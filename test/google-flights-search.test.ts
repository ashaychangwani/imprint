import { describe, expect, it } from 'bun:test';
import { extract as extractCalendar } from '../examples/google-flights/get_flight_calendar_prices/parser.ts';
import { extract as extractSearch } from '../examples/google-flights/search_flights/parser.ts';
import { transform as transformSearch } from '../examples/google-flights/search_flights/request-transform.ts';

function batchExecuteFrame(rpcid: string, payload: unknown): string {
  return `)]}'\n\n${JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])}\n`;
}

function decodeFreqBody(body: string): unknown[] {
  const freq = new URLSearchParams(body).get('f.req');
  if (!freq) throw new Error('missing f.req');
  const outer = JSON.parse(freq);
  return JSON.parse(outer[1]);
}

function searchItinerary(airlineCode: string, airlineName: string, token: string): unknown[] {
  const segment = new Array(24).fill(null);
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
  ];
  return [leg, [[null, 504], token]];
}

describe('Google Flights search parser', () => {
  it('rejects non-batchexecute provider responses instead of returning false zeroes', () => {
    expect(() => extractSearch('<html>temporarily unavailable</html>')).toThrow(
      /GetShoppingResults/,
    );
  });

  it('rejects unrecognized shopping payloads instead of returning false zeroes', () => {
    const raw = batchExecuteFrame('GetShoppingResults', []);
    expect(() => extractSearch(raw)).toThrow(/recognizable itineraries/);
  });

  it('surfaces available carrier filters even when the itinerary subset omits them', () => {
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

    const result = extractSearch(raw) as {
      count: number;
      resultScope: { exhaustive: boolean };
      availableAirlineFilters: {
        carriers: Array<{ code: string; name: string }>;
      };
    };

    expect(result.count).toBe(1);
    expect(result.resultScope.exhaustive).toBe(false);
    expect(result.availableAirlineFilters.carriers).toContainEqual({
      code: 'EK',
      name: 'Emirates',
    });
  });
});

describe('Google Flights search request transform', () => {
  const url =
    'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults?f.sid=sid&bl=bl';

  it.each(['one_way', 'one-way', 'one way', 'One way', '2'])(
    'encodes %s as a one-way search',
    (tripType) => {
      const result = transformSearch(
        'POST',
        url,
        {},
        {
          origin: 'SJC',
          destination: 'SAN',
          departure_date: '2026-07-21',
          return_date: '',
          trip_type: tripType,
        },
      );
      const payload = decodeFreqBody(result.body);
      const searchParams = payload[1] as unknown[];

      expect(searchParams[2]).toBe(2);
      expect(searchParams[13]).toHaveLength(1);
    },
  );

  it('treats missing return date as one-way even when workflow defaults say round trip', () => {
    const result = transformSearch(
      'POST',
      url,
      {},
      {
        origin: 'SJC',
        destination: 'SAN',
        departure_date: '2026-07-21',
        return_date: '',
        trip_type: 'round_trip',
      },
    );
    const payload = decodeFreqBody(result.body);
    const searchParams = payload[1] as unknown[];

    expect(searchParams[2]).toBe(2);
    expect(searchParams[13]).toHaveLength(1);
  });

  it('keeps round-trip encoding when a return date is supplied', () => {
    const result = transformSearch(
      'POST',
      url,
      {},
      {
        origin: 'SJC',
        destination: 'SAN',
        departure_date: '2026-07-21',
        return_date: '2026-07-28',
        trip_type: 'round trip',
      },
    );
    const payload = decodeFreqBody(result.body);
    const searchParams = payload[1] as unknown[];

    expect(searchParams[2]).toBe(1);
    expect(searchParams[13]).toHaveLength(2);
  });

  it('encodes carrier filters as included airlines instead of excluded airlines', () => {
    const result = transformSearch(
      'POST',
      url,
      {},
      {
        origin: 'BOS',
        destination: 'BOM',
        departure_date: '2026-10-12',
        return_date: '',
        trip_type: 'one-way',
        airlines: 'EK,TK,STAR_ALLIANCE',
      },
    );
    const payload = decodeFreqBody(result.body);
    const searchParams = payload[1] as unknown[];
    const firstLeg = (searchParams[13] as unknown[])[0] as unknown[];

    expect(firstLeg[4]).toEqual(['EK', 'TK', 'STAR_ALLIANCE']);
    expect(firstLeg[5]).toBeNull();
  });
});

describe('Google Flights calendar parser', () => {
  it('keeps the lowest fare when Google returns multiple prices for one departure date', () => {
    const raw = batchExecuteFrame('GetCalendarPicker', [
      null,
      [
        ['2026-07-22', '2026-07-29', [[null, 173], 'token-a'], 1],
        ['2026-07-22', '2026-08-02', [[null, 139], 'token-b'], 1],
        ['2026-07-23', '2026-07-30', [[null, 117], 'token-c'], 1],
      ],
    ]);

    const result = extractCalendar(raw, { params: { origin: 'SJC', destination: 'SAN' } }) as {
      prices: Record<string, number>;
      calendar: Array<{ departureDate: string; returnDate: string | null; lowestPriceUSD: number }>;
    };

    expect(result.prices['2026-07-22']).toBe(139);
    expect(result.calendar).toContainEqual({
      departureDate: '2026-07-22',
      returnDate: '2026-08-02',
      lowestPriceUSD: 139,
    });
    expect(result.prices['2026-07-23']).toBe(117);
  });
});
