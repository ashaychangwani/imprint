/**
 * Credential extraction over a recorded session.
 *
 * Detects login form submissions in raw HTTP request bodies (form-urlencoded
 * or JSON) and pairs each password-like field with the most likely
 * username/email field in the same body. Surfaces the values + their byte
 * locations so the redaction pass can rewrite them to `${credential.NAME}`
 * placeholders BEFORE the LLM sees the session.
 *
 * The DOM event stream is consulted as a confirmation signal — passwords are
 * already client-side-masked there by inject-listener.ts, but the username
 * value is visible and lets us confirm which form was the login form.
 */

import { isSensitiveCredentialKey, isUsernameLikeKey } from './sensitive-keys.ts';
import type { CapturedEvent, CapturedRequest, Session } from './types.ts';

/** Predicate: this key looks like the username/email/login partner of a
 *  password field. Backed by `USERNAME_LIKE_KEYS` in sensitive-keys.ts so
 *  the dictionary stays in one place. */
const isUsernameKey = (key: string): boolean => isUsernameLikeKey(key);

/** Where, within a request, a redactable value lives. */
export type ReplacementLocation =
  | { kind: 'body-form'; key: string }
  | { kind: 'body-json'; path: string[] };

export interface Replacement {
  /** Index into session.requests. */
  requestSeq: number;
  /** Where exactly in the request body. */
  location: ReplacementLocation;
  /** The exact substring we'll overwrite. */
  originalValue: string;
  /** What we'll replace it with — e.g. `${credential.username}`. */
  placeholder: string;
}

export interface CredentialFinding {
  kind: 'login-pair';
  /** `username` for form-login pairs by default. Re-namable by the user. */
  usernameName: string;
  passwordName: string;
  usernameValue: string;
  passwordValue: string;
  /** Where these values live (used by the redactor, also surfaced to the
   *  user so they can verify the right form was detected). */
  requestSeq: number;
  /** Brief request label like `POST /api/security/v4/security/token`. */
  requestLabel: string;
  /** Whether the username appears in form-submit DOM events too (high signal). */
  confirmedByDom: boolean;
}

interface ExtractionResult {
  findings: CredentialFinding[];
  replacements: Replacement[];
}

/** Parsers are tried in this order on every request that has a body. Each
 *  one is side-effect-free and returns `null` when its input doesn't fit
 *  its expected framing — so trying JSON first on a form body, or form on
 *  a JSON body, is safe: only the parser that actually fits will produce a
 *  finding.
 *
 *  Dispatch is parser-driven, not Content-Type-driven, because real sites
 *  routinely mislabel their bodies — the canonical example is the Nextep
 *  cafe API (`Content-Type: text/plain` for JSON bodies). Letting the data
 *  speak for itself prevents whole classes of silent extraction failures.
 *
 *  URL-query parsing runs even on requests without a body (e.g. GET-based
 *  logins that pass credentials in the query string). Multipart is checked
 *  before generic form-urlencoded because a multipart body still contains
 *  `=` characters and would be parsed as a single malformed form pair
 *  otherwise. */
const BODY_PARSERS: Array<(r: CapturedRequest) => BodyFinding | null> = [
  findInJsonBody,
  findInJsonWrappedInForm,
  findInMultipartBody,
  findInFormBody,
];

/** Top-level entry point. */
export function extractCredentials(session: Session): ExtractionResult {
  const findings: CredentialFinding[] = [];
  const replacements: Replacement[] = [];
  const usernamesInDom = collectFormSubmitUsernames(session.events);

  for (const req of session.requests) {
    let found: BodyFinding | null = null;
    if (req.body) {
      for (const parse of BODY_PARSERS) {
        found = parse(req);
        if (found) break;
      }
    }
    // Last-resort: credentials in the URL query string (rare but real for
    // some legacy GET-based login endpoints). Tried after body parsers so
    // body-based logins always win when both are present.
    if (!found) found = findInUrlQuery(req);
    if (!found) continue;

    const confirmedByDom = usernamesInDom.has(found.usernameValue);
    findings.push({
      kind: 'login-pair',
      usernameName: 'username',
      passwordName: 'password',
      usernameValue: found.usernameValue,
      passwordValue: found.passwordValue,
      requestSeq: req.seq,
      requestLabel: `${req.method} ${shortUrl(req.url)}`,
      confirmedByDom,
    });

    replacements.push(
      {
        requestSeq: req.seq,
        location: found.usernameLocation,
        originalValue: found.usernameValue,
        placeholder: '${credential.username}',
      },
      {
        requestSeq: req.seq,
        location: found.passwordLocation,
        originalValue: found.passwordValue,
        placeholder: '${credential.password}',
      },
    );
  }

  return { findings, replacements };
}

interface BodyFinding {
  usernameValue: string;
  passwordValue: string;
  usernameLocation: ReplacementLocation;
  passwordLocation: ReplacementLocation;
}

function findInFormBody(req: CapturedRequest): BodyFinding | null {
  if (!req.body) return null;
  const pairs = parseFormBody(req.body);
  let usernameKey: string | null = null;
  let usernameValue: string | null = null;
  let passwordKey: string | null = null;
  let passwordValue: string | null = null;

  // First pass: find a sensitive (password-like) key.
  for (const { key, value } of pairs) {
    if (isSensitiveCredentialKey(key) && value.length > 0) {
      passwordKey = key;
      passwordValue = value;
      break;
    }
  }
  if (passwordKey === null || passwordValue === null) return null;

  // Second pass: find a username-like key.
  for (const { key, value } of pairs) {
    if (isUsernameKey(key) && value.length > 0) {
      usernameKey = key;
      usernameValue = value;
      break;
    }
  }
  if (usernameKey === null || usernameValue === null) return null;

  return {
    usernameValue,
    passwordValue,
    usernameLocation: { kind: 'body-form', key: usernameKey },
    passwordLocation: { kind: 'body-form', key: passwordKey },
  };
}

function findInJsonBody(req: CapturedRequest): BodyFinding | null {
  if (!req.body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const pwdHit = findFirstByPredicate(parsed, isSensitiveCredentialKey);
  if (!pwdHit) return null;
  if (typeof pwdHit.value !== 'string' || pwdHit.value.length === 0) return null;

  // Look for a username-like key; prefer one in the same parent object.
  const userHit = findFirstByPredicate(parsed, isUsernameKey, pwdHit.parent);
  if (!userHit || typeof userHit.value !== 'string' || userHit.value.length === 0) return null;

  return {
    usernameValue: userHit.value,
    passwordValue: pwdHit.value,
    usernameLocation: { kind: 'body-json', path: userHit.path },
    passwordLocation: { kind: 'body-json', path: pwdHit.path },
  };
}

/** Handles legacy framings where a JSON document is the value of a single
 *  form-encoded field — `payload={"username":"…","password":"…"}` or
 *  `data=…` or `request=…`. Real PHP / ColdFusion apps do this. We delegate
 *  the inner pairing to findInJsonBody by synthesizing a child request, and
 *  re-encode the path as `body-form` so the redactor knows to swap the
 *  whole inner JSON string back in. */
function findInJsonWrappedInForm(req: CapturedRequest): BodyFinding | null {
  if (!req.body) return null;
  const pairs = parseFormBody(req.body);
  if (pairs.length === 0) return null;

  const WRAPPER_KEYS = new Set(['payload', 'data', 'request', 'json', 'body']);
  for (const { key, value } of pairs) {
    if (!WRAPPER_KEYS.has(key.toLowerCase())) continue;
    if (!value.startsWith('{') && !value.startsWith('[')) continue;
    // Build a synthetic request with the unwrapped JSON as body.
    const inner: CapturedRequest = { ...req, body: value };
    const found = findInJsonBody(inner);
    if (!found) continue;
    // Project the JSON paths back into form-key terms — the redactor
    // matches on `originalValue` regardless of `location`, but we keep the
    // location semantically correct so future readers aren't confused.
    return {
      ...found,
      usernameLocation: { kind: 'body-form', key },
      passwordLocation: { kind: 'body-form', key },
    };
  }
  return null;
}

/** Parse a multipart/form-data body into {key, value} pairs and pair like
 *  the form-urlencoded path. Defensive: any malformed part is skipped.
 *
 *  We sniff the boundary from the first line (`--<boundary>`) rather than
 *  trusting the Content-Type header, because the whole point of this
 *  module is to not trust Content-Type. */
function findInMultipartBody(req: CapturedRequest): BodyFinding | null {
  if (!req.body) return null;
  const body = req.body;
  // First line should be `--<boundary>`. If it doesn't start with `--` or
  // there's no following newline, this isn't multipart.
  const firstNewline = body.indexOf('\n');
  if (firstNewline < 0) return null;
  const firstLine = body.slice(0, firstNewline).trimEnd();
  if (!firstLine.startsWith('--')) return null;
  const boundary = firstLine.slice(2);
  if (boundary.length === 0 || boundary.length > 200) return null;
  // Split on the boundary; skip the prologue (empty before first boundary)
  // and the epilogue (after closing `--<boundary>--`).
  const sep = `--${boundary}`;
  const parts = body.split(sep).slice(1);
  const pairs: Array<{ key: string; value: string }> = [];
  for (const partRaw of parts) {
    const part = partRaw.startsWith('\r\n')
      ? partRaw.slice(2)
      : partRaw.startsWith('\n')
        ? partRaw.slice(1)
        : partRaw;
    if (part.startsWith('--')) break; // closing boundary
    // Headers and body are separated by a blank line.
    const headerEnd = part.indexOf('\r\n\r\n');
    const headerEnd2 = headerEnd >= 0 ? headerEnd : part.indexOf('\n\n');
    if (headerEnd2 < 0) continue;
    const sepLen = headerEnd >= 0 ? 4 : 2;
    const headers = part.slice(0, headerEnd2);
    let value = part.slice(headerEnd2 + sepLen);
    // Strip the trailing CRLF that precedes the next boundary.
    value = value.replace(/\r?\n$/, '');
    const nameMatch = headers.match(/name="([^"]*)"/i);
    if (!nameMatch) continue;
    const key = nameMatch[1] ?? '';
    if (!key) continue;
    pairs.push({ key, value });
  }
  if (pairs.length === 0) return null;
  return pairFromKeyValuePairs(pairs, 'body-form');
}

/** Credentials in the URL query string — `GET /login?username=…&password=…`
 *  or a POST whose body is empty but credentials ride in the URL. Rare but
 *  real for some legacy CGI endpoints. */
function findInUrlQuery(req: CapturedRequest): BodyFinding | null {
  let qs: string;
  try {
    const u = new URL(req.url);
    qs = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  } catch {
    return null;
  }
  if (!qs) return null;
  const pairs = parseFormBody(qs);
  if (pairs.length === 0) return null;
  return pairFromKeyValuePairs(pairs, 'body-form');
}

/** Shared pairing: given key/value pairs, find a password partner and a
 *  username partner. Returns a BodyFinding or null. Used by every parser
 *  that flattens its input into key/value pairs (form, multipart, URL
 *  query). The `location.kind` argument is passed through unchanged. */
function pairFromKeyValuePairs(
  pairs: Array<{ key: string; value: string }>,
  kind: 'body-form',
): BodyFinding | null {
  let passwordKey: string | null = null;
  let passwordValue: string | null = null;
  for (const { key, value } of pairs) {
    if (isSensitiveCredentialKey(key) && value.length > 0) {
      passwordKey = key;
      passwordValue = value;
      break;
    }
  }
  if (passwordKey === null || passwordValue === null) return null;
  let usernameKey: string | null = null;
  let usernameValue: string | null = null;
  for (const { key, value } of pairs) {
    if (isUsernameKey(key) && value.length > 0) {
      usernameKey = key;
      usernameValue = value;
      break;
    }
  }
  if (usernameKey === null || usernameValue === null) return null;
  return {
    usernameValue,
    passwordValue,
    usernameLocation: { kind, key: usernameKey },
    passwordLocation: { kind, key: passwordKey },
  };
}

interface JsonHit {
  key: string;
  value: unknown;
  path: string[];
  // Reference identity of the parent object — used to prefer same-parent matches.
  // biome-ignore lint/suspicious/noExplicitAny: opaque parent ref
  parent: any;
}

function findFirstByPredicate(
  root: unknown,
  predicate: (key: string) => boolean,
  preferredParent?: unknown,
): JsonHit | null {
  // BFS. If `preferredParent` is set, we run twice: first restricted to
  // children of that parent, then anywhere.
  if (preferredParent) {
    const r1 = bfsFindUnder(preferredParent, predicate);
    if (r1) return r1;
  }
  return bfsFind(root, predicate);
}

function bfsFindUnder(parent: unknown, predicate: (key: string) => boolean): JsonHit | null {
  if (!parent || typeof parent !== 'object') return null;
  for (const [k, v] of Object.entries(parent)) {
    if (predicate(k)) return { key: k, value: v, path: [k], parent };
  }
  return null;
}

function bfsFind(root: unknown, predicate: (key: string) => boolean): JsonHit | null {
  const queue: Array<{ node: unknown; path: string[] }> = [{ node: root, path: [] }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { node, path } = item;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        queue.push({ node: node[i], path: [...path, String(i)] });
      }
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (predicate(k)) return { key: k, value: v, path: [...path, k], parent: node };
        queue.push({ node: v, path: [...path, k] });
      }
    }
  }
  return null;
}

function collectFormSubmitUsernames(events: CapturedEvent[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'submit') continue;
    try {
      const detail = JSON.parse(ev.detail) as {
        fields?: Array<{ name?: string; type?: string; value?: string }>;
      };
      for (const f of detail.fields ?? []) {
        if (f.name && f.value && f.type !== 'password' && isUsernameKey(f.name)) {
          out.add(f.value);
        }
      }
    } catch {
      // ignore malformed details
    }
  }
  return out;
}

/** Fallback credential extraction for logins the username+password pairer
 *  misses — passwordless / OTP-only flows (e.g. email + emailed code, magic
 *  link) where the only "credential" the user supplies is an identifier, and
 *  the second factor replaces the password. Driven by the build plan's
 *  `authTool`: we look ONLY in the declared login request(s) and map each
 *  planner-declared `credentialNames` entry to a value, gated by either an
 *  exact field-name match or a username-like field whose value the user
 *  actually typed into a form submit (DOM confirmation) — so a stray email
 *  from analytics is never mistaken for a credential. Returns the values plus
 *  redaction replacements so the redacted session can show `${credential.X}`.
 *  Form-urlencoded bodies only (the common shape for these legacy forms). */
export function deriveLoginCredentials(
  session: Session,
  loginRequestSeqs: number[],
  credentialNames: string[],
): { values: Record<string, string>; replacements: Replacement[] } {
  const values: Record<string, string> = {};
  const replacements: Replacement[] = [];
  if (loginRequestSeqs.length === 0 || credentialNames.length === 0) {
    return { values, replacements };
  }
  const typedInDom = collectFormSubmitUsernames(session.events);
  const seqs = new Set(loginRequestSeqs);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const req of session.requests) {
    if (!seqs.has(req.seq) || !req.body) continue;
    const pairs = parseFormBody(req.body);
    if (pairs.length === 0) continue;
    for (const name of credentialNames) {
      if (values[name]) continue;
      // 1. Exact-ish field-name match (e.g. credentialName "email" → key "email").
      let hit = pairs.find((p) => norm(p.key) === norm(name) && p.value.length > 0);
      // 2. A username-like field whose value the user actually typed (DOM-confirmed).
      if (!hit) {
        hit = pairs.find(
          (p) => isUsernameKey(p.key) && p.value.length > 0 && typedInDom.has(p.value),
        );
      }
      if (hit) {
        values[name] = hit.value;
        replacements.push({
          requestSeq: req.seq,
          location: { kind: 'body-form', key: hit.key },
          originalValue: hit.value,
          placeholder: `\${credential.${name}}`,
        });
      }
    }
  }
  return { values, replacements };
}

/** Swap form-field values in a session's request bodies for their
 *  `${credential.X}` placeholders, in place. Used to back-fill credential
 *  placeholders into an already-redacted session once the build plan has
 *  identified passwordless credential fields (see `deriveLoginCredentials`).
 *  Preserves the original key encoding; only the value is replaced. */
export function applyCredentialPlaceholders(session: Session, replacements: Replacement[]): void {
  const bySeq = new Map<number, Map<string, string>>();
  for (const r of replacements) {
    if (r.location.kind !== 'body-form') continue;
    const m = bySeq.get(r.requestSeq) ?? new Map<string, string>();
    m.set(r.location.key, r.placeholder);
    bySeq.set(r.requestSeq, m);
  }
  for (const req of session.requests) {
    const keys = bySeq.get(req.seq);
    if (!keys || !req.body) continue;
    req.body = req.body
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const rawK = pair.slice(0, eq);
        let k: string;
        try {
          k = decodeURIComponent(rawK);
        } catch {
          k = rawK;
        }
        const placeholder = keys.get(k);
        return placeholder ? `${rawK}=${placeholder}` : pair;
      })
      .join('&');
  }
}

/** Parse `a=1&b=2` into pairs, URL-decoding both sides. Best-effort: bad
 *  pairs get skipped. */
export function parseFormBody(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const rawK = pair.slice(0, eq);
    const rawV = pair.slice(eq + 1);
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(rawK);
    } catch {
      k = rawK;
    }
    try {
      v = decodeURIComponent(rawV);
    } catch {
      v = rawV;
    }
    out.push({ key: k, value: v });
  }
  return out;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search ? '?…' : ''}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}
