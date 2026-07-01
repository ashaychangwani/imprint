import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { FlightLocation } from '../_shared/google_flights_types.ts';

type Output = {
  locations: FlightLocation[];
  location?: FlightLocation;
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

function apiTypeToName(type: unknown): string {
  if (type === 0) return 'airport_code';
  if (type === 4) return 'city';
  if (type === 5) return 'google_place_id';
  return typeof type === 'number' ? `google_flights_type_${type}` : 'unknown';
}

function imageUrls(details: unknown[]): string[] {
  const images = asArray(details[2]) ?? [];
  const urls: string[] = [];
  for (const image of images) {
    const nested = asArray(image);
    const url = nested ? asString(nested[0]) : asString(image);
    if (url) urls.push(url);
  }
  return urls;
}

function parseLocation(record: unknown): FlightLocation | undefined {
  const item = asArray(record);
  if (!item) return undefined;

  const idPair = asArray(item[0]) ?? [];
  const id = asString(idPair[0]);
  const apiType = idPair[1];
  const displayName = asString(item[1]);
  const details = asArray(item[2]) ?? [];
  const coordinatesRaw = asArray(item[3]) ?? [];
  const lat = asNumber(coordinatesRaw[0]);
  const lng = asNumber(coordinatesRaw[1]);

  if (!id && !displayName) return undefined;

  const detailId = asString(details[0]);
  const detailName = asString(details[1]);
  const airportCode = apiType === 0 ? id : asString(details[5]);
  const placeId = id?.startsWith('/m/') ? id : detailId?.startsWith('/m/') ? detailId : undefined;

  const location: FlightLocation = {
    id: id ?? detailId ?? displayName ?? '',
    type: apiTypeToName(apiType),
    displayName: displayName ?? detailName ?? id ?? '',
  };

  if (detailName && detailName !== location.displayName) location.city = detailName;
  if (asString(item[6])) location.region = asString(item[6]);
  if (asString(details[3])) location.description = asString(details[3]);
  if (airportCode) location.airportCode = airportCode;
  if (placeId) location.placeId = placeId;
  if (lat !== undefined && lng !== undefined) location.coordinates = { lat, lng };

  const urls = imageUrls(details);
  if (urls.length > 0) location.imageUrls = urls;

  return location;
}

function payloadFromRaw(rawResponse: unknown): unknown {
  if (typeof rawResponse === 'string') {
    const records = extractWrbRecords(rawResponse).filter((record) => record.rpcid === 'tDoGIe');
    return parseNestedPayload(records[0]?.payload);
  }
  return parseNestedPayload(rawResponse);
}

export function extract(rawResponse: unknown): Output {
  const payload = payloadFromRaw(rawResponse);
  const root = asArray(payload) ?? [];
  const locationsRaw = asArray(root[1]) ?? [];
  const locations = locationsRaw
    .map(parseLocation)
    .filter((location): location is FlightLocation => Boolean(location && location.id && location.displayName));

  if (locations.length > 1) {
    const [primary, ...rest] = locations;
    if (primary) primary.nestedAirports = rest;
  }

  return {
    locations,
    location: locations[0],
  };
}
