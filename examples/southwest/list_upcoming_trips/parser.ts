type AnyRecord = Record<string, unknown>;

type PassengerName = {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
};

type Passenger = {
  passenger_name?: PassengerName;
  passenger_reference?: string;
  account_number?: string;
  segment_features?: unknown[];
  seats?: unknown[];
};

type Segment = {
  departure_at?: string;
  arrival_at?: string;
  origination_airport_code?: string;
  destination_airport_code?: string;
  flight_number?: string;
  flight_equipment_type_code?: string;
  segment_identifier?: string;
  segment_status?: string;
  boarding_details?: AnyRecord;
  flight_legs?: unknown[];
  ancillary_limits?: unknown[];
};

type Bound = {
  origination_airport_code?: string;
  destination_airport_code?: string;
  segments?: Segment[];
  flown?: boolean;
  next_day?: boolean;
  overnight?: boolean;
  checkin_eligible?: boolean;
  all_passengers_assigned_boarding_positions?: boolean;
  fare_family?: string;
};

type Trip = {
  record_locator?: string;
  trip_type?: string;
  initial_ticket_issuer?: string;
  origin_departure_at?: string;
  destination_departure_at?: string;
  upcoming_travel_at?: string;
  bounds?: Bound[];
  passengers?: Passenger[];
  permissions?: AnyRecord;
  pnr_has_tickets?: boolean;
  pnr_sub_type?: string;
  pnr_type?: string;
  add_companion_eligible?: boolean;
  companion_pricing_token?: string;
  vacation_package_products?: unknown[];
};

type ResponseShape = {
  meta?: { api_version?: string };
  data?: Trip[];
};

function asObject(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function parseResponse(rawResponse: unknown): ResponseShape {
  if (typeof rawResponse === 'string') {
    try {
      return JSON.parse(rawResponse) as ResponseShape;
    } catch {
      return {};
    }
  }
  return asObject(rawResponse) as ResponseShape;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapSegment(segment: Segment) {
  return {
    segmentIdentifier: segment.segment_identifier ?? null,
    status: segment.segment_status ?? null,
    flightNumber: segment.flight_number ?? null,
    equipmentType: segment.flight_equipment_type_code ?? null,
    origin: segment.origination_airport_code ?? null,
    destination: segment.destination_airport_code ?? null,
    departureAt: segment.departure_at ?? null,
    arrivalAt: segment.arrival_at ?? null,
    boardingStatus: nonEmptyString(asObject(segment.boarding_details).acceptance_status) ?? null,
    flightLegs: Array.isArray(segment.flight_legs) ? segment.flight_legs : [],
    ancillaryLimits: Array.isArray(segment.ancillary_limits) ? segment.ancillary_limits : []
  };
}

function mapBound(bound: Bound) {
  return {
    origin: bound.origination_airport_code ?? null,
    destination: bound.destination_airport_code ?? null,
    fareFamily: bound.fare_family ?? null,
    flown: bound.flown ?? false,
    nextDay: bound.next_day ?? false,
    overnight: bound.overnight ?? false,
    checkinEligible: bound.checkin_eligible ?? false,
    allPassengersAssignedBoardingPositions: bound.all_passengers_assigned_boarding_positions ?? false,
    segments: (bound.segments ?? []).filter(Boolean).map(mapSegment)
  };
}

function mapPassenger(passenger: Passenger) {
  const name = passenger.passenger_name ?? {};
  return {
    reference: passenger.passenger_reference ?? null,
    firstName: name.first_name ?? null,
    middleName: name.middle_name ?? null,
    lastName: name.last_name ?? null,
    accountNumber: passenger.account_number ?? null,
    seats: Array.isArray(passenger.seats) ? passenger.seats : [],
    segmentFeatures: Array.isArray(passenger.segment_features) ? passenger.segment_features : []
  };
}

function mapTrip(trip: Trip) {
  return {
    recordLocator: trip.record_locator ?? null,
    tripType: trip.trip_type ?? null,
    initialTicketIssuer: trip.initial_ticket_issuer ?? null,
    originDepartureAt: trip.origin_departure_at ?? null,
    destinationDepartureAt: trip.destination_departure_at ?? null,
    upcomingTravelAt: trip.upcoming_travel_at ?? null,
    bounds: (trip.bounds ?? []).filter(Boolean).map(mapBound),
    passengers: (trip.passengers ?? []).filter(Boolean).map(mapPassenger),
    permissions: trip.permissions ?? {},
    pnrHasTickets: trip.pnr_has_tickets ?? false,
    pnrSubType: trip.pnr_sub_type ?? null,
    pnrType: trip.pnr_type ?? null,
    addCompanionEligible: trip.add_companion_eligible ?? false,
    hasCompanionPricingToken: Boolean(trip.companion_pricing_token),
    vacationPackageProducts: Array.isArray(trip.vacation_package_products) ? trip.vacation_package_products : []
  };
}

export function extract(rawResponse: unknown): unknown {
  const response = parseResponse(rawResponse);
  const trips = Array.isArray(response.data) ? response.data : [];
  const mappedTrips = trips
    .filter((trip) => nonEmptyString(trip?.record_locator))
    .map(mapTrip);

  return {
    apiVersion: response.meta?.api_version ?? null,
    count: mappedTrips.length,
    trips: mappedTrips
  };
}
