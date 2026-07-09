type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type HotelItem = {
  name: string;
  coordinates?: { latitude: number; longitude: number };
  star_class?: number;
  class_label?: string;
  rating?: number;
  review_count?: number;
  rating_facets?: Array<{ id: number; score: string }>;
  nightly_price?: string;
  nightly_price_range?: string[];
  total_price_range?: string[];
  location_snippets?: Array<{ label: string; time?: string }>;
  website?: string;
  image?: string;
  description?: string;
  hotel_token?: string;
  result_token?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBatchexecute(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const lines = raw.replace(/^\)\]\}'\s*/, '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('[')) continue;
    try {
      const frame = JSON.parse(line) as unknown;
      if (!Array.isArray(frame)) continue;
      for (const row of frame) {
        if (Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === 'AtySUc' && typeof row[2] === 'string') {
          return JSON.parse(row[2]);
        }
      }
      return frame;
    } catch {
      continue;
    }
  }
  return raw;
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) walk(child, visit);
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function paramNumber(params: Record<string, string | number | boolean> | undefined, key: string): number {
  const value = params?.[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function paramNumberSet(params: Record<string, string | number | boolean> | undefined, key: string): Set<number> {
  const value = params?.[key];
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => Number(part.trim()))
      .filter((part) => Number.isFinite(part)),
  );
}

function moneyAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectMoney(value: unknown): string[] {
  const out: string[] = [];
  walk(value, (node) => {
    if (typeof node === 'string' && /^\$[\d,]+/.test(node)) out.push(node);
  });
  return uniqueStrings(out);
}

function firstImage(value: unknown): string | undefined {
  let image: string | undefined;
  walk(value, (node) => {
    if (!image && typeof node === 'string' && /^https:\/\/lh\d\.googleusercontent\.com\//.test(node)) image = node;
  });
  return image;
}

function firstWebsite(details: unknown[]): string | undefined {
  let site: string | undefined;
  walk(details, (node) => {
    if (!site && typeof node === 'string' && /^https?:\/\//.test(node) && !node.includes('googleusercontent.com')) site = node;
  });
  return site;
}

function firstToken(value: unknown): string | undefined {
  let token: string | undefined;
  walk(value, (node) => {
    if (!token && typeof node === 'string' && /^Ch[ck][A-Za-z0-9_-]{12,}/.test(node)) token = node;
  });
  return token;
}

function ratingFacets(details: unknown[]): Array<{ id: number; score: string }> | undefined {
  const facets = details[12];
  if (!Array.isArray(facets) || !Array.isArray(facets[5])) return undefined;
  const parsed = facets[5]
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((entry) => ({ id: asNumber(entry[0]) ?? 0, score: String(entry[1] ?? '') }))
    .filter((entry) => entry.id > 0 && entry.score);
  return parsed.length ? parsed : undefined;
}

function nearby(details: unknown[]): Array<{ label: string; time?: string }> | undefined {
  const section = details[19];
  const snippets: Array<{ label: string; time?: string }> = [];
  if (!Array.isArray(section)) return undefined;
  for (const group of section) {
    const entries = Array.isArray(group) ? group[1] : undefined;
    const rows = Array.isArray(entries) ? entries[2] : undefined;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      let time: string | undefined;
      walk(row, (node) => {
        if (!time && typeof node === 'string' && /\b(min|hr)\b/.test(node)) time = node;
      });
      snippets.push({ label: row[0], time });
    }
  }
  return snippets.length ? snippets : undefined;
}

function reviewSummary(row: unknown[]): { rating?: number; review_count?: number } {
  let best: { rating?: number; review_count?: number } = {};
  walk(row, (node) => {
    if (!Array.isArray(node) || node.length < 2) return;
    const rating = asNumber(node[0]);
    const count = asNumber(node[1]);
    if (rating !== undefined && count !== undefined && rating >= 1 && rating <= 5 && count > 20) {
      if (!best.review_count || count > best.review_count) best = { rating, review_count: count };
    }
  });
  return best;
}

function description(row: unknown[]): string | undefined {
  let text: string | undefined;
  walk(row, (node) => {
    if (!text && typeof node === 'string' && node.length > 35 && /hotel|rooms|lodging|suite|resort|apartment/i.test(node)) {
      text = node;
    }
  });
  return text;
}

function isHotelRow(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && typeof value[1] === 'string'
    && Array.isArray(value[2])
    && Array.isArray((value[2] as unknown[])[0])
    && typeof ((value[2] as unknown[])[0] as unknown[])[0] === 'number'
    && typeof ((value[2] as unknown[])[0] as unknown[])[1] === 'number';
}

function parseHotelRow(row: unknown[]): HotelItem | null {
  const name = String(row[1] ?? '').trim();
  if (!name) return null;
  const details = Array.isArray(row[2]) ? row[2] as unknown[] : [];
  const coords = Array.isArray(details[0]) ? details[0] as unknown[] : [];
  const klass = Array.isArray(row[3]) ? row[3] as unknown[] : [];
  const prices = collectMoney(row);
  const reviews = reviewSummary(row);
  const item: HotelItem = { name };
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    item.coordinates = { latitude: coords[0], longitude: coords[1] };
  }
  if (typeof klass[0] === 'string') item.class_label = klass[0];
  if (typeof klass[1] === 'number') item.star_class = klass[1];
  if (reviews.rating !== undefined) item.rating = reviews.rating;
  if (reviews.review_count !== undefined) item.review_count = reviews.review_count;
  item.rating_facets = ratingFacets(details);
  const nearbyRows = nearby(details);
  if (nearbyRows) item.location_snippets = nearbyRows;
  const website = firstWebsite(details);
  if (website) item.website = website;
  const image = firstImage(row);
  if (image) item.image = image;
  const desc = description(row);
  if (desc) item.description = desc;
  const resultToken = firstToken(row);
  if (resultToken) {
    item.hotel_token = resultToken;
    item.result_token = resultToken;
  }
  if (prices.length) {
    item.nightly_price = prices[0];
    item.nightly_price_range = prices.slice(0, 2);
    if (prices.length >= 4) item.total_price_range = prices.slice(2, 4);
  }
  return item;
}

function metadata(payload: unknown): { result_count?: number; location_name?: string; price_histogram?: unknown; ads?: unknown } {
  const out: { result_count?: number; location_name?: string; price_histogram?: unknown; ads?: unknown } = {};
  walk(payload, (node) => {
    if (!isRecord(node)) return;
    const countBlock = node['416343588'];
    if (Array.isArray(countBlock) && typeof countBlock[0] === 'number') {
      out.result_count = countBlock[0];
      if (typeof countBlock[2] === 'string') out.location_name = countBlock[2];
    }
    const histogram = node['429411180'];
    if (Array.isArray(histogram)) {
      out.price_histogram = {
        place_ids: Array.isArray(histogram[0]) ? histogram[0] : undefined,
        buckets: Array.isArray(histogram[1]) ? histogram[1] : undefined,
        summary: Array.isArray(histogram[2]) ? histogram[2][0] : undefined,
      };
    }
    const ads = node['300000000'];
    if (Array.isArray(ads) && ads.length) out.ads = ads;
  });
  return out;
}

function filterItemsForParams(items: HotelItem[], params?: Record<string, string | number | boolean>): HotelItem[] {
  const maxPrice = paramNumber(params, 'max_price');
  const minRating = paramNumber(params, 'min_rating');
  const classes = paramNumberSet(params, 'hotel_classes');
  return items.filter((item) => {
    const nightly = moneyAmount(item.nightly_price);
    if (maxPrice > 0 && nightly !== undefined && nightly > maxPrice) return false;
    if (minRating > 0 && item.rating !== undefined && item.rating < minRating) return false;
    if (classes.size > 0 && item.star_class !== undefined && !classes.has(item.star_class)) return false;
    return true;
  });
}

export function extract(rawResponse: unknown, context?: { params: Record<string, string | number | boolean>; responses: unknown[] }): unknown {
  const payload = parseBatchexecute(rawResponse) as Json;
  const seen = new Set<string>();
  const items: HotelItem[] = [];
  walk(payload, (node) => {
    if (!isHotelRow(node)) return;
    const item = parseHotelRow(node);
    if (!item || seen.has(item.name)) return;
    seen.add(item.name);
    items.push(item);
  });
  const filteredItems = filterItemsForParams(items, context?.params);
  const meta = metadata(payload);
  return {
    query: context?.params?.destination,
    count: filteredItems.length,
    ...meta,
    items: filteredItems,
  };
}
