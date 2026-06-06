// Parser for google-hotels get_hotel_booking_options (M0CRd pricing response).
// Decodes the batchexecute anti-XSSI envelope with the SHARED helper, then
// normalizes BOTH M0CRd response shapes into one `hotels[]` output:
//
//   * single-hotel mode (live booking-options call, [2][1] is a price tuple):
//       one hotel entry carrying its per-provider booking `offers[]`.
//   * area-list mode (recorded seq 286/2083, hotels at <node>[9]):
//       many hotel entries, each with its summary nightly + stay-total price.
//
// Each hotel: name, class, rating, price_nightly, price_total, ftid, offers[].
import { parseBatchExecute } from '../_shared/batchexecute.ts';

type PriceTuple = {
  display: string | null; // base label, e.g. "$254"
  display_with_fees: string | null; // incl. taxes/fees, e.g. "$301"
  amount: number | null; // numeric base
  amount_with_fees: number | null; // numeric incl. taxes/fees
};

type Offer = {
  provider: string;
  booking_url: string | null;
  price_nightly: PriceTuple | null;
  price_total: PriceTuple | null;
};

type Hotel = {
  name: string;
  hotel_class: string | null;
  star_rating: number | null;
  rating: number | null;
  reviews: number | null;
  price_nightly: PriceTuple | null;
  price_total: PriceTuple | null;
  ftid: string | null;
  description: string | null;
  coordinates: { lat: number; lng: number } | null;
  offers: Offer[];
};

function priceFromTuple(t: unknown): PriceTuple | null {
  if (!Array.isArray(t)) return null;
  if (typeof t[0] !== 'string' && typeof t[2] !== 'number') return null;
  return {
    display: typeof t[0] === 'string' ? t[0] : null,
    display_with_fees: typeof t[1] === 'string' ? t[1] : null,
    amount: typeof t[2] === 'number' ? t[2] : null,
    amount_with_fees: typeof t[3] === 'number' ? t[3] : null,
  };
}

function absoluteUrl(u: string): string {
  if (u.startsWith('http')) return u;
  if (u.startsWith('/')) return 'https://www.google.com' + u;
  return u;
}

// Booking-offer entry:
//   [ [providerName, partnerId, bookingUrl, [logo], …],          // e[0]
//     null × 11,
//     [null,null,null,null, nightlyTuple, stayTotalTuple, …],     // e[12]
//     … ]
function looksLikeOffer(e: any): boolean {
  return (
    Array.isArray(e) &&
    Array.isArray(e[0]) &&
    typeof e[0][0] === 'string' &&
    e[0][0].length > 0 &&
    typeof e[0][2] === 'string' &&
    Array.isArray(e[12]) &&
    Array.isArray(e[12][4]) &&
    (typeof e[12][4][0] === 'string' || typeof e[12][4][2] === 'number')
  );
}

function collectOffers(node: any, out: Offer[], seen: Set<unknown>): void {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    if (looksLikeOffer(node)) {
      const url = typeof node[0][2] === 'string' ? node[0][2] : null;
      out.push({
        provider: node[0][0],
        booking_url: url ? absoluteUrl(url) : null,
        price_nightly: priceFromTuple(node[12][4]),
        price_total: priceFromTuple(node[12][5]),
      });
    }
    for (const child of node) collectOffers(child, out, seen);
  } else {
    for (const k of Object.keys(node)) collectOffers(node[k], out, seen);
  }
}

function dedupeOffers(offers: Offer[]): Offer[] {
  const byProvider = new Map<string, Offer>();
  for (const o of offers) {
    const prev = byProvider.get(o.provider);
    if (!prev) {
      byProvider.set(o.provider, o);
      continue;
    }
    const a = o.price_nightly?.amount;
    const b = prev.price_nightly?.amount;
    if (typeof a === 'number' && (typeof b !== 'number' || a < b)) {
      byProvider.set(o.provider, o);
    }
  }
  return Array.from(byProvider.values());
}

// Area-list mode: hotels live in a nested array whose [9] slot holds entries
// shaped [n, {"<key>": [hotelData]}].
function findHotelsArray(inner: any[]): any[] {
  for (const el of inner) {
    if (Array.isArray(el) && Array.isArray(el[9])) {
      const cand = el[9];
      if (
        cand.length &&
        Array.isArray(cand[0]) &&
        cand[0].length >= 2 &&
        cand[0][1] &&
        typeof cand[0][1] === 'object'
      ) {
        return cand;
      }
    }
  }
  return [];
}

function toInner(rawResponse: unknown): any {
  if (typeof rawResponse === 'string') return parseBatchExecute(rawResponse, 'M0CRd');
  return rawResponse;
}

export function extract(
  rawResponse: unknown,
  context?: {
    params: Record<string, string | number | boolean>;
    responses: unknown[];
  },
): unknown {
  const inner = toInner(rawResponse);

  const priceMode =
    context?.params && typeof context.params.price_mode === 'string'
      ? context.params.price_mode
      : 'nightly';

  const out = {
    location: { mid: null as string | null, name: null as string | null },
    currency: null as string | null,
    check_in: null as unknown,
    check_out: null as unknown,
    nights: null as number | null,
    adults: null as number | null,
    children: null as number | null,
    price_mode: priceMode,
    mode: 'list' as 'list' | 'single',
    hotels: [] as Hotel[],
  };

  if (!Array.isArray(inner)) return out;

  const ctx: any[] = Array.isArray(inner[1]) ? inner[1] : [];
  out.currency = typeof ctx[3] === 'string' ? ctx[3] : null;
  const dates = Array.isArray(ctx[4]) ? ctx[4] : null;
  const occ = Array.isArray(ctx[13]) ? ctx[13] : null;
  const loc = Array.isArray(ctx[18]) ? ctx[18] : [];
  out.location = { mid: loc[0] ?? null, name: loc[1] ?? null };
  out.check_in = dates ? dates[0] : null;
  out.check_out = dates ? dates[1] : null;
  out.nights = dates && typeof dates[2] === 'number' ? dates[2] : null;
  out.adults = occ && typeof occ[0] === 'number' ? occ[0] : null;
  out.children = occ && typeof occ[2] === 'number' ? occ[2] : null;

  const offersBlock = inner[2];
  const singleHeadline = Array.isArray(offersBlock)
    ? priceFromTuple(offersBlock[1])
    : null;

  if (singleHeadline) {
    // SINGLE-hotel booking-options mode.
    out.mode = 'single';
    let hotelName: string | null = null; // eslint-disable-line prefer-const
    const featured = offersBlock[2];
    if (
      Array.isArray(featured) &&
      Array.isArray(featured[0]) &&
      Array.isArray(featured[0][0]) &&
      typeof featured[0][0][0] === 'string'
    ) {
      hotelName = featured[0][0][0];
    }
    const collected: Offer[] = [];
    collectOffers(offersBlock, collected, new Set());
    const offers = dedupeOffers(collected);
    // Prefer a stay-total taken from any offer carrying it.
    const totalFrom = offers.find((o) => o.price_total)?.price_total ?? null;
    // Fallback: if the featured-offer name was not where we expected, use the
    // first collected offer's provider (often the hotel's own official site).
    if (!hotelName && offers.length) hotelName = offers[0]!.provider;
    out.hotels.push({
      name: hotelName ?? '',
      hotel_class: null,
      star_rating: null,
      rating: null,
      reviews: null,
      price_nightly: singleHeadline,
      price_total: totalFrom,
      ftid: null,
      description: null,
      coordinates: null,
      offers,
    });
    return out;
  }

  // AREA-LIST mode.
  const hotelsRaw = findHotelsArray(inner);
  for (const entry of hotelsRaw) {
    if (!Array.isArray(entry)) continue;
    const obj = entry[1];
    if (!obj || typeof obj !== 'object') continue;
    const keys = Object.keys(obj as Record<string, unknown>);
    if (!keys.length) continue;
    const h = (obj as Record<string, unknown>)[keys[0]!];
    if (!Array.isArray(h)) continue;
    const name = h[1];
    if (typeof name !== 'string' || name.length === 0) continue; // sentinel filter

    const classInfo = Array.isArray(h[3]) ? h[3] : null;
    let nightly: PriceTuple | null = null;
    let total: PriceTuple | null = null;
    const pricing = h[6];
    if (Array.isArray(pricing) && Array.isArray(pricing[2])) {
      nightly = priceFromTuple(pricing[2][1]);
      total = priceFromTuple(pricing[2][9]);
    }
    const ratingArr =
      Array.isArray(h[7]) && Array.isArray(h[7][0]) ? h[7][0] : null;
    const coordArr =
      Array.isArray(h[2]) && Array.isArray(h[2][0]) ? h[2][0] : null;

    out.hotels.push({
      name,
      hotel_class:
        classInfo && typeof classInfo[0] === 'string' ? classInfo[0] : null,
      star_rating:
        classInfo && typeof classInfo[1] === 'number' ? classInfo[1] : null,
      rating: ratingArr && typeof ratingArr[0] === 'number' ? ratingArr[0] : null,
      reviews: ratingArr && typeof ratingArr[1] === 'number' ? ratingArr[1] : null,
      price_nightly: nightly,
      price_total: total,
      ftid: typeof h[9] === 'string' ? h[9] : null,
      description:
        Array.isArray(h[11]) && typeof h[11][0] === 'string' ? h[11][0] : null,
      coordinates:
        coordArr &&
        typeof coordArr[0] === 'number' &&
        typeof coordArr[1] === 'number'
          ? { lat: coordArr[0], lng: coordArr[1] }
          : null,
      offers: [],
    });
  }

  return out;
}
