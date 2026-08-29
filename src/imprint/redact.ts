/**
 * Credential / PII redaction. Replaces values of known-sensitive fields
 * with `[REDACTED:N]` (N = original length) so the LLM still sees the
 * shape but never the secret. Best-effort — see docs/troubleshooting.md
 * for what it doesn't catch (response bodies, URL path segments, etc.)
 * and how to audit a redacted session.
 *
 * When `opts.replacements` is provided (e.g. by `imprint teach` after the
 * credential-extract pass), the named values are rewritten to literal
 * `${credential.NAME}` placeholders BEFORE the generic byte-length redaction
 * runs. The LLM then sees the placeholders verbatim and emits them into
 * workflow.json without translation.
 */

import { splitSetCookieHeader } from './cookie-jar.ts';
import type { Replacement } from './credential-extract.ts';
import { hasFreeformRedactionHint, redactFreeformText } from './freeform-redact.ts';
import {
  MAX_REACT_FLIGHT_JSON_NODES,
  MAX_REACT_FLIGHT_ROWS,
  boundedJsonNodeCount,
} from './react-flight-limits.ts';
import { isAlwaysSecretHeader, isSensitiveHeader, isSensitiveKey } from './sensitive-keys.ts';
import type { CapturedRequest, Session } from './types.ts';

const USER_INTERACTION_TYPES = new Set(['click', 'input', 'change', 'submit']);
const MULTI_VALUE_HEADERS = new Set(['cookie', 'set-cookie']);
const MAX_FLIGHT_JSON_NESTING_DEPTH = 256;

/** Cheap, string-aware guard against making JSON.parse plus recursive
 * redaction traverse an adversarially deep Flight row. JSON.parse remains the
 * authority for syntax; this only rejects nesting beyond the safe budget. */
function hasBoundedJsonNesting(value: string, maxDepth = MAX_FLIGHT_JSON_NESTING_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === 0x5c) escaped = true;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) {
      inString = true;
    } else if (char === 0x5b || char === 0x7b) {
      depth++;
      if (depth > maxDepth) return false;
    } else if (char === 0x5d || char === 0x7d) {
      depth--;
    }
  }
  return true;
}

/**
 * Well-known XSSI (cross-site script inclusion) guards that sites prepend to
 * JSON responses to prevent them being parsed as script tags in HTML contexts.
 */
const XSSI_GUARDS = [")]}'", 'while(1);', 'for(;;);'];

/**
 * Detect a structured RPC envelope (XSSI-guarded or length-prefixed) whose body
 * is NOT top-level JSON but carries doubly-encoded JSON as string payloads.
 * Examples include Google `batchexecute` (`)]}'\n` guard + `<len>\n[...]` frames),
 * Facebook Graph API (`for(;;);` guard), and other structured RPC transports.
 * Running the flat-text freeform scanner over such a body injects `[REDACTED]`
 * into bare numeric IDs/coordinates inside the inner JSON and makes it
 * unparseable, so the freeform fallback must skip these. The structure-aware
 * key-based redaction still applies to any clean-JSON bodies; this only gates
 * the flat-text scan.
 */
function looksLikeRpcEnvelope(body: string): boolean {
  const head = body.slice(0, 64).trimStart();
  for (const guard of XSSI_GUARDS) {
    if (head.startsWith(guard)) return true; // )]}' covers )]}'NNN variants
  }
  if (/^\d{1,9}\r?\n\[/.test(head)) return true; // length-prefixed frame: 219006\n[
  return false;
}

/**
 * Detect sensitive headers whose values are page-minted constants — baked
 * into the site's JavaScript, not per-user secrets. The recording starts
 * from a clean browser with no cookies or stored state, so any sensitive
 * header value present in requests BEFORE the user's first interaction
 * that wasn't set by a prior Set-Cookie or storage snapshot is an app
 * constant and should not be redacted.
 *
 * Returns header names (lowercase) that should be passed to
 * `redactSession()` via `keepHeaders`.
 */
export function detectPageMintedHeaders(session: Session): string[] {
  const firstInteraction = session.events.find((e) => USER_INTERACTION_TYPES.has(e.type));
  const cutoff = firstInteraction?.timestamp ?? Number.POSITIVE_INFINITY;

  const producedValues = new Set<string>();
  for (const snap of session.storageSnapshots ?? []) {
    for (const v of Object.values(snap.localStorage ?? {})) producedValues.add(v);
    for (const v of Object.values(snap.sessionStorage ?? {})) producedValues.add(v);
  }
  for (const req of session.requests) {
    if (req.timestamp >= cutoff) break;
    const sc = Object.entries(req.response?.headers ?? {}).find(
      ([n]) => n.toLowerCase() === 'set-cookie',
    )?.[1];
    if (sc) {
      for (const cookie of splitSetCookieHeader(sc)) {
        const first = cookie.split(';', 1)[0] ?? '';
        const eq = first.indexOf('=');
        if (eq > 0) producedValues.add(first.slice(eq + 1));
      }
    }
  }

  // A header value counts as "produced" (a persisted/minted token, NOT a baked-in
  // app constant) when its value — or, for an auth-scheme header, the bare token
  // after the `Bearer `/`Basic ` prefix — was set by a prior Set-Cookie or appears
  // in a storage snapshot. The scheme-strip closes the gap where a per-user JWT
  // lives in localStorage as the bare token but is sent as `Authorization: Bearer
  // <token>`: without it, an already-authenticated (`--persist-profile`) recording
  // would mis-classify that per-user token as a page constant.
  const isProduced = (value: string): boolean => {
    if (producedValues.has(value)) return true;
    const sp = value.indexOf(' ');
    return sp > 0 && producedValues.has(value.slice(sp + 1));
  };

  const pageMinted = new Set<string>();
  for (const req of session.requests) {
    if (req.timestamp >= cutoff) break;
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (!isSensitiveHeader(name)) continue;
      // An inherently per-session auth header (Authorization / session token) is
      // never a public page constant — never exempt it, even pre-interaction.
      if (isAlwaysSecretHeader(name)) continue;
      if (MULTI_VALUE_HEADERS.has(lower)) continue;
      if (isProduced(value)) continue;
      pageMinted.add(lower);
    }
  }

  return [...pageMinted];
}

const REDACTED = (originalLength: number): string => `[REDACTED:${originalLength}]`;

interface RedactionMarkerContext {
  ids: Map<string, number>;
  nextId: number;
}

function createMarkerContext(): RedactionMarkerContext {
  return { ids: new Map(), nextId: 1 };
}

function markerFor(value: string, ctx?: RedactionMarkerContext): string {
  if (!ctx) return REDACTED(value.length);
  let id = ctx.ids.get(value);
  if (id === undefined) {
    id = ctx.nextId++;
    ctx.ids.set(value, id);
  }
  return `[REDACTED:v3:id=${id}:len=${value.length}]`;
}

interface BodyRedaction {
  redacted: string;
  redactionsCount: number;
  placeholdersInjected: number;
  freeformRedactions: number;
}

/** Redact all values of sensitive keys in a www-form-urlencoded body string.
 *  When `placeholderByKey` is given, sensitive keys whose names match get
 *  rewritten to the placeholder string instead of `[REDACTED:N]`. */
export function redactFormBody(
  body: string,
  placeholderByKey?: Map<string, string>,
  markerContext?: RedactionMarkerContext,
): BodyRedaction {
  let count = 0;
  let placeholders = 0;
  const parts = body.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const rawKey = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch {
      decodedKey = rawKey;
    }
    if (placeholderByKey?.has(decodedKey)) {
      placeholders++;
      const placeholder = placeholderByKey.get(decodedKey) ?? '';
      return `${rawKey}=${placeholder}`;
    }
    if (isSensitiveKey(decodedKey)) {
      count++;
      return `${rawKey}=${markerFor(rawVal, markerContext)}`;
    }
    return pair;
  });
  return {
    redacted: parts.join('&'),
    redactionsCount: count,
    placeholdersInjected: placeholders,
    freeformRedactions: 0,
  };
}

/** Redact sensitive keys inside a JSON-stringified body. Returns body unchanged on parse failure.
 *  When `placeholderByPath` is given (path → placeholder), values at those JSON paths get
 *  rewritten to the placeholder string. */
export function redactJsonBody(
  body: string,
  placeholderByPath?: Map<string, string>,
  freeform = true,
  markerContext?: RedactionMarkerContext,
  maxNestingDepth?: number,
  jsonNodeBudget?: { remaining: number },
  countRoot = true,
): BodyRedaction {
  if (jsonNodeBudget && countRoot) {
    const nodes = boundedJsonNodeCount(body, jsonNodeBudget.remaining);
    if (nodes === null) throw new Error('JSON width exceeds redaction budget');
    jsonNodeBudget.remaining -= nodes;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { redacted: body, redactionsCount: 0, placeholdersInjected: 0, freeformRedactions: 0 };
  }

  let count = 0;
  let placeholders = 0;
  let freeformCount = 0;
  function visit(node: unknown, pathSoFar: string[], traversalDepth = 0): unknown {
    if (maxNestingDepth !== undefined && traversalDepth > maxNestingDepth) {
      throw new Error('JSON traversal depth exceeds redaction budget');
    }
    if (typeof node === 'string') {
      const jsonCandidate = node.trimStart();
      if (jsonCandidate.length > 1 && (jsonCandidate[0] === '{' || jsonCandidate[0] === '[')) {
        // JSON-in-JSON may appear at an object property, an array index, or the
        // root. Apply the same bounded structural redaction in every position.
        if (
          maxNestingDepth !== undefined &&
          !hasBoundedJsonNesting(jsonCandidate, maxNestingDepth)
        ) {
          throw new Error('JSON-in-JSON nesting exceeds redaction budget');
        }
        if (jsonNodeBudget) {
          const nodes = boundedJsonNodeCount(jsonCandidate, jsonNodeBudget.remaining);
          if (nodes === null) throw new Error('JSON-in-JSON width exceeds redaction budget');
          jsonNodeBudget.remaining -= nodes;
        }
        let inner: unknown;
        try {
          inner = JSON.parse(jsonCandidate);
        } catch {
          const fallback =
            freeform && !looksLikeRpcEnvelope(node)
              ? redactFreeformText(node)
              : { redacted: node, redactionsCount: 0 };
          freeformCount += fallback.redactionsCount;
          return fallback.redacted;
        }
        return JSON.stringify(visit(inner, pathSoFar, traversalDepth + 1));
      }
      if (freeform && !looksLikeRpcEnvelope(node)) {
        const redacted = redactFreeformText(node);
        freeformCount += redacted.redactionsCount;
        return redacted.redacted;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((v, i) => visit(v, [...pathSoFar, String(i)], traversalDepth + 1));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        const path = [...pathSoFar, k].join('.');
        const placeholder = placeholderByPath?.get(path);
        if (placeholder !== undefined && (typeof v === 'string' || typeof v === 'number')) {
          placeholders++;
          out[k] = placeholder;
        } else if (isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number')) {
          count++;
          out[k] = markerFor(String(v), markerContext);
        } else {
          out[k] = visit(v, [...pathSoFar, k], traversalDepth + 1);
        }
      }
      return out;
    }
    return node;
  }
  const redacted = JSON.stringify(visit(parsed, []));
  return {
    redacted,
    redactionsCount: count,
    placeholdersInjected: placeholders,
    freeformRedactions: freeformCount,
  };
}

function isAsciiHex(byte: number | undefined): boolean {
  return (
    byte !== undefined &&
    ((byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66))
  );
}

/** Redact JSON rows inside a React Flight body without changing its framing. */
function redactFlightBody(
  body: string,
  freeform = false,
  markerContext?: RedactionMarkerContext,
): BodyRedaction {
  const failClosed = (): BodyRedaction => ({
    redacted: `[REDACTED:UNSAFE_FLIGHT_BODY:${Buffer.byteLength(body, 'utf8')}]`,
    redactionsCount: 1,
    placeholdersInjected: 0,
    freeformRedactions: 0,
  });
  if (!body.endsWith('\n')) return failClosed();

  const bytes = Buffer.from(body, 'utf8');
  const output: Buffer[] = [];
  let offset = 0;
  let redactionsCount = 0;
  let freeformRedactions = 0;
  let rowCount = 0;
  const jsonNodeBudget = { remaining: MAX_REACT_FLIGHT_JSON_NODES };

  const redactJsonPayload = (json: string): BodyRedaction | null => {
    try {
      if (!hasBoundedJsonNesting(json)) return null;
      const nodes = boundedJsonNodeCount(json, jsonNodeBudget.remaining);
      if (nodes === null) return null;
      jsonNodeBudget.remaining -= nodes;
      JSON.parse(json);
      return redactJsonBody(
        json,
        undefined,
        freeform,
        markerContext,
        MAX_FLIGHT_JSON_NESTING_DEPTH,
        jsonNodeBudget,
        false,
      );
    } catch {
      return null;
    }
  };

  while (offset < bytes.length) {
    if (++rowCount > MAX_REACT_FLIGHT_ROWS) return failClosed();
    const lineEnd = bytes.indexOf(0x0a, offset);
    if (lineEnd < 0 || lineEnd === offset) return failClosed();
    if (bytes[offset] === 0x3a) {
      const hint = bytes.toString('utf8', offset, lineEnd);
      const match = /^:([A-Z]+)(.+)$/.exec(hint);
      const redacted = match?.[2] ? redactJsonPayload(match[2]) : null;
      if (!match?.[1] || !redacted) return failClosed();
      redactionsCount += redacted.redactionsCount;
      freeformRedactions += redacted.freeformRedactions;
      output.push(Buffer.from(`:${match[1]}${redacted.redacted}\n`, 'utf8'));
      offset = lineEnd + 1;
      continue;
    }

    let idStart = offset;
    if (bytes[idStart] === 0x23) idStart++;
    let colon = idStart;
    while (colon < bytes.length && isAsciiHex(bytes[colon])) colon++;
    if (colon === idStart || bytes[colon] !== 0x3a) return failClosed();
    const payloadStart = colon + 1;
    if (payloadStart >= bytes.length) return failClosed();

    if (bytes[payloadStart] === 0x54) {
      let comma = payloadStart + 1;
      while (comma < bytes.length && isAsciiHex(bytes[comma])) comma++;
      if (comma === payloadStart + 1 || bytes[comma] !== 0x2c) return failClosed();
      const length = Number.parseInt(bytes.toString('ascii', payloadStart + 1, comma), 16);
      if (!Number.isSafeInteger(length)) return failClosed();
      const textEnd = comma + 1 + length;
      if (textEnd > bytes.length) return failClosed();
      const text = bytes.toString('utf8', comma + 1, textEnd);
      const redactedText = freeform
        ? redactFreeformText(text)
        : { redacted: text, redactionsCount: 0 };
      freeformRedactions += redactedText.redactionsCount;
      output.push(bytes.subarray(offset, payloadStart));
      output.push(
        Buffer.from(
          `T${Buffer.byteLength(redactedText.redacted, 'utf8').toString(16)},${redactedText.redacted}`,
          'utf8',
        ),
      );
      offset = textEnd;
      continue;
    }

    const payload = bytes.toString('utf8', payloadStart, lineEnd);
    if (/^[RrXx]$/.test(payload)) {
      output.push(bytes.subarray(offset, lineEnd + 1));
      offset = lineEnd + 1;
      continue;
    }
    if (payload.startsWith('C')) {
      if (payload === 'C') {
        output.push(bytes.subarray(offset, lineEnd + 1));
        offset = lineEnd + 1;
        continue;
      }
      const redacted = redactJsonPayload(payload.slice(1));
      if (!redacted) return failClosed();
      redactionsCount += redacted.redactionsCount;
      freeformRedactions += redacted.freeformRedactions;
      output.push(bytes.subarray(offset, payloadStart));
      output.push(Buffer.from(`C${redacted.redacted}\n`, 'utf8'));
      offset = lineEnd + 1;
      continue;
    }
    const tagged = /^([A-Z]+)(?=[\[{\"\d\-ntf])(.*)$/.exec(payload);
    const tag = tagged?.[1] ?? '';
    const json = tagged?.[2] ?? payload;
    const redacted = redactJsonPayload(json);
    if (!redacted) return failClosed();
    redactionsCount += redacted.redactionsCount;
    freeformRedactions += redacted.freeformRedactions;
    output.push(bytes.subarray(offset, payloadStart));
    output.push(Buffer.from(`${tag}${redacted.redacted}\n`, 'utf8'));
    offset = lineEnd + 1;
  }

  return {
    redacted: Buffer.concat(output).toString('utf8'),
    redactionsCount,
    placeholdersInjected: 0,
    freeformRedactions,
  };
}

/** Redact a request body of unknown content-type. Tries JSON first, falls back to form. */
export function redactBody(
  body: string,
  contentType?: string,
  formPlaceholders?: Map<string, string>,
  jsonPlaceholders?: Map<string, string>,
  freeform = true,
  markerContext?: RedactionMarkerContext,
): BodyRedaction {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('urlencoded')) {
    return redactFormBody(body, formPlaceholders, markerContext);
  }
  if (ct.includes('text/x-component')) {
    return redactFlightBody(body, freeform, markerContext);
  }
  // Try JSON first — many APIs send JSON as text/plain or with no content-type.
  const jsonR = redactJsonBody(body, jsonPlaceholders, freeform, markerContext);
  if (jsonR.redactionsCount > 0 || jsonR.placeholdersInjected > 0 || jsonR.freeformRedactions > 0) {
    return jsonR;
  }
  try {
    JSON.parse(body);
    return jsonR;
  } catch {
    const formR = redactFormBody(body, formPlaceholders, markerContext);
    if (formR.redactionsCount > 0 || formR.placeholdersInjected > 0 || !freeform) return formR;
    // A structured RPC envelope (XSSI/length-prefixed) is not flat text —
    // flat-scanning it would corrupt the doubly-encoded JSON payloads it carries.
    if (looksLikeRpcEnvelope(body)) return formR;
    const freeformR = redactFreeformText(body);
    return {
      redacted: freeformR.redacted,
      redactionsCount: 0,
      placeholdersInjected: 0,
      freeformRedactions: freeformR.redactionsCount,
    };
  }
}

/** Redact sensitive query params from a URL string. */
export function redactUrl(
  url: string,
  freeform = true,
  markerContext?: RedactionMarkerContext,
): { redacted: string; redactionsCount: number; freeformRedactions: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { redacted: url, redactionsCount: 0, freeformRedactions: 0 };
  }
  let count = 0;
  let freeformCount = 0;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (isSensitiveKey(key)) {
      const val = parsed.searchParams.get(key) ?? '';
      parsed.searchParams.set(key, markerFor(val, markerContext));
      count++;
    }
  }
  if (freeform && parsed.pathname.length > 1 && hasFreeformRedactionHint(parsed.pathname)) {
    const segments = parsed.pathname.split('/').map((segment) => {
      if (segment.length === 0) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment if it is not valid percent-encoding.
      }
      const r = redactFreeformText(decoded);
      freeformCount += r.redactionsCount;
      return r.redacted;
    });
    parsed.pathname = segments.join('/');
  }
  return {
    redacted: parsed.toString(),
    redactionsCount: count + freeformCount,
    freeformRedactions: freeformCount,
  };
}

/** Redact sensitive headers in-place style (returns a new object). */
export function redactHeaders(
  headers: Record<string, string>,
  keepHeaders: ReadonlySet<string> = new Set(),
  markerContext?: RedactionMarkerContext,
): {
  redacted: Record<string, string>;
  redactionsCount: number;
} {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k) && !keepHeaders.has(k.toLowerCase())) {
      const lower = k.toLowerCase();
      if (lower === 'cookie') out[k] = redactCookieHeaderValue(v, markerContext);
      else if (lower === 'set-cookie') out[k] = redactSetCookieHeaderValue(v, markerContext);
      else out[k] = markerFor(v, markerContext);
      count++;
    } else {
      out[k] = v;
    }
  }
  return { redacted: out, redactionsCount: count };
}

function redactCookieHeaderValue(value: string, markerContext?: RedactionMarkerContext): string {
  return value
    .split(';')
    .map((part) => {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return trimmed;
      return `${trimmed.slice(0, eq)}=${markerFor(trimmed.slice(eq + 1), markerContext)}`;
    })
    .join('; ');
}

function redactSetCookieHeaderValue(value: string, markerContext?: RedactionMarkerContext): string {
  return splitSetCookieHeader(value)
    .map((cookie) => {
      const parts = cookie.split(';').map((p) => p.trim());
      const first = parts[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) return cookie;
      const redactedFirst = `${first.slice(0, eq)}=${markerFor(first.slice(eq + 1), markerContext)}`;
      return [redactedFirst, ...parts.slice(1)].join('; ');
    })
    .join(', ');
}

interface RedactionStats {
  /** Number of individual values replaced across the entire session. */
  totalRedactions: number;
  /** Number of requests touched (had at least one redaction). */
  requestsRedacted: number;
  /** Number of cookies whose VALUES were replaced. */
  cookiesRedacted: number;
  /** Values rewritten to a `${credential.X}` placeholder (extracted at teach time). */
  placeholdersInjected: number;
  /** Free-form PII/secrets found by the supplemental regex redactor. */
  freeformRedactions: number;
  /** Detected sensitive items that you should be aware of (for the user-facing report). */
  warnings: string[];
}

interface RedactOptions {
  /**
   * Header names (case-insensitive) to NEVER redact even if they match
   * the sensitive header list. Use for known-public headers like
   * `X-API-Key` on sites where it's an app-level identifier embedded in
   * the page JS rather than a per-user secret.
   */
  keepHeaders?: string[];
  /**
   * Replacements built by `extractCredentials()` to rewrite specific values
   * to `${credential.NAME}` placeholders before the LLM sees them. The
   * placeholders survive into workflow.json verbatim.
   */
  replacements?: Replacement[];
  /** Internal escape hatch for benchmarks/tests that compare structured-only redaction. */
  freeform?: boolean;
  /**
   * Gate the blanket sensitive-header redaction (Authorization / Cookie /
   * Set-Cookie / X-API-Key / X-CSRF / …). Default **false**: the compile agent
   * must SEE auth / session / gateway header values to reason about them and
   * wire each as a contracted input — it cannot reason about a value it cannot
   * read, and blinding it is the root cause of dropped auth/session inputs.
   * Credential placeholdering (`replacements`) and free-form PII redaction still
   * run regardless. Set true (or `IMPRINT_REDACT_SENSITIVE_HEADERS=1`) to restore
   * the old blind-the-agent behavior. The emit-time secret guard
   * (`assertNoRawSecrets`) backstops this by blocking raw secrets from artifacts.
   */
  redactSensitiveHeaders?: boolean;
}

/** Produce a scrubbed copy of a session safe to send to an LLM. */
export function redactSession(
  session: Session,
  opts: RedactOptions = {},
): { session: Session; stats: RedactionStats } {
  const stats: RedactionStats = {
    totalRedactions: 0,
    requestsRedacted: 0,
    cookiesRedacted: 0,
    placeholdersInjected: 0,
    freeformRedactions: 0,
    warnings: [],
  };
  const keepHeaders = new Set((opts.keepHeaders ?? []).map((h) => h.toLowerCase()));
  const useFreeform = opts.freeform ?? true;
  // Default OFF: keep auth/session/gateway header values visible to the compile
  // agent (see RedactOptions.redactSensitiveHeaders). Explicit opt wins; else the
  // env gate re-enables the legacy blanket redaction; else off.
  const redactSensitiveHeaders =
    opts.redactSensitiveHeaders ?? process.env.IMPRINT_REDACT_SENSITIVE_HEADERS === '1';
  const markerContext = createMarkerContext();
  const passthroughHeaders = (
    headers: Record<string, string>,
  ): { redacted: Record<string, string>; redactionsCount: number } => ({
    redacted: headers,
    redactionsCount: 0,
  });

  // Group replacements by request seq.
  const replacementsBySeq = new Map<number, Replacement[]>();
  for (const r of opts.replacements ?? []) {
    const arr = replacementsBySeq.get(r.requestSeq) ?? [];
    arr.push(r);
    replacementsBySeq.set(r.requestSeq, arr);
  }

  const redactedRequests = session.requests.map((req: CapturedRequest) => {
    let touched = 0;

    const urlR = redactUrl(req.url, useFreeform, markerContext);
    touched += urlR.redactionsCount;
    stats.freeformRedactions += urlR.freeformRedactions;

    const headersR = redactSensitiveHeaders
      ? redactHeaders(req.headers, keepHeaders, markerContext)
      : passthroughHeaders(req.headers);
    touched += headersR.redactionsCount;

    let body = req.body;
    if (body) {
      const ct = req.headers['content-type'] ?? req.headers['Content-Type'];
      const reqReplacements = replacementsBySeq.get(req.seq) ?? [];
      const formPlaceholders = new Map<string, string>();
      const jsonPlaceholders = new Map<string, string>();
      for (const r of reqReplacements) {
        if (r.location.kind === 'body-form') {
          formPlaceholders.set(r.location.key, r.placeholder);
        } else if (r.location.kind === 'body-json') {
          jsonPlaceholders.set(r.location.path.join('.'), r.placeholder);
        }
      }
      const bodyR = redactBody(
        body,
        ct,
        formPlaceholders,
        jsonPlaceholders,
        useFreeform,
        markerContext,
      );
      body = bodyR.redacted;
      touched += bodyR.redactionsCount + bodyR.freeformRedactions;
      stats.placeholdersInjected += bodyR.placeholdersInjected;
      stats.freeformRedactions += bodyR.freeformRedactions;
    }

    let response = req.response;
    if (response) {
      const respHeadersR = redactSensitiveHeaders
        ? redactHeaders(response.headers, keepHeaders, markerContext)
        : passthroughHeaders(response.headers);
      touched += respHeadersR.redactionsCount;
      let respBody = response.body;
      if (respBody) {
        const responseContentType =
          response.mimeType ||
          Object.entries(response.headers).find(
            ([name]) => name.toLowerCase() === 'content-type',
          )?.[1];
        const isFlight =
          (responseContentType ?? '').toLowerCase().split(';', 1)[0]?.trim() === 'text/x-component';
        const respBodyR = redactBody(
          respBody,
          responseContentType,
          undefined,
          undefined,
          // Flight rows have a framing-aware redactor, so rendered free-form
          // PII can be scrubbed without corrupting JSON or T-row byte lengths.
          // Other response envelopes remain key-based only.
          isFlight ? useFreeform : false,
          markerContext,
        );
        respBody = respBodyR.redacted;
        touched += respBodyR.redactionsCount + respBodyR.freeformRedactions;
        stats.freeformRedactions += respBodyR.freeformRedactions;
      }
      response = {
        ...response,
        headers: respHeadersR.redacted,
        body: respBody,
      };
    }

    if (touched > 0) {
      stats.requestsRedacted++;
      stats.totalRedactions += touched;
    }

    return {
      ...req,
      url: urlR.redacted,
      headers: headersR.redacted,
      body,
      response,
    };
  });

  const redactedSnapshots = (session.cookieSnapshots ?? []).map((snap) => ({
    ...snap,
    cookies: snap.cookies.map((c) => {
      stats.cookiesRedacted++;
      return { ...c, value: markerFor(c.value, markerContext) };
    }),
  }));

  const redactedStorageSnapshots = (session.storageSnapshots ?? []).map((snap) => ({
    ...snap,
    localStorage: redactStorageRecord(snap.localStorage, markerContext),
    sessionStorage: redactStorageRecord(snap.sessionStorage, markerContext),
  }));

  // Scrub captured DOM events too. inject-listener already masks password
  // VALUES at capture time, but other fields (username, email, search terms)
  // come through plaintext. When we have explicit replacements (the teach
  // flow), replace those values verbatim in event detail strings.
  const valueToPlaceholder = new Map<string, string>();
  for (const r of opts.replacements ?? []) {
    valueToPlaceholder.set(r.originalValue, r.placeholder);
  }
  const redactedEvents = session.events.map((ev) => {
    let detail = ev.detail;
    for (const [val, placeholder] of valueToPlaceholder) {
      if (val.length === 0) continue;
      // Avoid replacing inside JSON-string-escaped values that have already
      // been turned into the placeholder (idempotent).
      detail = detail.split(val).join(placeholder);
    }
    if (detail !== ev.detail) {
      stats.placeholdersInjected++;
    }
    if (useFreeform) {
      const freeformR = redactFreeformText(detail);
      if (freeformR.redactionsCount > 0) {
        detail = freeformR.redacted;
        stats.freeformRedactions += freeformR.redactionsCount;
        stats.totalRedactions += freeformR.redactionsCount;
      }
    }
    return { ...ev, detail };
  });

  if (
    session.requests.some(
      (r) => r.body?.toLowerCase().includes('password') || r.url.toLowerCase().includes('password'),
    )
  ) {
    // Already handled by the redact pass; just surface for the user-facing report.
    stats.warnings.push('Password field(s) detected and redacted.');
  }

  return {
    session: {
      ...session,
      requests: redactedRequests,
      events: redactedEvents,
      cookieSnapshots: redactedSnapshots,
      storageSnapshots: redactedStorageSnapshots,
    },
    stats,
  };
}

function redactStorageRecord(
  values: Record<string, string> | undefined,
  markerContext: RedactionMarkerContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    out[k] = isSensitiveKey(k) || hasFreeformRedactionHint(v) ? markerFor(v, markerContext) : v;
  }
  return out;
}
