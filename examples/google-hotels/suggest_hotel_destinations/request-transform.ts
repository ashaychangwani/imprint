export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params: Record<string, string | number | boolean> = {},
): { url: string; body: string } {
  const query = params.query;
  if (typeof query !== 'string' || query.length === 0) throw new Error('query must be a non-empty string');
  // Live verification proved the recorded prior-query and limit slots do not affect results.
  const args = JSON.stringify([query, '', 1, 0, null, 30, 10]);
  const rpc = JSON.stringify([[['mejVKc', args, null, 'generic']]]);
  return { url, body: new URLSearchParams({ 'f.req': rpc }).toString() + '&' };
}
