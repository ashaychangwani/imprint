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
  airlineCode: string;
  airlineName: string;
  flightNumber: string;
  aircraft: string;
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
  stopCount: number;
  priceUsd: number | null;
  bookingToken: string | null;
  flightNumbers: string[];
  segments: Segment[];
}

function formatDate(parts: unknown): string {
  if (!Array.isArray(parts) || parts.length < 3) return '';
  const [year, month, day] = parts as number[];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatTime(parts: unknown): string {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const [hour = 0, minute = 0] = parts as number[];
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function cabinClassLabel(code: unknown): string {
  switch (code) {
    case 1:
      return 'economy';
    case 2:
      return 'premium_economy';
    case 3:
      return 'business';
    case 4:
      return 'first';
    default:
      return 'unknown';
  }
}

function parseEnvelope(rawResponse: string): unknown[] | null {
  const jsonLine = rawResponse
    .split('\n')
    .find((line) => line.startsWith('[[') || line.startsWith('[["'));

  if (!jsonLine) return null;

  let outer: unknown[];
  try {
    outer = JSON.parse(jsonLine) as unknown[];
  } catch {
    return null;
  }

  const innerString = (outer as unknown[][])?.[0]?.[2];
  if (typeof innerString !== 'string') return null;

  try {
    return JSON.parse(innerString) as unknown[];
  } catch {
    return null;
  }
}

function parseSegment(rawSegment: unknown): Segment | null {
  if (!Array.isArray(rawSegment)) return null;

  const flightInfo = rawSegment[22];
  return {
    origin: typeof rawSegment[3] === 'string' ? rawSegment[3] : '',
    originName: typeof rawSegment[4] === 'string' ? rawSegment[4] : '',
    destination: typeof rawSegment[6] === 'string' ? rawSegment[6] : '',
    destinationName: typeof rawSegment[5] === 'string' ? rawSegment[5] : '',
    departureDate: formatDate(rawSegment[20]),
    departureTime: formatTime(rawSegment[8]),
    arrivalDate: formatDate(rawSegment[21]),
    arrivalTime: formatTime(rawSegment[10]),
    durationMinutes: typeof rawSegment[11] === 'number' ? rawSegment[11] : 0,
    airlineCode:
      Array.isArray(flightInfo) && typeof flightInfo[0] === 'string' ? flightInfo[0] : '',
    airlineName:
      Array.isArray(flightInfo) && typeof flightInfo[3] === 'string' ? flightInfo[3] : '',
    flightNumber:
      Array.isArray(flightInfo) &&
      typeof flightInfo[0] === 'string' &&
      typeof flightInfo[1] === 'string'
        ? `${flightInfo[0]}${flightInfo[1]}`
        : '',
    aircraft: typeof rawSegment[17] === 'string' ? rawSegment[17] : '',
    cabinClass: cabinClassLabel(rawSegment[13]),
  };
}

function parseFlight(rawOption: unknown): Flight | null {
  if (!Array.isArray(rawOption) || rawOption.length < 2) return null;

  const details = rawOption[0];
  const priceInfo = rawOption[1];
  if (!Array.isArray(details) || !Array.isArray(details[2])) return null;

  const segments = details[2]
    .map((segment) => parseSegment(segment))
    .filter((segment): segment is Segment => segment !== null);

  const firstPrice = Array.isArray(priceInfo) && Array.isArray(priceInfo[0]) ? priceInfo[0] : null;
  const priceUsd = firstPrice && typeof firstPrice[1] === 'number' ? firstPrice[1] : null;
  const bookingToken = Array.isArray(priceInfo) && typeof priceInfo[1] === 'string' ? priceInfo[1] : null;

  return {
    airlineCode: typeof details[0] === 'string' ? details[0] : '',
    airlineName:
      Array.isArray(details[1]) && typeof details[1][0] === 'string' ? details[1][0] : '',
    origin: typeof details[3] === 'string' ? details[3] : '',
    destination: typeof details[6] === 'string' ? details[6] : '',
    departureDate: formatDate(details[4]),
    departureTime: formatTime(details[5]),
    arrivalDate: formatDate(details[7]),
    arrivalTime: formatTime(details[8]),
    durationMinutes: typeof details[9] === 'number' ? details[9] : 0,
    stopCount: Math.max(segments.length - 1, 0),
    priceUsd,
    bookingToken,
    flightNumbers: segments.map((segment) => segment.flightNumber).filter(Boolean),
    segments,
  };
}

function isFlightSection(section: unknown): section is [unknown[], ...unknown[]] {
  return (
    Array.isArray(section) &&
    Array.isArray(section[0]) &&
    section[0].length > 0 &&
    Array.isArray(section[0][0]) &&
    Array.isArray(section[0][0][0])
  );
}

export function extract(rawResponse: unknown): unknown {
  if (typeof rawResponse !== 'string') {
    return { flights: [], totalCount: 0, error: 'Expected raw response string.' };
  }

  const envelope = parseEnvelope(rawResponse);
  if (!envelope) {
    return { flights: [], totalCount: 0, error: 'Unable to parse Google Flights response.' };
  }

  const flights: Flight[] = [];
  for (const section of envelope) {
    if (!isFlightSection(section)) continue;
    for (const rawOption of section[0]) {
      const flight = parseFlight(rawOption);
      if (flight) flights.push(flight);
    }
  }

  flights.sort((a, b) => {
    if (a.priceUsd == null && b.priceUsd == null) return 0;
    if (a.priceUsd == null) return 1;
    if (b.priceUsd == null) return -1;
    return a.priceUsd - b.priceUsd;
  });

  return {
    flights,
    totalCount: flights.length,
  };
}
