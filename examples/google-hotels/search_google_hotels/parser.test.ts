import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extract, parseEnvelope, type ExtractResult, type Hotel } from './parser.ts';

const FIXTURE = readFileSync(
  join(
    import.meta.dir,
    '../../../test/fixtures/examples/google-hotels/search_google_hotels/response-287.txt',
  ),
  'utf8',
);

describe('google-hotels parser (Tahoe City, AtySUc)', () => {
  test('parseEnvelope returns the AtySUc payload', () => {
    const env = parseEnvelope(FIXTURE) as { rpcid: string; payload: unknown } | null;
    expect(env).not.toBeNull();
    expect(env!.rpcid).toBe('AtySUc');
    expect(Array.isArray(env!.payload)).toBe(true);
  });

  test('extract surfaces the searched destination and stay window', () => {
    const result = extract(FIXTURE) as ExtractResult;
    expect(result.destination).toBe('Tahoe City');
    expect(result.checkInDate).toBe('2026-06-19');
    expect(result.checkOutDate).toBe('2026-06-27');
    expect(result.nights).toBe(8);
    expect(result.currency).toBe('USD');
    // The destination header carries a result count (107 hotels in the area).
    expect(result.totalResults).toBeGreaterThan(0);
  });

  test('extract returns multiple Tahoe-City-area hotels', () => {
    const result = extract(FIXTURE) as ExtractResult;
    expect(result.hotels.length).toBeGreaterThanOrEqual(15);
    expect(result.hotelCount).toBe(result.hotels.length);
    for (const h of result.hotels) {
      expect(typeof h.name).toBe('string');
      expect(h.name.length).toBeGreaterThan(0);
    }
  });

  test('extract finds the named hotels seen in the recording', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const names = result.hotels.map((h) => h.name);
    expect(names).toContain('Northstar California Resort');
    expect(names).toContain('Franciscan Lakeside Lodge');
    expect(names).toContain('The Ritz-Carlton, Lake Tahoe');
    expect(names).toContain('Granlibakken Tahoe');
    expect(names).toContain('Basecamp Tahoe City');
    expect(names).toContain('The Cottage Inn at Lake Tahoe');
    expect(names).toContain('evo Hotel Tahoe City');
    expect(names).toContain('Pepper Tree Inn');
  });

  test('extract pulls correct details for The Ritz-Carlton, Lake Tahoe', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const ritz = result.hotels.find((h) => h.name === 'The Ritz-Carlton, Lake Tahoe');
    expect(ritz).toBeDefined();
    expect(ritz!.starRating).toBe(5);
    expect(ritz!.starDescription).toBe('5-star hotel');
    expect(ritz!.nightlyPrice).toBe('$616');
    expect(ritz!.nightlyPriceValue).toBeCloseTo(615.79, 1);
    expect(ritz!.totalPrice).toBe('$4,926');
    expect(ritz!.guestRating).toBeCloseTo(4.4, 1);
    expect(ritz!.reviewCount).toBe(1705);
    expect(ritz!.checkInDate).toBe('2026-06-19');
    expect(ritz!.checkOutDate).toBe('2026-06-27');
    expect(ritz!.nights).toBe(8);
    expect(ritz!.hotelId).toBeTruthy();
    expect(ritz!.mapsFeatureId).toMatch(/^0x[0-9a-f]+:0x[0-9a-f]+$/);
  });

  test('extract pulls correct details for Northstar California Resort', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const northstar = result.hotels.find(
      (h) => h.name === 'Northstar California Resort',
    );
    expect(northstar).toBeDefined();
    expect(northstar!.starRating).toBe(3);
    expect(northstar!.nightlyPrice).toBe('$189');
    expect(northstar!.totalPrice).toBe('$1,514');
    expect(northstar!.guestRating).toBeCloseTo(4.5, 1);
    expect(northstar!.reviewCount).toBe(6251);
    expect(northstar!.latitude).toBeCloseTo(39.2647, 3);
    expect(northstar!.longitude).toBeCloseTo(-120.1332, 3);
  });

  test('extract pulls correct details for Everline Resort & Spa', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const everline = result.hotels.find((h) =>
      h.name.startsWith('Everline Resort'),
    );
    expect(everline).toBeDefined();
    expect(everline!.starRating).toBe(4);
    expect(everline!.nightlyPrice).toBe('$376');
    expect(everline!.totalPrice).toBe('$3,007');
    expect(everline!.reviewCount).toBe(2085);
  });

  test('every priced hotel has a positive nightly value and matching dates', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const priced = result.hotels.filter((h) => h.nightlyPrice !== null);
    expect(priced.length).toBeGreaterThanOrEqual(5);
    for (const h of priced) {
      expect(h.nightlyPrice!.startsWith('$')).toBe(true);
      if (h.nightlyPriceValue !== null) {
        expect(h.nightlyPriceValue).toBeGreaterThan(0);
      }
      expect(h.checkInDate).toBe('2026-06-19');
      expect(h.checkOutDate).toBe('2026-06-27');
      expect(h.nights).toBe(8);
    }
  });

  test('every hotel carries identifiers, coordinates and a star or rating', () => {
    const result = extract(FIXTURE) as ExtractResult;
    let withCoords = 0;
    let withRating = 0;
    let withToken = 0;
    for (const h of result.hotels) {
      if (h.latitude !== null && h.longitude !== null) withCoords++;
      if (h.guestRating !== null) withRating++;
      if (h.hotelToken !== null) withToken++;
    }
    // Effectively all hotels in this fixture have coordinates + a guest
    // rating + a hotel token; require ≥80 % to leave a little slack.
    const n = result.hotels.length;
    expect(withCoords).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
    expect(withRating).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
    expect(withToken).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
  });

  test('hotels are deduplicated by id (no name appears twice)', () => {
    const result = extract(FIXTURE) as ExtractResult;
    const ids: string[] = [];
    for (const h of result.hotels) {
      const id = h.hotelId ?? h.hotelToken ?? h.name;
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Smoke type assertion: the public Hotel shape stays consistent.
const _typecheck: Hotel = {
  name: 'x',
  latitude: 0,
  longitude: 0,
  starDescription: null,
  starRating: null,
  guestRating: null,
  reviewCount: null,
  nightlyPrice: null,
  nightlyPriceValue: null,
  totalPrice: null,
  totalPriceValue: null,
  description: null,
  photoUrl: null,
  hotelId: null,
  hotelToken: null,
  mapsFeatureId: null,
  checkInDate: null,
  checkOutDate: null,
  nights: null,
};
void _typecheck;
