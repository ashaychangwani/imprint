type Params = Record<string, string | number | boolean>;

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Params,
): { url: string; body?: string } {
  const p = params ?? {};
  const destination = stringParam(p.destination, 'tahoe city');
  const propertyType = stringParam(p.property_type, 'vacation_rentals');
  const checkIn = parseDate(stringParam(p.check_in_date, '2026-08-09'));
  const checkOut = parseDate(stringParam(p.check_out_date, '2026-08-16'));
  const hotelToken = stringParam(p.hotel_token, '');
  const isVacationRental = propertyType === 'vacation_rentals' || propertyType === 'vacation rental';

  const placeId = isVacationRental ? '0x809bd62ecf1fa721:0x2a98b230816c9ed1' : null;
  const placeMid = isVacationRental ? '/m/0gyvmkl' : '/m/0gz469';
  const placeLabel = isVacationRental ? 'Tahoe City' : 'Chicago Loop';
  const propertyCode = isVacationRental ? 2 : 1;
  const occupancy = isVacationRental ? [0] : [1];
  const stayLength = diffDays(checkIn, checkOut);

  const payload = [
    destination,
    [
      propertyCode,
      isVacationRental ? [[[3], [3], [3], [3]], 1] : [[[3], [3]], 0],
      [
        [null, [[placeMid, null, null, null, null, placeId, placeLabel]].map(trimTrailingNulls), isVacationRental ? undefined : []].filter((v) => v !== undefined),
        [null, [checkIn, checkOut, stayLength], null, null, null, occupancy],
      ],
      null,
      [[null, null, null, null, null, null, 'USD'], null, []],
    ],
    [propertyCode === 1 ? 1 : 0, null, null, 0, 0, hotelToken || null, 13, null, 0],
    null,
    1,
  ];

  const fReq = [[["AtySUc", JSON.stringify(payload), null, "1"]]];
  return { url, body: `f.req=${encodeURIComponent(JSON.stringify(fReq))}&` };
}

function stringParam(value: string | number | boolean | undefined, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function parseDate(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Expected date in YYYY-MM-DD format, got ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function diffDays(start: [number, number, number], end: [number, number, number]): number {
  const startDate = Date.UTC(start[0], start[1] - 1, start[2]);
  const endDate = Date.UTC(end[0], end[1] - 1, end[2]);
  return Math.max(1, Math.round((endDate - startDate) / 86_400_000));
}

function trimTrailingNulls(values: unknown[]): unknown[] {
  const out = [...values];
  while (out.length > 0 && out[out.length - 1] == null) out.pop();
  return out;
}
