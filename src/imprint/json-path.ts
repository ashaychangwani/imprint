/**
 * JSON dot-path walker. `[]` segments iterate arrays; numeric leaves
 * (including coerced numeric strings like "108.40") are collected.
 *
 *   extractAt({a:[{b:1},{b:2}]}, "a[].b")                 → [1, 2]
 *   extractAt({x:[{y:[{z:5}]}]}, "x[].y[].z")             → [5]
 *
 * Throws on shape mismatches (non-array where `[]` expected, primitive
 * where descent expected) so misconfigured paths fail loudly.
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
    // Many APIs return money as decimal strings ("108.40") to dodge
    // float-precision games — coerce.
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
    throw new Error(
      `extractAt: expected object/array at segment "${seg.key}", got ${node === null ? 'null' : typeof node}`,
    );
  }
  const next = (node as Record<string, unknown>)[seg.key];
  if (next === undefined) return;
  if (seg.iterate) {
    if (!Array.isArray(next)) {
      throw new Error(`extractAt: "${seg.key}[]" expected an array, got ${typeof next}`);
    }
    for (const item of next) walk(item, segs, i + 1, out);
  } else {
    walk(next, segs, i + 1, out);
  }
}
