function normalizedDate(value: unknown, name: string): string {
  const date = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`${name} must be a real YYYY-MM-DD date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${name} must be a real YYYY-MM-DD date`);
  }
  return date;
}

function normalizedAirport(value: unknown, name: string): string {
  const airport = String(value ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(airport)) {
    throw new Error(`${name} must be a three-letter IATA airport code`);
  }
  return airport;
}

export function transform(
  method: string,
  url: string,
  _responses: unknown[],
  params: Record<string, string | number | boolean> = {},
): { url: string; body?: string } {
  if (method.toUpperCase() === "GET") return { url };
  const tripType = String(params.trip_type ?? "oneway");
  const returnDate = String(params.return_date ?? "");
  const fareType = String(params.fare_type ?? "USD");
  const promoCode = String(params.promo_code ?? "");
  const departureTimeOfDay = String(params.departure_time_of_day ?? "ALL_DAY").toUpperCase();
  const returnTimeOfDay = String(params.return_time_of_day ?? "ALL_DAY").toUpperCase();
  const departureDate = normalizedDate(params.departure_date, "departure_date");
  const originationAirportCode = normalizedAirport(
    params.origination_airport_code,
    "origination_airport_code",
  );
  const destinationAirportCode = normalizedAirport(
    params.destination_airport_code,
    "destination_airport_code",
  );
  const timeWindows = new Set(["ALL_DAY", "BEFORE_NOON", "NOON_TO_SIX", "AFTER_SIX"]);
  if (tripType !== "oneway" && tripType !== "roundtrip") throw new Error("trip_type must be oneway or roundtrip");
  if (tripType === "roundtrip" && !returnDate) throw new Error("return_date is required for roundtrip searches");
  const normalizedReturnDate =
    tripType === "roundtrip" ? normalizedDate(returnDate, "return_date") : "";
  if (normalizedReturnDate && normalizedReturnDate <= departureDate) {
    throw new Error("return_date must be later than departure_date");
  }
  if (fareType !== "USD") throw new Error("Only fare_type=USD is supported by the recording");
  if (promoCode !== "") throw new Error("Nonempty promo_code is not supported by the recording");
  if (!timeWindows.has(departureTimeOfDay)) throw new Error("departure_time_of_day must be ALL_DAY, BEFORE_NOON, NOON_TO_SIX, or AFTER_SIX");
  if (!timeWindows.has(returnTimeOfDay)) throw new Error("return_time_of_day must be ALL_DAY, BEFORE_NOON, NOON_TO_SIX, or AFTER_SIX");

  // The recording and live audit prove the one-adult request shape. Southwest
  // returned equivalent adult-only inventory for every exposed count variation,
  // so passenger selection stays user-assisted instead of being falsely exposed.
  const body: Record<string, string> = {
    adultPassengersCount: "1",
    adultsCount: "1",
    departureDate,
    departureTimeOfDay,
    destinationAirportCode,
    fareType,
    int: "HOMEQBOMAIR",
    originationAirportCode,
    passengerType: "ADULT",
    promoCode,
    returnDate: normalizedReturnDate,
    returnTimeOfDay: tripType === "oneway" ? "ALL_DAY" : returnTimeOfDay,
    tripType,
    application: "air-booking",
    site: "southwest",
  };

  return { url, body: JSON.stringify(body) };
}
