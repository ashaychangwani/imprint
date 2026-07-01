import { extractWrbRecords, parseNestedPayload } from '../_shared/google_batchexecute_parser.ts';
import type { FlightLeg } from '../_shared/google_flights_types.ts';

type InputLeg = {
  origin?: string;
  destination?: string;
  originType?: number;
  destinationType?: number;
};

type ValidationResult = {
  valid: boolean;
  validationToken: string | null;
  flags: boolean[];
  legs: Array<FlightLeg & { originType?: number; destinationType?: number }>;
  statusCode: number | null;
};

function parseItinerary(value: unknown): InputLeg[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const text = value.trim();

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((leg): InputLeg | null => {
          if (Array.isArray(leg)) {
            const originTuple = leg[0]?.[0] ?? leg[0];
            const destinationTuple = leg[1]?.[0] ?? leg[1];
            if (Array.isArray(originTuple) && Array.isArray(destinationTuple)) {
              return {
                origin: String(originTuple[0] ?? ''),
                originType: typeof originTuple[1] === 'number' ? originTuple[1] : undefined,
                destination: String(destinationTuple[0] ?? ''),
                destinationType: typeof destinationTuple[1] === 'number' ? destinationTuple[1] : undefined,
              };
            }
          }
          if (leg && typeof leg === 'object') return leg as InputLeg;
          return null;
        })
        .filter((leg): leg is InputLeg => Boolean(leg?.origin && leg?.destination));
    }
  } catch {
    // Fall through to compact text parsing.
  }

  return text
    .split(/[;,]/)
    .map((part): InputLeg | null => {
      const [origin, destination] = part.split(/->|>|-/).map((item) => item.trim()).filter(Boolean);
      if (!origin || !destination) return null;
      return { origin, destination };
    })
    .filter((leg): leg is InputLeg => Boolean(leg));
}

function findNestedPayload(rawResponse: unknown): unknown[] | null {
  if (typeof rawResponse === 'string') {
    const record = extractWrbRecords(rawResponse).find((candidate) => candidate.rpcid === 'BVAT3');
    if (!record) return null;
    const nested = parseNestedPayload(record.payload);
    return Array.isArray(nested) ? nested : null;
  }

  if (Array.isArray(rawResponse)) return rawResponse;

  if (rawResponse && typeof rawResponse === 'object') {
    const maybePayload = (rawResponse as { payload?: unknown }).payload;
    const nested = parseNestedPayload(maybePayload);
    return Array.isArray(nested) ? nested : null;
  }

  return null;
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): ValidationResult {
  const nested = findNestedPayload(rawResponse);
  const tokenContainer = Array.isArray(nested?.[0]) ? nested[0] : [];
  const statusCode = typeof nested?.[1] === 'number' ? nested[1] : null;
  const token = typeof tokenContainer[3] === 'string' ? tokenContainer[3] : null;
  const flags = Array.isArray(nested?.[2]) ? nested[2].filter((flag): flag is boolean => typeof flag === 'boolean') : [];
  const inputLegs = parseItinerary(context?.params?.itinerary);

  return {
    valid: statusCode === 1,
    validationToken: token,
    flags,
    legs: inputLegs.map((leg) => ({
      origin: leg.origin ?? '',
      destination: leg.destination ?? '',
      originType: leg.originType,
      destinationType: leg.destinationType,
    })),
    statusCode,
  };
}
