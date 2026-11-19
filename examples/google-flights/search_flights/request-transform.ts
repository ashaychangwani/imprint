type Params = Record<string, string | number | boolean>;
type TripType = 'one_way';

const numberParam = (
  params: Params,
  name: string,
  fallback: number,
  options: { integer?: boolean; min?: number } = {},
): number => {
  const raw = params[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isFinite(value) ||
    (options.integer && !Number.isInteger(value)) ||
    (options.min !== undefined && value < options.min)
  ) {
    const integer = options.integer ? ' integer' : '';
    const minimum = options.min !== undefined ? ` greater than or equal to ${options.min}` : '';
    throw new Error(`${name} must be a finite${integer}${minimum}`);
  }
  return value;
};

const csv = (value: unknown): string[] =>
  typeof value === 'string' && value.trim()
    ? value.split(',').map((part) => part.trim()).filter(Boolean)
    : [];

function parseLegs(value: unknown): Array<{ origin: string; destination: string; date: string }> {
  if (typeof value !== 'string') {
    throw new Error('legs must be a semicolon-separated origin,destination,date string');
  }
  return value.split(';').filter(Boolean).map((part) => {
    const [origin, destination, date] = part.split(',').map((item) => item.trim());
    if (!origin || !destination || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      throw new Error('Each leg must be origin,destination,YYYY-MM-DD');
    }
    const [year, month, day] = date!.split('-').map(Number);
    const normalized = new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10);
    if (normalized !== date) throw new Error('Each leg date must be a real calendar date');
    return { origin, destination, date: date as string };
  });
}

function normalizeTripType(value: unknown): TripType {
  const normalized = String(value ?? 'one_way').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'one_way' || normalized === 'oneway' || normalized === '2') return 'one_way';
  throw new Error('Only one_way trip_type is supported by this emitted search tool');
}

const place = (value: string): unknown[] => [[[value, value.startsWith('/m/') ? 5 : 0]]];

function timeRange(value: unknown): number[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const hours = value.split(/[,:-]/).map(Number);
  if (hours.length !== 4 || hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new Error('Time range must have four integer hours from 0 through 23');
  }
  return hours;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params: Params = {},
): { url: string; body: string } {
  const legs = parseLegs(params.legs);
  if (legs.length === 0) throw new Error('At least one leg is required');

  normalizeTripType(params.trip_type);
  if (legs.length !== 1) throw new Error('one_way requires exactly one leg');
  const tripCode = 2;

  const cabinClass = String(params.cabin_class ?? 'economy');
  if (cabinClass !== 'economy') throw new Error('Only economy cabin_class is supported by the recording');
  const adults = numberParam(params, 'adults', 1, { integer: true, min: 1 });
  const children = numberParam(params, 'children', 0, { integer: true, min: 0 });
  const carryOnBags = numberParam(params, 'carry_on_bags', 0, { integer: true, min: 0 });
  if (carryOnBags !== 0) throw new Error('Only carry_on_bags=0 is supported by the recording');
  numberParam(params, 'max_price', 0, { min: 0 });

  const allianceCodes = csv(params.alliances).map((value) => value.toUpperCase());
  const validAlliances = new Set(['ONEWORLD', 'SKYTEAM', 'STAR_ALLIANCE']);
  if (allianceCodes.some((value) => !validAlliances.has(value))) {
    throw new Error('alliances must contain only ONEWORLD, SKYTEAM, or STAR_ALLIANCE');
  }
  const includedCarriers = [...csv(params.airlines).map((value) => value.toUpperCase()), ...allianceCodes];
  const outboundRange = timeRange(params.outbound_time_range);
  const maxStops = numberParam(params, 'max_stops', 0, { integer: true, min: 0 });
  const maxDuration = numberParam(params, 'max_duration_minutes', 0, {
    integer: true,
    min: 0,
  });
  const legDefinitions = legs.map((leg) => [
    place(leg.origin),
    place(leg.destination),
    outboundRange,
    maxStops,
    includedCarriers.length ? includedCarriers : null,
    null,
    leg.date,
    maxDuration > 0 ? [maxDuration] : null,
    null, null, null, null, null, null,
    3,
  ]);

  const sortCodes: Record<string, number> = {
    best: 1,
    price: 2,
    departure_time: 3,
    arrival_time: 4,
    duration: 5,
  };
  const sortOrder = String(params.sort_order ?? 'best');
  if (!(sortOrder in sortCodes)) {
    throw new Error('sort_order must be best, price, departure_time, arrival_time, or duration');
  }
  const search = [
    null, null, tripCode, null, [], 1,
    [
      adults,
      children,
      0,
      0,
    ],
    null,
    null, null, null, null, null,
    legDefinitions,
    null, null, null,
    sortCodes[sortOrder],
  ];
  return {
    url,
    body: `f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify([[], search, 0, 0, 0, 1])]))}&`,
  };
}
