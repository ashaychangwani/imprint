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
 * Dep cost: only Playwright (already an Imprint dependency).
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
   * After this many CONSECUTIVE 403 responses across calls, the
   * StealthFetch reports the site as broken and stops auto-retrying so
   * the caller (the ladder) can escalate to playbook. Avoids
   * pathological re-bootstrap loops.
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

interface TokenCache {
  cookies: Array<{ name: string; value: string }>;
  sensorHeaders: Record<string, string>;
  bootstrappedAt: number;
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

const log = createLog('stealth');

export class StealthFetch {
  private opts: Required<StealthFetchOptions>;
  private tokens: TokenCache | null = null;
  private consecutiveFailures = 0;

  constructor(opts: StealthFetchOptions | string) {
    const o = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.opts = {
      baseUrl: o.baseUrl,
      sensorWaitSeconds: o.sensorWaitSeconds ?? 3,
      headed: o.headed ?? false,
      userAgent: o.userAgent ?? DEFAULT_UA,
      maxRetries: o.maxRetries ?? 1,
      maxTokenAgeSeconds: o.maxTokenAgeSeconds ?? 600,
      maxConsecutiveFailures: o.maxConsecutiveFailures ?? 3,
    };
  }

  /**
   * Bootstrap: launch browser, navigate, capture tokens, close browser.
   * Called automatically on first fetch() and on TTL refresh / 403.
   * `probeUrl` should be the actual API endpoint — Akamai's interceptor
   * only injects sensor headers for requests to paths it recognizes.
   */
  async bootstrap(probeUrl?: string): Promise<void> {
    const t0 = Date.now();
    log('bootstrapping…');

    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: !this.opts.headed,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });

      const context = await browser.newContext({
        userAgent: this.opts.userAgent,
        viewport: { width: 1440, height: 900 },
        screen: { width: 2560, height: 1440 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // SPAs (Southwest, anything React-heavy) keep persistent
      // connections alive so 'networkidle' hangs forever. Use
      // 'domcontentloaded' + an explicit sensor-wait — long enough for
      // Akamai's bot-detection JS to fire and inject sensor tokens.
      await page.goto(this.opts.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(this.opts.sensorWaitSeconds * 1000);

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

      const probe = probeUrl ?? `${new URL(this.opts.baseUrl).origin}/api/__stealth_probe__`;
      await page.evaluate(
        async (args: { url: string; headers: Record<string, string> }) => {
          try {
            await fetch(args.url, {
              method: 'POST',
              headers: args.headers,
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
      const origin = new URL(this.opts.baseUrl);
      const rootDomain = origin.hostname.split('.').slice(-2).join('.');
      const cookies = allCookies
        .filter((c) => c.domain.includes(rootDomain))
        .map((c) => ({ name: c.name, value: c.value }));

      this.tokens = {
        cookies,
        sensorHeaders,
        bootstrappedAt: Date.now(),
      };
      // Successful bootstrap resets the failure counter — old failures
      // were against stale tokens that we've now refreshed.
      this.consecutiveFailures = 0;

      log(
        `bootstrapped in ${Date.now() - t0}ms — ${cookies.length} cookies, ${Object.keys(sensorHeaders).length} sensor headers`,
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /**
   * Make a fetch call using cached sensor tokens. Auto-bootstraps when:
   *   - no tokens yet (first call)
   *   - tokens are older than maxTokenAgeSeconds (proactive refresh)
   *   - the call returned 403 (reactive refresh, up to maxRetries)
   *
   * After maxConsecutiveFailures consecutive 403s ACROSS calls, returns
   * the 403 result without further retries — caller (the ladder) should
   * escalate to a different backend.
   */
  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const fullUrl = url.startsWith('http') ? url : `${new URL(this.opts.baseUrl).origin}${url}`;

    // Proactive refresh — if tokens have aged out, mint new ones now
    // instead of paying the round-trip + 403 + re-bootstrap cost.
    if (this.tokens && this.tokenAgeSeconds >= this.opts.maxTokenAgeSeconds) {
      log(
        `tokens are ${this.tokenAgeSeconds}s old (>= ${this.opts.maxTokenAgeSeconds}s), refreshing proactively`,
      );
      this.tokens = null;
    }

    if (!this.tokens) {
      await this.bootstrap(fullUrl);
    }

    let retries = 0;
    while (true) {
      const result = await this.doFetch(fullUrl, init);

      if (result.status === 403) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
          log(
            `${this.consecutiveFailures} consecutive 403s — giving up on this site (caller should escalate)`,
          );
          return result;
        }
        if (retries < this.opts.maxRetries) {
          log(`got 403 — re-bootstrapping (attempt ${retries + 1}/${this.opts.maxRetries})`);
          await this.bootstrap(fullUrl);
          retries++;
          continue;
        }
        return result;
      }

      // Any non-403 (success or different error) resets the streak.
      this.consecutiveFailures = 0;
      return result;
    }
  }

  private async doFetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const tokens = this.tokens;
    if (!tokens) throw new Error('No tokens (bootstrap failed?)');

    const cookieStr = tokens.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const resp = await globalThis.fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        'User-Agent': this.opts.userAgent,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        Origin: new URL(url).origin,
        Referer: this.opts.baseUrl,
        ...tokens.sensorHeaders,
        ...(init?.headers ?? {}),
      },
      body: init?.body,
    });

    const body = await resp.text();
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });

    return { status: resp.status, ok: resp.ok, body, headers };
  }

  /** How old the current tokens are, in seconds. -1 if not bootstrapped. */
  get tokenAgeSeconds(): number {
    if (!this.tokens) return -1;
    return Math.floor((Date.now() - this.tokens.bootstrappedAt) / 1000);
  }

  /** Force-invalidate cached tokens. Next fetch() will re-bootstrap. */
  invalidate(): void {
    this.tokens = null;
    this.consecutiveFailures = 0;
  }

  /**
   * Number of consecutive 403s observed across recent fetch() calls.
   * The ladder runner can poll this to decide whether to escalate.
   */
  get failureStreak(): number {
    return this.consecutiveFailures;
  }

  /** No-op kept for API compatibility with PR's v1. */
  async close(): Promise<void> {
    this.tokens = null;
    this.consecutiveFailures = 0;
  }
}

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

/**
 * Wrap a StealthFetch as a `typeof fetch`-compatible function suitable
 * for injecting into workflow-runtime as `fetchImpl`. The captured
 * workflow.json runs through stealth-fetch with zero workflow.json
 * changes — the runtime's substitution + chain logic + error
 * classification all stay the same.
 *
 * Side effect: known "unique per call" headers (X-User-Experience-ID
 * etc) get regenerated as fresh UUIDs. The captured value from
 * recording is treated as a stale identifier the API will reject.
 */
export function createStealthFetchImpl(sf: StealthFetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
    // Inject X-User-Experience-ID if missing — Southwest requires it
    // even when the captured workflow doesn't include it. The other
    // FRESH_UUID_HEADERS are less universal so we only auto-inject
    // this one; future demos can opt other headers in.
    if (!present.has('x-user-experience-id')) {
      headers['X-User-Experience-ID'] = crypto.randomUUID();
    }
    const result = await sf.fetch(url, {
      method: typeof init?.method === 'string' ? init.method : 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }) as typeof fetch;
}
