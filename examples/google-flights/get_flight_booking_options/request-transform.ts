type Params = Record<string, string | number | boolean>;

interface Segment {
  origin: string;
  destination: string;
  date: string;
  airlineCode: string;
  flightNumber: string;
}

interface SelectionData {
  selectionToken: string;
  segments: Segment[];
  tripType: string;
}

const tripCodes: Record<string, number> = {
  round_trip: 1,
  roundtrip: 1,
  one_way: 2,
  oneway: 2,
  multi_city: 3,
  multicity: 3,
};

function parseSelection(value: unknown): SelectionData {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('selected_flights must be fresh selection_data from search_flights');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error('selected_flights must be serialized JSON selection_data');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('selected_flights is not an object');
  const candidate = parsed as Partial<SelectionData>;
  if (typeof candidate.selectionToken !== 'string' || candidate.selectionToken.length === 0) {
    throw new Error('selected_flights.selectionToken is required');
  }
  if (typeof candidate.tripType !== 'string' || !Array.isArray(candidate.segments) || candidate.segments.length === 0) {
    throw new Error('selected_flights requires tripType and ordered segments');
  }
  for (const segment of candidate.segments) {
    if (!segment || typeof segment !== 'object') throw new Error('selected_flights contains an invalid segment');
    for (const key of ['origin','destination','date','airlineCode','flightNumber'] as const) {
      if (typeof segment[key] !== 'string' || segment[key].length === 0) {
        throw new Error(`selected_flights segment.${key} is required`);
      }
    }
  }
  return candidate as SelectionData;
}

function leg(segment: Segment, index: number): unknown[] {
  return [
    [[[segment.origin, 0]]],
    [[[segment.destination, 0]]],
    null, 0, null, null, segment.date, null,
    [[segment.origin, segment.date, segment.destination, null, segment.airlineCode, segment.flightNumber]],
    null, null, null, null, null,
    index === 0 ? 3 : 1,
  ];
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: Params,
): { url: string; body: string } {
  void method;
  void responses;
  const input = params ?? {};
  const selection = parseSelection(input.selected_flights);
  const requestedTrip = String(input.trip_type ?? selection.tripType).toLowerCase();
  const selectedTrip = selection.tripType.toLowerCase();
  const requestedCode = tripCodes[requestedTrip];
  const selectedCode = tripCodes[selectedTrip];
  if (!requestedCode || !selectedCode) throw new Error('Unsupported trip_type in selection or request');
  if (requestedCode !== selectedCode) {
    throw new Error(`trip_type ${requestedTrip} does not match selected_flights.tripType ${selection.tripType}`);
  }
  const adults = Number(input.adults ?? 1);
  const children = Number(input.children ?? 0);
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    throw new Error('adults must be at least 1 and children must be non-negative integers');
  }
  const cabinClass = String(input.cabin_class ?? 'economy').toLowerCase();
  if (cabinClass !== 'economy') throw new Error('Only economy cabin_class is supported by the recording');
  const cabin = 1;

  const searchDefinition = [
    null, null, requestedCode, null, [], cabin,
    [adults, children, 0, 0],
    null, null, null, null, null, null,
    selection.segments.map(leg),
    null, null, null, 1,
  ];
  const rpc = [[null, selection.selectionToken], searchDefinition, null, 0];
  const envelope = [null, JSON.stringify(rpc)];
  return { url, body: 'f.req=' + encodeURIComponent(JSON.stringify(envelope)) + '&' };
}
