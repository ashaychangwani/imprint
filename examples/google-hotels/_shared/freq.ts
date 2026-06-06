// _shared/freq.ts
// Shared request-builder for the google-hotels batchexecute RPC. Every tool's
// per-tool transform constructs its own inner payload, then calls these helpers
// to wrap it in the f.req envelope and assemble the request URL.
//
// NOTE: the published export-signature comment claims encodeDate maps month-1
// (e.g. encodeDate('2026-07-03') => [2026,6,3]). The recording disproves this:
// every wire date is 1-based (seq 300 sends [2026,7,3] for a Jul 3 stay; seq
// 2547 sends [2026,6,8] for Jun 8). We follow the recording and emit the ISO
// month unchanged.

const BASE_URL = 'https://www.google.com/_/TravelFrontendUi/data/batchexecute';

// Default rpcid -> mode (seq 222 mejVKc='generic', seq 229 AtySUc='1',
// seq 286 M0CRd='generic', seq 497 ocp93e='1').
const MODE_BY_RPCID: Record<string, '1' | 'generic'> = {
  mejVKc: 'generic',
  M0CRd: 'generic',
  AtySUc: '1',
  ocp93e: '1',
};

/**
 * Wrap a tool-specific inner payload in the batchexecute f.req envelope:
 * [[[ rpcid, JSON.stringify(innerPayload), null, mode ]]], URL-encoded with a
 * trailing '&'. Spaces become %20 (encodeURIComponent, not '+') and the inner
 * JSON's quotes become %5C%22, matching the recorded wire bytes exactly.
 */
export function buildFreqBody(
  rpcid: string,
  innerPayload: unknown,
  mode: '1' | 'generic',
): string {
  const inner = JSON.stringify(innerPayload);
  const envelope = [[[rpcid, inner, null, mode]]];
  return 'f.req=' + encodeURIComponent(JSON.stringify(envelope)) + '&';
}

/**
 * Assemble the batchexecute URL. f.sid and bl are session-bound (differ per
 * capture); _reqid is browser-minted and need not be reproduced exactly, so we
 * emit a fresh positive integer. Query order matches the recording.
 */
export function buildBatchExecuteUrl(
  rpcid: string,
  session: { f_sid: string; bl: string },
): string {
  const reqid = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const params = new URLSearchParams();
  params.set('rpcids', rpcid);
  params.set('source-path', '/travel/search');
  params.set('f.sid', session.f_sid);
  params.set('bl', session.bl);
  params.set('hl', 'en-US');
  params.set('soc-app', '162');
  params.set('soc-platform', '1');
  params.set('soc-device', '1');
  params.set('_reqid', String(reqid));
  params.set('rt', 'c');
  return BASE_URL + '?' + params.toString();
}

/**
 * Parse a 'YYYY-MM-DD' ISO date into the wire tuple [year, month, day].
 * Month is 1-based (emitted verbatim), as proven by the recorded payloads.
 */
export function encodeDate(isoDate: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`encodeDate: bad ISO date: ${isoDate}`);
  // Under noUncheckedIndexedAccess captures are string | undefined; the regex
  // match guarantees all three groups, so assert them.
  return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
}

type DecodedFreq = { innerPayload: unknown; mode: '1' | 'generic' };

// Inverse of buildFreqBody: recover the inner payload + mode from a recorded
// f.req body so transform() can re-sign a recorded request faithfully.
function decodeFreqBody(raw: string): DecodedFreq | null {
  const at = raw.indexOf('f.req=');
  if (at === -1) return null;
  let val = raw.slice(at + 'f.req='.length);
  const amp = val.indexOf('&');
  if (amp !== -1) val = val.slice(0, amp);
  let envelope: unknown;
  try {
    envelope = JSON.parse(decodeURIComponent(val));
  } catch {
    return null;
  }
  if (!Array.isArray(envelope)) return null;
  const lvl1 = envelope[0];
  if (!Array.isArray(lvl1)) return null;
  const row = lvl1[0];
  if (!Array.isArray(row)) return null;
  const innerStr = row[1];
  const rawMode = row[3];
  if (typeof innerStr !== 'string') return null;
  let innerPayload: unknown;
  try {
    innerPayload = JSON.parse(innerStr);
  } catch {
    return null;
  }
  const mode: '1' | 'generic' = rawMode === 'generic' ? 'generic' : '1';
  return { innerPayload, mode };
}

/**
 * Thin entry the runtime calls. Parses rpcid/f.sid/bl from the recorded URL,
 * resolves the inner payload + mode (from params, or by decoding a supplied
 * recorded body), and returns the re-signed { url, body }. Never throws for a
 * recorded batchexecute URL.
 */
export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Record<string, any>,
): { url: string; body: string } {
  void method;
  void responses;
  const u = new URL(url);
  const rpcid = u.searchParams.get('rpcids') ?? '';
  const fSid = u.searchParams.get('f.sid') ?? '';
  const bl = u.searchParams.get('bl') ?? '';

  const builtUrl = buildBatchExecuteUrl(rpcid, { f_sid: fSid, bl });

  let innerPayload: unknown = params ? params.innerPayload : undefined;
  let mode: '1' | 'generic' | undefined =
    params && (params.mode === '1' || params.mode === 'generic')
      ? params.mode
      : undefined;

  // Recover inner payload / mode from a recorded body when not supplied so a
  // re-sign of the recorded request reproduces its f.req byte-for-byte.
  if (innerPayload === undefined && params) {
    const rawBody =
      typeof params.requestBody === 'string'
        ? params.requestBody
        : typeof params.body === 'string'
          ? params.body
          : undefined;
    if (typeof rawBody === 'string') {
      const decoded = decodeFreqBody(rawBody);
      if (decoded) {
        innerPayload = decoded.innerPayload;
        if (mode === undefined) mode = decoded.mode;
      }
    }
  }

  if (mode === undefined) mode = MODE_BY_RPCID[rpcid] ?? '1';
  if (innerPayload === undefined) innerPayload = [];

  return { url: builtUrl, body: buildFreqBody(rpcid, innerPayload, mode) };
}
