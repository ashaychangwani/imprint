/**
 * Parser for Google Hotels search results (Travel Frontend UI batchexecute, rpcid AtySUc).
 *
 * The session captured a search for hotels in Tahoe City, June 19–27 2026,
 * 1 room with adults + 2 children (ages 3 + 3). The raw response is Google's
 * batchexecute envelope:
 *
 *   )]}'
 *   <chunkSize>
 *   [["wrb.fr","AtySUc","<JSON-string of the actual JSPB payload>",null,null,null,"generic"]]
 *   <chunkSize>
 *   [["di",NNN], …]
 *
 * The payload is positional JSPB (no field names — values are addressed by
 * array index). Hotels live in "section" sub-arrays under
 *   payload[0][0][0][1][i] = [section_type, { "<field_id>": <data> }]
 * where section_type === 34 carries hotel records under key "397419284".
 *
 * Each hotel record is a 48-element array. Empirically observed indices:
 *   rec[1]      string  hotel name
 *   rec[2][0]   [lat, lng]
 *   rec[3]      ["3-star hotel", 3]  star description + rating
 *   rec[6][1][4]  [[Y,M,D],[Y,M,D],nights,rooms]  search stay
 *   rec[6][2][1]  [nightlyDisplay, nightlyDisplayHigher, nightlyValueA, null, nightlyValueB]
 *   rec[6][2][9]  [totalDisplay, totalDisplayHigher]
 *   rec[7][0]   [guestRating, reviewCount]
 *   rec[9]      Maps internal place id "0x...:0x..."
 *   rec[11][0]  description / tagline
 *   rec[12][0]  primary photo URL
 *   rec[20]     opaque hotel token "ChY..." (for hotel-detail fetches)
 *   rec[25]     numeric Google hotel id
 *
 * Top-level metadata (search header + currency) is in section_type === 53
 * under key "416343588" → [resultCount, …, destinationName, …].
 */

export type Hotel = {
  name: string;
  latitude: number | null;
  longitude: number | null;
  starDescription: string | null;
  starRating: number | null;
  guestRating: number | null;
  reviewCount: number | null;
  nightlyPrice: string | null;
  nightlyPriceValue: number | null;
  totalPrice: string | null;
  totalPriceValue: number | null;
  description: string | null;
  photoUrl: string | null;
  hotelId: string | null;
  hotelToken: string | null;
  mapsFeatureId: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  nights: number | null;
};

export type ExtractResult = {
  destination: string | null;
  totalResults: number | null;
  currency: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  nights: number | null;
  hotelCount: number;
  hotels: Hotel[];
};

// ─── helpers ───────────────────────────────────────────────────────────────

function dateTupleToIso(t: unknown): string | null {
  if (!Array.isArray(t) || t.length < 3) return null;
  const [y, m, d] = t as [unknown, unknown, unknown];
  if (typeof y !== 'number' || typeof m !== 'number' || typeof d !== 'number') return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

function asNumberOrNull(x: unknown): number | null {
  return typeof x === 'number' ? x : null;
}

function asStringOrNull(x: unknown): string | null {
  return typeof x === 'string' && x.length > 0 ? x : null;
}

// ─── envelope parser ───────────────────────────────────────────────────────

/**
 * Parse Google's batchexecute envelope. Yields the inner JSPB payload of the
 * AtySUc wrb.fr row. Tolerant of off-by-N declared chunk lengths (Google's
 * length counter occasionally counts something other than UTF-16 code units).
 */
export function parseEnvelope(raw: string): { rpcid: unknown; payload: unknown } | null {
  let s = raw;
  if (s.startsWith(")]}'")) s = s.slice(4);
  s = s.replace(/^\s+/, '');

  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const lenStart = i;
    while (i < s.length && /[0-9]/.test(s[i]!)) i++;
    if (i === lenStart) break;
    const declaredLen = parseInt(s.slice(lenStart, i), 10);
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const chunkStart = i;

    const chunk = sliceJsonChunk(s, chunkStart, declaredLen);
    if (chunk === null) break;
    i = chunkStart + chunk.length;

    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const [tag, rpcid, payloadStr] = entry as unknown[];
      if (tag === 'wrb.fr' && typeof payloadStr === 'string') {
        try {
          return { rpcid, payload: JSON.parse(payloadStr) };
        } catch {
          return { rpcid, payload: null };
        }
      }
    }
  }
  return null;
}

function sliceJsonChunk(s: string, start: number, declaredLen: number): string | null {
  const tryParse = (len: number): string | null => {
    if (len < 1 || start + len > s.length) return null;
    const c = s.slice(start, start + len);
    try {
      JSON.parse(c);
      return c;
    } catch {
      return null;
    }
  };
  const exact = tryParse(declaredLen);
  if (exact !== null) return exact;
  for (let d = 1; d <= 16; d++) {
    const minus = tryParse(declaredLen - d);
    if (minus !== null) return minus;
    const plus = tryParse(declaredLen + d);
    if (plus !== null) return plus;
  }
  return null;
}

// ─── hotel record extraction ───────────────────────────────────────────────

function extractHotel(rec: unknown[]): Hotel | null {
  if (!Array.isArray(rec) || rec.length < 12) return null;
  const name = asStringOrNull(rec[1]);
  if (!name) return null;

  // location
  const locInfo = asArray(rec[2]);
  const latLng = asArray(locInfo[0]);
  const latitude = asNumberOrNull(latLng[0]);
  const longitude = asNumberOrNull(latLng[1]);

  // stars
  const starInfo = asArray(rec[3]);
  const starDescription = asStringOrNull(starInfo[0]);
  const starRating = asNumberOrNull(starInfo[1]);

  // pricing block — rec[6]
  const priceBlock = asArray(rec[6]);
  const stay = asArray(asArray(priceBlock[1])[4]);
  const checkInDate = dateTupleToIso(stay[0]);
  const checkOutDate = dateTupleToIso(stay[1]);
  const nights = asNumberOrNull(stay[2]);

  const priceArr = asArray(priceBlock[2]);
  const nightlyTuple = asArray(priceArr[1]);
  const nightlyPrice = asStringOrNull(nightlyTuple[0]);
  const nightlyPriceValue =
    asNumberOrNull(nightlyTuple[2]) ??
    asNumberOrNull(nightlyTuple[4]);

  const totalTuple = asArray(priceArr[9]);
  const totalPrice = asStringOrNull(totalTuple[0]);
  const totalPriceValue =
    asNumberOrNull(totalTuple[2]) ?? asNumberOrNull(totalTuple[4]);

  // ratings — rec[7][0] = [guestRating, reviewCount]
  const ratingTuple = asArray(asArray(rec[7])[0]);
  const guestRating = asNumberOrNull(ratingTuple[0]);
  const reviewCount = asNumberOrNull(ratingTuple[1]);

  // description / photo
  const description = asStringOrNull(asArray(rec[11])[0]);
  const photoUrl = asStringOrNull(asArray(rec[12])[0]);

  // identifiers
  const mapsFeatureId = asStringOrNull(rec[9]);
  const hotelToken = asStringOrNull(rec[20]);
  const hotelId = asStringOrNull(rec[25]);

  return {
    name,
    latitude,
    longitude,
    starDescription,
    starRating,
    guestRating,
    reviewCount,
    nightlyPrice,
    nightlyPriceValue,
    totalPrice,
    totalPriceValue,
    description,
    photoUrl,
    hotelId,
    hotelToken,
    mapsFeatureId,
    checkInDate,
    checkOutDate,
    nights,
  };
}

/**
 * Recursively walk the payload pulling out every "397419284" hotel record.
 * The number of nesting levels is not perfectly stable across query types
 * (recommended hotels vs additional hotels vs vacation rentals), so a key
 * sweep is more robust than hard-coded paths.
 */
function collectHotels(node: unknown, out: Hotel[], seen: Set<string>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) collectHotels(child, out, seen);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k === '397419284' && Array.isArray(obj[k])) {
      const wrapper = obj[k] as unknown[];
      for (const rec of wrapper) {
        if (!Array.isArray(rec)) continue;
        const h = extractHotel(rec);
        if (!h) continue;
        const key =
          h.hotelId ??
          h.hotelToken ??
          `${h.name}|${h.latitude ?? ''}|${h.longitude ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
      }
    } else {
      collectHotels(obj[k], out, seen);
    }
  }
}

/** Find the search-meta section (type=53, key=416343588) anywhere in the tree. */
function findSearchMeta(
  node: unknown,
): { destination: string | null; totalResults: number | null } | null {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findSearchMeta(child);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['416343588'])) {
    const arr = obj['416343588'] as unknown[];
    return {
      totalResults: asNumberOrNull(arr[0]),
      destination: asStringOrNull(arr[2]),
    };
  }
  for (const k of Object.keys(obj)) {
    const r = findSearchMeta(obj[k]);
    if (r) return r;
  }
  return null;
}

export function extract(rawResponse: unknown): ExtractResult {
  let payload: unknown = rawResponse;
  if (typeof rawResponse === 'string') {
    const env = parseEnvelope(rawResponse);
    payload = env?.payload;
  }

  const hotels: Hotel[] = [];
  collectHotels(payload, hotels, new Set());

  const meta = findSearchMeta(payload) ?? { destination: null, totalResults: null };

  // Pull stay info from any hotel that has it (all hotels carry the same dates).
  const sample = hotels.find(
    (h) => h.checkInDate !== null && h.checkOutDate !== null,
  );
  const checkInDate = sample?.checkInDate ?? null;
  const checkOutDate = sample?.checkOutDate ?? null;
  const nights = sample?.nights ?? null;

  return {
    destination: meta.destination,
    totalResults: meta.totalResults,
    currency: 'USD',
    checkInDate,
    checkOutDate,
    nights,
    hotelCount: hotels.length,
    hotels,
  };
}
