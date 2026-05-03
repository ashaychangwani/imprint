/**
 * stealth-fetch — bypasses bot detection by making API calls from within
 * a headless browser's page context, where Akamai/Cloudflare/DataDome
 * sensor scripts run naturally and generate valid tokens.
 *
 * Under the hood:
 *   1. Launches headless Chromium (via Playwright, already an Imprint dep)
 *   2. Navigates to the target site's homepage to trigger sensor JS
 *   3. Waits for the sensor to initialize (sets cookies + XHR interceptor)
 *   4. Executes `fetch()` from WITHIN the page context (page.evaluate)
 *   5. Returns the response as a standard ToolResult
 *
 * The browser stays alive for the lifetime of the StealthClient instance
 * so subsequent calls reuse the validated session (~200ms per call after
 * the first ~10s initialization).
 *
 * Usage:
 *   const client = new StealthClient('https://www.southwest.com');
 *   await client.init();
 *   const result = await client.fetch('/api/.../shopping', { method: 'POST', body, headers });
 *   await client.close();
 */

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

export interface StealthClientOptions {
  /** The site's base URL — homepage will be loaded to trigger sensor JS. */
  baseUrl: string;
  /** Seconds to wait after page load for sensor initialization. Default 3. */
  sensorWaitSeconds?: number;
  /** Launch in headed mode for debugging. Default false (headless). */
  headed?: boolean;
  /** Custom user agent. Defaults to Chrome 131. */
  userAgent?: string;
}

export interface StealthFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface StealthFetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class StealthClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private opts: Required<StealthClientOptions>;
  private initialized = false;

  constructor(opts: StealthClientOptions | string) {
    const o = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.opts = {
      baseUrl: o.baseUrl.replace(/\/$/, ''),
      sensorWaitSeconds: o.sensorWaitSeconds ?? 3,
      headed: o.headed ?? false,
      userAgent: o.userAgent ?? DEFAULT_UA,
    };
  }

  /**
   * Launch the browser and navigate to the homepage to bootstrap
   * the bot-detection sensor. Call once; subsequent fetch() calls
   * reuse the warm session.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    this.context = await this.browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: { width: 1440, height: 900 },
      screen: { width: 2560, height: 1440 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });

    this.page = await this.context.newPage();

    // Remove webdriver indicator
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Navigate to homepage — triggers Akamai's sensor script
    await this.page.goto(this.opts.baseUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for sensor initialization
    await this.page.waitForTimeout(this.opts.sensorWaitSeconds * 1000);

    this.initialized = true;
  }

  /**
   * Make a fetch call from WITHIN the page context. Akamai's XHR
   * interceptor automatically adds the bot-validation headers.
   * Returns the response status + body.
   */
  async fetch(url: string, init?: StealthFetchInit): Promise<StealthFetchResult> {
    if (!this.page) throw new Error('StealthClient not initialized. Call init() first.');

    const fullUrl = url.startsWith('http') ? url : `${this.opts.baseUrl}${url}`;

    const result = await this.page.evaluate(
      async (args: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
        const resp = await fetch(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body,
        });
        const text = await resp.text();
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        return { status: resp.status, ok: resp.ok, body: text, headers };
      },
      {
        url: fullUrl,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: init?.body,
      },
    );

    return result;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.initialized = false;
  }
}
