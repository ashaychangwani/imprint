/**
 * JSON dot-path walker.
 *
 * Paths WITHOUT `[]` navigate to a single value and return it as-is:
 *   extractAt({a:{b:{c:42}}}, "a.b")          → {c:42}
 *   extractAt({data:{results:[1,2]}}, "data.results") → [1,2]
 *
 * Paths WITH `[]` iterate arrays and collect leaf values:
 *   extractAt({a:[{b:1},{b:2}]}, "a[].b")     → [1, 2]
 *   extractAt({x:[{y:[{z:5}]}]}, "x[].y[].z") → [5]
 *
 * Throws on shape mismatches (non-array where `[]` expected, primitive
 * where descent expected) so misconfigured paths fail loudly.
 */
export function extractNumbers(data: unknown, path: string): number[] {
  const result = extractAt(data, path);
  if (Array.isArray(result)) {
    const nums: number[] = [];
    for (const v of result) {
      if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
      else if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) nums.push(n);
      }
    }
    return nums;
  }
  if (typeof result === 'number' && Number.isFinite(result)) return [result];
  if (typeof result === 'string') {
    const n = Number(result);
    if (Number.isFinite(n)) return [n];
  }
  return [];
}

export function extractAt(data: unknown, path: string): unknown {
  if (path.length === 0) throw new Error('extractAt: empty path');
  const segments = parsePath(path);
  const hasIterate = segments.some((s) => s.iterate);
  if (!hasIterate) {
    return navigatePath(data, segments);
  }
  const out: unknown[] = [];
  walkCollect(data, segments, 0, out);
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

function navigatePath(node: unknown, segs: PathSegment[]): unknown {
  let current = node;
  for (const seg of segs) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(
        `extractAt: expected object/array at segment "${seg.key}", got ${current === null ? 'null' : typeof current}`,
      );
    }
    current = (current as Record<string, unknown>)[seg.key];
    if (current === undefined) return undefined;
  }
  return current;
}

function walkCollect(node: unknown, segs: PathSegment[], i: number, out: unknown[]): void {
  if (i === segs.length) {
    if (node !== null && node !== undefined) {
      out.push(node);
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
    for (const item of next) walkCollect(item, segs, i + 1, out);
  } else {
    walkCollect(next, segs, i + 1, out);
  }
}
