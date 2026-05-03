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
});
