type Ctx = { params: Record<string, string | number | boolean>; responses: unknown[] };

function decode(raw: unknown): unknown[] {
  if (raw == null) return [];
  if (typeof raw !== 'string') return [raw];
  const out: unknown[] = [];
  for (const line of raw.replace(/^\)\]\}'\s*/, '').split(/\n/)) {
    if (!line.startsWith('[[')) continue;
    try {
      const frame = JSON.parse(line);
      for (const row of Array.isArray(frame) ? frame : []) {
        if (Array.isArray(row) && row[0] === 'wrb.fr' && typeof row[2] === 'string') {
          try { out.push(JSON.parse(row[2])); } catch {}
        }
      }
    } catch {}
  }
  return out;
}

function walk(value: unknown, strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value);
    if (/^[\[{]/.test(value)) try { walk(JSON.parse(value), strings); } catch {}
    return;
  }
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') for (const child of Object.values(value as Record<string, unknown>)) walk(child, strings);
    return;
  }
  for (const child of value) walk(child, strings);
}

const unique = <T>(values: T[]) => [...new Set(values)];
const normalize = (s: string) => s.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/<br\s*\/?\s*>/gi, '\n');

export function extract(rawResponse: unknown, context?: Ctx): unknown {
  const raws = context?.responses?.length ? context.responses : [rawResponse];
  const scoped = raws.map(raw => {
    const strings: string[] = [];
    for (const payload of decode(raw)) walk(payload, strings);
    return { strings: strings.map(normalize) };
  });
  const allStrings = scoped.flatMap(group => group.strings);
  const decodedPayloadCount = scoped.reduce((total, group) => total + group.strings.length, 0);
  const detailStrings = scoped[0]?.strings ?? [];
  const photoStrings = scoped[1]?.strings ?? [];
  const reviewStrings = scoped[2]?.strings ?? [];
  const webStrings = scoped[3]?.strings ?? [];

  const photos = unique(photoStrings.filter(s =>
    /^https:\/\/lh3\.googleusercontent\.com\/(?:gps-cs-s|grass-cs)\//.test(s) &&
    !/[=]s(?:40|120)-c/.test(s)
  ));
  const reviewTexts = unique(reviewStrings.filter(s =>
    s.length >= 120 && s.length <= 3000 &&
    !s.startsWith('http') && !s.startsWith('//') && !s.startsWith('data:') &&
    !s.includes('/local/content/rap/') && !s.includes('/aclk?') &&
    ['stay', 'room', 'hotel', 'staff', 'location', 'service'].some(term => s.toLowerCase().includes(term))
  )).slice(0, 20);
  const relatedLinks = unique(webStrings.filter(s =>
    /^https?:\/\//.test(s) &&
    !s.includes('google.com/') && !s.includes('googleusercontent.com') &&
    !s.includes('doubleclick.net') && !s.includes('adssettings')
  ));
  const address = detailStrings.find(s =>
    s.length >= 8 &&
    s.length <= 240 &&
    /\d/.test(s) &&
    !/^https?:\/\//.test(s) &&
    (s.includes(',') || /\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|platz|strasse|straße|rue|via|calle|ulica)\b/i.test(s))
  );
  const phone = detailStrings.find(s =>
    /^\+?[\d\s().-]{7,25}(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(s)
  );
  const hotelId = typeof context?.params?.hotel_id === 'string' ? context.params.hotel_id : undefined;
  const requestedName = typeof context?.params?.hotel_name === 'string' ? context.params.hotel_name : undefined;

  if (
    decodedPayloadCount === 0 ||
    (!address && !phone && photos.length === 0 && reviewTexts.length === 0 && relatedLinks.length === 0)
  ) {
    throw new Error('HOTEL_DETAILS_UNPARSED: Google returned no recognizable hotel detail payload');
  }
  return {
    hotel: {
      id: hotelId,
      name: undefined,
      requested_name: requestedName,
      address,
      phone,
      coordinates: undefined,
    },
    photos: photos.map(url => ({ url })),
    photo_count: photos.length,
    reviews: reviewTexts.map(text => ({ text })),
    related_links: relatedLinks.map(url => ({ url })),
    sections: unique(allStrings.filter(s => ['Overview','Prices','Reviews','Photos','About','Amenities','Policies','Hotel highlights'].includes(s))),
  };
}
