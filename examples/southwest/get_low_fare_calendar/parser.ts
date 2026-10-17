import { normalizeFareFamilies, normalizeRoute } from "../_shared/fare-normalizer.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extract(rawResponse: unknown): unknown {
  if (
    !isRecord(rawResponse) ||
    !isRecord(rawResponse.data) ||
    !Array.isArray(rawResponse.data.searchResults)
  ) {
    throw new Error('SOUTHWEST_CALENDAR_UNPARSED: expected data.searchResults array');
  }
  const searchResults = rawResponse.data.searchResults;

  const results = searchResults.filter(isRecord).map((result) => {
    const route = normalizeRoute(result);
    const days = Array.isArray(result.lowFareCalendarDays)
      ? result.lowFareCalendarDays
          .filter(isRecord)
          .map((day) => ({
            date: typeof day.date === "string" ? day.date : null,
            fares: normalizeFareFamilies(day.fares),
          }))
          .filter((day) => day.date !== null)
      : [];

    return {
      ...route,
      international: typeof result.international === "boolean" ? result.international : null,
      currencyCode: typeof result.currencyCode === "string" ? result.currencyCode : null,
      days,
    };
  }).filter((result) =>
    result.originationAirportCode !== null ||
    result.destinationAirportCode !== null ||
    result.days.length > 0
  );

  return { results };
}
