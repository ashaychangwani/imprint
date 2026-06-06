// Per-tool request transform for google-hotels search_hotels.
// Builds the AtySUc batchexecute inner payload from the tool params, then wraps
// it with the SHARED freq.ts helpers (buildFreqBody / buildBatchExecuteUrl).
// The structure was reverse-engineered from recorded requests:
//   seq 229  (location only)               -> proves a bare text query resolves
//   seq 300  (location + dates)            -> [1][2] location/dates block
//   seq 691  (4+ rating)                   -> [1][4][3]/[1][4][4]
//   seq 745  (price max 338)               -> [1][4][3][1] = [min,max]
//   seq 1098 (19 amenities + 4/5 star)     -> [1][4][0][0] amenities, [1][4][0][1] stars
//   seq 1745 (brands)                      -> [1][4][0][7] brands
//   seq 1842 (sort lowest price)           -> [1][4][0][4] sort code
//   seq 2082 (property type / vacation)    -> [1][0] = 1 hotels / 2 vacation rentals
import {
  buildFreqBody,
  buildBatchExecuteUrl,
  encodeDate,
} from '../_shared/freq.ts';

type Params = Record<string, string | number | boolean | undefined>;

function num(v: unknown, dflt = 0): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

// Amenity name aliases -> Google integer codes (best-effort; numeric codes pass
// through unchanged). Codes observed in the recording's 19-amenity list.
const AMENITY_ALIASES: Record<string, number> = {
  'free breakfast': 4,
  breakfast: 4,
  'free wi-fi': 6,
  'free wifi': 6,
  wifi: 6,
  'wi-fi': 6,
  bar: 2,
  pool: 9,
  spa: 15,
  'air conditioning': 8,
  'pet-friendly': 12,
  'pet friendly': 12,
  'fitness center': 19,
  gym: 19,
  restaurant: 1,
  'room service': 3,
  'airport shuttle': 22,
  'electric vehicle charging station': 61,
  parking: 7,
  'free parking': 10,
  'hot tub': 40,
  'accessible': 5,
  'kid-friendly': 53,
  'all-inclusive available': 11,
  'beach access': 52,
};

function parseCodeList(raw: string, aliases?: Record<string, number>): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (aliases && t in aliases) {
      out.push(aliases[t]!);
      continue;
    }
    const n = Number(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Brand filter: each entry encodes as [parentCode,[childCode]]. Accept "parent:child"
// or a bare numeric code (wrapped as [code,[code]]).
function parseBrands(raw: string): Array<[number, number[]]> {
  if (!raw) return [];
  const out: Array<[number, number[]]> = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.includes(':')) {
      const [a, b] = t.split(':');
      const pa = Number(a);
      const pb = Number(b);
      if (Number.isFinite(pa) && Number.isFinite(pb)) out.push([pa, [pb]]);
    } else {
      const n = Number(t);
      if (Number.isFinite(n)) out.push([n, [n]]);
    }
  }
  return out;
}

const SORT_CODES: Record<string, number | null> = {
  relevance: null,
  lowest_price: 3,
  highest_rating: 8,
  most_reviewed: 13,
};

function nightsBetween(ci: string, co: string): number {
  const a = Date.parse(ci + 'T00:00:00Z');
  const b = Date.parse(co + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.round((b - a) / 86_400_000);
}

export function buildInnerPayload(params: Params): unknown {
  const location = str(params.location);
  const checkIn = str(params.check_in_date);
  const checkOut = str(params.check_out_date);
  const adults = Math.max(1, num(params.adults, 2));
  const children = Math.max(0, num(params.children, 0));
  const minRating = num(params.min_rating, 0);
  const minPrice = num(params.min_price, 0);
  const maxPrice = num(params.max_price, 0);
  const amenities = parseCodeList(str(params.amenities), AMENITY_ALIASES);
  const stars = parseCodeList(str(params.hotel_class));
  const brands = parseBrands(str(params.brands));
  const sortKey = str(params.sort_by).toLowerCase() || 'relevance';
  const sortCode = sortKey in SORT_CODES ? SORT_CODES[sortKey] : null;
  const propertyType =
    str(params.property_type).toLowerCase() === 'vacation_rentals' ? 2 : 1;

  // [1][1] occupancy: array of adults (each [3]) + children scalar
  const occupancy: unknown = [Array.from({ length: adults }, () => [3]), children];

  // [1][2] location/dates: empty mid block + dates block
  let locDates: unknown;
  if (checkIn && checkOut) {
    locDates = [
      [],
      [
        null,
        [encodeDate(checkIn), encodeDate(checkOut), nightsBetween(checkIn, checkOut)],
        null,
        null,
        null,
        [1],
      ],
    ];
  } else {
    locDates = null;
  }

  // [1][4] filters
  const filterObj: unknown[] = [
    amenities.length ? amenities : null, // [0] amenities
    stars.length ? stars : null, // [1] hotel class (stars)
    null, // [2]
    null, // [3]
    sortCode ?? null, // [4] sort
    null, // [5]
    'USD', // [6] currency
  ];
  if (brands.length) filterObj[7] = brands; // [7] brands

  const f14: unknown[] = [filterObj, null, []];

  const ratingCode = minRating > 0 ? Math.round(minRating * 2) : 0;
  const priceSet = minPrice > 0 || maxPrice > 0;
  if (priceSet || ratingCode) {
    const priceTuple = priceSet ? [minPrice > 0 ? minPrice : null, maxPrice > 0 ? maxPrice : null] : null;
    f14[3] = [null, priceTuple, 1];
    if (ratingCode) f14[4] = ratingCode;
  }

  const block1: unknown = [propertyType, occupancy, locDates, null, f14];

  // [2] fresh-search block (matches seq 229 / a brand-new query)
  const block2: unknown = [0, null, null, 0, 0, null, null, null, 0];

  return [location, block1, block2];
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Params,
): { url: string; body: string } {
  void method;
  void responses;
  const u = new URL(url);
  const rpcid = u.searchParams.get('rpcids') || 'AtySUc';
  const fSid = u.searchParams.get('f.sid') ?? '';
  const bl = u.searchParams.get('bl') ?? '';
  const inner = buildInnerPayload(params ?? {});
  return {
    url: buildBatchExecuteUrl(rpcid, { f_sid: fSid, bl }),
    body: buildFreqBody(rpcid, inner, '1'),
  };
}
