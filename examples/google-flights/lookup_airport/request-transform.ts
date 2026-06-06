// Builds the tDoGIe (airport lookup) batchexecute POST body.
//
// The body is a single form field `f.req` whose value is a doubly-encoded JSON
// array: f.req=[[["tDoGIe","[null,[[\"<query>\",0]]]",null,"generic"]]]
// The inner element is itself a JSON STRING (JSON-in-JSON), so we build it with
// two JSON.stringify passes, then URL-encode the whole thing. Recorded seq 69
// used query="SJC". This is the tool's own transform (the shared flights_request
// module targets the FlightsFrontendService RPCs, not tDoGIe).
export function transform(
  _method: string,
  url: string,
  _responses: unknown[],
  params?: Record<string, string | number | boolean>,
): { url: string; body: string } {
  const query = String(params?.query ?? '').trim();
  const inner = JSON.stringify([null, [[query, 0]]]);
  const outer = JSON.stringify([[['tDoGIe', inner, null, 'generic']]]);
  const body = 'f.req=' + encodeURIComponent(outer) + '&';
  return { url, body };
}
