import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { FlightItinerary, FlightLeg } from '../_shared/google_flights_types.ts';

type AnyArray = unknown[];
type SelectedFlight = {
  origin: string;
  destination: string;
  date: string;
  carrier: string;
  flightNumber: string;
};

type SearchItinerary = FlightItinerary & {
  origin: string;
  destination: string;
  departure_date?: string;
  departure_time?: string;
  arrival_date?: string;
  arrival_time?: string;
  duration_minutes?: number;
  stops: number;
  layovers: Array<{ airport?: string; airport_name?: string; duration_minutes?: number }>;
  carriers: Array<{ code?: string; name?: string }>;
  segments: FlightLeg[];
  price?: number;
  currency?: string;
  itinerary_token: string;
  selection_token: string;
  selected_flights: string;
};

function isArray(value: unknown): value is AnyArray {
  return Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatDate(value: unknown): string | undefined {
  if (!isArray(value)) return undefined;
  const [year, month, day] = value;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatTime(value: unknown): string | undefined {
  if (!isArray(value)) return undefined;
  const hour = value[0];
  const minute = value[1] ?? 0;
  if (typeof hour !== 'number' || typeof minute !== 'number') return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseSegment(segment: AnyArray): FlightLeg | null {
  const origin = asString(segment[3]);
  const destination = asString(segment[6]);
  if (!origin || !destination) return null;
  const flight = isArray(segment[22]) ? segment[22] : [];
  return {
    origin,
    destination,
    departureDate: formatDate(segment[20]),
    departureTime: formatTime(segment[8]),
    arrivalDate: formatDate(segment[21]),
    arrivalTime: formatTime(segment[10]),
    airline: asString(flight[3]),
    carrierCode: asString(flight[0]),
    flightNumber: asString(flight[1]),
    durationMinutes: asNumber(segment[11]),
    stops: 0,
  };
}

function parseLayovers(value: unknown): Array<{ airport?: string; airport_name?: string; duration_minutes?: number }> {
  if (!isArray(value)) return [];
  return value
    .filter(isArray)
    .map((item) => ({
      duration_minutes: asNumber(item[0]),
      airport: asString(item[1]) ?? asString(item[2]),
      airport_name: asString(item[4]) ?? asString(item[6]),
    }))
    .filter((item) => item.airport || item.airport_name || item.duration_minutes !== undefined);
}

function normalizeSelectedFlight(value: unknown): SelectedFlight | null {
  if (Array.isArray(value)) {
    const [origin, date, destination, ignored, carrier, flightNumber] = value;
    void ignored;
    if (typeof origin === 'string' && typeof date === 'string' && typeof destination === 'string' && typeof carrier === 'string' && flightNumber != null) {
      return { origin, destination, date, carrier, flightNumber: String(flightNumber) };
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const origin = obj.origin;
    const destination = obj.destination;
    const date = obj.date ?? obj.departureDate;
    const carrier = obj.carrier ?? obj.carrierCode;
    const flightNumber = obj.flightNumber ?? obj.flight_number;
    if (typeof origin === 'string' && typeof destination === 'string' && typeof date === 'string' && typeof carrier === 'string' && flightNumber != null) {
      return { origin, destination, date, carrier, flightNumber: String(flightNumber) };
    }
  }
  return null;
}

function parsePriorSelectedFlights(raw: unknown): SelectedFlight[] {
  if (Array.isArray(raw)) return raw.map(normalizeSelectedFlight).filter((item): item is SelectedFlight => Boolean(item));
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return parsePriorSelectedFlights(JSON.parse(raw));
  } catch {
    return [];
  }
}

function selectedFlightsFromSegments(segments: FlightLeg[], priorSelectedFlights: SelectedFlight[]): string {
  const selected = segments
    .map((segment) => ({
      origin: segment.origin,
      destination: segment.destination,
      date: segment.departureDate ?? '',
      carrier: segment.carrierCode ?? '',
      flightNumber: segment.flightNumber ?? '',
    }))
    .filter((flight) => flight.origin && flight.destination && flight.date && flight.carrier && flight.flightNumber);
  return JSON.stringify([...priorSelectedFlights, ...selected]);
}

function looksLikeItinerary(value: AnyArray): boolean {
  const summary = value[0];
  const priceAndToken = value[1];
  return isArray(summary)
    && isArray(summary[2])
    && isArray(priceAndToken)
    && isArray(priceAndToken[0])
    && typeof priceAndToken[1] === 'string';
}

function parseItinerary(value: AnyArray, priorSelectedFlights: SelectedFlight[]): SearchItinerary | null {
  if (!looksLikeItinerary(value)) return null;
  const summary = value[0] as AnyArray;
  const priceAndToken = value[1] as AnyArray;
  const rawSegments = summary[2] as AnyArray;
  const segments = rawSegments.filter(isArray).map(parseSegment).filter((item): item is FlightLeg => item !== null);
  if (segments.length === 0) return null;

  const token = asString(priceAndToken[1]);
  if (!token) return null;
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const carrierCode = asString(summary[0]);
  const carrierNames = isArray(summary[1]) ? summary[1].filter((item): item is string => typeof item === 'string') : [];
  const amount = isArray(priceAndToken[0]) ? asNumber(priceAndToken[0][1]) : undefined;
  const selected_flights = selectedFlightsFromSegments(segments, priorSelectedFlights);

  return {
    origin: first.origin,
    destination: last.destination,
    departure_date: first.departureDate,
    departure_time: first.departureTime,
    arrival_date: last.arrivalDate,
    arrival_time: last.arrivalTime,
    duration_minutes: asNumber(summary[9]),
    stops: Math.max(0, segments.length - 1),
    layovers: parseLayovers(summary[13]),
    carriers: [{ code: carrierCode, name: carrierNames[0] }].filter((carrier) => carrier.code || carrier.name),
    legs: segments,
    segments,
    price: amount,
    currency: 'USD',
    itinerary_token: token,
    selection_token: token,
    selected_flights,
  };
}

function walk(value: unknown, visit: (array: AnyArray) => void): void {
  if (!isArray(value)) return;
  visit(value);
  for (const item of value) walk(item, visit);
}

function decode(rawResponse: unknown): { payloads: unknown[]; hadRecords: boolean } {
  if (typeof rawResponse !== 'string') return { payloads: [parseNestedPayload(rawResponse)], hadRecords: true };
  const records = extractWrbRecords(rawResponse);
  if (records.length === 0) return { payloads: [parseNestedPayload(rawResponse)], hadRecords: false };
  return { payloads: records.map((record) => parseNestedPayload(record.payload)), hadRecords: true };
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const { payloads: decodedPayloads, hadRecords } = decode(rawResponse);
  const itineraries: SearchItinerary[] = [];
  const seen = new Set<string>();
  const maxDuration = Number(context?.params?.max_duration_minutes ?? 0);
  const priorSelectedFlights = parsePriorSelectedFlights(context?.params?.selected_flights);

  for (const decoded of decodedPayloads) {
    walk(decoded, (array) => {
      const itinerary = parseItinerary(array, priorSelectedFlights);
      if (!itinerary) return;
      if (seen.has(itinerary.selection_token)) return;
      seen.add(itinerary.selection_token);
      if (Number.isFinite(maxDuration) && maxDuration > 0 && (itinerary.duration_minutes ?? 0) > maxDuration) return;
      itineraries.push(itinerary);
    });
  }

  if (typeof rawResponse === 'string' && !hadRecords) {
    throw new Error('Google Flights GetShoppingResults response did not contain a batchexecute payload');
  }

  if (itineraries.length === 0) {
    throw new Error('Google Flights GetShoppingResults payload did not contain recognizable itineraries');
  }

  return {
    query: context?.params ?? {},
    count: itineraries.length,
    itineraries,
  };
}
