import { parseBatchExecuteEnvelope } from '../_shared/batchexecute-envelope.ts';
import { parseFlightsServicePayload, jspbAt } from '../_shared/flights-service-parser.ts';

type AnyArray = unknown[];

function walk(value: unknown, visit: (node: AnyArray) => void): void {
  if (!Array.isArray(value)) return;
  visit(value);
  for (const child of value) walk(child, visit);
}

function textAt(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dateText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 3 || !value.every((part) => typeof part === 'number')) return null;
  const [year, month, day] = value as number[];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function timeText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') return null;
  return `${String(value[0]).padStart(2, '0')}:${String(value[1]).padStart(2, '0')}`;
}

export function extract(rawResponse: unknown): unknown {
  if (typeof rawResponse !== 'string' || rawResponse.trim().length === 0) {
    throw new Error('Empty Google Flights booking response');
  }

  // Invoke the shared service normalizer for the primary service frame.
  const primary = parseFlightsServicePayload(rawResponse);
  void jspbAt(primary, [0]);

  const frames = parseBatchExecuteEnvelope(rawResponse);
  const payloads = frames.filter((frame) => frame.kind === 'wrb.fr' && Array.isArray(frame.payload)).map((frame) => frame.payload);

  const itinerary: Array<Record<string, unknown>> = [];
  const segmentKeys = new Set<string>();
  for (const payload of payloads) {
    walk(payload, (node) => {
      const airlineCode = textAt(node[0]);
      const airlineName = Array.isArray(node[1]) ? textAt(node[1][0]) : null;
      const origin = textAt(node[3]);
      const destination = textAt(node[6]);
      const departureDate = dateText(node[4]);
      const departureTime = timeText(node[5]);
      const arrivalDate = dateText(node[7]);
      const arrivalTime = timeText(node[8]);
      if (!airlineCode || !airlineName || !origin || !destination || !departureDate || !departureTime || !arrivalTime) return;
      const details = Array.isArray(node[2]) && Array.isArray(node[2][0]) ? node[2][0] as AnyArray : [];
      const flightTuple = Array.isArray(details[22]) ? details[22] as AnyArray : [];
      const flightNumber = textAt(flightTuple[1]);
      const key = [origin,destination,departureDate,airlineCode,flightNumber].join('|');
      if (segmentKeys.has(key)) return;
      segmentKeys.add(key);
      itinerary.push({
        origin, destination, departure_date: departureDate, departure_time: departureTime,
        arrival_date: arrivalDate, arrival_time: arrivalTime,
        duration_minutes: typeof node[9] === 'number' ? node[9] : null,
        airline_code: airlineCode, airline_name: airlineName, flight_number: flightNumber,
        aircraft: textAt(details[17]),
      });
    });
  }

  const offers: Array<Record<string, unknown>> = [];
  const offerKeys = new Set<string>();
  for (const payload of payloads) {
    walk(payload, (node) => {
      let provider: AnyArray | null = null;
      let providerTuple: AnyArray = [];
      let amount: number | null = null;
      let handoff: string | null = null;
      let bookingUrl: string | null = null;
      walk(node, (candidate) => {
        if (!provider && candidate[0] === 0 && Array.isArray(candidate[1]) && Array.isArray(candidate[3]) && Array.isArray(candidate[5])) {
          provider = candidate;
        }
        if (amount === null && candidate[0] === null && typeof candidate[1] === 'number' && candidate[1] > 0 && candidate[1] < 100000) {
          amount = candidate[1];
        }
        if (!bookingUrl) {
          const possible = textAt(candidate[0]);
          if (possible?.includes('/travel/clk/f')) bookingUrl = possible;
        }
      });
      if (!provider || amount === null) return;
      walk((provider as AnyArray)[1], (candidate) => {
        if (providerTuple.length === 0 && textAt(candidate[0]) && textAt(candidate[1])) providerTuple = candidate;
      });
      const providerCode = textAt(providerTuple[0]);
      const providerName = textAt(providerTuple[1]);
      const priceBlock = Array.isArray(node[2]) ? node[2] as AnyArray : [];
      handoff = textAt(priceBlock[1]);
      if (!providerName) return;
      const displayBlock = Array.isArray((provider as AnyArray)[5]) ? (provider as AnyArray)[5] as AnyArray : [];
      const display = textAt(displayBlock[0]);
      const key = [providerCode, providerName, amount, display].join('|');
      if (offerKeys.has(key)) return;
      offerKeys.add(key);
      offers.push({
        provider_code: providerCode,
        provider_name: providerName,
        total_price: amount,
        currency: 'USD',
        display_destination: display,
        booking_url: bookingUrl,
        handoff_data: handoff,
      });
    });
  }
  offers.sort((a, b) => Number(a.total_price) - Number(b.total_price));
  return { itinerary, offers, offer_count: offers.length };
}
