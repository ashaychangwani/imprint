/**
 * Parser for Google Flights GetShoppingResults JSPB response.
 *
 * The response is a JSPB (protobuf-style) nested array format.
 * Structure:
 *   )]}'\n\nSIZE\n[[\"wrb.fr\",null,\"INNER_JSON_STRING\"]...]
 *
 * The inner JSON string contains flight data at positions [2] and [3]:
 *   inner[2] = first group of flight options (typically nonstop/direct)
 *   inner[3] = second group of flight options (typically connecting)
 *
 * Each flight option is an array:
 *   [0] = flight details (25-element array)
 *   [1] = price info [[null, price_usd], booking_token]
 *
 * Flight details:
 *   [0] = airline IATA code (e.g. "ZG")
 *   [1] = [airline name] (e.g. ["ZIPAIR Tokyo"])
 *   [2] = segments array
 *   [3] = origin airport code (e.g. "SFO")
 *   [4] = departure date [year, month, day]
 *   [5] = departure time [hour, minute]
 *   [6] = destination airport code (e.g. "NRT")
 *   [7] = arrival date [year, month, day]
 *   [8] = arrival time [hour, minute]
 *   [9] = total duration in minutes
 *   [10] = number of stops
 *   [15] = codeshare/partner airlines array (if any)
 *
 * Segment details (each segment in [2]):
 *   [3] = origin airport code
 *   [4] = origin airport name
 *   [5] = destination airport name
 *   [6] = destination airport code
 *   [8] = departure time [hour, minute]
 *   [10] = arrival time [hour, minute]
 *   [11] = segment duration in minutes
 *   [13] = seat class (1=economy, 2=premium economy, 3=business, 4=first)
 *   [14] = seat pitch
 *   [17] = aircraft type
 *   [20] = departure date [year, month, day]
 *   [21] = arrival date [year, month, day]
 *   [22] = [airline_code, flight_number, null, airline_name]
 */

interface Segment {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  durationMinutes: number;
  flightNumber: string;
  airlineCode: string;
  airlineName: string;
  aircraft: string;
  seatPitch: string;
  cabinClass: string;
}

interface Flight {
  airlineCode: string;
  airlineName: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  durationMinutes: number;
  stops: number;
  priceUsd: number | null;
  bookingToken: string | null;
  segments: Segment[];
  codesharePartners: string[];
}

function formatDate(dateParts: number[] | null | undefined): string {
  if (!dateParts || dateParts.length < 3) return '';
  const [year, month, day] = dateParts;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatTime(timeParts: number[] | null | undefined): string {
  if (!timeParts || timeParts.length === 0) return '';
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function cabinClassLabel(code: number): string {
  switch (code) {
    case 1: return 'economy';
    case 2: return 'premium_economy';
    case 3: return 'business';
    case 4: return 'first';
    default: return 'economy';
  }
}

function parseSegment(seg: any[]): Segment {
  const flightInfo = seg[22] as any[] | null;
  return {
    origin: seg[3] ?? '',
    originName: seg[4] ?? '',
    destination: seg[6] ?? '',
    destinationName: seg[5] ?? '',
    departureDate: formatDate(seg[20]),
    departureTime: formatTime(seg[8]),
    arrivalDate: formatDate(seg[21]),
    arrivalTime: formatTime(seg[10]),
    durationMinutes: seg[11] ?? 0,
    flightNumber: flightInfo ? `${flightInfo[0]}${flightInfo[1]}` : '',
    airlineCode: flightInfo?.[0] ?? '',
    airlineName: flightInfo?.[3] ?? '',
    aircraft: seg[17] ?? '',
    seatPitch: seg[14] ?? '',
    cabinClass: cabinClassLabel(seg[13] ?? 1),
  };
}

function parseFlightOption(option: any[]): Flight | null {
  if (!Array.isArray(option) || option.length < 2) return null;

  const details = option[0] as any[];
  const priceInfo = option[1] as any[];

  if (!Array.isArray(details) || typeof details[0] !== 'string') return null;

  const airlineCode = details[0] as string;
  const airlineNameArr = details[1] as string[];
  const airlineName = Array.isArray(airlineNameArr) ? (airlineNameArr[0] ?? '') : '';
  const segments = (details[2] as any[][]).map(parseSegment);
  const origin = details[3] as string;
  const depDate = formatDate(details[4]);
  const depTime = formatTime(details[5]);
  const dest = details[6] as string;
  const arrDate = formatDate(details[7]);
  const arrTime = formatTime(details[8]);
  const durationMinutes = details[9] as number;
  const stops = (details[10] as number) - 1; // stops = segments - 1
  const codesharePartners = Array.isArray(details[15]) ? (details[15] as string[]) : [];

  let priceUsd: number | null = null;
  let bookingToken: string | null = null;
  if (Array.isArray(priceInfo)) {
    const priceArr = priceInfo[0] as any[];
    if (Array.isArray(priceArr) && priceArr[1] != null) {
      priceUsd = priceArr[1] as number;
    }
    bookingToken = priceInfo[1] as string ?? null;
  }

  return {
    airlineCode,
    airlineName,
    origin,
    destination: dest,
    departureDate: depDate,
    departureTime: depTime,
    arrivalDate: arrDate,
    arrivalTime: arrTime,
    durationMinutes,
    stops,
    priceUsd,
    bookingToken,
    segments,
    codesharePartners,
  };
}

function extractFlightsFromSection(section: any): Flight[] {
  if (!Array.isArray(section) || !Array.isArray(section[0])) return [];
  const flightOptions = section[0] as any[][];
  const flights: Flight[] = [];
  for (const option of flightOptions) {
    const flight = parseFlightOption(option);
    if (flight) flights.push(flight);
  }
  return flights;
}

export function extract(rawResponse: unknown): unknown {
  if (typeof rawResponse !== 'string') {
    // Already parsed — shouldn't happen for this endpoint but handle gracefully
    return { flights: [], error: 'Expected string response' };
  }

  // Strip JSPB prefix: )]}'\n\nSIZE\n[...]
  const lines = rawResponse.split('\n');
  // Find the line that starts with '[' (the JSON array)
  let jsonLine = '';
  for (const line of lines) {
    if (line.startsWith('[[') || line.startsWith('[["')) {
      jsonLine = line;
      break;
    }
  }

  if (!jsonLine) {
    return { flights: [], error: 'Could not find JSON data in response' };
  }

  let outerJson: any[];
  try {
    outerJson = JSON.parse(jsonLine);
  } catch {
    return { flights: [], error: 'Failed to parse outer JSON' };
  }

  // outerJson[0][2] is the inner JSPB string
  const innerStr = outerJson?.[0]?.[2];
  if (typeof innerStr !== 'string') {
    return { flights: [], error: 'Could not find inner JSPB string' };
  }

  let inner: any[];
  try {
    inner = JSON.parse(innerStr);
  } catch {
    return { flights: [], error: 'Failed to parse inner JSPB JSON' };
  }

  // Extract flights from sections [2] and [3]
  const allFlights: Flight[] = [];

  // Section [2]: typically nonstop/direct flights
  if (inner[2]) {
    allFlights.push(...extractFlightsFromSection(inner[2]));
  }

  // Section [3]: typically connecting flights
  if (inner[3]) {
    allFlights.push(...extractFlightsFromSection(inner[3]));
  }

  // Sort by price ascending
  allFlights.sort((a, b) => {
    if (a.priceUsd === null && b.priceUsd === null) return 0;
    if (a.priceUsd === null) return 1;
    if (b.priceUsd === null) return -1;
    return a.priceUsd - b.priceUsd;
  });

  return {
    flights: allFlights,
    totalCount: allFlights.length,
  };
}
