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
import { launchChromium, proxyUrl } from './chromium.ts';
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
  /** Per-request in-page timeout (ms). Default 60000. */
  requestTimeoutMs?: number;
  /** Per-CDP-command timeout (ms). Default 20000. Prevents a wedged browser
   *  or CDP socket from hanging an MCP tool call forever. */
  cdpCommandTimeoutMs?: number;
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
  /** Opt-in: write a cross-origin response's `Set-Cookie` back into the browser
   *  cookie jar (the cross-origin plain-fetch path can't do this itself). OFF by
   *  default — it changes the jar, so it must be a DELIBERATE decision grounded in
   *  the recording, not a blanket behavior. The auth compile agent sets it (via
   *  `authConfig.crossOriginCookieReinjection`) only when the recorded login
   *  establishes/carries its session through a cross-origin `Set-Cookie` that a
   *  later request depends on (e.g. www → functions → global). */
  reinjectCrossOriginCookies?: boolean;
}

type CdpClient = Awaited<ReturnType<typeof CDP>>;
type LaunchedChromium = Awaited<ReturnType<typeof launchChromium>>;
type ChromiumLauncher = (opts: Parameters<typeof launchChromium>[0]) => Promise<LaunchedChromium>;
type CdpConnector = (port: number) => Promise<CdpClient>;

let chromiumLauncherForTest: ChromiumLauncher | null = null;
let cdpConnectorForTest: CdpConnector | null = null;

export function __setCdpBrowserFetchHooksForTest(
  hooks: { launchChromium?: ChromiumLauncher; connectCdp?: CdpConnector } | null,
): void {
  chromiumLauncherForTest = hooks?.launchChromium ?? null;
  cdpConnectorForTest = hooks?.connectCdp ?? null;
}

function abckIsValidated(v: string | undefined): boolean {
  return !!v && v.split('~')[1] === '0';
}

/** The registrable domain (eTLD+1, approximated) of a host: the last two labels,
 *  or last three when the penultimate label is a known two-part public suffix
 *  (co.uk, com.au, …). Used to decide whether a cross-origin request is a SIBLING
 *  subdomain under the SAME site (e.g. `global.americanexpress.com` vs
 *  `www.americanexpress.com` → both `americanexpress.com`) versus a genuinely
 *  third-party origin (analytics/CDN). Siblings share the page's anti-bot umbrella
 *  and the recording proves they accept the credentialed cross-origin request, so
 *  they must be issued IN-PAGE (live sensor + Chrome CORS) — not via plain fetch.
 *  Site-agnostic: no host literals, derived purely from the URL structure. */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  // Common multi-part public suffixes where eTLD+1 needs three labels.
  const twoPartTld = new Set([
    'co.uk',
    'co.jp',
    'co.kr',
    'co.in',
    'co.nz',
    'co.za',
    'com.au',
    'com.br',
    'com.cn',
    'com.mx',
    'com.sg',
    'com.hk',
    'com.tr',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'net.au',
    'org.au',
  ]);
  const lastTwo = labels.slice(-2).join('.');
  if (twoPartTld.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Two origins are SIBLINGS when they share a registrable domain but differ in
 *  origin (subdomain and/or scheme). A request to a sibling origin is still under
 *  the page's site/anti-bot umbrella, so it should ride the live in-page sensor +
 *  Chrome's credentialed-CORS engine rather than escaping to plain fetch. */
function isSiblingOrigin(originA: string, originB: string): boolean {
  if (originA === originB) return false;
  try {
    const a = new URL(originA);
    const b = new URL(originB);
    const da = registrableDomain(a.hostname);
    const db = registrableDomain(b.hostname);
    return da.length > 0 && da === db;
  } catch {
    return false;
  }
}

/** Build the in-page `fetch` expression that runs INSIDE the live trusted Chrome
 *  document. credentials:'include' so the browser attaches the validated session
 *  cookies AND the request rides the live anti-bot sensor (`_abck` re-validates
 *  between calls). For a cross-origin SIBLING target (e.g. www → global) the
 *  browser automatically attaches `Origin`/`Referer` and runs the real CORS
 *  preflight — which the recording proves the server answers (ACAO names the page
 *  origin, ACA-credentials:true). The browser also auto-supplies the sibling
 *  origin's cookie jar, so we must NOT pass a manual Cookie header (it's stripped
 *  by the caller anyway). `fullUrl` may be same-origin OR an absolute sibling URL.
 *
 *  Some SPAs monkeypatch window.fetch (AmEx's app.js throws from its patched
 *  version), so we grab the native fetch from a hidden iframe whose fresh
 *  browsing context has the unpatched global but shares the page cookie jar.
 *  The iframe stays alive until the body is read, then is removed.
 *
 *  `sameOriginIframeSrc`: when set, the iframe is pointed at this SAME-ORIGIN URL
 *  (and we await its load) instead of the default `about:blank`. This MATTERS for
 *  a cross-origin (sibling) request: an `about:blank` / `srcdoc` iframe has an
 *  OPAQUE origin (`"null"`), so a credentialed cross-origin fetch from it sends
 *  `Origin: null` — which the server's credentialed ACAO (it names the page origin
 *  exactly, never `*`) rejects → "Failed to fetch". An iframe loaded from a real
 *  same-origin URL inherits the live document's true origin, so the fetch carries
 *  the correct `Origin` (verified empirically: same-origin-src iframe → real
 *  origin + native fetch + preflight 200; about:blank/srcdoc → `null`). For a
 *  same-origin request the document origin already equals the request origin, so
 *  `about:blank` (faster, no load wait) is fine and this stays unset. */
function buildInPageFetchExpr(
  fullUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  reqTimeoutMs: number,
  sameOriginIframeSrc?: string,
): string {
  const iframeSetup = sameOriginIframeSrc
    ? `
          ifr = document.createElement('iframe');
          ifr.style.display = 'none';
          const _loaded = new Promise((res) => {
            ifr.onload = () => res(true);
            setTimeout(() => res(false), 5000);
          });
          ifr.src = ${JSON.stringify(sameOriginIframeSrc)};
          document.body.appendChild(ifr);
          await _loaded;
          if (ifr.contentWindow && typeof ifr.contentWindow.fetch === 'function') {
            _f = ifr.contentWindow.fetch.bind(ifr.contentWindow);
          }`
    : `
          ifr = document.createElement('iframe');
          ifr.style.display = 'none';
          document.body.appendChild(ifr);
          if (ifr.contentWindow && typeof ifr.contentWindow.fetch === 'function') {
            _f = ifr.contentWindow.fetch.bind(ifr.contentWindow);
          }`;
  return `(async () => {
      let ifr;
      try {
        let _f = fetch;
        try {${iframeSetup}
        } catch (_) {}
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), ${reqTimeoutMs});
        const r = await _f(${JSON.stringify(fullUrl)}, {
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
        if (ifr) ifr.remove();
        return JSON.stringify({ ok: true, status: r.status, body: text, headers: h });
      } catch (e) {
        if (ifr) try { ifr.remove(); } catch (_) {}
        return JSON.stringify({ ok: false, error: String(e) });
      }
    })()`;
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
  const reqTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const cdpCommandTimeoutMs = opts.cdpCommandTimeoutMs ?? 20_000;
  const shortCdpTimeoutMs = Math.max(1, Math.min(cdpCommandTimeoutMs, 2_000));

  let chrome: LaunchedChromium | null = null;
  let client: CdpClient | null = null;
  let bootstrapped = false;
  let appliedUa: string | undefined;

  async function close(): Promise<void> {
    const c = client;
    const ch = chrome;
    client = null;
    chrome = null;
    bootstrapped = false;
    appliedUa = undefined;
    try {
      await withTimeout(Promise.resolve(c?.close()), 'CDP client close', 2_000);
    } catch {
      /* ignore */
    }
    try {
      await withTimeout(Promise.resolve(ch?.close()), 'Chromium close', 3_000);
    } catch {
      /* ignore */
    }
  }

  async function ensure(): Promise<CdpClient> {
    if (client && bootstrapped) return client;
    try {
      const headed = opts.headed ?? false;
      if (!chrome) {
        log(`launching real ${headed ? 'headed' : 'headless'} Chrome (will navigate ${navUrl})`);
        // Launch at about:blank — we MUST attach CDP and override the UA before the
        // first request to the protected origin fires, so we navigate via
        // Page.navigate AFTER the override rather than passing the URL at launch.
        // headless renders offscreen (no display); headed needs one (Xvfb on Linux).
        const launch = chromiumLauncherForTest ?? launchChromium;
        chrome = await withTimeout(
          launch({
            headless: !headed,
            extraArgs: gpuLaunchArgs(),
            ...(headed ? { display: opts.display } : {}),
          }),
          'Chromium launch',
          cdpCommandTimeoutMs,
        );
        await withTimeout(chrome.ready, 'Chromium CDP readiness', cdpCommandTimeoutMs);
      }
      if (!client) {
        const connectCdp = cdpConnectorForTest ?? ((port: number) => CDP({ port }));
        client = await withTimeout(connectCdp(chrome.port), 'CDP connect', cdpCommandTimeoutMs);
      }
      const { Runtime, Network, Input, Page } = client;
      await withTimeout(Runtime.enable(), 'CDP Runtime.enable', cdpCommandTimeoutMs);
      await withTimeout(Network.enable(), 'CDP Network.enable', cdpCommandTimeoutMs);
      await withTimeout(Page.enable(), 'CDP Page.enable', cdpCommandTimeoutMs);
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
            await withTimeout(
              Network.setCookie({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path ?? '/',
                secure: c.secure ?? false,
                httpOnly: c.httpOnly ?? false,
                ...(c.sameSite ? { sameSite: normalizeSameSite(c.sameSite) } : {}),
                ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
              }),
              `CDP Network.setCookie(${c.name})`,
              shortCdpTimeoutMs,
            );
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
        const { result } = await withTimeout(
          Runtime.evaluate({
            expression: 'navigator.userAgent',
            returnByValue: true,
          }),
          'CDP Runtime.evaluate(navigator.userAgent)',
          cdpCommandTimeoutMs,
        );
        const rawUa = String(result.value ?? '');
        if (rawUa) {
          const override = buildUaOverride(rawUa);
          await withTimeout(
            Network.setUserAgentOverride(override),
            'CDP Network.setUserAgentOverride',
            cdpCommandTimeoutMs,
          );
          appliedUa = override.userAgent;
          log(`UA override: ${override.userAgent}`);
        }
      } catch {
        // best-effort — a headed launch already has a clean UA
      }
      // Navigate now (post-override). Page.navigate stalls forever on an Akamai
      // origin ONLY when the UA still says HeadlessChrome; with the override it
      // loads normally. Bound the CDP command and proceed regardless — _abck
      // polling below tolerates a partial load.
      try {
        await withTimeout(
          Page.navigate({ url: navUrl }),
          'CDP Page.navigate',
          Math.max(1, Math.min(abckWaitMs, 25_000)),
        );
        await withTimeout(
          Page.loadEventFired(),
          'CDP Page.loadEventFired',
          Math.max(1, Math.min(abckWaitMs, 5_000)),
        ).catch(() => {});
      } catch (err) {
        log(`navigation issue (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Give the sensor JS time to start.
      await sleep(3000);
      // Drive HUMAN-LIKE interaction until _abck validates (or budget expires).
      // Akamai's bmak grades the behavioral SHAPE of trusted input, not just that
      // it exists: a robotic linear lattice + a programmatic `window.scrollBy`
      // (which is isTrusted=FALSE — a real bot tell) score low. Instead we move the
      // cursor along Bezier paths with variable velocity + sub-pixel jitter, scroll
      // via a TRUSTED CDP mouseWheel, and emit occasional key events — all through
      // CDP Input (isTrusted=true). Note: this raises the behavioral score that
      // sits ON TOP of IP reputation; it does NOT overcome a datacenter egress
      // (Akamai serves a 200 empty-shell to a datacenter ASN regardless), which is
      // what IMPRINT_PROXY (residential egress) is for.
      const start = Date.now();
      let i = 0;
      let status = '?';
      let pos = { x: rand(120, 1100), y: rand(120, 600) };
      while (Date.now() - start < abckWaitMs) {
        try {
          const target = { x: rand(60, 1200), y: rand(80, 680) };
          for (const p of bezierPoints(pos, target, Math.round(rand(8, 20)))) {
            await withTimeout(
              Input.dispatchMouseEvent({
                type: 'mouseMoved',
                x: Math.round(p.x),
                y: Math.round(p.y),
                timestamp: Date.now() / 1000,
              }),
              'CDP Input.dispatchMouseEvent(mouseMoved)',
              shortCdpTimeoutMs,
            );
            await sleep(rand(8, 28)); // variable velocity, not a fixed cadence
          }
          pos = target;
          if (i % 3 === 0) {
            // TRUSTED wheel scroll via CDP Input (replaces the isTrusted=false
            // programmatic window.scrollBy).
            await withTimeout(
              Input.dispatchMouseEvent({
                type: 'mouseWheel',
                x: Math.round(pos.x),
                y: Math.round(pos.y),
                deltaX: 0,
                deltaY: rand(80, 260),
              }),
              'CDP Input.dispatchMouseEvent(mouseWheel)',
              shortCdpTimeoutMs,
            );
          }
          if (i % 5 === 2) {
            // A keystroke broadens the behavioral feature vector beyond mouse-only.
            await withTimeout(
              Input.dispatchKeyEvent({
                type: 'keyDown',
                key: 'ArrowDown',
                code: 'ArrowDown',
                windowsVirtualKeyCode: 40,
              }),
              'CDP Input.dispatchKeyEvent(keyDown)',
              shortCdpTimeoutMs,
            );
            await sleep(rand(30, 90));
            await withTimeout(
              Input.dispatchKeyEvent({
                type: 'keyUp',
                key: 'ArrowDown',
                code: 'ArrowDown',
                windowsVirtualKeyCode: 40,
              }),
              'CDP Input.dispatchKeyEvent(keyUp)',
              shortCdpTimeoutMs,
            );
          }
        } catch {
          // non-fatal
        }
        await sleep(rand(180, 520)); // non-uniform dwell between interaction bursts
        const abck = await getCookie(client, '_abck');
        status = abck?.split('~')[1] ?? '?';
        if (abckIsValidated(abck)) break;
        i++;
      }
      log(`_abck status after interaction: ~${status}~`);
      bootstrapped = true;
      return client;
    } catch (err) {
      await close();
      throw err;
    }
  }

  async function getCookie(c: CdpClient, name: string): Promise<string | undefined> {
    try {
      const { cookies } = await withTimeout(
        c.Network.getCookies({ urls: [baseOrigin] }),
        'CDP Network.getCookies',
        shortCdpTimeoutMs,
      );
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
    const requestOrigin = new URL(fullUrl).origin;

    // Run a request IN the live trusted page via Runtime.evaluate(fetch). Returns
    // a structured payload (ok + status/body/headers, or ok:false + error string
    // — the latter is how CORS rejections surface: the page sees "Failed to fetch"
    // / "TypeError"). Shared by the same-origin path AND the cross-origin SIBLING
    // path so both ride the live anti-bot sensor + Chrome's credentialed-CORS
    // engine identically (incl. the iframe-escape for monkeypatched window.fetch).
    const runInPageFetch = async (
      sameOriginIframeSrc?: string,
    ): Promise<
      | { ok: true; status: number; body: string; headers: Record<string, string> }
      | { ok: false; error: string }
    > => {
      const expr = buildInPageFetchExpr(
        fullUrl,
        method,
        headers,
        body,
        reqTimeoutMs,
        sameOriginIframeSrc,
      );
      const { result } = await withTimeout(
        c.Runtime.evaluate({
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
        }),
        'CDP Runtime.evaluate(fetch)',
        Math.max(cdpCommandTimeoutMs, reqTimeoutMs + 5_000),
      );
      return JSON.parse(result.value as string) as
        | { ok: true; status: number; body: string; headers: Record<string, string> }
        | { ok: false; error: string };
    };

    // Issue a request to a different origin via plain globalThis.fetch (carrying
    // cookies harvested from the browser jar for that origin, through the same
    // proxy as the browser). Used for genuinely third-party origins (analytics,
    // CDNs) that are NOT under the page's anti-bot umbrella — and as the fallback
    // when an in-page sibling fetch is genuinely CORS-blocked. Optionally
    // re-injects the response Set-Cookie into the browser jar (auth opt-in).
    const crossOriginPlainFetch = async (): Promise<Response> => {
      let cookieHeader: string | undefined;
      try {
        const { cookies } = await withTimeout(
          c.Network.getCookies({ urls: [requestOrigin] }),
          'CDP Network.getCookies(cross-origin)',
          cdpCommandTimeoutMs,
        );
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
      // Route the cross-origin plain fetch through the SAME proxy as the browser
      // (Bun fetch `proxy` opt) so its egress IP matches the in-page traffic.
      const proxy = proxyUrl();
      const xResp = await globalThis.fetch(fullUrl, {
        method,
        headers: outHeaders,
        body: body ?? undefined,
        signal: init?.signal ?? undefined,
        ...(proxy ? { proxy } : {}),
      } as RequestInit);
      // Re-inject the cross-origin response's Set-Cookie back into the browser's
      // cookie jar — ONLY when the auth compile agent opted in (the recorded login
      // carries its session through a cross-origin Set-Cookie). The plain fetch
      // above carries cookies OUT (read from the browser) but its response cookies
      // never re-enter the browser, so a session cookie minted by a cross-origin
      // leg (e.g. `functions.*`/`global.*` during a multi-step login) would be
      // dropped and the next leg / 2FA completion 401s. We do NOT do this by
      // default: it mutates the jar, so it's a deliberate, recording-grounded
      // decision, not a blanket behavior for every cdp-replay tool. Best-effort.
      if (opts.reinjectCrossOriginCookies) {
        try {
          const setCookies =
            typeof xResp.headers.getSetCookie === 'function' ? xResp.headers.getSetCookie() : [];
          const cdpCookies = setCookies
            .map((sc) => parseSetCookieForCdp(sc, fullUrl))
            .filter((ck): ck is NonNullable<typeof ck> => ck !== null);
          if (cdpCookies.length) {
            await withTimeout(
              c.Network.setCookies({ cookies: cdpCookies }),
              'CDP Network.setCookies(cross-origin)',
              cdpCommandTimeoutMs,
            );
            log(`cross-origin: re-injected ${cdpCookies.length} Set-Cookie into browser jar`);
          }
        } catch {
          // best-effort — cookie re-injection is opportunistic
        }
      }
      return xResp;
    };

    // Cross-origin routing. A request to a SIBLING origin (same registrable domain
    // as the live page, e.g. www → global on `americanexpress.com`) is still under
    // the page's anti-bot umbrella: the recording shows AmEx CORS-allows the
    // credentialed cross-origin POST (ACAO names the page origin, ACA-credentials
    // true), and Akamai edge-403s the SAME request when it leaves the browser as a
    // plain fetch (no live sensor, no isTrusted, no `Origin` the edge expects). So
    // issue sibling-origin requests IN-PAGE from the live document — identical
    // mechanism to the same-origin path (credentials:'include', iframe-escape) — so
    // the browser attaches `Origin`/`Referer`, runs the real preflight, supplies the
    // validated jar, and the `_abck` sensor re-validates. Fall back to plain fetch
    // ONLY if the browser genuinely CORS-blocks it (in-page payload ok:false). A
    // genuinely third-party origin (analytics/CDN) — NOT a sibling — keeps the plain
    // fetch path: it isn't behind this site's wall and may not CORS-allow the page.
    if (requestOrigin !== baseOrigin) {
      if (isSiblingOrigin(requestOrigin, baseOrigin)) {
        log(`cross-origin SIBLING ${method} ${requestOrigin} via in-page fetch`);
        // Use a SAME-ORIGIN iframe (loaded from the page origin) for the unpatched
        // fetch — NOT about:blank, whose opaque ("null") origin would make the
        // cross-origin request send `Origin: null` and get CORS-rejected by a
        // credentialed ACAO that names the page origin exactly. A real same-origin
        // src gives the iframe the live document's true origin (empirically
        // verified). `/favicon.ico` is a universal, cheap same-origin resource; its
        // status is irrelevant — only that the iframe inherits the origin.
        const sameOriginIframeSrc = `${baseOrigin}/favicon.ico`;
        let payload:
          | { ok: true; status: number; body: string; headers: Record<string, string> }
          | { ok: false; error: string };
        try {
          payload = await runInPageFetch(sameOriginIframeSrc);
        } catch (err) {
          payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (payload.ok) {
          return new Response(payload.body, {
            status: payload.status,
            headers: new Headers(payload.headers),
          });
        }
        // The in-page sibling fetch failed — almost always a genuine CORS block
        // (the page can't read the cross-origin response). Fall back to plain
        // fetch so the request still goes out (it just won't carry the live
        // sensor; the ladder can then escalate if it 403s).
        log(`cross-origin SIBLING in-page failed (${payload.error}); falling back to plain fetch`);
        return crossOriginPlainFetch();
      }
      log(`cross-origin ${method} ${requestOrigin} via plain fetch`);
      return crossOriginPlainFetch();
    }

    // Execute the fetch INSIDE the trusted page. credentials:'include' so the
    // browser attaches the validated session cookies. Uses the shared in-page
    // mechanism (iframe-escape for monkeypatched window.fetch — e.g. AmEx's SPA).
    const payload = await runInPageFetch();
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
        const { cookies } = await withTimeout(
          c.Network.getCookies({ urls: [baseOrigin] }),
          'CDP Network.getCookies',
          cdpCommandTimeoutMs,
        );
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
        const res = await withTimeout(
          c.Network.getCookies({ urls: [baseOrigin] }),
          'CDP Network.getCookies',
          cdpCommandTimeoutMs,
        );
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
        const { result } = await withTimeout(
          c.Runtime.evaluate({
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
          }),
          'CDP Runtime.evaluate(document HTML)',
          cdpCommandTimeoutMs,
        );
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
    close,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Uniform random in [min, max). Used to humanize interaction timing/geometry —
 *  bmak flags fixed cadences and uniform step sizes as synthetic. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Cubic-Bezier cursor path from `from` to `to` with control points pulled to
 *  one side and per-point sub-pixel jitter, so the move has curvature +
 *  variable spacing like a real hand (vs a teleporting linear lattice). Pure
 *  geometry — returns the intermediate points to feed to Input.dispatchMouseEvent. */
function bezierPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
): Array<{ x: number; y: number }> {
  const c1x = from.x + (to.x - from.x) * rand(0.2, 0.4) + rand(-60, 60);
  const c1y = from.y + (to.y - from.y) * rand(0.2, 0.4) + rand(-60, 60);
  const c2x = from.x + (to.x - from.x) * rand(0.6, 0.8) + rand(-60, 60);
  const c2y = from.y + (to.y - from.y) * rand(0.6, 0.8) + rand(-60, 60);
  const pts: Array<{ x: number; y: number }> = [];
  const n = Math.max(2, steps);
  for (let s = 1; s <= n; s++) {
    const t = s / n;
    const u = 1 - t;
    const x = u * u * u * from.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * to.x;
    const y = u * u * u * from.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * to.y;
    pts.push({ x: x + rand(-1.5, 1.5), y: y + rand(-1.5, 1.5) });
  }
  return pts;
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

/** A CDP `Network.setCookies` CookieParam (the subset we populate). */
interface CdpCookieParam {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/** Parse a raw `Set-Cookie` header value into a CDP CookieParam so a cross-origin
 *  response's cookies can be written back into the browser jar via
 *  Network.setCookies (see the cross-origin branch of fetchImpl). Returns null
 *  when there's no `name=value` pair. `url` scopes the cookie when the header
 *  omits Domain/Path. Channel/site-agnostic. Exported for unit testing. */
export function parseSetCookieForCdp(setCookie: string, requestUrl: string): CdpCookieParam | null {
  const segments = setCookie.split(';');
  const first = segments.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  const ck: CdpCookieParam = { name, value, url: requestUrl };
  for (const seg of segments) {
    const i = seg.indexOf('=');
    const k = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : seg.slice(i + 1).trim();
    if (k === 'domain' && v) ck.domain = v;
    else if (k === 'path' && v) ck.path = v;
    else if (k === 'secure') ck.secure = true;
    else if (k === 'httponly') ck.httpOnly = true;
    else if (k === 'samesite' && v) {
      const s = normalizeSameSite(v);
      if (s) ck.sameSite = s;
    } else if (k === 'expires' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) ck.expires = Math.floor(t / 1000);
    } else if (k === 'max-age' && v) {
      const n = Number(v);
      if (Number.isFinite(n)) ck.expires = Math.floor(Date.now() / 1000) + n;
    }
  }
  return ck;
}
