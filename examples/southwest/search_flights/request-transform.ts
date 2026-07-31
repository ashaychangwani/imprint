type Params = Record<string, string | number | boolean>;
const value = (params: Params, name: string, fallback: string | number): string => String(params[name] ?? fallback);
export function transform(method: string, url: string, _responses: unknown[], params?: Params): { url: string; body?: string } {
  if (method.toUpperCase() !== 'POST') return { url };
  const p = params ?? {};
  const selectedFareName = value(p, 'selected_fare_name', '');
  const selectedFareAmount = value(p, 'selected_fare_amount', '');
  const departureDate = value(p, 'departure_date', '');
  const returnDate = value(p, 'return_date', '');
  const fromLowFareCalendar = selectedFareName !== '' || selectedFareAmount !== '';
  return { url, body: JSON.stringify({
    adultPassengersCount: value(p, 'adults_count', 1), adultsCount: value(p, 'adults_count', 1),
    departureDate, departureTimeOfDay: 'ALL_DAY',
    destinationAirportCode: value(p, 'destination_airport_code', ''),
    ...(fromLowFareCalendar ? { fare1: selectedFareAmount, fare2: '', fareName1: selectedFareName, fareName2: '' } : {}),
    fareType: value(p, 'fare_type', 'USD'), int: fromLowFareCalendar ? 'LFCBOOKAIR' : 'HOMEQBOMAIR',
    lapInfantPassengersCount: value(p, 'lap_infant_passengers_count', 0),
    originationAirportCode: value(p, 'origination_airport_code', ''), passengerType: 'ADULT',
    promoCode: value(p, 'promo_code', ''), ...(fromLowFareCalendar ? { returnAirportCode: '' } : {}),
    returnDate, returnTimeOfDay: value(p, 'return_time_of_day', 'ALL_DAY'),
    ...(fromLowFareCalendar ? { selectedFlight1: departureDate, selectedFlight2: returnDate } : {}),
    tripType: value(p, 'trip_type', 'oneway'), application: 'air-booking', site: 'southwest'
  }) };
}
