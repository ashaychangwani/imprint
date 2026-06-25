/**
 * File-backed cache for a cdp-browser-minted Akamai jar (MintedJar), so the
 * "bootstrap-then-fetch" path launches a real Chrome ONCE per validity window
 * and then replays many searches via plain fetch with the cached jar.
 *
 * Validity window: Akamai's ak_bmsc + bm_sv expire ~2h FIXED from first page
 * load (non-sliding — activity does not extend it), so we operate well under
 * that and re-mint after 90 min (JAR_MAX_AGE_SECONDS). A jar is only reusable
 * while its `_abck` is still validated (`~0~`); a jar that has gone stale
 * self-heals via the reactive `clearJar` on a replay 401/403/428/429.
 *
 * The file holds a LIVE session credential (validated _abck + session cookies).
 * It lives under ~/.imprint/<site>/ (never the repo), is gitignored, and must
 * never be copied into examples/ fixtures, PRs, or screenshots.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join as pathJoin } from 'node:path';
import { type MintedJar, jarCookiesValidated } from './cdp-browser-fetch.ts';
import { createLog } from './log.ts';

const log = createLog('cdp-jar');

const JAR_FILE = '.cdp-jar.json';

/** Re-mint after 90 min. The hard ceiling is the ~2h fixed ak_bmsc/bm_sv TTL;
 *  90 min leaves margin for snapshot-issuance skew. */
export const JAR_MAX_AGE_SECONDS = 5400;

/** Effective max jar/recording age. Defaults to JAR_MAX_AGE_SECONDS but can be
 *  raised via IMPRINT_JAR_MAX_AGE_SECONDS for a long single-IP teach where the
 *  recording must stay seedable for the whole compile (the real Akamai TTL is
 *  ~2h, so values up to ~6900s are still safe). Clamped to the ~2h hard ceiling
 *  so a typo can't push past the real cookie expiry. Read per-call. */
function jarMaxAgeSeconds(): number {
  const raw = Number(process.env.IMPRINT_JAR_MAX_AGE_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 7200);
  return JAR_MAX_AGE_SECONDS;
}

function jarPath(siteDir: string): string {
  return pathJoin(siteDir, JAR_FILE);
}

/** Load a cached jar, or null if absent / malformed / aged-out / not validated.
 *  The cached `ua` is reused for replay verbatim; a UA drift (Chrome auto-update
 *  mid-window) is rare and self-heals reactively on a replay 403, so we do NOT
 *  launch Chrome just to gate on UA here. */
export function loadJar(siteDir: string): MintedJar | null {
  const p = jarPath(siteDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<MintedJar>;
    if (!raw || !Array.isArray(raw.cookies) || typeof raw.bootstrapEpoch !== 'number') return null;
    const ageSeconds = (Date.now() - raw.bootstrapEpoch) / 1000;
    const maxAge = jarMaxAgeSeconds();
    if (ageSeconds >= maxAge) {
      log(`cached jar in ${siteDir} is ${Math.round(ageSeconds)}s old (>= ${maxAge}s) — re-mint`);
      return null;
    }
    // Validated = `_abck~0~` OR `bm_sv` present (the latter survives `_abck`
    // rotating back to `~-1~`). Fall back to the abckFlag check for caches
    // written before the `validated` field existed.
    const validated = raw.validated ?? raw.abckFlag === '0';
    if (!validated) {
      log(`cached jar not validated (_abck~${raw.abckFlag}~, no bm_sv) — re-mint`);
      return null;
    }
    return raw as MintedJar;
  } catch {
    return null;
  }
}

/** Persist a minted jar (atomic temp + rename). Best-effort. */
export function saveJar(siteDir: string, jar: MintedJar): void {
  try {
    mkdirSync(siteDir, { recursive: true });
    const p = jarPath(siteDir);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(jar)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    log(`failed to persist jar to ${siteDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove a cached jar (best-effort) — call on a replay 401/403/428/429 so the
 *  next call re-mints (reactive self-heal), or when a site's teach run ends. */
export function clearJar(siteDir: string): void {
  try {
    rmSync(jarPath(siteDir), { force: true });
  } catch {
    // best-effort
  }
}

/** Path + mtime of the newest raw recorded session (excludes .redacted/.triaged),
 *  or null. Lets callers prefer a fresh recording over an older cached jar — e.g.
 *  after the user re-records on a new IP, the fresh recording must supersede the
 *  stale (old-IP) cached jar, which would otherwise tarpit. */
export function newestRecording(siteDir: string): { path: string; mtimeMs: number } | null {
  const sessionsDir = pathJoin(siteDir, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  let path = '';
  let mtimeMs = 0;
  try {
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith('.json') || f.endsWith('.redacted.json') || f.endsWith('.triaged.json')) {
        continue;
      }
      // Skip synthetic `combined-*` merges — the jar must come from a GENUINE
      // single browser recording whose `end` cookieSnapshot carries the real
      // validated session (bm_sv). A combined session is a merge for tool
      // detection and may not preserve a usable validated snapshot. (teach
      // writes a fresh combined-*.json, so without this it'd be "newest".)
      if (f.startsWith('combined-')) continue;
      const p = pathJoin(sessionsDir, f);
      const m = statSync(p).mtimeMs;
      if (m > mtimeMs) {
        mtimeMs = m;
        path = p;
      }
    }
  } catch {
    return null;
  }
  return path ? { path, mtimeMs } : null;
}

/**
 * Seed the jar cache from the most recent RECORDED session for this site, if
 * fresh + validated. The recording is a REAL browser session, so its `_abck`
 * is HIGH-TRUST (genuine interaction → many sequential .act succeed) — strictly
 * better than a synthetic cdp-browser mint, whose quickly-validated `_abck` is
 * low-trust and gets rate-tarpitted. This is the imprint-native pure-API path:
 * "the recording IS the executable" — replay reuses the session the user already
 * validated, via plain fetch. Returns true if a jar was seeded.
 *
 * Reads the newest raw session (not `.redacted`/`.triaged`), takes the validated
 * "end" cookieSnapshot + the recording's UA, and saves a MintedJar. Bound to the
 * recording's IP/UA, so a later 403 (IP/UA changed, or expiry) self-heals to a
 * fresh mint via clearJar. `siteDir` is `~/.imprint/<site>`.
 */
export function seedJarFromRecording(
  siteDir: string,
  // Reuse a newestRecording() result the caller already computed (avoids a
  // second readdir+stat and closes the tiny TOCTOU window between the
  // supersede check and the seed). Falls back to a fresh lookup if omitted.
  precomputed?: { path: string; mtimeMs: number } | null,
  // The workflow's bootstrap page URL (if any), so jar.html is seeded from the
  // recorded response for THAT page — the same page a fresh cdp mint would
  // navigate to. Falls back to the largest recorded text/html Document body.
  bootstrapUrl?: string,
): boolean {
  const found = precomputed ?? newestRecording(siteDir);
  if (!found) return false;
  const newest = found.path;
  const newestMtime = found.mtimeMs;
  const ageSeconds = (Date.now() - newestMtime) / 1000;
  const maxAge = jarMaxAgeSeconds();
  if (ageSeconds >= maxAge) {
    log(`newest recording is ${Math.round(ageSeconds)}s old (>= ${maxAge}s) — not seeding`);
    return false;
  }
  let session: {
    cookieSnapshots?: Array<{ label?: string; cookies?: Array<Record<string, unknown>> }>;
    requests?: Array<{
      requestHeaders?: unknown;
      headers?: unknown;
      url?: string;
      method?: string;
      resourceType?: string;
      response?: { status?: number; mimeType?: string; body?: string };
    }>;
  };
  try {
    session = JSON.parse(readFileSync(newest, 'utf8'));
  } catch {
    return false;
  }
  const snaps = session.cookieSnapshots ?? [];
  const end = snaps.find((s) => s.label === 'end') ?? snaps[snaps.length - 1];
  if (!end || !Array.isArray(end.cookies)) return false;
  const cookies = end.cookies.map((c) => ({
    name: c.name as string,
    value: c.value as string,
    domain: c.domain as string,
    path: (c.path as string) ?? '/',
    expires: typeof c.expires === 'number' && c.expires > 0 ? (c.expires as number) : undefined,
    httpOnly: c.httpOnly as boolean | undefined,
    secure: c.secure as boolean | undefined,
    sameSite: c.sameSite as string | undefined,
  }));
  const abck = cookies.find((c) => c.name === '_abck')?.value;
  const abckFlag = abck?.split('~')[1] ?? '?';
  // Validated = `_abck~0~` OR a `bm_sv` cookie (Akamai's validated-session
  // marker). `_abck` rotates back to `~-1~` after clearing a request, so a real
  // working recording often ends with `_abck~-1~` + `bm_sv` — that jar replays
  // fine (verified live: 609KB results). Gating on `_abck==='0'` alone wrongly
  // rejects such recordings.
  if (!jarCookiesValidated(cookies)) {
    log(`newest recording is not validated (_abck~${abckFlag}~, no bm_sv) — not seeding`);
    return false;
  }
  let ua = '';
  for (const r of session.requests ?? []) {
    let h = (r.requestHeaders ?? r.headers ?? {}) as
      | Record<string, string>
      | Array<{ name: string; value: string }>;
    if (Array.isArray(h)) h = Object.fromEntries(h.map((x) => [x.name, x.value]));
    const u =
      (h as Record<string, string>)['User-Agent'] ?? (h as Record<string, string>)['user-agent'];
    if (u) {
      ua = u;
      break;
    }
  }
  if (!ua) {
    // Replay (makeJarUaFetch) gates on a non-empty UA, so an empty one means
    // the wire UA falls back to the runtime default — which may not match the
    // UA the recording's jar was bound to and can get the jar dropped on a
    // UA-sensitive (Akamai) origin. Surface it so a mysteriously-rejected jar
    // is debuggable rather than silently degraded.
    log(
      `WARNING: no User-Agent found in recording ${newest}; seeded jar has no UA (replay will use the default UA — may not match the jar)`,
    );
  }
  // Seed jar.html from the recorded bootstrap page so html_regex bootstrap
  // captures (csrf / csp-nonce scraped from the page) resolve on the
  // recording-seed path — exactly as they would from a fresh cdp mint's
  // captured HTML. Without this (the old `html: ''`), any workflow whose
  // requests reference `${state.X}` from an html_regex capture STATE_MISSINGs.
  const html = pickBootstrapHtml(session.requests ?? [], bootstrapUrl);
  saveJar(siteDir, {
    cookies,
    ua,
    html,
    bootstrapEpoch: Math.round(newestMtime),
    abckFlag,
    validated: true, // gated above on jarCookiesValidated
    source: 'recording',
  });
  log(
    `seeded jar from recording ${newest} (${cookies.length} cookies, _abck~${abckFlag}~, bm_sv-validated, ua=${ua ? `${ua.slice(0, 40)}…` : '(none)'}, html=${html.length}b)`,
  );
  return true;
}

/**
 * Choose the recorded HTML to seed into jar.html for html_regex bootstrap
 * captures. Preference order: (1) the recorded response for the exact bootstrap
 * URL; (2) same origin+path (query stripped — the bootstrap URL may carry
 * params the recording didn't); (3) the largest recorded text/html Document
 * body (the app shell / fully-rendered page most likely to carry csrf/nonce).
 * Returns '' if the recording has no usable HTML document.
 */
function pickBootstrapHtml(
  requests: Array<{
    url?: string;
    method?: string;
    resourceType?: string;
    response?: { mimeType?: string; body?: string };
  }>,
  bootstrapUrl?: string,
): string {
  const hasBody = (r: { response?: { body?: string } }): boolean =>
    typeof r.response?.body === 'string' && r.response.body.length > 0;
  // A bootstrap "page" is a top-level navigation Document, not an XHR fragment
  // (e.g. costco's rentalCarDetails.act is XHR + text/html but is NOT a page).
  // Prefer real Documents; only broaden to any text/html body if the recording
  // has no Document responses (older recordings may lack resourceType).
  const documents = requests.filter((r) => r.resourceType === 'Document' && hasBody(r));
  const docs =
    documents.length > 0
      ? documents
      : // Older recordings may lack resourceType. Broaden to text/html bodies, but
        // still exclude XHR-shaped endpoints (GET-only, no `.act`/`/api/`) so we
        // don't seed an XHR fragment (e.g. rentalCarDetails.act) as the page.
        requests.filter(
          (r) =>
            (r.response?.mimeType ?? '').includes('text/html') &&
            hasBody(r) &&
            (r.method ?? 'GET').toUpperCase() === 'GET' &&
            !/\.act(\?|$)|\/api\//i.test(r.url ?? ''),
        );
  if (docs.length === 0) return '';
  if (bootstrapUrl) {
    const exact = docs.find((r) => r.url === bootstrapUrl);
    if (exact?.response?.body) return exact.response.body;
    try {
      const want = new URL(bootstrapUrl);
      const samePath = docs.find((r) => {
        try {
          const u = new URL(r.url ?? '');
          return u.origin === want.origin && u.pathname === want.pathname;
        } catch {
          return false;
        }
      });
      if (samePath?.response?.body) return samePath.response.body;
    } catch {
      // bootstrapUrl not a valid URL — fall through to largest-body
    }
  }
  return (
    docs.reduce((best, r) =>
      (r.response?.body?.length ?? 0) > (best.response?.body?.length ?? 0) ? r : best,
    ).response?.body ?? ''
  );
}
