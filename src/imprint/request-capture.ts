/**
 * Shared, format-agnostic helpers for resolving a `RequestCapture` against a
 * response. Used by the runtime and by `imprint login` when resolving captures
 * named by `authConfig.persist`. Keeping one implementation means a capture
 * locator behaves identically wherever it runs.
 *
 * This is a LEAF module — it must not import other `src/imprint` modules so it
 * can be consumed from anywhere without introducing an import cycle.
 */

/** Lookup a JSON path inside a parsed value. Segments may be:
 *   - an object key:            `result.identifier`
 *   - a numeric array index:    `items[0]` (bracket) or `items.0` (dot)
 *   - a field-match predicate:  `items[type=primary]`
 *   - a JSONPath predicate:     `items[?(@.type=='primary')]`
 *     → the FIRST array element whose `element[field]` stringifies to the value.
 *  Predicates keep captures stable when array ordering is non-deterministic. A
 *  bracketed token that is neither a number nor a `key=value`
 *  predicate is treated as a literal object key (so a top-level key that itself
 *  contains dots, e.g. `[customers.userInformation.accountNumber]`, is matched
 *  verbatim rather than traversed). */
export function jsonpath(root: unknown, path: string): unknown {
  const normalizedPath =
    path === '$'
      ? ''
      : path.startsWith('$.')
        ? path.slice(2)
        : path.startsWith('$[')
          ? path.slice(1)
          : path;
  const tokens: Array<
    | { kind: 'key'; v: string }
    | { kind: 'index'; v: number }
    | { kind: 'pred'; k: string; v: string }
  > = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(normalizedPath)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ kind: 'key', v: m[1] });
    } else {
      const inner = m[2] ?? '';
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: 'index', v: Number.parseInt(inner, 10) });
      } else {
        const predicate = parseFieldPredicate(inner);
        if (predicate) tokens.push(predicate);
        else tokens.push({ kind: 'key', v: inner });
      }
    }
  }
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.kind === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t.v];
    } else if (t.kind === 'pred') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find(
        (el) =>
          el != null &&
          typeof el === 'object' &&
          String((el as Record<string, unknown>)[t.k]) === t.v,
      );
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[t.v];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function captureValueMatches(
  value: unknown,
  equals?: string | number | boolean | null,
): boolean {
  if (equals !== undefined) return Object.is(value, equals);
  return value !== undefined && value !== null && value !== '';
}

function parseFieldPredicate(inner: string): { kind: 'pred'; k: string; v: string } | null {
  const standard = /^\?\(\s*@\.([A-Za-z_$][\w$-]*)\s*==\s*(.+?)\s*\)$/.exec(inner);
  if (standard?.[1] && standard[2] !== undefined) {
    return { kind: 'pred', k: standard[1], v: unquotePredicateValue(standard[2]) };
  }

  const eq = inner.indexOf('=');
  if (eq < 1 || inner[eq + 1] === '=') return null;
  return {
    kind: 'pred',
    k: inner.slice(0, eq).trim(),
    v: unquotePredicateValue(inner.slice(eq + 1).trim()),
  };
}

function unquotePredicateValue(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === "'" || first === '"') && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

/** Read a response header value, honoring the capture `mode`. Multi-valued
 *  headers are comma-split. `set-cookie` is never projected (cookies are handled
 *  by the cookie jar, not as plain header captures). */
export function captureHeader(
  headers: Headers,
  name: string,
  mode: 'first' | 'last' | 'all' = 'last',
): string | string[] | undefined {
  if (name.toLowerCase() === 'set-cookie') return undefined;
  const value = headers.get(name);
  if (value === null) return undefined;
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (mode === 'all') return values.length ? values : [value];
  if (mode === 'first') return values[0] ?? value;
  return values.at(-1) ?? value;
}
