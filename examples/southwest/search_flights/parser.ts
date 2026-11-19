import { normalizeFareFamilies, normalizeMoney, normalizeRoute } from "../_shared/fare-normalizer.ts";

type R = Record<string, unknown>;
const record = (v: unknown): v is R => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" ? v : null;

function fares(value: unknown) {
  if (!record(value)) return {};
  const adult = record(value.ADULT) ? value.ADULT : {};
  const fareAmounts: R = {};
  for (const [family, product] of Object.entries(adult)) {
    if (record(product)) fareAmounts[family] = product.fare;
  }
  const normalized = normalizeFareFamilies(fareAmounts);
  return Object.fromEntries(Object.entries(adult).map(([family, product]) => {
    const p = record(product) ? product : {};
    return [family, {
      productId: str(p.productId),
      availabilityStatus: str(p.availabilityStatus),
      passengerType: str(p.passengerType),
      ...normalized[family],
      seatsLeft: record(p.fare) && typeof p.fare.seatsLeft === "number" ? p.fare.seatsLeft : null,
    }];
  }));
}

function flight(value: unknown) {
  if (!record(value)) return null;
  const route = normalizeRoute(value);
  if (!route.originationAirportCode && !route.destinationAirportCode && !str(value.departureTime)) return null;
  return {
    ...route,
    flightNumbers: list(value.flightNumbers).filter((x): x is string => typeof x === "string"),
    departureDateTime: str(value.departureDateTime),
    arrivalDateTime: str(value.arrivalDateTime),
    departureTime: str(value.departureTime),
    arrivalTime: str(value.arrivalTime),
    totalDurationMinutes: num(value.totalDuration),
    nextDay: typeof value.nextDay === "boolean" ? value.nextDay : null,
    filterTags: list(value.filterTags).filter((x): x is string => typeof x === "string"),
    fares: fares(value.fareProducts),
    segments: list(value.segments).filter(record).map(s => ({
      ...normalizeRoute(s),
      flightNumber: str(s.flightNumber),
      departureDateTime: str(s.departureDateTime),
      arrivalDateTime: str(s.arrivalDateTime),
      departureTime: str(s.departureTime),
      arrivalTime: str(s.arrivalTime),
      duration: str(s.duration),
      numberOfStops: num(s.numberOfStops),
      aircraftEquipmentType: str(s.aircraftEquipmentType),
      wifiOnBoard: typeof s.wifiOnBoard === "boolean" ? s.wifiOnBoard : null,
      stops: list(s.stopsDetails).filter(record).map(stop => ({
        ...normalizeRoute(stop),
        flightNumber: str(stop.flightNumber),
        departureTime: str(stop.departureTime),
        arrivalTime: str(stop.arrivalTime),
        changePlanes: typeof stop.changePlanes === "boolean" ? stop.changePlanes : null,
        legDurationMinutes: num(stop.legDuration),
        stopDurationMinutes: num(stop.stopDuration),
      })),
    })),
  };
}

const TIME_WINDOWS = new Set(["ALL_DAY", "BEFORE_NOON", "NOON_TO_SIX", "AFTER_SIX"]);

function requestedTimeWindow(
  params: Record<string, string | number | boolean>,
  name: "departure_time_of_day" | "return_time_of_day",
): string {
  const value = String(params[name] ?? "ALL_DAY").toUpperCase();
  return TIME_WINDOWS.has(value) ? value : "ALL_DAY";
}

function matchesTimeWindow(value: unknown, window: string): boolean {
  if (window === "ALL_DAY" || !record(value)) return true;
  return list(value.filterTags).includes(window);
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  if (!record(rawResponse) || !record(rawResponse.data) || !record(rawResponse.data.searchResults)) {
    if (record(rawResponse) && (rawResponse.error || rawResponse.errors)) {
      throw new Error(
        `SOUTHWEST_SEARCH_ERROR: ${JSON.stringify(rawResponse.error ?? rawResponse.errors)}`,
      );
    }
    throw new Error("Southwest response is missing data.searchResults");
  }
  const search = rawResponse.data.searchResults;
  const params = context?.params ?? {};
  const departureWindow = requestedTimeWindow(params, "departure_time_of_day");
  const returnWindow = requestedTimeWindow(params, "return_time_of_day");
  return {
    promoToken: str(search.promoToken),
    fareSummary: list(search.fareSummary).filter(record).map(x => ({
      fareFamily: str(x.fareFamily),
      minimumFare: normalizeMoney(x.minimumFare),
    })).filter(x => x.fareFamily),
    bounds: list(search.airProducts).filter(record).map((bound, index) => {
      const window = index === 0 ? departureWindow : returnWindow;
      return {
        index,
        ...normalizeRoute(bound),
        containsAvailability: typeof bound.containsAvailability === "boolean" ? bound.containsAvailability : null,
        containsDirect: typeof bound.containsDirect === "boolean" ? bound.containsDirect : null,
        containsNonstop: typeof bound.containsNonstop === "boolean" ? bound.containsNonstop : null,
        fastestDurationMinutes: typeof bound.fastestDuration === "string" ? Number(bound.fastestDuration) : num(bound.fastestDuration),
        lowestFare: normalizeMoney(bound.lowestFare),
        flights: list(bound.details).filter(value => matchesTimeWindow(value, window)).map(flight).filter(Boolean),
      };
    }),
  };
}
