function normalizedDate(value: unknown): string {
  const date = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error('departure_date must be a valid date in YYYY-MM-DD format');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('departure_date must be a valid date in YYYY-MM-DD format');
  }
  return date;
}

function normalizedAirport(value: unknown, name: string): string {
  const airport = String(value ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(airport)) throw new Error(`${name} must be a three-letter IATA airport code`);
  return airport;
}

export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params: Record<string, string | number | boolean> = {},
): { url: string } {
  const departureDate = normalizedDate(params.departure_date);
  normalizedAirport(params.origination_airport_code, 'origination_airport_code');
  normalizedAirport(params.destination_airport_code, 'destination_airport_code');
  const flightNumber = String(params.flight_number ?? '');
  if (!/^\d{1,4}$/.test(flightNumber)) throw new Error('flight_number must contain one to four digits');

  return {
    url: `${url}?flightNumber=${encodeURIComponent(flightNumber)}&departureDate=${encodeURIComponent(departureDate)}&searchType=flight`,
  };
}
