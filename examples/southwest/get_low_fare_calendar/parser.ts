type Money = {
  currencyCode?: string;
  value?: string | number;
};

type Fare = {
  baseFare?: Money;
  totalFare?: Money;
  totalTaxesAndFees?: Money;
};

type CalendarDay = {
  date?: string;
  fares?: Record<string, Fare>;
};

type SearchResult = {
  destinationAirportCode?: string;
  originationAirportCode?: string;
  international?: boolean;
  currencyCode?: string;
  lowFareCalendarDays?: CalendarDay[];
};

type SouthwestResponse = {
  success?: boolean;
  data?: {
    searchResults?: SearchResult[];
  };
};

type Context = {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
};

function toNumber(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMoney(money: Money | undefined): { currencyCode: string | null; value: number | null } {
  return {
    currencyCode: money?.currencyCode ?? null,
    value: toNumber(money?.value),
  };
}

function normalizeFares(fares: Record<string, Fare> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (!fares || typeof fares !== 'object') return normalized;

  for (const [family, fare] of Object.entries(fares)) {
    if (!family || !fare || typeof fare !== 'object') continue;
    normalized[family] = {
      baseFare: normalizeMoney(fare.baseFare),
      totalFare: normalizeMoney(fare.totalFare),
      totalTaxesAndFees: normalizeMoney(fare.totalTaxesAndFees),
    };
  }

  return normalized;
}

export function extract(rawResponse: unknown, context?: Context): unknown {
  const response = rawResponse as SouthwestResponse;
  const searchResults = Array.isArray(response?.data?.searchResults) ? response.data.searchResults : [];
  const calendars = searchResults
    .filter((result) => result && typeof result === 'object')
    .map((result) => {
      const days = Array.isArray(result.lowFareCalendarDays) ? result.lowFareCalendarDays : [];
      const calendarDays = days
        .filter((day) => day?.date)
        .map((day) => ({
          date: day.date,
          fares: normalizeFares(day.fares),
        }))
        .filter((day) => Object.keys(day.fares).length > 0);

      return {
        originationAirportCode: result.originationAirportCode ?? null,
        destinationAirportCode: result.destinationAirportCode ?? null,
        international: result.international ?? null,
        currencyCode: result.currencyCode ?? null,
        selectedFlight1: context?.params?.departure_date ?? null,
        selectedFlight2: null,
        calendarDays,
      };
    })
    .filter((calendar) => calendar.originationAirportCode || calendar.destinationAirportCode || calendar.calendarDays.length > 0);

  return {
    success: response?.success === true,
    query: {
      originationAirportCode: context?.params?.origination_airport_code ?? calendars[0]?.originationAirportCode ?? null,
      destinationAirportCode: context?.params?.destination_airport_code ?? calendars[0]?.destinationAirportCode ?? null,
      departureDate: context?.params?.departure_date ?? null,
      tripType: context?.params?.trip_type ?? null,
      adultsCount: context?.params?.adults_count ?? null,
      currencyCode: context?.params?.currency_code ?? calendars[0]?.currencyCode ?? null,
      promoCode: context?.params?.promo_code ?? '',
    },
    calendars,
  };
}
