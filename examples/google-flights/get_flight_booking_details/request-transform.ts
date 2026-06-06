// Adapter around the shared FlightsFrontendService body builder for
// GetBookingResults. The tool exposes flat snake_case params (origin,
// destination, departure_date, return_date, outbound_flight, return_flight,
// flight_token); the shared encoder consumes a structured shape
// ({ tripType, legs:[{origin,dest,date,selected:[{origin,date,dest,carrier,flightNumber}]}], flight_token }).
// We map between them here and delegate the byte-for-byte positional encoding
// (legs, trip-type, the [[null,token],sp,null,selIdx] outer wrapper, token
// injection, encodeFreq) to the shared module — required reuse.
import { transform as sharedTransform } from '../_shared/flights_request.ts';

type Params = Record<string, string | number | boolean | undefined | null>;

// "WN 3489" / "WN3489" -> { carrier:"WN", flightNumber:"3489" }
function parseFlight(v: unknown): { carrier: string; flightNumber: string } | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = /^([A-Za-z0-9]{2})\s*([0-9]{1,5})$/.exec(s) ?? /^(\S+)\s+(\S+)$/.exec(s);
  if (!m) return null;
  const carrier = m[1];
  const flightNumber = m[2];
  if (carrier == null || flightNumber == null) return null;
  return { carrier: carrier.toUpperCase(), flightNumber };
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Params,
): { url: string; body: string } {
  const p: Params = params ?? {};
  const origin = p.origin != null ? String(p.origin) : '';
  const destination = p.destination != null ? String(p.destination) : '';
  const departureDate = p.departure_date ? String(p.departure_date) : null;
  const returnDate = p.return_date != null ? String(p.return_date).trim() : '';
  const roundTrip = returnDate !== '';
  const tripType = roundTrip ? 1 : 2; // 1=round trip, 2=one way

  const ob = parseFlight(p.outbound_flight);
  const legs: any[] = [
    {
      origin,
      dest: destination,
      date: departureDate,
      selected: ob
        ? [
            {
              origin,
              date: departureDate,
              dest: destination,
              carrier: ob.carrier,
              flightNumber: ob.flightNumber,
            },
          ]
        : null,
    },
  ];

  if (roundTrip) {
    const rb = parseFlight(p.return_flight);
    legs.push({
      origin: destination,
      dest: origin,
      date: returnDate,
      selected: rb
        ? [
            {
              origin: destination,
              date: returnDate,
              dest: origin,
              carrier: rb.carrier,
              flightNumber: rb.flightNumber,
            },
          ]
        : null,
    });
  }

  const mapped: Record<string, any> = {
    tripType,
    legs,
    flight_token: p.flight_token != null ? String(p.flight_token) : null,
  };

  return sharedTransform(method, url, responses, mapped);
}
