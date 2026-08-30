import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { renderWorkflowRequests } from '../src/imprint/backend-ladder.ts';
import {
  type CookieRecord,
  type CredentialBackend,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import {
  type BrowserNavigationTransport,
  type CredentialStore,
  executeWorkflow,
} from '../src/imprint/runtime.ts';
import { type Workflow, WorkflowSchema } from '../src/imprint/types.ts';

function memoryBackend(): CredentialBackend {
  const cookies = new Map<string, CookieRecord[]>();
  const secrets = new Map<string, Map<string, string>>();
  const values = (site: string) => {
    let siteValues = secrets.get(site);
    if (!siteValues) {
      siteValues = new Map();
      secrets.set(site, siteValues);
    }
    return siteValues;
  };
  return {
    id: 'encrypted-file',
    async getSecret(site, name) {
      return values(site).get(name) ?? null;
    },
    async setSecret(site, name, value) {
      values(site).set(name, value);
    },
    async deleteSecret(site, name) {
      values(site).delete(name);
    },
    async listSecrets(site) {
      return [...values(site).keys()];
    },
    async getCookies(site) {
      return cookies.get(site) ?? [];
    },
    async setCookies(site, next) {
      cookies.set(site, next);
    },
    async listSites() {
      return [...new Set([...cookies.keys(), ...secrets.keys()])];
    },
  };
}

const credentials: CredentialStore = {
  site: 'fixture-auth',
  cookies: [],
  values: { username: 'fixture-user', password: 'fixture-pass' },
};

let backend: CredentialBackend;

function workflow(input: {
  parameters?: unknown[];
  requests: unknown[];
  authConfig: { entry: string; actions: Record<string, unknown>; [key: string]: unknown };
}): Workflow {
  return WorkflowSchema.parse({
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    intent: { description: 'Authenticate from a synthetic recording' },
    site: 'fixture-auth',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action selected from the compiled auth program',
        default: input.authConfig.entry,
        choices: Object.keys(input.authConfig.actions),
      },
      ...(input.parameters ?? []),
    ],
    requests: input.requests,
    authConfig: input.authConfig,
  });
}

beforeEach(() => {
  backend = memoryBackend();
  setBackendOverride(backend);
});
afterEach(() => {
  setBackendOverride(null);
  resetBackendCache();
});

describe('auth action runtime', () => {
  it('does not send an auth request when its declared transform is unavailable', async () => {
    const wf = {
      ...workflow({
        requests: [{ method: 'POST', url: 'https://fixture.test/login', headers: {} }],
        authConfig: {
          entry: 'login',
          actions: {
            login: {
              steps: [{ request: 0 }],
              outcome: {
                type: 'pause',
                next: 'login',
                evidence: [],
                carry: [],
                message: 'Continue login.',
              },
            },
          },
        },
      }),
      requestTransformModule: './missing-transform.ts',
    };
    let sends = 0;
    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      workflowPath: '/tmp/imprint-auth-transform-fixture/workflow.json',
      fetchImpl: (async () => {
        sends++;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });

    expect(sends).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      error: 'BAD_RESPONSE',
      requestStageFacts: [{ requestIndex: 0, stage: 'transform', outcome: 'unavailable' }],
    });
  });

  it('offline request rendering never persists auth cookies or secrets', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'POST',
          url: 'https://fixture.test/login',
          headers: {},
          captures: [{ source: 'json', name: 'compiled_capture', path: 'value' }],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['compiled_capture'] },
          },
        },
        persist: ['durable_interface'],
        persistBindings: { durable_interface: 'compiled_capture' },
      },
    });

    const rendered = await renderWorkflowRequests({
      workflow: wf,
      params: {},
      credentials,
      recordedResponseFor: () => ({
        status: 200,
        body: '{"value":"must-not-persist"}',
        headers: { 'set-cookie': 'sid=must-not-persist; Path=/; Secure' },
      }),
    });

    expect(rendered.result).toEqual({ ok: true, data: { authenticated: true } });
    expect(await backend.getSecret('fixture-auth', 'durable_interface')).toBeNull();
    expect(await backend.getCookies('fixture-auth')).toEqual([]);
  });

  it('offline request rendering does not load current stored credentials implicitly', async () => {
    await backend.setSecret('fixture-data', 'api_token', 'current-machine-token');
    const wf = WorkflowSchema.parse({
      toolName: 'credentialed_fixture',
      intent: { description: 'Read fixture data' },
      site: 'fixture-data',
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/data',
          headers: { authorization: 'Bearer ${credential.api_token}' },
        },
      ],
    });

    const rendered = await renderWorkflowRequests({ workflow: wf, params: {} });

    expect(rendered.requests).toEqual([]);
    expect(rendered.result).toMatchObject({ ok: false, error: 'STATE_MISSING' });
  });

  it('executes arbitrary actions and carries only the state declared by the artifact', async () => {
    const seenBodies: string[] = [];
    const wf = workflow({
      parameters: [{ name: 'answer', type: 'string', description: 'Live answer' }],
      requests: [
        {
          method: 'POST',
          url: 'https://fixture.test/start',
          headers: {},
          captures: [
            { source: 'json', name: 'ticket', path: 'ticket' },
            { source: 'json', name: 'notCarried', path: 'private' },
          ],
        },
        {
          method: 'POST',
          url: 'https://fixture.test/finish',
          headers: { 'content-type': 'application/json' },
          body: '{"ticket":"${state.ticket}","answer":"${param.answer}"}',
          captures: [
            { source: 'json', name: 'authenticated', path: 'authenticated', equals: true },
          ],
        },
      ],
      authConfig: {
        entry: 'open_gate',
        actions: {
          open_gate: {
            steps: [{ request: 0 }],
            outcome: {
              type: 'pause',
              next: 'close_gate',
              evidence: ['ticket'],
              carry: ['ticket'],
              message: 'External confirmation is required.',
            },
          },
          close_gate: {
            parameters: ['answer'],
            steps: [{ request: 1 }],
            outcome: { type: 'success', evidence: ['authenticated'] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) seenBodies.push(String(init.body));
      return seenBodies.length === 0
        ? new Response('{"ticket":"fixture-ticket","private":"do-not-carry"}')
        : new Response('{"authenticated":true}');
    }) as typeof fetch;

    const first = await executeWorkflow({
      workflow: wf,
      params: { action: 'open_gate' },
      credentials,
      fetchImpl,
    });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('expected pause');
    expect(first.error).toBe('ACTION_REQUIRED');
    expect(first.nextAction).toBe('close_gate');
    expect(first.continuation).toEqual({ ticket: 'fixture-ticket' });

    const second = await executeWorkflow({
      workflow: wf,
      params: { action: 'close_gate', answer: 'fixture-answer' },
      credentials,
      fetchImpl,
      initialState: first.continuation,
    });
    expect(second).toEqual({ ok: true, data: { authenticated: true } });
    expect(seenBodies).toEqual(['{"ticket":"fixture-ticket","answer":"fixture-answer"}']);
  });

  it('fails when a pause omits state the artifact declared as carry', async () => {
    const wf = workflow({
      requests: [{ method: 'GET', url: 'https://fixture.test/start', headers: {} }],
      authConfig: {
        entry: 'start',
        actions: {
          start: {
            steps: [{ request: 0 }],
            outcome: {
              type: 'pause',
              next: 'finish',
              carry: ['missingTicket'],
              message: 'Continue.',
            },
          },
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success' },
          },
        },
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    if (!result.ok) expect(result.message).toContain('missingTicket');
  });

  it('fails when success omits state the artifact declared as persistent', async () => {
    const wf = workflow({
      requests: [{ method: 'GET', url: 'https://fixture.test/finish', headers: {} }],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success' },
          },
        },
        persist: ['missingToken'],
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    if (!result.ok) expect(result.message).toContain('missingToken');
  });

  it('does not persist response cookies when declared success evidence is missing', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/finish',
          headers: {},
          captures: [
            { source: 'json', name: 'authenticated', path: 'authenticated', equals: true },
          ],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['authenticated'] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response('{"authenticated":false}', {
          headers: { 'set-cookie': 'sid=unverified; Path=/; Secure' },
        })) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, error: 'STATE_MISSING' });
    expect(await backend.getCookies('fixture-auth')).toEqual([]);
  });

  it('persists cookies after a valid pause so the 2FA action can continue', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/start',
          headers: {},
          captures: [{ source: 'json', name: 'ticket', path: 'ticket' }],
        },
      ],
      authConfig: {
        entry: 'start',
        actions: {
          start: {
            steps: [{ request: 0 }],
            outcome: {
              type: 'pause',
              next: 'finish',
              evidence: ['ticket'],
              carry: ['ticket'],
              message: 'Enter the code.',
            },
          },
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success' },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response('{"ticket":"ticket-1"}', {
          headers: { 'set-cookie': 'challenge=active; Path=/; Secure' },
        })) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, error: 'ACTION_REQUIRED' });
    expect(await backend.getCookies('fixture-auth')).toMatchObject([
      { name: 'challenge', value: 'active' },
    ]);
  });

  it('preserves the 2FA continuation only when a browser session is retained', async () => {
    const failingBackend = memoryBackend();
    failingBackend.setCookies = async () => {
      throw new Error('fixture cookie write failed');
    };
    backend = failingBackend;
    setBackendOverride(failingBackend);
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/start',
          headers: {},
          captures: [{ source: 'json', name: 'ticket', path: 'ticket' }],
        },
      ],
      authConfig: {
        entry: 'start',
        actions: {
          start: {
            steps: [{ request: 0 }],
            outcome: {
              type: 'pause',
              next: 'finish',
              evidence: ['ticket'],
              carry: ['ticket'],
              message: 'Enter the code.',
            },
          },
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success' },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const withoutBrowser = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () => new Response('{"ticket":"ticket-1"}')) as unknown as typeof fetch,
    });

    expect(withoutBrowser).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    if (!withoutBrowser.ok) expect(withoutBrowser.message).toContain('fixture cookie write failed');

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      browser: {
        async navigate() {
          throw new Error('not used by this workflow');
        },
        async snapshotCookies() {
          return [];
        },
      },
      fetchImpl: (async () => new Response('{"ticket":"ticket-1"}')) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'ACTION_REQUIRED',
      nextAction: 'finish',
      continuation: { ticket: 'ticket-1' },
    });
    if (!result.ok) expect(result.message).toContain('fixture cookie write failed');
  });

  it('fails authentication when a required captured secret cannot be persisted', async () => {
    const failingBackend = memoryBackend();
    failingBackend.setSecret = async () => {
      throw new Error('fixture write failed');
    };
    backend = failingBackend;
    setBackendOverride(failingBackend);
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/finish',
          headers: {},
          captures: [{ source: 'json', name: 'access_token', path: 'access_token' }],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['access_token'] },
          },
        },
        persist: ['access_token'],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response('{"access_token":"fixture-token"}', {
          headers: { 'set-cookie': 'sid=verified; Path=/; Secure' },
        })) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    if (!result.ok) expect(result.message).toContain('fixture write failed');
    expect(await backend.getCookies('fixture-auth')).toEqual([]);
  });

  it('persists a renamed capture under its durable credential interface', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/finish',
          headers: {},
          captures: [{ source: 'json', name: 'compiled_capture', path: 'value' }],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['compiled_capture'] },
          },
        },
        persist: ['durable_interface'],
        persistBindings: { durable_interface: 'compiled_capture' },
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response('{"value":"resolved-value"}')) as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, data: { authenticated: true } });
    expect(await backend.getSecret('fixture-auth', 'durable_interface')).toBe('resolved-value');
  });

  it('persists a JSON-string capture after decoding its nested path once', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/finish',
          headers: {},
          captures: [
            {
              source: 'json',
              name: 'nested_token',
              path: '$.payload',
              decodeJsonPath: '$.session.token',
            },
          ],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['nested_token'] },
          },
        },
        persist: ['nested_token'],
      },
    });
    const token = 'fixture/segment+token=';
    const encodedEnvelope = `{"session":{"token":"fixture\\/segment+token="}}`;

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ payload: encodedEnvelope }))) as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, data: { authenticated: true } });
    expect(await backend.getSecret('fixture-auth', 'nested_token')).toBe(token);
  });

  it('rolls back cookies and earlier secrets when a later secret write fails', async () => {
    const failingBackend = memoryBackend();
    await failingBackend.setCookies('fixture-auth', [
      { name: 'sid', value: 'old-cookie', domain: 'fixture.test', path: '/' },
    ]);
    await failingBackend.setSecret('fixture-auth', 'first_token', 'old-first');
    await failingBackend.setSecret('fixture-auth', 'second_token', 'old-second');
    const writeSecret = failingBackend.setSecret.bind(failingBackend);
    let shouldFail = true;
    failingBackend.setSecret = async (site, name, value) => {
      if (name === 'second_token' && shouldFail) {
        shouldFail = false;
        throw new Error('second secret failed');
      }
      await writeSecret(site, name, value);
    };
    backend = failingBackend;
    setBackendOverride(failingBackend);
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/finish',
          headers: {},
          captures: [
            { source: 'json', name: 'first_token', path: 'first' },
            { source: 'json', name: 'second_token', path: 'second' },
          ],
        },
      ],
      authConfig: {
        entry: 'finish',
        actions: {
          finish: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['first_token', 'second_token'] },
          },
        },
        persist: ['first_token', 'second_token'],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        new Response('{"first":"new-first","second":"new-second"}', {
          headers: { 'set-cookie': 'sid=new-cookie; Path=/; Secure' },
        })) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, error: 'BAD_RESPONSE' });
    expect(await backend.getSecret('fixture-auth', 'first_token')).toBe('old-first');
    expect(await backend.getSecret('fixture-auth', 'second_token')).toBe('old-second');
    expect(await backend.getCookies('fixture-auth')).toEqual([
      { name: 'sid', value: 'old-cookie', domain: 'fixture.test', path: '/' },
    ]);
  });

  it('keeps HTTP status classification when an auth error body cannot be read', async () => {
    const wf = workflow({
      requests: [{ method: 'GET', url: 'https://fixture.test/login', headers: {} }],
      authConfig: {
        entry: 'login',
        actions: { login: { steps: [{ request: 0 }], outcome: { type: 'success' } } },
      },
    });
    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () =>
        ({
          status: 401,
          headers: new Headers(),
          async text() {
            throw new Error('body stream reset');
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, error: 'AUTH_EXPIRED', status: 401 });
  });

  it('repeats a request until an exact empty scalar is observed', async () => {
    let calls = 0;
    const wf = workflow({
      requests: [{ method: 'GET', url: 'https://fixture.test/status', headers: {} }],
      authConfig: {
        entry: 'observe',
        actions: {
          observe: {
            steps: [
              {
                request: 0,
                repeat: {
                  until: { source: 'json', name: 'status', path: 'status', equals: '' },
                  intervalMs: 0,
                  maxAttempts: 3,
                },
              },
            ],
            outcome: { type: 'success', evidence: ['status'] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: { action: 'observe' },
      credentials,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ status: calls === 3 ? '' : 'waiting' }));
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('uses artifact-declared retry behavior for request errors', async () => {
    let calls = 0;
    const wf = workflow({
      requests: [{ method: 'GET', url: 'https://fixture.test/retry', headers: {} }],
      authConfig: {
        entry: 'retry_observation',
        actions: {
          retry_observation: {
            steps: [
              {
                request: 0,
                onError: 'retry',
                repeat: {
                  until: { source: 'json', name: 'ready', path: 'ready', equals: false },
                  intervalMs: 0,
                  maxAttempts: 2,
                },
              },
            ],
            outcome: { type: 'success', evidence: ['ready'] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      fetchImpl: (async () => {
        calls++;
        return calls === 1
          ? new Response('temporary', { status: 503 })
          : new Response('{"ready":false}');
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not expose captures produced before a failed action outcome', async () => {
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/first',
          headers: {},
          captures: [{ source: 'json', name: 'privateTicket', path: 'ticket' }],
        },
        { method: 'GET', url: 'https://fixture.test/second', headers: {} },
      ],
      authConfig: {
        entry: 'run',
        actions: {
          run: {
            steps: [{ request: 0 }, { request: 1 }],
            outcome: { type: 'success' },
          },
        },
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      initialState: { declaredPriorState: 'fixture-prior' },
      fetchImpl: (async (url: string | URL | Request) =>
        String(url).includes('/first')
          ? new Response('{"ticket":"private-ticket"}')
          : new Response('failure', { status: 503 })) as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.continuation).toEqual({ declaredPriorState: 'fixture-prior' });
  });

  it('runs a recording-declared top-level navigation', async () => {
    const navigations: Array<{ url: string; options: unknown }> = [];
    const browser: BrowserNavigationTransport = {
      async navigate(url, options) {
        navigations.push({ url, options });
        return new Response('{"arrived":true}');
      },
      async snapshotCookies() {
        return [];
      },
    };
    const wf = workflow({
      requests: [
        {
          method: 'GET',
          url: 'https://fixture.test/document',
          headers: {},
          mode: 'navigate',
          navigation: { urlIncludes: '/complete' },
          captures: [{ source: 'json', name: 'arrived', path: 'arrived', equals: true }],
        },
      ],
      authConfig: {
        entry: 'navigate_document',
        actions: {
          navigate_document: {
            steps: [{ request: 0 }],
            outcome: { type: 'success', evidence: ['arrived'] },
          },
        },
        persist: [],
        crossOriginCookieReinjection: false,
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials,
      browser,
      fetchImpl: (async () => {
        throw new Error('fetch should not run');
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(navigations).toEqual([
      {
        url: 'https://fixture.test/document',
        options: {
          method: 'GET',
          headers: {},
          body: undefined,
          urlIncludes: '/complete',
        },
      },
    ]);
  });

  it('passes a transformed URL-encoded POST to top-level navigation', async () => {
    const navigations: Array<{ url: string; options: unknown }> = [];
    const wf = workflow({
      requests: [
        {
          method: 'POST',
          url: 'https://fixture.test/login',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'username=${credential.username}&state=fresh',
          mode: 'navigate',
          navigation: { urlIncludes: '/password' },
        },
      ],
      authConfig: {
        entry: 'submit_identifier',
        actions: {
          submit_identifier: {
            steps: [{ request: 0 }],
            outcome: { type: 'success' },
          },
        },
      },
    });

    const result = await executeWorkflow({
      workflow: wf,
      params: {},
      credentials: { ...credentials, values: { username: 'person@example.test' } },
      browser: {
        async navigate(url, options) {
          navigations.push({ url, options });
          return new Response('{}');
        },
        async snapshotCookies() {
          return [];
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(navigations).toEqual([
      {
        url: 'https://fixture.test/login',
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'username=person%40example.test&state=fresh',
          urlIncludes: '/password',
        },
      },
    ]);
  });
});
