import { describe, expect, it } from 'bun:test';
import { extract as extractAccountDetails } from '../examples/southwest/get_account_details/parser.ts';
import { extract as extractFlightStatus } from '../examples/southwest/get_flight_status/parser.ts';
import { transform as transformFlightStatus } from '../examples/southwest/get_flight_status/request-transform.ts';
import { extract as extractCalendar } from '../examples/southwest/get_low_fare_calendar/parser.ts';
import { transform as transformCalendar } from '../examples/southwest/get_low_fare_calendar/request-transform.ts';
import { extract as extractTrips } from '../examples/southwest/list_upcoming_trips/parser.ts';
import { extract as extractFlights } from '../examples/southwest/search_flights/parser.ts';
import { transform as transformFlights } from '../examples/southwest/search_flights/request-transform.ts';

const statusParams = {
  departure_date: '2026-07-18',
  origination_airport_code: 'SJC',
  destination_airport_code: 'SAN',
  flight_number: '233',
};

const renderedStatus = `
  <h1><span aria-label="flight number 233">#233</span></h1>
  <strong aria-label="Flight Status: DELAYED">DELAYED</strong>
  <div aria-label="departs 8:38 P M">8:38 PM</div><span>Gate: 19</span>
  <a href="/airport-information/"><div>SJC</div></a>
  <strong aria-label="Flight Status: ON_TIME">ON TIME</strong>
  <div aria-label="arrives 10:05 P M">10:05 PM</div><span>Gate: 105</span>
  <a href="/airport-information/"><div>SAN</div></a>
`;

function rawSearch() {
  const details = [
    { departureTime: '08:00', filterTags: ['AVAILABLE', 'BEFORE_NOON'] },
    { departureTime: '15:00', filterTags: ['AVAILABLE', 'NOON_TO_SIX'] },
    { departureTime: '19:00', filterTags: ['AVAILABLE', 'AFTER_SIX'] },
  ];
  return {
    data: {
      searchResults: {
        airProducts: [
          { originationAirportCode: 'SJC', destinationAirportCode: 'SAN', details },
          { originationAirportCode: 'SAN', destinationAirportCode: 'SJC', details },
        ],
      },
    },
  };
}

describe('Southwest example parsers', () => {
  it('extracts account details from the customer-details response slot', () => {
    const result = extractAccountDetails({
      data: {
        account: {
          id: 'RR-details',
          type: 'RAPID_REWARDS',
          redeemable_points: 12345,
          tier: { type: 'A_LIST', qualifying_flights: 12 },
        },
      },
    }) as {
      account: {
        id: string | null;
        redeemable_points: number | null;
        tier: { type: string | null; qualifying_flights: number | null } | null;
      };
    };

    expect(result.account.id).toBe('RR-details');
    expect(result.account.redeemable_points).toBe(12345);
    expect(result.account.tier?.type).toBe('A_LIST');
    expect(result.account.tier?.qualifying_flights).toBe(12);
  });

  it('filters outbound and return bounds by requested Southwest time windows', () => {
    const result = extractFlights(rawSearch(), {
      params: {
        departure_time_of_day: 'BEFORE_NOON',
        return_time_of_day: 'AFTER_SIX',
      },
      responses: [],
    }) as { bounds: Array<{ flights: Array<{ departureTime: string }> }> };

    expect(result.bounds[0]?.flights.map((flight) => flight.departureTime)).toEqual(['08:00']);
    expect(result.bounds[1]?.flights.map((flight) => flight.departureTime)).toEqual(['19:00']);
  });

  it('uses the audited one-adult request baseline without passenger controls', () => {
    const transformed = transformFlights('POST', 'https://www.southwest.com/api/search', [], {
      origination_airport_code: 'SJC',
      destination_airport_code: 'SAN',
      departure_date: '2026-09-02',
    });
    if (!transformed.body) throw new Error('expected transformed POST body');
    const body = JSON.parse(transformed.body) as Record<string, unknown>;

    expect(body.adultPassengersCount).toBe('1');
    expect(body.adultsCount).toBe('1');
    expect(body).not.toHaveProperty('teensCount');
    expect(body).not.toHaveProperty('lapInfantPassengersCount');
  });

  it('rejects invalid Southwest flight-search routes and dates', () => {
    const call = (overrides: Record<string, string>) =>
      transformFlights('POST', 'https://www.southwest.com/api/search', [], {
        origination_airport_code: 'SJC',
        destination_airport_code: 'SAN',
        departure_date: '2026-09-02',
        trip_type: 'oneway',
        ...overrides,
      });

    expect(() => call({ origination_airport_code: 'X' })).toThrow(/three-letter/);
    expect(() => call({ destination_airport_code: '123' })).toThrow(/three-letter/);
    expect(() => call({ departure_date: '2026-02-30' })).toThrow(/real YYYY-MM-DD/);
    expect(() => call({ trip_type: 'roundtrip', return_date: '2026-09-01' })).toThrow(/later than/);
  });

  it('rejects rollover dates in flight-status requests', () => {
    expect(() =>
      transformFlightStatus('GET', 'https://www.southwest.com/air/flight-status/path.html', [], {
        ...statusParams,
        departure_date: '2026-02-30',
      }),
    ).toThrow(/valid date/);
  });

  it('does not attach POST bodies to the dynamic API-key bootstrap request', () => {
    const bootstrapUrl =
      'https://www.southwest.com/swa-ui/bootstrap/landing-home-page-v2/1/data.js';

    expect(transformFlights('GET', bootstrapUrl, [], {})).toEqual({ url: bootstrapUrl });
    expect(transformCalendar('GET', bootstrapUrl, [], {})).toEqual({ url: bootstrapUrl });
  });

  it('throws on malformed calendar and authenticated responses', () => {
    expect(() => extractCalendar('<html>verify</html>')).toThrow(/SOUTHWEST_CALENDAR_UNPARSED/);
    expect(() => extractAccountDetails('<html>login</html>')).toThrow(/SOUTHWEST_ACCOUNT_UNPARSED/);
    expect(() => extractTrips({ loginRequired: true })).toThrow(/SOUTHWEST_TRIPS_UNPARSED/);
  });

  it('throws on provider search errors so the backend ladder can escalate', () => {
    expect(() => extractFlights({ error: 'blocked' })).toThrow(/SOUTHWEST_SEARCH_ERROR/);
    expect(() => extractFlights({ errors: [{ message: 'try again' }] })).toThrow(
      /SOUTHWEST_SEARCH_ERROR/,
    );
  });

  it('rejects invalid low-fare calendar routes, dates, and trip types', () => {
    const call = (overrides: Record<string, string>) =>
      transformCalendar('POST', 'https://www.southwest.com/api/calendar', [], {
        origination_airport_code: 'SJC',
        destination_airport_code: 'SAN',
        departure_date: '2026-09-02',
        trip_type: 'oneway',
        ...overrides,
      });

    expect(() => call({ trip_type: 'multi_city' })).toThrow(/oneway or roundtrip/);
    expect(() => call({ departure_date: '2026-02-30' })).toThrow(/real YYYY-MM-DD/);
    expect(() => call({ origination_airport_code: 'San Jose' })).toThrow(/three-letter/);
    expect(() => call({ trip_type: 'roundtrip', return_date: '2026-09-01' })).toThrow(/later than/);
  });

  it('extracts rendered flight status and enforces the requested route', () => {
    const matching = extractFlightStatus(renderedStatus, {
      params: statusParams,
      responses: [],
    }) as { count: number; results: Array<Record<string, unknown>> };
    const mismatched = extractFlightStatus(renderedStatus, {
      params: { ...statusParams, destination_airport_code: 'LAX' },
      responses: [],
    });
    const mismatchedFlight = extractFlightStatus(renderedStatus, {
      params: { ...statusParams, flight_number: '999' },
      responses: [],
    });

    expect(matching.count).toBe(1);
    expect(matching.results[0]).toMatchObject({
      originationAirportCode: 'SJC',
      destinationAirportCode: 'SAN',
      flightNumbers: ['233'],
      departureStatus: 'DELAYED',
      arrivalStatus: 'ON_TIME',
      departureTimes: ['8:38 P M'],
      arrivalTimes: ['10:05 P M'],
    });
    expect(mismatched).toEqual({ count: 0, results: [] });
    expect(mismatchedFlight).toEqual({ count: 0, results: [] });
  });

  it('surfaces rendered flight-status service errors instead of false zeroes', () => {
    expect(() =>
      extractFlightStatus(
        '<div data-test="serviceErrorMessageBody"><span>Flight status is unavailable.</span></div>',
        { params: statusParams, responses: [] },
      ),
    ).toThrow(/SOUTHWEST_FLIGHT_STATUS_ERROR: Flight status is unavailable/);
  });

  it('rejects challenge or garbage flight-status HTML instead of false zeroes', () => {
    expect(() =>
      extractFlightStatus('<html>Verify you are human</html>', {
        params: statusParams,
        responses: [],
      }),
    ).toThrow(/SOUTHWEST_FLIGHT_STATUS_UNPARSED/);
  });
});
