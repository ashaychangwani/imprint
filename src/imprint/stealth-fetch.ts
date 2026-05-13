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

import { type Browser, chromium } from 'playwright';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
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
}

export interface StealthFetch {
  /** typeof fetch wrapper that auto-bootstraps + adds sensor headers. */
  readonly fetchImpl: typeof fetch;
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

interface BootstrapArgs {
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
interface StealthFetchInternals {
  bootstrap?: (args: BootstrapArgs) => Promise<TokenCache>;
  underlyingFetch?: (url: string, init: FetchInit, tokens: TokenCache) => Promise<FetchResult>;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
    if (tokens && tokenAge() >= opts.maxTokenAgeSeconds) {
      log(`tokens ${tokenAge()}s old (>= ${opts.maxTokenAgeSeconds}s), refreshing proactively`);
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
      const result = await underlyingFetchFn(
        fullUrl,
        {
          method: init?.method ?? 'GET',
          headers: {
            'User-Agent': opts.userAgent,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/json',
            Cookie: mergeCookieHeader(
              t.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
              cookieHeader,
            ),
            Origin: new URL(fullUrl).origin,
            Referer: opts.baseUrl,
            ...t.sensorHeaders,
            ...initHeaders,
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

    // 'domcontentloaded' (not 'networkidle') because SPAs keep connections
    // alive forever; explicit sensor-wait lets bot-detection JS fire.
    await page.goto(args.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(args.sensorWaitSeconds * 1000);

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
    const origin = new URL(args.baseUrl);
    const root = registrableDomain(origin.hostname);
    const cookies = allCookies
      .filter((c) => {
        const cookieHost = c.domain.replace(/^\./, '');
        return isSameRegistrableDomain(cookieHost, root);
      })
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
