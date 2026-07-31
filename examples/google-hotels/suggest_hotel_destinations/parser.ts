import {
  decodeBatchExecuteResponse,
  findBatchPayload,
} from '../_shared/google_travel_batchexecute.ts';

interface ExtractContext {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
}

interface MatchedSegment {
  text: string;
  isCompletion: boolean;
}

export function extract(rawResponse: unknown, context?: ExtractContext): unknown {
  if (typeof rawResponse !== 'string') {
    return {
      items: [],
      suggestions: [],
      count: 0,
      error: { code: 'INVALID_RESPONSE', message: 'Expected a batchexecute text response.' },
    };
  }

  try {
    const payload = findBatchPayload(decodeBatchExecuteResponse(rawResponse), 'mejVKc');
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
      throw new Error('mejVKc payload has an unexpected shape');
    }

    const requestedMax = Number(context?.params.max_results ?? 0);
    const requestedLimit = Number(context?.params.limit ?? 0);
    const maxResults = requestedMax > 0
      ? Math.floor(requestedMax)
      : requestedLimit > 0
        ? Math.floor(requestedLimit)
        : 15;

    const items = payload[0]
      .filter((item): item is unknown[] => Array.isArray(item) && typeof item[1] === 'string' && item[1].length > 0)
      .map((item) => {
        const displayText = item[1] as string;
        const normalizedQuery = typeof item[11] === 'string' ? item[11] : displayText;
        const typeCode = typeof item[0] === 'number' ? item[0] : -1;
        const placeId = typeof item[6] === 'string' ? item[6] : null;
        const hotelId = typeof item[9] === 'string' ? item[9] : null;
        const tokenContainer = Array.isArray(item[7]) ? item[7][0] : null;
        const resultToken = Array.isArray(tokenContainer)
          ? tokenContainer.filter((value): value is number => typeof value === 'number')
          : [];
        const matchedSegments = Array.isArray(item[5])
          ? item[5].filter(Array.isArray).map((segment): MatchedSegment => ({
              text: typeof segment[0] === 'string' ? segment[0] : '',
              isCompletion: segment[1] === true,
            })).filter((segment) => segment.text.length > 0)
          : [];
        const suggestionType = hotelId
          ? 'hotel'
          : placeId
            ? 'place'
            : typeCode === 0
              ? 'map_query'
              : typeCode === 1
                ? 'lodging_query'
                : 'query';
        return {
          displayText,
          normalizedQuery,
          suggestionType,
          typeCode,
          matchedSegments,
          identifier: placeId ?? hotelId,
          subtitle: typeof item[4] === 'string' ? item[4] : null,
          thumbnailUrl: typeof item[3] === 'string' ? item[3] : null,
          // Backward-compatible field names.
          text: displayText,
          canonicalQuery: normalizedQuery,
          highlightedParts: matchedSegments.map((segment) => ({
            text: segment.text,
            matched: segment.isCompletion,
          })),
          ...(placeId ? { placeId } : {}),
          ...(hotelId ? { hotelId } : {}),
          ...(typeof item[4] === 'string' ? { displayAddress: item[4] } : {}),
          ...(typeof item[3] === 'string' ? { thumbnailUrl: item[3] } : {}),
          ...(resultToken.length ? { resultToken } : {}),
        };
      })
      .slice(0, maxResults);

    return {
      query: typeof context?.params.query === 'string' ? context.params.query : null,
      previousQuery: typeof context?.params.previous_query === 'string'
        ? context.params.previous_query
        : null,
      items,
      suggestions: items,
      count: items.length,
    };
  } catch (error) {
    return {
      items: [],
      suggestions: [],
      count: 0,
      error: {
        code: 'PARSE_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
