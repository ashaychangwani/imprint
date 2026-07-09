export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body?: string } {
  const hotelName = String(params?.hotel_name ?? 'Hyatt Regency Chicago');
  const limitValue = Number(params?.limit ?? 3);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 3;

  const rpcPayload = JSON.stringify([hotelName, limit]);
  const fReq = JSON.stringify([[['bdmBfe', rpcPayload, null, 'generic']]]);
  return {
    url,
    body: `f.req=${encodeURIComponent(fReq)}&`,
  };
}
