/**
 * Tests for the predicate engine that drives cron's optional
 * `notifyWhen` push-on-success hook.
 */

import { describe, expect, it } from 'bun:test';
import { evaluateNotifyWhen, extractAt } from '../src/imprint/notify-when.ts';

describe('extractAt', () => {
  it('extracts a single numeric leaf via dot path', () => {
    expect(extractAt({ a: { b: 7 } }, 'a.b')).toEqual([7]);
  });

  it('iterates an array with [] and gathers all numeric leaves', () => {
    const data = { items: [{ price: 10 }, { price: 20 }, { price: 30 }] };
    expect(extractAt(data, 'items[].price')).toEqual([10, 20, 30]);
  });

  it('iterates nested arrays', () => {
    const data = {
      bounds: [
        { flights: [{ fares: [{ price: { amount: 89 } }, { price: { amount: 109 } }] }] },
        { flights: [{ fares: [{ price: { amount: 49 } }] }] },
      ],
    };
    expect(extractAt(data, 'bounds[].flights[].fares[].price.amount')).toEqual([89, 109, 49]);
  });

  it('returns [] when the path is missing partway down', () => {
    expect(extractAt({ a: {} }, 'a.b.c')).toEqual([]);
  });

  it('returns [] when an array along the path is empty', () => {
    expect(extractAt({ items: [] }, 'items[].price')).toEqual([]);
  });

  it('skips non-numeric leaves silently (e.g., null/undefined prices)', () => {
    const data = {
      items: [{ price: 10 }, { price: null }, { price: 'free' }, { price: 30 }],
    };
    expect(extractAt(data, 'items[].price')).toEqual([10, 30]);
  });

  it('throws when [] is applied to a non-array', () => {
    expect(() => extractAt({ items: { not: 'array' } }, 'items[].price')).toThrow(
      /expected an array/,
    );
  });

  it('throws when the path tries to descend into a non-object leaf', () => {
    expect(() => extractAt({ a: 5 }, 'a.b')).toThrow(/expected object\/array/);
  });

  it('throws on an empty path', () => {
    expect(() => extractAt({}, '')).toThrow(/empty path/);
  });
});

describe('evaluateNotifyWhen — price_below', () => {
  const data = {
    bounds: [
      { flights: [{ fares: [{ price: 149 }, { price: 89 }] }] },
      { flights: [{ fares: [{ price: 199 }] }] },
    ],
  };

  it('returns notify=true when min < threshold', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 99, pricePath: 'bounds[].flights[].fares[].price' },
      data,
    );
    expect(decision.notify).toBe(true);
    expect(decision.message).toContain('$89');
    expect(decision.message).toContain('$99');
  });

  it('returns notify=false when min === threshold (strict <)', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 89, pricePath: 'bounds[].flights[].fares[].price' },
      data,
    );
    expect(decision.notify).toBe(false);
  });

  it('returns notify=false when min > threshold', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 50, pricePath: 'bounds[].flights[].fares[].price' },
      data,
    );
    expect(decision.notify).toBe(false);
  });

  it('returns notify=false on an empty result set (no signal)', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 999, pricePath: 'bounds[].flights[].fares[].price' },
      { bounds: [] },
    );
    expect(decision.notify).toBe(false);
  });

  it('uses toolName in the title when provided', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 999, pricePath: 'items[].price' },
      { items: [{ price: 10 }] },
      'watch_southwest_fare',
    );
    expect(decision.title).toContain('watch_southwest_fare');
  });

  it('reports option count in the message', () => {
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 100, pricePath: 'items[].price' },
      { items: [{ price: 50 }, { price: 60 }, { price: 70 }] },
    );
    expect(decision.message).toContain('3 options');
  });
});
