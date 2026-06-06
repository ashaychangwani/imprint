import { parseBatchExecute } from '../_shared/batchexecute.ts';

// Shape of one review-source "entry" in the ocp93e inner JSON (recording seq 497):
//   entry[0] = provider:  [ providerName, null, [iconUrl, w, h], code, count ]
//   entry[1] = review:    [ [reviewerName, profileLink, [avatarUrl, w, h]],
//                           dateText, [score, outOf], [[ [code, text, ...], ... ]],
//                           sourceLink, ... ]
// The entries list lives at root[0][0] (root = [[[ entry, entry, ... ]]]).

interface ParsedReview {
  reviewerName: string | null;
  profileLink: string | null;
  avatarUrl: string | null;
  date: string | null;
  ratingScore: number | null;
  ratingOutOf: number | null;
  texts: string[];
  sourceLink: string | null;
}

interface ParsedEntry {
  provider: {
    name: string | null;
    iconUrl: string | null;
    count: number | null;
  };
  review: ParsedReview;
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? (v as any[]) : [];
}

function looksLikeEntry(e: unknown): boolean {
  // entry[0] is the provider array whose first element is the provider name string.
  return (
    Array.isArray(e) &&
    Array.isArray((e as any[])[0]) &&
    typeof (e as any[])[0][0] === 'string'
  );
}

// The entries-list nesting depth is the one value the recording does not fully
// pin down, so locate the array whose elements have the entry shape rather than
// hardcoding root[0][0]. Falls back to a recursive search if the expected path
// does not match.
function findEntriesList(root: unknown): any[] {
  const direct = asArray(asArray(asArray(root)[0])[0]);
  if (direct.length > 0 && direct.some(looksLikeEntry)) return direct;

  let best: any[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || !Array.isArray(node)) return;
    const arr = node as any[];
    if (arr.length > 0 && arr.every(looksLikeEntry)) {
      if (arr.length > best.length) best = arr;
      return;
    }
    for (const child of arr) visit(child, depth + 1);
  };
  visit(root, 0);
  return best;
}

function parseEntry(entry: any[]): ParsedEntry {
  const provider = asArray(entry[0]);
  const review = asArray(entry[1]);
  const reviewer = asArray(review[0]);
  const rating = asArray(review[2]);

  // review[3] = [[ [code, text, null, text, ...], ... ]] -> collect text strings.
  const textGroups = asArray(asArray(review[3])[0]);
  const texts: string[] = [];
  for (const t of textGroups) {
    if (Array.isArray(t) && typeof t[1] === 'string' && t[1].trim() !== '') {
      texts.push(t[1]);
    }
  }

  return {
    provider: {
      name: typeof provider[0] === 'string' ? provider[0] : null,
      iconUrl: Array.isArray(provider[2]) && typeof provider[2][0] === 'string'
        ? provider[2][0]
        : null,
      count: typeof provider[4] === 'number' ? provider[4] : null,
    },
    review: {
      reviewerName: typeof reviewer[0] === 'string' ? reviewer[0] : null,
      profileLink: typeof reviewer[1] === 'string' ? reviewer[1] : null,
      avatarUrl: Array.isArray(reviewer[2]) && typeof reviewer[2][0] === 'string'
        ? reviewer[2][0]
        : null,
      date: typeof review[1] === 'string' && review[1] !== '' ? review[1] : null,
      ratingScore: typeof rating[0] === 'number' ? rating[0] : null,
      ratingOutOf: typeof rating[1] === 'number' ? rating[1] : null,
      texts,
      sourceLink: typeof review[4] === 'string' && review[4] !== '' ? review[4] : null,
    },
  };
}

export function extract(
  rawResponse: unknown,
  _context?: {
    params: Record<string, string | number | boolean>;
    responses: unknown[];
  },
): unknown {
  const raw =
    typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const root = parseBatchExecute(raw, 'ocp93e');
  if (root == null) return { reviews: [], count: 0 };

  const entries = findEntriesList(root);
  const reviews = entries
    .filter(looksLikeEntry)
    .map((e) => parseEntry(e as any[]))
    // Drop content-less placeholder rows (API no-match sentinel).
    .filter(
      (e) =>
        e.provider.name != null ||
        e.review.reviewerName != null ||
        e.review.texts.length > 0,
    );

  return { reviews, count: reviews.length };
}
