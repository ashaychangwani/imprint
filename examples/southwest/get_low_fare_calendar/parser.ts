import { parseMoney, type Money } from '../_shared/fare-parser.ts';

interface FareOutput {
  baseFare: Money | null;
  totalFare: Money | null;
  totalTaxesAndFees: Money | null;
}

interface DayOutput {
  date: string;
  fares: Record<string, FareOutput>;
}

interface Context {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function legacyMoney(money: Money | null): { currencyCode: string | null; value: number | null } {
  const value = money === null ? null : Number(money.value);
  return {
    currencyCode: money?.currencyCode ?? null,
    value: Number.isFinite(value) ? value : null,
  };
}

export function extract(rawResponse: unknown, context?: Context): unknown {
  const root = asRecord(rawResponse);
  const data = asRecord(root?.data);
  const rawResults = Array.isArray(data?.searchResults) ? data.searchResults : [];

  const searchResults = rawResults.flatMap((rawResult) => {
    const result = asRecord(rawResult);
    if (!result) return [];

    const origin = typeof result.originationAirportCode === 'string' ? result.originationAirportCode : '';
    const destination = typeof result.destinationAirportCode === 'string' ? result.destinationAirportCode : '';
    const rawDays = Array.isArray(result.lowFareCalendarDays) ? result.lowFareCalendarDays : [];

    const days: DayOutput[] = rawDays.flatMap((rawDay) => {
      const day = asRecord(rawDay);
      if (!day || typeof day.date !== 'string' || day.date.length === 0) return [];
      const rawFares = asRecord(day.fares);
      const fares: Record<string, FareOutput> = {};
      if (rawFares) {
        for (const [family, rawFare] of Object.entries(rawFares)) {
          const fare = asRecord(rawFare);
          if (!fare) continue;
          fares[family] = {
            baseFare: parseMoney(fare.baseFare),
            totalFare: parseMoney(fare.totalFare),
            totalTaxesAndFees: parseMoney(fare.totalTaxesAndFees),
          };
        }
      }
      return [{ date: day.date, fares }];
    });

    if (!origin && !destination && days.length === 0) return [];
    return [{
      originationAirportCode: origin,
      destinationAirportCode: destination,
      international: typeof result.international === 'boolean' ? result.international : null,
      currencyCode: typeof result.currencyCode === 'string' ? result.currencyCode : null,
      days,
    }];
  });

  const calendars = searchResults.map((result) => ({
    originationAirportCode: result.originationAirportCode || null,
    destinationAirportCode: result.destinationAirportCode || null,
    international: result.international,
    currencyCode: result.currencyCode,
    selectedFlight1: context?.params?.departure_date ?? null,
    selectedFlight2: context?.params?.return_date ?? null,
    calendarDays: result.days.map((day) => ({
      date: day.date,
      fares: Object.fromEntries(
        Object.entries(day.fares).map(([family, fare]) => [
          family,
          {
            baseFare: legacyMoney(fare.baseFare),
            totalFare: legacyMoney(fare.totalFare),
            totalTaxesAndFees: legacyMoney(fare.totalTaxesAndFees),
          },
        ]),
      ),
    })),
  }));

  return {
    success: root?.success === true,
    query: {
      originationAirportCode:
        context?.params?.origination_airport_code ?? calendars[0]?.originationAirportCode ?? null,
      destinationAirportCode:
        context?.params?.destination_airport_code ?? calendars[0]?.destinationAirportCode ?? null,
      departureDate: context?.params?.departure_date ?? null,
      tripType: context?.params?.trip_type ?? null,
      adultsCount: context?.params?.adults_count ?? null,
      currencyCode: context?.params?.currency_code ?? calendars[0]?.currencyCode ?? null,
      promoCode: context?.params?.promo_code ?? '',
    },
    calendars,
    searchResults,
  };
}
