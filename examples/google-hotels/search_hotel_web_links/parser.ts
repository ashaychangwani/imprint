type BatchexecuteFrame = unknown[];

type WebLink = {
  title: string;
  url: string;
  snippet: string;
  breadcrumb: string[];
  faviconDataUri?: string;
};

function stripXssi(raw: string): string {
  return raw.replace(/^\)\]\}'\n\n?/, '').trim();
}

function cleanSnippet(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\u003c\/?b\\u003e/g, '')
    .replace(/<\/?b>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFrames(rawResponse: unknown): BatchexecuteFrame[] {
  if (Array.isArray(rawResponse)) return [rawResponse];
  if (typeof rawResponse !== 'string') return [];

  const frames: BatchexecuteFrame[] = [];
  const lines = stripXssi(rawResponse).split('\n').map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) frames.push(parsed);
    } catch {
      // Ignore batchexecute length lines and malformed telemetry tails.
    }
  }

  return frames;
}

function extractPayload(rawResponse: unknown): unknown[] {
  const frames = parseFrames(rawResponse);
  for (const frame of frames) {
    for (const entry of frame) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== 'bdmBfe') continue;
      const payload = entry[2];
      if (typeof payload !== 'string') continue;
      try {
        const parsed = JSON.parse(payload);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

function toBreadcrumb(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const crumbs = value[5];
  if (!Array.isArray(crumbs)) return [];
  return crumbs.filter((part): part is string => typeof part === 'string' && part.length > 0);
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const payload = extractPayload(rawResponse);
  const records = Array.isArray(payload[0]) ? payload[0] : [];
  const requestedLimit = Number(context?.params?.limit ?? 0);

  const links: WebLink[] = records
    .filter(Array.isArray)
    .map((record) => {
      const title = typeof record[0] === 'string' ? record[0].trim() : '';
      const url = typeof record[1] === 'string' ? record[1].trim() : '';
      const snippet = cleanSnippet(record[2]);
      const breadcrumb = toBreadcrumb(record[5]);
      const faviconDataUri = typeof record[6] === 'string' && record[6].startsWith('data:image/') ? record[6] : undefined;
      return { title, url, snippet, breadcrumb, faviconDataUri };
    })
    .filter((link) => link.title || link.url)
    .slice(0, requestedLimit > 0 ? requestedLimit : undefined);

  return {
    hotelName: typeof context?.params?.hotel_name === 'string' ? context.params.hotel_name : undefined,
    count: links.length,
    links,
  };
}
