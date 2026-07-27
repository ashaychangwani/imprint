export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body: string } {
  const raw = params?.location_id;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('location_id is required');
  }
  const input = raw.trim();
  let locationId: string;
  let discriminator: number;
  if (/^[A-Za-z]{3}$/.test(input)) {
    locationId = input.toUpperCase();
    discriminator = 0;
  } else if (/^\/m\/[A-Za-z0-9_-]+$/.test(input)) {
    locationId = input;
    discriminator = 5;
  } else {
    throw new Error('Unsupported location_id: use a three-letter airport code or a slash-prefixed /m/ entity id');
  }
  const argument = JSON.stringify([null, [[locationId, discriminator]]]);
  const envelope = JSON.stringify([[['tDoGIe', argument, null, 'generic']]]);
  return { url, body: 'f.req=' + encodeURIComponent(envelope) + '&' };
}
