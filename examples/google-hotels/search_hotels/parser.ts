// Parser for google-hotels search_hotels (AtySUc batchexecute response).
// Decodes the anti-XSSI envelope via the shared helper, then walks the inner
// JSON collecting hotel entries (keyed "397419284"), the result-count/area row
// (keyed "416343588"), and recursively extracting per-hotel fields whose exact
// array positions drift between entries.
import { parseBatchExecute } from '../_shared/batchexecute.ts';

type Ctx = {
  params?: Record<string, string | number | boolean>;
  responses?: unknown[];
};

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

// Depth-first: collect every object value stored under `key` anywhere in the tree.
function collectByKey(node: unknown, key: string, out: unknown[]): void {
  if (isArr(node)) {
    for (const child of node) collectByKey(child, key, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (k === key) out.push(obj[k]);
      collectByKey(obj[k], key, out);
    }
  }
}

// Recursively find the first node satisfying `pred`.
function findFirst(node: unknown, pred: (n: unknown) => boolean): unknown {
  if (pred(node)) return node;
  if (isArr(node)) {
    for (const child of node) {
      const hit = findFirst(child, pred);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function findHotelId(entry: unknown): string | null {
  const hit = findFirst(
    entry,
    (n) => typeof n === 'string' && /^Ch[a-zA-Z]I[A-Za-z0-9_-]{8,}$/.test(n),
  );
  return typeof hit === 'string' ? hit : null;
}

function findLatLng(entry: unknown): { lat: number; lng: number } | null {
  const hit = findFirst(
    entry,
    (n) =>
      isArr(n) &&
      n.length === 2 &&
      typeof n[0] === 'number' &&
      typeof n[1] === 'number' &&
      Math.abs(n[0]) <= 90 &&
      Math.abs(n[1]) <= 180 &&
      // exclude small integer pairs like [12,18]; coords have decimals
      (!Number.isInteger(n[0]) || !Number.isInteger(n[1])),
  ) as number[] | undefined;
  return hit ? { lat: hit[0]!, lng: hit[1]! } : null;
}

// Overall rating block looks like [[4,"4.6"],[1,"4.8"],...] (4 = overall).
function findRating(entry: unknown): { overall: number | null; categories: Record<string, number> } {
  const block = findFirst(entry, (n) => {
    if (!isArr(n) || n.length === 0) return false;
    return n.every(
      (p) =>
        isArr(p) &&
        p.length === 2 &&
        typeof p[0] === 'number' &&
        typeof p[1] === 'string' &&
        /^\d+(\.\d+)?$/.test(p[1]),
    );
  }) as Array<[number, string]> | undefined;
  const categories: Record<string, number> = {};
  let overall: number | null = null;
  if (block) {
    const labels: Record<number, string> = {
      4: 'overall',
      1: 'location',
      5: 'rooms',
      2: 'service',
      3: 'value',
    };
    for (const [code, val] of block) {
      const f = Number(val);
      if (code === 4) overall = f;
      categories[labels[code] ?? String(code)] = f;
    }
  }
  return { overall, categories };
}

function findCheckInOut(entry: unknown): { checkIn: string | null; checkOut: string | null } {
  const hit = findFirst(
    entry,
    (n) =>
      isArr(n) &&
      n.length === 2 &&
      typeof n[0] === 'string' &&
      typeof n[1] === 'string' &&
      /\d{1,2}:\d{2}\s?(AM|PM)/i.test(n[0]) &&
      /\d{1,2}:\d{2}\s?(AM|PM)/i.test(n[1]),
  ) as string[] | undefined;
  return hit ? { checkIn: hit[0]!, checkOut: hit[1]! } : { checkIn: null, checkOut: null };
}

// Price block: ["$98","$115",98,null,98] -> display + numeric.
function findPrice(entry: unknown): { display: string | null; amount: number | null } {
  const hit = findFirst(
    entry,
    (n) =>
      isArr(n) &&
      n.length >= 3 &&
      typeof n[0] === 'string' &&
      n[0].startsWith('$') &&
      typeof n[2] === 'number',
  ) as unknown[] | undefined;
  return hit
    ? { display: hit[0] as string, amount: hit[2] as number }
    : { display: null, amount: null };
}

function findStarClass(entry: unknown): string | null {
  const hit = findFirst(
    entry,
    (n) =>
      isArr(n) &&
      n.length === 2 &&
      typeof n[0] === 'string' &&
      /-star (hotel|property)|star hotel|hotel$/i.test(n[0]) &&
      typeof n[1] === 'number',
  ) as unknown[] | undefined;
  return hit ? (hit[0] as string) : null;
}

function findAreaMid(entry: unknown): string | null {
  const hit = findFirst(
    entry,
    (n) => typeof n === 'string' && /^\/m\/[a-z0-9_]+$/i.test(n),
  );
  return typeof hit === 'string' ? hit : null;
}

// Nearby POIs: [[1,[1,null,[["Grant Park",null,[[2,"6 min"]]]]]],...]
function findPois(entry: unknown): string[] {
  const names: string[] = [];
  function walk(n: unknown): void {
    if (isArr(n)) {
      // a POI tuple ["Name", null, [[code,"X min"]], ...]
      if (
        typeof n[0] === 'string' &&
        n[0].length > 1 &&
        isArr(n[2]) &&
        n[2].some(
          (d) => isArr(d) && typeof d[1] === 'string' && /\bmin\b|\bhr\b/.test(d[1]),
        )
      ) {
        if (!names.includes(n[0])) names.push(n[0]);
      }
      for (const c of n) walk(c);
    }
  }
  walk(entry);
  return names.slice(0, 8);
}

function mapHotel(rawEntry: unknown, areaMid: string | null, areaName: string): Record<string, unknown> | null {
  // The "397419284" value wraps the hotel entry: [ [null,"Name",[...]] ].
  let entry: unknown = rawEntry;
  if (
    isArr(entry) &&
    typeof entry[1] !== 'string' &&
    isArr(entry[0]) &&
    typeof (entry[0] as unknown[])[1] === 'string'
  ) {
    entry = entry[0];
  }
  const name = isArr(entry) && typeof entry[1] === 'string' ? entry[1] : null;
  const hotelId = findHotelId(entry);
  if (!name && !hotelId) return null; // content-less sentinel
  const latlng = findLatLng(entry);
  const rating = findRating(entry);
  const times = findCheckInOut(entry);
  const price = findPrice(entry);
  const ownMid = findAreaMid(entry) ?? areaMid;
  return {
    name,
    hotel_id: hotelId, // PRODUCER token (ChcI… ftid)
    location_context: `${ownMid ?? ''}|${areaName}`, // PRODUCER token "<mid>|<displayName>"
    latitude: latlng?.lat ?? null,
    longitude: latlng?.lng ?? null,
    rating: rating.overall,
    rating_categories: rating.categories,
    star_class: findStarClass(entry),
    check_in_time: times.checkIn,
    check_out_time: times.checkOut,
    price: price.display,
    price_amount: price.amount,
    nearby: findPois(entry),
  };
}

export function extract(rawResponse: unknown, context?: Ctx): unknown {
  const raw =
    typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  let inner: unknown;
  try {
    inner = parseBatchExecute(raw, 'AtySUc');
  } catch {
    inner = null;
  }
  if (inner == null) {
    return { area: null, result_count: 0, hotels: [] };
  }

  // result-count / area row: [922,false,"Chicago Loop",true,2]
  const countRows: unknown[] = [];
  collectByKey(inner, '416343588', countRows);
  let resultCount = 0;
  let areaName = '';
  for (const row of countRows) {
    if (isArr(row) && typeof row[0] === 'number') {
      resultCount = row[0];
      if (typeof row[2] === 'string') areaName = row[2];
      break;
    }
  }
  if (!areaName && context?.params?.location) {
    areaName = String(context.params.location);
  }

  // area mid from anywhere in the tree
  const areaMid = findAreaMid(inner);

  // hotel entries
  const hotelVals: unknown[] = [];
  collectByKey(inner, '397419284', hotelVals);
  const seen = new Set<string>();
  const hotels: Record<string, unknown>[] = [];
  for (const v of hotelVals) {
    const mapped = mapHotel(v, areaMid, areaName);
    if (!mapped) continue;
    const dedup = `${mapped.name}|${mapped.hotel_id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    hotels.push(mapped);
  }

  return {
    area: areaName || null,
    area_mid: areaMid,
    result_count: resultCount || hotels.length,
    hotels,
  };
}
