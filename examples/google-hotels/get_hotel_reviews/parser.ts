type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Review = {
  source: string;
  sourceIconUrl?: string;
  sourceId?: number;
  sourceReviewCount?: number;
  reviewerName: string;
  reviewerUrl?: string;
  reviewerImageUrl?: string;
  relativeTime?: string;
  rating?: number;
  ratingScale?: number;
  text?: string;
  summary?: string;
  reviewUrl?: string;
  reviewId?: string;
  ownerResponse?: { text: string; relativeTime?: string };
  highlights?: string[];
  categories?: Array<{ name: string; text: string }>;
  photos?: Array<{ url: string; width?: number; height?: number; caption?: string }>;
  reportUrl?: string;
};

type Photo = { url: string; width?: number; height?: number; caption?: string };

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/\\u003cbr\\u003e/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseBatchExecute(rawResponse: unknown): unknown {
  if (typeof rawResponse !== 'string') return rawResponse;
  const lines = rawResponse.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('[[')) continue;
    try {
      const frame = JSON.parse(line) as unknown[];
      const entry = asArray(frame[0]);
      if (entry[0] === 'wrb.fr' && entry[1] === 'ocp93e') {
        const payload = asString(entry[2]);
        return payload ? JSON.parse(payload) : [];
      }
    } catch {
      // Ignore non-payload diagnostic frames.
    }
  }
  return [];
}

function extractReviewText(parts: unknown): { text?: string; summary?: string } {
  const sectionTexts: string[] = [];
  const sectionSummaries: string[] = [];
  for (const group of asArray(parts)) {
    for (const item of asArray(group)) {
      const fields = asArray(item);
      const full = asString(fields[3]) ?? asString(fields[1]);
      const summary = asString(fields[1]);
      if (full) sectionTexts.push(decodeHtml(full));
      if (summary) sectionSummaries.push(decodeHtml(summary));
    }
  }
  return {
    text: sectionTexts.filter(Boolean).join('\n\n') || undefined,
    summary: sectionSummaries.filter(Boolean).join('\n\n') || undefined,
  };
}

function extractOwnerResponse(value: unknown): { text: string; relativeTime?: string } | undefined {
  const response = asArray(value);
  const paragraphs = asArray(response[0]).map((part) => asString(part)).filter((part): part is string => Boolean(part));
  if (paragraphs.length === 0) return undefined;
  return {
    text: paragraphs.map(decodeHtml).join('\n\n'),
    relativeTime: asString(response[1]),
  };
}

function extractHighlights(value: unknown): string[] | undefined {
  const data = asArray(value);
  const labels = asArray(data[1]).map((part) => asString(part)).filter((part): part is string => Boolean(part));
  return labels.length > 0 ? labels : undefined;
}

function extractCategories(value: unknown): Array<{ name: string; text: string }> | undefined {
  const categories = asArray(value)
    .map((entry) => {
      const item = asArray(entry);
      const name = asString(item[0]);
      const text = asString(item[1]);
      return name && text ? { name, text: decodeHtml(text) } : undefined;
    })
    .filter((item): item is { name: string; text: string } => Boolean(item));
  return categories.length > 0 ? categories : undefined;
}

function extractPhotoCaption(entry: unknown[]): string | undefined {
  const metadata = asArray(entry[17]);
  const descriptionBlock = asArray(metadata[3]);
  const labels = asArray(descriptionBlock[5]);
  return asString(labels[0]);
}

function extractPhotos(value: unknown): Photo[] | undefined {
  const photos = asArray(value)
    .map((entry): Photo | undefined => {
      const item = asArray(entry);
      const url = asString(item[0]);
      if (!url) return undefined;
      return {
        url,
        width: typeof item[1] === 'number' ? item[1] : undefined,
        height: typeof item[2] === 'number' ? item[2] : undefined,
        caption: extractPhotoCaption(item),
      };
    })
    .filter((item): item is Photo => Boolean(item));
  return photos.length > 0 ? photos : undefined;
}

function mapReview(record: unknown): Review | undefined {
  const row = asArray(record);
  const provider = asArray(row[0]);
  const review = asArray(row[1]);
  const source = asString(provider[0]);
  const reviewer = asArray(review[0]);
  const reviewerName = asString(reviewer[0]);
  if (!source || !reviewerName) return undefined;

  const reviewerImage = asArray(reviewer[2]);
  const rating = asArray(review[2]);
  const text = extractReviewText(review[3]);
  const sourceIcon = asArray(provider[2]);

  return {
    source,
    sourceIconUrl: asString(sourceIcon[0]),
    sourceId: typeof provider[3] === 'number' ? provider[3] : undefined,
    sourceReviewCount: typeof provider[4] === 'number' ? provider[4] : undefined,
    reviewerName,
    reviewerUrl: asString(reviewer[1]),
    reviewerImageUrl: asString(reviewerImage[0]),
    relativeTime: asString(review[1]),
    rating: typeof rating[0] === 'number' ? rating[0] : undefined,
    ratingScale: typeof rating[1] === 'number' ? rating[1] : undefined,
    text: text.text,
    summary: text.summary,
    reviewUrl: asString(review[4]),
    ownerResponse: extractOwnerResponse(review[5]),
    reviewId: asString(review[8]),
    highlights: extractHighlights(review[15]),
    categories: extractCategories(review[16]),
    photos: extractPhotos(review[14]),
    reportUrl: asString(row[2]),
  };
}

function getPayloadRoot(parsed: unknown): unknown[] {
  return asArray(asArray(parsed)[0]);
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const parsed = parseBatchExecute(rawResponse) as Json;
  const root = getPayloadRoot(parsed);
  const reviewRows = asArray(root[0]);
  const reviews = reviewRows.map(mapReview).filter((review): review is Review => Boolean(review));
  const nextPageToken = asString(root[5]);

  return {
    hotelToken: typeof context?.params?.hotel_token === 'string' ? context.params.hotel_token : undefined,
    reviewCount: reviews.length,
    nextPageToken,
    reviews,
    sources: Array.from(new Map(reviews.map((review) => [review.source, {
      name: review.source,
      iconUrl: review.sourceIconUrl,
      sourceId: review.sourceId,
      sourceReviewCount: review.sourceReviewCount,
    }])).values()),
  };
}
