/**
 * Minimal browser-compatible cookie jar for replay.
 *
 * This is the minimal compatible wrapper for the v1 state model. It keeps the
 * needed surface small: Set-Cookie ingestion, request-url matching, path
 * ordering, deletion, and ambiguity detection for scalar `${cookie.*}` lookups.
 * `tough-cookie` can replace this after an audit of browser-compatibility,
 * ESM/Bun support, public suffix behavior, license, and security history.
 * CHIPS/partitioned cookies and full SameSite context enforcement are out of
 * scope for v1.
 */

import { createHash } from 'node:crypto';

export interface RuntimeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  hostOnly?: boolean;
  creationIndex?: number;
  /** Exact browser observation when an independent HTTP response changed this scope. */
  httpResponse?: { browserSnapshotHash: string | null; deleted?: boolean };
}

export interface CookieLookupConstraints {
  url?: string;
  domain?: string;
  path?: string;
  sameSite?: string;
  allowHttpOnlyProjection?: boolean;
}

type CookieLookupResult =
  | { ok: true; cookie: RuntimeCookie }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'httponly'; matches: RuntimeCookie[] };

let globalCreationIndex = 0;

export class RuntimeCookieJar {
  private cookies: RuntimeCookie[] = [];

  constructor(cookies: RuntimeCookie[] = []) {
    for (const c of cookies) this.setCookie(c);
  }

  clone(): RuntimeCookieJar {
    return new RuntimeCookieJar(this.cookies.map((c) => ({ ...c })));
  }

  toJSON(): RuntimeCookie[] {
    return this.cookies.map((c) => ({ ...c }));
  }

  /** Reconcile a complete browser snapshot, including cookies it removed. */
  replace(cookies: RuntimeCookie[]): void {
    this.cookies = [];
    for (const cookie of cookies) this.setCookie(cookie);
  }

  /** Restore actual browser state while retaining HTTP changes whose browser
   * baseline has not changed since that response, including deletion markers. */
  restoreBrowserSnapshot(cookies: RuntimeCookie[]): void {
    const observed = new RuntimeCookieJar(cookies);
    const independent = this.cookies.filter(
      (cookie) =>
        cookie.httpResponse !== undefined &&
        cookie.httpResponse.browserSnapshotHash === observed.scopeHash(cookie),
    );
    this.replace([...cookies, ...independent]);
  }

  private scopeHash(cookie: RuntimeCookie): string | null {
    const matching = this.cookies.find((entry) => cookieScopeKey(entry) === cookieScopeKey(cookie));
    if (!matching) return null;
    const { name, value, domain, path, expires, sameSite, hostOnly } = matching;
    return createHash('sha256')
      .update(
        JSON.stringify({
          name,
          value,
          domain,
          path,
          expires,
          sameSite,
          hostOnly,
          secure: Boolean(matching.secure),
          httpOnly: Boolean(matching.httpOnly),
        }),
      )
      .digest('hex');
  }

  /** Reconcile browser changes while retaining independent HTTP Set-Cookie
   * changes that the browser has not observed. The caller owns the previous
   * browser snapshot separately from this mixed-transport jar. */
  reconcileBrowserSnapshot(cookies: RuntimeCookie[], previous: RuntimeCookieJar): void {
    const next = new RuntimeCookieJar(cookies);
    const scope = cookieScopeKey;
    const before = new Map(previous.cookies.map((cookie) => [scope(cookie), cookie]));
    const after = new Map(next.cookies.map((cookie) => [scope(cookie), cookie]));
    const current = new Map(this.cookies.map((cookie) => [scope(cookie), cookie]));
    const equal = (a: RuntimeCookie | undefined, b: RuntimeCookie | undefined) => {
      const fields: (keyof RuntimeCookie)[] = [
        'name',
        'value',
        'domain',
        'path',
        'expires',
        'httpOnly',
        'secure',
        'sameSite',
        'hostOnly',
      ];
      return (
        a === b ||
        Boolean(
          a &&
            b &&
            fields.every((field) =>
              field === 'secure' || field === 'httpOnly'
                ? Boolean(a[field]) === Boolean(b[field])
                : a[field] === b[field],
            ),
        )
      );
    };
    this.cookies = this.cookies.filter((cookie) => {
      const key = scope(cookie);
      return !before.has(key) || after.has(key) || !equal(cookie, before.get(key));
    });
    for (const [key, cookie] of after) {
      if (!equal(cookie, before.get(key)) || equal(current.get(key), before.get(key)))
        this.setCookie(cookie);
    }
    previous.replace(cookies);
  }

  setCookie(cookie: RuntimeCookie): void {
    const normalized = normalizeCookie(cookie);
    const idx = this.cookies.findIndex((c) => cookieScopeKey(c) === cookieScopeKey(normalized));

    if (isExpired(normalized) && !normalized.httpResponse?.deleted) {
      if (idx >= 0) this.cookies.splice(idx, 1);
      return;
    }

    if (idx >= 0) {
      const previous = this.cookies[idx];
      this.cookies[idx] = {
        ...normalized,
        creationIndex: previous?.creationIndex ?? normalized.creationIndex,
      };
    } else {
      this.cookies.push(normalized);
    }
  }

  setCookieFromHeader(
    setCookie: string,
    requestUrl: string,
    browserSnapshot?: RuntimeCookieJar,
  ): void {
    const parsed = parseSetCookie(setCookie, requestUrl);
    if (parsed) {
      if (browserSnapshot)
        parsed.httpResponse = {
          browserSnapshotHash: browserSnapshot.scopeHash(parsed),
          ...(isExpired(parsed) ? { deleted: true } : {}),
        };
      this.setCookie(parsed);
    }
  }

  getCookieHeader(url: string): string | null {
    const matching = this.matchingCookies(url).sort(cookieHeaderSort);
    if (!matching.length) return null;
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  lookup(
    name: string,
    requestUrl: string,
    constraints: CookieLookupConstraints = {},
  ): CookieLookupResult {
    const url = constraints.url ?? requestUrl;
    let matching = this.matchingCookies(url).filter((c) => c.name === name);
    if (constraints.domain) {
      const domain = normalizeDomain(constraints.domain);
      matching = matching.filter((c) => normalizeDomain(c.domain) === domain);
    }
    if (constraints.path) matching = matching.filter((c) => c.path === constraints.path);
    if (constraints.sameSite) {
      matching = matching.filter(
        (c) => (c.sameSite ?? '').toLowerCase() === constraints.sameSite?.toLowerCase(),
      );
    }

    if (!matching.length) return { ok: false, reason: 'missing', matches: [] };
    if (matching.length > 1) {
      return { ok: false, reason: 'ambiguous', matches: matching.sort(cookieHeaderSort) };
    }
    const top = matching[0];
    if (!top) return { ok: false, reason: 'missing', matches: [] };
    if (top.httpOnly && constraints.allowHttpOnlyProjection !== true) {
      return { ok: false, reason: 'httponly', matches: [top] };
    }
    return { ok: true, cookie: top };
  }

  private matchingCookies(url: string): RuntimeCookie[] {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || '/';
    const secure = parsed.protocol === 'https:';
    const nowSeconds = Date.now() / 1000;

    return this.cookies.filter((c) => {
      if (c.httpResponse?.deleted) return false;
      if (c.expires !== undefined && c.expires <= nowSeconds) return false;
      if (c.secure && !secure) return false;
      if (!domainMatches(c, host)) return false;
      return pathMatches(c.path, path);
    });
  }
}

export function extractSetCookieHeaders(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const sc = headers.get('set-cookie');
  return sc ? splitSetCookieHeader(sc) : [];
}

/** Split a concatenated Set-Cookie header without splitting inside Expires. */
export function splitSetCookieHeader(joined: string): string[] {
  return joined.split(/,\s*(?=[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/);
}

function parseSetCookie(setCookie: string, requestUrl: string): RuntimeCookie | null {
  const parts = setCookie.split(';').map((s) => s.trim());
  const first = parts[0] ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  const cookie: RuntimeCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    domain: url.hostname,
    path: defaultPath(url.pathname),
    hostOnly: true,
  };

  for (const attr of parts.slice(1)) {
    const attrEq = attr.indexOf('=');
    const rawName = attrEq === -1 ? attr : attr.slice(0, attrEq);
    const rawValue = attrEq === -1 ? '' : attr.slice(attrEq + 1);
    const name = rawName.toLowerCase();

    if (name === 'domain') {
      cookie.domain = normalizeDomain(rawValue);
      cookie.hostOnly = false;
    } else if (name === 'path') {
      cookie.path = rawValue.startsWith('/') ? rawValue : '/';
    } else if (name === 'expires') {
      const ms = Date.parse(rawValue);
      if (!Number.isNaN(ms)) cookie.expires = Math.floor(ms / 1000);
    } else if (name === 'max-age') {
      const seconds = Number.parseInt(rawValue, 10);
      if (Number.isFinite(seconds)) cookie.expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (name === 'httponly') {
      cookie.httpOnly = true;
    } else if (name === 'secure') {
      cookie.secure = true;
    } else if (name === 'samesite') {
      cookie.sameSite = rawValue;
    }
  }

  return normalizeCookie(cookie);
}

/** Chromium stores host-only and domain cookies as distinct scopes even when
 * their names, normalized domains, and paths match. */
export function cookieScopeKey(
  cookie: Pick<RuntimeCookie, 'name' | 'domain' | 'path' | 'hostOnly'>,
): string {
  return JSON.stringify([
    normalizeDomain(cookie.domain),
    cookie.hostOnly ?? !cookie.domain.startsWith('.'),
    cookie.path || '/',
    cookie.name,
  ]);
}

function normalizeCookie(cookie: RuntimeCookie): RuntimeCookie {
  const expires = cookie.expires === -1 ? undefined : cookie.expires;
  return {
    ...cookie,
    expires,
    domain: normalizeDomain(cookie.domain),
    path: cookie.path || '/',
    hostOnly: cookie.hostOnly ?? !cookie.domain.startsWith('.'),
    creationIndex: cookie.creationIndex ?? globalCreationIndex++,
  };
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, '').toLowerCase();
}

function isExpired(cookie: RuntimeCookie): boolean {
  return cookie.expires !== undefined && cookie.expires <= Date.now() / 1000;
}

function domainMatches(cookie: RuntimeCookie, host: string): boolean {
  const dom = normalizeDomain(cookie.domain);
  return cookie.hostOnly ? host === dom : host === dom || host.endsWith(`.${dom}`);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function defaultPath(pathname: string): string {
  if (!pathname || pathname[0] !== '/') return '/';
  if (pathname === '/') return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}

function cookieHeaderSort(a: RuntimeCookie, b: RuntimeCookie): number {
  return (
    b.path.length - a.path.length ||
    Number(b.hostOnly === true) - Number(a.hostOnly === true) ||
    (a.creationIndex ?? 0) - (b.creationIndex ?? 0)
  );
}
