/**
 * Credential / PII redaction for captured sessions.
 *
 * Captures often contain credentials in places nobody thinks to look:
 *   - Login POST bodies (patronPassword, password, token, ...)
 *   - URL query strings (apiKey=..., access_token=..., patronNumber=...)
 *   - Authorization / Cookie / X-CSRF-Token request headers
 *   - Set-Cookie response headers
 *   - End-of-session cookie snapshots (the actual session cookie value)
 *
 * Before any captured session is sent to an LLM (day 3 codegen), we scrub
 * these. The LLM still needs to know the SHAPE — which fields exist, what
 * type they are — so it can parameterize the workflow. So we replace VALUES
 * with `[REDACTED:N]` markers (N = original length) instead of removing
 * the field entirely.
 *
 * This is best-effort. It catches the common cases. It will NOT catch:
 *   - Credentials embedded in arbitrary response bodies (HTML pages, JSON)
 *   - Custom field names a site invents that don't match the patterns below
 *   - Credentials encoded as part of a URL path segment (vs query string)
 *
 * If you're using Imprint on a site with unusual auth, audit the redacted
 * session before generating against it.
 */

import type { Session } from './types.ts';

/**
 * Field names whose values get replaced. Match is case-insensitive on the
 * KEY only; values are not pattern-matched, so "patronPassword: hunter2"
 * is redacted but a value that happens to look like a JWT in some other
 * field is not. (Catching value patterns is a separate, higher-false-positive
 * problem we punt on.)
 */
const SENSITIVE_KEYS = [
  // Generic auth
  'password',
  'passwd',
  'pwd',
  'pin',
  'secret',
  'token',
  'auth',
  'apikey',
  'api_key',
  'apitoken',
  'api_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessionid',
  'session_id',
  'sessiontoken',
  'session_token',
  'csrf',
  'csrf_token',
  'csrftoken',
  'xsrf',
  'xsrf_token',
  'xsrftoken',
  'authorization',
  'authentication',
  'bearer',
  // Site-specific (Discover & Go uses these)
  'patronpassword',
  'patron_password',
  'patronnumber',
  'patron_number',
  'cardnumber',
  'card_number',
  'librarycard',
  'library_card',
  // Stripe / payments
  'cvc',
  'cvv',
  'cardnum',
  'card_num',
  'creditcard',
  'credit_card',
  'cc_number',
  // Personal info worth redacting
  'ssn',
  'socialsecurity',
  'social_security',
  'dateofbirth',
  'date_of_birth',
  'dob',
];

/** Header names whose values get fully replaced. Case-insensitive. */
const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-api-key',
  'x-apikey',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'proxy-authorization',
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS.map((h) => h.toLowerCase()));

const REDACTED = (originalLength: number): string => `[REDACTED:${originalLength}]`;

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY_SET.has(key.toLowerCase().replace(/[-_]/g, ''));

const isSensitiveHeader = (header: string): boolean =>
  SENSITIVE_HEADER_SET.has(header.toLowerCase());

/** Redact all values of sensitive keys in a www-form-urlencoded body string. */
export function redactFormBody(body: string): { redacted: string; redactionsCount: number } {
  let count = 0;
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
    if (isSensitiveKey(decodedKey)) {
      count++;
      return `${rawKey}=${REDACTED(rawVal.length)}`;
    }
    return pair;
  });
  return { redacted: parts.join('&'), redactionsCount: count };
}

/** Redact sensitive keys inside a JSON-stringified body. Returns body unchanged on parse failure. */
export function redactJsonBody(body: string): { redacted: string; redactionsCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { redacted: body, redactionsCount: 0 };
  }

  let count = 0;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number')) {
          count++;
          out[k] = REDACTED(String(v).length);
        } else {
          out[k] = visit(v);
        }
      }
      return out;
    }
    return node;
  };
  const redacted = JSON.stringify(visit(parsed));
  return { redacted, redactionsCount: count };
}

/** Redact a request body of unknown content-type. Tries JSON first, falls back to form. */
export function redactBody(
  body: string,
  contentType?: string,
): { redacted: string; redactionsCount: number } {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) {
    const r = redactJsonBody(body);
    if (r.redactionsCount > 0) return r;
    // JSON parse may have succeeded with no redactions — accept the round-trip.
    return r;
  }
  if (ct.includes('urlencoded') || body.includes('=')) {
    return redactFormBody(body);
  }
  // Try JSON anyway as a last resort — many APIs send JSON without a content-type.
  return redactJsonBody(body);
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
export function redactHeaders(headers: Record<string, string>): {
  redacted: Record<string, string>;
  redactionsCount: number;
} {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k)) {
      out[k] = REDACTED(v.length);
      count++;
    } else {
      out[k] = v;
    }
  }
  return { redacted: out, redactionsCount: count };
}

export interface RedactionStats {
  /** Number of individual values replaced across the entire session. */
  totalRedactions: number;
  /** Number of requests touched (had at least one redaction). */
  requestsRedacted: number;
  /** Number of cookies whose VALUES were replaced. */
  cookiesRedacted: number;
  /** Detected sensitive items that you should be aware of (for the user-facing report). */
  warnings: string[];
}

/** Produce a scrubbed copy of a session safe to send to an LLM. */
export function redactSession(session: Session): { session: Session; stats: RedactionStats } {
  const stats: RedactionStats = {
    totalRedactions: 0,
    requestsRedacted: 0,
    cookiesRedacted: 0,
    warnings: [],
  };

  const redactedRequests = session.requests.map((req) => {
    let touched = 0;

    const urlR = redactUrl(req.url);
    touched += urlR.redactionsCount;

    const headersR = redactHeaders(req.headers);
    touched += headersR.redactionsCount;

    let body = req.body;
    if (body) {
      const ct = req.headers['content-type'] ?? req.headers['Content-Type'];
      const bodyR = redactBody(body, ct);
      body = bodyR.redacted;
      touched += bodyR.redactionsCount;
    }

    let response = req.response;
    if (response) {
      const respHeadersR = redactHeaders(response.headers);
      touched += respHeadersR.redactionsCount;
      response = {
        ...response,
        headers: respHeadersR.redacted,
        // Response bodies may contain PII (user's name, library card, booking
        // confirmation with personal details). Default policy: leave intact
        // because the LLM needs to see them for codegen. Site-specific PII
        // redaction is a per-site concern.
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
      cookieSnapshots: redactedSnapshots,
    },
    stats,
  };
}
