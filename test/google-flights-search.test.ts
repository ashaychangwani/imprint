import { describe, expect, it } from 'bun:test';
import { extract as extractBooking } from '../examples/google-flights/get_flight_booking_options/parser.ts';
import { extract as extractCalendar } from '../examples/google-flights/get_flight_calendar_prices/parser.ts';
import { transform as transformCalendar } from '../examples/google-flights/get_flight_calendar_prices/request-transform.ts';
import { extract as extractLocationDetails } from '../examples/google-flights/get_flight_location_details/parser.ts';
import { extract as extractLocationSearch } from '../examples/google-flights/search_flight_locations/parser.ts';
import { extract as extractSearch } from '../examples/google-flights/search_flights/parser.ts';
import { transform as transformSearch } from '../examples/google-flights/search_flights/request-transform.ts';

function batchExecuteFrame(rpcid: string, payload: unknown): string {
  void rpcid;
  const frame = JSON.stringify([['wrb.fr', null, JSON.stringify(payload)]]);
  return `)]}'\n${frame.length}\n${frame}`;
}

function decodeFreqBody(body: string): unknown[] {
  const freq = new URLSearchParams(body).get('f.req');
  if (!freq) throw new Error('missing f.req');
  const outer = JSON.parse(freq);
  return JSON.parse(outer[1]);
}

function searchItinerary(airlineCode: string, airlineName: string, token: string): unknown[] {
  const segment = new Array(24).fill(null);
  segment[3] = 'BOS';
  segment[2] = airlineName;
  segment[6] = 'BOM';
  segment[8] = [21, 50];
  segment[10] = [5, 15];
  segment[11] = 1315;
  segment[20] = [2026, 10, 12];
  segment[21] = [2026, 10, 14];
  segment[22] = [airlineCode, '82', null, airlineName];
  const leg = [
    airlineCode,
    [airlineName],
    [segment],
    'BOS',
    [2026, 10, 12],
    [21, 50],
    'BOM',
    [2026, 10, 14],
    [5, 15],
    1315,
    [[null, 504], token],
  ];
  return [leg, [[null, 504], token]];
}

describe('Google Flights search parser', () => {
  it('rejects non-batchexecute provider responses instead of returning false zeroes', () => {
    expect(() => extractSearch('<html>temporarily unavailable</html>')).toThrow(
      /Malformed batchexecute envelope/,
    );
  });

  it('rejects unrecognized shopping payloads instead of returning false zeroes', () => {
    const raw = batchExecuteFrame('GetShoppingResults', []);
    expect(() => extractSearch(raw)).toThrow(/recognizable itineraries/);
    expect(() => extractSearch(batchExecuteFrame('GetShoppingResults', [[], []]))).toThrow(
      /recognizable itineraries/,
    );
  });

  it('allows a structurally recognized carrier catalog to represent zero inventory', () => {
    const raw = batchExecuteFrame('GetShoppingResults', [
      [
        ['UA', 'United Airlines'],
        ['STAR_ALLIANCE', 'Star Alliance'],
      ],
    ]);

    expect(extractSearch(raw)).toEqual({ items: [], count: 0 });
  });

  it('surfaces carrier details from recognized itineraries', () => {
    const raw = batchExecuteFrame('GetShoppingResults', [
      searchItinerary('TK', 'Turkish Airlines', 'tok_turkish_airlines_12345'),
      [
        [
          ['ONEWORLD', 'Oneworld'],
          ['STAR_ALLIANCE', 'Star Alliance'],
        ],
        [
          ['EK', 'Emirates'],
          ['TK', 'Turkish Airlines'],
        ],
      ],
    ]);

    const result = extractSearch(raw, { params: {}, responses: [] }) as {
      count: number;
      items: Array<{
        segments: Array<{ airline_code?: string; carrier_name?: string }>;
      }>;
    };

    expect(result.count).toBe(1);
    expect(result.items[0]?.segments[0]).toMatchObject({
      airline_code: 'TK',
      carrier_name: 'Turkish Airlines',
    });
  });

  it('enforces max_price as a deterministic result postcondition', () => {
    const raw = batchExecuteFrame('GetShoppingResults', [
      searchItinerary('TK', 'Turkish Airlines', 'tok_turkish_airlines_12345'),
    ]);

    const belowFare = extractSearch(raw, {
      params: { max_price: 500 },
      responses: [],
    }) as { count: number };
    const aboveFare = extractSearch(raw, {
      params: { max_price: 600 },
      responses: [],
    }) as { count: number };

    expect(belowFare.count).toBe(0);
    expect(aboveFare.count).toBe(1);
  });

  it('matches airline filters case-insensitively', () => {
    const raw = batchExecuteFrame('GetShoppingResults', [
      searchItinerary('UA', 'United Airlines', 'tok_united_airlines_123456789'),
    ]);

    const result = extractSearch(raw, {
      params: { airlines: 'ua' },
      responses: [],
    }) as { count: number };

    expect(result.count).toBe(1);
  });
});

describe('Google Flights search request transform', () => {
  const url =
    'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults?f.sid=sid&bl=bl';

  it.each(['one_way', 'one-way', 'one way', 'One way', '2'])(
    'encodes %s as a one-way search',
    (tripType) => {
      const result = transformSearch('POST', url, [], {
        legs: 'SJC,SAN,2026-07-21',
        trip_type: tripType,
      });
      const payload = decodeFreqBody(result.body);
      const searchParams = payload[1] as unknown[];

      expect(searchParams[2]).toBe(2);
      expect(searchParams[13]).toHaveLength(1);
    },
  );

  it('rejects round-trip search instead of producing an unverified staged selection', () => {
    expect(() =>
      transformSearch('POST', url, [], {
        legs: 'SJC,SAN,2026-07-21;SAN,SJC,2026-07-28',
        trip_type: 'round_trip',
      }),
    ).toThrow(/Only one_way/);
  });

  it('rejects multiple legs even when trip_type is one-way', () => {
    expect(() =>
      transformSearch('POST', url, [], {
        legs: 'SJC,SAN,2026-07-21;SAN,SJC,2026-07-28',
        trip_type: 'one_way',
      }),
    ).toThrow(/exactly one leg/);
  });

  it('encodes carrier filters as included airlines instead of excluded airlines', () => {
    const result = transformSearch('POST', url, [], {
      legs: 'BOS,BOM,2026-10-12',
      trip_type: 'one-way',
      airlines: 'EK,TK',
      alliances: 'star_alliance',
    });
    const payload = decodeFreqBody(result.body);
    const searchParams = payload[1] as unknown[];
    const firstLeg = (searchParams[13] as unknown[])[0] as unknown[];

    expect(firstLeg[4]).toEqual(['EK', 'TK', 'STAR_ALLIANCE']);
    expect(firstLeg[5]).toBeNull();
  });

  it('rejects unsupported alliances and malformed time windows', () => {
    expect(() =>
      transformSearch('POST', url, [], {
        legs: 'BOS,BOM,2026-10-12',
        alliances: 'NOT_AN_ALLIANCE',
      }),
    ).toThrow(/alliances must contain only/);
    expect(() =>
      transformSearch('POST', url, [], {
        legs: 'BOS,BOM,2026-10-12',
        outbound_time_range: '24,0,25,0',
      }),
    ).toThrow(/four integer hours/);
  });

  it('rejects impossible leg dates', () => {
    expect(() =>
      transformSearch('POST', url, [], {
        legs: 'SJC,SAN,2026-02-30',
      }),
    ).toThrow(/real calendar date/);
  });

  it('rejects invalid numeric controls and unknown sort orders', () => {
    const call = (overrides: Record<string, string | number>) =>
      transformSearch('POST', url, [], {
        legs: 'SJC,SAN,2026-07-21',
        ...overrides,
      });

    expect(() => call({ adults: -3 })).toThrow(/adults must be/);
    expect(() => call({ children: 1.5 })).toThrow(/children must be/);
    expect(() => call({ max_stops: -2 })).toThrow(/max_stops must be/);
    expect(() => call({ max_duration_minutes: 90.5 })).toThrow(/max_duration_minutes must be/);
    expect(() => call({ max_price: -1 })).toThrow(/max_price must be/);
    expect(() => call({ adults: 'not-a-number' })).toThrow(/adults must be/);
    expect(() => call({ sort_order: 'cheapest_typo' })).toThrow(/sort_order must be/);
  });
});

describe('Google Flights calendar parser', () => {
  it('enforces the requested date window and exact trip length before deduplicating fares', () => {
    const raw = batchExecuteFrame('GetCalendarPicker', [
      null,
      [
        ['2026-07-22', '2026-07-29', [[null, 173], 'token-a'], 1],
        ['2026-07-22', '2026-08-02', [[null, 139], 'token-b'], 1],
        ['2026-07-23', '2026-07-30', [[null, 117], 'token-c'], 1],
      ],
    ]);

    const result = extractCalendar(raw, {
      params: {
        start_date: '2026-07-22',
        end_date: '2026-07-23',
        trip_length_days: 7,
      },
      responses: [],
    }) as {
      items: Array<{
        departureDate: string;
        returnDate: string | null;
        fare: number;
        currency: string;
        selectionData: string;
        status: number;
      }>;
      unavailableDates: Array<{
        departureDate: string;
        returnDate: string | null;
        status: number | null;
      }>;
    };

    expect(result.items).toContainEqual({
      departureDate: '2026-07-22',
      returnDate: '2026-07-29',
      fare: 173,
      currency: 'USD',
      selectionData: 'token-a',
      status: 1,
    });
    expect(result.items).toContainEqual({
      departureDate: '2026-07-23',
      returnDate: '2026-07-30',
      fare: 117,
      currency: 'USD',
      selectionData: 'token-c',
      status: 1,
    });
    expect(result.unavailableDates).not.toContainEqual(
      expect.objectContaining({ departureDate: '2026-07-22', returnDate: '2026-08-02' }),
    );
  });

  it('rejects impossible calendar dates', () => {
    expect(() =>
      transformCalendar('POST', 'https://www.google.com/calendar', [], {
        origin: 'SJC',
        destination: 'SAN',
        start_date: '2026-02-30',
        end_date: '2026-03-10',
        trip_length_days: 7,
      }),
    ).toThrow(/real calendar date/);
  });
});

describe('Google Flights location details parser', () => {
  it('throws on non-batchexecute responses so the backend ladder can escalate', () => {
    expect(() => extractLocationDetails('<html>verify you are human</html>')).toThrow(
      /Malformed batchexecute envelope/,
    );
  });
});

describe('Google Flights empty-response failure behavior', () => {
  it('throws for every batchexecute tool so the backend ladder can escalate', () => {
    expect(() => extractSearch('')).toThrow(/Empty Google Flights shopping response/);
    expect(() => extractCalendar('')).toThrow(/Empty Google Flights calendar response/);
    expect(() => extractBooking('')).toThrow(/Empty Google Flights booking response/);
    expect(() => extractLocationSearch('')).toThrow(
      /Empty Google Flights location-search response/,
    );
    expect(() => extractLocationDetails('')).toThrow(
      /Empty Google Flights location-details response/,
    );
  });
});
