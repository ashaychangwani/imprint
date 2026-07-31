export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body: string } {
  const query = params?.query;
  const requestedMax = Number(params?.max_results ?? 0);
  const requestedLimit = Number(params?.limit ?? 0);
  const maxResults = requestedMax > 0 ? requestedMax : requestedLimit > 0 ? requestedLimit : 15;

  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('query must be a non-empty string');
  }
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error('max_results or limit must be a positive integer');
  }

  // Live differential verification showed the recorded prior-query slot is a no-op.
  // Keep the RPC's required string shape without advertising ineffective control.
  const args = JSON.stringify([query, query, 1, 0, null, 30, maxResults]);
  const envelope = JSON.stringify([[['mejVKc', args, null, 'generic']]]);
  return { url, body: `f.req=${encodeURIComponent(envelope)}&` };
}
