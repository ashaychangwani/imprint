/**
 * A stable key grouping "comparable" requests: the batchexecute rpcid when
 * present, else METHOD + URL path (query stripped).
 */

import type { CapturedRequest } from './types.ts';

/** A stable key grouping "comparable" requests: the batchexecute rpcid when
 *  present, else METHOD + URL path (query stripped). */
export function getEndpointKey(req: CapturedRequest): string {
  const url = req.url ?? '';
  // Accept both `rpcids=` (Google batchexecute, plural) and a singular `rpcid=`
  // in the URL query, matching tool-candidates' endpoint-family keying — so a
  // batchexecute-style endpoint never collapses distinct rpcs to one path key.
  const rpc = /[?&]rpcids?=([^&]+)/.exec(url);
  if (rpc) return `rpc:${decodeURIComponent(rpc[1] ?? '')}`;
  try {
    const u = new URL(url);
    return `${req.method ?? 'GET'} ${u.pathname}`;
  } catch {
    return `${req.method ?? 'GET'} ${url.split('?')[0]}`;
  }
}
