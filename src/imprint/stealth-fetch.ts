/**
 * stealth-fetch — bypass bot detection without keeping a browser alive.
 *
 * Architecture (same as what paid stealth APIs sell — Bright Data Web
 * Unlocker, browser-use Cloud, ScrapingBee):
 *
 *   1. Bootstrap: launch headless Chromium briefly, navigate to a URL on
 *      the target site, let the bot-detection JS (Akamai/Cloudflare/etc)
 *      run and generate its tokens. Capture the resulting cookies + the
 *      sensor headers the JS injects via Playwright route interception.
 *      Close the browser.
 *   2. Fetch: native `fetch()` with the captured cookies + sensor
 *      headers. No TLS impersonation needed — sensor tokens override
 *      the fingerprint check entirely.
 *   3. Refresh: tokens have a TTL (minutes to hours, site-dependent).
 *      Re-bootstrap proactively after `maxTokenAgeSeconds` AND reactively
 *      when a call returns 403.
 *
 * Total cost: ~12s for bootstrap (one-time), ~1s per API call after.
 *
 * Comes from PR #1 (https://github.com/ashaychangwani/imprint/pull/1)
 * which proved the bypass against real Southwest. This file refines it
 * for integration: proactive refresh, consecutive-failure escalation,
 * and a fetch-shape adapter so it plugs into workflow-runtime as
 * `fetchImpl` with zero workflow.json changes.
 */

import { type Browser, chromium } from 'playwright';
import { createLog } from './log.ts';

export interface StealthFetchOptions {
  /** Homepage URL to load during bootstrap (triggers bot-detection JS). */
  baseUrl: string;
  /** Seconds to wait after page load for sensor initialization. Default 3. */
  sensorWaitSeconds?: number;
  /** Launch headed for debugging. Default false. */
  headed?: boolean;
  /** Custom user agent. */
  userAgent?: string;
  /** Max number of auto-re-bootstraps on 403 per fetch call. Default 1. */
  maxRetries?: number;
  /**
   * Refresh tokens proactively when older than this. Akamai's `_abck`
   * lifetime varies; 10min is a safe middle ground (long enough to
   * amortize the bootstrap, short enough to dodge most expirations).
   */
  maxTokenAgeSeconds?: number;
  /**
   * After this many CONSECUTIVE 403 responses across calls, the stealth
   * fetcher reports the site as broken and stops auto-retrying so the
   * caller (the ladder) can escalate to playbook. Avoids pathological
   * re-bootstrap loops.
   */
  maxConsecutiveFailures?: number;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

export interface TokenCache {
  cookies: Array<{ name: string; value: string }>;
  sensorHeaders: Record<string, string>;
  bootstrappedAt: number;
}

/**
 * The public surface of a stealth fetcher. Production callers use only
 * `fetchImpl` (and occasionally the introspection getters); the tests
 * use `invalidate` + the streak/age numbers to assert lifecycle.
 */
export interface StealthFetch {
  /**
   * `typeof fetch`-shaped wrapper that routes through the bootstrap +
   * sensor-token machinery. Drop into workflow-runtime as `fetchImpl`
   * with zero workflow.json changes.
   */
  readonly fetchImpl: typeof fetch;
  /** Force-invalidate cached tokens. Next fetch will re-bootstrap. */
  invalidate(): void;
  /** Token age in seconds; -1 if not bootstrapped yet. */
  readonly tokenAgeSeconds: number;
  /** Consecutive 403s observed across recent calls. Resets on success. */
  readonly failureStreak: number;
  /** Drop tokens. Kept for symmetry with future browser-pool variants. */
  close(): Promise<void>;
}

export interface BootstrapArgs {
  baseUrl: string;
  probeUrl?: string;
  userAgent: string;
  headed: boolean;
  sensorWaitSeconds: number;
}

/**
 * Test-only seam for swapping the Playwright bootstrap and the
 * sensor-headered network call. Production code never passes these —
 * defaults are real Chromium + globalThis.fetch.
 */
export interface StealthFetchInternals {
  bootstrap?: (args: BootstrapArgs) => Promise<TokenCache>;
  underlyingFetch?: (url: string, init: FetchInit, tokens: TokenCache) => Promise<FetchResult>;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Headers the operator/runtime sets explicitly. Anything in an outbound
 * request NOT in this set was injected by the bot-detection sensor JS
 * and should be captured for replay.
 */
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

/**
 * Headers that should be regenerated as fresh UUIDs on every call,
 * never reused from the captured workflow. Sites validate these as
 * "unique per request" or "session-bound" and reject replay of stale
 * values. Match is case-insensitive.
 *
 * Verified against Southwest: replaying the captured
 * `X-User-Experience-ID` produces a 400 VALIDATION__FIELD__INVALID
 * even with otherwise-valid Akamai sensor tokens. Generating a fresh
 * UUID per call clears it.
 */
const FRESH_UUID_HEADERS = new Set([
  'x-user-experience-id',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
]);

const log = createLog('stealth');

/**
 * Build a stealth fetcher. Returns an object exposing `fetchImpl` plus
 * a few introspection accessors. Lifecycle (bootstrap, retry, refresh)
 * lives in closure variables — there is no class, no `new`, no `this`.
 */
export function createStealthFetch(
  optsOrUrl: StealthFetchOptions | string,
  internals?: StealthFetchInternals,
): StealthFetch {
  const o = typeof optsOrUrl === 'string' ? { baseUrl: optsOrUrl } : optsOrUrl;
  const opts = {
    baseUrl: o.baseUrl,
    sensorWaitSeconds: o.sensorWaitSeconds ?? 3,
    headed: o.headed ?? false,
    userAgent: o.userAgent ?? DEFAULT_UA,
    maxRetries: o.maxRetries ?? 1,
    maxTokenAgeSeconds: o.maxTokenAgeSeconds ?? 600,
    maxConsecutiveFailures: o.maxConsecutiveFailures ?? 3,
  };
  const bootstrapFn = internals?.bootstrap ?? defaultBootstrap;
  const underlyingFetchFn = internals?.underlyingFetch ?? defaultUnderlyingFetch;

  let tokens: TokenCache | null = null;
  let consecutiveFailures = 0;

  const tokenAge = (): number => {
    if (!tokens) return -1;
    return Math.floor((Date.now() - tokens.bootstrappedAt) / 1000);
  };

  async function ensureTokens(probeUrl?: string): Promise<void> {
    // Proactive refresh — if tokens have aged out, mint new ones now
    // instead of paying the round-trip + 403 + re-bootstrap cost.
    if (tokens && tokenAge() >= opts.maxTokenAgeSeconds) {
      log(`tokens are ${tokenAge()}s old (>= ${opts.maxTokenAgeSeconds}s), refreshing proactively`);
      tokens = null;
    }
    if (tokens) return;
    const t0 = Date.now();
    log('bootstrapping…');
    tokens = await bootstrapFn({
      baseUrl: opts.baseUrl,
      probeUrl,
      userAgent: opts.userAgent,
      headed: opts.headed,
      sensorWaitSeconds: opts.sensorWaitSeconds,
    });
    // Successful bootstrap resets the failure counter — old failures
    // were against stale tokens that we've now refreshed.
    consecutiveFailures = 0;
    log(
      `bootstrapped in ${Date.now() - t0}ms — ${tokens.cookies.length} cookies, ${Object.keys(tokens.sensorHeaders).length} sensor headers`,
    );
  }

  /**
   * Internal fetch — auto-bootstraps on demand, re-bootstraps on 403
   * (within maxRetries), escalates after maxConsecutiveFailures. Returns
   * a raw FetchResult (status/body/headers) for the public wrapper to
   * adapt into a Response.
   */
  async function fetchWithRetry(url: string, init?: FetchInit): Promise<FetchResult> {
    const fullUrl = url.startsWith('http') ? url : `${new URL(opts.baseUrl).origin}${url}`;
    await ensureTokens(fullUrl);
    let retries = 0;
    while (true) {
      const t = tokens;
      if (!t) throw new Error('No tokens (bootstrap failed?)');
      const result = await underlyingFetchFn(
        fullUrl,
        {
          method: init?.method ?? 'GET',
          headers: {
            'User-Agent': opts.userAgent,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/json',
            Cookie: t.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
            Origin: new URL(fullUrl).origin,
            Referer: opts.baseUrl,
            ...t.sensorHeaders,
            ...(init?.headers ?? {}),
          },
          body: init?.body,
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
    // Regenerate "unique per call" headers — captured static values get
    // rejected as stale by APIs that validate freshness. Also ensure
    // they're present at all: some APIs require the header (Southwest
    // returns VALIDATION__FIELD__INVALID for a missing
    // x-user-experience-id), and the LLM may have dropped it during
    // workflow generation.
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
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }) as typeof fetch;

  return {
    fetchImpl,
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
    async close(): Promise<void> {
      tokens = null;
      consecutiveFailures = 0;
    },
  };
}

/**
 * Real Playwright bootstrap. Launches headless Chromium, navigates to
 * `baseUrl`, lets the bot-detection JS run, captures the resulting
 * cookies + sensor-injected headers via a route interceptor on a probe
 * request, closes the browser. Returns a fresh TokenCache.
 */
async function defaultBootstrap(args: BootstrapArgs): Promise<TokenCache> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: !args.headed,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: args.userAgent,
      viewport: { width: 1440, height: 900 },
      screen: { width: 2560, height: 1440 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // SPAs (Southwest, anything React-heavy) keep persistent connections
    // alive so 'networkidle' hangs forever. Use 'domcontentloaded' + an
    // explicit sensor-wait — long enough for Akamai's bot-detection JS
    // to fire and inject sensor tokens.
    await page.goto(args.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(args.sensorWaitSeconds * 1000);

    // Capture ONLY the bot-detection headers that the sensor injects.
    // We send a probe with known headers, then any header in the
    // outbound request that we didn't send is sensor-injected. This
    // avoids capturing our own dummy values.
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

    // Capture cookies for the registrable domain.
    const allCookies = await context.cookies();
    const origin = new URL(args.baseUrl);
    const rootDomain = origin.hostname.split('.').slice(-2).join('.');
    const cookies = allCookies
      .filter((c) => c.domain.includes(rootDomain))
      .map((c) => ({ name: c.name, value: c.value }));

    return { cookies, sensorHeaders, bootstrappedAt: Date.now() };
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
  });
  const body = await resp.text();
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, ok: resp.ok, body, headers };
}
