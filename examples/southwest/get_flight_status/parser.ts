type FlightStatusResponse = {
  data?: {
    searchResults?: Array<{
      summary?: FlightSummary;
      details?: FlightDetail[];
      flightNumbers?: string[];
    }>;
  };
  success?: boolean;
  notifications?: unknown;
};

type FlightSummary = {
  originationAirportCode?: string;
  destinationAirportCode?: string;
  flightNumbers?: string[];
  departureTime?: string;
  departureStatus?: string;
  arrivalTime?: string;
  arrivalStatus?: string;
  totalDuration?: number;
  numberOfStops?: number;
  stopsDetails?: StopDetail[];
  nextDay?: boolean;
};

type FlightDetail = {
  originationAirportCode?: string;
  destinationAirportCode?: string;
  departureScheduledTime?: string;
  departureActualTime?: string;
  departureStatus?: string;
  departureGate?: string;
  arrivalScheduledTime?: string;
  arrivalActualTime?: string;
  arrivalStatus?: string;
  arrivalGate?: string;
  flightNumber?: string;
  flightStatusStopDetail?: StopDetail;
};

type StopDetail = {
  originationAirportCode?: string;
  destinationAirportCode?: string;
  flightNumber?: string;
  legDuration?: number;
  stopDuration?: number;
  changePlanes?: boolean | null;
  departureTime?: string;
  departureDate?: string;
  operatingCarrierCode?: string;
  aircraftEquipmentType?: string;
  stopLocationCodes?: string[] | null;
  features?: unknown[];
  overnight?: boolean;
};

function asObject(rawResponse: unknown): FlightStatusResponse {
  if (typeof rawResponse === 'string') {
    try {
      return JSON.parse(rawResponse) as FlightStatusResponse;
    } catch {
      return {};
    }
  }
  if (rawResponse && typeof rawResponse === 'object') {
    return rawResponse as FlightStatusResponse;
  }
  return {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function mapStop(stop: StopDetail) {
  return {
    origin: stop.originationAirportCode ?? null,
    destination: stop.destinationAirportCode ?? null,
    flight_number: stop.flightNumber ?? null,
    leg_duration_minutes: stop.legDuration ?? null,
    stop_duration_minutes: stop.stopDuration ?? null,
    change_planes: stop.changePlanes ?? null,
    departure_time: stop.departureTime ?? null,
    departure_date: stop.departureDate ?? null,
    operating_carrier: stop.operatingCarrierCode ?? null,
    aircraft_equipment_type: stop.aircraftEquipmentType ?? null,
    stop_location_codes: stop.stopLocationCodes ?? null,
    overnight: stop.overnight ?? null,
  };
}

export function extract(rawResponse: unknown): unknown {
  const data = asObject(rawResponse);
  const results = Array.isArray(data.data?.searchResults) ? data.data.searchResults : [];

  const flights = results
    .map((result) => {
      const summary = result.summary ?? {};
      const stops = Array.isArray(summary.stopsDetails) ? summary.stopsDetails : [];
      const firstStop = stops[0] ?? {};
      const details = Array.isArray(result.details) ? result.details : [];
      const firstDetail = details[0] ?? {};
      const flightNumber = summary.flightNumbers?.[0] ?? result.flightNumbers?.[0] ?? firstStop.flightNumber ?? firstDetail.flightNumber ?? null;

      return {
        origin: summary.originationAirportCode ?? firstStop.originationAirportCode ?? null,
        destination: summary.destinationAirportCode ?? firstStop.destinationAirportCode ?? null,
        flight_number: flightNumber,
        departure_time: summary.departureTime ?? firstDetail.departureScheduledTime ?? null,
        departure_status: summary.departureStatus ?? firstDetail.departureStatus ?? null,
        arrival_time: summary.arrivalTime ?? firstDetail.arrivalScheduledTime ?? null,
        arrival_status: summary.arrivalStatus ?? firstDetail.arrivalStatus ?? null,
        duration_minutes: summary.totalDuration ?? firstStop.legDuration ?? null,
        stops: summary.numberOfStops ?? null,
        date: firstStop.departureDate ?? firstDetail.flightStatusStopDetail?.departureDate ?? null,
        operating_carrier: firstStop.operatingCarrierCode ?? firstDetail.flightStatusStopDetail?.operatingCarrierCode ?? null,
        next_day_arrival: summary.nextDay ?? null,
        details: {
          departure_scheduled_time: firstDetail.departureScheduledTime ?? null,
          departure_actual_time: firstDetail.departureActualTime ?? null,
          departure_gate: firstDetail.departureGate ?? null,
          arrival_scheduled_time: firstDetail.arrivalScheduledTime ?? null,
          arrival_actual_time: firstDetail.arrivalActualTime ?? null,
          arrival_gate: firstDetail.arrivalGate ?? null,
        },
        segments: stops.map(mapStop),
      };
    })
    .filter((flight) => nonEmpty(flight.origin) || nonEmpty(flight.destination) || nonEmpty(flight.flight_number));

  return {
    success: data.success === true,
    count: flights.length,
    flights,
    notifications: data.notifications ?? null,
  };
}
