/**
 * Bypass bot detection without keeping a browser alive.
 *
 *   1. Bootstrap: brief headless Chromium navigation to mint cookies +
 *      sensor headers the bot-detection JS (Akamai/Cloudflare/etc) injects.
 *   2. Fetch: native fetch() with those cookies + sensor headers.
 *   3. Refresh: re-bootstrap proactively after maxTokenAgeSeconds AND
 *      reactively on 403.
 *
 * ~12s bootstrap one-time, ~1s per API call after.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { createLog } from './log.ts';

export interface StealthFetchOptions {
  /** Homepage URL to load during bootstrap (triggers bot-detection JS). */
  baseUrl: string;
  /** URL to navigate during bootstrap, when it differs from baseUrl. Set this
   *  to the workflow's `bootstrap.url` so the same stealth session that mints
   *  anti-bot cookies (_abck etc.) ALSO loads the page that sets session
   *  tokens (CSRF cookies, nonces) — those tokens and the bot-cookies must
   *  come from ONE session or the site rejects the later API POST on a
   *  session mismatch. Defaults to baseUrl. */
  bootstrapUrl?: string;
  /** Seconds to wait after page load for sensor initialization. Default 3. */
  sensorWaitSeconds?: number;
  /** Launch headed for debugging. Default false. */
  headed?: boolean;
  /** Custom user agent. */
  userAgent?: string;
  /** Max number of auto-re-bootstraps on 403 per fetch call. Default 1. */
  maxRetries?: number;
  /** Proactive refresh threshold. Default 600s (10min) — Akamai's _abck
   *  lifetime varies; this amortizes the bootstrap without risking expiry. */
  maxTokenAgeSeconds?: number;
  /** Stop auto-retrying after this many consecutive 403s so the ladder
   *  can escalate to playbook. Default 3. */
  maxConsecutiveFailures?: number;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Anything `fetch()` accepts as a body. The retry loop reads this
   *  once per attempt via globalThis.fetch, so non-replayable bodies
   *  (ReadableStream consumed once, hand-rolled iterables) won't survive
   *  a 403 retry — callers that need retry-after-bot-bootstrap should
   *  pass a string, Blob, ArrayBuffer, FormData, or URLSearchParams. */
  body?: RequestInit['body'];
  /** Abort signal from the caller (e.g. executeWorkflow's per-request timeout
   *  AbortController). MUST be forwarded to the underlying fetch — without it a
   *  tarpitting anti-bot endpoint hangs far past the caller's timeout (observed
   *  ~272s on Akamai) instead of aborting promptly so the ladder can escalate. */
  signal?: AbortSignal;
}

interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

export interface TokenCache {
  cookies: Array<{ name: string; value: string }>;
  sensorHeaders: Record<string, string>;
  bootstrappedAt: number;
  /** HTML of the bootstrap navigation, so callers can satisfy a workflow's
   *  `html_regex` bootstrap captures from the same session. Optional —
   *  absent on caches minted before this field existed. */
  bootstrapHtml?: string;
  /** Lower-cased response headers of the bootstrap navigation, so callers can
   *  satisfy `response_header` bootstrap captures. Optional. */
  bootstrapResponseHeaders?: Record<string, string>;
  /** The bootstrap browser's actual `navigator.userAgent`, captured live. Reused
   *  for the post-bootstrap fetches so the wire UA matches the binary that minted
   *  the cookies (and its client hints below). Absent if capture failed or on
   *  caches minted before this field existed → caller falls back to DEFAULT_UA. */
  userAgent?: string;
  /** Lower-cased `sec-ch-ua*` client-hint headers derived from the bootstrap
   *  browser's `navigator.userAgentData`, so the post-bootstrap fetch can send
   *  client hints consistent with `userAgent`. Absent when the browser doesn't
   *  expose userAgentData (non-secure context / non-Chromium). */
  clientHints?: Record<string, string>;
}

export interface StealthFetch {
  /** typeof fetch wrapper that auto-bootstraps + adds sensor headers. */
  readonly fetchImpl: typeof fetch;
  /** Force the bootstrap navigation now (if not already done) and return the
   *  token cache — including the cookies minted during the navigation. Callers
   *  use this to read session-token cookies (CSRF etc.) set by the bootstrap
   *  page and feed them into the workflow as `${state.X}`, in the SAME session
   *  as the transport cookies. */
  ensureBootstrapped(): Promise<TokenCache>;
  /** Drop cached tokens; next fetch re-bootstraps. */
  invalidate(): void;
  /** Token age in seconds; -1 if not bootstrapped yet. */
  readonly tokenAgeSeconds: number;
  /** Consecutive 403s; resets on success. */
  readonly failureStreak: number;
  /** Future-proof teardown hook. Today: no-op (defaultBootstrap closes
   *  its Browser inside its own try/finally; nothing else to release).
   *  Reserved for an architecture where StealthFetch owns a long-lived
   *  Browser across calls — callers can wire \`await sf.close()\` into
   *  shutdown handlers now and it'll Just Work later. */
  close(): Promise<void>;
}

export interface BootstrapArgs {
  baseUrl: string;
  /** Page to navigate during bootstrap (for session-token cookies). Defaults
   *  to baseUrl when absent. */
  bootstrapUrl?: string;
  probeUrl?: string;
  /** Force a specific UA on the bootstrap browser. Omit (the default) to let
   *  Chrome use its NATIVE UA — which is always self-consistent with the client
   *  hints it emits. Only set this when a caller explicitly needs a custom UA. */
  userAgent?: string;
  headed: boolean;
  sensorWaitSeconds: number;
}

/**
 * Test-only seam for swapping the Playwright bootstrap and the
 * sensor-headered network call. Production code never passes these —
 * defaults are real Chromium + globalThis.fetch.
 */
interface StealthFetchInternals {
  bootstrap?: (args: BootstrapArgs) => Promise<TokenCache>;
  underlyingFetch?: (url: string, init: FetchInit, tokens: TokenCache) => Promise<FetchResult>;
}

/**
 * Last-resort User-Agent, used ONLY when the bootstrap browser couldn't report
 * its own UA and the caller didn't force one. The real path captures the live
 * browser's actual `navigator.userAgent` during bootstrap (see
 * `bootstrapStealthToken`) and reuses THAT for the post-bootstrap fetches, so
 * the UA on the wire always matches the binary's own client hints (sec-ch-ua).
 *
 * A hardcoded UA is dangerous precisely because it drifts: a stale major
 * version (e.g. Chrome/131) paired with the live binary's client hints
 * (Chrome/148) is a contradiction no real browser emits — a textbook anti-bot
 * tell. Keep this roughly current as a floor, but the capture is what ships.
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Standard headers the runtime sets — anything outbound NOT in this set
 *  was injected by sensor JS and is what we capture for replay. */
const STANDARD_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'connection',
  'content-length',
  'content-type',
  'host',
  'origin',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
  'cookie',
]);

/** Regenerate as fresh UUIDs per call. Sites validate these as
 *  unique-per-request and reject replay (verified vs. Southwest's
 *  X-User-Experience-ID → 400 VALIDATION__FIELD__INVALID). */
const FRESH_UUID_HEADERS = new Set([
  'x-user-experience-id',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
]);

const log = createLog('stealth');

export function createStealthFetch(
  optsOrUrl: StealthFetchOptions | string,
  internals?: StealthFetchInternals,
): StealthFetch {
  const o = typeof optsOrUrl === 'string' ? { baseUrl: optsOrUrl } : optsOrUrl;
  const opts = {
    baseUrl: o.baseUrl,
    bootstrapUrl: o.bootstrapUrl ?? o.baseUrl,
    sensorWaitSeconds: o.sensorWaitSeconds ?? 3,
    headed: o.headed ?? false,
    // Undefined unless the caller forces a UA. Letting it stay undefined makes
    // the bootstrap browser use its native UA (self-consistent with its client
    // hints); we then capture that real UA and reuse it for the fetches.
    userAgent: o.userAgent,
    maxRetries: o.maxRetries ?? 1,
    maxTokenAgeSeconds: o.maxTokenAgeSeconds ?? 600,
    maxConsecutiveFailures: o.maxConsecutiveFailures ?? 3,
  };
  const bootstrapFn = internals?.bootstrap ?? bootstrapStealthToken;
  const underlyingFetchFn = internals?.underlyingFetch ?? defaultUnderlyingFetch;

  let tokens: TokenCache | null = null;
  let consecutiveFailures = 0;

  const tokenAge = (): number => {
    if (!tokens) return -1;
    return Math.floor((Date.now() - tokens.bootstrappedAt) / 1000);
  };

  async function ensureTokens(probeUrl?: string): Promise<void> {
    if (tokens && tokenAge() >= opts.maxTokenAgeSeconds) {
      log(`tokens ${tokenAge()}s old (>= ${opts.maxTokenAgeSeconds}s), refreshing proactively`);
      tokens = null;
    }
    if (tokens) return;
    const t0 = Date.now();
    log('bootstrapping…');
    tokens = await bootstrapFn({
      baseUrl: opts.baseUrl,
      bootstrapUrl: opts.bootstrapUrl,
      probeUrl,
      userAgent: opts.userAgent,
      headed: opts.headed,
      sensorWaitSeconds: opts.sensorWaitSeconds,
    });
    consecutiveFailures = 0; // fresh tokens → past failures don't count
    log(
      `bootstrapped in ${Date.now() - t0}ms — ${tokens.cookies.length} cookies, ${Object.keys(tokens.sensorHeaders).length} sensor headers`,
    );
  }

  async function fetchWithRetry(url: string, init?: FetchInit): Promise<FetchResult> {
    const fullUrl = url.startsWith('http') ? url : `${new URL(opts.baseUrl).origin}${url}`;
    await ensureTokens(fullUrl);
    let retries = 0;
    while (true) {
      const t = tokens;
      if (!t) throw new Error('No tokens (bootstrap failed?)');
      const { headers: initHeaders, cookieHeader } = splitCookieHeader(init?.headers ?? {});
      // Defaults that yield to the caller's initHeaders (and the workflow's
      // recorded headers that flow through them). Keys are lowercase to
      // match what the public `fetchImpl` wrapper normalizes everything to
      // (via `new Headers().forEach`) — a mixed-case merge would silently
      // duplicate both `Accept` and `accept` in the final headers and the
      // caller's override would never actually win.
      //
      // Content-Type intentionally depends on whether the request actually
      // has a body — sending Content-Type: application/json on a body-less
      // GET is anti-bot suspicious (real browsers don't do it) and was
      // contributing to Akamai tarpits on HTML bootstrap GETs from this rung.
      const hasBody = init?.body !== undefined && init?.body !== null;
      // UA precedence: an explicit caller override (also used for the bootstrap
      // context) → the UA the bootstrap browser actually reported → the stale
      // fallback. The captured value keeps the fetch UA matching the binary that
      // minted the cookies.
      const ua = opts.userAgent ?? t.userAgent ?? DEFAULT_UA;
      const defaultHeaders: Record<string, string> = {
        'user-agent': ua,
        accept: 'application/json, text/javascript, */*; q=0.01',
        cookie: mergeCookieHeader(
          t.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
          cookieHeader,
        ),
        origin: new URL(fullUrl).origin,
        referer: opts.baseUrl,
        ...t.sensorHeaders,
      };
      // Send client hints consistent with the UA. Only when we're NOT forcing a
      // custom UA: the captured hints reflect the browser's native UA, so pairing
      // them with an override would reintroduce the UA/hints contradiction we fix.
      if (!opts.userAgent && t.clientHints) {
        for (const [k, v] of Object.entries(t.clientHints)) defaultHeaders[k] = v;
      }
      if (hasBody) defaultHeaders['content-type'] = 'application/json';
      const result = await underlyingFetchFn(
        fullUrl,
        {
          method: init?.method ?? 'GET',
          headers: { ...defaultHeaders, ...initHeaders },
          body: init?.body,
          signal: init?.signal,
        },
        t,
      );

      if (result.status === 403) {
        consecutiveFailures++;
        if (consecutiveFailures >= opts.maxConsecutiveFailures) {
          log(
            `${consecutiveFailures} consecutive 403s — giving up on this site (caller should escalate)`,
          );
          return result;
        }
        if (retries < opts.maxRetries) {
          log(`got 403 — re-bootstrapping (attempt ${retries + 1}/${opts.maxRetries})`);
          tokens = null;
          await ensureTokens(fullUrl);
          retries++;
          continue;
        }
        return result;
      }

      // Any non-403 (success or different error) resets the streak.
      consecutiveFailures = 0;
      return result;
    }
  }

  const fetchImpl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    // Regenerate per-call UUIDs (captured statics get rejected as stale).
    // Always inject x-user-experience-id — Southwest requires it even
    // when the recorded workflow omits it.
    const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    for (const k of Object.keys(headers)) {
      if (FRESH_UUID_HEADERS.has(k.toLowerCase())) {
        headers[k] = crypto.randomUUID();
      }
    }
    if (!present.has('x-user-experience-id')) {
      headers['X-User-Experience-ID'] = crypto.randomUUID();
    }
    const result = await fetchWithRetry(url, {
      method: typeof init?.method === 'string' ? init.method : 'GET',
      headers,
      // Pass BodyInit through unchanged; globalThis.fetch handles every
      // accepted shape (string, Blob, ArrayBuffer, FormData, URLSearchParams,
      // ReadableStream). Previously we dropped any non-string body silently.
      body: init?.body ?? undefined,
      // Forward the caller's abort signal (per-request timeout) — without it a
      // tarpitting endpoint hangs far past the timeout instead of escalating.
      signal: init?.signal ?? undefined,
    });
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    async ensureBootstrapped(): Promise<TokenCache> {
      await ensureTokens();
      if (!tokens) throw new Error('stealth bootstrap produced no tokens');
      return tokens;
    },
    invalidate(): void {
      tokens = null;
      consecutiveFailures = 0;
    },
    get tokenAgeSeconds(): number {
      return tokenAge();
    },
    get failureStreak(): number {
      return consecutiveFailures;
    },
    // Intentional no-op — see the docstring on StealthFetch.close.
    // Don't reset tokens/failures here: callers that hit close() are
    // shutting down, not invalidating, and the difference matters if
    // the future architecture grows real cleanup work.
    async close(): Promise<void> {},
  };
}

function splitCookieHeader(headers: Record<string, string>): {
  headers: Record<string, string>;
  cookieHeader: string | undefined;
} {
  const next: Record<string, string> = {};
  let cookieHeader: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'cookie') {
      cookieHeader = value;
    } else {
      next[key] = value;
    }
  }
  return { headers: next, cookieHeader };
}

function mergeCookieHeader(browserCookie: string, runtimeCookie: string | undefined): string {
  const merged = new Map<string, string>();
  for (const header of [browserCookie, runtimeCookie ?? '']) {
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      merged.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Real Playwright bootstrap. Launches headless Chromium, navigates to
 * `baseUrl`, lets the bot-detection JS run, captures the resulting
 * cookies + sensor-injected headers via a route interceptor on a probe
 * request, closes the browser. Returns a fresh TokenCache.
 *
 * Exported so the compile-time token cache (stealth-token-cache.ts) can mint a
 * token to persist + share across `bun test` processes without re-implementing
 * the Playwright bootstrap.
 */
/** Akamai _abck cookie validation marker. Format: `<token>~<status>~…`;
 *  status `0` = sensor-validated (requests pass), `-1` = not yet validated
 *  (state-changing POSTs get tarpitted). */
function abckIsValidated(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  return cookieValue.split('~')[1] === '0';
}

/** Drive human-like interaction (mouse moves + scroll) and poll until the
 *  Akamai _abck cookie validates (`~0~`), or until `maxSeconds` elapse. Returns
 *  true if validation was observed. No-op-safe on pages without _abck (returns
 *  false after the window; caller proceeds regardless). */
async function driveSensorValidation(
  page: Page,
  context: BrowserContext,
  maxSeconds: number,
): Promise<boolean> {
  const deadline = maxSeconds * 1000;
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < deadline) {
    // Jittered mouse path + occasional scroll — the sensor wants movement, not
    // a single teleport. Coordinates stay within the viewport.
    try {
      await page.mouse.move(80 + ((i * 137) % 1200), 120 + ((i * 89) % 640), { steps: 4 });
      if (i % 3 === 0) {
        await page.evaluate(
          (y: number) => {
            (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(0, y);
          },
          100 + (i % 5) * 40,
        );
      }
    } catch {
      // page may navigate/close mid-interaction — non-fatal
    }
    await page.waitForTimeout(800);
    let abck: string | undefined;
    try {
      abck = (await context.cookies()).find((c) => c.name === '_abck')?.value;
    } catch {
      // best-effort
    }
    // Absent _abck → site doesn't use Akamai's scheme; nothing to wait for.
    if (abck === undefined && i >= 2) return false;
    if (abckIsValidated(abck)) return true;
    i++;
  }
  return false;
}

export async function bootstrapStealthToken(args: BootstrapArgs): Promise<TokenCache> {
  // Use the same stealth-patched chromium + full Chrome binary that
  // runFetchBootstrap and runPlaybook use. The original implementation
  // imported vanilla `playwright` with no executablePath, which defaults
  // to chrome-headless-shell — a separate stripped-down binary that
  // Akamai / Cloudflare / PerimeterX detect at the binary / TLS layer
  // and RST the HTTP/2 stream immediately (verified empirically against
  // www.costcotravel.com). Using the same binary as `imprint record`
  // (Playwright's bundled "Google Chrome for Testing") makes Akamai
  // accept the navigation and mint clean bot-cookies, just like the
  // recording session did.
  const { getStealthChromium, getStealthExecutablePath, isStealthPluginAvailable } = await import(
    './stealth-chromium.ts'
  );
  const chromium = await getStealthChromium();
  const stealthActive = await isStealthPluginAvailable();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: !args.headed,
      executablePath: getStealthExecutablePath(),
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    // Only override the UA when the caller explicitly asked for one. Otherwise
    // let Chrome use its native UA: a forced UA does NOT change the client hints
    // (sec-ch-ua) the browser emits, so pinning a stale UA string while the
    // binary advertises its real version is a contradiction anti-bot services
    // flag. Native UA + native hints are always self-consistent.
    const context = await browser.newContext({
      ...(args.userAgent ? { userAgent: args.userAgent } : {}),
      viewport: { width: 1440, height: 900 },
      screen: { width: 2560, height: 1440 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });

    const page = await context.newPage();
    // Patch navigator.webdriver ONLY on the vanilla-Playwright fallback. When the
    // stealth plugin is active it already removes the property natively (a real
    // Chrome lacks it); stacking our Object.defineProperty on top leaves a
    // non-native descriptor that is itself a tell. See isStealthPluginAvailable.
    if (!stealthActive) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
    }

    // Navigate the bootstrap page (the workflow's bootstrap.url when set,
    // else baseUrl). Loading the actual session-minting page here means the
    // CSRF/nonce cookies it sets land in the SAME context as the anti-bot
    // cookies — a later API POST that needs both will not be rejected for a
    // session mismatch.
    const navUrl = args.bootstrapUrl ?? args.baseUrl;
    // 'domcontentloaded' (not 'networkidle') because SPAs keep connections
    // alive forever; explicit sensor-wait lets bot-detection JS fire.
    const navResponse = await page.goto(navUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Drive human-like interaction (mouse moves + scroll) while polling the
    // Akamai _abck cookie until it VALIDATES. Akamai's sensor JS only flips
    // _abck from "unvalidated" (`token~-1~…`) to "validated" (`token~0~…`)
    // after it observes human behavioral signals; a bare navigate-and-idle
    // bootstrap captures the `~-1~` cookie, and every later API POST that
    // relies on it is silently tarpitted (RST after ~30s). Verified against
    // www.costcotravel.com: a recorded human session shows _abck `~-1~`→`~0~`
    // after the sensor POSTs, and synthetic mouse/scroll reproduces the flip
    // in ~5s. This is the behavioral piece a real browser has and a headless
    // replay lacks. General — any Akamai-protected site uses the same _abck
    // state machine. Falls through after the wait window regardless, so a site
    // that doesn't use _abck (the cookie is absent) is unaffected.
    const abckValidated = await driveSensorValidation(
      page,
      context,
      Math.max(args.sensorWaitSeconds, 20),
    );
    if (!abckValidated) {
      log('_abck did not validate within the interaction window (continuing anyway)');
    }

    // Snapshot the bootstrap page HTML + response headers so callers can
    // satisfy the workflow's html_regex / response_header bootstrap captures
    // from this same stealth session (the cookies, HTML, and headers are all
    // one consistent session — required for tokens the later API POST checks).
    let bootstrapHtml: string | undefined;
    try {
      bootstrapHtml = await page.content();
    } catch {
      // best-effort
    }
    const bootstrapResponseHeaders: Record<string, string> = {};
    if (navResponse) {
      try {
        const raw = await navResponse.allHeaders();
        for (const [k, v] of Object.entries(raw)) bootstrapResponseHeaders[k.toLowerCase()] = v;
      } catch {
        // best-effort
      }
    }

    // Capture the live browser's actual UA + client hints so the post-bootstrap
    // fetches present the SAME identity that minted the cookies. Reading them
    // from the page (rather than hardcoding) guarantees UA ↔ sec-ch-ua agree and
    // never drift as the bundled Chrome updates.
    // Hoisted out of the page.evaluate callback: TS types are erased before
    // Playwright serializes the function, so the callback can reference them
    // without breaking serialization — and keeping them flat avoids formatter
    // churn on a deeply nested inline type.
    type HighEntropy = {
      platform?: string;
      fullVersionList?: Array<{ brand: string; version: string }>;
    };
    type UserAgentData = {
      brands?: Array<{ brand: string; version: string }>;
      mobile?: boolean;
      getHighEntropyValues?: (hints: string[]) => Promise<HighEntropy>;
    };
    let capturedUserAgent: string | undefined;
    let clientHints: Record<string, string> | undefined;
    try {
      const captured = (await page.evaluate(async () => {
        const ua = navigator.userAgent;
        const d = (navigator as unknown as { userAgentData?: UserAgentData }).userAgentData;
        let hints: Record<string, string> | null = null;
        if (d && typeof d.getHighEntropyValues === 'function') {
          try {
            const he = await d.getHighEntropyValues(['fullVersionList', 'platform']);
            const fmt = (list?: Array<{ brand: string; version: string }>) =>
              (list ?? []).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
            hints = {
              'sec-ch-ua': fmt(d.brands),
              'sec-ch-ua-mobile': d.mobile ? '?1' : '?0',
              'sec-ch-ua-platform': `"${he.platform ?? ''}"`,
            };
            const fv = fmt(he.fullVersionList);
            if (fv) hints['sec-ch-ua-full-version-list'] = fv;
          } catch {
            hints = null;
          }
        }
        return { ua, hints };
      })) as { ua: string; hints: Record<string, string> | null };
      capturedUserAgent = captured.ua || undefined;
      clientHints = captured.hints ?? undefined;
    } catch {
      // best-effort — fall back to DEFAULT_UA downstream
    }

    // Probe with known headers; any header we DIDN'T send was injected
    // by the sensor — that's what we capture.
    const probeHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': 'x',
      'X-App-ID': 'x',
      'X-Channel-ID': 'x',
      'X-User-Experience-ID': 'x',
    };
    const probeSentKeys = new Set([
      ...Array.from(STANDARD_HEADERS),
      ...Object.keys(probeHeaders).map((k) => k.toLowerCase()),
    ]);

    const sensorHeaders: Record<string, string> = {};
    await page.route('**/*', async (route) => {
      for (const [k, v] of Object.entries(route.request().headers())) {
        if (!probeSentKeys.has(k.toLowerCase())) {
          sensorHeaders[k] = v;
        }
      }
      await route.abort();
    });

    const probe = args.probeUrl ?? `${new URL(args.baseUrl).origin}/api/__stealth_probe__`;
    await page.evaluate(
      async (probeArgs: { url: string; headers: Record<string, string> }) => {
        try {
          await fetch(probeArgs.url, {
            method: 'POST',
            headers: probeArgs.headers,
            body: '{}',
          });
        } catch {
          // expected: route aborts the request after capturing headers
        }
      },
      { url: probe, headers: probeHeaders },
    );

    await page.waitForTimeout(300);

    // Capture cookies scoped to the recording's registrable domain
    // (eTLD+1). Naive `.split('.').slice(-2)` was wrong for multi-part
    // suffixes like .co.uk — it would match any cookie whose domain
    // contained "co.uk".
    const allCookies = await context.cookies();
    // Scope to the navigated page's registrable domain — that's where the
    // session-token cookies live (baseUrl may be an API subdomain that shares
    // the same eTLD+1, so this still captures cross-subdomain cookies).
    const origin = new URL(navUrl);
    const root = registrableDomain(origin.hostname);
    const cookies = allCookies
      .filter((c) => {
        const cookieHost = c.domain.replace(/^\./, '');
        return isSameRegistrableDomain(cookieHost, root);
      })
      .map((c) => ({ name: c.name, value: c.value }));

    return {
      cookies,
      sensorHeaders,
      bootstrappedAt: Date.now(),
      bootstrapHtml,
      bootstrapResponseHeaders,
      userAgent: capturedUserAgent,
      clientHints,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function defaultUnderlyingFetch(
  url: string,
  init: FetchInit,
  _tokens: TokenCache,
): Promise<FetchResult> {
  const resp = await globalThis.fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  const body = await resp.text();
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, ok: resp.ok, body, headers };
}
