export interface HotelResult {
  hotel_id: string | null;
  name: string;
  property_type: string | null;
  coordinates: { latitude: number; longitude: number } | null;
  nightly_price: number | null;
  currency: string | null;
  rating: number | null;
  review_count: number | null;
}

function decodePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const lines = raw.replace(/^\)\]\}'\s*/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('[[')) continue;
    try {
      const frame = JSON.parse(line) as unknown[][];
      const row = frame.find(x => Array.isArray(x) && x[0] === 'wrb.fr');
      if (typeof row?.[2] === 'string') return JSON.parse(row[2]);
    } catch { /* inspect next framed line */ }
  }
  try { return JSON.parse(raw); } catch { return null; }
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const child of value) walk(child, visit);
  else if (value && typeof value === 'object') for (const child of Object.values(value as Record<string, unknown>)) walk(child, visit);
}

function stringsIn(value: unknown): string[] {
  const out: string[] = [];
  walk(value, x => { if (typeof x === 'string') out.push(x); });
  return out;
}

function coordinatesIn(value: unknown): { latitude: number; longitude: number } | null {
  let found: { latitude: number; longitude: number } | null = null;
  walk(value, x => {
    if (found || !Array.isArray(x) || x.length !== 2) return;
    const [a,b] = x;
    if (
      typeof a === 'number' &&
      typeof b === 'number' &&
      Math.abs(a) <= 90 &&
      Math.abs(b) <= 180 &&
      (a !== 0 || b !== 0) &&
      (
        Math.abs(a) > 10 ||
        Math.abs(b) > 10 ||
        !Number.isInteger(a) ||
        !Number.isInteger(b)
      )
    ) {
      found = { latitude: a, longitude: b };
    }
  });
  return found;
}

function priceIn(value: unknown): number | null {
  const strings = stringsIn(value);
  for (const s of strings) {
    const match = s.match(/^\$([0-9][0-9,]*(?:\.\d+)?)$/);
    if (match) return Number(match[1]!.replace(/,/g, ''));
  }
  return null;
}

function directLocalizedPairs(node: unknown[]): Array<[string,string]> {
  return node.filter(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(x[1])) as Array<[string,string]>;
}

export function extract(rawResponse: unknown): unknown {
  const payload = decodePayload(rawResponse);
  if (!Array.isArray(payload)) {
    throw new Error('ATYSUC_UNPARSED: Google returned a non-batchexecute search response');
  }
  const byName = new Map<string, HotelResult>();
  walk(payload, node => {
    if (!Array.isArray(node)) return;
    const pairs = directLocalizedPairs(node);
    if (!pairs.length) return;
    const typePair = pairs.find(([value]) => /^(Hotel|Vacation rental|Resort|Motel|Hostel|Inn|Apartment|Bed and breakfast)$/i.test(value));
    if (!typePair) return;
    const namePair = pairs.find(([value]) => value !== typePair[0] && value.length >= 3);
    if (!namePair || /^(Images may|Essential info)/i.test(namePair[0])) return;
    const allStrings = stringsIn(node);
    const token = allStrings.find(s => /^Ch[a-zA-Z0-9_-]{20,}$/.test(s)) ?? null;
    const ratingCandidate = node.find(x => typeof x === 'number' && x >= 1 && x <= 5 && !Number.isInteger(x)) as number | undefined;
    const reviewCandidate = node.find(x => typeof x === 'number' && Number.isInteger(x) && x > 5 && x < 1000000) as number | undefined;
    byName.set(namePair[0], {
      hotel_id: token,
      name: namePair[0],
      property_type: typePair[0],
      coordinates: coordinatesIn(node),
      nightly_price: priceIn(node),
      currency: allStrings.includes('USD') || allStrings.some(s => /^\$/.test(s)) ? 'USD' : null,
      rating: ratingCandidate ?? null,
      review_count: reviewCandidate ?? null,
    });
  });

  // Tagged-map variants put the localized compact record one level below a numeric-keyed object.
  if (!byName.size && payload && typeof payload === 'object') {
    walk(payload, node => {
      if (!node || Array.isArray(node) || typeof node !== 'object') return;
      for (const child of Object.values(node as Record<string, unknown>)) {
        if (!Array.isArray(child)) continue;
        const strings = stringsIn(child);
        const type = strings.find(s => /^(Hotel|Vacation rental|Resort|Motel|Hostel|Inn|Apartment)$/i.test(s));
        const name = strings.find(s => s.length > 3 && s !== type && !/^https?:|^\/|^\$|^[A-Z]{3}$/.test(s));
        if (!type || !name) continue;
        byName.set(name, { hotel_id: strings.find(s => /^Ch[a-zA-Z0-9_-]{20,}$/.test(s)) ?? null, name, property_type:type, coordinates:coordinatesIn(child), nightly_price:priceIn(child), currency:strings.includes('USD')?'USD':null, rating:null, review_count:null });
      }
    });
  }

  const items = [...byName.values()].filter(x => x.name.trim() && x.property_type);
  if (items.length === 0 && payload.length !== 0) {
    throw new Error(
      'ATYSUC_UNPARSED: Google returned a non-empty search frame in an unsupported or challenge response shape; retry the request.',
    );
  }
  const all = stringsIn(payload);
  return { query: null, currency: all.includes('USD') ? 'USD' : null, count: items.length, items };
}
