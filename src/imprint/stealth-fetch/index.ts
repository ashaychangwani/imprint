/**
 * stealth-fetch — bypass bot detection without keeping a browser alive.
 *
 * Architecture (same as what paid stealth APIs sell):
 *   1. Bootstrap: launch headless Chromium briefly, navigate to the site,
 *      let the bot-detection JS (Akamai/Cloudflare/DataDome) run and
 *      generate its tokens. Capture the resulting cookies + request
 *      headers via route interception. Close the browser immediately.
 *   2. Fetch: use native `fetch` with the captured cookies + headers.
 *      No TLS impersonation needed — the sensor tokens override the
 *      fingerprint check entirely.
 *   3. Re-bootstrap: when a call returns 403 (tokens expired), repeat
 *      step 1 automatically.
 *
 * Total cost: ~12s for bootstrap (one-time), ~1s per API call after.
 * Tokens are reusable across multiple calls and survive for minutes to
 * hours depending on the site's configuration.
 *
 * No external deps beyond Playwright (already an Imprint dependency).
 * No curl-impersonate, no paid proxy service, no persistent browser.
 *
 * Usage:
 *   const sf = new StealthFetch('https://www.southwest.com/air/booking/');
 *   const resp = await sf.fetch('/api/.../shopping', { method: 'POST', body, headers });
 *   // resp is a standard { status, ok, body, headers }
 *   await sf.close(); // cleanup (only needed if you called init() manually)
 */

import { type Browser, type BrowserContext, chromium } from 'playwright';

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

const STANDARD_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'connection',
  'content-length', 'content-type', 'host', 'origin', 'referer',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'user-agent', 'cookie',
]);

const log = (msg: string): void => {
  process.stderr.write(`[stealth-fetch] ${msg}\n`);
};

export class StealthFetch {
  private opts: Required<StealthFetchOptions>;
  private tokens: TokenCache | null = null;

  constructor(opts: StealthFetchOptions | string) {
    const o = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.opts = {
      baseUrl: o.baseUrl,
      sensorWaitSeconds: o.sensorWaitSeconds ?? 3,
      headed: o.headed ?? false,
      userAgent: o.userAgent ?? DEFAULT_UA,
      maxRetries: o.maxRetries ?? 1,
    };
  }

  /**
   * Bootstrap: launch browser, navigate, capture tokens, close browser.
   * Called automatically on first fetch(). The probeUrl should be the
   * actual API endpoint — Akamai's interceptor only injects headers for
   * requests to paths it recognizes.
   */
  async bootstrap(probeUrl?: string): Promise<void> {
    const t0 = Date.now();
    log('bootstrapping...');

    const browser = await chromium.launch({
      headless: !this.opts.headed,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    try {
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

      await page.goto(this.opts.baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(this.opts.sensorWaitSeconds * 1000);

      // Capture ONLY the bot-detection headers that Akamai's interceptor
      // ADDS to the request. We send a probe with known headers, then any
      // header in the outbound request that we didn't send is injected by
      // the sensor script. This avoids capturing our own dummy values.
      const probeHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-API-Key': 'x',
        'X-App-ID': 'x',
        'X-Channel-ID': 'x',
        'X-User-Experience-ID': 'x',
      };
      const probeSentKeys = new Set([
        ...Array.from(STANDARD_HEADERS),
        ...Object.keys(probeHeaders).map(k => k.toLowerCase()),
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
      await page.evaluate(async (args: { url: string; headers: Record<string, string> }) => {
        try {
          await fetch(args.url, {
            method: 'POST',
            headers: args.headers,
            body: '{}',
          });
        } catch { /* expected: route aborts it */ }
      }, { url: probe, headers: probeHeaders });

      await page.waitForTimeout(300);

      // Capture cookies
      const allCookies = await context.cookies();
      const origin = new URL(this.opts.baseUrl);
      const rootDomain = origin.hostname.split('.').slice(-2).join('.');
      const cookies = allCookies
        .filter(c => c.domain.includes(rootDomain))
        .map(c => ({ name: c.name, value: c.value }));

      this.tokens = {
        cookies,
        sensorHeaders,
        bootstrappedAt: Date.now(),
      };

      log(`bootstrapped in ${Date.now() - t0}ms — ${cookies.length} cookies, ${Object.keys(sensorHeaders).length} sensor headers`);
    } finally {
      await browser.close();
    }
  }

  /**
   * Make a fetch call using the cached sensor tokens. If tokens are
   * missing (first call) or expired (403 response), auto-bootstraps.
   */
  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const fullUrl = url.startsWith('http')
      ? url
      : `${new URL(this.opts.baseUrl).origin}${url}`;

    if (!this.tokens) {
      await this.bootstrap(fullUrl);
    }

    let retries = 0;
    while (true) {
      const result = await this.doFetch(fullUrl, init);

      if (result.status === 403 && retries < this.opts.maxRetries) {
        log(`got 403 — re-bootstrapping (attempt ${retries + 1}/${this.opts.maxRetries})`);
        await this.bootstrap(fullUrl);
        retries++;
        continue;
      }

      return result;
    }
  }

  private async doFetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const tokens = this.tokens;
    if (!tokens) throw new Error('No tokens (bootstrap failed?)');

    const cookieStr = tokens.cookies.map(c => `${c.name}=${c.value}`).join('; ');

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
    resp.headers.forEach((v, k) => { headers[k] = v; });

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
  }

  /** No-op in v2 (no persistent browser). Here for API compat with v1. */
  async close(): Promise<void> {
    this.tokens = null;
  }
}
