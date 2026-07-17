import { describe, expect, it } from 'bun:test';
import { RequestBodyLifecycleTracker } from '../src/imprint/response-body-lifecycle.ts';
import {
  ResponseBodyStreamLeaseTracker,
  ResponseBodyStreamStore,
  STREAM_TRUNCATION_MARKER,
  isStructurallyCompleteReactFlight,
  isStructurallyCompleteServerActionFlight,
  matchesIntendedRoute,
  needsLaterIntent,
  resolveResponseBodyWithFallback,
  shouldRecoverStreamedBody,
  shouldStreamResponseBody,
} from '../src/imprint/response-body-stream.ts';

describe('RequestBodyLifecycleTracker', () => {
  it('defers generation cleanup when a terminal event races an active body read', () => {
    const tracker = new RequestBodyLifecycleTracker();
    tracker.begin('request-1', 42);

    expect(tracker.markTerminal('request-1', 42)).toBe(false);
    expect(tracker.finish('request-1', 42)).toBe(true);
  });

  it('allows immediate cleanup after body work has already exited', () => {
    const tracker = new RequestBodyLifecycleTracker();
    tracker.begin('request-1', 42);

    expect(tracker.finish('request-1', 42)).toBe(false);
    expect(tracker.markTerminal('request-1', 42)).toBe(true);

    // An immediate cleanup must not retain a terminal marker for a later reuse
    // of the same CDP request id and generation number.
    tracker.begin('request-1', 42);
    expect(tracker.finish('request-1', 42)).toBe(false);
  });

  it('keeps reused request-id generations independent', () => {
    const tracker = new RequestBodyLifecycleTracker();
    tracker.begin('request-1', 41);
    tracker.begin('request-1', 42);

    expect(tracker.markTerminal('request-1', 41)).toBe(false);
    expect(tracker.finish('request-1', 42)).toBe(false);
    expect(tracker.finish('request-1', 41)).toBe(true);
  });
});

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64');

describe('matchesIntendedRoute', () => {
  it('ignores the transient RSC cache key and a trailing slash', () => {
    expect(
      matchesIntendedRoute(
        'https://example.com/products/?category=tools&_rsc=cache-key',
        'https://example.com/products?category=tools',
      ),
    ).toBe(true);
    expect(
      matchesIntendedRoute(
        'https://example.com/products?sort=price&category=tools&_rsc=cache-key',
        'https://example.com/products?category=tools&sort=price',
      ),
    ).toBe(true);
  });

  it('does not correlate a different route, query, or origin', () => {
    for (const requestUrl of [
      'https://example.com/other?_rsc=key',
      'https://example.com/products?category=books&_rsc=key',
      'https://other.example/products?category=tools&_rsc=key',
    ]) {
      expect(matchesIntendedRoute(requestUrl, 'https://example.com/products?category=tools')).toBe(
        false,
      );
    }
  });
});

describe('shouldStreamResponseBody', () => {
  it('includes observed Next.js navigation and Server Action response classes', () => {
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { RSC: '1' },
      }),
    ).toBe(true);
    expect(
      shouldStreamResponseBody({
        method: 'POST',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'text/x-component; charset=utf-8',
        url: 'https://example.com/server/search',
        requestHeaders: {
          Accept: 'text/x-component',
          'Content-Type': 'text/plain;charset=UTF-8',
          'Next-Action': 'action-id',
        },
      }),
    ).toBe(true);
    expect(
      shouldStreamResponseBody({
        method: 'POST',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'text/x-component',
        url: 'https://example.com/infinite-scroll',
        requestHeaders: {
          accept: 'text/x-component',
          'content-type': 'multipart/form-data; boundary=abc',
          'next-action': 'action-id',
        },
      }),
    ).toBe(true);
    expect(
      shouldStreamResponseBody({
        method: 'POST',
        resourceType: 'XHR',
        status: 200,
        mimeType: 'application/json; charset=utf-8',
        url: 'https://example.com/api',
        requestHeaders: {},
      }),
    ).toBe(false);
  });

  it('excludes bodyless methods/statuses and noisy resource types', () => {
    expect(
      shouldStreamResponseBody({
        method: 'HEAD',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'application/json',
        url: 'https://example.com/api',
        requestHeaders: {},
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'XHR',
        status: 204,
        mimeType: 'application/json',
        url: 'https://example.com/api',
        requestHeaders: {},
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Image',
        status: 200,
        mimeType: 'image/png',
        url: 'https://example.com/image.png',
        requestHeaders: {},
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'text/event-stream',
        url: 'https://example.com/events',
        requestHeaders: {},
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Document',
        status: 200,
        mimeType: 'text/html',
        url: 'https://example.com/',
        requestHeaders: {},
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'text/x-component',
        contentLength: 2 * 1024 * 1024 + 1,
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
      }),
    ).toBe(false);
  });

  it('requires a framework request signal and rejects unqualified POSTs', () => {
    for (const candidate of [
      { method: 'POST', url: 'https://example.com/app', requestHeaders: { rsc: '1' } },
      {
        method: 'POST',
        url: 'https://example.com/app',
        requestHeaders: { accept: 'text/x-component' },
      },
      {
        method: 'GET',
        url: 'https://example.com/app',
        requestHeaders: {} as Record<string, string>,
      },
    ]) {
      expect(
        shouldStreamResponseBody({
          ...candidate,
          resourceType: 'Fetch',
          status: 200,
          mimeType: 'text/x-component',
        }),
      ).toBe(false);
    }
  });

  it('covers GET variants without requiring the transient _rsc query parameter', () => {
    for (const requestHeaders of [
      { RSC: '1' },
      { Accept: 'text/x-component' },
      { 'Next-Router-State-Tree': '["",{}]' },
    ] as Record<string, string>[]) {
      expect(
        shouldStreamResponseBody({
          method: 'GET',
          resourceType: 'Fetch',
          status: 200,
          mimeType: 'text/x-component',
          url: 'https://example.com/app',
          requestHeaders,
        }),
      ).toBe(true);
    }
  });

  it('streams labeled prefetches but marks uncorrelated ones for later intent', () => {
    const candidate = {
      method: 'GET',
      resourceType: 'Fetch',
      status: 200,
      mimeType: 'text/x-component',
      url: 'https://example.com/app?_rsc=abc',
      requestHeaders: {
        RSC: '1',
        'Next-Router-Prefetch': '1',
        'Next-Router-Segment-Prefetch': '/_tree',
      },
    };
    expect(shouldStreamResponseBody(candidate)).toBe(true);
    expect(needsLaterIntent(candidate)).toBe(true);
    expect(
      shouldStreamResponseBody({
        ...candidate,
        recentUserIntent: true,
        intendedUrl: 'https://example.com/app',
      }),
    ).toBe(true);
    expect(
      needsLaterIntent({
        ...candidate,
        recentUserIntent: true,
        intendedUrl: 'https://example.com/app',
      }),
    ).toBe(true);
    expect(
      needsLaterIntent({
        ...candidate,
        recentUserIntent: true,
        recentUserActivation: true,
        intendedUrl: 'https://example.com/app',
      }),
    ).toBe(false);
    expect(
      shouldStreamResponseBody({
        ...candidate,
        recentUserIntent: true,
        recentUserActivation: true,
        intendedUrl: 'https://example.com/other',
      }),
    ).toBe(true);
    expect(
      needsLaterIntent({
        ...candidate,
        recentUserIntent: true,
        intendedUrl: 'https://example.com/other',
      }),
    ).toBe(true);
  });

  it('does not stream redirects even if they carry RSC request headers', () => {
    expect(
      shouldStreamResponseBody({
        method: 'GET',
        resourceType: 'Fetch',
        status: 307,
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
      }),
    ).toBe(false);
  });
});

describe('shouldRecoverStreamedBody', () => {
  const completeFlight = [
    '1:"$Sreact.fragment"',
    '0:{"b":"build-id","f":["$L2","$1"],"q":"?id=1","i":false,"S":false}',
    '2:["$","div",null,{"children":"forecast"}]',
    '',
  ].join('\n');
  const olderServerActionFlight = [
    '2:HL["/font.woff2",{"as":"font"}]',
    '0:["$@1",[]]',
    '1:"$undefined"',
    '',
  ].join('\n');
  const modernServerActionFlight = [
    '2:"$Sreact.fragment"',
    '3:I[3063,["chunk.js"],"Image"]',
    '0:{"a":"$@1","f":"","b":"build-id"}',
    '1:[["$","$2",null,{"children":["$","$L3",null,{}]}]]',
    '',
  ].join('\n');
  const modernNavigationFlight = [
    '#1:"$Sreact.fragment"',
    '2:I[3063,["chunk.js"],"Image"]',
    '0:{"P":null,"c":["","products"],"q":"","i":false,"f":["$L2"]}',
    '3:X',
    '3:C',
    '',
  ].join('\n');
  const treePrefetchFlight = [
    ':HL["/style.css","style"]',
    '0:{"tree":{"name":"products","slots":null},"staleTime":300}',
    '',
  ].join('\n');
  const dataPrefetchFlight = [
    '1:"$Sreact.fragment"',
    '0:{"buildId":"","data":[{"rsc":"$1"}]}',
    '',
  ].join('\n');

  it('allows completed responses whose normal body lookup was evicted', () => {
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'finished' },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: completeFlight,
      }),
    ).toBe(true);
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'finished' },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: `${completeFlight.slice(0, -1)}${STREAM_TRUNCATION_MARKER}`,
      }),
    ).toBe(false);
  });

  it('allows a structurally complete canceled Next.js RSC navigation', () => {
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { RSC: '1' },
        body: completeFlight,
      }),
    ).toBe(true);
    for (const body of [modernNavigationFlight, treePrefetchFlight, dataPrefetchFlight]) {
      expect(
        shouldRecoverStreamedBody({
          completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
          method: 'GET',
          mimeType: 'text/x-component',
          url: 'https://example.com/products',
          requestHeaders: { RSC: '1', 'Next-Router-Prefetch': '1' },
          body,
        }),
      ).toBe(true);
    }
  });

  it('requires every React stream-control row to close on the same chunk id', () => {
    expect(isStructurallyCompleteReactFlight(modernNavigationFlight)).toBe(true);
    expect(isStructurallyCompleteReactFlight(modernNavigationFlight.replace('3:C', '4:C'))).toBe(
      false,
    );
    expect(isStructurallyCompleteReactFlight(modernNavigationFlight.replace('3:C\n', ''))).toBe(
      false,
    );
    for (const start of ['R', 'r', 'X', 'x']) {
      expect(
        isStructurallyCompleteReactFlight(modernNavigationFlight.replace('3:X', `3:${start}`)),
      ).toBe(true);
    }
    expect(
      isStructurallyCompleteReactFlight(modernNavigationFlight.replace('3:C', '3:C\n3:["late"]')),
    ).toBe(false);
    expect(
      isStructurallyCompleteReactFlight(modernNavigationFlight.replace('3:C', '3:C\n3:X\n3:C')),
    ).toBe(false);
  });

  it('rejects duplicate ordinary chunk definitions', () => {
    expect(
      isStructurallyCompleteReactFlight('0:{"b":"id","f":["$L1"],"q":""}\n1:null\n1:null\n'),
    ).toBe(false);
    expect(
      isStructurallyCompleteServerActionFlight('0:{"a":"$@1","f":"","b":"id"}\n1:null\n1:null\n'),
    ).toBe(false);
  });

  it('rejects Flight bodies whose tiny rows exceed the shared metadata budget', () => {
    const rows = ['0:{"b":"id","f":["$L1"],"q":""}', '1:null'];
    for (let index = 2; index < 17_000; index++) rows.push(`${index.toString(16)}:null`);
    expect(isStructurallyCompleteReactFlight(`${rows.join('\n')}\n`)).toBe(false);
  });

  it('rejects a single excessively wide Flight JSON row before parsing it', () => {
    const body = `0:{"b":"id","f":[],"q":"","items":[${Array.from(
      { length: 40_000 },
      () => '0',
    ).join(',')}]}\n`;
    expect(isStructurallyCompleteReactFlight(body)).toBe(false);
  });

  it('does not interpret dollar signs inside user strings as chunk references', () => {
    for (const label of ['Only $2', '$$2']) {
      const body = [
        '1:"$Sreact.fragment"',
        `0:{"b":"build-id","f":["$1"],"q":"","label":${JSON.stringify(label)}}`,
        '',
      ].join('\n');
      expect(isStructurallyCompleteReactFlight(body)).toBe(true);
    }
  });

  it('recovers canceled GET variants accepted by the streaming candidate policy', () => {
    for (const [url, requestHeaders] of [
      ['https://example.com/app?_rsc=key', {}],
      ['https://example.com/app', { Accept: 'text/x-component' }],
      ['https://example.com/app', { 'Next-Router-State-Tree': '["",{}]' }],
    ] as Array<[string, Record<string, string>]>) {
      expect(
        shouldRecoverStreamedBody({
          completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
          method: 'GET',
          mimeType: 'text/x-component',
          url,
          requestHeaders,
          body: completeFlight,
        }),
      ).toBe(true);
    }
  });

  it('allows complete canceled Server Actions across observed Next.js generations', () => {
    for (const body of [olderServerActionFlight, modernServerActionFlight]) {
      expect(
        shouldRecoverStreamedBody({
          completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
          method: 'POST',
          mimeType: 'text/x-component',
          url: 'https://example.com/action',
          requestHeaders: { 'Next-Action': 'action-id', Accept: 'text/x-component' },
          body,
        }),
      ).toBe(true);
      expect(isStructurallyCompleteServerActionFlight(body)).toBe(true);
    }
  });

  it('requires the Server Action root itself to own a resolved action reference', () => {
    expect(isStructurallyCompleteServerActionFlight('0:[]\n1:"$2"\n2:null\n')).toBe(false);
    expect(
      isStructurallyCompleteServerActionFlight(
        '0:{"a":"not-a-reference","f":null,"b":"id"}\n1:"$2"\n2:null\n',
      ),
    ).toBe(false);
  });

  it('rejects pathologically deep Flight JSON without throwing', () => {
    const body = `0:{"b":"id","f":[${'['.repeat(1_000)}"$1"${']'.repeat(1_000)}],"q":""}\n1:null\n`;
    expect(() => isStructurallyCompleteReactFlight(body)).not.toThrow();
    expect(isStructurallyCompleteReactFlight(body)).toBe(false);
  });

  it('rejects truncated, dangling, and unqualified Server Action bodies', () => {
    for (const body of [
      modernServerActionFlight.slice(0, -1),
      '0:{"a":"$@1","f":"","b":"build-id"}\n',
      '0:{"a":"$@1","f":"","b":"build-id"}\n1:{\n',
    ]) {
      expect(isStructurallyCompleteServerActionFlight(body)).toBe(false);
    }
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
        method: 'POST',
        mimeType: 'text/x-component',
        url: 'https://example.com/action',
        requestHeaders: { Accept: 'text/x-component' },
        body: modernServerActionFlight,
      }),
    ).toBe(false);
  });

  it('rejects generic, blocked, malformed, and incomplete failures', () => {
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'failed', errorText: 'net::ERR_CONNECTION_RESET' },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: completeFlight,
      }),
    ).toBe(false);
    expect(
      shouldRecoverStreamedBody({
        completion: {
          kind: 'failed',
          errorText: 'net::ERR_ABORTED',
          canceled: true,
          blockedReason: 'other',
        },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: completeFlight,
      }),
    ).toBe(false);
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: '0:{"root":"$L2"}\n',
      }),
    ).toBe(false);
    expect(
      shouldRecoverStreamedBody({
        completion: { kind: 'timeout' },
        mimeType: 'text/x-component',
        url: 'https://example.com/app?_rsc=abc',
        requestHeaders: { rsc: '1' },
        body: completeFlight,
      }),
    ).toBe(false);
  });

  it('recognizes complete Flight framing and rejects a missing referenced chunk', () => {
    expect(isStructurallyCompleteReactFlight(completeFlight)).toBe(true);
    expect(isStructurallyCompleteReactFlight(modernNavigationFlight)).toBe(true);
    expect(isStructurallyCompleteReactFlight(treePrefetchFlight)).toBe(true);
    expect(isStructurallyCompleteReactFlight(dataPrefetchFlight)).toBe(true);
    expect(
      isStructurallyCompleteReactFlight(
        '0:{"buildId":"","data":[{"rsc":"$1"}]}\n1:T5,hello2:null\n',
      ),
    ).toBe(true);
    expect(
      isStructurallyCompleteReactFlight(
        '0:{"buildId":"","data":[{"rsc":"$1"}]}\n1:T6,hello2:null\n',
      ),
    ).toBe(false);
    expect(
      isStructurallyCompleteReactFlight(
        '0:{"b":"build-id","f":["$L2"],"q":"?id=1","i":false,"S":false}\n',
      ),
    ).toBe(false);
    for (const prefix of ['', 'L', '@', 'F', 'Q', 'W', 'B', 'K', 'Z', 'i', 'h', 'P', 'Y', 'Y@']) {
      expect(
        isStructurallyCompleteReactFlight(
          `0:{"b":"build-id","f":["$${prefix}2"],"q":"?id=1","i":false,"S":false}\n`,
        ),
      ).toBe(false);
    }
    expect(isStructurallyCompleteReactFlight('0:{\n')).toBe(false);
    expect(isStructurallyCompleteReactFlight('0:{}\n')).toBe(false);
    expect(isStructurallyCompleteReactFlight('0:{}\n1:{\n')).toBe(false);
    expect(isStructurallyCompleteReactFlight(completeFlight.slice(0, -1))).toBe(false);
  });
});

describe('resolveResponseBodyWithFallback', () => {
  it('uses normal getResponseBody output without consulting the speculative stream', async () => {
    let streamReads = 0;
    const resolved = await resolveResponseBodyWithFallback({
      readNormal: async () => 'normal',
      readStream: async () => {
        streamReads++;
        return 'stream';
      },
    });
    expect(resolved).toEqual({ body: 'normal', source: 'normal' });
    expect(streamReads).toBe(0);
  });

  it('uses a stream only after normal capture fails', async () => {
    const error = new Error('No data found for resource');
    const resolved = await resolveResponseBodyWithFallback({
      readNormal: async () => {
        throw error;
      },
      readStream: async () => 'recovered',
    });
    expect(resolved).toEqual({ body: 'recovered', source: 'stream', normalError: error });
  });

  it('recovers a validated Server Action body under an injected normal-read failure', async () => {
    const body = [
      '2:"$Sreact.fragment"',
      '0:{"a":"$@1","f":"","b":"build-id"}',
      '1:[["$","$2",null,{"children":"more products"}]]',
      '',
    ].join('\n');
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('server-action', 42);
    store.appendBufferedData(capture, b64(body.slice(0, 25)));
    store.appendData(capture, b64(body.slice(25)));

    const normalError = new Error('No data found for resource with given identifier');
    const resolved = await resolveResponseBodyWithFallback({
      readNormal: async () => {
        throw normalError;
      },
      readStream: async () =>
        store.recover(capture, (candidate) =>
          shouldRecoverStreamedBody({
            completion: { kind: 'failed', errorText: 'net::ERR_ABORTED', canceled: true },
            method: 'POST',
            mimeType: 'text/x-component',
            url: 'https://example.com/products',
            requestHeaders: { 'Next-Action': 'action-id' },
            body: candidate,
          }),
        ),
    });

    expect(resolved).toEqual({ body, source: 'stream', normalError });
    expect(store.stats.recoveredBytes).toBe(Buffer.byteLength(body));
  });

  it('keeps the response bodyless when the guarded stream is unavailable', async () => {
    const resolved = await resolveResponseBodyWithFallback({
      readNormal: async () => {
        throw new Error('normal failed');
      },
      readStream: async () => null,
    });
    expect(resolved.body).toBeNull();
    expect(resolved.source).toBeNull();
  });
});

describe('ResponseBodyStreamStore', () => {
  it('reconstructs buffered prefix and independently padded data chunks', () => {
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('request-1', 7);
    store.markStarted(capture);
    store.appendBufferedData(capture, b64('hello '));
    store.appendData(capture, b64('world'));

    expect(store.recover(capture)).toBe('hello world');
    expect(store.stats.recovered).toBe(1);
    expect(store.stats.attempted).toBe(1);
    expect(store.stats.started).toBe(1);
    expect(store.stats.observedBytes).toBe(11);
    expect(store.stats.recoveredBytes).toBe(11);
    expect(store.stats.activeBytes).toBe(0);
  });

  it('decodes UTF-8 only after joining chunks', () => {
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('request-2', 8);
    const bytes = Buffer.from('A🌅B');
    store.appendBufferedData(capture, bytes.subarray(0, 3).toString('base64'));
    store.appendData(capture, bytes.subarray(3).toString('base64'));

    expect(store.recover(capture)).toBe('A🌅B');
  });

  it('caps one response and marks the recovered body as truncated', () => {
    const store = new ResponseBodyStreamStore({ perResponseBytes: 5 });
    const capture = store.begin('request-3', 9);
    store.appendData(capture, b64('123456789'));

    expect(store.recover(capture)).toBe(`12345${STREAM_TRUNCATION_MARKER}`);
    expect(store.stats.recoveredBytes).toBe(5);
  });

  it('abandons a capture rather than returning arbitrary data under aggregate pressure', () => {
    const store = new ResponseBodyStreamStore({ activeBytes: 5 });
    const first = store.begin('request-4', 10);
    const second = store.begin('request-5', 11);
    store.appendData(first, b64('1234'));
    store.appendData(second, b64('abcd'));

    expect(second.abandoned).toBe(true);
    expect(store.recover(second)).toBeNull();
    expect(store.recover(first)).toBe('1234');
    expect(store.stats.activeBytes).toBe(0);
  });

  it('persists nothing when a speculative stream is discarded', () => {
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('request-6', 12);
    store.appendData(capture, b64('{"unused":true}'));
    store.discard(capture);

    expect(store.recover(capture)).toBeNull();
    expect(store.stats.recovered).toBe(0);
    expect(store.stats.recoveredBytes).toBe(0);
    expect(store.stats.activeBytes).toBe(0);
  });

  it('does not charge recovery budget when a completeness validator rejects the body', () => {
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('request-rejected', 15);
    store.appendData(capture, b64('partial'));

    expect(store.recover(capture, () => false)).toBeNull();
    expect(store.stats.recovered).toBe(0);
    expect(store.stats.recoveredBytes).toBe(0);
    expect(store.stats.discarded).toBe(1);
  });

  it('releases capture accounting when a completeness validator throws', () => {
    const store = new ResponseBodyStreamStore();
    const capture = store.begin('request', 1);
    store.markStarted(capture);
    store.appendData(capture, Buffer.from('body').toString('base64'));

    expect(
      store.recover(capture, () => {
        throw new Error('validator failed');
      }),
    ).toBeNull();
    expect(store.stats.activeBytes).toBe(0);
    expect(capture.released).toBe(true);
  });

  it('enforces a total persisted recovery budget', () => {
    const store = new ResponseBodyStreamStore({ recoveredBytes: 6 });
    const first = store.begin('request-7', 13);
    const second = store.begin('request-8', 14);
    store.appendData(first, b64('1234'));
    store.appendData(second, b64('abcdef'));

    expect(store.recover(first)).toBe('1234');
    expect(store.recover(second)).toBeNull();
    expect(store.stats.recoveredBytes).toBe(4);
  });

  it('coalesces tiny CDP chunks into bounded slabs', () => {
    const store = new ResponseBodyStreamStore({ perResponseBytes: 600_000, activeBytes: 700_000 });
    const capture = store.begin('tiny-chunks', 15);
    for (let index = 0; index < 500_000; index++) store.appendData(capture, b64('x'));

    expect(capture.dataSlabs.length).toBeLessThanOrEqual(8);
    expect(capture.allocatedBytes).toBeLessThanOrEqual(600_000);
    expect(store.stats.activeBytes).toBe(capture.allocatedBytes);
    expect(store.recover(capture)?.length).toBe(500_000);
    expect(store.stats.activeBytes).toBe(0);
  });
});

describe('ResponseBodyStreamLeaseTracker', () => {
  it('reserves issued slots for activated navigation and Server Action priority', () => {
    const tracker = new ResponseBodyStreamLeaseTracker(4, 1);
    expect(tracker.begin('passive-1', 1)).not.toBeNull();
    expect(tracker.begin('passive-2', 2)).not.toBeNull();
    expect(tracker.begin('passive-3', 3)).not.toBeNull();
    expect(tracker.begin('passive-4', 4)).toBeNull();
    expect(tracker.begin('priority', 5, true)).not.toBeNull();
    expect(tracker.size).toBe(4);
  });

  it('keeps the priority reserve vacant when priority work is already active', () => {
    const tracker = new ResponseBodyStreamLeaseTracker(4, 1);
    expect(tracker.begin('priority-1', 1, true)).not.toBeNull();
    expect(tracker.begin('passive-1', 2)).not.toBeNull();
    expect(tracker.begin('passive-2', 3)).not.toBeNull();
    expect(tracker.begin('passive-3', 4)).toBeNull();
    expect(tracker.begin('priority-2', 5, true)).not.toBeNull();
    expect(tracker.size).toBe(4);
  });

  it('holds an issued slot until both the command and request settle', () => {
    const tracker = new ResponseBodyStreamLeaseTracker(1);
    const first = tracker.begin('request-1', 1);
    expect(first).not.toBeNull();
    if (!first) throw new Error('expected first lease');
    expect(tracker.begin('request-2', 2)).toBeNull();

    tracker.markCommandSettled(first);
    expect(tracker.begin('request-2', 2)).toBeNull();
    tracker.markRequestCompleted('request-1', 1);
    expect(tracker.size).toBe(0);
    expect(tracker.begin('request-2', 2)).not.toBeNull();
  });

  it('keeps a hanging command leased after request completion', () => {
    const tracker = new ResponseBodyStreamLeaseTracker(1);
    const lease = tracker.begin('request', 1);
    if (!lease) throw new Error('expected lease');
    tracker.markRequestCompleted('request', 1);
    expect(tracker.size).toBe(1);
    tracker.markCommandSettled(lease);
    expect(tracker.size).toBe(0);
  });

  it('releases a settled command when the request finishes after a body-wait timeout', () => {
    const tracker = new ResponseBodyStreamLeaseTracker(1);
    const lease = tracker.begin('slow-request', 7);
    if (!lease) throw new Error('expected lease');
    tracker.markCommandSettled(lease);

    // A recorder body-wait timeout is intentionally not a network completion.
    expect(tracker.size).toBe(1);
    tracker.markRequestCompleted('slow-request', 7);
    expect(tracker.size).toBe(0);
  });
});
