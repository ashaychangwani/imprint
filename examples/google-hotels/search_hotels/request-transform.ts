type Params = Record<string, string | number | boolean>;

function dateParts(value: unknown, name: string): number[] {
  if (typeof value !== 'string') throw new Error(`${name} must use YYYY-MM-DD`);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${name} must use YYYY-MM-DD`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const normalized = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!))
    .toISOString()
    .slice(0, 10);
  if (normalized !== value) throw new Error(`${name} must be a real calendar date`);
  return parts;
}
function rpcBody(payload: unknown): string {
  return 'f.req=' + encodeURIComponent(JSON.stringify([[['AtySUc', JSON.stringify(payload), null, '1']]])) + '&';
}
function destinationIdFrom(responses: unknown[]): string | null {
  const text = responses
    .map(value => typeof value === 'string' ? value : JSON.stringify(value))
    .join('\n');
  const escaped = text.match(
    /\\+"((?:0x[0-9a-f]+:0x[0-9a-f]+|\/[mg]\/[A-Za-z0-9_-]+))\\+"(?:,null){0,6},\\+"((?!0x)[^"\\]+)\\+"/i,
  );
  const plain = text.match(
    /"((?:0x[0-9a-f]+:0x[0-9a-f]+|\/[mg]\/[A-Za-z0-9_-]+))"(?:,null){0,6},"((?!0x)[^"\\]+)"/i,
  );
  return escaped?.[1] ?? plain?.[1] ?? null;
}
export function transform(method: string, url: string, responses: unknown[], params: Params = {}): { url: string; body: string } {
  void method;
  const location = String(params.location || '');
  if (!location) throw new Error('location is required');
  const currency = String(params.currency || 'USD').toUpperCase();
  const checkIn = dateParts(params.check_in_date, 'check_in_date');
  const checkOut = dateParts(params.check_out_date, 'check_out_date');
  const adults = Math.max(1, Number(params.adults ?? 2));
  const children = Math.max(0, Number(params.children ?? 0));
  const propertyType = String(params.property_type || 'hotels').toLowerCase().includes('vacation') ? 2 : 1;
  const rating = Number(params.min_rating ?? 0);
  const ratingCode = rating >= 4.5 ? 9 : rating >= 4 ? 8 : rating >= 3.5 ? 7 : null;
  const minPrice = Number(params.min_price ?? 0) || null;
  const maxPrice = Number(params.max_price ?? 0) || null;
  const total = String(params.price_display || 'nightly').toLowerCase().includes('total') ? 1 : null;
  const stars = String(params.star_classes || '').split(',').map(x => Number(x.trim())).filter(x => [1,2,3,4,5].includes(x));
  const sorts: Record<string, number> = { relevance: 0, lowest_price: 1, highest_rating: 2, most_reviewed: 3 };
  const sortBy = sorts[String(params.sort_by || 'relevance').toLowerCase()] ?? 0;
  const filters: unknown[] = [];
  if (ratingCode) filters[0] = [ratingCode];
  if (stars.length) filters[1] = stars;
  const priceFilter = (minPrice || maxPrice || total) ? [[null, minPrice], [null, maxPrice], total] : undefined;
  const start = Date.UTC(checkIn[0]!, checkIn[1]! - 1, checkIn[2]!);
  const end = Date.UTC(checkOut[0]!, checkOut[1]! - 1, checkOut[2]!);
  const nights = (end - start) / 86_400_000;
  if (!Number.isInteger(nights) || nights < 1) {
    throw new Error('check_out_date must be later than check_in_date');
  }
  const destinationId = responses.length ? destinationIdFrom(responses) : null;
  if (responses.length && !destinationId) {
    throw new Error('destination identifier missing from discovery response');
  }
  const destination = destinationId ? [null, [[destinationId, null, null, null, null, null, location]]] : null;
  const stay = [null, [checkIn, checkOut, nights], null, null, null, [adults > 1 ? adults - 1 : null, children]];
  const payload = [location, [propertyType, [[[3],[3]], children > 0 ? 1 : 0], destination ? [destination, stay] : null, null, [[null,null,null,null,null,null,currency], null, filters.length ? filters : [], priceFilter, ratingCode]], [sortBy,null,null,propertyType === 2 ? 1 : 0,0,null,13,null,0]];
  return { url, body: rpcBody(payload) };
}
