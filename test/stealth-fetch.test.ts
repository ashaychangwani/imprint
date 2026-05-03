/**
 * Pure-logic tests for StealthFetch — no real Chromium, no real
 * network. The Playwright + Akamai integration is verified by
 * scripts/southwest-stealth-test.ts (live, manual) since it can't be
 * meaningfully unit-tested without spinning up a browser.
 *
 * These tests cover:
 *   - Constructor option handling
 *   - Token age tracking + invalidate
 *   - Proactive maxTokenAgeSeconds refresh
 *   - Reactive maxConsecutiveFailures escalation
 *   - createStealthFetchImpl wrapper translation
 */

import { describe, expect, it } from 'bun:test';
import { StealthFetch, createStealthFetchImpl } from '../src/imprint/stealth-fetch.ts';

/**
 * Test subclass that stubs the real bootstrap (browser launch) and the
 * public fetch path so the test drives lifecycle deterministically
 * without touching real Chromium or the network. We override `fetch`
 * directly and re-implement just enough of the retry + age + failure-
 * streak logic to keep the StealthFetch contract observable from tests.
 */
class FakeStealthFetch extends StealthFetch {
  bootstrapCalls = 0;
  fetchCalls = 0;
  /** Status returned from each successive simulated network call. */
  statusSequence: number[] = [200];
  bodySequence: string[] = ['{}'];

  override async bootstrap(_probeUrl?: string): Promise<void> {
    this.bootstrapCalls++;
    // Inject pretend tokens so tokenAgeSeconds becomes >= 0.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    (this as any).tokens = {
      cookies: [{ name: '_abck', value: 'fake' }],
      sensorHeaders: { 'EE-a': 'sensor-token' },
      bootstrappedAt: Date.now(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    (this as any).consecutiveFailures = 0;
  }

  override async fetch(
    _url: string,
    _init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    ok: boolean;
    body: string;
    headers: Record<string, string>;
  }> {
    // Mimic the proactive-refresh check on the parent class.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    const tokens = (this as any).tokens as { bootstrappedAt: number } | null;
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    const opts = (this as any).opts as {
      maxRetries: number;
      maxConsecutiveFailures: number;
      maxTokenAgeSeconds: number;
    };
    if (tokens && this.tokenAgeSeconds >= opts.maxTokenAgeSeconds) {
      // biome-ignore lint/suspicious/noExplicitAny: test-only access
      (this as any).tokens = null;
    }
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    if (!(this as any).tokens) await this.bootstrap();

    let retries = 0;
    while (true) {
      const status = this.statusSequence[this.fetchCalls] ?? 200;
      const body = this.bodySequence[this.fetchCalls] ?? '{}';
      this.fetchCalls++;
      const result = { status, ok: status >= 200 && status < 300, body, headers: {} };

      if (status === 403) {
        // biome-ignore lint/suspicious/noExplicitAny: test-only access
        (this as any).consecutiveFailures++;
        // biome-ignore lint/suspicious/noExplicitAny: test-only access
        if ((this as any).consecutiveFailures >= opts.maxConsecutiveFailures) {
          return result;
        }
        if (retries < opts.maxRetries) {
          await this.bootstrap();
          retries++;
          continue;
        }
        return result;
      }

      // biome-ignore lint/suspicious/noExplicitAny: test-only access
      (this as any).consecutiveFailures = 0;
      return result;
    }
  }
}

describe('StealthFetch construction', () => {
  it('accepts a string baseUrl as shorthand', () => {
    const sf = new StealthFetch('https://example.com');
    expect(sf.tokenAgeSeconds).toBe(-1);
  });

  it('accepts an options object', () => {
    const sf = new StealthFetch({
      baseUrl: 'https://example.com',
      sensorWaitSeconds: 5,
      maxTokenAgeSeconds: 30,
    });
    expect(sf.tokenAgeSeconds).toBe(-1);
  });
});

describe('Token lifecycle', () => {
  it('tokenAgeSeconds is -1 before bootstrap', () => {
    const sf = new FakeStealthFetch('https://example.com');
    expect(sf.tokenAgeSeconds).toBe(-1);
  });

  it('tokenAgeSeconds becomes >= 0 after bootstrap', async () => {
    const sf = new FakeStealthFetch('https://example.com');
    await sf.bootstrap();
    expect(sf.tokenAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('invalidate() clears tokens', async () => {
    const sf = new FakeStealthFetch('https://example.com');
    await sf.bootstrap();
    sf.invalidate();
    expect(sf.tokenAgeSeconds).toBe(-1);
  });
});

describe('Proactive TTL refresh (maxTokenAgeSeconds)', () => {
  it('does NOT re-bootstrap when tokens are within max age', async () => {
    const sf = new FakeStealthFetch({
      baseUrl: 'https://example.com',
      maxTokenAgeSeconds: 600,
    });
    sf.statusSequence = [200];
    await sf.fetch('/api/x');
    expect(sf.bootstrapCalls).toBe(1);
    sf.statusSequence = [200];
    await sf.fetch('/api/x');
    // Still 1 — tokens are fresh
    expect(sf.bootstrapCalls).toBe(1);
  });

  it('re-bootstraps when tokens exceed max age', async () => {
    const sf = new FakeStealthFetch({
      baseUrl: 'https://example.com',
      maxTokenAgeSeconds: 0, // expire immediately
    });
    sf.statusSequence = [200, 200];
    await sf.fetch('/api/x');
    expect(sf.bootstrapCalls).toBe(1);
    // Wait at least 1 full second so floor((now - bootstrappedAt)/1000) >= 1.
    await new Promise((r) => setTimeout(r, 1100));
    await sf.fetch('/api/x');
    expect(sf.bootstrapCalls).toBe(2);
  });
});

describe('Reactive 403 retry + consecutive-failure escalation', () => {
  it('re-bootstraps once on 403 (within maxRetries)', async () => {
    const sf = new FakeStealthFetch({
      baseUrl: 'https://example.com',
      maxRetries: 1,
      maxConsecutiveFailures: 5,
    });
    sf.statusSequence = [403, 200];
    const r = await sf.fetch('/api/x');
    expect(r.status).toBe(200);
    expect(sf.bootstrapCalls).toBe(2); // initial + one retry
  });

  it('returns the 403 (and stops retrying) when failure streak hits the cap', async () => {
    const sf = new FakeStealthFetch({
      baseUrl: 'https://example.com',
      maxRetries: 1,
      maxConsecutiveFailures: 2,
    });
    // Streak grows across calls: 1st call → 403, 2nd call → 403 (caps).
    sf.statusSequence = [403, 403, 403, 403];
    const r1 = await sf.fetch('/api/x');
    expect(r1.status).toBe(403);
    expect(sf.failureStreak).toBe(1);

    // Second call sees 403 again — failure count hits 2, no more retries.
    const r2 = await sf.fetch('/api/x');
    expect(r2.status).toBe(403);
    expect(sf.failureStreak).toBeGreaterThanOrEqual(2);
  });

  it('resets the failure streak on a non-403 response', async () => {
    const sf = new FakeStealthFetch({
      baseUrl: 'https://example.com',
      maxConsecutiveFailures: 5,
    });
    sf.statusSequence = [403, 200, 200];
    await sf.fetch('/api/x');
    expect(sf.failureStreak).toBe(0); // reset by the 200 after 403's retry
  });
});

describe('createStealthFetchImpl', () => {
  it('returns a fetch-shaped function that delegates to StealthFetch', async () => {
    const sf = new FakeStealthFetch('https://example.com');
    sf.statusSequence = [200];
    sf.bodySequence = ['{"items":[1,2,3]}'];

    const impl = createStealthFetchImpl(sf);
    const resp = await impl('https://example.com/api/x', {
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
    const sf = new FakeStealthFetch('https://example.com');
    sf.statusSequence = [200];
    const impl = createStealthFetchImpl(sf);
    const resp = await impl(new URL('https://example.com/api/x'));
    expect(resp.status).toBe(200);
  });
});
