type GeometryGroup = {
  zoom: number | null;
  radius: number | null;
  coordinates: unknown;
  coordinateCount: number;
};
type BoundaryRecord = {
  place_id: string;
  center: { latitude: number | null; longitude: number | null };
  geometry_groups: GeometryGroup[];
};

type ExtractContext = {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
};

function firstJsonArrayText(text: string): string {
  const start = text.indexOf('[');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

function parseFrameBody(rawResponse: unknown): unknown {
  if (Array.isArray(rawResponse)) return rawResponse;
  if (typeof rawResponse !== 'string') return rawResponse;

  let text = rawResponse.trimStart();
  if (text.startsWith(")]}'")) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1).trimStart() : '';
  }
  const frames = JSON.parse(firstJsonArrayText(text)) as unknown[];
  const frame = frames.find((candidate) => {
    return Array.isArray(candidate) && candidate[0] === 'wrb.fr' && candidate[1] === 'FCE32b';
  }) as unknown[] | undefined;
  if (!frame || typeof frame[2] !== 'string') return [];
  return JSON.parse(frame[2]);
}

function countCoordinates(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return 1;
  }
  return value.reduce((sum, child) => sum + countCoordinates(child), 0);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseGeometryGroup(group: unknown): GeometryGroup | null {
  if (!Array.isArray(group)) return null;
  const key = Array.isArray(group[0]) ? group[0] : [];
  const coordinates = group[1] ?? [];
  const coordinateCount = countCoordinates(coordinates);
  if (coordinateCount === 0) return null;
  return {
    zoom: asNumber(key[0]),
    radius: asNumber(key[1]),
    coordinates,
    coordinateCount,
  };
}

export function extract(rawResponse: unknown, context?: ExtractContext): unknown {
  const payload = parseFrameBody(rawResponse);
  const records = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  const center = {
    latitude: asNumber(context?.params?.latitude),
    longitude: asNumber(context?.params?.longitude),
  };

  const placeBoundaries: Record<string, BoundaryRecord> = {};
  for (const record of records) {
    if (!Array.isArray(record)) continue;
    const placeId = typeof record[0] === 'string' ? record[0] : '';
    if (!placeId) continue;
    const groups = Array.isArray(record[1]) ? record[1] : [];
    const geometryGroups = groups
      .map(parseGeometryGroup)
      .filter((group): group is GeometryGroup => group !== null);
    if (geometryGroups.length === 0) continue;
    placeBoundaries[placeId] = {
      place_id: placeId,
      center,
      geometry_groups: geometryGroups,
    };
  }

  return {
    place_boundaries: placeBoundaries,
    places: Object.values(placeBoundaries),
    count: Object.keys(placeBoundaries).length,
  };
}
