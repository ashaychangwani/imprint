type HighlightSegment = {
  text: string;
  matched: boolean;
};

type Suggestion = {
  text: string;
  canonicalQuery: string;
  typeCode: number;
  suggestionType: string;
  highlightedParts: HighlightSegment[];
  placeId?: string;
  hotelId?: string;
  displayAddress?: string;
  thumbnailUrl?: string;
  resultToken?: number[];
};

type Extracted = {
  query?: string;
  previousQuery?: string;
  count: number;
  suggestions: Suggestion[];
};

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseBatchedResponse(raw: unknown): unknown[] {
  const parsed = parseMaybeJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'string') return [];

  const lines = parsed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ")]}'" && !/^\d+$/.test(line));

  for (const line of lines) {
    if (!line.startsWith('[')) continue;
    try {
      const candidate = JSON.parse(line);
      if (Array.isArray(candidate)) return candidate;
    } catch {
      // Continue scanning length-prefixed chunks.
    }
  }

  return [];
}

function classifySuggestion(typeCode: number, placeId?: string, hotelId?: string): string {
  if (hotelId) return 'hotel';
  if (placeId) return 'place';
  if (typeCode === 0) return 'map_query';
  if (typeCode === 1) return 'lodging_query';
  return 'query';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nums = value.filter((item): item is number => typeof item === 'number');
  return nums.length > 0 ? nums : undefined;
}

function extractSuggestions(payload: unknown): Suggestion[] {
  if (!Array.isArray(payload)) return [];

  const rpc = payload.find((entry) => Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === 'mejVKc');
  const innerPayload = Array.isArray(rpc) ? parseMaybeJson(rpc[2]) : payload;
  if (!Array.isArray(innerPayload)) return [];

  const rows = Array.isArray(innerPayload[0]) ? innerPayload[0] : [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => {
      const typeCode = typeof row[0] === 'number' ? row[0] : -1;
      const text = asString(row[1]) ?? '';
      const thumbnailUrl = asString(row[3]);
      const displayAddress = asString(row[4]);
      const placeId = asString(row[6]);
      const tokenContainer = Array.isArray(row[7]) ? row[7][0] : undefined;
      const hotelId = asString(row[9]);
      const canonicalQuery = asString(row[11]) ?? text;
      const highlightedParts = Array.isArray(row[5])
        ? row[5]
            .filter((part): part is unknown[] => Array.isArray(part))
            .map((part) => ({
              text: String(part[0] ?? ''),
              matched: Boolean(part[1]),
            }))
            .filter((part) => part.text.length > 0)
        : [];

      return {
        text,
        canonicalQuery,
        typeCode,
        suggestionType: classifySuggestion(typeCode, placeId, hotelId),
        highlightedParts,
        ...(placeId ? { placeId } : {}),
        ...(hotelId ? { hotelId } : {}),
        ...(displayAddress ? { displayAddress } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(asNumberArray(tokenContainer) ? { resultToken: asNumberArray(tokenContainer) } : {}),
      };
    })
    .filter((item) => item.text.length > 0 || item.canonicalQuery.length > 0 || Boolean(item.placeId) || Boolean(item.hotelId));
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): Extracted {
  const payload = parseBatchedResponse(rawResponse);
  const limitParam = context?.params.limit;
  const limit = typeof limitParam === 'number' && Number.isFinite(limitParam) && limitParam > 0
    ? Math.floor(limitParam)
    : undefined;
  const suggestions = extractSuggestions(payload).slice(0, limit);

  return {
    query: typeof context?.params.query === 'string' ? context.params.query : undefined,
    previousQuery: typeof context?.params.previous_query === 'string' ? context.params.previous_query : undefined,
    count: suggestions.length,
    suggestions,
  };
}
