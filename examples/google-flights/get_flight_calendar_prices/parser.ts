import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { CalendarPrice } from '../_shared/google_flights_types.ts';

type CalendarOutput = {
  items: CalendarPrice[];
  count: number;
  currency: string;
};

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parsePayload(rawResponse: unknown): unknown[] | null {
  if (Array.isArray(rawResponse)) return rawResponse;

  if (typeof rawResponse !== 'string') return null;

  const records = extractWrbRecords(rawResponse);
  const record = records.find((entry) => Array.isArray(parseNestedPayload(entry.payload)));
  if (!record) return null;

  const payload = parseNestedPayload(record.payload);
  return asArray(payload);
}

function dateDiffDays(start: string, end: string): number | undefined {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.round((endMs - startMs) / 86_400_000);
}

function readCurrency(token: string | undefined): string {
  if (!token) return 'USD';
  return token.includes('VVNE') || token.includes('USD') ? 'USD' : 'USD';
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): CalendarOutput {
  const payload = parsePayload(rawResponse);
  const rows = asArray(payload?.[1]) ?? [];

  const parsedItems = rows
    .map((row): CalendarPrice | null => {
      const entry = asArray(row);
      if (!entry) return null;

      const departureDate = typeof entry[0] === 'string' ? entry[0] : '';
      const returnDate = typeof entry[1] === 'string' ? entry[1] : undefined;
      const priceBlock = asArray(entry[2]);
      const priceTuple = asArray(priceBlock?.[0]);
      const rawPrice = priceTuple?.[1];
      const price = typeof rawPrice === 'number' ? rawPrice : undefined;
      const selectionToken = typeof priceBlock?.[1] === 'string' ? priceBlock[1] : undefined;

      if (!departureDate && !returnDate && price === undefined && !selectionToken) return null;
      if (!departureDate) return null;

      const nights = returnDate ? dateDiffDays(departureDate, returnDate) : undefined;
      const requestedTripLength = context?.params?.trip_length;
      const tripLength = nights !== undefined ? `${nights} nights` : requestedTripLength ? String(requestedTripLength) : undefined;

      return {
        departureDate,
        returnDate,
        price,
        currency: readCurrency(selectionToken),
        tripLength,
        selectionToken,
      };
    })
    .filter((item): item is CalendarPrice => item !== null);
  const items = Array.from(
    parsedItems
      .reduce((bestByDeparture, item) => {
        const current = bestByDeparture.get(item.departureDate);
        if (!current || (item.price ?? Number.POSITIVE_INFINITY) < (current.price ?? Number.POSITIVE_INFINITY)) {
          bestByDeparture.set(item.departureDate, item);
        }
        return bestByDeparture;
      }, new Map<string, CalendarPrice>())
      .values(),
  );

  return {
    items,
    count: items.length,
    currency: items[0]?.currency ?? 'USD',
  };
}
