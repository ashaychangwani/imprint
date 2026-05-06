/**
 * Test extract() against the captured Southwest seat-map response from the
 * recorded session. Anchors on real values: flight 2188 FAT→SAN on 2026-05-20,
 * the 7S7 (Boeing 737-700) equipment, and the FRONT_CABIN $48–$54 fare band.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract, type SeatUpgradeResult } from './parser.ts';

const SESSION_PATH = join(
  import.meta.dir,
  'sessions',
  '2026-05-06T07-20-10-599Z.redacted.json',
);

interface CapturedRequest {
  url: string;
  method: string;
  response?: { body?: string };
}

function loadSeatmapResponse(): unknown {
  const session = JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as {
    requests: CapturedRequest[];
  };
  const seatmapReq = session.requests.find(
    (r) =>
      r.method === 'POST' &&
      r.url.includes('/api/seat-management/v1/seatmaps/selections'),
  );
  if (!seatmapReq?.response?.body) {
    throw new Error('seatmap response body not present in session');
  }
  return JSON.parse(seatmapReq.response.body);
}

const RAW = loadSeatmapResponse();
const RESULT: SeatUpgradeResult = extract(RAW);

describe('Southwest seat upgrade parser', () => {
  test('reports the API spec version from meta', () => {
    expect(RESULT.specVersion).toBe('1.107.0');
  });

  test('returns exactly one flight segment for the captured one-way reservation', () => {
    expect(RESULT.segments).toHaveLength(1);
  });

  test('segment carries the recorded FAT→SAN flight 2188 on the 737-700', () => {
    const segment = RESULT.segments[0]!;
    expect(segment.carrier).toBe('WN');
    expect(segment.flightNumber).toBe('2188');
    expect(segment.origin).toBe('FAT');
    expect(segment.destination).toBe('SAN');
    expect(segment.departAt).toBe('2026-05-20');
    expect(segment.equipment).toBe('7S7');
  });

  test('seat map spans rows 1 through 27 across all six columns A–F', () => {
    const segment = RESULT.segments[0]!;
    expect(segment.totalRows).toBe(27);
    // 23 numbered rows × 6 columns = 138 seats (rows 10–13 are intentionally
    // absent in Southwest's 7S7 layout response).
    expect(segment.seats).toHaveLength(138);
    const columns = new Set(segment.seats.map((s) => s.column));
    expect([...columns].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const rowNumbers = new Set(segment.seats.map((s) => s.row));
    expect(rowNumbers.has(1)).toBe(true);
    expect(rowNumbers.has(27)).toBe(true);
  });

  test('row 1 seat A is a $54 bulkhead front-cabin extra-legroom window seat', () => {
    const segment = RESULT.segments[0]!;
    const seat1A = segment.seats.find((s) => s.id === '1A');
    expect(seat1A).toBeDefined();
    expect(seat1A!.row).toBe(1);
    expect(seat1A!.column).toBe('A');
    expect(seat1A!.position).toBe('WINDOW');
    expect(seat1A!.priceUsd).toBe(54);
    expect(seat1A!.currency).toBe('USD');
    expect(seat1A!.characteristics).toEqual(
      expect.arrayContaining(['FRONT_CABIN', 'BULKHEAD_SEAT', 'EXTRA_LEGROOM']),
    );
    expect(seat1A!.tier).toBe('FRONT_CABIN');
  });

  test('row 1 middle seats (B and E) are priced lower than the window/aisle seats at $48', () => {
    const segment = RESULT.segments[0]!;
    const seat1B = segment.seats.find((s) => s.id === '1B')!;
    const seat1E = segment.seats.find((s) => s.id === '1E')!;
    expect(seat1B.position).toBe('MIDDLE');
    expect(seat1E.position).toBe('MIDDLE');
    expect(seat1B.priceUsd).toBe(48);
    expect(seat1E.priceUsd).toBe(48);
  });

  test('row 1F is available for selection while 1A is held by a passenger', () => {
    const segment = RESULT.segments[0]!;
    const seat1A = segment.seats.find((s) => s.id === '1A')!;
    const seat1F = segment.seats.find((s) => s.id === '1F')!;
    expect(seat1A.available).toBe(false);
    expect(seat1F.available).toBe(true);
  });

  test('back-of-cabin standard seats (row 25) are non-chargeable but available', () => {
    const segment = RESULT.segments[0]!;
    const seat25A = segment.seats.find((s) => s.id === '25A')!;
    expect(seat25A.tier).toBe('STANDARD');
    expect(seat25A.priceUsd).toBe(0);
    expect(seat25A.available).toBe(true);
  });

  test('availability and chargeable counts are non-trivial', () => {
    const segment = RESULT.segments[0]!;
    expect(segment.availableSeatsCount).toBeGreaterThan(50);
    expect(segment.chargeableSeatsCount).toBeGreaterThan(0);
    expect(segment.chargeableSeatsCount).toBeLessThan(segment.seats.length);
  });

  test('price summary surfaces FRONT_CABIN $48–$54 and EXTRA_LEGROOM $43–$54 bands', () => {
    const segment = RESULT.segments[0]!;
    const front = segment.priceTiers.find((t) => t.tier === 'FRONT_CABIN');
    expect(front).toBeDefined();
    expect(front!.minPriceUsd).toBe(48);
    expect(front!.maxPriceUsd).toBe(54);

    const extraLegroom = segment.priceTiers.find((t) => t.tier === 'EXTRA_LEGROOM');
    expect(extraLegroom).toBeDefined();
    expect(extraLegroom!.minPriceUsd).toBe(43);
    expect(extraLegroom!.maxPriceUsd).toBe(54);

    const tierNames = new Set(segment.priceTiers.map((t) => t.tier));
    expect(tierNames.has('EXIT_ROW')).toBe(true);
    expect(tierNames.has('PREFERRED')).toBe(true);
  });
});
