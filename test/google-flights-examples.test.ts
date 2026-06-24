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
  it('marks a round-trip return shopping leg with the current browser classifier', () => {
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
    expect(legs[1]?.[14]).toBe(1);
  });
});
