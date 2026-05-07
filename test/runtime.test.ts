/**
 * Unit tests for the workflow execution runtime.
 *
 * Pure-function tests for substitution + a few end-to-end tests using a
 * mocked fetch.
 */

import { describe, expect, it } from 'bun:test';
import {
  type CredentialStore,
  executeWorkflow,
  splitSetCookieHeader,
  substituteString,
} from '../src/imprint/runtime.ts';
import type { Workflow } from '../src/imprint/types.ts';

const STORE: CredentialStore = {
  site: 'test',
  cookies: [{ name: 'session', value: 'abc123', domain: '.example.com', path: '/' }],
  values: { patron_id: 'PATRON_xyz', csrf_token: 'tk_42' },
};

describe('substituteString', () => {
  it('substitutes ${param.X} in URLs (with URI encoding in query strings)', () => {
    const out = substituteString(
      'https://api.example.com/x?q=${param.search}',
      { search: 'hello world & friends' },
      STORE,
      [],
    );
    expect(out).toBe('https://api.example.com/x?q=hello%20world%20%26%20friends');
  });

  it('substitutes ${credential.X} in headers (no URL encoding)', () => {
    const out = substituteString('Bearer ${credential.csrf_token}', {}, STORE, []);
    expect(out).toBe('Bearer tk_42');
  });

  it('substitutes ${response[N].path} from a prior response', () => {
    const responses = [{ booking: { id: 12345 } }];
    const out = substituteString(
      'https://api.example.com/cancel?id=${response[0].booking.id}',
      {},
      STORE,
      responses,
    );
    expect(out).toBe('https://api.example.com/cancel?id=12345');
  });

  it('throws on missing param', () => {
    expect(() => substituteString('${param.missing}', {}, STORE, [])).toThrow(/no param/i);
  });

  it('throws on missing credential', () => {
    expect(() => substituteString('${credential.absent}', {}, STORE, [])).toThrow(/credential/i);
  });

  it('throws when ${response[N]} refers to an out-of-bounds index', () => {
    expect(() => substituteString('${response[5].x}', {}, STORE, [{}])).toThrow(/responses/i);
  });

  it('handles array indexing in JSON paths', () => {
    const responses = [{ items: [{ id: 'a' }, { id: 'b' }] }];
    expect(substituteString('${response[0].items.1.id}', {}, STORE, responses)).toBe('b');
  });

  it('mixes param + credential + response in a single template', () => {
    const responses = [{ token: 'TOK' }];
    const out = substituteString(
      'https://x.test/?p=${param.foo}&c=${credential.patron_id}&t=${response[0].token}',
      { foo: 'bar' },
      STORE,
      responses,
    );
    expect(out).toBe('https://x.test/?p=bar&c=PATRON_xyz&t=TOK');
  });
});

describe('executeWorkflow', () => {
  const baseWorkflow: Workflow = {
    toolName: 'test_tool',
    intent: { description: 'test' },
    parameters: [{ name: 'q', type: 'string', description: 'query' }],
    requests: [
      {
        method: 'GET',
        url: 'https://api.example.com/search?q=${param.q}',
        headers: { Accept: 'application/json' },
      },
    ],
    site: 'test',
  };

  it('returns ok:true with the parsed JSON of the last response on success', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ results: [1, 2, 3] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'hello' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ results: [1, 2, 3] });
  });

  it('classifies 401 as AUTH_EXPIRED with a helpful remediation', async () => {
    const fetchMock = (async () =>
      new Response('session expired', { status: 401 })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('AUTH_EXPIRED');
    expect(r.message).toContain('session expired');
    expect(r.remediation).toMatch(/imprint login test/);
  });

  it('classifies 403 as FORBIDDEN (NOT AUTH_EXPIRED) with the body included', async () => {
    // Real-world: Southwest's Akamai returns 403 with a JSON code body
    // when bot detection fires. Telling the user "run imprint login" is
    // the wrong remediation; surface the body so they can diagnose.
    const fetchMock = (async () =>
      new Response('{"code":403050700}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toContain('403050700');
    expect(r.remediation).toMatch(/bot detection/i);
  });

  it('classifies 429 as RATE_LIMITED', async () => {
    const fetchMock = (async () =>
      new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('RATE_LIMITED');
  });

  it('classifies other 4xx as BAD_RESPONSE with the response body included', async () => {
    const fetchMock = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('BAD_RESPONSE');
    expect(r.message).toContain('404');
    expect(r.message).toContain('not found');
  });

  it('classifies thrown fetch errors as NETWORK', async () => {
    const fetchMock = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NETWORK');
  });

  it('returns UNKNOWN with the parameter name when a required param is missing', async () => {
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: {}, // missing q
      credentials: STORE,
      fetchImpl: (async () => new Response('')) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('UNKNOWN');
    expect(r.message).toContain('q');
  });

  it('fails loud when a workflow has zero requests (empty `requests` array)', async () => {
    const empty: Workflow = { ...baseWorkflow, requests: [] };
    const r = await executeWorkflow({
      workflow: empty,
      params: { q: 'x' },
      credentials: STORE,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('UNKNOWN');
    expect(r.message).toMatch(/no requests/);
    expect(r.remediation).toMatch(/re-record|re-run/);
  });

  it('chains responses: request 1 references ${response[0].field}', async () => {
    const chained: Workflow = {
      ...baseWorkflow,
      toolName: 'chain_tool',
      requests: [
        { method: 'GET', url: 'https://api.example.com/init', headers: {} },
        {
          method: 'POST',
          url: 'https://api.example.com/use?token=${response[0].token}',
          headers: {},
        },
      ],
    };
    const calls: string[] = [];
    const fetchMock = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/init')) {
        return new Response(JSON.stringify({ token: 'TOK_99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const r = await executeWorkflow({
      workflow: chained,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(calls[1]).toBe('https://api.example.com/use?token=TOK_99');
  });

  it('attaches the cookie header from the credential store on matching domains', async () => {
    const seen: { cookie: string | null } = { cookie: null };
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.cookie = headers?.cookie ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'x' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(seen.cookie).toBe('session=abc123');
  });

  it('URL-encodes credential values inside form-urlencoded request bodies', async () => {
    // Regression: a password containing "@" or "&" must reach the wire as
    // %40 / %26, not raw — otherwise the form pair structure breaks
    // (or, worse, the server rejects the unrequested encoding).
    const formWorkflow: Workflow = {
      toolName: 'login_test',
      intent: { description: 'login' },
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: 'https://example.com/api/login',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'username=${credential.username}&password=${credential.password}',
        },
      ],
      site: 'test',
    };
    const seen: { body: string | null } = { body: null };
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      seen.body = (init?.body as string | null) ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const creds: CredentialStore = {
      site: 'test',
      cookies: [],
      values: { username: 'alice', password: 'p@ss & word=1' },
    };

    await executeWorkflow({
      workflow: formWorkflow,
      params: {},
      credentials: creds,
      fetchImpl: fetchMock,
    });

    expect(seen.body).toBe('username=alice&password=p%40ss%20%26%20word%3D1');
  });
});

describe('splitSetCookieHeader', () => {
  it('returns the single cookie unchanged when only one is present', () => {
    expect(splitSetCookieHeader('sid=abc123; Path=/; HttpOnly')).toEqual([
      'sid=abc123; Path=/; HttpOnly',
    ]);
  });

  it('splits two cookies joined with `, `', () => {
    const joined = 'sid=abc; Path=/, theme=dark; Path=/';
    expect(splitSetCookieHeader(joined)).toEqual(['sid=abc; Path=/', 'theme=dark; Path=/']);
  });

  it('does NOT split inside an Expires date weekday-comma', () => {
    // Real-world case: `Set-Cookie: a=1; Expires=Wed, 30 Dec 2026 12:00:00 GMT, b=2; Path=/`.
    // The naive `split(',')` would produce 3 fragments and lose the cookie.
    const joined = 'a=1; Expires=Wed, 30 Dec 2026 12:00:00 GMT, b=2; Path=/';
    expect(splitSetCookieHeader(joined)).toEqual([
      'a=1; Expires=Wed, 30 Dec 2026 12:00:00 GMT',
      'b=2; Path=/',
    ]);
  });

  it('handles three cookies with mixed attributes', () => {
    const joined =
      'sid=abc; Path=/; Expires=Wed, 30 Dec 2026 12:00:00 GMT, csrf=xyz; Path=/, theme=dark';
    expect(splitSetCookieHeader(joined)).toEqual([
      'sid=abc; Path=/; Expires=Wed, 30 Dec 2026 12:00:00 GMT',
      'csrf=xyz; Path=/',
      'theme=dark',
    ]);
  });
});
