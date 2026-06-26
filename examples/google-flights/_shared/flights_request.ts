// Builds the double-encoded `f.req` form body for FlightsFrontendService RPCs
// (GetShoppingResults / GetCalendarPicker / GetBookingResults). Body construction
// is session-independent; f.sid/bl/_reqid/X-Goog-BatchExecute-Bgr are runtime state
// and are intentionally left untouched (transform returns the input url verbatim).
//
// NOTE (correction to spec): the leg encoding is NOT byte-for-byte identical across
// all three RPCs. GetCalendarPicker uses 4-slot legs ([ORIGIN,DEST,TIMES|null,STOPS])
// with the date range living in the outer wrapper; Shopping/Booking use the full
// 15-slot leg with DATE at [6]. Verified by decoding seq 97 vs seq 111.

// Fresh searches emit wrapper `...,0,0,0,1]` and leg[14]=3 (proven seq 111/140).
// In-page-refined searches use `...,0,1,0,1]` with return-leg[14]=1 (seq 194/425) —
// a UI freshness flag, not a user param; we always emit the fresh form for shopping.
// Booking outbound legs use [14]=3, return legs [14]=1 (seq 764/811).

function buildLeg(leg: any): any[] {
  const out: any[] = new Array(15).fill(null);
  out[0] = [[[leg?.origin, 0]]];
  out[1] = [[[leg?.dest, 0]]];
  out[2] = leg?.times ?? null;
  out[3] = leg?.stops ?? 0;
  // Google uses slot 4 for included alliances and carrier codes. Slot 5 is an
  // exclusion list; putting carrier codes there inverts the filter.
  out[4] = leg?.includeAirlines ?? leg?.alliances ?? null;
  out[5] = leg?.excludeAirlines ?? null;
  out[6] = leg?.date ?? null;
  out[7] = leg?.duration ?? null;
  out[8] = Array.isArray(leg?.selected)
    ? leg.selected.map((s: any) => [s?.origin, s?.date, s?.dest, null, s?.carrier, s?.flightNumber])
    : null;
  out[14] = 3;
  return out;
}

export function buildFlightSearchParams(params: Record<string, any>): any[] {
  const p: Record<string, any> = params ?? {};
  // 18-slot positional search array shared by every body (proven seq 111).
  const sp: any[] = new Array(18).fill(null);
  sp[2] = p.tripType ?? 1; // 1=round, 2=one-way, 3=multi-city
  sp[4] = [];
  sp[5] = 1;
  sp[6] = [p.adults ?? 1, p.children ?? 0, p.infantsSeat ?? 0, p.infantsLap ?? 0];
  sp[7] = p.maxPrice != null ? [null, p.maxPrice] : null;
  sp[10] = p.bags ? [p.bags.carryOn ?? 0, p.bags.checked ?? 0] : null;
  const legs: any[] = Array.isArray(p.legs) ? p.legs : [];
  sp[13] = legs.map((l: any) => buildLeg(l));
  sp[17] = 1;
  return sp;
}

export function encodeFreq(payload: any): string {
  // payload -> inner json string -> embedded in [null, inner] -> x-www-form-urlencoded.
  // Verified byte-for-byte against seq 111: `\"`->%5C%22, `[`->%5B, `,`->%2C, `=`->%3D.
  const inner = JSON.stringify(payload);
  const outer = JSON.stringify([null, inner]);
  return 'f.req=' + encodeURIComponent(outer) + '&';
}

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Record<string, any>,
): { url: string; body: string } {
  // method/responses are part of the contract but unused for body construction
  // (the booking token arrives via params.flight_token). Reference to satisfy strict.
  void method;
  void responses;

  const p: Record<string, any> = params ?? {};
  const m = /FlightsFrontendService\/(\w+)/.exec(url);
  if (!m || !m[1]) throw new Error(`unrecognized FlightsFrontendService rpc in url: ${url}`);
  const rpc: string = m[1];

  const sp = buildFlightSearchParams(p);
  let payload: any;

  if (rpc === 'GetShoppingResults') {
    payload = [[], sp, 0, 0, 0, 1];
  } else if (rpc === 'GetCalendarPicker') {
    const legs = sp[13];
    if (Array.isArray(legs)) sp[13] = legs.map((l: any) => (Array.isArray(l) ? l.slice(0, 4) : l));
    payload = [null, sp, [p.startDate ?? null, p.endDate ?? null], null, [7, 7]];
  } else if (rpc === 'GetBookingResults') {
    const legs = sp[13];
    if (Array.isArray(legs)) {
      legs.forEach((l: any, i: number) => {
        if (i >= 1 && Array.isArray(l)) l[14] = 1; // return leg(s)
      });
    }
    payload = [[null, p.flight_token ?? null], sp, null, p.tripType === 2 ? 0 : 1];
  } else {
    throw new Error(`unsupported FlightsFrontendService rpc: ${rpc}`);
  }

  return { url, body: encodeFreq(payload) };
}
