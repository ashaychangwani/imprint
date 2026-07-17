import { describe, expect, it } from 'bun:test';
import { ResponseBodyIntentTracker } from '../src/imprint/response-body-intent.ts';

describe('ResponseBodyIntentTracker', () => {
  it('matches intent even when Runtime delivery follows the Network request event', () => {
    const tracker = new ResponseBodyIntentTracker();
    const requestAt = 20_000;

    expect(tracker.match('https://example.com/products?_rsc=key', requestAt)).toBeUndefined();
    tracker.record(19_900, 'https://example.com/products');
    expect(tracker.match('https://example.com/products?_rsc=key', requestAt)).toBe(
      'https://example.com/products',
    );
  });

  it('rejects future, stale, cross-route, and cross-origin intent', () => {
    const requestAt = 20_000;
    for (const [intentAt, intentUrl] of [
      [20_001, 'https://example.com/products'],
      [9_999, 'https://example.com/products'],
      [19_900, 'https://example.com/other'],
      [19_900, 'https://other.example/products'],
    ] as Array<[number, string]>) {
      const tracker = new ResponseBodyIntentTracker();
      tracker.record(intentAt, intentUrl);
      expect(tracker.match('https://example.com/products?_rsc=key', requestAt)).toBeUndefined();
    }
  });

  it('requires later activation, not hover, for a viewport-prefetched route', () => {
    const tracker = new ResponseBodyIntentTracker();
    tracker.record(29_000, 'https://example.com/products', 'pointerover');
    expect(
      tracker.matchActivation('https://example.com/products?_rsc=prefetch', 30_000),
    ).toBeUndefined();
    expect(
      tracker.hasMatchingActivationSince('https://example.com/products?_rsc=prefetch', 20_000),
    ).toBe(false);
    tracker.record(30_000, 'https://example.com/products', 'pointerdown');
    expect(tracker.matchActivation('https://example.com/products?_rsc=prefetch', 30_001)).toBe(
      'https://example.com/products',
    );

    expect(
      tracker.hasMatchingActivationSince('https://example.com/products?_rsc=prefetch', 20_000),
    ).toBe(true);
    expect(
      tracker.hasMatchingActivationSince('https://example.com/other?_rsc=prefetch', 20_000),
    ).toBe(false);
  });

  it('bounds hostile same-window intent volume and URL length', () => {
    const tracker = new ResponseBodyIntentTracker();
    const startedAt = performance.now();
    for (let index = 0; index < 50_000; index++) {
      tracker.record(30_000, `https://example.com/${index}`, 'pointerover');
    }
    tracker.record(30_001, `https://example.com/${'x'.repeat(5_000)}`, 'click');

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(tracker.match('https://example.com/49999', 30_000)).toBe('https://example.com/49999');
    expect(tracker.match('https://example.com/0', 30_000)).toBeUndefined();
  });
});
