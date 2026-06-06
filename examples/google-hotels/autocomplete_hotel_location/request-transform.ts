// Per-tool request-transform for autocomplete_hotel_location (rpcid=mejVKc).
// Imports the shared google-hotels batchexecute helpers (../_shared/freq.ts)
// and constructs the mejVKc-specific inner payload from the tool's `query`
// param, then wraps it with the shared envelope/URL builders.
//
// Inner payload shape per the recording (seq 2550, newer build 20260603):
//   ["tahoe city hotels","tahoe city hotels",1,1,null,30]
// i.e. [query, query(context), 1, 1, null, 30] with mode 'generic'.
// (Older seq 222 carried a user-geo context string + trailing fields; that geo
// context is session-specific and not a caller-controlled parameter, so we
// follow the newer same-session pair and mirror the query into element [1].)

import { buildBatchExecuteUrl, buildFreqBody } from '../_shared/freq.ts';

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Record<string, any>,
): { url: string; body: string } {
  void method;
  void responses;

  const query = String(params?.query ?? '');

  // Session params (f.sid / bl) ride along in the workflow URL; buildBatchExecuteUrl
  // reassembles the URL with a fresh _reqid and the rpcids/source-path/etc params.
  const u = new URL(url);
  const fSid = u.searchParams.get('f.sid') ?? '';
  const bl = u.searchParams.get('bl') ?? '';
  const builtUrl = buildBatchExecuteUrl('mejVKc', { f_sid: fSid, bl });

  const innerPayload = [query, query, 1, 1, null, 30];
  const body = buildFreqBody('mejVKc', innerPayload, 'generic');

  return { url: builtUrl, body };
}
