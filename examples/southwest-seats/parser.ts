/**
 * Parser for Southwest's POST /api/seat-management/v1/seatmaps/selections
 * response. Flattens the nested seatmap (cabins → rows → seats) into a
 * compact, agent-friendly summary keyed by seat id ("12A", "1F", etc.),
 * surfaces the price-tier summary, and lists each flight segment.
 *
 * Input shape (relevant subset):
 *   {
 *     meta: { spec_version: "1.107.0" },
 *     data: [
 *       {
 *         flight_segment: { marketing_carrier_code, marketing_flight_number,
 *                           origination_airport_code, destination_airport_code,
 *                           depart_at, flight_equipment_type_code },
 *         cabins: [
 *           {
 *             columns: [{ type, column?, position? }, ...],
 *             row_start, row_end,
 *             rows: [
 *               { facilities?: [...] }            // bulkhead / lavatory / galley
 *               | { row_number, seats: [
 *                     { column, characteristics, available,
 *                       price?: { total_fare: { amount, currency }, ... },
 *                       seat_transaction_information: [...] }
 *                 ] }
 *             ]
 *           }
 *         ],
 *         price_summary: {
 *           FRONT_CABIN: { min_price: { total_fare: { amount } }, max_price: ... },
 *           EXTRA_LEGROOM: ..., PREFERRED: ..., EXIT_ROW: ..., BULKHEAD_SEAT: ...
 *         }
 *       }
 *     ]
 *   }
 */

export interface SeatOption {
  /** Combined row+column id, e.g. "1A", "12F". */
  id: string;
  row: number;
  column: string;
  /** WINDOW / MIDDLE / AISLE if known. */
  position: string | null;
  /** Raw characteristic tags (FRONT_CABIN, BULKHEAD_SEAT, EXTRA_LEGROOM, EXIT_ROW, STANDARD, PREFERRED, ...). */
  characteristics: string[];
  /** High-level seat tier picked from `characteristics` (FRONT_CABIN > EXIT_ROW > EXTRA_LEGROOM > PREFERRED > STANDARD). */
  tier: string;
  available: boolean;
  /** USD upgrade price for this seat, or 0 if non-chargeable / no price block. */
  priceUsd: number;
  currency: string | null;
}

export interface PriceTier {
  tier: string;
  minPriceUsd: number;
  maxPriceUsd: number;
  currency: string;
}

export interface FlightSegmentSummary {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departAt: string;
  equipment: string;
  /** Highest row number seen on this segment's seat map. */
  totalRows: number;
  /** Number of available (selectable) seats. */
  availableSeatsCount: number;
  /** Number of seats that require a payment to upgrade into. */
  chargeableSeatsCount: number;
  seats: SeatOption[];
  priceTiers: PriceTier[];
}

export interface SeatUpgradeResult {
  specVersion: string | null;
  segments: FlightSegmentSummary[];
}

const TIER_PRIORITY = [
  'FRONT_CABIN',
  'EXIT_ROW',
  'EXTRA_LEGROOM',
  'PREFERRED',
  'BULKHEAD_SEAT',
  'STANDARD',
] as const;

function pickTier(characteristics: string[]): string {
  for (const t of TIER_PRIORITY) {
    if (characteristics.includes(t)) return t;
  }
  return characteristics[0] ?? 'UNKNOWN';
}

function toAmount(s: string | undefined | null): number {
  if (s === undefined || s === null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

interface RawColumn {
  type: string;
  column?: string;
  position?: string;
}

interface RawSeat {
  column: string;
  characteristics?: string[];
  available?: boolean;
  price?: {
    total_fare?: { amount?: string; currency?: string };
  };
}

interface RawRow {
  row_number?: number;
  seats?: RawSeat[];
  facilities?: unknown[];
}

interface RawCabin {
  columns?: RawColumn[];
  row_start?: number;
  row_end?: number;
  rows?: RawRow[];
}

interface RawPriceBlock {
  min_price?: { total_fare?: { amount?: string; currency?: string } };
  max_price?: { total_fare?: { amount?: string; currency?: string } };
}

interface RawSegmentEntry {
  flight_segment?: {
    marketing_carrier_code?: string;
    marketing_flight_number?: string;
    origination_airport_code?: string;
    destination_airport_code?: string;
    depart_at?: string;
    flight_equipment_type_code?: string;
  };
  cabins?: RawCabin[];
  price_summary?: Record<string, RawPriceBlock>;
}

interface RawResponse {
  meta?: { spec_version?: string };
  data?: RawSegmentEntry[];
}

export function extract(rawResponse: unknown): SeatUpgradeResult {
  const root = (rawResponse ?? {}) as RawResponse;
  const data = Array.isArray(root.data) ? root.data : [];

  const segments: FlightSegmentSummary[] = data.map((entry) => {
    const fs = entry.flight_segment ?? {};
    const cabins = Array.isArray(entry.cabins) ? entry.cabins : [];

    // Build a column-position lookup so we can label seats with their
    // window/middle/aisle position from the cabins[].columns header.
    const columnPosition = new Map<string, string>();
    for (const cab of cabins) {
      for (const col of cab.columns ?? []) {
        if (col.column && col.position) columnPosition.set(col.column, col.position);
      }
    }

    const seats: SeatOption[] = [];
    let maxRow = 0;
    for (const cab of cabins) {
      for (const row of cab.rows ?? []) {
        if (typeof row.row_number !== 'number' || !Array.isArray(row.seats)) continue;
        if (row.row_number > maxRow) maxRow = row.row_number;
        for (const seat of row.seats) {
          const characteristics = Array.isArray(seat.characteristics) ? seat.characteristics : [];
          const totalFare = seat.price?.total_fare;
          seats.push({
            id: `${row.row_number}${seat.column}`,
            row: row.row_number,
            column: seat.column,
            position: columnPosition.get(seat.column) ?? null,
            characteristics,
            tier: pickTier(characteristics),
            available: seat.available === true,
            priceUsd: toAmount(totalFare?.amount),
            currency: totalFare?.currency ?? null,
          });
        }
      }
    }

    const priceTiers: PriceTier[] = Object.entries(entry.price_summary ?? {}).map(
      ([tier, block]) => ({
        tier,
        minPriceUsd: toAmount(block.min_price?.total_fare?.amount),
        maxPriceUsd: toAmount(block.max_price?.total_fare?.amount),
        currency:
          block.min_price?.total_fare?.currency ??
          block.max_price?.total_fare?.currency ??
          'USD',
      }),
    );

    const availableSeatsCount = seats.filter((s) => s.available).length;
    const chargeableSeatsCount = seats.filter((s) => s.priceUsd > 0).length;

    return {
      carrier: fs.marketing_carrier_code ?? '',
      flightNumber: fs.marketing_flight_number ?? '',
      origin: fs.origination_airport_code ?? '',
      destination: fs.destination_airport_code ?? '',
      departAt: fs.depart_at ?? '',
      equipment: fs.flight_equipment_type_code ?? '',
      totalRows: maxRow,
      availableSeatsCount,
      chargeableSeatsCount,
      seats,
      priceTiers,
    };
  });

  return {
    specVersion: root.meta?.spec_version ?? null,
    segments,
  };
}
