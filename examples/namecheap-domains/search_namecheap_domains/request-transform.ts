/**
 * Request transform for Namecheap RTB endpoints.
 *
 * The namecheap.com domain-search UI signs every request to its real-time
 * bidding APIs (rtb.namecheapapi.com, etc.) with an `rcs` query param
 * computed by client-side JavaScript. The signature is:
 *   1. Build a canonical string:
 *        "<secret> <nonce32hex> <METHOD> <pathname> <key1>=<encodedValue1>&<key2>=..."
 *      where query pairs come from the URL's raw search string (encoded values),
 *      excluding any existing `rcs` key, sorted alphabetically by key. The
 *      values are then re-encoded with encodeURIComponent (potentially
 *      double-encoding), per the original JS implementation.
 *   2. Compute CRC32 (signed 32-bit) of that string.
 *   3. JSON.stringify({val: <crc>, n: <nonce>}).
 *   4. XOR each character of the JSON with 73, then base64 the resulting
 *      binary string. That value, URL-encoded, becomes the rcs param.
 *
 * The two static "secrets" (one for *.namecheapapi.com, one for *.revved.com)
 * are app-level constants embedded in the public domain-search bundle — not
 * per-user secrets — and gate access to real availability/pricing data.
 * Without a valid rcs the API returns sentinel "domain.com" mock data.
 */

const NC_SECRET = '815e7ef93be85bebe5959f6f72d7e542';
const REVVED_SECRET = '8f6c7d5691eebd3b5090dc6b06755d58';

const NC_HOST_RE =
  /(sb[.-])?(rtb|aftermarket|premiums|pricerequest|business-lookup|domain-suggestion)?\.namecheapapi\.com$/;
const REVVED_HOST_RE = /(sb-)?domains?\.revved\.com$/;

// CRC32 lookup table (matching the `crc-32` npm module v1.2.2 used by the site).
const CRC32_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let e = n;
    for (let k = 0; k < 8; k++) {
      e = e & 1 ? -306674912 ^ (e >>> 1) : e >>> 1;
    }
    t[n] = e;
  }
  return t;
})();

function crc32Str(str: string, seed = 0): number {
  let r = ~seed;
  for (let a = 0; a < str.length; a++) {
    let i = str.charCodeAt(a);
    if (i < 128) {
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ i) & 255]!;
    } else if (i < 2048) {
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (192 | ((i >> 6) & 31))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | (63 & i))) & 255]!;
    } else if (i >= 55296 && i < 57344) {
      i = 64 + (1023 & i);
      const s = 1023 & str.charCodeAt(++a);
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (240 | ((i >> 8) & 7))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | ((i >> 2) & 63))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | ((s >> 6) & 15) | ((3 & i) << 4))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | (63 & s))) & 255]!;
    } else {
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (224 | ((i >> 12) & 15))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | ((i >> 6) & 63))) & 255]!;
      r = (r >>> 8) ^ CRC32_TABLE[(r ^ (128 | (63 & i))) & 255]!;
    }
  }
  return ~r;
}

function randomNonce32Hex(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function chooseSecret(host: string): string | null {
  if (REVVED_HOST_RE.test(host)) return REVVED_SECRET;
  if (NC_HOST_RE.test(host)) return NC_SECRET;
  return null;
}

export function transform(method: string, urlStr: string, responses?: unknown[]): string {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return urlStr;
  }

  // domainStatus placeholder: replace __PLACEHOLDER__ with actual domain
  // names extracted from the search response (responses[1]).
  // Use string replacement instead of searchParams.set to avoid encoding commas.
  if (url.pathname === '/v1/domainStatus' && urlStr.includes('__PLACEHOLDER__') && responses) {
    const search = responses[1] as { picks?: Array<{ domain?: string }>; ranks?: Array<{ domain?: string }>; exact_match?: { domain?: string } } | undefined;
    const domains = new Set<string>();
    if (search?.exact_match?.domain) domains.add(search.exact_match.domain);
    for (const p of search?.picks ?? []) { if (p?.domain) domains.add(p.domain); }
    for (const r of search?.ranks ?? []) { if (r?.domain) domains.add(r.domain); }
    urlStr = urlStr.replace('__PLACEHOLDER__', [...domains].join(','));
    try { url = new URL(urlStr); } catch { return urlStr; }
  }

  const secret = chooseSecret(url.host);
  if (!secret) return urlStr;

  const nonce = randomNonce32Hex();
  let canonical = `${secret} ${nonce} ${method.toUpperCase()} ${url.pathname} `;

  const pairs: Array<[string, string]> = [];
  if (url.search && url.search.startsWith('?')) {
    for (const part of url.search.slice(1).split('&')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx);
      const v = part.slice(idx + 1);
      if (k !== 'rcs') pairs.push([k, v]);
    }
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  canonical += pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const val = crc32Str(canonical, 0);
  const payload = JSON.stringify({ val, n: nonce });

  let xored = '';
  for (let i = 0; i < payload.length; i++) {
    xored += String.fromCharCode(73 ^ payload.charCodeAt(i));
  }

  // Buffer is available in Bun/Node; encode the XOR'd binary string as base64.
  const rcs = Buffer.from(xored, 'binary').toString('base64');

  // Strip any pre-existing rcs param the caller may have placed in the URL.
  const filtered = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const newSearch = filtered ? `?${filtered}&rcs=${encodeURIComponent(rcs)}` : `?rcs=${encodeURIComponent(rcs)}`;
  return `${url.origin}${url.pathname}${newSearch}${url.hash}`;
}
