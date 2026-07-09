type BatchedFrame = unknown[];

type Photo = {
  category: number | null;
  order: number | null;
  photoId: number | null;
  urls: string[];
  requestedWidth: number | null;
  requestedHeight: number | null;
};

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function unwrapBatchedResponse(rawResponse: unknown): unknown {
  if (Array.isArray(rawResponse)) return rawResponse;
  if (typeof rawResponse !== 'string') return rawResponse;

  const lines = rawResponse.split('\n').filter((line) => line.trim() && line.trim() !== ")]}'");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed) as BatchedFrame[];
      if (Array.isArray(parsed)) {
        const frame = parsed.find((entry) => entry?.[0] === 'wrb.fr' && entry?.[1] === 'zM1L7d');
        if (frame && typeof frame[2] === 'string') return JSON.parse(frame[2]);
      }
    } catch {
      // Batchexecute responses can contain trailing non-target frames; keep scanning.
    }
  }
  return [];
}

function parseSizeFromUrl(url: string): { width: number | null; height: number | null } {
  const match = url.match(/[=\-]w(\d+)-h(\d+)/);
  return {
    width: match ? Number(match[1]) : null,
    height: match ? Number(match[2]) : null,
  };
}

function isPhotoEntry(value: unknown): value is unknown[] {
  return Array.isArray(value) && Array.isArray(value[4]) && value[4].some((item) => typeof item === 'string');
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const payload = parseJsonMaybe(unwrapBatchedResponse(rawResponse));
  const entries = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  const requestedFallback = Number(context?.params?.image_size ?? 0) || null;

  const photos: Photo[] = entries.filter(isPhotoEntry).map((entry) => {
    const urls = (entry[4] as unknown[]).filter((url): url is string => typeof url === 'string' && url.length > 0);
    const size = parseSizeFromUrl(urls[0] ?? '');
    return {
      category: typeof entry[0] === 'number' ? entry[0] : null,
      order: typeof entry[1] === 'number' ? entry[1] : null,
      photoId: typeof entry[3] === 'number' ? entry[3] : null,
      urls,
      requestedWidth: size.width ?? requestedFallback,
      requestedHeight: size.height ?? requestedFallback,
    };
  }).filter((photo) => photo.photoId !== null || photo.urls.length > 0);

  return {
    photos,
    count: photos.length,
  };
}
