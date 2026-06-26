// Parse a Google Flights GetCalendarPicker batchexecute response into a
// date->price calendar for the route. Decoding of the )]}' envelope is delegated
// to the shared batchexecute helper (imported per the build plan).
import { decodeBatchExecute } from '../_shared/batchexecute.ts';

type CalendarEntry = {
  departureDate: string;
  returnDate: string | null;
  lowestPriceUSD: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The GetCalendarPicker wrb.fr payload is shaped:
//   [ <metadata>, [ [depDate, retDate, [[null, price], token], 1], ... ] ]
// The metadata entry is skipped naturally because we only keep array items whose
// [0] is an ISO date string. We scan every nested array so we are robust to the
// list living at payload[1] (the recorded shape) or being flattened.
function collectEntries(payload: unknown): CalendarEntry[] {
  const entries = new Map<string, CalendarEntry>();
  if (!Array.isArray(payload)) return [];

  const consider = (item: unknown) => {
    if (!Array.isArray(item)) return;
    const dep = item[0];
    if (typeof dep !== 'string' || !ISO_DATE.test(dep)) return;
    const ret = typeof item[1] === 'string' && ISO_DATE.test(item[1]) ? (item[1] as string) : null;
    // price lives at item[2][0][1]
    const priceContainer = item[2];
    let price: unknown = null;
    if (Array.isArray(priceContainer) && Array.isArray(priceContainer[0])) {
      price = (priceContainer[0] as unknown[])[1];
    }
    if (typeof price !== 'number') return; // no fare found for that date -> omit
    const existing = entries.get(dep);
    if (!existing || price < existing.lowestPriceUSD) {
      entries.set(dep, { departureDate: dep, returnDate: ret, lowestPriceUSD: price });
    }
  };

  for (const top of payload) {
    if (Array.isArray(top)) {
      // top may itself be the list of date entries, or a single entry.
      consider(top);
      for (const inner of top) consider(inner);
    }
  }
  return [...entries.values()];
}

export function extract(
  rawResponse: unknown,
  context?: { params?: Record<string, string | number | boolean>; responses?: unknown[] },
): unknown {
  const raw = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse ?? '');
  const frames = decodeBatchExecute(raw);

  let payload: unknown = null;
  for (const f of frames) {
    const candidate = collectEntries(f.payload);
    if (candidate.length > 0) {
      payload = f.payload;
      break;
    }
  }
  // If no frame produced entries, still attempt the first frame's payload so an
  // empty (zero-result) response yields an empty calendar rather than throwing.
  if (payload == null && frames.length > 0) payload = frames[0]?.payload ?? null;

  const entries = collectEntries(payload).sort((a, b) =>
    a.departureDate < b.departureDate ? -1 : a.departureDate > b.departureDate ? 1 : 0,
  );

  const prices: Record<string, number> = {};
  for (const e of entries) prices[e.departureDate] = e.lowestPriceUSD;

  const params = context?.params ?? {};
  return {
    origin: params.origin != null ? String(params.origin).toUpperCase() : null,
    destination: params.destination != null ? String(params.destination).toUpperCase() : null,
    currency: 'USD',
    count: entries.length,
    prices,
    calendar: entries,
  };
}
