type Params = Record<string, string | number | boolean>;

function asString(params: Params | undefined, key: string, fallback = ''): string {
  const value = params?.[key];
  return value === undefined || value === null ? fallback : String(value);
}

function asNumber(params: Params | undefined, key: string, fallback = 0): number {
  const value = params?.[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateTriplet(value: string): number[] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function numberList(value: string): number[] | null {
  const nums = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
  return nums.length ? nums : null;
}

function propertyTypeCode(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === '2' || normalized.includes('vacation')) return 2;
  return 1;
}

function placeRow(destination: string): unknown[] | null {
  const normalized = destination.trim().toLowerCase();
  if (normalized.includes('chicago loop')) {
    return ['/m/0gz469', null, null, null, null, null, 'Chicago Loop'];
  }
  if (normalized.includes('tahoe city')) {
    return ['/m/0gyvmkl', null, null, null, null, '0x809bd62ecf1fa721:0x2a98b230816c9ed1', 'Tahoe City'];
  }
  if (normalized.includes('denver downtown')) {
    return ['/m/0525427', null, null, null, null, null, 'Denver Downtown'];
  }
  return null;
}

function buildPayload(params?: Params): unknown[] {
  const destination = asString(params, 'destination', 'chicago loop');
  const currency = asString(params, 'currency', 'USD') || 'USD';
  const type = propertyTypeCode(asString(params, 'property_type', 'hotels'));
  const sortOrder = asString(params, 'sort_order', 'relevance').trim().toLowerCase();
  const amenities = numberList(asString(params, 'amenities', ''));
  const classes = numberList(asString(params, 'hotel_classes', ''));
  const minPrice = asNumber(params, 'min_price', 0);
  const maxPrice = asNumber(params, 'max_price', 0);
  const minRating = asNumber(params, 'min_rating', 0);
  const checkIn = asString(params, 'check_in_date', '2026-07-03');
  const checkOut = asString(params, 'check_out_date', '2026-07-06');
  const checkInTriplet = parseDateTriplet(checkIn);
  const checkOutTriplet = parseDateTriplet(checkOut);
  const place = placeRow(destination);

  const filterVector: unknown[] = [
    amenities,
    classes,
    null,
    null,
    null,
    null,
    currency,
  ];
  const filters: unknown[] = [filterVector, null, []];
  if (minPrice > 0 || maxPrice > 0) {
    const bounds: unknown[] = [];
    bounds[0] = minPrice > 0 ? [null, minPrice] : null;
    bounds[1] = maxPrice > 0 ? [null, maxPrice] : null;
    if (maxPrice > 0) bounds[2] = 1;
    filters[3] = bounds;
  }
  if (minRating >= 4) {
    filters[4] = 8;
  }

  const uiState = sortOrder === 'prices' || minRating >= 4 || minPrice > 0 || maxPrice > 0 || amenities || classes
    ? [[[3], [3], [3], [3]], 1]
    : [[[3], [3]], 0];
  const searchBlock: unknown[] = [type, uiState];
  if (place && checkInTriplet && checkOutTriplet) {
    searchBlock[2] = [
      [null, [place], []],
      [null, [checkInTriplet, checkOutTriplet, nightsBetween(checkIn, checkOut)], null, null, null, [1]],
    ];
    searchBlock[3] = null;
    searchBlock[4] = filters;
  } else {
    searchBlock[2] = null;
    searchBlock[3] = null;
    searchBlock[4] = filters;
  }

  const control = place ? [1, null, null, 0, 0, null, 13, null, 0] : [0, null, null, 0, 0, null, null, null, 0];
  const payload: unknown[] = [destination, searchBlock, control];
  if (sortOrder === 'prices') payload[6] = ['prices'];
  return payload;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Params,
): { url: string; body: string } {
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('_reqid', String(Math.floor(Date.now() % 90_000_000) + 1_000_000));
  const outer = [[['AtySUc', JSON.stringify(buildPayload(params)), null, '1']]];
  return {
    url: nextUrl.toString(),
    body: `f.req=${encodeURIComponent(JSON.stringify(outer))}&`,
  };
}
