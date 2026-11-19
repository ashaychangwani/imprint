import { getWrbPayload, parseBatchExecuteEnvelope } from '../_shared/batchexecute-envelope.ts';

type LocationResult = {
  found: boolean;
  location: {
    id: string;
    location_type: number;
    airport_code: string | null;
    display_name: string;
    associated_city: { id: string | null; name: string | null };
    coordinates: { latitude: number; longitude: number } | null;
    images: string[];
    highlights: string | null;
    description: string | null;
    country_code: string | null;
    country_name: string | null;
  } | null;
};

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('http') ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(stringsIn);
}

export function extract(rawResponse: unknown): LocationResult {
  if (typeof rawResponse !== 'string' || rawResponse.trim() === '') {
    throw new Error('Empty Google Flights location-details response');
  }

  const payload = getWrbPayload(parseBatchExecuteEnvelope(rawResponse), 'tDoGIe');

  if (!Array.isArray(payload) || !Array.isArray(payload[1]) || !Array.isArray(payload[1][0])) {
    return { found: false, location: null };
  }
  const record = payload[1][0] as unknown[];
  const identity = Array.isArray(record[0]) ? record[0] : [];
  const associated = Array.isArray(record[2]) ? record[2] : [];
  const coordinates = Array.isArray(record[3]) ? record[3] : [];
  const id = typeof identity[0] === 'string' ? identity[0] : '';
  const locationType = typeof identity[1] === 'number' ? identity[1] : -1;
  const displayName = typeof record[1] === 'string' ? record[1] : '';
  if (!id || !displayName) return { found: false, location: null };

  return {
    found: true,
    location: {
      id,
      location_type: locationType,
      airport_code: locationType === 0 ? id : null,
      display_name: displayName,
      associated_city: {
        id: typeof associated[0] === 'string' ? associated[0] : null,
        name: typeof associated[1] === 'string' ? associated[1] : null,
      },
      coordinates: typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number'
        ? { latitude: coordinates[0], longitude: coordinates[1] }
        : null,
      images: stringsIn(associated[2]),
      highlights: typeof associated[3] === 'string' ? associated[3] : null,
      description: typeof associated[4] === 'string' ? associated[4] : null,
      country_code: typeof record[4] === 'string' ? record[4] : null,
      country_name: typeof record[6] === 'string' ? record[6] : null,
    },
  };
}
