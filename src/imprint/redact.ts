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

import type { Replacement } from './credential-extract.ts';
import { isSensitiveHeader, isSensitiveKey } from './sensitive-keys.ts';
import type { CapturedRequest, Session } from './types.ts';

const REDACTED = (originalLength: number): string => `[REDACTED:${originalLength}]`;

/** Redact all values of sensitive keys in a www-form-urlencoded body string.
 *  When `placeholderByKey` is given, sensitive keys whose names match get
 *  rewritten to the placeholder string instead of `[REDACTED:N]`. */
export function redactFormBody(
  body: string,
  placeholderByKey?: Map<string, string>,
): { redacted: string; redactionsCount: number; placeholdersInjected: number } {
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
      return `${rawKey}=${REDACTED(rawVal.length)}`;
    }
    return pair;
  });
  return { redacted: parts.join('&'), redactionsCount: count, placeholdersInjected: placeholders };
}

/** Redact sensitive keys inside a JSON-stringified body. Returns body unchanged on parse failure.
 *  When `placeholderByPath` is given (path → placeholder), values at those JSON paths get
 *  rewritten to the placeholder string. */
export function redactJsonBody(
  body: string,
  placeholderByPath?: Map<string, string>,
): { redacted: string; redactionsCount: number; placeholdersInjected: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { redacted: body, redactionsCount: 0, placeholdersInjected: 0 };
  }

  let count = 0;
  let placeholders = 0;
  const visit = (node: unknown, pathSoFar: string[]): unknown => {
    if (Array.isArray(node)) {
      return node.map((v, i) => visit(v, [...pathSoFar, String(i)]));
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
          out[k] = REDACTED(String(v).length);
        } else if (typeof v === 'string' && v.length > 1 && (v[0] === '{' || v[0] === '[')) {
          // JSON-in-JSON: try to parse and redact the nested string.
          try {
            const inner = JSON.parse(v);
            const visited = visit(inner, [...pathSoFar, k]);
            out[k] = JSON.stringify(visited);
          } catch {
            out[k] = v;
          }
        } else {
          out[k] = visit(v, [...pathSoFar, k]);
        }
      }
      return out;
    }
    return node;
  };
  const redacted = JSON.stringify(visit(parsed, []));
  return { redacted, redactionsCount: count, placeholdersInjected: placeholders };
}

/** Redact a request body of unknown content-type. Tries JSON first, falls back to form. */
export function redactBody(
  body: string,
  contentType?: string,
  formPlaceholders?: Map<string, string>,
  jsonPlaceholders?: Map<string, string>,
): { redacted: string; redactionsCount: number; placeholdersInjected: number } {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('urlencoded')) {
    return redactFormBody(body, formPlaceholders);
  }
  // Try JSON first — many APIs send JSON as text/plain or with no content-type.
  const jsonR = redactJsonBody(body, jsonPlaceholders);
  if (jsonR.redactionsCount > 0 || jsonR.placeholdersInjected > 0) return jsonR;
  try {
    JSON.parse(body);
    return jsonR;
  } catch {
    return redactFormBody(body, formPlaceholders);
  }
}

/** Redact sensitive query params from a URL string. */
export function redactUrl(url: string): { redacted: string; redactionsCount: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { redacted: url, redactionsCount: 0 };
  }
  let count = 0;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (isSensitiveKey(key)) {
      const val = parsed.searchParams.get(key) ?? '';
      parsed.searchParams.set(key, REDACTED(val.length));
      count++;
    }
  }
  return { redacted: parsed.toString(), redactionsCount: count };
}

/** Redact sensitive headers in-place style (returns a new object). */
export function redactHeaders(
  headers: Record<string, string>,
  keepHeaders: ReadonlySet<string> = new Set(),
): {
  redacted: Record<string, string>;
  redactionsCount: number;
} {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k) && !keepHeaders.has(k.toLowerCase())) {
      out[k] = REDACTED(v.length);
      count++;
    } else {
      out[k] = v;
    }
  }
  return { redacted: out, redactionsCount: count };
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
    warnings: [],
  };
  const keepHeaders = new Set((opts.keepHeaders ?? []).map((h) => h.toLowerCase()));

  // Group replacements by request seq.
  const replacementsBySeq = new Map<number, Replacement[]>();
  for (const r of opts.replacements ?? []) {
    const arr = replacementsBySeq.get(r.requestSeq) ?? [];
    arr.push(r);
    replacementsBySeq.set(r.requestSeq, arr);
  }

  const redactedRequests = session.requests.map((req: CapturedRequest) => {
    let touched = 0;

    const urlR = redactUrl(req.url);
    touched += urlR.redactionsCount;

    const headersR = redactHeaders(req.headers, keepHeaders);
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
      const bodyR = redactBody(body, ct, formPlaceholders, jsonPlaceholders);
      body = bodyR.redacted;
      touched += bodyR.redactionsCount;
      stats.placeholdersInjected += bodyR.placeholdersInjected;
    }

    let response = req.response;
    if (response) {
      const respHeadersR = redactHeaders(response.headers, keepHeaders);
      touched += respHeadersR.redactionsCount;
      let respBody = response.body;
      if (respBody) {
        const respBodyR = redactBody(respBody, response.mimeType);
        respBody = respBodyR.redacted;
        touched += respBodyR.redactionsCount;
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
      return { ...c, value: REDACTED(c.value.length) };
    }),
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
    if (valueToPlaceholder.size === 0) return ev;
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
    return { ...ev, detail };
  });

  // Flag site-specific patterns that survive.
  if (
    session.requests.some(
      (r) => r.body?.includes('patronPassword') || r.url.includes('patronPassword'),
    )
  ) {
    stats.warnings.push('Discover & Go patronPassword detected and redacted.');
  }
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
    },
    stats,
  };
}
