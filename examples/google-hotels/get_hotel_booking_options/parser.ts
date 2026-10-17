function decode(raw: unknown): any[] | null {
  if (Array.isArray(raw)) return raw as any[];
  if (typeof raw !== 'string') return null;
  const cleaned = raw.startsWith(")]}'") ? raw.slice(4) : raw;
  for (const line of cleaned.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /^\\d+$/.test(text)) continue;
    try {
      const frames = JSON.parse(text);
      if (!Array.isArray(frames)) continue;
      for (const frame of frames) {
        if (Array.isArray(frame) && frame[0] === 'wrb.fr' && frame[1] === 'M0CRd' && typeof frame[2] === 'string') return JSON.parse(frame[2]);
      }
    } catch {}
  }
  return null;
}
function extractTruncated(raw: string): any[] | null {
  const normalized = raw.replaceAll('\\', '');
  const contextMatch = normalized.match(/"([A-Z]{3})",\[\[(\d{4}),(\d{1,2}),(\d{1,2})\],\[(\d{4}),(\d{1,2}),(\d{1,2})\],\d+,(\d+)\]/);
  const options: any[] = [];
  let cursor = 0;
  while (true) {
    const marker = normalized.indexOf(',"/aclk?', cursor);
    if (marker < 0) break;
    const urlStart = marker + 2;
    const urlEnd = normalized.indexOf('"', urlStart);
    if (urlEnd < 0) break;
    const prefix = normalized.slice(Math.max(0, marker - 120), marker);
    const head = prefix.match(/"([^"]{2,80})",(\d+(?:\.\d+)?)$/);
    cursor = urlEnd + 1;
    if (!head) continue;
    const url = normalized.slice(urlStart, urlEnd).replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    const inDate = contextMatch ? contextMatch[2] + '-' + contextMatch[3]!.padStart(2,'0') + '-' + contextMatch[4]!.padStart(2,'0') : null;
    const outDate = contextMatch ? contextMatch[5] + '-' + contextMatch[6]!.padStart(2,'0') + '-' + contextMatch[7]!.padStart(2,'0') : null;
    options.push({ provider:head[1], room_description:null, rate_description:null, nightly_price:Number(head[2]), stay_total:null, taxes_and_fees:null, currency:contextMatch?.[1] ?? null, availability:'unknown', check_in_date:inDate, check_out_date:outDate, adults:contextMatch ? Number(contextMatch[8]) : null, sponsored:null, booking_url:new URL(url,'https://www.google.com').toString() });
  }
  return contextMatch ? [null,[null,null,null,contextMatch[1],[[Number(contextMatch[2]),Number(contextMatch[3]),Number(contextMatch[4])],[Number(contextMatch[5]),Number(contextMatch[6]),Number(contextMatch[7])],null,Number(contextMatch[8])]], [null,null,options]] : null;
}
function moneyArrays(node: unknown, out: any[][] = []): any[][] {
  if (!Array.isArray(node)) return out;
  if (node.length >= 3 && typeof node[0] === 'string' && /^[$€£]/.test(node[0]) && typeof node[2] === 'number') out.push(node);
  for (const v of node) moneyArrays(v, out);
  return out;
}
function walk(node: unknown, ancestors: any[][], found: Array<{head:any[]; parent:any[]}>): void {
  if (!Array.isArray(node)) return;
  if (typeof node[0] === 'string' && typeof node[1] === 'number' && typeof node[2] === 'string' && node[2].startsWith('/aclk')) {
    found.push({ head: node, parent: ancestors.at(-1) ?? node });
  }
  for (const v of node) walk(v, [...ancestors, node], found);
}
function iso(parts: unknown): string | null {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  return [parts[0], String(parts[1]).padStart(2,'0'), String(parts[2]).padStart(2,'0')].join('-');
}
export function extract(rawResponse: unknown, context?: { params: Record<string,string|number|boolean>; responses: unknown[] }): unknown {
  const sources = context?.responses?.length ? context.responses : [rawResponse];
  const options: any[] = [];
  let currency = typeof context?.params?.currency === 'string' ? context.params.currency : null;
  let checkIn: string | null = typeof context?.params?.check_in_date === 'string' ? context.params.check_in_date : null;
  let checkOut: string | null = typeof context?.params?.check_out_date === 'string' ? context.params.check_out_date : null;
  let adults: number | null = typeof context?.params?.adults === 'number' ? context.params.adults : null;
  let providerPayloads = 0;
  for (const source of sources) {
    const payload = decode(source) ?? (typeof source === 'string' ? extractTruncated(source) : null);
    if (!payload) continue;
    if (!Array.isArray(payload[1]) && !Array.isArray(payload[2])) continue;
    providerPayloads++;
    const echoed = payload[1];
    currency ??= typeof echoed?.[3] === 'string' ? echoed[3] : null;
    checkIn ??= iso(echoed?.[4]?.[0]);
    checkOut ??= iso(echoed?.[4]?.[1]);
    adults ??= typeof echoed?.[4]?.[3] === 'number' ? echoed[4][3] : null;
    const found: Array<{head:any[];parent:any[]}> = [];
    const direct = payload?.[2]?.[2];
    if (Array.isArray(direct) && direct.every((x:any) => x && typeof x.provider === 'string')) options.push(...direct);
    else walk(direct, [], found);
    for (const {head,parent} of found) {
      const prices = moneyArrays(parent);
      const nightly = prices[0] ?? null;
      const total = prices[1] ?? null;
      const provider = head[0].trim();
      if (!provider) continue;
      options.push({
        provider,
        room_description: null,
        rate_description: null,
        nightly_price: nightly?.[2] ?? (typeof head[1] === 'number' ? head[1] : null),
        stay_total: total?.[2] ?? null,
        taxes_and_fees: null,
        currency,
        availability: 'unknown',
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults,
        sponsored: typeof head[5] === 'boolean' ? head[5] : null,
        booking_url: new URL(head[2], 'https://www.google.com').toString()
      });
    }
  }
  if (providerPayloads === 0) {
    throw new Error('HOTEL_BOOKING_UNPARSED: Google returned no recognizable booking payload');
  }
  const seen = new Set<string>();
  return { currency, check_in_date: checkIn, check_out_date: checkOut, adults, options: options.filter(o => {
    const key = [o.provider,o.room_description,o.rate_description,o.nightly_price,o.stay_total,o.check_in_date,o.check_out_date,o.adults,o.sponsored].join('|');
    if (seen.has(key)) return false; seen.add(key); return true;
  }) };
}
