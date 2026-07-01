import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { FlightLocation } from '../_shared/google_flights_types.ts';

type LookupResult = {
  query?: string;
  items: FlightLocation[];
};

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function typeName(typeCode: unknown): string {
  switch (typeCode) {
    case 1:
      return 'airport';
    case 3:
      return 'city';
    case 4:
      return 'region';
    case 5:
      return 'station';
    default:
      return `type_${String(typeCode ?? 'unknown')}`;
  }
}

function parseTuple(tuple: unknown, distanceText?: unknown): (FlightLocation & { score?: number; distance?: string }) | null {
  const values = asArray(tuple);
  if (!values) return null;

  const type = typeName(values[0]);
  const displayName = asString(values[1]);
  const secondaryName = asString(values[2]);
  const description = asString(values[3]);
  const placeId = asString(values[4]);
  const airportCode = asString(values[5]) ?? asString(values[8]);
  const id = airportCode ?? placeId ?? displayName;

  if (!id || !displayName) return null;

  const location: FlightLocation & { score?: number; distance?: string } = {
    id,
    type,
    displayName,
  };

  if (type === 'region') {
    if (secondaryName) location.region = secondaryName;
  } else if (secondaryName) {
    location.city = secondaryName;
  }
  if (description) location.description = description;
  if (airportCode) location.airportCode = airportCode;
  if (placeId) location.placeId = placeId;
  const score = asNumber(values[12]);
  if (score !== undefined) location.score = score;
  const distance = asString(distanceText);
  if (distance) location.distance = distance;

  return location;
}

function parseNestedAirports(value: unknown): FlightLocation[] | undefined {
  const options = asArray(value);
  if (!options) return undefined;

  const nested = options
    .map((option) => {
      const parts = asArray(option);
      if (!parts) return null;
      return parseTuple(parts[0], parts[1]);
    })
    .filter((item): item is FlightLocation => Boolean(item));

  return nested.length > 0 ? nested : undefined;
}

function unwrapRows(payload: unknown): unknown[] {
  let parsed = payload;
  for (let i = 0; i < 4; i += 1) {
    parsed = parseNestedPayload(parsed);
  }

  const top = asArray(parsed);
  return asArray(top?.[0]) ?? [];
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): LookupResult {
  const query = typeof context?.params?.query === 'string' ? context.params.query : undefined;

  if (typeof rawResponse !== 'string') {
    const rows = unwrapRows(rawResponse);
    return {
      query,
      items: rows.map(parseRow).filter((item): item is FlightLocation => Boolean(item)),
    };
  }

  const records = extractWrbRecords(rawResponse);
  const record = records.find((entry) => entry.rpcid === 'H028ib');
  if (!record) {
    throw new Error('Google Flights location lookup response did not include H028ib wrb.fr data');
  }

  const rows = unwrapRows(record.rawPayload ?? record.payload);
  return {
    query,
    items: rows.map(parseRow).filter((item): item is FlightLocation => Boolean(item)),
  };
}

function parseRow(row: unknown): FlightLocation | null {
  const parts = asArray(row);
  if (!parts) return null;

  const location = parseTuple(parts[0]);
  if (!location) return null;

  const nestedAirports = parseNestedAirports(parts[1]);
  if (nestedAirports) location.nestedAirports = nestedAirports;

  return location;
}
