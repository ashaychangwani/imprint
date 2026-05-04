/** Registrable-domain extraction (eTLD+1) for hostname filtering.
 *
 *  Naive `split('.').slice(-2)` is wrong for multi-part public suffixes:
 *    api.example.co.uk → "co.uk"   (wrong; should be "example.co.uk")
 *  which then over-matches every other .co.uk hostname.
 *
 *  We're not pulling in the full Mozilla Public Suffix List — too much
 *  weight for a CLI tool. Instead, a small allow-list of the common
 *  multi-part suffixes covers ~all real-world cases. If we ever record
 *  against an exotic ccTLD we'll add it here. */
const MULTI_PART_SUFFIXES = new Set([
  // United Kingdom
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'ac.uk',
  'gov.uk',
  'nhs.uk',
  // Australia
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'asn.au',
  'id.au',
  // Japan
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'ad.jp',
  'go.jp',
  'gr.jp',
  // Brazil
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'edu.br',
  'mil.br',
  // South Africa
  'co.za',
  'ac.za',
  'gov.za',
  'org.za',
  'net.za',
  // Mexico
  'com.mx',
  'gob.mx',
  'org.mx',
  'edu.mx',
  // India
  'co.in',
  'gov.in',
  'ac.in',
  'org.in',
  'net.in',
  'edu.in',
  // South Korea
  'co.kr',
  'ne.kr',
  'or.kr',
  'go.kr',
  'ac.kr',
  // China
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  // Hong Kong
  'com.hk',
  'org.hk',
  'gov.hk',
  'edu.hk',
  'net.hk',
  // New Zealand
  'co.nz',
  'org.nz',
  'net.nz',
  'govt.nz',
  'ac.nz',
  // Singapore
  'com.sg',
  'org.sg',
  'gov.sg',
  'edu.sg',
  'net.sg',
  // Israel
  'co.il',
  'org.il',
  'gov.il',
  'ac.il',
  'net.il',
  // Argentina
  'com.ar',
  'gov.ar',
  'edu.ar',
  'org.ar',
]);

/** Return the registrable domain (eTLD+1) of a hostname.
 *  Examples:
 *    api.example.com    → example.com
 *    api.example.co.uk  → example.co.uk
 *    example.com        → example.com
 *    localhost          → localhost
 *    192.168.1.1        → 192.168.1.1 (no further reduction)  */
export function registrableDomain(hostname: string): string {
  // IPs and bare hosts pass through unchanged.
  if (hostname.length === 0) return hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;

  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** True when `hostname` is the registrable domain `root` or a subdomain
 *  of it. Used by request-filtering and cookie-scoping. */
export function isSameRegistrableDomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}
