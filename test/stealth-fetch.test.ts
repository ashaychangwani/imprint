/**
 * Pure-logic tests for stealth-fetch — no real Chromium, no real
 * network. The Playwright + Akamai integration is verified by
 * scripts/southwest-stealth-test.ts (live, manual) since it can't be
 * meaningfully unit-tested without spinning up a browser.
 *
 * These tests cover:
 *   - Construction (string and options-object forms)
 *   - Token age tracking + invalidate
 *   - Proactive maxTokenAgeSeconds refresh
 *   - Reactive maxConsecutiveFailures escalation
 *   - fetchImpl wrapper translation (URL inputs, Response shape)
 *
 * The bootstrap + underlying network call are injected via the
 * StealthFetchInternals seam so the tests drive lifecycle
 * deterministically without touching real Chromium or the network.
 */

import { describe, expect, it } from 'bun:test';
import {
  type FetchInit,
  type StealthFetch,
  type StealthFetchOptions,
  type TokenCache,
  createStealthFetch,
} from '../src/imprint/stealth-fetch.ts';

interface FakeOpts extends Partial<StealthFetchOptions> {
  /** Sequence of HTTP statuses returned by underlyingFetch in order. */
  statusSequence?: number[];
  /** Sequence of bodies returned by underlyingFetch in order. */
  bodySequence?: string[];
  /** Caller observes how many times bootstrap was invoked. */
  bootstrapCalls?: { count: number };
  /** Caller observes how many times underlyingFetch was invoked. */
  fetchCalls?: { count: number };
}

function makeFake(opts: FakeOpts = {}): StealthFetch {
  const bootstrapRef = opts.bootstrapCalls ?? { count: 0 };
  const fetchRef = opts.fetchCalls ?? { count: 0 };
  const statusSeq = opts.statusSequence ?? [200];
  const bodySeq = opts.bodySequence ?? ['{}'];
  return createStealthFetch(
    {
      baseUrl: opts.baseUrl ?? 'https://example.com',
      maxRetries: opts.maxRetries,
      maxConsecutiveFailures: opts.maxConsecutiveFailures,
      maxTokenAgeSeconds: opts.maxTokenAgeSeconds,
    },
    {
      bootstrap: async (): Promise<TokenCache> => {
        bootstrapRef.count++;
        return {
          cookies: [{ name: '_abck', value: 'fake' }],
          sensorHeaders: { 'EE-a': 'sensor-token' },
          bootstrappedAt: Date.now(),
        };
      },
      underlyingFetch: async (_url: string, _init: FetchInit, _tokens: TokenCache) => {
        const idx = fetchRef.count++;
        const status = statusSeq[idx] ?? 200;
        const body = bodySeq[idx] ?? '{}';
        return { status, ok: status >= 200 && status < 300, body, headers: {} };
      },
    },
  );
}

describe('createStealthFetch construction', () => {
  it('accepts a string baseUrl as shorthand', () => {
    const sf = createStealthFetch('https://example.com');
    expect(sf.tokenAgeSeconds).toBe(-1);
  });

  it('accepts an options object', () => {
    const sf = createStealthFetch({
      baseUrl: 'https://example.com',
      sensorWaitSeconds: 5,
      maxTokenAgeSeconds: 30,
    });
    expect(sf.tokenAgeSeconds).toBe(-1);
  });
});

describe('Token lifecycle', () => {
  it('tokenAgeSeconds is -1 before any fetch', () => {
    const sf = makeFake();
    expect(sf.tokenAgeSeconds).toBe(-1);
  });

  it('tokenAgeSeconds becomes >= 0 after the first fetch (which bootstraps)', async () => {
    const sf = makeFake({ statusSequence: [200] });
    await sf.fetchImpl('https://example.com/api/x');
    expect(sf.tokenAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('invalidate() clears tokens', async () => {
    const sf = makeFake({ statusSequence: [200] });
    await sf.fetchImpl('https://example.com/api/x');
    sf.invalidate();
    expect(sf.tokenAgeSeconds).toBe(-1);
  });
});

describe('Proactive TTL refresh (maxTokenAgeSeconds)', () => {
  it('does NOT re-bootstrap when tokens are within max age', async () => {
    const bootstrapCalls = { count: 0 };
    const sf = makeFake({
      statusSequence: [200, 200],
      bootstrapCalls,
      maxTokenAgeSeconds: 600,
    });
    await sf.fetchImpl('https://example.com/api/x');
    expect(bootstrapCalls.count).toBe(1);
    await sf.fetchImpl('https://example.com/api/x');
    // Still 1 — tokens are fresh.
    expect(bootstrapCalls.count).toBe(1);
  });

  it('re-bootstraps when tokens exceed max age', async () => {
    const bootstrapCalls = { count: 0 };
    const sf = makeFake({
      statusSequence: [200, 200],
      bootstrapCalls,
      maxTokenAgeSeconds: 0, // expire immediately
    });
    await sf.fetchImpl('https://example.com/api/x');
    expect(bootstrapCalls.count).toBe(1);
    // Wait at least 1 full second so floor((now - bootstrappedAt)/1000) >= 1.
    await new Promise((r) => setTimeout(r, 1100));
    await sf.fetchImpl('https://example.com/api/x');
    expect(bootstrapCalls.count).toBe(2);
  });
});

describe('Reactive 403 retry + consecutive-failure escalation', () => {
  it('re-bootstraps once on 403 (within maxRetries)', async () => {
    const bootstrapCalls = { count: 0 };
    const sf = makeFake({
      statusSequence: [403, 200],
      bootstrapCalls,
      maxRetries: 1,
      maxConsecutiveFailures: 5,
    });
    const r = await sf.fetchImpl('https://example.com/api/x');
    expect(r.status).toBe(200);
    expect(bootstrapCalls.count).toBe(2); // initial + one retry
  });

  it('returns the 403 (and stops retrying) when failure streak hits the cap', async () => {
    const sf = makeFake({
      statusSequence: [403, 403, 403, 403],
      maxRetries: 1,
      maxConsecutiveFailures: 2,
    });
    // Streak grows across calls: 1st call → 403, 2nd call → 403 (caps).
    const r1 = await sf.fetchImpl('https://example.com/api/x');
    expect(r1.status).toBe(403);
    expect(sf.failureStreak).toBe(1);

    // Second call sees 403 again — failure count hits 2, no more retries.
    const r2 = await sf.fetchImpl('https://example.com/api/x');
    expect(r2.status).toBe(403);
    expect(sf.failureStreak).toBeGreaterThanOrEqual(2);
  });

  it('resets the failure streak on a non-403 response', async () => {
    const sf = makeFake({
      statusSequence: [403, 200, 200],
      maxConsecutiveFailures: 5,
    });
    await sf.fetchImpl('https://example.com/api/x');
    expect(sf.failureStreak).toBe(0); // reset by the 200 after 403's retry
  });
});

describe('fetchImpl', () => {
  it('returns a fetch-shaped Response', async () => {
    const sf = makeFake({
      statusSequence: [200],
      bodySequence: ['{"items":[1,2,3]}'],
    });
    const resp = await sf.fetchImpl('https://example.com/api/x', {
      method: 'POST',
      headers: { 'X-Custom': 'value' },
      body: 'request-body',
    });
    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
    const text = await resp.text();
    expect(text).toBe('{"items":[1,2,3]}');
  });

  it('handles URL objects as input', async () => {
    const sf = makeFake({ statusSequence: [200] });
    const resp = await sf.fetchImpl(new URL('https://example.com/api/x'));
    expect(resp.status).toBe(200);
  });

  it('passes non-string bodies through to the underlying fetch', async () => {
    // Workflow generated tools always send strings today, but the
    // wrapper is typed as `typeof fetch` and silently dropping a Blob /
    // FormData / URLSearchParams body would be a confusing real-user
    // failure mode. This test pins each of the BodyInit variants.
    const observed: Array<RequestInit['body']> = [];
    const sf = createStealthFetch(
      { baseUrl: 'https://example.com' },
      {
        bootstrap: async (): Promise<TokenCache> => ({
          cookies: [],
          sensorHeaders: {},
          bootstrappedAt: Date.now(),
        }),
        underlyingFetch: async (_url, init) => {
          observed.push(init.body);
          return { status: 200, ok: true, body: '{}', headers: {} };
        },
      },
    );

    const blob = new Blob(['hello']);
    await sf.fetchImpl('https://example.com/x', { method: 'POST', body: blob });

    const form = new FormData();
    form.append('q', 'value');
    await sf.fetchImpl('https://example.com/x', { method: 'POST', body: form });

    const params = new URLSearchParams({ q: 'v' });
    await sf.fetchImpl('https://example.com/x', { method: 'POST', body: params });

    const buf = new TextEncoder().encode('binary-payload');
    await sf.fetchImpl('https://example.com/x', { method: 'POST', body: buf });

    await sf.fetchImpl('https://example.com/x', { method: 'POST', body: 'plain-string' });

    // No call should have observed a dropped (undefined) body.
    expect(observed).toHaveLength(5);
    expect(observed[0]).toBe(blob);
    expect(observed[1]).toBe(form);
    expect(observed[2]).toBe(params);
    expect(observed[3]).toBe(buf);
    expect(observed[4]).toBe('plain-string');
  });
});

describe('Header defaults vs caller overrides', () => {
  // Capture the final init.headers the underlying fetch sees so we can
  // assert on what stealth-fetch actually puts on the wire.
  function makeHeaderCapturingSf(): {
    sf: StealthFetch;
    seen: Array<Record<string, string>>;
  } {
    const seen: Array<Record<string, string>> = [];
    const sf = createStealthFetch(
      { baseUrl: 'https://example.com' },
      {
        bootstrap: async (): Promise<TokenCache> => ({
          cookies: [],
          sensorHeaders: {},
          bootstrappedAt: Date.now(),
        }),
        underlyingFetch: async (_url, init) => {
          seen.push((init.headers ?? {}) as Record<string, string>);
          return { status: 200, ok: true, body: '{}', headers: {} };
        },
      },
    );
    return { sf, seen };
  }

  // Header keys reach fetchWithRetry already lowercased (the public
  // fetchImpl wrapper normalizes via `new Headers().forEach`), so we assert
  // on lowercase keys throughout.

  it('omits content-type on body-less GETs (real browsers do not send it)', async () => {
    // Regression: the JSON Content-Type used to land unconditionally, which
    // is a small but real anti-bot tell on HTML bootstrap GETs against
    // Akamai-protected sites (Costco). A GET with no body must not carry a
    // Content-Type at all.
    const { sf, seen } = makeHeaderCapturingSf();
    await sf.fetchImpl('https://example.com/Rental-Cars');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('content-type');
    expect(seen[0]).not.toHaveProperty('Content-Type');
  });

  it('applies content-type: application/json default on POST with body', async () => {
    const { sf, seen } = makeHeaderCapturingSf();
    await sf.fetchImpl('https://example.com/api/x', { method: 'POST', body: '{"k":1}' });
    expect(seen[0]?.['content-type']).toBe('application/json');
  });

  it('lets the caller override content-type on a POST', async () => {
    const { sf, seen } = makeHeaderCapturingSf();
    await sf.fetchImpl('https://example.com/api/x', {
      method: 'POST',
      body: 'a=1&b=2',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(seen[0]?.['content-type']).toBe('application/x-www-form-urlencoded');
    // The duplicate-case bug pre-fix would leave both `Content-Type` and
    // `content-type` in the headers; assert it doesn't anymore.
    expect(seen[0]).not.toHaveProperty('Content-Type');
  });

  it('lets the caller override accept (e.g. text/html on a bootstrap GET)', async () => {
    const { sf, seen } = makeHeaderCapturingSf();
    await sf.fetchImpl('https://example.com/Rental-Cars', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    expect(seen[0]?.accept).toBe('text/html,application/xhtml+xml');
    expect(seen[0]).not.toHaveProperty('Accept');
  });
});

describe('UA + client-hint consistency', () => {
  // The bug this guards: a hardcoded UA (Chrome/131) paired with the live
  // binary's client hints (Chrome/148) is a contradiction no real browser
  // emits — a textbook anti-bot tell. The bootstrap now captures the browser's
  // real navigator.userAgent + sec-ch-ua and reuses them on the wire.
  function makeSf(
    token: Partial<TokenCache>,
    optionUserAgent?: string,
  ): { sf: StealthFetch; seen: Array<Record<string, string>> } {
    const seen: Array<Record<string, string>> = [];
    const sf = createStealthFetch(
      {
        baseUrl: 'https://example.com',
        ...(optionUserAgent ? { userAgent: optionUserAgent } : {}),
      },
      {
        bootstrap: async (): Promise<TokenCache> => ({
          cookies: [],
          sensorHeaders: {},
          bootstrappedAt: Date.now(),
          ...token,
        }),
        underlyingFetch: async (_url, init) => {
          seen.push((init.headers ?? {}) as Record<string, string>);
          return { status: 200, ok: true, body: '{}', headers: {} };
        },
      },
    );
    return { sf, seen };
  }

  it('reuses the UA captured during bootstrap on the wire', async () => {
    const capturedUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
    const { sf, seen } = makeSf({ userAgent: capturedUA });
    await sf.fetchImpl('https://example.com/api/x');
    expect(seen[0]?.['user-agent']).toBe(capturedUA);
  });

  it('attaches captured client hints consistent with the UA', async () => {
    const { sf, seen } = makeSf({
      userAgent: 'UA/148',
      clientHints: {
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    });
    await sf.fetchImpl('https://example.com/api/x');
    expect(seen[0]?.['sec-ch-ua']).toBe('"Chromium";v="148", "Google Chrome";v="148"');
    expect(seen[0]?.['sec-ch-ua-platform']).toBe('"macOS"');
  });

  it('falls back to DEFAULT_UA when bootstrap captured none', async () => {
    const { sf, seen } = makeSf({});
    await sf.fetchImpl('https://example.com/api/x');
    // The current floor is Chrome/148; assert it is not the stale 131 we removed.
    expect(seen[0]?.['user-agent']).toContain('Chrome/148');
    expect(seen[0]?.['user-agent']).not.toContain('Chrome/131');
  });

  it('an explicit UA override wins and suppresses captured client hints', async () => {
    // A forced UA does not change the browser's native client hints, so pairing
    // captured hints with an override would reintroduce the contradiction.
    const { sf, seen } = makeSf(
      {
        userAgent: 'native/148',
        clientHints: { 'sec-ch-ua': '"Chromium";v="148"', 'sec-ch-ua-platform': '"macOS"' },
      },
      'forced/99',
    );
    await sf.fetchImpl('https://example.com/api/x');
    expect(seen[0]?.['user-agent']).toBe('forced/99');
    expect(seen[0]).not.toHaveProperty('sec-ch-ua');
  });
});
