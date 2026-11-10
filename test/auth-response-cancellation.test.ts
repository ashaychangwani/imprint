import { afterEach, describe, expect, it } from 'bun:test';
import {
  type CookieRecord,
  type CredentialBackend,
  resetBackendCache,
  setBackendOverride,
} from '../src/imprint/credential-store.ts';
import { executeWorkflow } from '../src/imprint/runtime.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const oldCookie: CookieRecord = {
  name: 'session',
  value: 'fixture-old-cookie',
  domain: 'fixture.invalid',
  path: '/',
  secure: true,
};
const credentials = {
  site: 'fixture-auth-cancellation',
  cookies: [oldCookie],
  values: { token: 'fixture-old-token' },
};

function memoryBackend(
  hooks: {
    beforeCookies?: (cookies: CookieRecord[]) => Promise<void>;
    beforeSecret?: (name: string, value: string) => Promise<void>;
  } = {},
) {
  let cookies = structuredClone([oldCookie]);
  const secrets = new Map([['token', 'fixture-old-token']]);
  let writes = 0;
  const backend: CredentialBackend = {
    id: 'encrypted-file',
    getCookies: async () => structuredClone(cookies),
    setCookies: async (_site, next) => {
      writes += 1;
      await hooks.beforeCookies?.(next);
      cookies = structuredClone(next);
    },
    getSecret: async (_site, name) => secrets.get(name) ?? null,
    setSecret: async (_site, name, value) => {
      writes += 1;
      await hooks.beforeSecret?.(name, value);
      secrets.set(name, value);
    },
    deleteSecret: async (_site, name) => {
      secrets.delete(name);
    },
    listSecrets: async () => [...secrets.keys()],
    listSites: async () => [credentials.site],
  };
  setBackendOverride(backend);
  return { backend, writes: () => writes };
}

function workflow(outcome: 'pause' | 'success') {
  return WorkflowSchema.parse({
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    site: credentials.site,
    intent: { description: 'Synthetic cancellable authentication' },
    parameters: [{ name: 'action', type: 'string', description: 'Action', default: 'run' }],
    requests: [
      {
        method: 'POST',
        url: 'https://fixture.invalid/run',
        headers: {},
        captures: [
          { name: 'ticket', source: 'json', path: 'ticket' },
          { name: 'token', source: 'json', path: 'token' },
        ],
      },
    ],
    authConfig: {
      entry: 'run',
      persist: ['token'],
      actions: {
        run: {
          steps: [{ request: 0, onError: 'continue' }],
          outcome:
            outcome === 'pause'
              ? {
                  type: 'pause',
                  next: 'finish',
                  evidence: ['ticket'],
                  carry: ['ticket'],
                  message: 'Continue',
                }
              : { type: 'success', evidence: ['token'] },
        },
        finish: { steps: [{ request: 0 }], outcome: { type: 'success', evidence: ['token'] } },
      },
    },
  });
}

function response() {
  return Response.json(
    { ticket: 'fixture-ticket', token: 'fixture-new-token' },
    {
      headers: { 'set-cookie': 'session=fixture-new-cookie; Path=/; Secure' },
    },
  );
}

afterEach(() => {
  setBackendOverride(null);
  resetBackendCache();
});

describe('authentication response and persistence cancellation', () => {
  it('reports a local transport rejection as invocation without claiming HTTP dispatch', async () => {
    const authored = workflow('success');
    const step = authored.authConfig?.actions.run?.steps[0];
    if (!step) throw new Error('Missing synthetic action');
    step.onError = 'fail';
    const result = await executeWorkflow({
      workflow: authored,
      credentials,
      params: {},
      fetchImpl: (async (
        _input: Parameters<typeof fetch>[0],
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new TypeError('Fixture local URL validation rejected');
      }) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'NETWORK',
      authExecution: { transportInvoked: true, responseReceived: false, phase: 'send' },
    });
    expect(JSON.stringify(result)).not.toContain('httpSent');
    if (!result.ok) expect(result.authExecution?.httpStatus).toBeUndefined();
  });

  for (const outcome of ['pause', 'success'] as const) {
    it(`keeps caller cancellation attached through the ${outcome} response body`, async () => {
      const store = memoryBackend();
      const abort = new AbortController();
      const reading = deferred();
      let transportSignal: AbortSignal | undefined;
      let authSnapshots = 0;
      const executing = executeWorkflow({
        workflow: workflow(outcome),
        credentials,
        params: {},
        signal: abort.signal,
        onAuthState: () => {
          authSnapshots += 1;
        },
        fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          transportSignal = init?.signal ?? undefined;
          const observed = response();
          Object.defineProperty(observed, 'text', {
            value: async () =>
              await new Promise<string>((_resolve, reject) => {
                transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), {
                  once: true,
                });
                reading.resolve();
              }),
          });
          return observed;
        }) as typeof fetch,
      });
      await reading.promise;
      abort.abort(new Error('Fixture caller cancelled during response body'));
      expect(await executing).toMatchObject({
        ok: false,
        error: 'NETWORK',
        authExecution: { transportInvoked: true, responseReceived: true, httpStatus: 200 },
      });
      expect(transportSignal?.aborted).toBe(true);
      expect(store.writes()).toBe(0);
      expect(authSnapshots).toBe(0);
    });

    it(`rejects a late ${outcome} body after cancellation without writing or returning continuation`, async () => {
      const store = memoryBackend();
      const abort = new AbortController();
      const reading = deferred();
      const release = deferred();
      let observations = 0;
      const executing = executeWorkflow({
        workflow: workflow(outcome),
        credentials,
        params: {},
        signal: abort.signal,
        onAuthState: () => {
          observations += 1;
        },
        fetchImpl: (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
          const observed = response();
          Object.defineProperty(observed, 'text', {
            value: async () => {
              reading.resolve();
              await release.promise; // A transport/body reader that settles after cancellation.
              return '{"ticket":"fixture-ticket","token":"fixture-new-token"}';
            },
          });
          return observed;
        }) as typeof fetch,
      });
      await reading.promise;
      abort.abort(new Error('Fixture caller cancelled before late body'));
      release.resolve();
      const result = await executing;
      expect(result).toMatchObject({ ok: false, error: 'NETWORK' });
      if (!result.ok) {
        expect(result.nextAction).toBeUndefined();
        expect(result.continuation).toBeUndefined();
      }
      expect(store.writes()).toBe(0);
      expect(observations).toBe(0);
    });
  }

  it('rolls back a pause cookie write that settles after cancellation', async () => {
    const writing = deferred();
    const release = deferred();
    const store = memoryBackend({
      beforeCookies: async (next) => {
        if (next.some(({ value }) => value === 'fixture-new-cookie')) {
          writing.resolve();
          await release.promise;
        }
      },
    });
    const abort = new AbortController();
    let observations = 0;
    const executing = executeWorkflow({
      workflow: workflow('pause'),
      credentials,
      params: {},
      signal: abort.signal,
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        response()) as typeof fetch,
      onAuthState: () => {
        observations += 1;
      },
    });
    await writing.promise;
    abort.abort(new Error('Fixture pause write cancelled'));
    release.resolve();
    const result = await executing;
    expect(result).toMatchObject({ ok: false, error: 'NETWORK' });
    if (!result.ok) expect(result.nextAction).toBeUndefined();
    expect(await store.backend.getCookies(credentials.site)).toEqual([oldCookie]);
    expect(observations).toBe(0);
  });

  it('rolls back cookies and the final secret write when cancellation happens during commit', async () => {
    const writing = deferred();
    const release = deferred();
    const store = memoryBackend({
      beforeSecret: async (_name, value) => {
        if (value === 'fixture-new-token') {
          writing.resolve();
          await release.promise;
        }
      },
    });
    const abort = new AbortController();
    let observations = 0;
    const executing = executeWorkflow({
      workflow: workflow('success'),
      credentials,
      params: {},
      signal: abort.signal,
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        response()) as typeof fetch,
      onAuthState: () => {
        observations += 1;
      },
    });
    await writing.promise;
    abort.abort(new Error('Fixture final secret write cancelled'));
    release.resolve();
    expect(await executing).toMatchObject({ ok: false, error: 'NETWORK' });
    expect(await store.backend.getCookies(credentials.site)).toEqual([oldCookie]);
    expect(await store.backend.getSecret(credentials.site, 'token')).toBe('fixture-old-token');
    expect(observations).toBe(0);
  });
});
