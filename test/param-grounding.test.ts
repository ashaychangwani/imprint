import { describe, expect, it } from 'bun:test';
import {
  decodeBodyForDiff,
  endpointsForSeqs,
  groundEvent,
  groundingForEvents,
  inputProvenance,
  structuralDiff,
} from '../src/imprint/param-grounding.ts';
import type { Session } from '../src/imprint/types.ts';

// Synthetic batchexecute f.req body wrapping an inner payload.
const freq = (inner: unknown): string =>
  `f.req=${encodeURIComponent(JSON.stringify([[['Search', JSON.stringify(inner), null, 'generic']]]))}`;

function req(seq: number, body: string) {
  return {
    seq,
    timestamp: seq,
    method: 'POST',
    url: 'https://x.test/data/batchexecute?rpcids=Search',
    headers: {},
    resourceType: 'Fetch',
    response: { status: 200, headers: {}, mimeType: 'application/json', body: '{}' },
    body,
  };
}
function clickEvent(seq: number, text: string) {
  return { seq, type: 'click', timestamp: seq, detail: JSON.stringify({ tag: 'div', text }) };
}

// A search, then a "4+ rating" toggle changes inner[1][2] from null -> 4.
const session = {
  site: 'demo',
  startedAt: '2026-05-04T00:00:00.000Z',
  url: 'https://x.test/',
  imprintVersion: '0.1.0',
  requests: [req(10, freq(['q', [null, null, null]])), req(30, freq(['q', [null, null, 4]]))],
  events: [clickEvent(20, '4+ rating')],
  narration: [],
  cookieSnapshots: [],
  storageSnapshots: [],
} as unknown as Session;

describe('decodeBodyForDiff', () => {
  it('unwraps an f.req batchexecute envelope to the inner payload', () => {
    expect(decodeBodyForDiff(freq(['q', [1, 2]]))).toEqual(['q', [1, 2]]);
  });
  it('parses a raw JSON body and a flat form body', () => {
    expect(decodeBodyForDiff('{"a":1}')).toEqual({ a: 1 });
    expect(decodeBodyForDiff('a=1&b=2')).toEqual({ a: '1', b: '2' });
  });
  it('returns undefined for an empty body', () => {
    expect(decodeBodyForDiff(undefined)).toBeUndefined();
    expect(decodeBodyForDiff('')).toBeUndefined();
  });
});

describe('structuralDiff', () => {
  it('reports the exact changed array path', () => {
    const d = structuralDiff(['q', [null, null, null]], ['q', [null, null, 4]]);
    expect(d).toHaveLength(1);
    expect(d[0]?.path).toBe('[1][2]');
    expect(d[0]?.after).toBe('4');
  });
  it('returns nothing for identical structures', () => {
    expect(structuralDiff({ a: [1, 2] }, { a: [1, 2] })).toHaveLength(0);
  });
});

describe('groundEvent', () => {
  it('finds the triggered request, diffs vs the prior equivalent, and locates the param position', () => {
    const g = groundEvent(session, 20, endpointsForSeqs(session, [10, 30]));
    expect(g.label).toBe('4+ rating');
    expect(g.triggeredSeq).toBe(30);
    expect(g.priorSeq).toBe(10);
    expect(g.changes.some((c) => c.path === '[1][2]' && c.after === '4')).toBe(true);
  });

  it('returns no trigger when the click fires no comparable request', () => {
    const g = groundEvent(session, 999, endpointsForSeqs(session, [10, 30]));
    expect(g.triggeredSeq).toBeUndefined();
    expect(g.changes).toHaveLength(0);
  });
});

describe('groundingForEvents', () => {
  it('surfaces grounding for events that changed the request', () => {
    const g = groundingForEvents(session, [20], endpointsForSeqs(session, [10, 30]));
    expect(g).toHaveLength(1);
    expect(g[0]?.changes.some((c) => c.path === '[1][2]')).toBe(true);
  });
});

describe('inputProvenance', () => {
  // A resolve request (text "chicago loop") whose RESPONSE mints a KG mid, then a
  // search carrying that mid in its body at [1][0]. The mid is id-like and first
  // appears upstream → flagged as a chained input; the free-text is not.
  function reqWithResp(seq: number, body: string, respBody: string) {
    return {
      seq,
      timestamp: seq,
      method: 'POST',
      url: 'https://x.test/data/batchexecute?rpcids=Search',
      headers: {},
      resourceType: 'Fetch',
      response: { status: 200, headers: {}, mimeType: 'application/json', body: respBody },
      body,
    };
  }
  const chainSession = {
    ...session,
    requests: [
      reqWithResp(
        10,
        freq(['chicago loop', null]),
        ')]}\'\n[["wrb.fr",null,"[[\\"/m/0gz469\\"]]"]]',
      ),
      reqWithResp(30, freq(['chicago loop', ['/m/0gz469']]), '{}'),
    ],
    events: [],
  } as unknown as Session;

  it('flags a body id minted by an earlier response, with self-chain set', () => {
    const p = inputProvenance(chainSession, [30]);
    expect(p).toHaveLength(1);
    expect(p[0]?.path).toBe('[1][0]');
    expect(p[0]?.valueSample).toBe('/m/0gz469');
    expect(p[0]?.sourceSeq).toBe(10);
    expect(p[0]?.selfChain).toBe(true);
  });

  it('does not flag the free-text param itself (not id-like)', () => {
    const p = inputProvenance(chainSession, [10]);
    expect(p).toHaveLength(0);
  });

  // Generalization guards: the id-like test is structural (vendor-agnostic), not
  // a list of known id formats. It must still exclude values that merely happen
  // to be echoed from a response — ISO dates and plain words — and must catch a
  // generic opaque handle (UUID) with no Google-specific shape.
  function chainOf(value: string): Session {
    return {
      ...session,
      requests: [
        reqWithResp(10, freq(['q', null]), `)]}'\n[["wrb.fr",null,"[[\\"${value}\\"]]"]]`),
        reqWithResp(30, freq(['q', [value]]), '{}'),
      ],
      events: [],
    } as unknown as Session;
  }

  it('does not flag a chained ISO date (not an opaque id)', () => {
    expect(inputProvenance(chainOf('2026-07-03'), [30])).toHaveLength(0);
  });

  it('does not flag a chained plain word like a brand name', () => {
    expect(inputProvenance(chainOf('Budget'), [30])).toHaveLength(0);
  });

  it('flags a generic UUID handle (structural, no vendor-specific shape)', () => {
    const p = inputProvenance(chainOf('550e8400-e29b-41d4-a716-446655440000'), [30]);
    expect(p).toHaveLength(1);
    expect(p[0]?.valueSample).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(p[0]?.selfChain).toBe(true);
  });
});
