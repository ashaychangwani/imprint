// Parser for Google Flights GetBookingResults (batchexecute RPC).
// Decodes the streaming envelope with the shared helper, then walks the deeply
// nested positional payload to extract the itinerary's per-segment detail and
// the list of bookable fare options (price USD + booking provider).
import { decodeBatchExecute } from '../_shared/batchexecute.ts';

const AIRPORT = /^[A-Z]{3}$/;

interface Segment {
  carrier: string;
  carrierName: string | null;
  flightNumber: string;
  origin: string;
  originName: string | null;
  destination: string;
  destinationName: string | null;
  departDate: string | null;
  departTime: string | null;
  arriveDate: string | null;
  arriveTime: string | null;
  durationMinutes: number | null;
  aircraft: string | null;
  operatingCarrier: { carrier: string; flightNumber: string | null; name: string | null } | null;
}

interface FareOption {
  priceUSD: number;
  provider: string;
  bookingUrl: string | null;
  fareClass: string | null;
}

function fmtTime(t: unknown): string | null {
  if (!Array.isArray(t) || t.length === 0) return null;
  const h = typeof t[0] === 'number' ? t[0] : 0;
  const m = typeof t[1] === 'number' ? t[1] : 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDate(d: unknown): string | null {
  if (!Array.isArray(d) || d.length < 3) return null;
  const [y, mo, day] = d as number[];
  if (typeof y !== 'number') return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// A segment node: airport codes at [3]/[6], aircraft string at [17],
// and a marketing-flight tuple [carrier, number, _, carrierName] at [22].
function isSegment(node: unknown): node is unknown[] {
  if (!Array.isArray(node)) return false;
  if (typeof node[3] !== 'string' || !AIRPORT.test(node[3] as string)) return false;
  if (typeof node[6] !== 'string' || !AIRPORT.test(node[6] as string)) return false;
  const fn = node[22];
  return Array.isArray(fn) && typeof fn[0] === 'string' && fn[1] != null;
}

// A booking-option node: provider tuple at [1][0] = [carrier, providerName,...]
// and price at [7] = [[null, priceUSD], "<fareToken>"].
function isBookingOption(node: unknown): node is unknown[] {
  if (!Array.isArray(node)) return false;
  const provider = node[1];
  if (!Array.isArray(provider) || !Array.isArray(provider[0])) return false;
  if (typeof provider[0][1] !== 'string') return false;
  const price = node[7];
  if (!Array.isArray(price) || !Array.isArray(price[0])) return false;
  return typeof price[0][1] === 'number';
}

function toSegment(seg: unknown[]): Segment {
  const fn = seg[22] as unknown[];
  let operatingCarrier: Segment['operatingCarrier'] = null;
  const op = seg[15];
  if (Array.isArray(op) && Array.isArray(op[0]) && typeof op[0][0] === 'string') {
    const o = op[0] as unknown[];
    operatingCarrier = {
      carrier: o[0] as string,
      flightNumber: typeof o[1] === 'string' ? (o[1] as string) : null,
      name: typeof o[3] === 'string' ? (o[3] as string) : null,
    };
  }
  return {
    carrier: typeof fn[0] === 'string' ? (fn[0] as string) : '',
    carrierName: typeof fn[3] === 'string' ? (fn[3] as string) : null,
    flightNumber: fn[1] != null ? String(fn[1]) : '',
    origin: seg[3] as string,
    originName: typeof seg[4] === 'string' ? (seg[4] as string) : null,
    destination: seg[6] as string,
    destinationName: typeof seg[5] === 'string' ? (seg[5] as string) : null,
    departDate: fmtDate(seg[20]),
    departTime: fmtTime(seg[8]),
    arriveDate: fmtDate(seg[21]),
    arriveTime: fmtTime(seg[10]),
    durationMinutes: typeof seg[11] === 'number' ? (seg[11] as number) : null,
    aircraft: typeof seg[17] === 'string' ? (seg[17] as string) : null,
    operatingCarrier,
  };
}

function toFareOption(node: unknown[]): FareOption {
  const provider = node[1] as unknown[];
  const price = node[7] as unknown[];
  const link = node[5];
  let bookingUrl: string | null = null;
  if (Array.isArray(link) && typeof link[0] === 'string') bookingUrl = link[0] as string;

  let fareClass: string | null = null;
  const fc = node[14];
  // node[14] = [[[null, ["WN","BASIC"], 1]]]
  const inner = Array.isArray(fc) ? (fc[0] as unknown[]) : undefined;
  const innerInner = Array.isArray(inner) ? (inner[0] as unknown[]) : undefined;
  if (Array.isArray(innerInner) && Array.isArray(innerInner[1])) {
    const code = (innerInner[1] as unknown[])[1];
    if (typeof code === 'string') fareClass = code;
  }

  return {
    priceUSD: (price[0] as unknown[])[1] as number,
    provider: (provider[0] as unknown[])[1] as string,
    bookingUrl,
    fareClass,
  };
}

function walk(node: unknown, segs: unknown[][], fares: unknown[][]): void {
  if (!Array.isArray(node)) return;
  if (isBookingOption(node)) {
    fares.push(node);
    // booking options also contain a nested segment listing; keep recursing
    // so those segments are still discovered (dedup handles overlap).
  }
  if (isSegment(node)) {
    segs.push(node);
    return; // a segment is a leaf for our purposes
  }
  for (const child of node) walk(child, segs, fares);
}

export function extract(
  rawResponse: unknown,
  _context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  let frames: Array<{ rpcid: string | null; payload: any }> = [];
  if (typeof rawResponse === 'string') {
    frames = decodeBatchExecute(rawResponse);
  } else if (rawResponse != null) {
    frames = [{ rpcid: null, payload: rawResponse }];
  }

  const segNodes: unknown[][] = [];
  const fareNodes: unknown[][] = [];
  for (const f of frames) walk(f.payload, segNodes, fareNodes);

  // Dedup segments by carrier+number+departDate+departTime.
  const segMap = new Map<string, Segment>();
  for (const s of segNodes) {
    const seg = toSegment(s);
    if (!seg.carrier && !seg.flightNumber) continue;
    const key = `${seg.carrier}${seg.flightNumber}|${seg.departDate}|${seg.departTime}|${seg.origin}`;
    if (!segMap.has(key)) segMap.set(key, seg);
  }

  // Dedup fare options by fareClass + price + provider.
  const fareMap = new Map<string, FareOption>();
  for (const n of fareNodes) {
    const fare = toFareOption(n);
    if (!fare.provider || typeof fare.priceUSD !== 'number') continue;
    const key = `${fare.fareClass}|${fare.priceUSD}|${fare.provider}`;
    if (!fareMap.has(key)) fareMap.set(key, fare);
  }

  const segments = [...segMap.values()];
  const fareOptions = [...fareMap.values()];
  const prices = fareOptions.map((f) => f.priceUSD);

  return {
    segments,
    fareOptions,
    segmentCount: segments.length,
    fareOptionCount: fareOptions.length,
    lowestPriceUSD: prices.length ? Math.min(...prices) : null,
  };
}
