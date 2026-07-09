type Params = Record<string, string | number | boolean>;

function dateTuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (typeof value !== 'string') return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return fallback;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function priceDisplayCode(value: unknown): number {
  if (value === 'stay_total' || value === 'total') return 2;
  return 1;
}

function buildRpc(params: Params): string {
  const currency = stringParam(params.currency, 'USD');
  const checkIn = dateTuple(params.check_in_date, [2026, 8, 3]);
  const checkOut = dateTuple(params.check_out_date, [2026, 8, 6]);
  const adults = numberParam(params.adults, 3);
  const children = numberParam(params.children, 1);
  const hotelToken = stringParam(params.hotel_token, '');
  const pageToken = stringParam(params.page_token, '');
  const displayMode = priceDisplayCode(params.price_display);

  const payload = [
    null,
    [
      null,
      null,
      null,
      currency,
      [checkIn, checkOut, adults, children],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [displayMode, null, 0],
      null,
      null,
      null,
      null,
      ['/m/0gz469', 'Chicago Loop'],
    ],
    [1, pageToken || null, pageToken ? 2 : 1],
    hotelToken,
    [null, null, null, null, null, null, 1, null, 2, null, null, null, null, ['0x880e2cbb24a58c1f:0x469c0c8118eb74b2']],
    1,
    2,
  ];

  return JSON.stringify([[["M0CRd", JSON.stringify(payload), null, "generic"]]]);
}

export function transform(_method: string, url: string, _responses: unknown[], params?: Params): { url: string; body?: string } {
  const input = params ?? {};
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('rpcids', 'M0CRd');
  nextUrl.searchParams.set('hl', 'en-US');
  nextUrl.searchParams.set('rt', 'c');
  nextUrl.searchParams.set('_reqid', '3552256');
  return {
    url: nextUrl.toString(),
    body: `f.req=${encodeURIComponent(buildRpc(input))}&`,
  };
}
