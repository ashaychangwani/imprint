/**
 * A stable key grouping comparable requests: a batchexecute rpcid when present,
 * otherwise METHOD plus URL path with the query stripped.
 */

import type { CapturedRequest } from './types.ts';

export function getEndpointKey(req: CapturedRequest): string {
  const url = req.url ?? '';
  const rpc = /[?&]rpcids?=([^&]+)/.exec(url);
  if (rpc) {
    const encodedRpc = rpc[1] ?? '';
    try {
      return `rpc:${decodeURIComponent(encodedRpc)}`;
    } catch {
      return `rpc:${encodedRpc}`;
    }
  }
  try {
    const parsed = new URL(url);
    return `${req.method ?? 'GET'} ${parsed.pathname}`;
  } catch {
    return `${req.method ?? 'GET'} ${url.split('?')[0]}`;
  }
}
