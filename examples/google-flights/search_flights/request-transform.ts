// Adapter around the shared FlightsFrontendService body builder.
// The tool exposes flat snake_case params (origin, destination, departure_date,
// max_stops, …); the shared encoder consumes a structured camelCase shape
// ({ tripType, legs:[{origin,dest,date,times,stops,alliances,carriers,duration}],
// maxPrice, bags }). We map between them here and delegate the byte-for-byte
// positional encoding to the shared module (required reuse).
import { transform as sharedTransform } from '../_shared/flights_request.ts';

type Params = Record<string, string | number | boolean | undefined | null>;

const ALLIANCES = new Set(['ONEWORLD', 'SKYTEAM', 'STAR_ALLIANCE']);

function mapTripType(v: unknown): number {
  if (v == null || v === '') return 1;
  if (typeof v === 'number') return v;
  const s = String(v).toLowerCase();
  if (s === 'one_way' || s === 'oneway' || s === '2') return 2;
  if (s === 'multi_city' || s === 'multicity' || s === '3') return 3;
  return 1; // round_trip
}

// User semantics (per likelyParam): 0=nonstop, 1=≤1 stop, 2=≤2 stops, 3=any.
// Google wire encoding: 1=nonstop, 2=≤1, 3=≤2, 0=any.
function mapStops(v: unknown): number {
  switch (Number(v)) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    default:
      return 0; // any (default / 3)
  }
}

// "6-23" -> [depMin, depMax, arrMin, arrMax]; arrival defaults to full day.
function parseTimes(v: unknown): number[] | null {
  if (v == null || v === '') return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), 0, 23];
}

function parseAirlines(v: unknown): { alliances: string[] | null; carriers: string[] | null } {
  if (v == null || v === '') return { alliances: null, carriers: null };
  const parts = String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const alliances = parts.filter((p) => ALLIANCES.has(p.toUpperCase())).map((p) => p.toUpperCase());
  const carriers = parts.filter((p) => !ALLIANCES.has(p.toUpperCase()));
  return {
    alliances: alliances.length ? alliances : null,
    carriers: carriers.length ? carriers : null,
  };
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildBootstrapQuery(params: Params): string {
  const origin = params.origin != null ? String(params.origin) : '';
  const destination = params.destination != null ? String(params.destination) : '';
  const departureDate = params.departure_date != null ? String(params.departure_date) : '';
  const tripType = String(params.trip_type ?? 'round_trip').toLowerCase();
  if (tripType === 'one_way' || tripType === 'oneway' || tripType === '2') {
    return `One way flights from ${origin} to ${destination} on ${departureDate}`;
  }
  if (params.return_date) {
    return `Round trip flights from ${origin} to ${destination} departing ${departureDate} returning ${params.return_date}`;
  }
  return `Flights from ${origin} to ${destination} on ${departureDate}`;
}

export function prepareParams(params?: Params): Params {
  const p: Params = params ?? {};
  return {
    ...p,
    bootstrap_query: buildBootstrapQuery(p),
  };
}

function hasNonDefaultFilters(params: Params): boolean {
  if (params.max_stops != null && params.max_stops !== '' && Number(params.max_stops) !== 3) {
    return true;
  }
  return Boolean(
    params.airlines ||
      num(params.max_price) ||
      params.outbound_times ||
      params.return_times ||
      num(params.max_duration) ||
      num(params.carry_on_bags),
  );
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Params,
  state?: Record<string, unknown>,
): { url: string; body: string } {
  const p: Params = params ?? {};
  const observedSearchBody =
    typeof state?.observed_search_body === 'string' ? state.observed_search_body : undefined;
  if (observedSearchBody && !hasNonDefaultFilters(p)) {
    return { url, body: observedSearchBody };
  }

  const tripType = mapTripType(p.trip_type);
  const stops = p.max_stops != null && p.max_stops !== '' ? mapStops(p.max_stops) : 0;
  const { alliances, carriers } = parseAirlines(p.airlines);
  const maxDur = num(p.max_duration);
  const duration = maxDur != null ? [maxDur] : null;

  const origin = p.origin != null ? String(p.origin) : '';
  const destination = p.destination != null ? String(p.destination) : '';

  const legs: any[] = [
    {
      origin,
      dest: destination,
      date: p.departure_date ? String(p.departure_date) : null,
      times: parseTimes(p.outbound_times),
      stops,
      alliances,
      carriers,
      duration,
    },
  ];

  // Append a return leg for round-trip / multi-city when a return date exists.
  if (tripType !== 2 && p.return_date) {
    legs.push({
      origin: destination,
      dest: origin,
      date: String(p.return_date),
      times: parseTimes(p.return_times),
      stops,
      alliances,
      carriers,
      duration,
    });
  }

  const carryOn = num(p.carry_on_bags);
  const mapped: Record<string, any> = {
    tripType,
    legs,
    maxPrice: num(p.max_price),
    // CONFIG[10] wire form is [1, <carry-on count>]; shared builder emits
    // [carryOn, checked], so map count -> checked slot, constant 1 -> first.
    bags: carryOn != null ? { carryOn: 1, checked: carryOn } : undefined,
    searchContextToken:
      typeof state?.search_context_token === 'string' ? state.search_context_token : undefined,
  };

  return sharedTransform(method, url, responses, mapped);
}
