import { describe, expect, it } from 'bun:test';
import { extract as extractBooking } from '../examples/google-hotels/get_hotel_booking_options/parser.ts';
import { transform as transformBooking } from '../examples/google-hotels/get_hotel_booking_options/request-transform.ts';
import { extract as extractDetails } from '../examples/google-hotels/get_hotel_details/parser.ts';
import { transform as transformDetails } from '../examples/google-hotels/get_hotel_details/request-transform.ts';
import { extract as extractSearch } from '../examples/google-hotels/search_hotels/parser.ts';
import { transform as transformSearch } from '../examples/google-hotels/search_hotels/request-transform.ts';

function batchExecuteFrame(rpcId: string, payload: unknown): string {
  const frame = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload)]]);
  return `)]}'\n${frame.length}\n${frame}`;
}

function decodeRpcBody(body: string): unknown[] {
  const encoded = new URLSearchParams(body).get('f.req');
  if (!encoded) throw new Error('missing f.req');
  return JSON.parse(encoded);
}

describe('Google Hotels request transforms', () => {
  it('JSON-escapes quotes and backslashes in hotel detail names', () => {
    const hotelName = 'Hotel "Quote" \\ Lodge';
    const result = transformDetails(
      'POST',
      'https://www.google.com/_/TravelFrontendUi/data/batchexecute?rpcids=AtySUc',
      [],
      { hotel_id: 'hotel-id-123', hotel_name: hotelName },
    );
    const outer = decodeRpcBody(result.body);
    const request = (outer[0] as unknown[])[0] as unknown[];
    const inner = JSON.parse(String(request[1])) as unknown[];

    expect(inner[0]).toBe(hotelName);
    expect(JSON.stringify(inner)).toContain('hotel-id-123');
  });

  it('uses the destination identifier from the discovery response', () => {
    const response = String.raw`[[\"/m/0d6lp\",null,null,\"Chicago\"]]`;
    const result = transformSearch(
      'POST',
      'https://www.google.com/_/TravelFrontendUi/data/batchexecute?rpcids=AtySUc',
      [response],
      {
        location: 'Chicago',
        check_in_date: '2026-09-10',
        check_out_date: '2026-09-12',
      },
    );

    expect(result.body).toContain(encodeURIComponent('/m/0d6lp'));
    expect(result.body).not.toContain('${state.destination_id}');
  });

  it('rejects missing, impossible, and reversed stay dates', () => {
    const call = (checkIn: unknown, checkOut: unknown) =>
      transformSearch(
        'POST',
        'https://www.google.com/_/TravelFrontendUi/data/batchexecute?rpcids=AtySUc',
        [],
        {
          location: 'Chicago',
          check_in_date: checkIn as string,
          check_out_date: checkOut as string,
        },
      );

    expect(() => call('', '2026-09-12')).toThrow(/check_in_date/);
    expect(() => call('2026-02-30', '2026-03-02')).toThrow(/real calendar date/);
    expect(() => call('2026-09-12', '2026-09-10')).toThrow(/later than/);
  });

  it('rejects impossible booking dates', () => {
    expect(() =>
      transformBooking(
        'POST',
        'https://www.google.com/_/TravelFrontendUi/data/batchexecute?rpcids=M0CRd',
        [],
        {
          hotel_id: 'hotel-id',
          check_in_date: '2026-02-30',
          check_out_date: '2026-03-03',
          adults: 2,
          currency: 'USD',
        },
      ),
    ).toThrow(/real calendar date/);
  });
});

describe('Google Hotels parser failure behavior', () => {
  it('throws on challenge pages instead of returning caller-echoed hotel details', () => {
    expect(() =>
      extractDetails('<html>verify you are human</html>', {
        params: { hotel_id: 'caller-id', hotel_name: 'Caller Hotel' },
        responses: [],
      }),
    ).toThrow(/HOTEL_DETAILS_UNPARSED/);
  });

  it('throws on challenge pages instead of returning caller-echoed booking fields', () => {
    expect(() =>
      extractBooking('<html>verify you are human</html>', {
        params: {
          hotel_id: 'caller-id',
          check_in_date: '2026-09-10',
          check_out_date: '2026-09-12',
          adults: 2,
          currency: 'USD',
        },
        responses: [],
      }),
    ).toThrow(/HOTEL_BOOKING_UNPARSED/);
  });

  it('accepts a structurally valid booking response with no available offers', () => {
    const raw = batchExecuteFrame('M0CRd', [
      null,
      [null, null, null, 'USD', [[2026, 9, 10], [2026, 9, 12], 2, 2]],
      [null, null, []],
    ]);

    expect(extractBooking(raw)).toMatchObject({ currency: 'USD', options: [] });
  });

  it('returns the requested hotel name only after provider-derived detail evidence', () => {
    const raw = batchExecuteFrame('AtySUc', [['123 Global Road, Singapore 123456']]);
    const result = extractDetails(raw, {
      params: { hotel_id: 'hotel-id', hotel_name: 'Global Hotel' },
      responses: [],
    }) as { hotel: { requested_name: string; coordinates: unknown } };

    expect(result.hotel.requested_name).toBe('Global Hotel');
    expect(result.hotel.coordinates).toBeUndefined();
  });

  it('keeps valid coordinates near the equator and prime meridian', () => {
    const raw = batchExecuteFrame('AtySUc', [
      [
        ['Equator Hotel', 'en-US'],
        ['Hotel', 'en-US'],
        [1.3521, 103.8198],
        'ChGlobalHotelIdentifier123456',
      ],
    ]);
    const result = extractSearch(raw) as {
      items: Array<{ coordinates: { latitude: number; longitude: number } | null }>;
    };

    expect(result.items[0]?.coordinates).toEqual({ latitude: 1.3521, longitude: 103.8198 });
  });

  it('keeps exact-integer coordinates when one axis is near zero', () => {
    const raw = batchExecuteFrame('AtySUc', [
      [
        ['Prime Meridian Hotel', 'en-US'],
        ['Hotel', 'en-US'],
        [51, 0],
        'ChPrimeMeridianIdentifier12345',
      ],
    ]);
    const result = extractSearch(raw) as {
      items: Array<{ coordinates: { latitude: number; longitude: number } | null }>;
    };

    expect(result.items[0]?.coordinates).toEqual({ latitude: 51, longitude: 0 });
  });

  it('throws on non-batchexecute search responses', () => {
    expect(() => extractSearch('<html>consent required</html>')).toThrow(/ATYSUC_UNPARSED/);
  });

  it('rejects arbitrary nonempty search arrays but permits an explicit empty payload', () => {
    expect(() => extractSearch('[["consent required"]]')).toThrow(/ATYSUC_UNPARSED/);
    expect(extractSearch('[]')).toEqual({
      query: null,
      currency: null,
      count: 0,
      items: [],
    });
  });
});
