/**
 * Tests for the predicate engine that drives cron's optional
 * `notifyWhen` push-on-success hook (provider hooks live in notify.ts
 * itself but are env-var-driven and not unit-tested here).
 */

import { describe, expect, it } from 'bun:test';
import { extractAt } from '../src/imprint/json-path.ts';
import { evaluateNotifyWhen } from '../src/imprint/notify.ts';

describe('extractAt', () => {
  it('extracts a single value via dot path (no [])', () => {
    expect(extractAt({ a: { b: 7 } }, 'a.b')).toEqual(7);
  });

  it('extracts a complex object via dot path (no [])', () => {
    const data = { data: { results: { items: [1, 2, 3] } } };
    expect(extractAt(data, 'data.results')).toEqual({ items: [1, 2, 3] });
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

  it('returns undefined when the path is missing (no [])', () => {
    expect(extractAt({ a: {} }, 'a.b.c')).toEqual(undefined);
  });

  it('returns [] when an array along the path is empty', () => {
    expect(extractAt({ items: [] }, 'items[].price')).toEqual([]);
  });

  it('collects all non-null leaves including non-numeric values', () => {
    const data = {
      items: [{ price: 10 }, { price: null }, { price: 'free' }, { price: 30 }],
    };
    expect(extractAt(data, 'items[].price')).toEqual([10, 'free', 30]);
  });

  it('collects all values including strings and numbers', () => {
    const data = {
      items: [{ price: '108.40' }, { price: '49.00' }, { price: 'N/A' }, { price: 199 }],
    };
    expect(extractAt(data, 'items[].price')).toEqual(['108.40', '49.00', 'N/A', 199]);
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

describe('evaluateNotifyWhen — multi-path pricePath (backend shape variance)', () => {
  it('tries each path until one matches the data shape', () => {
    // Simulates the Southwest case: stealth-fetch returns the raw API
    // shape, playbook returns a reshaped {prices: [...]} envelope. One
    // pricePath array handles both.
    const apiShape = {
      data: { searchResults: { airProducts: [{ lowestFare: { value: 89 } }] } },
    };
    const playbookShape = { prices: [89], source_url: 'x' };
    const pricePath = ['data.searchResults.airProducts[].lowestFare.value', 'prices[]'];

    expect(
      evaluateNotifyWhen({ type: 'price_below', threshold: 99, pricePath }, apiShape).notify,
    ).toBe(true);
    expect(
      evaluateNotifyWhen({ type: 'price_below', threshold: 99, pricePath }, playbookShape).notify,
    ).toBe(true);
  });

  it('unions values from every matching path', () => {
    const data = { a: { x: 50 }, b: { y: 30 } };
    const decision = evaluateNotifyWhen(
      { type: 'price_below', threshold: 40, pricePath: ['a.x', 'b.y'] },
      data,
    );
    expect(decision.notify).toBe(true); // min(50, 30) = 30 < 40
    expect(decision.message).toContain('$30');
  });

  it('returns notify=false when NO path matches', () => {
    const decision = evaluateNotifyWhen(
      {
        type: 'price_below',
        threshold: 999,
        pricePath: ['nonexistent.path.one', 'also.missing'],
      },
      { unrelated: { shape: true } },
    );
    expect(decision.notify).toBe(false);
  });

  it('treats a single-string pricePath identically to a one-element array', () => {
    const data = { items: [{ price: 50 }] };
    const a = evaluateNotifyWhen(
      { type: 'price_below', threshold: 99, pricePath: 'items[].price' },
      data,
    );
    const b = evaluateNotifyWhen(
      { type: 'price_below', threshold: 99, pricePath: ['items[].price'] },
      data,
    );
    expect(a.notify).toBe(b.notify);
    expect(a.message).toBe(b.message);
  });
});
