import { transform as transportTransform } from '../_shared/google_flights_transport.ts';

type Params = Record<string, string | number | boolean>;

type MultiCityLeg = { origin: string; destination: string; date: string };
type SegmentTuple = [string, string, string, null, string, string];

function asString(params: Params | undefined, key: string, fallback = ''): string {
  const value = params?.[key];
  return value === undefined || value === null ? fallback : String(value);
}

function asNumber(params: Params | undefined, key: string, fallback: number): number {
  const value = params?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function location(value: string): [string, number] {
  const trimmed = value.trim();
  if (trimmed.startsWith('/m/')) return [trimmed, 5];
  return [trimmed.toUpperCase(), 0];
}

function locGroup(value: string): [[[string, number]]] {
  return [[location(value)]];
}

function tripTypeCode(value: string): number {
  switch (value.trim().toLowerCase()) {
    case 'one_way':
    case 'one-way':
    case 'one way':
    case '2':
      return 2;
    case 'multi_city':
    case 'multi-city':
    case 'multi city':
    case '3':
      return 3;
    case 'round_trip':
    case 'round-trip':
    case 'round trip':
    case '1':
    default:
      return 1;
  }
}

function stopCode(value: string): number {
  switch (value.trim().toLowerCase()) {
    case 'nonstop_only':
    case 'nonstop':
    case 'non_stop':
      return 1;
    case 'one_stop_or_fewer':
    case 'one stop or fewer':
      return 2;
    case 'two_stops_or_fewer':
    case 'two stops or fewer':
      return 3;
    case 'any':
    default:
      return 0;
  }
}

function parseTimeRange(value: string): [number, number] | null {
  const match = value.trim().match(/^(\d{1,2})(?::\d{2})?-(\d{1,2})(?::\d{2})?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [start, end];
}

function airlineList(value: string): string[] | null {
  const items = value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function normalizeSegment(value: unknown): SegmentTuple | null {
  if (Array.isArray(value)) {
    const [origin, date, destination, ignored, carrier, flightNumber] = value;
    if (typeof origin === 'string' && typeof date === 'string' && typeof destination === 'string' && typeof carrier === 'string' && String(flightNumber)) {
      return [origin, date, destination, ignored === null ? null : null, carrier, String(flightNumber)];
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const origin = obj.origin;
    const date = obj.date ?? obj.departureDate;
    const destination = obj.destination;
    const carrier = obj.carrier ?? obj.carrierCode;
    const flightNumber = obj.flightNumber ?? obj.flight_number;
    if (typeof origin === 'string' && typeof date === 'string' && typeof destination === 'string' && typeof carrier === 'string' && flightNumber != null) {
      return [origin, date, destination, null, carrier, String(flightNumber)];
    }
  }
  return null;
}

function parseSelectedFlights(raw: unknown): SegmentTuple[] {
  if (Array.isArray(raw)) return raw.map(normalizeSegment).filter((item): item is SegmentTuple => Boolean(item));
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return parseSelectedFlights(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

function sameCode(left: string, right: string): boolean {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

function dateDeltaDays(left: string, right: string): number | null {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.round((rightTime - leftTime) / 86_400_000);
}

function groupSelectedSegments(segments: SegmentTuple[]): SegmentTuple[][] {
  const groups: SegmentTuple[][] = [];
  for (const segment of segments) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    const startsReturnToGroupOrigin = current ? sameCode(segment[2], current[0]![0]) : false;
    const dateDelta = previous ? dateDeltaDays(previous[1], segment[1]) : null;
    const continuesConnection = previous
      && sameCode(segment[0], previous[2])
      && (dateDelta === null || (dateDelta >= 0 && dateDelta <= 1))
      && !startsReturnToGroupOrigin;
    if (current && continuesConnection) {
      current.push(segment);
    } else {
      groups.push([segment]);
    }
  }
  return groups;
}

function leg(
  origin: string,
  destination: string,
  date: string,
  stops: number,
  airlines: string[] | null,
  timeRange: [number, number] | null,
  bags: number,
  legFlag = 3,
  selectedSegments: SegmentTuple[] | null = null,
): unknown[] {
  return [
    locGroup(origin),
    locGroup(destination),
    timeRange,
    stops,
    airlines,
    null,
    date,
    bags > 0 ? [bags * 90] : null,
    selectedSegments,
    null,
    null,
    null,
    null,
    null,
    stops || airlines || timeRange || bags > 0 ? 1 : legFlag,
  ];
}

function parseMultiCityLegs(value: string): MultiCityLeg[] {
  const legs: MultiCityLeg[] = [];
  for (const part of value.split(';').map((item) => item.trim()).filter(Boolean)) {
    const [origin, destination, date] = part.split(',').map((item) => item.trim());
    if (origin && destination && date) legs.push({ origin, destination, date });
  }
  return legs;
}

function buildInner(params?: Params): unknown[] {
  const itinerary = asString(params, 'itinerary', '');
  let tripCode = itinerary.trim() ? 3 : tripTypeCode(asString(params, 'trip_type', 'round_trip'));
  if (tripCode === 1 && !asString(params, 'return_date', '').trim()) tripCode = 2;
  const adults = Math.max(1, asNumber(params, 'adults', 1));
  const bags = Math.max(0, asNumber(params, 'bags', 0));
  const stops = stopCode(asString(params, 'stops', 'any'));
  const airlines = airlineList(asString(params, 'airlines', ''));
  const maxPrice = asNumber(params, 'max_price', 0);
  const maxDuration = asNumber(params, 'max_duration_minutes', 0);
  const outboundTimeRange = parseTimeRange(asString(params, 'outbound_time_range', ''));
  const returnTimeRange = parseTimeRange(asString(params, 'return_time_range', ''));
  const selectedFlightGroups = groupSelectedSegments(parseSelectedFlights(params?.selected_flights));
  const selectionToken = asString(params, 'selection_token', '');

  let legs: unknown[];
  if (tripCode === 3) {
    const parsedLegs = parseMultiCityLegs(itinerary);
    const sourceLegs = parsedLegs.length > 0
      ? parsedLegs
      : [{ origin: asString(params, 'origin', 'SJC'), destination: asString(params, 'destination', 'SAN'), date: asString(params, 'departure_date', '2026-07-12') }];
    legs = sourceLegs.map((item, index) => {
      const selectedSegments = selectedFlightGroups[index];
      return leg(item.origin, item.destination, item.date, stops, airlines, outboundTimeRange, bags, 1, selectedSegments ?? null);
    });
  } else {
    const origin = asString(params, 'origin', 'SJC');
    const destination = asString(params, 'destination', 'SAN');
    const departureDate = asString(params, 'departure_date', '2026-07-12');
    legs = [leg(origin, destination, departureDate, stops, airlines, outboundTimeRange, bags, 3)];
    if (tripCode === 1) {
      const returnDate = asString(params, 'return_date', '2026-07-16');
      legs.push(leg(destination, origin, returnDate, stops, airlines, returnTimeRange, bags, 1));
    }
  }

  const filters = [
    null,
    null,
    tripCode,
    null,
    [],
    adults,
    [adults, 0, 0, 0],
    maxPrice > 0 ? [null, maxPrice] : null,
    null,
    null,
    maxDuration > 0 ? [1, 1] : null,
    null,
    null,
    legs,
    null,
    null,
    null,
    1,
  ];

  if (selectionToken && selectedFlightGroups.length > 0) return [[null, selectionToken], filters, 0, 0, 0, 1];
  return [[], filters, 0, 0, 0, 1];
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: Params,
): { url: string; body: string; headers: Record<string, string> } {
  return transportTransform(method, url, responses, {
    fReq: [null, JSON.stringify(buildInner(params))],
    sourcePath: '/travel/flights',
    referer: 'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTA2LTA4agcIARIDU0pDcgcIARIDU0FOGh4SCjIwMjYtMDYtMTFqBwgBEgNTQU5yBwgBEgNTSkNAAUgBcAGCAQsI____________AZgBAQ',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua-full-version': '"148.0.7778.96"',
      'x-goog-ext-259736195-jspb': '["en-US","US","USD",2,null,[420],null,null,7,[]]',
    },
  }) as { url: string; body: string; headers: Record<string, string> };
}
