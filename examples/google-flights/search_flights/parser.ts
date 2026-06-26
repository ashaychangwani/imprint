// Parser for Google Flights GetShoppingResults (batchexecute RPC).
// Decodes the envelope with the shared helper, then walks the deeply-nested
// positional payload to find itinerary records and normalize them.
import { decodeBatchExecute, extractRpcPayload } from '../_shared/batchexecute.ts';

interface Itinerary {
  airlines: string[];
  flightNumbers: string[];
  origin: string;
  destination: string;
  departDate: string | null;
  departTime: string | null;
  arriveDate: string | null;
  arriveTime: string | null;
  durationMinutes: number | null;
  stops: number;
  priceUSD: number | null;
  co2Grams: number | null;
  flight_token: string;
}

interface AirlineFilter {
  code: string;
  name: string;
}

const AIRPORT = /^[A-Z]{3}$/;
const ALLIANCE_CODES = new Set(['ONEWORLD', 'SKYTEAM', 'STAR_ALLIANCE']);

// A leg is [carrierCode, [carrierNames], [segments], originIATA, [departDate],
// [departTime], destIATA, [arriveDate], [arriveTime], durationMinutes, ...].
function isLeg(leg: unknown): leg is unknown[] {
  if (!Array.isArray(leg)) return false;
  return (
    typeof leg[0] === 'string' &&
    Array.isArray(leg[1]) &&
    typeof leg[3] === 'string' &&
    AIRPORT.test(leg[3] as string) &&
    typeof leg[6] === 'string' &&
    AIRPORT.test(leg[6] as string)
  );
}

// node[0] is either a single leg or an array of legs; node[1] is
// [[null, <priceUSD>], "<base64 flight token>"].
function legsOf(node: unknown[]): unknown[][] {
  const head = node[0];
  if (isLeg(head)) return [head as unknown[]];
  if (Array.isArray(head)) return head.filter(isLeg) as unknown[][];
  return [];
}

function isItinerary(node: unknown): node is unknown[] {
  if (!Array.isArray(node)) return false;
  if (legsOf(node).length === 0) return false;
  const priceTok = node[1];
  if (!Array.isArray(priceTok)) return false;
  const priceArr = priceTok[0];
  const token = priceTok[1];
  if (!Array.isArray(priceArr)) return false;
  if (typeof token !== 'string' || token.length < 20) return false;
  return true;
}

function fmtTime(t: unknown): string | null {
  if (!Array.isArray(t) || t.length === 0) return null;
  const h = typeof t[0] === 'number' ? t[0] : 0;
  const m = typeof t[1] === 'number' ? t[1] : 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDate(d: unknown): string | null {
  if (!Array.isArray(d) || d.length < 3) return null;
  const [y, mo, day] = d as number[];
  if (typeof y !== 'number') return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function walk(node: unknown, found: unknown[][]): void {
  if (!Array.isArray(node)) return;
  if (isItinerary(node)) {
    found.push(node);
    return; // don't recurse into a matched itinerary
  }
  for (const child of node) walk(child, found);
}

function isPairList(node: unknown): node is string[][] {
  return (
    Array.isArray(node) &&
    node.length > 0 &&
    node.every(
      (item) =>
        Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string',
    )
  );
}

function toFilters(pairs: string[][]): AirlineFilter[] {
  return pairs.map((pair) => ({ code: pair[0] as string, name: pair[1] as string }));
}

function collectAirlineFilters(
  node: unknown,
  found: { alliances: AirlineFilter[]; carriers: AirlineFilter[] },
): void {
  if (!Array.isArray(node)) return;
  if (
    node.length >= 2 &&
    isPairList(node[0]) &&
    isPairList(node[1]) &&
    node[0].some((pair) => ALLIANCE_CODES.has(pair[0] as string))
  ) {
    found.alliances = toFilters(node[0]);
    found.carriers = toFilters(node[1]);
  }
  for (const child of node) collectAirlineFilters(child, found);
}

function normalize(it: unknown[]): Itinerary {
  const legs = legsOf(it);
  const priceTok = it[1] as unknown[];
  const priceArr = priceTok[0] as unknown[];
  const token = priceTok[1] as string;

  const airlines = new Set<string>();
  const flightNumbers: string[] = [];
  let durationMinutes = 0;
  let stops = 0;
  let co2 = 0;

  for (const leg of legs) {
    const names = leg[1];
    if (Array.isArray(names)) {
      for (const n of names) if (typeof n === 'string') airlines.add(n);
    }
    if (typeof leg[9] === 'number') durationMinutes += leg[9] as number;
    const segs = leg[2];
    if (Array.isArray(segs)) {
      stops += Math.max(0, segs.length - 1);
      for (const seg of segs) {
        if (!Array.isArray(seg)) continue;
        const fn = seg[22];
        if (Array.isArray(fn) && typeof fn[0] === 'string' && fn[1] != null) {
          flightNumbers.push(`${fn[0]}${fn[1]}`);
          if (typeof fn[3] === 'string') airlines.add(fn[3]);
        }
        // best-effort CO2 (grams): large numeric near the end of the segment.
        const cand = seg[seg.length - 2];
        if (typeof cand === 'number' && cand > 1000 && cand < 10_000_000) co2 += cand;
      }
    }
  }

  const firstLeg = legs[0] ?? [];
  const lastLeg = legs[legs.length - 1] ?? [];
  const price = priceArr.find((v) => typeof v === 'number') as number | undefined;

  return {
    airlines: [...airlines],
    flightNumbers,
    origin: typeof firstLeg[3] === 'string' ? (firstLeg[3] as string) : '',
    destination: typeof lastLeg[6] === 'string' ? (lastLeg[6] as string) : '',
    departDate: fmtDate(firstLeg[4]),
    departTime: fmtTime(firstLeg[5]),
    arriveDate: fmtDate(lastLeg[7]),
    arriveTime: fmtTime(lastLeg[8]),
    durationMinutes: durationMinutes || null,
    stops,
    priceUSD: price ?? null,
    co2Grams: co2 || null,
    flight_token: token,
  };
}

export function extract(
  rawResponse: unknown,
  _context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  let payload: unknown;
  if (typeof rawResponse === 'string') {
    payload =
      extractRpcPayload(rawResponse, 'GetShoppingResults') ?? extractRpcPayload(rawResponse);
    if (payload == null) {
      const frames = decodeBatchExecute(rawResponse);
      payload = frames[0]?.payload;
    }
    if (payload == null) {
      throw new Error(
        'Google Flights GetShoppingResults response did not contain a batchexecute payload',
      );
    }
  } else {
    payload = rawResponse;
  }

  const found: unknown[][] = [];
  if (payload != null) walk(payload, found);
  const availableAirlineFilters = {
    alliances: [] as AirlineFilter[],
    carriers: [] as AirlineFilter[],
  };
  if (payload != null) collectAirlineFilters(payload, availableAirlineFilters);

  const byToken = new Map<string, Itinerary>();
  for (const it of found) {
    const norm = normalize(it);
    if (!norm.flight_token) continue;
    if (!byToken.has(norm.flight_token)) byToken.set(norm.flight_token, norm);
  }

  const itineraries = [...byToken.values()];
  if (itineraries.length === 0) {
    throw new Error(
      'Google Flights GetShoppingResults payload did not contain recognizable itineraries',
    );
  }
  return {
    count: itineraries.length,
    itineraries,
    resultScope: {
      exhaustive: false,
      note:
        'Google Flights GetShoppingResults returns a limited sorted subset. A carrier can be available in availableAirlineFilters without appearing in itineraries; call search_flights again with airlines=<code> to fetch that carrier.',
    },
    availableAirlineFilters,
  };
}
