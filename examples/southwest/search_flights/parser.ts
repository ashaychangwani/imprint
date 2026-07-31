type Money = {
  currencyCode?: string;
  value?: string | number;
};

type FareProduct = {
  productId?: string;
  availabilityStatus?: string;
  passengerType?: string;
  fare?: {
    accrualPoints?: string;
    baseFare?: Money;
    totalFare?: Money;
    totalTaxesAndFees?: Money;
    totalFareBaselineDifference?: Money;
    seatsLeft?: number;
  };
};

type Segment = {
  operatingCarrierCode?: string;
  marketingCarrierCode?: string;
  flightNumber?: string;
  originationAirportCode?: string;
  destinationAirportCode?: string;
  departureDateTime?: string;
  arrivalDateTime?: string;
  departureTime?: string;
  arrivalTime?: string;
  duration?: string;
  numberOfStops?: number;
  aircraftEquipmentType?: string;
  wifiOnBoard?: boolean;
  stopsDetails?: Array<Record<string, unknown>>;
};

type FlightDetail = {
  nextDay?: boolean;
  totalDuration?: number;
  filterTags?: string[];
  fareProducts?: {
    ADULT?: Record<string, FareProduct>;
    [passengerType: string]: Record<string, FareProduct> | undefined;
  };
  originationAirportCode?: string;
  destinationAirportCode?: string;
  flightNumbers?: string[];
  departureDateTime?: string;
  arrivalDateTime?: string;
  departureTime?: string;
  arrivalTime?: string;
  segments?: Segment[];
};

type AirProduct = {
  originationAirportCode?: string;
  destinationAirportCode?: string;
  fastestDuration?: string;
  lowestFare?: Money & { fareFamily?: string };
  containsAfterSix?: boolean;
  containsAvailability?: boolean;
  containsBeforeNoon?: boolean;
  containsDirect?: boolean;
  containsNonstop?: boolean;
  containsNoonToSix?: boolean;
  containsStops?: boolean;
  containsTimeOfDay?: boolean;
  containsOnlyPlaneChange?: boolean;
  details?: FlightDetail[];
};

type SearchResponse = {
  data?: {
    searchResults?: {
      fareSummary?: Array<{ fareFamily?: string; minimumFare?: Money }>;
      airProducts?: AirProduct[];
      promoToken?: string;
    };
  };
};

type ParserContext = {
  params?: Record<string, string | number | boolean>;
  responses?: unknown[];
};

function moneyValue(money: Money | undefined): number | null {
  if (!money || money.value === undefined || money.value === null || money.value === '') return null;
  const parsed = Number(money.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  ) as T;
}

function parseFares(detail: FlightDetail): Array<Record<string, unknown>> {
  const adultFares = detail.fareProducts?.ADULT ?? {};
  return Object.entries(adultFares)
    .map(([fareFamily, product]) => {
      const totalFare = product?.fare?.totalFare;
      return compactRecord({
        fareFamily,
        productId: product?.productId,
        availabilityStatus: product?.availabilityStatus,
        passengerType: product?.passengerType,
        currency: totalFare?.currencyCode,
        price: moneyValue(totalFare),
        baseFare: moneyValue(product?.fare?.baseFare),
        taxesAndFees: moneyValue(product?.fare?.totalTaxesAndFees),
        accrualPoints: product?.fare?.accrualPoints ? Number(product.fare.accrualPoints) : undefined,
        seatsLeft: product?.fare?.seatsLeft,
      });
    })
    .filter((fare) => fare.fareFamily && (fare.price !== null || fare.availabilityStatus));
}

function parseSegments(segments: Segment[] | undefined): Array<Record<string, unknown>> {
  return (segments ?? [])
    .map((segment) => compactRecord({
      carrier: segment.marketingCarrierCode ?? segment.operatingCarrierCode,
      operatingCarrier: segment.operatingCarrierCode,
      flightNumber: segment.flightNumber,
      originationAirportCode: segment.originationAirportCode,
      destinationAirportCode: segment.destinationAirportCode,
      departureDateTime: segment.departureDateTime,
      arrivalDateTime: segment.arrivalDateTime,
      departureTime: segment.departureTime,
      arrivalTime: segment.arrivalTime,
      duration: segment.duration,
      numberOfStops: segment.numberOfStops,
      aircraftEquipmentType: segment.aircraftEquipmentType,
      wifiOnBoard: segment.wifiOnBoard,
      stopsDetails: segment.stopsDetails ?? [],
    }))
    .filter((segment) => segment.flightNumber || segment.originationAirportCode || segment.destinationAirportCode);
}

function requestedAdultsCount(context: ParserContext | undefined): number {
  const raw = context?.params?.adults_count;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function withPassengerTotals(fares: Array<Record<string, unknown>>, adultsCount: number): Array<Record<string, unknown>> {
  return fares.map((fare) => {
    const price = typeof fare.price === 'number' ? fare.price : null;
    return compactRecord({
      ...fare,
      passengerCount: adultsCount,
      totalPrice: price === null ? undefined : Number((price * adultsCount).toFixed(2)),
    });
  });
}

export function extract(rawResponse: unknown, context?: ParserContext): unknown {
  const response = rawResponse as SearchResponse;
  const adultsCount = requestedAdultsCount(context);
  const searchResults = response?.data?.searchResults;
  const fareSummary = (searchResults?.fareSummary ?? [])
    .map((summary) => compactRecord({
      fareFamily: summary.fareFamily,
      currency: summary.minimumFare?.currencyCode,
      minimumFare: moneyValue(summary.minimumFare),
      minimumFareMoney: summary.minimumFare?.value == null
        ? undefined
        : {
            value: String(summary.minimumFare.value),
            currencyCode: summary.minimumFare.currencyCode ?? null,
          },
    }))
    .filter((summary) => summary.fareFamily || summary.minimumFare !== null);

  const flights = (searchResults?.airProducts ?? []).flatMap((product) => {
    return (product.details ?? []).map((detail) => {
      const segments = parseSegments(detail.segments);
      const fares = withPassengerTotals(parseFares(detail), adultsCount);
      const stopCount = Math.max(0, segments.length - 1);
      const lowestFare = fares
        .filter((fare) => typeof fare.price === 'number')
        .sort((a, b) => Number(a.price) - Number(b.price))[0];

      return compactRecord({
        originationAirportCode: detail.originationAirportCode ?? product.originationAirportCode,
        destinationAirportCode: detail.destinationAirportCode ?? product.destinationAirportCode,
        origin: detail.originationAirportCode ?? product.originationAirportCode,
        destination: detail.destinationAirportCode ?? product.destinationAirportCode,
        departureDateTime: detail.departureDateTime,
        arrivalDateTime: detail.arrivalDateTime,
        departureTime: detail.departureTime,
        arrivalTime: detail.arrivalTime,
        flightNumbers: detail.flightNumbers ?? segments.map((segment) => String(segment.flightNumber)).filter(Boolean),
        durationMinutes: detail.totalDuration,
        totalDurationMinutes: detail.totalDuration,
        duration: segments.length === 1 ? segments[0]?.duration : undefined,
        stopCount,
        stops: stopCount + segments.reduce(
          (sum, segment) => sum + (
            typeof segment.numberOfStops === 'number' ? segment.numberOfStops : 0
          ),
          0,
        ),
        nonstop: stopCount === 0,
        nextDay: detail.nextDay,
        filterTags: detail.filterTags ?? [],
        availability: detail.filterTags ?? [],
        passengerCount: adultsCount,
        lowestFare,
        fares,
        segments,
      });
    });
  }).filter((flight) => {
    return Boolean(
      flight.originationAirportCode ||
      flight.destinationAirportCode ||
      (Array.isArray(flight.flightNumbers) && flight.flightNumbers.length > 0),
    );
  });

  return {
    requestedAdultsCount: adultsCount,
    fareSummary,
    flights,
    itineraries: flights,
    count: flights.length,
    promoToken: searchResults?.promoToken ?? '',
  };
}
