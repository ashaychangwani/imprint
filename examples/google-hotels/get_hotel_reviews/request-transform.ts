// Per-tool request-transform for get_hotel_reviews. Builds the ocp93e inner
// payload from the hotel_id param and delegates envelope/URL construction to the
// shared google-hotels batchexecute helpers.
import { buildFreqBody, buildBatchExecuteUrl } from '../_shared/freq.ts';

export function transform(
  method: string,
  url: string,
  responses: Record<string, any>,
  params?: Record<string, any>,
): { url: string; body: string } {
  void method;
  void responses;

  const hotelId = String(params?.hotel_id ?? '');

  // Recorded inner payload (seq 497): positions 0-7 null, [8] = hotel token,
  // 9 & 10 null, [11] = constant [[]].
  const innerPayload = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    hotelId,
    null,
    null,
    [[]],
  ];

  const u = new URL(url);
  const fSid = u.searchParams.get('f.sid') ?? '';
  const bl = u.searchParams.get('bl') ?? '';

  return {
    url: buildBatchExecuteUrl('ocp93e', { f_sid: fSid, bl }),
    body: buildFreqBody('ocp93e', innerPayload, '1'),
  };
}
