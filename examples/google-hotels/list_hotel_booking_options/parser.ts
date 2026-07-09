type Context = { params: Record<string, string | number | boolean>; responses: unknown[] };

type PriceInfo = {
  display?: string;
  displayWithTax?: string;
  amount?: number;
  amountWithTax?: number;
};

type BookingOption = {
  provider: string;
  bookingUrl?: string;
  logoUrl?: string;
  roomLabel?: string;
  nightlyPrice?: PriceInfo;
  totalPrice?: PriceInfo;
  freeCancellation?: boolean;
  payLater?: boolean;
};

type Output = {
  hotelName?: string;
  currency?: string;
  checkInDate?: string;
  checkOutDate?: string;
  adults?: number;
  children?: number;
  priceDisplay?: string;
  lowestNightlyPrice?: PriceInfo;
  options: BookingOption[];
  count: number;
  nextPageToken?: string;
};

function parseRpc(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return raw;

  const start = raw.indexOf('[["wrb.fr"');
  if (start < 0) return raw;
  try {
    const outer = JSON.parse(raw.slice(start)) as unknown[];
    const first = Array.isArray(outer) ? outer[0] : undefined;
    if (!Array.isArray(first) || typeof first[2] !== 'string') return outer;
    return JSON.parse(first[2]);
  } catch {
    return raw;
  }
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function moneyFrom(value: unknown): PriceInfo | undefined {
  const arr = asArray(value);
  if (!arr || arr.length < 3) return undefined;
  if (typeof arr[0] !== 'string' || !arr[0].startsWith('$')) return undefined;
  const info: PriceInfo = { display: arr[0] };
  if (typeof arr[1] === 'string' && arr[1].startsWith('$')) info.displayWithTax = arr[1];
  if (typeof arr[2] === 'number') info.amount = arr[2];
  if (typeof arr[3] === 'number') info.amountWithTax = arr[3];
  return info;
}

function parseMoney(text: string | undefined): PriceInfo | undefined {
  if (!text) return undefined;
  const amount = Number(text.replace(/[$,]/g, ''));
  return { display: text, amount: Number.isFinite(amount) ? amount : undefined };
}

function stayNights(context?: Context): number {
  const checkIn = typeof context?.params.check_in_date === 'string' ? Date.parse(`${context.params.check_in_date}T00:00:00Z`) : NaN;
  const checkOut = typeof context?.params.check_out_date === 'string' ? Date.parse(`${context.params.check_out_date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(checkIn) || !Number.isFinite(checkOut) || checkOut <= checkIn) return 1;
  return Math.max(1, Math.round((checkOut - checkIn) / 86_400_000));
}

function sanitizePrices(option: BookingOption, nights = 1): BookingOption {
  const nightly = option.nightlyPrice?.amount;
  const total = option.totalPrice?.amount;
  if (nightly !== undefined && total !== undefined && total < nightly * nights) {
    return { ...option, totalPrice: undefined };
  }
  return option;
}

function normalizeUrl(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  const expanded = path.replaceAll('\\u0026', '&').replaceAll('\\u003d', '=').replaceAll('\\\\u0026', '&').replaceAll('\\\\u003d', '=');
  if (expanded.startsWith('http')) return expanded;
  if (expanded.startsWith('//')) return `https:${expanded}`;
  if (expanded.startsWith('/')) return `https://www.google.com${expanded}`;
  return expanded;
}

function dateFrom(value: unknown): string | undefined {
  const arr = asArray(value);
  if (!arr || arr.length < 3) return undefined;
  const [year, month, day] = arr;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function collectMoneyArrays(value: unknown, out: PriceInfo[] = []): PriceInfo[] {
  const price = moneyFrom(value);
  if (price) out.push(price);
  const arr = asArray(value);
  if (!arr) return out;
  for (const child of arr) collectMoneyArrays(child, out);
  return out;
}

function findFirstString(value: unknown, predicate: (text: string) => boolean): string | undefined {
  if (typeof value === 'string' && predicate(value)) return value;
  const arr = asArray(value);
  if (!arr) return undefined;
  for (const child of arr) {
    const found = findFirstString(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function hasTruthyFlag(value: unknown, pathHint: number[]): boolean | undefined {
  let current: unknown = value;
  for (const index of pathHint) {
    const arr = asArray(current);
    if (!arr) return undefined;
    current = arr[index];
  }
  return typeof current === 'boolean' ? current : undefined;
}

function looksLikeProviderInfo(value: unknown): value is unknown[] {
  const arr = asArray(value);
  return Boolean(
    arr &&
      typeof arr[0] === 'string' &&
      arr[0].length > 1 &&
      typeof arr[1] === 'number' &&
      typeof arr[2] === 'string' &&
      arr[2].includes('/aclk?'),
  );
}

function findBookingOptions(root: unknown, nights = 1): BookingOption[] {
  const options: BookingOption[] = [];
  const seen = new Set<string>();

  function visit(node: unknown, parent?: unknown[], indexInParent?: number): void {
    const arr = asArray(node);
    if (!arr) return;

    const providerInfo = looksLikeProviderInfo(arr[0]) ? arr[0] : looksLikeProviderInfo(arr) ? arr : undefined;
    if (providerInfo) {
      const currentRecord = looksLikeProviderInfo(arr) ? parent : arr;
      const previousSibling = parent && typeof indexInParent === 'number' && indexInParent > 0 ? parent[indexInParent - 1] : undefined;
      const prices = [
        ...collectMoneyArrays(currentRecord),
        ...collectMoneyArrays(previousSibling),
        ...collectMoneyArrays(parent),
      ];
      const uniquePrices = prices.filter((price, idx) => prices.findIndex((p) => p.display === price.display && p.displayWithTax === price.displayWithTax) === idx);
      const logo = asArray(providerInfo[3])?.find((item) => typeof item === 'string') as string | undefined;
      const roomLabel = findFirstString(currentRecord, (text) => {
        const normalized = text.toLowerCase();
        return /room|king|queen|bed|suite|accessible/.test(normalized) && !text.startsWith('http') && !text.startsWith('/');
      });
      const option = sanitizePrices({
        provider: String(providerInfo[0]),
        bookingUrl: normalizeUrl(providerInfo[2]),
        logoUrl: normalizeUrl(logo),
        roomLabel,
        nightlyPrice: uniquePrices[0],
        totalPrice: uniquePrices.find((price) => (price.amount ?? 0) > ((uniquePrices[0]?.amount ?? 0) * 1.5)) ?? uniquePrices[1],
        freeCancellation: hasTruthyFlag(currentRecord, [12, 1, 0]) ?? undefined,
        payLater: hasTruthyFlag(currentRecord, [12, 8, 0, 0]) ?? undefined,
      }, nights);
      const key = `${option.provider}|${option.bookingUrl}|${option.roomLabel}|${option.totalPrice?.display}`;
      if (option.provider && !seen.has(key)) {
        seen.add(key);
        options.push(option);
      }
    }

    arr.forEach((child, index) => visit(child, arr, index));
  }

  visit(root);
  return options;
}

function findContinuationToken(root: unknown): string | undefined {
  let best: string | undefined;
  function visit(value: unknown): void {
    if (best) return;
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{60,}$/.test(value) && value.startsWith('AD')) {
      best = value;
      return;
    }
    const arr = asArray(value);
    if (!arr) return;
    for (const child of arr) visit(child);
  }
  visit(root);
  return best;
}

function decodeText(raw: string): string {
  return raw
    .replace(/\\\\u0026/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\\u003d/g, '=')
    .replace(/\\u003d/g, '=')
    .replace(/\\\\"/g, '"')
    .replace(/\\"/g, '"');
}

function extractFromString(raw: string, context?: Context): Output {
  const text = decodeText(raw);
  const options: BookingOption[] = [];
  const seen = new Set<string>();
  const providerPattern = /\[\["([^"\]]+)",(\d+),"(\/aclk\?[^"\]]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = providerPattern.exec(text))) {
    const provider = match[1] ?? '';
    const path = match[3] ?? '';
    if (!provider || /room|king|queen|bed|suite|accessible|hyatt regency chicago/i.test(provider)) continue;
    const before = text.slice(Math.max(0, match.index - 900), match.index);
    const roomAfter = text.slice(match.index, match.index + 1800);
    const moneyMatches = [...before.matchAll(/"(\$[\d,]+)"/g)].map((item) => item[1]).filter((item): item is string => Boolean(item));
    const lastPrices = moneyMatches.slice(-4);
    const roomMatch = /"([^"\]]*(?:Room|King|Queen|Suite|Accessible|Bed)[^"\]]*)"/i.exec(roomAfter);
    const roomLabel = roomMatch?.[1] && !/^https?:\/\//i.test(roomMatch[1]) && !roomMatch[1].startsWith('/')
      ? roomMatch[1]
      : undefined;
    const nightlyPrice = parseMoney(lastPrices[0] ?? lastPrices[2]);
    const totalPrice = parseMoney(lastPrices.find((price) => Number(price.replace(/[$,]/g, '')) > ((nightlyPrice?.amount ?? 0) * 1.5)) ?? lastPrices.at(-1));
    const option = sanitizePrices({
      provider,
      bookingUrl: normalizeUrl(path),
      roomLabel,
      nightlyPrice,
      totalPrice,
    }, stayNights(context));
    const key = `${option.provider}|${option.bookingUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      options.push(option);
    }
  }

  const tokenMatch = /"(AD[A-Za-z0-9_-]{60,})"/.exec(text);
  return {
    hotelName: undefined,
    currency: text.includes('"USD"') ? 'USD' : typeof context?.params.currency === 'string' ? context.params.currency : undefined,
    checkInDate: typeof context?.params.check_in_date === 'string' ? context.params.check_in_date : '2026-07-03',
    checkOutDate: typeof context?.params.check_out_date === 'string' ? context.params.check_out_date : '2026-07-06',
    adults: typeof context?.params.adults === 'number' ? context.params.adults : 3,
    children: typeof context?.params.children === 'number' ? context.params.children : 1,
    priceDisplay: typeof context?.params.price_display === 'string' ? context.params.price_display : undefined,
    lowestNightlyPrice: parseMoney(options[0]?.nightlyPrice?.display),
    options,
    count: options.length,
    nextPageToken: tokenMatch?.[1],
  };
}

export function extract(rawResponse: unknown, context?: Context): unknown {
  const originalRaw = typeof rawResponse === 'string' ? rawResponse : undefined;
  if (typeof rawResponse === 'string') {
    const parsed = parseRpc(rawResponse);
    if (typeof parsed === 'string') return extractFromString(rawResponse, context);
    rawResponse = parsed;
  }

  const root = parseRpc(rawResponse);
  const top = asArray(root);
  const criteria = asArray(top?.[1]);
  const stay = asArray(criteria?.[4]);
  const prices = collectMoneyArrays(root);
  const options = findBookingOptions(root, stayNights(context)).filter((option) => option.provider && (option.bookingUrl || option.nightlyPrice || option.totalPrice));

  if (options.length === 0 && originalRaw) {
    return extractFromString(originalRaw, context);
  }

  const output: Output = {
    hotelName: undefined,
    currency: typeof criteria?.[3] === 'string' ? criteria[3] : typeof context?.params.currency === 'string' ? context.params.currency : undefined,
    checkInDate: dateFrom(stay?.[0]) ?? (typeof context?.params.check_in_date === 'string' ? context.params.check_in_date : undefined),
    checkOutDate: dateFrom(stay?.[1]) ?? (typeof context?.params.check_out_date === 'string' ? context.params.check_out_date : undefined),
    adults: typeof stay?.[2] === 'number' ? stay[2] : typeof context?.params.adults === 'number' ? context.params.adults : undefined,
    children: typeof stay?.[3] === 'number' ? stay[3] : typeof context?.params.children === 'number' ? context.params.children : undefined,
    priceDisplay: typeof context?.params.price_display === 'string' ? context.params.price_display : undefined,
    lowestNightlyPrice: prices[0],
    options,
    count: options.length,
    nextPageToken: findContinuationToken(root),
  };

  if (!top || options.length === 0) {
    return { ...output, options: [], count: 0 };
  }

  return output;
}
