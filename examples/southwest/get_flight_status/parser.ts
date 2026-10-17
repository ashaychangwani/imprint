type Context = {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
};

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function matches(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => decode(match[1] ?? '').trim());
}

function airportCodes(html: string): string[] {
  return matches(
    html,
    /href=["']\/airport-information\/["'][^>]*>[\s\S]*?<div[^>]*>\s*([A-Z]{3})\s*<\/div>/gi,
  );
}

export function extract(rawResponse: unknown, context?: Context): unknown {
  const html = typeof rawResponse === 'string' ? rawResponse : '';
  const serviceError = matches(
    html,
    /data-test=["']serviceErrorMessageBody["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
  )
    .map((message) => message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (serviceError) {
    throw new Error(`SOUTHWEST_FLIGHT_STATUS_ERROR: ${serviceError}`);
  }
  const params = context?.params ?? {};
  const requestedOrigin = String(params.origination_airport_code ?? '').toUpperCase();
  const requestedDestination = String(params.destination_airport_code ?? '').toUpperCase();
  const requestedFlightNumber = String(params.flight_number ?? '');
  const departureDate = String(params.departure_date ?? '');

  const airports = airportCodes(html);
  if (airports.length < 2) {
    throw new Error(
      'SOUTHWEST_FLIGHT_STATUS_UNPARSED: expected a rendered flight-status route or explicit service error',
    );
  }
  const flightNumbers = matches(html, /aria-label=["']flight number\s*([^"']+)["']/gi)
    .map((value) => value.replace(/\D/g, ''))
    .filter(Boolean);
  if (flightNumbers.length === 0) {
    throw new Error(
      'SOUTHWEST_FLIGHT_STATUS_UNPARSED: rendered route did not include a provider flight number',
    );
  }
  const statuses = matches(html, /aria-label=["']Flight Status:\s*([^"']+)["']/gi);
  const departureTimes = matches(html, /aria-label=["']departs\s+([^"']+)["']/gi);
  const arrivalTimes = matches(html, /aria-label=["']arrives\s+([^"']+)["']/gi);
  const gates = matches(html, />\s*Gate:\s*([^<]+)</gi);
  const durations = matches(html, /aria-label=["']([^"']*hours?[^"']*minutes?)["']/gi);
  const aircraft = matches(html, /aria-label=["']Plane Type[^"']*["'][^>]*>([^<]+)</gi);

  const results = [];
  for (let index = 0; index + 1 < airports.length; index += 2) {
    const originationAirportCode = airports[index];
    const destinationAirportCode = airports[index + 1];
    if (requestedOrigin && originationAirportCode !== requestedOrigin) continue;
    if (requestedDestination && destinationAirportCode !== requestedDestination) continue;
    if (requestedFlightNumber && !flightNumbers.includes(requestedFlightNumber)) continue;
    const routeIndex = index / 2;
    results.push({
      originationAirportCode,
      destinationAirportCode,
      flightNumbers,
      departureDate,
      departureStatus: statuses[routeIndex * 2] ?? null,
      arrivalStatus: statuses[routeIndex * 2 + 1] ?? null,
      departureTimes: departureTimes[routeIndex] ? [departureTimes[routeIndex]] : [],
      arrivalTimes: arrivalTimes[routeIndex] ? [arrivalTimes[routeIndex]] : [],
      departureGate: gates[routeIndex * 2] ?? null,
      arrivalGate: gates[routeIndex * 2 + 1] ?? null,
      duration: durations[routeIndex] ?? null,
      aircraft: aircraft[routeIndex] ?? null,
    });
  }

  return { results, count: results.length };
}
