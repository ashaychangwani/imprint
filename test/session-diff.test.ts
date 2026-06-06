import { describe, expect, it } from 'bun:test';
import {
  type CapturedReplayRequest,
  type ClassifiedValue,
  alignRequests,
  diffTriagedSessions,
  mergeClassifications,
  triageByAlignment,
} from '../src/imprint/session-diff.ts';
import type { Session } from '../src/imprint/types.ts';

function cv(
  originalSeq: number,
  location: string,
  classification: ClassifiedValue['classification'],
  overrides: Partial<ClassifiedValue> = {},
): ClassifiedValue {
  return {
    classification,
    location,
    originalSeq,
    value1: 'v1',
    value2: 'v2',
    ...overrides,
  };
}

function makeRequest(
  seq: number,
  method: string,
  url: string,
  overrides: Partial<CapturedReplayRequest> = {},
): CapturedReplayRequest {
  return {
    seq,
    timestamp: seq * 100,
    method,
    url,
    headers: {},
    resourceType: 'Fetch',
    ...overrides,
  };
}

function makeSession(requests: Session['requests'][]): Session {
  return {
    site: 'test',
    startedAt: '2026-05-14T00:00:00.000Z',
    url: 'https://example.com',
    imprintVersion: '0.1.0',
    requests: requests.flat(),
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

describe('alignRequests', () => {
  it('pairs requests by method + URL pathname', () => {
    const run1 = [makeRequest(1, 'POST', 'https://api.example.com/search?q=foo')];
    const run2 = [makeRequest(1, 'POST', 'https://api.example.com/search?q=bar')];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.originalSeq).toBe(1);
    expect(pairs[0]?.replaySeq).toBe(1);
    expect(pairs[0]?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('aligns by relative sequence within groups', () => {
    const run1 = [
      makeRequest(1, 'POST', 'https://api.example.com/search'),
      makeRequest(2, 'POST', 'https://api.example.com/search'),
    ];
    const run2 = [
      makeRequest(10, 'POST', 'https://api.example.com/search'),
      makeRequest(20, 'POST', 'https://api.example.com/search'),
    ];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.originalSeq).toBe(1);
    expect(pairs[0]?.replaySeq).toBe(10);
    expect(pairs[1]?.originalSeq).toBe(2);
    expect(pairs[1]?.replaySeq).toBe(20);
  });

  it('does not pair requests with different methods', () => {
    const run1 = [makeRequest(1, 'GET', 'https://api.example.com/data')];
    const run2 = [makeRequest(1, 'POST', 'https://api.example.com/data')];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(0);
  });

  it('does not pair requests with different URL paths', () => {
    const run1 = [makeRequest(1, 'GET', 'https://api.example.com/users')];
    const run2 = [makeRequest(1, 'GET', 'https://api.example.com/items')];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(0);
  });

  it('boosts confidence for matching JSON body structure', () => {
    const run1 = [
      makeRequest(1, 'POST', 'https://api.example.com/search', {
        body: JSON.stringify({ origin: 'SFO', destination: 'LAX' }),
      }),
    ];
    const run2 = [
      makeRequest(1, 'POST', 'https://api.example.com/search', {
        body: JSON.stringify({ origin: 'JFK', destination: 'BOS' }),
      }),
    ];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.confidence).toBeGreaterThan(0.7);
  });

  it('handles unmatched requests gracefully', () => {
    const run1 = [
      makeRequest(1, 'GET', 'https://api.example.com/a'),
      makeRequest(2, 'GET', 'https://api.example.com/b'),
    ];
    const run2 = [makeRequest(1, 'GET', 'https://api.example.com/a')];
    const pairs = alignRequests(run1, run2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.originalSeq).toBe(1);
  });
});

describe('diffTriagedSessions', () => {
  it('classifies identical values as constant', () => {
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.example.com/data?key=static_value',
          headers: { 'x-api-key': 'app-key-123' },
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'GET', 'https://api.example.com/data?key=static_value', {
          headers: { 'x-api-key': 'app-key-123' },
        }),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    const keyClassification = result.classifications.find((c) => c.location === 'url_param:key');
    expect(keyClassification).toBeDefined();
    expect(keyClassification?.classification).toBe('constant');
  });

  it('classifies differing values not in prior responses as browser_minted', () => {
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.com/search?correlationId=uuid-aaa',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [makeRequest(1, 'POST', 'https://api.example.com/search?correlationId=uuid-bbb')],
    };
    const result = diffTriagedSessions(session, replay);
    const corr = result.classifications.find((c) => c.location === 'url_param:correlationId');
    expect(corr).toBeDefined();
    expect(corr?.classification).toBe('browser_minted');
    expect(corr?.value1).toBe('uuid-aaa');
    expect(corr?.value2).toBe('uuid-bbb');
    expect(corr?.suggestedStateName).toBeTruthy();
  });

  it('classifies differing values found in prior response as server_derived', () => {
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.example.com/init',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({ sessionToken: 'token-222' }),
            mimeType: 'application/json',
          },
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://api.example.com/search',
          headers: { 'x-session-token': 'token-111' },
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'GET', 'https://api.example.com/init', {
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({ sessionToken: 'token-222' }),
            mimeType: 'application/json',
          },
        }),
        makeRequest(2, 'POST', 'https://api.example.com/search', {
          headers: { 'x-session-token': 'token-222' },
        }),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    const tokenClass = result.classifications.find((c) => c.location === 'header:x-session-token');
    expect(tokenClass).toBeDefined();
    expect(tokenClass?.classification).toBe('server_derived');
    expect(tokenClass?.producerSeq).toBe(1);
    expect(tokenClass?.producerPath).toContain('sessionToken');
  });

  it('remaps a server_derived producerSeq from replay-seq space to original-seq space', () => {
    // Production case: the replay assigns its own (0-based) seqs that do NOT match
    // the original seqs. producerSeq must be reported in ORIGINAL-seq space.
    const session = makeSession([
      [
        {
          seq: 10,
          timestamp: 1000,
          method: 'GET',
          url: 'https://api.example.com/init',
          headers: {},
          resourceType: 'Fetch',
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({ sessionToken: 'tok-recorded' }),
            mimeType: 'application/json',
          },
        },
        {
          seq: 20,
          timestamp: 2000,
          method: 'POST',
          url: 'https://api.example.com/search',
          headers: { 'x-session-token': 'token-111' },
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'GET', 'https://api.example.com/init', {
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({ sessionToken: 'token-222' }),
            mimeType: 'application/json',
          },
        }),
        makeRequest(2, 'POST', 'https://api.example.com/search', {
          headers: { 'x-session-token': 'token-222' },
        }),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    const tokenClass = result.classifications.find((c) => c.location === 'header:x-session-token');
    expect(tokenClass?.classification).toBe('server_derived');
    // The producer is the init request: original seq 10, replay seq 1. Must be 10.
    expect(tokenClass?.producerSeq).toBe(10);
  });

  it('tags a stable opaque value found in a prior response with producer provenance', () => {
    const search = {
      status: 200,
      headers: {},
      body: JSON.stringify({ detailToken: 'fixture-detail-0001', locale: 'en' }),
      mimeType: 'application/json',
    };
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.example.com/search',
          headers: {},
          resourceType: 'Fetch',
          response: search,
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://api.example.com/detail',
          headers: { 'x-detail': 'fixture-detail-0001', 'x-locale': 'en' },
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'GET', 'https://api.example.com/search', { response: search }),
        // Same entity → same token (stable across runs).
        makeRequest(2, 'POST', 'https://api.example.com/detail', {
          headers: { 'x-detail': 'fixture-detail-0001', 'x-locale': 'en' },
        }),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    const tokenClass = result.classifications.find((c) => c.location === 'header:x-detail');
    expect(tokenClass?.classification).toBe('constant');
    expect(tokenClass?.producerSeq).toBe(1);
    expect(tokenClass?.producerPath).toContain('detailToken');
    // A short / free-text stable value is NOT tagged (opacity gate).
    const localeClass = result.classifications.find((c) => c.location === 'header:x-locale');
    expect(localeClass?.classification).toBe('constant');
    expect(localeClass?.producerSeq).toBeUndefined();
  });

  it('reports unmatched requests in both directions', () => {
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://api.example.com/a',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://api.example.com/only-in-run1',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'GET', 'https://api.example.com/a'),
        makeRequest(2, 'GET', 'https://api.example.com/only-in-run2'),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    expect(result.unmatchedOriginal).toContain(2);
    expect(result.unmatchedReplay).toContain(2);
  });

  it('handles JSON body value diffs', () => {
    const session = makeSession([
      [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.com/search',
          headers: {},
          body: JSON.stringify({ query: 'test', nonce: 'nonce-aaa' }),
          resourceType: 'Fetch',
        },
      ],
    ]);
    const replay = {
      requests: [
        makeRequest(1, 'POST', 'https://api.example.com/search', {
          body: JSON.stringify({ query: 'test', nonce: 'nonce-bbb' }),
        }),
      ],
    };
    const result = diffTriagedSessions(session, replay);
    const queryClass = result.classifications.find((c) => c.location === 'body.query');
    expect(queryClass?.classification).toBe('constant');
    const nonceClass = result.classifications.find((c) => c.location === 'body.nonce');
    expect(nonceClass?.classification).toBe('browser_minted');
  });
});

describe('triageByAlignment', () => {
  it('filters run-2 requests to those matching run-1 triaged set', () => {
    const triaged1 = [
      {
        seq: 1,
        timestamp: 100,
        method: 'POST' as const,
        url: 'https://api.example.com/search',
        headers: {},
        resourceType: 'Fetch',
      },
    ];
    const allRun2 = [
      makeRequest(1, 'GET', 'https://cdn.example.com/logo.png'),
      makeRequest(2, 'POST', 'https://api.example.com/search'),
      makeRequest(3, 'POST', 'https://analytics.example.com/track'),
    ];
    const result = triageByAlignment(triaged1, allRun2);
    expect(result).toContain(2);
    expect(result).not.toContain(1);
    expect(result).not.toContain(3);
  });

  it('returns empty array when nothing aligns', () => {
    const triaged1 = [
      {
        seq: 1,
        timestamp: 100,
        method: 'POST' as const,
        url: 'https://api.example.com/search',
        headers: {},
        resourceType: 'Fetch',
      },
    ];
    const allRun2 = [makeRequest(1, 'GET', 'https://completely-different.com/path')];
    const result = triageByAlignment(triaged1, allRun2);
    expect(result).toHaveLength(0);
  });
});

describe('mergeClassifications', () => {
  it('keeps a value the replay never observed but recordings agree on (marriott signature regression)', () => {
    // Pass 1 = recording vs blocked replay: the protected request never aligned,
    // so its signature header was never classified.
    const replayPass: ClassifiedValue[] = [cv(2, 'url_param:q', 'constant')];
    // Pass 2 = recording vs another real recording (captured hours apart): the
    // protected request aligned and its signature is byte-identical → constant.
    const crossPass: ClassifiedValue[] = [
      cv(5, 'header:graphql-operation-signature', 'constant', {
        value1: '7d7f73',
        value2: '7d7f73',
      }),
    ];
    const merged = mergeClassifications([replayPass, crossPass]);
    const sig = merged.find((c) => c.location === 'header:graphql-operation-signature');
    expect(sig).toBeDefined();
    expect(sig?.classification).toBe('constant');
  });

  it('a value that varies in ANY pass is ephemeral (non-constant wins)', () => {
    const passA: ClassifiedValue[] = [cv(1, 'header:x-token', 'constant')];
    const passB: ClassifiedValue[] = [
      cv(1, 'header:x-token', 'server_derived', { producerSeq: 0, producerPath: '$.token' }),
    ];
    const merged = mergeClassifications([passA, passB]);
    const tok = merged.find((c) => c.location === 'header:x-token');
    expect(tok?.classification).toBe('server_derived');
    // provenance from the non-constant pass is preserved
    expect(tok?.producerSeq).toBe(0);
    expect(tok?.producerPath).toBe('$.token');
  });

  it('server_derived outranks browser_minted', () => {
    const merged = mergeClassifications([
      [cv(3, 'body:$.nonce', 'browser_minted')],
      [cv(3, 'body:$.nonce', 'server_derived', { producerSeq: 1 })],
    ]);
    expect(merged.find((c) => c.location === 'body:$.nonce')?.classification).toBe(
      'server_derived',
    );
  });

  it('keys by (originalSeq, location) so the same header on different requests stays distinct', () => {
    const merged = mergeClassifications([
      [cv(5, 'header:graphql-operation-signature', 'constant')],
      [cv(8, 'header:graphql-operation-signature', 'server_derived')],
    ]);
    const sigs = merged.filter((c) => c.location === 'header:graphql-operation-signature');
    expect(sigs).toHaveLength(2);
    expect(sigs.find((c) => c.originalSeq === 5)?.classification).toBe('constant');
    expect(sigs.find((c) => c.originalSeq === 8)?.classification).toBe('server_derived');
  });

  it('returns empty for no passes / empty passes', () => {
    expect(mergeClassifications([])).toEqual([]);
    expect(mergeClassifications([[], []])).toEqual([]);
  });
});
