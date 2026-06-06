// Per-tool request transform for google-hotels get_hotel_booking_options.
//
// This tool returns the BOOKING OPTIONS (per-provider offers) for the top hotel
// in an area, matching the narration "clicked one of the offerings, saw booking
// options". The M0CRd pricing RPC requires a per-hotel entry token ([3]) that is
// minted by the AtySUc hotel-search RPC, so the workflow is a 2-request chain:
//
//   request[0]  AtySUc  — search the area (by the display name carried in the
//                         location_context token) to mint hotel entry tokens.
//   request[1]  M0CRd   — pricing/booking options, using the first hotel token
//                         from request[0] as [3], plus the area mid + dates +
//                         occupancy. (Empirically M0CRd needs NO bounds.)
//
// Proven by the recording + live probes:
//   seq 525 (nightly) / seq 536 (stay total) -> [2][2] price-mode flag (1 vs 2)
//   seq 2083                                  -> [1][13] = [adults,null,children]
//   live probe                                -> M0CRd 403s/empties when [3]=null;
//                                                a fresh AtySUc hotel token fixes it.
//
// location_context is the opaque token emitted by the sibling search_hotels tool
// in the shape "<mid>|<displayName>" (e.g. "/m/0gz469|Chicago Loop").
import {
  buildFreqBody,
  buildBatchExecuteUrl,
  encodeDate,
} from '../_shared/freq.ts';
import { parseBatchExecute } from '../_shared/batchexecute.ts';
import { buildInnerPayload as buildSearchInner } from '../search_hotels/request-transform.ts';

type Params = Record<string, string | number | boolean | undefined>;

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}
function num(v: unknown, dflt = 0): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function nightsBetween(ci: string, co: string): number {
  const a = Date.parse(ci + 'T00:00:00Z');
  const b = Date.parse(co + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.round((b - a) / 86_400_000);
}
function parseLocationContext(raw: string): { mid: string; name: string } {
  const i = raw.indexOf('|');
  if (i === -1) return { mid: raw, name: '' };
  return { mid: raw.slice(0, i), name: raw.slice(i + 1) };
}

// Find the raw AtySUc response body among whatever shape the runtime passes.
function firstResponseString(responses: unknown): string | null {
  if (!responses) return null;
  const vals = Array.isArray(responses)
    ? responses
    : typeof responses === 'object'
      ? Object.values(responses as Record<string, unknown>)
      : [];
  for (const v of vals) {
    if (typeof v === 'string' && v.includes('AtySUc')) return v;
  }
  for (const v of vals) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const b = (v as { body?: unknown }).body;
      if (typeof b === 'string') return b;
    }
  }
  return null;
}

// Pull the first hotel entry token ("Ch…") from an AtySUc response.
export function extractHotelToken(atysRaw: string): string | null {
  let inner: unknown = null;
  try {
    inner = parseBatchExecute(atysRaw, 'AtySUc');
  } catch {
    inner = null;
  }
  if (!inner) return null;
  const m = JSON.stringify(inner).match(/"(Ch[A-Za-z0-9_-]{30,})"/);
  return m ? m[1]! : null;
}

export function buildSearchPayload(params: Params): unknown {
  const { name } = parseLocationContext(str(params.location_context));
  return buildSearchInner({
    location: name || str(params.location_context),
    check_in_date: str(params.check_in_date),
    check_out_date: str(params.check_out_date),
    adults: num(params.adults, 2),
    children: num(params.children, 0),
  });
}

export function buildPricingPayload(params: Params, token: string | null): unknown {
  const { mid, name } = parseLocationContext(str(params.location_context));
  const checkIn = str(params.check_in_date) || '2026-07-03';
  const checkOut = str(params.check_out_date) || '2026-07-06';
  const adults = Math.max(1, num(params.adults, 2));
  const children = Math.max(0, num(params.children, 0));
  const priceMode =
    str(params.price_mode).toLowerCase() === 'stay_total' ? 2 : 1;
  const nights = nightsBetween(checkIn, checkOut);

  const context: unknown[] = new Array(19).fill(null);
  context[0] = [200, 0];
  context[3] = 'USD';
  context[4] = [encodeDate(checkIn), encodeDate(checkOut), nights, null, 0];
  context[13] = [adults, null, children];
  context[18] = [mid, name];

  return [null, context, [1, null, priceMode, 1], token ?? null, []];
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Params,
): { url: string; body: string } {
  void method;
  const u = new URL(url);
  const rpcid = u.searchParams.get('rpcids') || 'M0CRd';
  const fSid = u.searchParams.get('f.sid') ?? '';
  const bl = u.searchParams.get('bl') ?? '';
  const p = params ?? {};

  if (rpcid === 'AtySUc') {
    return {
      url: buildBatchExecuteUrl('AtySUc', { f_sid: fSid, bl }),
      body: buildFreqBody('AtySUc', buildSearchPayload(p), '1'),
    };
  }

  // M0CRd: needs the hotel entry token from the AtySUc response.
  const atysRaw = firstResponseString(responses);
  const token = atysRaw ? extractHotelToken(atysRaw) : null;
  if (process.env.GHO_DEBUG) {
    console.error(
      '[gho transform] responses type=',
      Array.isArray(responses) ? 'array' : typeof responses,
      'keys=',
      responses && typeof responses === 'object' ? Object.keys(responses) : null,
      'token=',
      token,
    );
  }
  return {
    url: buildBatchExecuteUrl('M0CRd', { f_sid: fSid, bl }),
    body: buildFreqBody('M0CRd', buildPricingPayload(p, token), 'generic'),
  };
}
