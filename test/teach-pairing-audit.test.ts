/**
 * Tests for the post-redact pairing audit in src/imprint/teach.ts —
 * specifically `findUnpairedPasswordRequests`, the scanner that detects
 * password-shaped body fields the extractor failed to pair.
 *
 * All fixtures synthetic — see CLAUDE.md "Test data hygiene".
 */

import { describe, expect, it } from 'bun:test';
import { findUnpairedPasswordRequests } from '../src/imprint/teach.ts';
import type { CapturedRequest, Session } from '../src/imprint/types.ts';

function makeReq(over: Partial<CapturedRequest>): CapturedRequest {
  return {
    seq: 1,
    timestamp: 100,
    method: 'POST',
    url: 'https://example.com/x',
    headers: {},
    resourceType: 'XHR',
    ...over,
  };
}

function makeSession(reqs: CapturedRequest[]): Session {
  return {
    site: 'test',
    startedAt: new Date().toISOString(),
    url: 'https://example.com',
    imprintVersion: '0.1.0',
    requests: reqs,
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

describe('findUnpairedPasswordRequests', () => {
  it('flags a JSON body with a nested `password` key', () => {
    // The exact shape that broke panw-canteen: JSON nested under a wrapper
    // key, with text/plain Content-Type (irrelevant to this scanner — it
    // only cares about body shape).
    const session = makeSession([
      makeReq({
        seq: 42,
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          authcode: 'fixture',
          LOGIN: { userid: 'fixture-user', password: 'fixture-pass' },
        }),
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([42]);
  });

  it('flags a form-urlencoded body with a `password` field', () => {
    const session = makeSession([
      makeReq({
        seq: 7,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=fixture-user&password=fixture-pass',
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([7]);
  });

  it('flags a multipart body with a `password` field', () => {
    const boundary = '----FixtureBoundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="username"',
      '',
      'fixture-user',
      `--${boundary}`,
      'Content-Disposition: form-data; name="password"',
      '',
      'fixture-pass',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const session = makeSession([
      makeReq({
        seq: 99,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([99]);
  });

  it('flags a GET-based login with `password` in the URL query string', () => {
    const session = makeSession([
      makeReq({
        seq: 3,
        method: 'GET',
        url: 'https://legacy.example.com/cgi/login?username=fixture-user&password=fixture-pass',
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([3]);
  });

  it('flags Java EE / Spring `j_password` form bodies', () => {
    const session = makeSession([
      makeReq({
        seq: 5,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'j_username=fixture-user&j_password=fixture-pass',
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([5]);
  });

  it('does not flag requests that lack any password-shaped key', () => {
    const session = makeSession([
      makeReq({
        seq: 1,
        url: 'https://example.com/search?q=fixture',
        method: 'GET',
      }),
      makeReq({
        seq: 2,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'fixture', limit: 10 }),
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([]);
  });

  it('does not false-fire on prose containing the word "password"', () => {
    // Substring matches are gated on key-shaped contexts: `"password"`,
    // `password=`, or `name="password"`. Free-form prose shouldn't trip.
    const session = makeSession([
      makeReq({
        seq: 1,
        headers: { 'content-type': 'text/plain' },
        body: 'Please reset your password by visiting the link below.',
      }),
    ]);
    expect(findUnpairedPasswordRequests(session)).toEqual([]);
  });

  it('returns multiple seqs when the same recording logs in to multiple stores', () => {
    // Mirrors panw-canteen's pattern: same login replayed across 4 cafe
    // storeids, each producing its own LOGIN request.
    const reqs = [141, 330, 504, 685, 834].map((seq) =>
      makeReq({
        seq,
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          name: 'LOGIN',
          LOGIN: { userid: 'fixture-user', password: 'fixture-pass' },
        }),
      }),
    );
    expect(findUnpairedPasswordRequests(makeSession(reqs))).toEqual([141, 330, 504, 685, 834]);
  });
});
