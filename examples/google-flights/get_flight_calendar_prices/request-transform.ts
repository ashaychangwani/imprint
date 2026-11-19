type Params = Record<string, string | number | boolean>;

function requiredString(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function airportCode(params: Params, name: string): string {
  const value = requiredString(params, name).toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new Error(`${name} must be a three-letter airport code`);
  return value;
}

function isoDate(params: Params, name: string): string {
  const value = requiredString(params, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const normalized = new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10);
  if (normalized !== value) throw new Error(`${name} must be a real calendar date`);
  return value;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params: Params = {},
): { url: string; body: string } {
  const tripType = String(params.trip_type ?? 'round_trip');
  if (tripType !== 'round_trip') throw new Error('trip_type must be round_trip');
  const cabinClass = String(params.cabin_class ?? 'economy');
  if (cabinClass !== 'economy') throw new Error('cabin_class must be economy');

  const origin = airportCode(params, 'origin');
  const destination = airportCode(params, 'destination');
  const startDate = isoDate(params, 'start_date');
  const endDate = isoDate(params, 'end_date');
  if (startDate > endDate) throw new Error('start_date must be on or before end_date');

  const adults = Number(params.adults ?? 1);
  if (!Number.isInteger(adults) || adults < 1) throw new Error('adults must be a positive integer');
  const tripLength = Number(params.trip_length_days);
  if (!Number.isInteger(tripLength) || tripLength < 1) throw new Error('trip_length_days must be a positive integer');

  const routeLegs = [
    [[[[origin, 0]]], [[[destination, 0]]], null, 0],
    [[[[destination, 0]]], [[[origin, 0]]], null, 0],
  ];
  const innerPayload = [
    null,
    [null, null, 1, null, [], 1, [adults, 0, 0, 0], null, null, null, null, null, null, routeLegs, null, null, null, 1],
    [startDate, endDate],
    null,
    [tripLength, tripLength],
  ];
  const outerPayload = [null, JSON.stringify(innerPayload)];
  return { url, body: 'f.req=' + encodeURIComponent(JSON.stringify(outerPayload)) + '&' };
}
