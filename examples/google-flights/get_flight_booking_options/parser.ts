import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { BookingOption, FlightLeg } from '../_shared/google_flights_types.ts';

type JsonArray = unknown[];

type Output = {
  selectedItinerary: {
    legs: FlightLeg[];
    carriers: string[];
  };
  bookingOptions: BookingOption[];
  warnings?: string[];
};

function isArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatDate(value: unknown): string | undefined {
  if (!isArray(value) || value.length < 3) return undefined;
  const [year, month, day] = value.map(Number);
  if (!year || !month || !day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatTime(value: unknown): string | undefined {
  if (!isArray(value) || value.length === 0) return undefined;
  const hour = Number(value[0]);
  const minute = Number(value[1] ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function walk(value: unknown, visit: (node: JsonArray) => void): void {
  if (!isArray(value)) return;
  visit(value);
  for (const child of value) walk(child, visit);
}

function looksLikeCarrierGroup(node: JsonArray): boolean {
  return typeof node[0] === 'string' && isArray(node[1]) && isArray(node[2]) && node[2].some((segment) => isArray(segment) && typeof segment[3] === 'string' && typeof segment[6] === 'string');
}

function legFromSegment(segment: JsonArray, fallbackAirline?: string): FlightLeg | null {
  const origin = asString(segment[3]);
  const destination = asString(segment[6]);
  if (!origin || !destination) return null;
  const marketing = isArray(segment[22]) ? segment[22] : [];
  const operating = isArray(segment[15]) && isArray(segment[15][0]) ? segment[15][0] as JsonArray : [];
  return {
    origin,
    destination,
    departureDate: formatDate(segment[20]),
    departureTime: formatTime(segment[8]),
    arrivalDate: formatDate(segment[21]),
    arrivalTime: formatTime(segment[10]),
    airline: asString(marketing[3]) ?? fallbackAirline,
    carrierCode: asString(marketing[0]) ?? asString(operating[0]),
    flightNumber: asString(marketing[1]) ?? asString(operating[1]),
    durationMinutes: asNumber(segment[11]),
  };
}

function collectLegs(payloads: unknown[]): FlightLeg[] {
  const seen = new Set<string>();
  const legs: FlightLeg[] = [];
  for (const payload of payloads) {
    walk(payload, (node) => {
      if (!looksLikeCarrierGroup(node)) return;
      const airline = isArray(node[1]) ? asString(node[1][0]) : undefined;
      for (const segment of node[2] as JsonArray[]) {
        if (!isArray(segment)) continue;
        const leg = legFromSegment(segment, airline);
        if (!leg) continue;
        const key = [leg.origin, leg.destination, leg.departureDate, leg.carrierCode, leg.flightNumber].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        legs.push(leg);
      }
    });
  }
  return legs;
}

function providerFromOption(option: JsonArray): string | undefined {
  const providerGroup = isArray(option[1]) && isArray(option[1][0]) ? option[1][0] as JsonArray : undefined;
  if (!providerGroup) return undefined;
  return asString(providerGroup[1]) ?? asString(providerGroup[0]);
}

function codeFromProvider(option: JsonArray): string | undefined {
  const providerGroup = isArray(option[1]) && isArray(option[1][0]) ? option[1][0] as JsonArray : undefined;
  return providerGroup ? asString(providerGroup[0]) : undefined;
}

function priceFromOption(option: JsonArray): number | undefined {
  const explicit = isArray(option[7]) && isArray(option[7][0]) ? asNumber((option[7][0] as JsonArray)[1]) : undefined;
  if (explicit !== undefined) return explicit;
  let best: number | undefined;
  walk(option, (node) => {
    if (node.length === 2 && node[0] === null && typeof node[1] === 'number' && node[1] > 0 && node[1] < 10000) {
      best = best === undefined ? node[1] as number : Math.min(best, node[1] as number);
    }
  });
  return best;
}

function bookingUrlFromOption(option: JsonArray): string | undefined {
  let found: string | undefined;
  walk(option, (node) => {
    if (found) return;
    if (node[0] === 'https://www.google.com/travel/clk/f') found = node[0];
    for (const value of node) {
      if (typeof value === 'string' && /^https?:\/\//.test(value) && !value.includes('accessible-services')) {
        found = value;
        return;
      }
    }
  });
  return found;
}

function collectStrings(value: unknown): string[] {
  const strings = new Set<string>();
  walk(value, (node) => {
    for (const item of node) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (!text) continue;
      if (text.length > 80) continue;
      if (/^https?:\/\//.test(text) || text.includes('/travel/flights')) continue;
      if (/^[A-Za-z0-9_-]{24,}$/.test(text)) continue;
      strings.add(text);
    }
  });
  return [...strings];
}

function looksLikeBookingOption(node: JsonArray): boolean {
  if (node[0] !== 0) return false;
  if (!providerFromOption(node)) return false;
  if (!isArray(node[3]) || !node[3].some((flight) => isArray(flight) && typeof flight[0] === 'string' && String(flight[1] ?? '').length > 0)) return false;
  return isArray(node[5]) || priceFromOption(node) !== undefined;
}

function collectBookingOptions(payloads: unknown[], legs: FlightLeg[]): BookingOption[] {
  const options: BookingOption[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    walk(payload, (node) => {
      if (!looksLikeBookingOption(node)) return;
      const provider = providerFromOption(node);
      const price = priceFromOption(node);
      const bookingUrl = bookingUrlFromOption(node);
      const code = codeFromProvider(node);
      const strings = collectStrings(node);
      const fareNotes = strings.filter((text) => {
        if (text === provider || text === code) return false;
        if (/^[A-Z0-9]{2,6}$/.test(text)) return false;
        if (/^www\./.test(text)) return false;
        return ['Basic', 'Choice', 'Choice Preferred', 'Choice Extra', 'Saver', 'Main', 'First'].includes(text) || /bag|seat|basic|main|first|choice|saver/i.test(text);
      });
      const optionLegs = legs.length ? legs : [];
      if (!provider && price === undefined && !bookingUrl) return;
      const key = `${provider ?? ''}|${price ?? ''}|${bookingUrl ?? ''}|${fareNotes.join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({
        provider,
        price,
        currency: price !== undefined ? 'USD' : undefined,
        bookingUrl,
        fareNotes,
        restrictions: strings.filter((text) => /restriction|refund|change|carry|bag/i.test(text) && !fareNotes.includes(text)),
        legs: optionLegs,
      });
    });
  }
  return options;
}

function parsePayloads(rawResponse: unknown): unknown[] {
  if (typeof rawResponse !== 'string') return [rawResponse];
  const records = extractWrbRecords(rawResponse);
  return records.map((record) => parseNestedPayload(record.payload)).filter(Boolean);
}

export function extract(rawResponse: unknown): Output {
  const payloads = parsePayloads(rawResponse);
  const legs = collectLegs(payloads);
  const bookingOptions = collectBookingOptions(payloads, legs);
  const carriers = [...new Set(legs.map((leg) => leg.airline ?? leg.carrierCode).filter((value): value is string => Boolean(value)))];
  return {
    selectedItinerary: {
      legs,
      carriers,
    },
    bookingOptions,
    warnings: bookingOptions.length === 0 ? ['No booking options were returned for this selected itinerary.'] : undefined,
  };
}
