import { decodeBatchExecuteResponse, findBatchPayload } from '../_shared/google_travel_batchexecute.ts';

type Coordinate = { latitude: number; longitude: number };

const EMPTY_RESULT = {
  destinations: [],
  place_boundaries: {},
  places: [],
  count: 0,
};

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === 'number' && Number.isFinite(value[0]) &&
    typeof value[1] === 'number' && Number.isFinite(value[1]) &&
    value[0] >= -90 && value[0] <= 90 && value[1] >= -180 && value[1] <= 180;
}

function collectSequences(value: unknown, out: Coordinate[][]): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 3 && value.every(isCoordinatePair)) {
    out.push(value.map(([latitude, longitude]) => ({ latitude, longitude })));
    return;
  }
  for (const child of value) collectSequences(child, out);
}

export function extract(rawResponse: unknown): unknown {
  const body = typeof rawResponse === 'string' ? rawResponse : '';
  if (!body.trim()) return EMPTY_RESULT;

  let payload: unknown;
  try {
    payload = findBatchPayload(decodeBatchExecuteResponse(body), 'FCE32b');
  } catch {
    return EMPTY_RESULT;
  }

  const root = Array.isArray(payload) ? payload : [];
  const destinationRows = Array.isArray(root[0]) ? root[0] : [];
  const destinations = destinationRows.flatMap((row): unknown[] => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) return [];
    const destinationId = row[0];
    const boundaries = row[1].flatMap((entry): unknown[] => {
      if (!Array.isArray(entry) || !Array.isArray(entry[0]) || entry[0].length < 2) return [];
      const [mode, radius] = entry[0];
      if (typeof mode !== 'number' || typeof radius !== 'number') return [];
      const sequences: Coordinate[][] = [];
      collectSequences(entry[1], sequences);
      const centerPair = isCoordinatePair(entry[3]) ? entry[3] : undefined;
      if (sequences.length === 0) return [];
      return [{
        scale: { mode, radius },
        center: centerPair ? { latitude: centerPair[0], longitude: centerPair[1] } : null,
        geometry: sequences,
      }];
    });
    if (boundaries.length === 0) return [];
    return [{ destination_id: destinationId, boundaries }];
  });

  const places = destinations.map((destination) => {
    const typed = destination as {
      destination_id: string;
      boundaries: Array<{
        scale: { mode: number; radius: number };
        center: Coordinate | null;
        geometry: Coordinate[][];
      }>;
    };
    const firstCenter = typed.boundaries.find((boundary) => boundary.center)?.center ?? {
      latitude: null,
      longitude: null,
    };
    return {
      place_id: typed.destination_id,
      center: firstCenter,
      geometry_groups: typed.boundaries.map((boundary) => ({
        zoom: boundary.scale.mode,
        radius: boundary.scale.radius,
        coordinates: boundary.geometry.map((sequence) => (
          sequence.map((coordinate) => [coordinate.latitude, coordinate.longitude])
        )),
        coordinateCount: boundary.geometry.reduce((sum, sequence) => sum + sequence.length, 0),
      })),
    };
  });
  return {
    destinations,
    place_boundaries: Object.fromEntries(places.map((place) => [place.place_id, place])),
    places,
    count: places.length,
  };
}
