import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extract } from './parser';

const fixtureResponse = readFileSync(
  join(
    import.meta.dir,
    '../../../test/fixtures/examples/google-flights/search_google_flights/fixture_response.txt',
  ),
  'utf-8'
);

describe('Google Flights parser', () => {
  test('extract returns an object with flights array', () => {
    const result = extract(fixtureResponse) as any;
    expect(result).toBeDefined();
    expect(result.flights).toBeDefined();
    expect(Array.isArray(result.flights)).toBe(true);
  });

  test('returns multiple flights (SFO to Tokyo search)', () => {
    const result = extract(fixtureResponse) as any;
    expect(result.flights.length).toBeGreaterThan(0);
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.flights.length).toBe(result.totalCount);
  });

  test('flights originate from SFO (San Francisco)', () => {
    const result = extract(fixtureResponse) as any;
    const sfFlights = result.flights.filter((f: any) => f.origin === 'SFO');
    expect(sfFlights.length).toBeGreaterThan(0);
    // All flights should be from SFO
    expect(result.flights.every((f: any) => f.origin === 'SFO')).toBe(true);
  });

  test('flights go to Tokyo airports (NRT or HND)', () => {
    const result = extract(fixtureResponse) as any;
    const tokyoFlights = result.flights.filter(
      (f: any) => f.destination === 'NRT' || f.destination === 'HND'
    );
    expect(tokyoFlights.length).toBeGreaterThan(0);
    // All flights should go to Tokyo area airports
    expect(result.flights.every((f: any) => f.destination === 'NRT' || f.destination === 'HND')).toBe(true);
  });

  test('flights have valid prices in USD', () => {
    const result = extract(fixtureResponse) as any;
    const flightsWithPrice = result.flights.filter((f: any) => f.priceUsd !== null);
    expect(flightsWithPrice.length).toBeGreaterThan(0);
    // Prices should be reasonable for SFO-TYO (between $500 and $10000)
    for (const flight of flightsWithPrice) {
      expect(flight.priceUsd).toBeGreaterThan(500);
      expect(flight.priceUsd).toBeLessThan(10000);
    }
  });

  test('cheapest flight is ZIPAIR Tokyo at $1245', () => {
    const result = extract(fixtureResponse) as any;
    // Flights are sorted by price ascending
    const cheapest = result.flights[0];
    expect(cheapest.priceUsd).toBe(1245);
    expect(cheapest.airlineCode).toBe('ZG');
    expect(cheapest.airlineName).toBe('ZIPAIR Tokyo');
  });

  test('flights have valid departure dates in 2026', () => {
    const result = extract(fixtureResponse) as any;
    for (const flight of result.flights) {
      expect(flight.departureDate).toMatch(/^2026-/);
      expect(flight.departureDate).toBeTruthy();
    }
  });

  test('flights have valid departure and arrival times', () => {
    const result = extract(fixtureResponse) as any;
    for (const flight of result.flights) {
      expect(flight.departureTime).toMatch(/^\d{2}:\d{2}$/);
      expect(flight.arrivalTime).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  test('flights have positive duration in minutes', () => {
    const result = extract(fixtureResponse) as any;
    for (const flight of result.flights) {
      // SFO to Tokyo is roughly 10-28 hours
      expect(flight.durationMinutes).toBeGreaterThan(600);
      expect(flight.durationMinutes).toBeLessThan(2000);
    }
  });

  test('flights have segment details', () => {
    const result = extract(fixtureResponse) as any;
    for (const flight of result.flights) {
      expect(Array.isArray(flight.segments)).toBe(true);
      expect(flight.segments.length).toBeGreaterThan(0);
      const seg = flight.segments[0];
      expect(seg.origin).toBe('SFO');
      expect(seg.flightNumber).toBeTruthy();
      expect(seg.aircraft).toBeTruthy();
    }
  });

  test('includes known airlines: United, ANA, JAL', () => {
    const result = extract(fixtureResponse) as any;
    const airlineCodes = result.flights.map((f: any) => f.airlineCode);
    expect(airlineCodes).toContain('UA'); // United
    expect(airlineCodes).toContain('NH'); // ANA
    expect(airlineCodes).toContain('JL'); // JAL
  });

  test('United flight to NRT costs $1809', () => {
    const result = extract(fixtureResponse) as any;
    const unitedNRT = result.flights.find(
      (f: any) => f.airlineCode === 'UA' && f.destination === 'NRT'
    );
    expect(unitedNRT).toBeDefined();
    expect(unitedNRT.priceUsd).toBe(1809);
    expect(unitedNRT.durationMinutes).toBe(635);
  });

  test('flights have booking tokens', () => {
    const result = extract(fixtureResponse) as any;
    const flightsWithToken = result.flights.filter((f: any) => f.bookingToken !== null);
    expect(flightsWithToken.length).toBeGreaterThan(0);
  });

  test('stops field is correctly parsed (0 for nonstop, 1+ for connecting)', () => {
    const result = extract(fixtureResponse) as any;
    // All flights in this response have at least 1 segment
    for (const flight of result.flights) {
      expect(flight.stopCount).toBeGreaterThanOrEqual(0);
    }
    // Asiana Airlines goes via ICN (1 stop)
    const asiana = result.flights.find((f: any) => f.airlineCode === 'OZ');
    if (asiana) {
      expect(asiana.stopCount).toBeGreaterThan(0);
    }
  });
});
