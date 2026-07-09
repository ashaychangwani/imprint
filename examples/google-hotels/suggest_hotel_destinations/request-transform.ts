function stringParam(params: Record<string, string | number | boolean> | undefined, name: string, fallback: string): string {
  const value = params?.[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function numberParam(params: Record<string, string | number | boolean> | undefined, name: string, fallback: number): number {
  const value = params?.[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body?: string } {
  const query = stringParam(params, 'query', 'denver downtown');
  const previousQuery = stringParam(params, 'previous_query', 'tahoe city hotels');
  const limit = numberParam(params, 'limit', 15);

  const innerArgs = JSON.stringify([query, previousQuery, 1, 0, null, 30, limit]);
  const rpcEnvelope = [[["mejVKc", innerArgs, null, "generic"]]];
  const body = `f.req=${encodeURIComponent(JSON.stringify(rpcEnvelope))}&`;

  return { url, body };
}
