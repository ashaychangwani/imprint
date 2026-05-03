/**
 * Tiny JSON dot-path walker with `[]` segments meaning "iterate every
 * element of this array". Used by both the cron notifyWhen predicate
 * (extracting prices to test against a threshold) and the playbook
 * runner (extracting values out of captured XHR JSON).
 *
 * Generic enough that it doesn't belong to either caller — they just
 * happened to need the same shape, so it lives on its own.
 */

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
