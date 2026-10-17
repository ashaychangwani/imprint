export function transform(
  method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body?: string } {
  if (method.toUpperCase() === "GET") return { url };
  const p = params ?? {};
  const departureDate = String(p.departure_date ?? "");
  const validDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
  };
  if (!validDate(departureDate)) {
    throw new Error("departure_date must be a real YYYY-MM-DD date");
  }
  const tripType = String(p.trip_type ?? "oneway");
  if (tripType !== "oneway" && tripType !== "roundtrip") {
    throw new Error("trip_type must be oneway or roundtrip");
  }
  const returnDate = String(p.return_date ?? "");
  if (tripType === "roundtrip" && !validDate(returnDate)) {
    throw new Error("return_date is required for roundtrip and must be a real YYYY-MM-DD date");
  }
  if (tripType === "roundtrip" && returnDate <= departureDate) {
    throw new Error("return_date must be later than departure_date");
  }
  const origin = String(p.origination_airport_code ?? "").toUpperCase();
  const destination = String(p.destination_airport_code ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin)) throw new Error("origination_airport_code must be a three-letter IATA code");
  if (!/^[A-Z]{3}$/.test(destination)) throw new Error("destination_airport_code must be a three-letter IATA code");
  return {
    url,
    body: JSON.stringify({
      // Live audit proved that count variations return the same adult-only
      // calendar, so retain the recorded one-adult baseline.
      adultPassengersCount: "1",
      adultsCount: "1",
      currencyCode: "USD",
      departureDate: departureDate.slice(0, 8) + "01",
      destinationAirportCode: destination,
      hasNearByAirport: "false",
      lapInfantPassengersCount: "0",
      originationAirportCode: origin,
      passengerType: "ADULT",
      promoCode: String(p.promo_code ?? ""),
      returnAirportCode: "",
      returnDate: tripType === "roundtrip" ? returnDate : "",
      selectedFlight1: departureDate,
      selectedFlight2: tripType === "roundtrip" ? returnDate : "",
      tripType,
      clk: "6403032",
      cbid: "6403032",
    }),
  };
}
