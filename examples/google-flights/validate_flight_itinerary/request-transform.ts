import { transform as googleFlightsTransform } from '../_shared/google_flights_transport.ts';

type ParamValue = string | number | boolean;
type LegTuple = [[string, number][], [string, number][]];

type ItineraryLeg = {
  origin?: string;
  destination?: string;
  originType?: number;
  destinationType?: number;
};

function inferLocationType(id: string): number {
  return id.startsWith('/m/') || id.startsWith('/g/') ? 5 : 0;
}

function normalizeLeg(leg: unknown): LegTuple | null {
  if (Array.isArray(leg)) {
    const originTuple = leg[0]?.[0] ?? leg[0];
    const destinationTuple = leg[1]?.[0] ?? leg[1];
    if (Array.isArray(originTuple) && Array.isArray(destinationTuple)) {
      const origin = String(originTuple[0] ?? '').trim();
      const destination = String(destinationTuple[0] ?? '').trim();
      if (!origin || !destination) return null;
      const originType = typeof originTuple[1] === 'number' ? originTuple[1] : inferLocationType(origin);
      const destinationType = typeof destinationTuple[1] === 'number' ? destinationTuple[1] : inferLocationType(destination);
      return [[[origin, originType]], [[destination, destinationType]]];
    }
  }

  if (leg && typeof leg === 'object') {
    const item = leg as ItineraryLeg;
    const origin = String(item.origin ?? '').trim();
    const destination = String(item.destination ?? '').trim();
    if (!origin || !destination) return null;
    return [
      [[origin, typeof item.originType === 'number' ? item.originType : inferLocationType(origin)]],
      [[destination, typeof item.destinationType === 'number' ? item.destinationType : inferLocationType(destination)]],
    ];
  }

  return null;
}

function parseItinerary(value: unknown): LegTuple[] {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('itinerary is required and must include at least two legs');
  }

  const text = value.trim();
  let rawLegs: unknown[];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error('itinerary JSON must be an array');
    rawLegs = parsed;
  } catch {
    rawLegs = text.split(/[;,]/).map((part) => {
      const [origin, destination] = part.split(/->|>|-/).map((item) => item.trim()).filter(Boolean);
      return { origin, destination };
    });
  }

  const legs = rawLegs.map(normalizeLeg).filter((leg): leg is LegTuple => Boolean(leg));
  if (legs.length < 2) {
    throw new Error('BVAT3 validation is only verified for itineraries with at least two legs');
  }
  return legs;
}

export function transform(
  method: string,
  url: string,
  responses: unknown[],
  params?: Record<string, ParamValue>,
): { url: string; body: string; headers: Record<string, string> } {
  const legs = parseItinerary(params?.itinerary);
  const fReq = [[['BVAT3', JSON.stringify([null, [legs]]), null, 'generic']]];

  return googleFlightsTransform(method, url, responses, {
    rpcid: 'BVAT3',
    sourcePath: '/travel/flights',
    referer: 'https://www.google.com/travel/flights',
    fReq,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
      'Accept-Language': 'en-US,en;q=0.9',
      'x-goog-ext-259736195-jspb': '["en-US","US","USD",2,null,[420],null,null,7,[]]',
    },
    params,
  });
}
