// Parser for autocomplete_hotel_location (Google Hotels mejVKc autocomplete).
// Decodes the batchexecute anti-XSSI envelope via the shared helper, then maps
// the inner suggestion list into clean named-field objects.
//
// Inner JSON shape (seq 222 / seq 2550):
//   [ [ <entry>, <entry>, ... ], <trailing-meta> ]
// Each <entry> is positional:
//   [0]  number  1 = place/hotel suggestion, 0 = map/other suggestion
//   [1]  string  suggested query text (e.g. "chicago loop hotels")
//   [5]  array   bolded match segments: [ [text, isBold], ... ]
//   [7]  array   id container; [7][0] is the place id triple [a,b,c]
//   [11] string  repeats the suggested query text

import { parseBatchExecute } from '../_shared/batchexecute.ts';

interface Segment {
  text: string;
  bold: boolean;
}

interface Suggestion {
  query: string;
  segments: Segment[];
  id: number[] | null;
  isPlaceSuggestion: boolean;
}

export function extract(
  rawResponse: unknown,
  context?: {
    params: Record<string, string | number | boolean>;
    responses: unknown[];
  },
): unknown {
  const raw =
    typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

  const inner = parseBatchExecute(raw, 'mejVKc');
  const list: any[] =
    Array.isArray(inner) && Array.isArray(inner[0]) ? inner[0] : [];

  const suggestions: Suggestion[] = list
    .filter(
      (e: any) =>
        Array.isArray(e) && typeof e[1] === 'string' && e[1].length > 0,
    )
    .map((e: any) => {
      const segments: Segment[] = Array.isArray(e[5])
        ? e[5]
            .filter((s: any) => Array.isArray(s))
            .map((s: any) => ({ text: String(s[0] ?? ''), bold: Boolean(s[1]) }))
        : [];
      const id =
        Array.isArray(e[7]) && Array.isArray(e[7][0])
          ? (e[7][0] as number[])
          : null;
      return {
        query: e[1] as string,
        segments,
        id,
        isPlaceSuggestion: e[0] === 1,
      };
    });

  const queryParam =
    context?.params && typeof context.params.query !== 'undefined'
      ? String(context.params.query)
      : null;

  return { query: queryParam, suggestions };
}
