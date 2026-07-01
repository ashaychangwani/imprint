import { transform as sharedTransform } from '../_shared/google_flights_transport.ts';
import { extract as extractSearchResults } from '../search_flights/parser.ts';

type SegmentTuple = [string, string, string, null, string, string];
type SegmentGroup = SegmentTuple[];

const BOOKING_ENDPOINT = 'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetBookingResults';
const SHOPPING_ENDPOINT = 'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults';
const ROUND_TRIP_TYPE = 1;
const ONE_WAY_TRIP_TYPE = 2;
const MULTI_CITY_TRIP_TYPE = 3;

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
    const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length % 5 !== 0) return [];
    const out: SegmentTuple[] = [];
    for (let i = 0; i < parts.length; i += 5) {
      const carrier = parts[i];
      const flightNumber = parts[i + 1];
      const date = parts[i + 2];
      const origin = parts[i + 3];
      const destination = parts[i + 4];
      if (!carrier || !flightNumber || !date || !origin || !destination) continue;
      out.push([origin, date, destination, null, carrier, flightNumber]);
    }
    return out;
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

function groupSelectedSegments(segments: SegmentTuple[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
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

function airportRef(code: string) {
  const type = code.startsWith('/m/') ? 5 : 0;
  return [[[code, type]]];
}

function routeLegEndpoints(group: SegmentGroup): { origin: string; date: string; destination: string } {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  return { origin: first[0], date: first[1], destination: last[2] };
}

function searchLeg(group: SegmentGroup, selected = false) {
  const { origin, date, destination } = routeLegEndpoints(group);
  return [airportRef(origin), airportRef(destination), null, 0, null, null, date, null, selected ? group : null, null, null, null, null, null, 1];
}

function tripTypeForGroups(groups: SegmentGroup[]): number {
  if (groups.length <= 1) return ONE_WAY_TRIP_TYPE;
  const first = routeLegEndpoints(groups[0]!);
  const second = routeLegEndpoints(groups[1]!);
  if (
    groups.length === 2
    && sameCode(first.origin, second.destination)
    && sameCode(first.destination, second.origin)
  ) {
    return ROUND_TRIP_TYPE;
  }
  return MULTI_CITY_TRIP_TYPE;
}

function legCriteria(group: SegmentGroup, index: number, tripType: number) {
  const { origin, date, destination } = routeLegEndpoints(group);
  const legKind = tripType === ONE_WAY_TRIP_TYPE || (tripType === ROUND_TRIP_TYPE && index === 0) ? 3 : 1;
  return [airportRef(origin), airportRef(destination), null, 0, null, null, date, null, group, null, null, null, null, null, legKind];
}

function tokenFromSearchResponse(rawResponse: unknown, params: Record<string, unknown>, targetIndex: number): string {
  const requestedGroups = groupSelectedSegments(parseSelectedFlights(params.selected_flights));
  if (requestedGroups.length === 0) throw new Error('selected_flights must be a JSON array of selected flight segment tuples');
  const target = requestedGroups[Math.min(Math.max(targetIndex, 0), requestedGroups.length - 1)]!;

  const searchData = extractSearchResults(rawResponse, { params: {}, responses: [] }) as {
    itineraries?: Array<{ selected_flights?: unknown; selection_token?: unknown }>;
  };
  const itineraries = Array.isArray(searchData?.itineraries) ? searchData.itineraries : [];

  for (const itinerary of itineraries) {
    const candidateGroups = groupSelectedSegments(parseSelectedFlights(itinerary.selected_flights));
    const candidate = candidateGroups.length === 1 ? candidateGroups[0]! : [];
    if (
      sameSelectedFlights(target, candidate)
      && typeof itinerary.selection_token === 'string'
      && itinerary.selection_token
    ) {
      return itinerary.selection_token;
    }
  }

  if (requestedGroups.length === 1) {
    const fallback = itineraries.find((itinerary) => typeof itinerary.selection_token === 'string' && itinerary.selection_token)?.selection_token;
    if (typeof fallback === 'string' && fallback) return fallback;
  }
  throw new Error(`Unable to mint a fresh booking selection token for selected_flights segment ${targetIndex + 1}`);
}

function buildShoppingInner(params: Record<string, unknown>, responses: unknown[]) {
  const groups = groupSelectedSegments(parseSelectedFlights(params.selected_flights));
  if (groups.length === 0) throw new Error('selected_flights must be a JSON array of selected flight segment tuples');
  const tripType = tripTypeForGroups(groups);
  const selectedPrefixCount = Math.min(responses.length, Math.max(0, groups.length - 1));
  const searchLegs = groups.map((group, index) => searchLeg(group, index < selectedPrefixCount));
  if (tripType === ONE_WAY_TRIP_TYPE) {
    searchLegs[0]![14] = 3;
  }
  const filters = [null, null, tripType, null, [], 1, [1, 0, 0, 0], null, null, null, null, null, null, searchLegs, null, null, null, 1];
  if (selectedPrefixCount === 0) return [[], filters, 0, 0, 0, 1];
  const selectionToken = tokenFromSearchResponse(responses[responses.length - 1], params, selectedPrefixCount - 1);
  return [[null, selectionToken], filters, 0, 0, 0, 1];
}

function sameSegment(left: SegmentTuple, right: SegmentTuple): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[4] === right[4] && left[5] === right[5];
}

function sameSelectedFlights(requested: SegmentTuple[], candidate: SegmentTuple[], allowPrefix = false): boolean {
  if (requested.length === 0 || candidate.length === 0) return false;
  if (allowPrefix) {
    if (candidate.length > requested.length) return false;
    return candidate.every((segment, index) => sameSegment(segment, requested[index]!));
  }
  if (requested.length !== candidate.length) return false;
  return requested.every((segment, index) => sameSegment(segment, candidate[index]!));
}

function buildBookingInner(params: Record<string, unknown>, responses: unknown[]) {
  const groups = groupSelectedSegments(parseSelectedFlights(params.selected_flights));
  if (groups.length === 0) throw new Error('selected_flights must be a JSON array of selected flight segment tuples');
  const tokenSource = responses[responses.length - 1];
  const selectionToken = tokenFromSearchResponse(tokenSource, params, groups.length - 1);
  const tripType = tripTypeForGroups(groups);
  const criteria = [null, null, tripType, null, [], 1, [1, 0, 0, 0], null, null, null, null, null, null, groups.map((group, index) => legCriteria(group, index, tripType)), null, null, null, 1];
  const selectedOptionIndex = Number(params.selected_option_index ?? 0);
  return [[null, selectionToken], criteria, null, Number.isFinite(selectedOptionIndex) ? selectedOptionIndex : 0];
}

export function transform(method: string, url: string, responses: unknown[], params?: Record<string, unknown>): { url: string; body: string; headers: Record<string, string> } {
  const requestParams = params ?? {};
  const isShoppingRequest = (url || '').includes('/GetShoppingResults');
  const inner = isShoppingRequest ? buildShoppingInner(requestParams, responses) : buildBookingInner(requestParams, responses);
  const endpoint = isShoppingRequest ? SHOPPING_ENDPOINT : BOOKING_ENDPOINT;
  return sharedTransform(method, url || endpoint, responses, {
    fReq: [null, JSON.stringify(inner)],
    rpcid: isShoppingRequest ? 'GetShoppingResults' : 'GetBookingResults',
    sourcePath: isShoppingRequest ? '/travel/flights' : '/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetBookingResults',
    referer: isShoppingRequest ? 'https://www.google.com/travel/flights/search' : 'https://www.google.com/travel/flights/booking',
    headers: {
      'sec-ch-ua-full-version': '"148.0.7778.96"',
      'x-goog-ext-259736195-jspb': '["en-US","US","USD",2,null,[420],null,null,7,[]]',
    },
    params: requestParams,
  });
}
