export interface FlightLocation {
  id: string;
  type: string;
  displayName: string;
  city?: string;
  region?: string;
  description?: string;
  airportCode?: string;
  placeId?: string;
  coordinates?: { lat: number; lng: number };
  imageUrls?: string[];
  nestedAirports?: FlightLocation[];
}

export interface FlightLeg {
  origin: string;
  destination: string;
  departureDate?: string;
  departureTime?: string;
  arrivalDate?: string;
  arrivalTime?: string;
  airline?: string;
  carrierCode?: string;
  flightNumber?: string;
  durationMinutes?: number;
  stops?: number;
}

export interface FlightItinerary {
  price?: number;
  currency?: string;
  legs: FlightLeg[];
  selection_token?: string;
  selected_flights?: string;
  emissions?: unknown;
  group?: string;
}

export interface CalendarPrice {
  departureDate: string;
  returnDate?: string;
  price?: number;
  currency?: string;
  tripLength?: string;
  selectionToken?: string;
}

export interface BookingOption {
  provider?: string;
  price?: number;
  currency?: string;
  bookingUrl?: string;
  fareNotes?: string[];
  restrictions?: string[];
  legs: FlightLeg[];
}
