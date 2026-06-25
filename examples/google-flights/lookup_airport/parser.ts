import { extractRpcPayload } from '../_shared/batchexecute.ts';

// Parse the tDoGIe (airport/place resolution) batchexecute response.
//
// Decoded payload shape (seq 69):
//   [ [null,null,0,"<token>"],
//     [  // <- payload[1]: array of matches
//       [ ["SJC",0], "San Jose Mineta International Airport",
//         ["/m/0f04v","San Jose",[[img],[img]]], [37.3627778,-121.92917],
//         "US", false, "United States" ],
//       [ ["/m/0f04v",4], "San Jose", ["/m/0f04v","San Jose",...], [37.33874,-121.8852525], ... ]
//     ] ]
// Each match item: [0][0]=code (IATA or /m/ entity id), [1]=name,
//   [2][1]=associated city, [3]=[lat,lng], [4]=country code, [6]=country name.

interface AirportMatch {
  code: string | null;
  name: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  country: string | null;
  countryName: string | null;
}

function parseItem(item: unknown): AirportMatch | null {
  if (!Array.isArray(item)) return null;
  const code = Array.isArray(item[0]) ? (item[0][0] ?? null) : null;
  const name = typeof item[1] === 'string' ? item[1] : null;
  const city = Array.isArray(item[2]) && typeof item[2][1] === 'string' ? item[2][1] : null;
  const coords = item[3];
  const lat = Array.isArray(coords) && typeof coords[0] === 'number' ? coords[0] : null;
  const lng = Array.isArray(coords) && typeof coords[1] === 'number' ? coords[1] : null;
  const country = typeof item[4] === 'string' ? item[4] : null;
  const countryName = typeof item[6] === 'string' ? item[6] : null;
  const m: AirportMatch = { code, name, city, lat, lng, country, countryName };
  // Drop content-less placeholder records (API no-match sentinel).
  if (m.code == null && m.name == null) return null;
  return m;
}

export function extract(
  rawResponse: unknown,
  context?: { params: Record<string, string | number | boolean>; responses: unknown[] },
): unknown {
  const raw = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const payload = extractRpcPayload(raw, 'tDoGIe');

  const matchesRaw = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
  const matches = matchesRaw
    .map(parseItem)
    .filter((m): m is AirportMatch => m !== null);

  const primary = matches[0] ?? null;
  return {
    query: context?.params?.query ?? null,
    matchCount: matches.length,
    matches,
    // Convenience: hoist the best (first) match to the top level.
    code: primary?.code ?? null,
    name: primary?.name ?? null,
    city: primary?.city ?? null,
    lat: primary?.lat ?? null,
    lng: primary?.lng ?? null,
  };
}
