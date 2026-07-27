type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function extract(rawResponse: unknown): unknown {
  const root = record(rawResponse);
  if (!Array.isArray(root.data)) {
    throw new Error('SOUTHWEST_TRIPS_UNPARSED: expected data array');
  }
  const source = root.data;

  const trips = source
    .map((rawTrip) => {
      const trip = record(rawTrip);
      const bounds = (Array.isArray(trip.bounds) ? trip.bounds : []).map((rawBound) => {
        const bound = record(rawBound);
        const segments = (Array.isArray(bound.segments) ? bound.segments : []).map((rawSegment) => {
          const segment = record(rawSegment);
          const boarding = record(segment.boarding_details);
          return {
            segment_identifier: segment.segment_identifier ?? null,
            status: segment.segment_status ?? null,
            origin_airport_code: segment.origination_airport_code ?? null,
            destination_airport_code: segment.destination_airport_code ?? null,
            departure_at: segment.departure_at ?? null,
            arrival_at: segment.arrival_at ?? null,
            flight_number: segment.flight_number ?? null,
            equipment_type_code: segment.flight_equipment_type_code ?? null,
            boarding_acceptance_status: boarding.acceptance_status ?? null,
            flight_legs: (Array.isArray(segment.flight_legs) ? segment.flight_legs : []).map((rawLeg) => {
              const leg = record(rawLeg);
              return {
                flight_leg_identifier: leg.flight_leg_identifier ?? null,
                origin_airport_code: leg.origination_airport_code ?? null,
                destination_airport_code: leg.destination_airport_code ?? null,
              };
            }),
          };
        }).filter((segment) =>
          Boolean(segment.segment_identifier || segment.flight_number || segment.origin_airport_code || segment.destination_airport_code)
        );

        return {
          origin_airport_code: bound.origination_airport_code ?? null,
          destination_airport_code: bound.destination_airport_code ?? null,
          flown: bound.flown ?? null,
          next_day: bound.next_day ?? null,
          overnight: bound.overnight ?? null,
          checkin_eligible: bound.checkin_eligible ?? null,
          all_passengers_assigned_boarding_positions: bound.all_passengers_assigned_boarding_positions ?? null,
          fare_family: bound.fare_family ?? null,
          segments,
        };
      }).filter((bound) =>
        Boolean(bound.origin_airport_code || bound.destination_airport_code || bound.segments.length)
      );

      const passengers = (Array.isArray(trip.passengers) ? trip.passengers : []).map((rawPassenger) => {
        const passenger = record(rawPassenger);
        const name = record(passenger.passenger_name);
        return {
          passenger_reference: passenger.passenger_reference ?? null,
          name: {
            first_name: name.first_name ?? null,
            middle_name: name.middle_name ?? null,
            last_name: name.last_name ?? null,
          },
          seats: (Array.isArray(passenger.seats) ? passenger.seats : []).map((rawSeat) => {
            const seat = record(rawSeat);
            return {
              segment_reference: seat.segment_reference ?? null,
              seat_number: seat.seat_number ?? null,
              characteristics: strings(seat.characteristics),
              is_extra_seat: seat.is_extra_seat ?? null,
            };
          }),
          segment_features: (Array.isArray(passenger.segment_features) ? passenger.segment_features : []).map((rawFeature) => {
            const feature = record(rawFeature);
            return {
              segment_reference: feature.segment_reference ?? null,
              ancillaries_available: strings(feature.ancillaries_available),
              ancillaries_purchased: strings(feature.ancillaries_purchased),
              ancillaries_unavailable: (Array.isArray(feature.ancillaries_unavailable) ? feature.ancillaries_unavailable : []).map((rawUnavailable) => {
                const unavailable = record(rawUnavailable);
                return { feature: unavailable.feature ?? null, reason: unavailable.reason ?? null };
              }),
            };
          }),
        };
      }).filter((passenger) => Boolean(passenger.passenger_reference || passenger.seats.length));

      const permissions = record(trip.permissions);
      return {
        record_locator: trip.record_locator ?? null,
        trip_type: trip.trip_type ?? null,
        initial_ticket_issuer: trip.initial_ticket_issuer ?? null,
        origin_departure_at: trip.origin_departure_at ?? null,
        destination_departure_at: trip.destination_departure_at ?? null,
        upcoming_travel_at: trip.upcoming_travel_at ?? null,
        bounds,
        passengers,
        permissions: {
          can_cancel: permissions.can_cancel ?? null,
          can_change: permissions.can_change ?? null,
          can_checkin: permissions.can_checkin ?? null,
          can_reaccom: permissions.can_reaccom ?? null,
          can_upgrade: permissions.can_upgrade ?? null,
          can_view: permissions.can_view ?? null,
        },
        pnr_has_tickets: trip.pnr_has_tickets ?? null,
        pnr_type: trip.pnr_type ?? null,
        pnr_sub_type: trip.pnr_sub_type ?? null,
        add_companion_eligible: trip.add_companion_eligible ?? null,
        companion_pricing_token: trip.companion_pricing_token ?? null,
      };
    })
    .filter((trip) => Boolean(trip.record_locator || trip.bounds.length));

  return {
    api_version: record(root.meta).api_version ?? null,
    count: trips.length,
    trips,
  };
}
