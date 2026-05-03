/**
 * Predicate engine for cron's `notifyWhen` config. Decides — given a
 * successful tool result — whether to fire a push notification and what
 * to say in it.
 *
 * Lives outside the workflow runtime on purpose: deciding "is this fare
 * a good price?" is operator-specific business logic that has nothing
 * to do with how the underlying API call is made. The runtime stays
 * generic; this file holds the conditional-notify logic.
 */

import type { NotifyWhen } from './types.ts';

export interface NotifyDecision {
  notify: boolean;
  /** Used as the push title when notify=true. */
  title?: string;
  /** Used as the push body when notify=true. */
  message?: string;
}

export function evaluateNotifyWhen(
  pred: NotifyWhen,
  data: unknown,
  toolName = 'workflow',
): NotifyDecision {
  switch (pred.type) {
    case 'price_below': {
      const prices = extractAt(data, pred.pricePath);
      if (prices.length === 0) {
        // No prices at all — most likely an empty result set or a
        // misconfigured path. Treat as "no signal", don't push.
        return { notify: false };
      }
      const min = Math.min(...prices);
      if (min < pred.threshold) {
        return {
          notify: true,
          title: `imprint: price drop on ${toolName}`,
          message: `Lowest price $${min} (under your $${pred.threshold} threshold) — ${prices.length} option${prices.length === 1 ? '' : 's'} found.`,
        };
      }
      return { notify: false };
    }
  }
}

/**
 * Walk a dot-path with `[]` segments meaning "iterate every element of
 * this array". Returns a flat list of every numeric leaf reached.
 *
 * Examples:
 *   extractAt({a: 1}, "a")                → [1]
 *   extractAt({a: [{b: 1}, {b: 2}]}, "a[].b") → [1, 2]
 *   extractAt({x: [{y: [{z: 5}]}]}, "x[].y[].z") → [5]
 *
 * Throws if a non-array sits where a `[]` segment expects iteration —
 * misconfigurations should fail loudly so the operator notices.
 * Non-numeric leaves are silently skipped (some price fields might be
 * null for sold-out flights, etc.); we only care about the numbers.
 */
export function extractAt(data: unknown, path: string): number[] {
  if (path.length === 0) throw new Error('extractAt: empty path');
  const segments = parsePath(path);
  const out: number[] = [];
  walk(data, segments, 0, out);
  return out;
}

interface PathSegment {
  key: string;
  iterate: boolean;
}

function parsePath(path: string): PathSegment[] {
  return path.split('.').map((raw) => {
    if (raw.endsWith('[]')) {
      return { key: raw.slice(0, -2), iterate: true };
    }
    return { key: raw, iterate: false };
  });
}

function walk(node: unknown, segs: PathSegment[], i: number, out: number[]): void {
  if (i === segs.length) {
    // Numeric leaves are kept as-is. String leaves like "108.40" are
    // coerced — many real APIs return decimal money values as strings to
    // avoid float-precision games (Southwest, Stripe, most travel APIs).
    // Strings that don't parse cleanly are silently skipped.
    if (typeof node === 'number' && Number.isFinite(node)) {
      out.push(node);
    } else if (typeof node === 'string') {
      const n = Number(node);
      if (Number.isFinite(n)) out.push(n);
    }
    return;
  }
  const seg = segs[i];
  if (!seg) return;
  if (typeof node !== 'object' || node === null) {
    // Path expected a deeper structure but we hit a leaf. Misconfig.
    throw new Error(
      `extractAt: expected object/array at segment "${seg.key}", got ${node === null ? 'null' : typeof node}`,
    );
  }
  const next = (node as Record<string, unknown>)[seg.key];
  if (next === undefined) return; // missing key → no values from this branch
  if (seg.iterate) {
    if (!Array.isArray(next)) {
      throw new Error(`extractAt: "${seg.key}[]" expected an array, got ${typeof next}`);
    }
    for (const item of next) {
      walk(item, segs, i + 1, out);
    }
  } else {
    walk(next, segs, i + 1, out);
  }
}
