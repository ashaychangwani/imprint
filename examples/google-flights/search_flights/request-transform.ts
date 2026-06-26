// Adapter around the shared FlightsFrontendService body builder.
// The tool exposes flat snake_case params (origin, destination, departure_date,
// max_stops, …); the shared encoder consumes a structured camelCase shape
// ({ tripType, legs:[{origin,dest,date,times,stops,includeAirlines,duration}],
// maxPrice, bags }). We map between them here and delegate the byte-for-byte
// positional encoding to the shared module (required reuse).
import { transform as sharedTransform } from '../_shared/flights_request.ts';

type Params = Record<string, string | number | boolean | undefined | null>;

function mapTripType(v: unknown): number {
  if (v == null || v === '') return 1;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
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

function parseAirlines(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  const includeAirlines = String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((p) => p.toUpperCase());
  return includeAirlines.length ? includeAirlines : null;
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Params,
): { url: string; body: string } {
  const p: Params = params ?? {};
  const requestedTripType = mapTripType(p.trip_type);
  const hasReturnDate = p.return_date != null && String(p.return_date).trim() !== '';
  const tripType = requestedTripType === 1 && !hasReturnDate ? 2 : requestedTripType;
  const stops = p.max_stops != null && p.max_stops !== '' ? mapStops(p.max_stops) : 0;
  const includeAirlines = parseAirlines(p.airlines);
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
      includeAirlines,
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
      includeAirlines,
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
  };

  return sharedTransform(method, url, responses, mapped);
}
