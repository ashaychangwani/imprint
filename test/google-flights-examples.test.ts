import { describe, expect, it } from 'bun:test';
import { extract as extractBooking } from '../examples/google-flights/get_flight_booking_details/parser.ts';
import { extract as extractCalendar } from '../examples/google-flights/get_flight_calendar_prices/parser.ts';
import { extract as extractLookup } from '../examples/google-flights/lookup_airport/parser.ts';
import { extract as extractSearch } from '../examples/google-flights/search_flights/parser.ts';

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
});
