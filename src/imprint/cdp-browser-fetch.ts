/**
 * Record-faithful replay transport: a `fetch`-compatible impl backed by a REAL
 * Chrome (the same `launchChromium` + raw CDP mechanism `imprint record` uses),
 * executing each request IN the page via `Runtime.evaluate(fetch)`.
 *
 * Why this exists: Akamai's behavioral defense (verified on costcotravel.com)
 * tarpits Playwright-driven Chrome — headless OR headed, stealth-patched or not —
 * because Playwright's automation instrumentation is detectable. It also tarpits
 * a real Chrome that never validates the `_abck` sensor cookie. A plain Chrome
 * spawned with no automation flags (launchChromium), driven only by CDP, plus
 * synthetic mouse/scroll to validate `_abck` (`~-1~`→`~0~`), is indistinguishable
 * from the recording session: it sustains repeated state-changing POSTs that the
 * Playwright path cannot.
 *
 * Runs HEADLESS by default. The one thing Akamai edge-blocks a headless Chrome on
 * is the `HeadlessChrome` token its `navigator.userAgent` still carries (even with
 * `--headless=new` in Chrome 148) — so we override the UA (strip the token, keep
 * the real version + matching client-hint metadata) via CDP BEFORE navigating.
 * Empirically (costcotravel.com, flagged IP): with the override, headless loads
 * the real page, `_abck` validates, and `.act` POSTs return 200 — identical to a
 * headed window. Headless needs no display (it renders offscreen); on macOS/GPU
 * hosts the WebGL renderer is the real GPU (`--use-angle=metal`), not SwiftShader.
 * `headed: true` is an escape hatch (e.g. a GPU-less Linux box where SwiftShader
 * might re-bite — pair with Xvfb via `display`).
 *
 * Executing the workflow's requests through this `fetchImpl` keeps `executeWorkflow`
 * (substitution, captures, parser) unchanged — only the transport moves into the
 * trusted browser session.
 */

import CDP from 'chrome-remote-interface';
import { launchChromium } from './chromium.ts';
import { createLog } from './log.ts';

const log = createLog('cdp-browser');

export interface MintedJar {
  /** Full cookie set (with attributes) so callers can rebuild a runtime jar. */
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }>;
  /** The exact UA the bootstrap browser presented (HeadlessChrome stripped) —
   *  replay fetches MUST send this verbatim or Akamai drops the jar. */
  ua: string;
  /** The bootstrap page HTML, so callers can satisfy html_regex captures
   *  (e.g. csrf / csp-nonce scraped from the page) without the browser. */
  html: string;
  /** Date.now() at mint — the jar's validity is bounded (~2h fixed for Akamai). */
  bootstrapEpoch: number;
  /** The final `_abck` status field at capture (`0` = validated, `-1` = pending).
   *  NOTE: `_abck` rotates — it flips to `0` to clear a request, then Akamai
   *  re-issues a fresh `-1` token that re-validates on the next sensor beat. So a
   *  jar can carry `_abck~-1~` yet still be a VALIDATED session — see `validated`. */
  abckFlag: string;
  /** Whether the session is validated and safe to replay. True when `_abck~0~`
   *  OR a `bm_sv` cookie is present (`bm_sv` is Akamai's validated-session marker,
   *  set only after the sensor accepts the session; empirically a jar with
   *  `bm_sv` replays even when `_abck` has rotated back to `~-1~`). Gating on this
   *  instead of `abckFlag==='0'` avoids rejecting a perfectly good recording whose
   *  end snapshot caught `_abck` mid-rotation. Optional for backward-compat with
   *  caches written before this field; `loadJar` falls back to `abckFlag==='0'`. */
  validated?: boolean;
  /** Provenance: 'mint' = freshly bootstrapped via cdp-browser; 'recording' =
   *  seeded from the user's recorded session. Used only for accurate diagnostics
   *  (both now carry `html`, so emptiness no longer distinguishes them). */
  source?: 'mint' | 'recording';
}

/** A session is replay-safe when `_abck` is validated (`~0~`) OR the Akamai
 *  validated-session marker `bm_sv` is present (it is only set post-validation,
 *  and survives `_abck` rotating back to `~-1~`). Shared by the cdp mint and the
 *  recording-seed paths so both judge "validated" identically. */
export function jarCookiesValidated(cookies: Array<{ name: string; value: string }>): boolean {
  const abck = cookies.find((c) => c.name === '_abck')?.value;
  if (abck && abck.split('~')[1] === '0') return true;
  return cookies.some((c) => c.name === 'bm_sv');
}

export interface CdpBrowserFetch {
  /** typeof fetch — executes the request inside the live trusted Chrome page. */
  readonly fetchImpl: typeof fetch;
  /** Force the bootstrap navigation + `_abck` validation now; returns the
   *  session cookies so callers can read session tokens (CSRF) for `${state.X}`. */
  ensureBootstrapped(): Promise<Array<{ name: string; value: string }>>;
  /** Bootstrap, then harvest the full validated jar + UA + page HTML so the
   *  caller can CLOSE the browser and replay every request via plain fetch
   *  (the "bootstrap-then-fetch" model). The jar outlives the Chrome process. */
  mintJar(): Promise<MintedJar>;
  /** Close the CDP client and the Chrome process. */
  close(): Promise<void>;
}

export interface CdpBrowserFetchOptions {
  /** Origin used to resolve relative request URLs + cookie lookups. */
  baseUrl: string;
  /** Page to navigate (the workflow's bootstrap.url when set) after the UA
   *  override is installed. With the `HeadlessChrome` token stripped, Page.navigate
   *  to a protected origin loads normally; it only stalls when the UA still leaks
   *  headless. Defaults to the origin root (which runs the sensor JS). */
  bootstrapUrl?: string;
  /** Seconds budget to validate _abck via interaction. Default 25. */
  abckWaitSeconds?: number;
  /** Per-request in-page timeout (ms). Default 30000. */
  requestTimeoutMs?: number;
  /** Launch a visible window instead of headless. Default false (headless). Only
   *  needed as a fallback on a GPU-less host where headless WebGL falls back to
   *  SwiftShader and the site fingerprints it — pair with `display`/Xvfb. */
  headed?: boolean;
  /** X display for HEADED Chrome on Linux (passed to launchChromium). Only used
   *  when `headed` is set; headless renders offscreen and needs no display. */
  display?: string;
  /** Cookies to plant into the page (via Network.setCookie) BEFORE navigating,
   *  so the live session starts from a HIGH-TRUST validated jar (the user's
   *  recording) instead of re-earning trust from a synthetic mint — which
   *  empirically can reach `_abck~0~` yet still get its `.act` POSTs tarpitted.
   *  The open browser's bmak sensor then keeps that trusted `_abck` re-validated
   *  between protected POSTs. Best-effort; failures are logged, not fatal. */
  seedCookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: number;
  }>;
}

type CdpClient = Awaited<ReturnType<typeof CDP>>;

function abckIsValidated(v: string | undefined): boolean {
  return !!v && v.split('~')[1] === '0';
}

/** Real-GPU launch flags so headless Chrome doesn't fall back to the SwiftShader
 *  software rasterizer (a behavioral-anti-bot tell). On macOS the Metal ANGLE
 *  backend yields the real GPU even headless; elsewhere request ANGLE and let
 *  Chrome pick the platform backend. Never `--disable-gpu`. */
function gpuLaunchArgs(): string[] {
  const common = ['--window-size=1920,1080', '--disable-blink-features=AutomationControlled'];
  if (process.platform === 'darwin') return ['--use-gl=angle', '--use-angle=metal', ...common];
  return ['--use-gl=angle', ...common];
}

/** Build a de-headlessed UA + matching client-hint metadata from the browser's
 *  own reported UA. The ONLY headless edge-tell Akamai keys on is the
 *  `HeadlessChrome` token; stripping it (while keeping the real version) makes the
 *  headless session indistinguishable from a headed one. Derived live so it never
 *  drifts as the bundled Chrome updates. */
function buildUaOverride(rawUa: string): {
  userAgent: string;
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>;
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
  };
} {
  const userAgent = rawUa.replace(/HeadlessChrome/g, 'Chrome');
  const major = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '148';
  const fullVersion = userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? `${major}.0.0.0`;
  const platform =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return {
    userAgent,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not.A/Brand', version: '24' },
      ],
      fullVersion,
      platform,
      platformVersion: '',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: false,
    },
  };
}

/** Create a CDP-browser-backed fetch. Lazily launches Chrome on first use. */
export function createCdpBrowserFetch(opts: CdpBrowserFetchOptions): CdpBrowserFetch {
  const baseOrigin = new URL(opts.baseUrl).origin;
  // Navigate the bootstrap page when declared; otherwise the base URL — but
  // never an obvious API/.act endpoint (opening one cold yields an error page
  // and never establishes the sensor session). Fall back to the origin root,
  // which loads a real page and runs the Akamai sensor JS.
  const baseLooksLikeApi = /\.act(\?|$)|\/api\//i.test(opts.baseUrl);
  const navUrl = opts.bootstrapUrl ?? (baseLooksLikeApi ? `${baseOrigin}/` : opts.baseUrl);
  const abckWaitMs = (opts.abckWaitSeconds ?? 25) * 1000;
  const reqTimeoutMs = opts.requestTimeoutMs ?? 30_000;

  let chrome: Awaited<ReturnType<typeof launchChromium>> | null = null;
  let client: CdpClient | null = null;
  let bootstrapped = false;
  let appliedUa: string | undefined;

  async function ensure(): Promise<CdpClient> {
    if (client && bootstrapped) return client;
    const headed = opts.headed ?? false;
    if (!chrome) {
      log(`launching real ${headed ? 'headed' : 'headless'} Chrome (will navigate ${navUrl})`);
      // Launch at about:blank — we MUST attach CDP and override the UA before the
      // first request to the protected origin fires, so we navigate via
      // Page.navigate AFTER the override rather than passing the URL at launch.
      // headless renders offscreen (no display); headed needs one (Xvfb on Linux).
      chrome = await launchChromium({
        headless: !headed,
        extraArgs: gpuLaunchArgs(),
        ...(headed ? { display: opts.display } : {}),
      });
      await chrome.ready;
    }
    if (!client) client = await CDP({ port: chrome.port });
    const { Runtime, Network, Input, Page } = client;
    await Runtime.enable();
    await Network.enable();
    await Page.enable();
    // Plant the high-trust seed cookies (the recording's validated Akamai jar)
    // BEFORE navigating, so the first request to the protected origin carries the
    // trusted session. A synthetic mint can reach `_abck~0~` yet still get its
    // `.act` tarpitted; starting from the recording's earned trust is what makes
    // the in-page protected POSTs succeed (the live bmak sensor then keeps it
    // re-validated between calls).
    if (opts.seedCookies && opts.seedCookies.length > 0) {
      let planted = 0;
      for (const c of opts.seedCookies) {
        try {
          await Network.setCookie({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path ?? '/',
            secure: c.secure ?? false,
            httpOnly: c.httpOnly ?? false,
            ...(c.sameSite ? { sameSite: normalizeSameSite(c.sameSite) } : {}),
            ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
          });
          planted++;
        } catch {
          // best-effort — a cookie Akamai re-issues on navigate isn't fatal
        }
      }
      log(`seeded ${planted}/${opts.seedCookies.length} high-trust cookies before navigate`);
    }
    // Strip the `HeadlessChrome` UA token (Akamai's only headless edge-tell) and
    // send matching client hints — BEFORE navigating to the protected origin.
    try {
      const { result } = await Runtime.evaluate({
        expression: 'navigator.userAgent',
        returnByValue: true,
      });
      const rawUa = String(result.value ?? '');
      if (rawUa) {
        const override = buildUaOverride(rawUa);
        await Network.setUserAgentOverride(override);
        appliedUa = override.userAgent;
        log(`UA override: ${override.userAgent}`);
      }
    } catch {
      // best-effort — a headed launch already has a clean UA
    }
    // Navigate now (post-override). Page.navigate stalls forever on an Akamai
    // origin ONLY when the UA still says HeadlessChrome; with the override it
    // loads normally. Race a timeout and proceed regardless — _abck polling below
    // tolerates a partial load.
    try {
      await Promise.race([
        Page.navigate({ url: navUrl }),
        sleep(Math.min(abckWaitMs, 25_000)).then(() => {
          throw new Error('navigate timeout');
        }),
      ]);
      await Page.loadEventFired().catch(() => {});
    } catch (err) {
      log(`navigation issue (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
    // Give the sensor JS time to start.
    await sleep(3000);
    // Drive interaction until _abck validates (or budget expires).
    const start = Date.now();
    let i = 0;
    let status = '?';
    while (Date.now() - start < abckWaitMs) {
      try {
        await Input.dispatchMouseEvent({
          type: 'mouseMoved',
          x: 80 + ((i * 137) % 1200),
          y: 120 + ((i * 89) % 640),
        });
        if (i % 3 === 0) {
          await Runtime.evaluate({
            expression: `window.scrollBy(0, ${100 + (i % 5) * 40})`,
          });
        }
      } catch {
        // non-fatal
      }
      await sleep(700);
      const abck = await getCookie(client, '_abck');
      status = abck?.split('~')[1] ?? '?';
      if (abckIsValidated(abck)) break;
      i++;
    }
    log(`_abck status after interaction: ~${status}~`);
    bootstrapped = true;
    return client;
  }

  async function getCookie(c: CdpClient, name: string): Promise<string | undefined> {
    try {
      const { cookies } = await c.Network.getCookies({ urls: [baseOrigin] });
      return cookies.find((ck: { name: string; value: string }) => ck.name === name)?.value;
    } catch (err) {
      // A failed CDP call (dead/crashed browser, closed target) is
      // indistinguishable from a genuinely-absent cookie to the caller — the
      // _abck wait loop would just spin to timeout and report `~?~` with no
      // clue why. Log it so the two cases are distinguishable.
      log(`getCookie(${name}) CDP error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  const fetchImpl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const c = await ensure();
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const fullUrl = url.startsWith('http') ? url : `${baseOrigin}${url}`;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      // Headers may be a Headers instance, array, or record.
      const h = new Headers(init.headers as Record<string, string>);
      h.forEach((v, k) => {
        // Cookie is managed by the browser session; don't override it.
        if (k.toLowerCase() !== 'cookie') headers[k] = v;
      });
    }
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;

    // Cross-origin requests (e.g. an `api.*` subdomain) can't go through the
    // trusted page's `fetch` — the browser CORS-blocks them ("Failed to fetch").
    // These endpoints are typically plain APIs NOT behind the same-origin
    // anti-bot wall (the wall is on the page-origin .act/state-changing calls),
    // so issue them with a normal fetch, carrying any cookies the browser holds
    // for that origin. The trusted in-page path below is reserved for the
    // page-origin requests that actually need the validated session.
    const requestOrigin = new URL(fullUrl).origin;
    if (requestOrigin !== baseOrigin) {
      let cookieHeader: string | undefined;
      try {
        const { cookies } = await c.Network.getCookies({ urls: [requestOrigin] });
        if (cookies.length) {
          cookieHeader = cookies
            .map((ck: { name: string; value: string }) => `${ck.name}=${ck.value}`)
            .join('; ');
        }
      } catch {
        // best-effort — many cross-origin APIs are gated by header, not cookie
      }
      const outHeaders: Record<string, string> = { ...headers };
      if (cookieHeader && !Object.keys(outHeaders).some((k) => k.toLowerCase() === 'cookie')) {
        outHeaders.cookie = cookieHeader;
      }
      log(`cross-origin ${method} ${requestOrigin} via plain fetch`);
      return globalThis.fetch(fullUrl, {
        method,
        headers: outHeaders,
        body: body ?? undefined,
        signal: init?.signal ?? undefined,
      });
    }

    // Execute the fetch INSIDE the trusted page. credentials:'include' so the
    // browser attaches the validated session cookies.
    const expr = `(async () => {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), ${reqTimeoutMs});
        const r = await fetch(${JSON.stringify(fullUrl)}, {
          method: ${JSON.stringify(method)},
          headers: ${JSON.stringify(headers)},
          ${body !== null ? `body: ${JSON.stringify(body)},` : ''}
          credentials: 'include',
          signal: ctrl.signal,
        });
        clearTimeout(to);
        const text = await r.text();
        const h = {};
        r.headers.forEach((v, k) => { h[k] = v; });
        return JSON.stringify({ ok: true, status: r.status, body: text, headers: h });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e) });
      }
    })()`;
    const { result } = await c.Runtime.evaluate({
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    const payload = JSON.parse(result.value as string) as
      | { ok: true; status: number; body: string; headers: Record<string, string> }
      | { ok: false; error: string };
    if (!payload.ok) {
      // Surface as a network-style failure so the ladder treats it like a fetch throw.
      throw new Error(`cdp-browser fetch failed: ${payload.error}`);
    }
    return new Response(payload.body, {
      status: payload.status,
      headers: new Headers(payload.headers),
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    async ensureBootstrapped() {
      const c = await ensure();
      try {
        const { cookies } = await c.Network.getCookies({ urls: [baseOrigin] });
        return cookies.map((ck: { name: string; value: string }) => ({
          name: ck.name,
          value: ck.value,
        }));
      } catch {
        return [];
      }
    },
    async mintJar(): Promise<MintedJar> {
      const c = await ensure();
      const cookies: MintedJar['cookies'] = [];
      try {
        const res = await c.Network.getCookies({ urls: [baseOrigin] });
        for (const ck of res.cookies as unknown as Array<Record<string, unknown>>) {
          cookies.push({
            name: ck.name as string,
            value: ck.value as string,
            domain: ck.domain as string,
            path: (ck.path as string) ?? '/',
            expires:
              typeof ck.expires === 'number' && ck.expires > 0 ? (ck.expires as number) : undefined,
            httpOnly: ck.httpOnly as boolean | undefined,
            secure: ck.secure as boolean | undefined,
            sameSite: ck.sameSite as string | undefined,
          });
        }
      } catch {
        // best-effort
      }
      let html = '';
      try {
        const { result } = await c.Runtime.evaluate({
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        });
        html = String(result.value ?? '');
      } catch {
        // best-effort — html_regex captures will miss
      }
      const abck = cookies.find((ck) => ck.name === '_abck')?.value;
      return {
        cookies,
        ua: appliedUa ?? '',
        html,
        bootstrapEpoch: Date.now(),
        abckFlag: abck?.split('~')[1] ?? '?',
        validated: jarCookiesValidated(cookies),
        source: 'mint',
      };
    },
    async close() {
      try {
        await client?.close();
      } catch {
        /* ignore */
      }
      try {
        await chrome?.close();
      } catch {
        /* ignore */
      }
      client = null;
      chrome = null;
      bootstrapped = false;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** CDP Network.setCookie wants 'Strict' | 'Lax' | 'None'; recordings store the
 *  attribute in varied casing (or omit it). Normalize, dropping anything
 *  unrecognized so the setCookie call doesn't reject. */
function normalizeSameSite(v: string): 'Strict' | 'Lax' | 'None' | undefined {
  const s = v.toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  if (s === 'none') return 'None';
  return undefined;
}
