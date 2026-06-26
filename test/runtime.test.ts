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

  it('resolves ${generated.uuid} to a fresh UUID each call', () => {
    const a = substituteString('${generated.uuid}', {}, STORE, []);
    const b = substituteString('${generated.uuid}', {}, STORE, []);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });

  it('resolves each generated kind to its shape', () => {
    expect(substituteString('${generated.epoch_ms}', {}, STORE, [])).toMatch(/^\d{13}$/);
    expect(substituteString('${generated.epoch_s}', {}, STORE, [])).toMatch(/^\d{10}$/);
    expect(substituteString('${generated.iso8601}', {}, STORE, [])).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(substituteString('${generated.nonce}', {}, STORE, [])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints two distinct values for two ${generated.X} in one template', () => {
    const out = substituteString('${generated.uuid}|${generated.uuid}', {}, STORE, []);
    const [a, b] = out.split('|');
    expect(a).not.toBe(b);
  });

  it('throws on an unknown generated kind', () => {
    expect(() => substituteString('${generated.bogus}', {}, STORE, [])).toThrow(
      /unknown generated kind/i,
    );
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

  it('parses JSON body even when content-type is text/html', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ vehicles: [{ type: 'SUV', price: 45 }] }), {
        status: 200,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'test' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ vehicles: [{ type: 'SUV', price: 45 }] });
  });

  it('leaves non-JSON text/html responses as strings', async () => {
    const fetchMock = (async () =>
      new Response('<html><body>Hello</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: { q: 'test' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBe('<html><body>Hello</body></html>');
  });

  it('substitutes parameter.default when the caller omits the param', async () => {
    // Regression: runtime used to treat `default` as a presence-sentinel only.
    // `${param.q}` would still throw STATE_MISSING because the substitution
    // layer reads from the working params map directly. Defaults must merge
    // in so a sibling tool can call us with only its own params and let our
    // declared defaults fill in the rest.
    const workflowWithDefault: Workflow = {
      ...baseWorkflow,
      parameters: [{ name: 'q', type: 'string', description: 'query', default: 'fallback' }],
    };
    let observedUrl = '';
    const fetchMock = (async (input: string | URL | Request) => {
      observedUrl = typeof input === 'string' ? input : input.toString();
      return new Response('{"ok":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: workflowWithDefault,
      params: {},
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(observedUrl).toBe('https://api.example.com/search?q=fallback');
  });

  it('lets explicitly-passed params win over parameter.default', async () => {
    const workflowWithDefault: Workflow = {
      ...baseWorkflow,
      parameters: [{ name: 'q', type: 'string', description: 'query', default: 'fallback' }],
    };
    let observedUrl = '';
    const fetchMock = (async (input: string | URL | Request) => {
      observedUrl = typeof input === 'string' ? input : input.toString();
      return new Response('{"ok":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: workflowWithDefault,
      params: { q: 'explicit' },
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(true);
    expect(observedUrl).toBe('https://api.example.com/search?q=explicit');
  });

  it('still rejects a missing required param (no default declared)', async () => {
    // Regression guard for the validation path the default-injection edit
    // sits next to — make sure a required-with-no-default param still fails
    // loud rather than silently substituting empty.
    const fetchMock = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const r = await executeWorkflow({
      workflow: baseWorkflow,
      params: {},
      credentials: STORE,
      fetchImpl: fetchMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('Missing required parameter: q');
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

  it('captures a cookie from request A and projects it into request B without Chromium', async () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      toolName: 'cookie_capture',
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://api.example.com/bootstrap',
          headers: {},
          captures: [
            {
              name: 'csrf',
              source: 'cookie',
              cookie: 'XSRF-TOKEN',
              path: '/',
              required: true,
              capability: 'ordinary_http',
              allowHttpOnlyProjection: false,
            },
          ],
        },
        {
          method: 'POST',
          url: 'https://api.example.com/search',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': '${state.csrf}',
          },
          body: '{"csrf":"${state.csrf}"}',
        },
      ],
    };
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body as string | undefined,
      });
      if (url.endsWith('/bootstrap')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'XSRF-TOKEN=csrf123; Path=/; SameSite=Lax',
          },
        });
      }
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await executeWorkflow({
      workflow,
      params: {},
      credentials: STORE,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['X-CSRF-Token']).toBe('csrf123');
    expect(calls[1]?.body).toBe('{"csrf":"csrf123"}');
  });

  it('returns STATE_MISSING for ambiguous direct cookie placeholders', async () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://api.example.com/app/search',
          headers: { 'X-Session': '${cookie.sid}' },
        },
      ],
    };
    const result = await executeWorkflow({
      workflow,
      params: {},
      credentials: {
        site: 'test',
        values: {},
        cookies: [
          { name: 'sid', value: 'root', domain: 'api.example.com', path: '/', hostOnly: true },
          { name: 'sid', value: 'app', domain: 'api.example.com', path: '/app', hostOnly: true },
        ],
      },
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('STATE_MISSING');
    expect(result.missing?.[0]?.failure).toBe('ambiguous_cookie');
  });

  it('preflights missing state before an earlier unsafe request can run', async () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      parameters: [],
      requests: [
        {
          method: 'POST',
          effect: 'unsafe',
          url: 'https://api.example.com/charge',
          headers: {},
        },
        {
          method: 'POST',
          url: 'https://api.example.com/use',
          headers: { 'X-CSRF-Token': '${state.csrf}' },
        },
      ],
    };
    let fetchCount = 0;
    const result = await executeWorkflow({
      workflow,
      params: {},
      credentials: STORE,
      fetchImpl: (async () => {
        fetchCount++;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    expect(fetchCount).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('STATE_MISSING');
    expect(result.message).toMatch(/unsafe request/);
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

describe('requestTransformModule', () => {
  const scratchRoot = `${import.meta.dir}/../.context`;

  const transformWorkflow: Workflow = {
    toolName: 'test_transform',
    intent: { description: 'test' },
    parameters: [
      { name: 'q', type: 'string', description: 'query' },
      { name: 'filter', type: 'string', description: 'filter value' },
    ],
    requests: [
      {
        method: 'POST',
        url: 'https://api.example.com/search',
        headers: { 'Content-Type': 'application/json' },
        body: '{"placeholder": true}',
      },
    ],
    site: 'test',
    requestTransformModule: './request-transform.ts',
  };

  it('passes params to transform and applies object return with body override', async () => {
    const fetchMock = (async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ body: init?.body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(scratchRoot, { recursive: true });
    const tmpDir = mkdtempSync(join(scratchRoot, 'rt-transform-'));
    try {
      writeFileSync(join(tmpDir, 'workflow.json'), JSON.stringify(transformWorkflow));
      writeFileSync(
        join(tmpDir, 'request-transform.ts'),
        `export function transform(method, url, responses, params) {
          return { url, body: JSON.stringify({ q: params?.q, filter: params?.filter }) };
        }`,
      );

      const r = await executeWorkflow({
        workflow: transformWorkflow,
        params: { q: 'hello', filter: 'price<100' },
        fetchImpl: fetchMock,
        workflowPath: join(tmpDir, 'workflow.json'),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { body: string };
      const parsed = JSON.parse(data.body);
      expect(parsed.q).toBe('hello');
      expect(parsed.filter).toBe('price<100');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('backward-compatible: string return still works as URL-only transform', async () => {
    let capturedUrl = '';
    const fetchMock = (async (url: string) => {
      capturedUrl = url;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(scratchRoot, { recursive: true });
    const tmpDir = mkdtempSync(join(scratchRoot, 'rt-transform-str-'));
    try {
      writeFileSync(join(tmpDir, 'workflow.json'), JSON.stringify(transformWorkflow));
      writeFileSync(
        join(tmpDir, 'request-transform.ts'),
        `export function transform(method, url) {
          return url + '?signed=true';
        }`,
      );

      const r = await executeWorkflow({
        workflow: transformWorkflow,
        params: { q: 'test', filter: 'none' },
        fetchImpl: fetchMock,
        workflowPath: join(tmpDir, 'workflow.json'),
      });
      expect(r.ok).toBe(true);
      expect(capturedUrl).toBe('https://api.example.com/search?signed=true');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies header overrides from object return', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).filter(([k]) => k.startsWith('X-')),
      );
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(scratchRoot, { recursive: true });
    const tmpDir = mkdtempSync(join(scratchRoot, 'rt-transform-hdr-'));
    try {
      writeFileSync(join(tmpDir, 'workflow.json'), JSON.stringify(transformWorkflow));
      writeFileSync(
        join(tmpDir, 'request-transform.ts'),
        `export function transform(method, url, responses, params) {
          return { url, headers: { 'X-Custom': 'injected-' + (params?.q ?? '') } };
        }`,
      );

      const r = await executeWorkflow({
        workflow: transformWorkflow,
        params: { q: 'test', filter: 'none' },
        fetchImpl: fetchMock,
        workflowPath: join(tmpDir, 'workflow.json'),
      });
      expect(r.ok).toBe(true);
      expect(capturedHeaders['X-Custom']).toBe('injected-test');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
