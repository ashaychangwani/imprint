type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type HotelOutput = {
  hotel: {
    name: string;
    coordinates?: { latitude: number; longitude: number };
    address?: string;
    phone?: string;
    checkInTime?: string;
    checkOutTime?: string;
    ratingBreakdown?: Record<string, number>;
  } | null;
  selectedHotelToken?: string;
  photos: Array<{ url: string; sourceUrl?: string }>;
  amenities: Array<{ name: string; available: boolean; section: string }>;
  nearby: Array<{ name: string; category?: string; rating?: number; reviewCount?: number; distance?: string }>;
  bookingOptions: Array<{ provider: string; url?: string; displayedPrice?: string }>;
  rawSections: string[];
};

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const decoded = decodeGoogleBatch(rawResponse);
  if (!decoded) return emptyOutput(context);

  const hotelRecord = findSection(decoded, '441552390');
  if (!Array.isArray(hotelRecord) || typeof hotelRecord[1] !== 'string' || !hotelRecord[1].trim()) {
    return emptyOutput(context);
  }

  const hotelName = hotelRecord[1].trim();
  const hotelDetail = hotelRecord[2];
  const allStrings = collectStrings(hotelRecord);
  const times = findTimePair(hotelRecord);

  const output: HotelOutput = {
    hotel: {
      name: hotelName,
      coordinates: findCoordinatePair(hotelDetail ?? hotelRecord),
      address: allStrings.find((value) => /\d+\s+.+,\s*[A-Z]{2}\s+\d{5}/.test(value)),
      phone: allStrings.find((value) => /^(?:\+?1\s*)?\(?\d{3}\)?[-\s.]\d{3}[-\s.]\d{4}$/.test(value)),
      checkInTime: times?.[0],
      checkOutTime: times?.[1],
      ratingBreakdown: findRatingBreakdown(hotelRecord),
    },
    selectedHotelToken: findSelectedToken(hotelRecord, context),
    photos: collectPhotos(hotelRecord),
    amenities: collectAmenitySections(hotelRecord),
    nearby: collectNearbyPlaces(hotelRecord, hotelName),
    bookingOptions: collectBookingOptions(hotelRecord),
    rawSections: collectSectionKeys(decoded),
  };

  return output;
}

function emptyOutput(context?: { params: Record<string, string | number | boolean> }): HotelOutput {
  const token = typeof context?.params?.hotel_token === 'string' ? context.params.hotel_token : undefined;
  return { hotel: null, selectedHotelToken: token, photos: [], amenities: [], nearby: [], bookingOptions: [], rawSections: [] };
}

function decodeGoogleBatch(raw: unknown): Json | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw) || typeof raw === 'object') return raw as Json;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('[[')) continue;
    try {
      const outer = JSON.parse(line) as Json;
      const payload = findWrbPayload(outer);
      if (typeof payload === 'string') return JSON.parse(payload) as Json;
    } catch {
      continue;
    }
  }

  try {
    return JSON.parse(raw) as Json;
  } catch {
    return undefined;
  }
}

function findWrbPayload(value: Json): string | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value[0] === 'wrb.fr' && value[1] === 'AtySUc' && typeof value[2] === 'string') return value[2];
  for (const item of value) {
    const found = findWrbPayload(item);
    if (found) return found;
  }
  return undefined;
}

function findSection(value: Json, key: string): Json | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSection(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, Json>;
    if (objectValue[key] !== undefined) return objectValue[key];
    for (const item of Object.values(objectValue)) {
      const found = findSection(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function collectSectionKeys(value: Json, keys = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSectionKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^\d{6,}$/.test(key)) keys.add(key);
      collectSectionKeys(item, keys);
    }
  }
  return [...keys].sort();
}

function collectStrings(value: Json | undefined, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value.replace(/\\u0026/g, '&').replace(/\\u003cbr\\u003e/g, '\n'));
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function findCoordinatePair(value: Json | undefined): { latitude: number; longitude: number } | undefined {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    if (Math.abs(value[0]) <= 90 && Math.abs(value[1]) <= 180) return { latitude: value[0], longitude: value[1] };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCoordinatePair(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findCoordinatePair(item);
      if (found) return found;
    }
  }
  return undefined;
}

function findTimePair(value: Json | undefined): [string, string] | undefined {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
    if (/[AP]M/.test(value[0]) && /[AP]M/.test(value[1])) return [value[0], value[1]];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTimePair(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findTimePair(item);
      if (found) return found;
    }
  }
  return undefined;
}

function findRatingBreakdown(value: Json | undefined): Record<string, number> | undefined {
  if (Array.isArray(value) && value.length >= 5 && value.every((entry) => Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'string')) {
    const entries = value as Array<[number, string]>;
    if (entries.some(([key]) => key >= 1 && key <= 5)) {
      return Object.fromEntries(entries.map(([key, rating]) => [`category_${key}`, Number(rating)]));
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRatingBreakdown(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findRatingBreakdown(item);
      if (found) return found;
    }
  }
  return undefined;
}

function findSelectedToken(value: Json, context?: { params: Record<string, string | number | boolean> }): string | undefined {
  if (typeof context?.params?.hotel_token === 'string' && context.params.hotel_token) return context.params.hotel_token;
  return collectStrings(value).find((text) => /^[A-Za-z0-9_-]{20,}$/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text));
}

function collectPhotos(value: Json): Array<{ url: string; sourceUrl?: string }> {
  const urls = unique(collectStrings(value).filter((text) => /^https?:\/\//.test(text) || text.startsWith('//')))
    .filter((url) => /(?:googleusercontent|gstatic|trvl-media|media\.vrbo|hostaway-platform)/.test(url))
    .filter((url) => !/branding|mapfiles|annotations/.test(url));
  return urls.slice(0, 30).map((url) => ({ url: normalizeUrl(url) }));
}

function collectAmenitySections(value: Json): Array<{ name: string; available: boolean; section: string }> {
  const amenities: Array<{ name: string; available: boolean; section: string }> = [];
  walk(value, (node) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string' || !Array.isArray(node[1])) return;
    const section = node[0];
    if (!/^(Amenities|Essential info)$/i.test(section)) return;
    for (const entry of node[1]) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean') {
        amenities.push({ name: entry[0], available: entry[1], section });
      }
    }
  });
  return uniqueBy(amenities, (item) => `${item.section}:${item.name}`);
}

function collectNearbyPlaces(value: Json, hotelName: string): Array<{ name: string; category?: string; rating?: number; reviewCount?: number; distance?: string }> {
  const nearby: Array<{ name: string; category?: string; rating?: number; reviewCount?: number; distance?: string }> = [];
  walk(value, (node) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string' || node[0] === hotelName) return;
    const category = typeof node[13] === 'string' ? node[13] : undefined;
    const rating = typeof node[5] === 'number' && node[5] <= 5 ? node[5] : undefined;
    const reviewCount = typeof node[6] === 'number' ? node[6] : undefined;
    const distance = node.find((item) => typeof item === 'string' && /(?:ft|mi)$/.test(item)) as string | undefined;
    if (category && (rating || reviewCount || distance || findCoordinatePair(node))) {
      nearby.push({ name: node[0], category, rating, reviewCount, distance });
    }
  });
  return uniqueBy(nearby, (item) => `${item.name}:${item.category}`).slice(0, 30);
}

function collectBookingOptions(value: Json): Array<{ provider: string; url?: string; displayedPrice?: string }> {
  const options: Array<{ provider: string; url?: string; displayedPrice?: string }> = [];
  walk(value, (node) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string') return;
    const strings = node.filter((item): item is string => typeof item === 'string');
    const url = strings.find((item) => item.includes('/travel/clk') || /^https?:\/\//.test(item));
    const displayedPrice = strings.find((item) => /^\$[\d,]+/.test(item));
    if ((url || displayedPrice) && /(?:\.com|Stays|Booking|Expedia|Vrbo|Hotels|Hyatt|Hilton)/i.test(node[0])) {
      options.push({ provider: node[0], url: url ? normalizeUrl(url) : undefined, displayedPrice });
    }
  });
  return uniqueBy(options, (item) => `${item.provider}:${item.url ?? item.displayedPrice ?? ''}`).slice(0, 20);
}

function walk(value: Json | undefined, visitor: (value: Json) => void): void {
  if (value === undefined) return;
  visitor(value);
  if (Array.isArray(value)) for (const item of value) walk(item, visitor);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, visitor);
}

function normalizeUrl(url: string): string {
  const cleaned = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\\//g, '/');
  return cleaned.startsWith('//') ? `https:${cleaned}` : cleaned;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(value);
  }
  return out;
}
