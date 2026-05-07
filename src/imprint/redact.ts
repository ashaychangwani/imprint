/**
 * Credential / PII redaction. Replaces values of known-sensitive fields
 * with `[REDACTED:N]` (N = original length) so the LLM still sees the
 * shape but never the secret. Best-effort — see docs/troubleshooting.md
 * for what it doesn't catch (response bodies, URL path segments, etc.)
 * and how to audit a redacted session.
 */

import type { Session } from './types.ts';

/** Case-insensitive key match. Values aren't pattern-matched — that's a
 *  separate high-false-positive problem we punt on. */
const SENSITIVE_KEYS = [
  // Credentials — login identifiers
  'user',
  'username',
  'user_name',
  'userid',
  'user_id',
  'login',
  'loginid',
  'login_id',
  // Credentials — passwords & secrets
  'pass',
  'password',
  'passwd',
  'pwd',
  'pin',
  'secret',
  'credential',
  'credentials',
  // Tokens & session identifiers
  'token',
  'auth',
  'authcode',
  'auth_code',
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
  'authorization',
  'authentication',
  'bearer',
  // CSRF / XSRF
  'csrf',
  'csrf_token',
  'csrftoken',
  'xsrf',
  'xsrf_token',
  'xsrftoken',
  // MFA / OTP
  'otp',
  'totp',
  'mfa_code',
  'mfacode',
  'verification_code',
  'verificationcode',
  'oktaemail',
  'okta_email',
  // Device / browser fingerprinting
  'fingerprint',
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
  // PII — contact
  'email',
  'emailaddress',
  'email_address',
  'phone',
  'phonenumber',
  'phone_number',
  'mobile',
  'cell',
  'sms',
  'smsnumber',
  'sms_number',
  // PII — names
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  'nameoncard',
  'name_on_card',
  // PII — government / identity
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
        } else if (typeof v === 'string' && v.length > 1 && (v[0] === '{' || v[0] === '[')) {
          // JSON-in-JSON: try to parse and redact the nested string.
          try {
            const inner = JSON.parse(v);
            const visited = visit(inner);
            out[k] = JSON.stringify(visited);
          } catch {
            out[k] = v;
          }
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
  if (ct.includes('urlencoded')) {
    return redactFormBody(body);
  }
  // Try JSON first — many APIs send JSON as text/plain or with no content-type.
  const jsonR = redactJsonBody(body);
  if (jsonR.redactionsCount > 0) return jsonR;
  // JSON parsed but found nothing sensitive — check if it actually was JSON
  // (successfully parsed) vs. random text that happened to not throw.
  try {
    JSON.parse(body);
    return jsonR;
  } catch {
    // Not valid JSON — try form-encoded as last resort.
    return redactFormBody(body);
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
    warnings: [],
  };
  const keepHeaders = new Set((opts.keepHeaders ?? []).map((h) => h.toLowerCase()));

  const redactedRequests = session.requests.map((req) => {
    let touched = 0;

    const urlR = redactUrl(req.url);
    touched += urlR.redactionsCount;

    const headersR = redactHeaders(req.headers, keepHeaders);
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
