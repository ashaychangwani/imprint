import {
  getWrbPayload,
  parseBatchExecuteEnvelope,
} from '../_shared/batchexecute-envelope.ts';

type LocationRecord = unknown[];

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapRecord(record: LocationRecord) {
  const type = typeof record[0] === 'number' ? record[0] : null;
  const airportCode = nullableString(record[5]) ?? nullableString(record[8]);
  const entityId = nullableString(record[4]);
  const locationId = type === 1 && airportCode ? airportCode : entityId;
  const typeLabels: Record<number, string> = {
    1: 'airport',
    3: 'city_or_locality',
    4: 'region_or_county',
  };

  return {
    location_type: type,
    location_type_label: type === null ? null : (typeLabels[type] ?? null),
    display_name: nullableString(record[1]),
    city_or_region: nullableString(record[2]),
    description: nullableString(record[3]),
    entity_id: entityId,
    airport_code: airportCode,
    location_id: locationId,
    relevance_score: typeof record[12] === 'number' ? record[12] : null,
  };
}

export function extract(rawResponse: unknown): unknown {
  if (typeof rawResponse !== 'string' || rawResponse.trim().length === 0) {
    throw new Error('Empty Google Flights location-search response');
  }

  const payload = getWrbPayload(parseBatchExecuteEnvelope(rawResponse), 'H028ib');
  // The decoded service payload wraps the ranked list once: payload[0].
  const ranked = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];

  const rankedMatches = ranked.flatMap((entry) => {
    if (!Array.isArray(entry) || !Array.isArray(entry[0])) return [];
    const primary = mapRecord(entry[0]);
    if (!primary.display_name && !primary.location_id) return [];

    const nearby = Array.isArray(entry[1])
      ? entry[1].flatMap((nearbyEntry) => {
          if (!Array.isArray(nearbyEntry) || !Array.isArray(nearbyEntry[0])) return [];
          const airport = mapRecord(nearbyEntry[0]);
          if (!airport.display_name && !airport.location_id) return [];
          return [{ ...airport, distance: nullableString(nearbyEntry[1]) }];
        })
      : [];

    return [{ ...primary, nearby_airports: nearby }];
  });

  return { ranked_matches: rankedMatches };
}
