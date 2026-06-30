/**
 * Shared, format-agnostic helpers for resolving a `RequestCapture` against a
 * response. Used by the runtime (resolving `authConfig.sessionCapture` /
 * per-request captures during replay) and by `imprint login` (resolving the
 * same declarative captures against a recorded login response). Keeping a single
 * implementation means a capture locator behaves identically wherever it runs.
 *
 * This is a LEAF module — it must not import other `src/imprint` modules so it
 * can be consumed from anywhere without introducing an import cycle.
 */

/** Lookup a JSON path inside a parsed value. Segments may be:
 *   - an object key:            `reauth.mfaId`
 *   - a numeric array index:    `items[0]` (bracket) or `items.0` (dot)
 *   - a field-match predicate:  `challenges[type=push]`
 *     → the FIRST array element whose `element[field]` stringifies to the value.
 *  The predicate makes captures robust to non-deterministic array ordering — e.g.
 *  a 2FA endpoint that returns its SMS/email/push challenges in a varying order, so
 *  a fixed `challenges[0]` grabs the wrong one while `[type=push]` always selects
 *  the push one. A bracketed token that is neither a number nor a `key=value`
 *  predicate is treated as a literal object key (so a top-level key that itself
 *  contains dots, e.g. `[customers.userInformation.accountNumber]`, is matched
 *  verbatim rather than traversed). */
export function jsonpath(root: unknown, path: string): unknown {
  const tokens: Array<
    | { kind: 'key'; v: string }
    | { kind: 'index'; v: number }
    | { kind: 'pred'; k: string; v: string }
  > = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ kind: 'key', v: m[1] });
    } else {
      const inner = m[2] ?? '';
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: 'index', v: Number.parseInt(inner, 10) });
      } else {
        const eq = inner.indexOf('=');
        if (eq >= 0)
          tokens.push({
            kind: 'pred',
            k: inner.slice(0, eq).trim(),
            v: inner.slice(eq + 1).trim(),
          });
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
