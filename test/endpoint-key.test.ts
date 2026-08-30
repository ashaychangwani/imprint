import { describe, expect, it } from 'bun:test';
import { getEndpointKey } from '../src/imprint/endpoint-key.ts';
import type { CapturedRequest } from '../src/imprint/types.ts';

function request(url: string, method = 'GET'): CapturedRequest {
  return {
    seq: 1,
    timestamp: 100,
    method,
    url,
    headers: {},
    resourceType: 'XHR',
  };
}

describe('endpoint family key', () => {
  it('distinguishes plural and singular batched RPC identifiers', () => {
    expect(getEndpointKey(request('https://fixture.invalid/batch?rpcids=Lookup%2CPrice'))).toBe(
      'rpc:Lookup,Price',
    );
    expect(getEndpointKey(request('https://fixture.invalid/batch?rpcid=Checkout'))).toBe(
      'rpc:Checkout',
    );
  });

  it('keeps malformed RPC encodings stable instead of throwing', () => {
    expect(getEndpointKey(request('https://fixture.invalid/batch?rpcid=%E0%A4%A'))).toBe(
      'rpc:%E0%A4%A',
    );
  });

  it('groups ordinary endpoints by method and pathname without query values', () => {
    expect(getEndpointKey(request('https://fixture.invalid/api/search?q=first'))).toBe(
      'GET /api/search',
    );
    expect(getEndpointKey(request('https://fixture.invalid/api/search?q=second', 'POST'))).toBe(
      'POST /api/search',
    );
  });

  it('falls back safely for non-URL request strings', () => {
    expect(getEndpointKey(request('/api/search?q=fixture', 'PATCH'))).toBe('PATCH /api/search');
  });
});
