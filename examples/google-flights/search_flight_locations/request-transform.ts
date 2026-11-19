export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body: string } {
  const query = params?.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query must be a non-empty string');
  }

  const innerPayload = JSON.stringify([query, [1, 2, 3, 5], null, [2], 1]);
  const envelope = JSON.stringify([[['H028ib', innerPayload, null, 'generic']]]);
  return { url, body: `f.req=${encodeURIComponent(envelope)}&` };
}
