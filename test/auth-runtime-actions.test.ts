import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

beforeEach(() => setBackendOverride(memoryBackend()));
afterEach(() => {
  setBackendOverride(null);
  resetBackendCache();
});

describe('auth action runtime', () => {
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
    const navigations: string[] = [];
    const browser: BrowserNavigationTransport = {
      async navigate(url) {
        navigations.push(url);
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
    expect(navigations).toEqual(['https://fixture.test/document']);
  });
});
