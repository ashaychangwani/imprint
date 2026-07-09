type Params = Record<string, string | number | boolean>;

function asNumber(value: string | number | boolean | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function asString(value: string | number | boolean | undefined, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Params,
): { url: string; body?: string } {
  const imageSize = asNumber(params?.image_size, 152);
  const hotelToken = asString(params?.hotel_token, 'hotel_token');
  const innerPayload = JSON.stringify([null, null, null, [imageSize, imageSize], hotelToken]);
  const outerPayload = [[['zM1L7d', innerPayload, null, '1']]];
  const body = new URLSearchParams({ 'f.req': JSON.stringify(outerPayload) }).toString() + '&';
  return { url, body };
}
