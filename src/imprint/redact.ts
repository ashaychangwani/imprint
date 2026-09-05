/**
 * Protect known login credentials only; ordinary API data is preserved.
 * A "redacted" recording is not a share-safe file.
 */
import { splitSetCookieHeader } from './cookie-jar.ts';
import { type Replacement, extractCredentials } from './credential-extract.ts';
import { redactFreeformText } from './freeform-redact.ts';
import { isAlwaysSecretHeader, isSensitiveHeader } from './sensitive-keys.ts';
import type { Session } from './types.ts';
const USER_INTERACTION_TYPES = new Set(['click', 'input', 'change', 'submit']);
const MULTI_VALUE_HEADERS = new Set(['cookie', 'set-cookie']);
// Retained for build-plan evidence, not redaction.
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

interface RedactionStats {
  totalRedactions: number;
  requestsRedacted: number;
  cookiesRedacted: number;
  placeholdersInjected: number;
  freeformRedactions: number;
  warnings: string[];
}
interface RedactOptions {
  replacements?: Replacement[];
}
export function redactSession(
  session: Session,
  opts: RedactOptions = {},
): { session: Session; stats: RedactionStats } {
  const replacements = opts.replacements ?? extractCredentials(session).replacements;
  const values = new Map(
    replacements.map(({ originalValue, placeholder }) => [originalValue, placeholder]),
  );
  const stats: RedactionStats = {
    totalRedactions: 0,
    requestsRedacted: 0,
    cookiesRedacted: 0,
    placeholdersInjected: 0,
    freeformRedactions: 0,
    warnings: [],
  };
  function protect<T>(value: T): T {
    if (typeof value === 'string') {
      const result = redactFreeformText(value, values);
      stats.totalRedactions += result.redactionsCount;
      stats.placeholdersInjected += result.redactionsCount;
      return result.redacted as T;
    }
    if (Array.isArray(value)) return value.map(protect) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, protect(item)]),
      ) as T;
    }
    return value;
  }
  const requests = session.requests.map((request) => {
    const before = stats.totalRedactions;
    const result = protect(request);
    if (stats.totalRedactions > before) stats.requestsRedacted++;
    return result;
  });
  const rest = protect({ ...session, requests: [] });
  return { session: { ...rest, requests }, stats };
}
