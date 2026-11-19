import { parseBatchExecuteEnvelope } from '../_shared/batchexecute-envelope.ts';
import { asJspbArray, jspbAt, parseFlightsServicePayload } from '../_shared/flights-service-parser.ts';

export interface CalendarPrice {
  departureDate: string;
  returnDate: string | null;
  fare: number;
  currency: string;
  selectionData: string;
  status: number;
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  if (typeof rawResponse !== 'string' || rawResponse.trim() === '') {
    throw new Error('Empty Google Flights calendar response');
  }

  // Parse once explicitly through the shared envelope helper as a structural guard,
  // then use the Flights service normalizer assigned for this endpoint.
  parseBatchExecuteEnvelope(rawResponse);
  const payload = parseFlightsServicePayload(rawResponse);
  const rawEntries = jspbAt(payload, [1]);
  if (!Array.isArray(rawEntries)) {
    return { items: [], unavailableDates: [], count: 0, currency: 'USD' };
  }

  const items: CalendarPrice[] = [];
  const unavailableDates: Array<{ departureDate: string; returnDate: string | null; status: number | null }> = [];
  const startDate = typeof context?.params.start_date === 'string' ? context.params.start_date : null;
  const endDate = typeof context?.params.end_date === 'string' ? context.params.end_date : null;
  const tripLengthDays = Number(context?.params.trip_length_days ?? 0);
  const matchesRequestedWindow = (departureDate: string, returnDate: string | null): boolean => {
    if (startDate && departureDate < startDate) return false;
    if (endDate && departureDate > endDate) return false;
    if (tripLengthDays > 0) {
      if (!returnDate) return false;
      const actualDays = (Date.parse(`${returnDate}T00:00:00Z`) - Date.parse(`${departureDate}T00:00:00Z`)) / 86_400_000;
      if (actualDays !== tripLengthDays) return false;
    }
    return true;
  };

  for (const value of rawEntries) {
    let entry: unknown[];
    try {
      entry = asJspbArray(value, 'calendar entry');
    } catch {
      continue;
    }
    const departureDate = typeof entry[0] === 'string' ? entry[0] : '';
    const returnDate = typeof entry[1] === 'string' ? entry[1] : null;
    const fare = jspbAt(entry, [2, 0, 1]);
    const selectionData = jspbAt(entry, [2, 1]);
    const status = typeof entry[3] === 'number' ? entry[3] : null;
    if (departureDate && !matchesRequestedWindow(departureDate, returnDate)) continue;

    if (
      departureDate &&
      status === 1 &&
      typeof fare === 'number' &&
      Number.isFinite(fare) &&
      fare > 0 &&
      typeof selectionData === 'string' &&
      selectionData.length > 0
    ) {
      const candidate = { departureDate, returnDate, fare, currency: 'USD', selectionData, status };
      const duplicateIndex = items.findIndex((item) => item.departureDate === departureDate);
      if (duplicateIndex < 0) {
        items.push(candidate);
      } else if (fare < items[duplicateIndex]!.fare) {
        items[duplicateIndex] = candidate;
      }
    } else if (departureDate) {
      unavailableDates.push({ departureDate, returnDate, status });
    }
  }

  return { items, unavailableDates, count: items.length, currency: 'USD' };
}
