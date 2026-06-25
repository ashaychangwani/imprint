import { describe, expect, it } from 'bun:test';
import { extract as extractBooking } from '../examples/google-flights/get_flight_booking_details/parser.ts';
import { extract as extractCalendar } from '../examples/google-flights/get_flight_calendar_prices/parser.ts';
import { extract as extractLookup } from '../examples/google-flights/lookup_airport/parser.ts';
import { extract as extractSearch } from '../examples/google-flights/search_flights/parser.ts';
import { transform as transformSearch } from '../examples/google-flights/search_flights/request-transform.ts';

function batchExecuteFrame(rpcid: string, payload: unknown): string {
  return `)]}'\n\n${JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])}\n`;
}

describe('Google Flights example parsers', () => {
  it('rejects non-batchexecute search responses instead of returning false zeroes', () => {
    expect(() => extractSearch('<html>temporarily unavailable</html>')).toThrow(
      /GetShoppingResults/,
    );
  });

  it('rejects non-batchexecute lookup responses instead of returning false zeroes', () => {
    expect(() => extractLookup('<html>temporarily unavailable</html>')).toThrow(/tDoGIe/);
  });

  it('rejects non-batchexecute calendar responses instead of returning false zeroes', () => {
    expect(() => extractCalendar('<html>temporarily unavailable</html>')).toThrow(
      /GetCalendarPicker/,
    );
  });

  it('rejects non-batchexecute booking responses instead of returning false zeroes', () => {
    expect(() => extractBooking('<html>temporarily unavailable</html>')).toThrow(
      /GetBookingResults/,
    );
  });

  it('rejects recognizable search RPC frames that contain no itineraries', () => {
    const raw = batchExecuteFrame('GetShoppingResults', []);
    expect(() => extractSearch(raw)).toThrow(/recognizable itineraries/);
  });

  it('rejects recognizable calendar RPC frames that contain no prices', () => {
    const raw = batchExecuteFrame('GetCalendarPicker', [null, []]);
    expect(() => extractCalendar(raw)).toThrow(/recognizable calendar prices/);
  });

  it('rejects recognizable booking RPC frames that contain no booking details', () => {
    const raw = batchExecuteFrame('GetBookingResults', [null, []]);
    expect(() => extractBooking(raw)).toThrow(/recognizable booking details/);
  });

  it('rejects airport lookup RPC frames with an unrecognized payload shape', () => {
    const raw = batchExecuteFrame('tDoGIe', []);
    expect(() => extractLookup(raw)).toThrow(/recognizable match list/);
  });

  it('allows airport lookup RPC frames with a recognized empty match list', () => {
    const raw = batchExecuteFrame('tDoGIe', [null, []]);
    expect(extractLookup(raw, { params: { query: 'ZZZ' }, responses: [] })).toMatchObject({
      query: 'ZZZ',
      matchCount: 0,
      matches: [],
      code: null,
    });
  });
});

describe('Google Flights request transforms', () => {
  it('uses the fresh-shopping classifier for both explicit round-trip legs', () => {
    const { body } = transformSearch(
      'POST',
      'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults',
      {},
      {
        origin: 'SFO',
        destination: 'JFK',
        departure_date: '2026-10-23',
        return_date: '2026-10-27',
        trip_type: 'round_trip',
        max_stops: 3,
      },
    );

    const encoded = body.replace(/^f\.req=/, '').replace(/&$/, '');
    const outer = JSON.parse(decodeURIComponent(encoded)) as [null, string];
    const payload = JSON.parse(outer[1]) as unknown[];
    const filters = payload[1] as unknown[];
    const legs = filters[13] as unknown[][];

    expect(legs[0]?.[14]).toBe(3);
    expect(legs[1]?.[14]).toBe(3);
  });

  it('threads the browser-minted search context token into shopping requests', () => {
    const { body } = transformSearch(
      'POST',
      'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults',
      {},
      {
        origin: 'SFO',
        destination: 'JFK',
        departure_date: '2026-10-23',
        return_date: '',
        trip_type: 'one_way',
        max_stops: 3,
      },
      { search_context_token: 'browser-minted-search-token' },
    );

    const encoded = body.replace(/^f\.req=/, '').replace(/&$/, '');
    const outer = JSON.parse(decodeURIComponent(encoded)) as [null, string];
    const payload = JSON.parse(outer[1]) as unknown[];

    expect(payload[0]).toEqual([null, null, null, 'browser-minted-search-token']);
  });

  it('uses the browser-observed shopping body for unfiltered searches', () => {
    const observedBody = 'f.req=%5Bnull%2C%22native-browser-body%22%5D&';
    const { body } = transformSearch(
      'POST',
      'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults',
      {},
      {
        origin: 'SFO',
        destination: 'LGA',
        departure_date: '2026-10-23',
        return_date: '',
        trip_type: 'one_way',
        max_stops: 3,
      },
      { observed_search_body: observedBody, search_context_token: 'browser-minted-search-token' },
    );

    expect(body).toBe(observedBody);
  });

  it('falls back to generated shopping bodies when filters need to be applied', () => {
    const observedBody = 'f.req=%5Bnull%2C%22native-browser-body%22%5D&';
    const { body } = transformSearch(
      'POST',
      'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults',
      {},
      {
        origin: 'SFO',
        destination: 'LGA',
        departure_date: '2026-10-23',
        return_date: '',
        trip_type: 'one_way',
        max_stops: 0,
      },
      { observed_search_body: observedBody, search_context_token: 'browser-minted-search-token' },
    );

    expect(body).not.toBe(observedBody);
    const encoded = body.replace(/^f\.req=/, '').replace(/&$/, '');
    const outer = JSON.parse(decodeURIComponent(encoded)) as [null, string];
    const payload = JSON.parse(outer[1]) as unknown[];
    expect(payload[0]).toEqual([null, null, null, 'browser-minted-search-token']);
  });
});
