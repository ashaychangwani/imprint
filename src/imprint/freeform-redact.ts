/**
 * Exact-value protection for known user-supplied credentials.
 * No PII, token-shape, header, cookie, or payload classifiers.
 * Without explicit credential values the text is unchanged.
 */
export function redactFreeformText(
  text: string,
  credentials: ReadonlyMap<string, string> = new Map(),
): { redacted: string; redactionsCount: number } {
  let redactionsCount = 0;
  const variants = new Map<string, string>();
  for (const [value, placeholder] of credentials) {
    if (!value || value.startsWith('$' + '{credential.')) continue;
    for (const encoded of [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
    ]) {
      variants.set(encoded, placeholder);
    }
  }
  if (variants.size === 0) return { redacted: text, redactionsCount };
  const alternatives = [...variants.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    `\\$\\{credential\\.[^}]+\\}|(?<![A-Za-z0-9_])(?:${alternatives.join('|')})(?![A-Za-z0-9_])`,
    'g',
  );
  const redacted = text.replace(pattern, (value) => {
    const placeholder = variants.get(value);
    if (!placeholder) return value;
    redactionsCount++;
    return placeholder;
  });
  return { redacted, redactionsCount };
}
