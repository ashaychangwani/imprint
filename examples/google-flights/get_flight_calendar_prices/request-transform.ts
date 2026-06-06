// Local adapter: maps this tool's user-facing params (origin/destination/
// start_date/end_date) into the shape the shared FlightsFrontendService body
// builder consumes (legs[]/startDate/endDate/tripType), then delegates the
// byte-for-byte f.req encoding to the assigned shared request-transform.
import { transform as sharedTransform } from '../_shared/flights_request.ts';

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Record<string, any>,
): { url: string; body: string } {
  const p: Record<string, any> = params ?? {};
  const origin = String(p.origin ?? '').toUpperCase();
  const destination = String(p.destination ?? '').toUpperCase();

  // GetCalendarPicker for this tool is a round-trip (tripType 1), 1 adult,
  // with a mirrored outbound/return leg pair — exactly as recorded in seq 97.
  const adapted = {
    tripType: 1,
    adults: 1,
    legs: [
      { origin, dest: destination },
      { origin: destination, dest: origin },
    ],
    startDate: p.start_date ?? null,
    endDate: p.end_date ?? null,
  };

  return sharedTransform(method, url, responses, adapted);
}
