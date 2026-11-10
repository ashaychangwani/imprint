import { afterEach, describe, expect, it } from 'bun:test';
import { AuthVerifier, __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { ToolResult } from '../src/imprint/types.ts';

type Runner = NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>;
type RunnerArgs = Parameters<Runner>[0];

const credentials = {
  site: 'fixture-site',
  cookies: [
    {
      name: 'session',
      value: 'fixture-cookie-secret',
      domain: '.fixture.test',
      path: '/',
    },
  ],
  values: { username: 'person+auth@example.com', password: 'fixture pass/word' },
  storage: [
    {
      origin: 'https://fixture.test',
      kind: 'localStorage' as const,
      key: 'device',
      value: 'fixture-storage-secret',
    },
  ],
};

function fakeRunner(
  results: ToolResult[],
  calls: Array<{
    params: Record<string, string | number | boolean>;
    initialState?: Record<string, unknown>;
    forceBackend?: string;
  }>,
): Runner {
  let index = 0;
  return (async (args: RunnerArgs) => {
    calls.push({
      params: args.params,
      initialState: args.initialState,
      forceBackend: args.forceBackend,
    });
    const result = results[Math.min(index++, results.length - 1)];
    if (!result) throw new Error('missing fixture result');
    return { result, usedBackend: args.forceBackend ?? 'fetch', attempts: [] };
  }) as Runner;
}

afterEach(() => __setAuthVerifierLadderForTest(null));

describe('AuthVerifier', () => {
  it('keeps discovery in the active browser and continuation, resolves credentials locally, and masks OTPs before returning evidence', async () => {
    const inputs: unknown[] = [];
    const states: unknown[] = [];
    let closed = 0;
    const browser = {
      close: async () => {
        closed++;
      },
      interactBrowser: async (action: unknown) => {
        inputs.push(action);
        return {
          sourceId: 'fixture-discovery-source',
          page: {
            url: 'https://fixture.test/otp',
            title: 'Verify',
            bodyText: 'fixture-otp-987654',
            controls: [],
            controlsTruncated: false,
          },
          requests: [
            {
              seq: 0,
              timestamp: 0,
              method: 'POST',
              url: 'https://fixture.test/unrecorded',
              resourceType: 'Fetch',
              headers: {},
              body: 'password=fixture+pass%2Fword&code=fixture-otp-987654',
              response: { status: 200, headers: {}, body: '{"ready":true}' },
            },
          ],
          captureErrors: [],
        };
      },
    };
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      states.push(args.initialState);
      args.cdpPool?.set('fixture', browser as never);
      return {
        result: {
          ok: false,
          error: 'ACTION_REQUIRED',
          message: 'Verify',
          nextAction: 'finish',
          continuation: { ticket: 'fixture-ticket' },
        },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    try {
      await verifier.runAction('begin');
      await verifier.interactBrowser({
        action: 'fill',
        selector: '#password',
        value: '${credential.password}',
      });
      const observation = await verifier.interactBrowser({
        action: 'fill',
        selector: '#otp',
        value: 'fixture-otp-987654',
      });
      expect(inputs).toEqual([
        { action: 'fill', selector: '#password', value: 'fixture pass/word' },
        { action: 'fill', selector: '#otp', value: 'fixture-otp-987654' },
      ]);
      expect(JSON.stringify(observation)).not.toContain('fixture-otp-987654');
      expect(observation.requests[0]?.body).toContain('${credential.password}');
      expect(observation.page.bodyText).toBe('[REDACTED]');
      await verifier.runAction('finish');
      expect(states).toEqual([undefined, { ticket: 'fixture-ticket' }]);
      expect(closed).toBe(0);
    } finally {
      await verifier.drain();
    }
    expect(closed).toBe(1);
  });

  it('masks known secrets in added response metadata as well as messages', async () => {
    const otp = 'fixture-secret-otp-731';
    __setAuthVerifierLadderForTest((async () => ({
      result: { ok: false, error: 'BAD_RESPONSE', message: 'Synthetic rejection' },
      usedBackend: 'cdp-replay',
      attempts: [],
      responseObservations: [
        {
          backend: 'cdp-replay',
          requestIndex: 0,
          status: 400,
          bodyByteLength: 0,
          valueType: 'object',
          redactedBodyPreview: otp,
          contentType: `application/${otp}`,
          topLevelKeys: [credentials.values.username, otp, 'ordinary'],
        },
      ],
    })) as Runner);
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    try {
      const result = await verifier.runAction('fixture-action', { code: otp });
      const output = JSON.stringify(result);
      expect(output).not.toContain(otp);
      expect(output).not.toContain(credentials.values.username);
      expect(result.responseObservations?.[0]?.topLevelKeys).toContain('ordinary');
    } finally {
      await verifier.drain();
    }
  });

  it('inspects the existing page without losing continuation and redacts secrets', async () => {
    const initialStates: Array<Record<string, unknown> | undefined> = [];
    let call = 0;
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      initialStates.push(args.initialState);
      if (call++ === 0) {
        args.cdpPool?.set('fixture', {
          inspectPage: async () => ({
            url: 'https://fixture.test/error?user=person%2Bauth%40example.com',
            title: 'Password fixture pass/word rejected',
            bodyText: `OTP otp+code%2F42 failed. ${'x'.repeat(300)}`,
            cookies: [
              {
                name: 'transaction',
                domain: '.fixture.test',
                path: '/',
                expires: 1_800_000_000,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
                value: 'must-not-leak',
              },
            ],
          }),
          close: async () => {},
        } as never);
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Continue.',
            nextAction: 'finish',
            continuation: { ticket: 'fixture-ticket' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      return {
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start', { otp: 'otp code/42' });
    const inspected = await verifier.inspectPage({ maxChars: 256 });

    expect(inspected).toMatchObject({
      ok: true,
      url: 'https://fixture.test/error?user=[REDACTED]',
      title: 'Password [REDACTED] rejected',
      bodyTextTruncated: true,
      cookies: [
        {
          name: 'transaction',
          domain: '.fixture.test',
          path: '/',
          expires: 1_800_000_000,
        },
      ],
    });
    expect(inspected.bodyText).toContain('[REDACTED]');
    expect(inspected.bodyText).not.toContain('otp+code%2F42');
    expect(JSON.stringify(inspected)).not.toContain('fixture pass/word');
    expect(inspected.cookies?.[0]?.value).toBe('must-not-leak');

    await verifier.runAction('finish');
    expect(initialStates).toEqual([undefined, { ticket: 'fixture-ticket' }]);
  });

  it('does not create a browser just to inspect and can omit cookie metadata', async () => {
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    expect(await verifier.inspectPage()).toEqual({
      ok: false,
      message: 'No active verification browser session exists.',
    });

    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      args.cdpPool?.set('fixture', {
        inspectPage: async () => ({
          url: 'https://fixture.test/',
          title: 'Fixture',
          bodyText: 'Rendered content',
          cookies: [{ name: 'session', value: 'must-not-leak' }],
        }),
        close: async () => {},
      } as never);
      return {
        result: { ok: false, error: 'BAD_RESPONSE', message: 'failed' },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);
    await verifier.runAction('start');
    const inspected = await verifier.inspectPage({ includeCookies: false });
    expect(inspected.cookies).toBeUndefined();
    expect(JSON.stringify(inspected)).not.toContain('must-not-leak');
  });

  it('runs arbitrary actions and carries generic continuation into the next action', async () => {
    const calls: Array<{
      params: Record<string, string | number | boolean>;
      initialState?: Record<string, unknown>;
      forceBackend?: string;
    }> = [];
    __setAuthVerifierLadderForTest(
      fakeRunner(
        [
          {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Continue externally.',
            nextAction: 'confirm_result',
            continuation: { ticket: 'fixture-ticket' },
          },
          { ok: true, data: { authenticated: true } },
        ],
        calls,
      ),
    );
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);

    const first = await verifier.runAction('request_external');
    expect(first).toMatchObject({
      action: 'request_external',
      ok: false,
      error: 'ACTION_REQUIRED',
      nextAction: 'confirm_result',
    });

    const second = await verifier.runAction('confirm_result', {
      confirmation: 'fixture-confirmation',
    });
    expect(second.ok).toBe(true);
    expect(calls).toEqual([
      {
        params: { action: 'request_external' },
        initialState: undefined,
        forceBackend: 'cdp-replay',
      },
      {
        params: {
          action: 'confirm_result',
          confirmation: 'fixture-confirmation',
        },
        initialState: { ticket: 'fixture-ticket' },
        forceBackend: 'cdp-replay',
      },
    ]);
  });

  it('protects typed credentials while preserving session and continuation data', async () => {
    const calls: Array<{
      params: Record<string, string | number | boolean>;
      initialState?: Record<string, unknown>;
      forceBackend?: string;
    }> = [];
    __setAuthVerifierLadderForTest(
      fakeRunner(
        [
          {
            ok: false,
            error: 'BAD_RESPONSE',
            message:
              'Login person+auth@example.com failed with fixture-cookie-secret and nested-ticket.',
            status: 422,
            responseBodyPreview:
              'password=fixture+pass%2fword&email=person%2bauth%40example.com&device=fixture-storage-secret&ticket=nested-ticket&nonce=nested-nonce',
            continuation: {
              challenge: { ticket: 'nested-ticket', steps: [{ nonce: 'nested-nonce' }] },
            },
          },
        ],
        calls,
      ),
    );

    const result = await new AuthVerifier('/tmp/fixture-workflow.json', credentials).runAction(
      'agent_named_action',
    );
    expect(result).toMatchObject({
      action: 'agent_named_action',
      ok: false,
      error: 'BAD_RESPONSE',
      status: 422,
      continuation: {
        challenge: { ticket: 'nested-ticket', steps: [{ nonce: 'nested-nonce' }] },
      },
      usedBackend: 'cdp-replay',
    });
    expect(result.message).toBe(
      'Login [REDACTED] failed with fixture-cookie-secret and nested-ticket.',
    );
    expect(result.responseBodyPreview).toBe(
      'password=[REDACTED]&email=[REDACTED]&device=fixture-storage-secret&ticket=nested-ticket&nonce=nested-nonce',
    );
  });

  it('preserves prior continuation when a later failure returns none', async () => {
    const initialStates: Array<Record<string, unknown> | undefined> = [];
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      initialStates.push(args.initialState);
      if (initialStates.length === 1) {
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Continue.',
            nextAction: 'finish',
            continuation: { ticket: 'fixture-ticket' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      return {
        result: { ok: false, error: 'NETWORK', message: 'Session ended.' },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start');
    await verifier.runAction('finish');
    await verifier.runAction('retry');

    expect(initialStates).toEqual([
      undefined,
      { ticket: 'fixture-ticket' },
      { ticket: 'fixture-ticket' },
    ]);
  });

  it('replaces explicitly returned continuation and clears it after success', async () => {
    const calls: Array<{
      params: Record<string, string | number | boolean>;
      initialState?: Record<string, unknown>;
      forceBackend?: string;
    }> = [];
    __setAuthVerifierLadderForTest(
      fakeRunner(
        [
          {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'first',
            continuation: { ticket: 'first-ticket' },
          },
          {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'second',
            continuation: {},
          },
          { ok: true, data: { authenticated: true } },
          { ok: false, error: 'NETWORK', message: 'retry' },
        ],
        calls,
      ),
    );

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('first');
    const replaced = await verifier.runAction('replace');
    expect(replaced.continuation).toEqual({});
    await verifier.runAction('complete');
    await verifier.runAction('retry');

    expect(calls.map((call) => call.initialState)).toEqual([
      undefined,
      { ticket: 'first-ticket' },
      {},
      undefined,
    ]);
  });

  it('does not restore prior continuation after a fresh-session failure', async () => {
    const calls: Array<{
      params: Record<string, string | number | boolean>;
      initialState?: Record<string, unknown>;
      forceBackend?: string;
    }> = [];
    __setAuthVerifierLadderForTest(
      fakeRunner(
        [
          {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'continue',
            continuation: { ticket: 'stale-ticket' },
          },
          { ok: false, error: 'NETWORK', message: 'fresh attempt failed' },
          { ok: false, error: 'NETWORK', message: 'retry failed' },
        ],
        calls,
      ),
    );

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start');
    const freshFailure = await verifier.runAction('restart', {}, { freshSession: true });
    expect(freshFailure.continuation).toBeUndefined();
    await verifier.runAction('retry');

    expect(calls.map((call) => call.initialState)).toEqual([undefined, undefined, undefined]);
  });

  it('lets the agent discard browser and continuation state before an action', async () => {
    const initialStates: Array<Record<string, unknown> | undefined> = [];
    let closed = 0;
    let call = 0;
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      initialStates.push(args.initialState);
      if (call++ === 0) {
        args.cdpPool?.set('fixture', {
          close: async () => {
            closed++;
          },
        } as never);
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'pause',
            nextAction: 'finish',
            continuation: { ticket: 'stale-ticket' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      expect(args.cdpPool?.size).toBe(0);
      return {
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start');
    await verifier.runAction('restart', {}, { freshSession: true });

    expect(closed).toBe(1);
    expect(initialStates).toEqual([undefined, undefined]);
  });

  it('withholds stored browser state only when the agent requests a clean session', async () => {
    const seen: Array<{ cookies: unknown[]; storage?: unknown[] }> = [];
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      seen.push({ cookies: args.credentials?.cookies ?? [], storage: args.credentials?.storage });
      return {
        result: { ok: false, error: 'NETWORK', message: 'fixture failure' },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('normal');
    await verifier.runAction('clean', {}, { cleanSession: true });

    expect(seen[0]?.cookies).toHaveLength(1);
    expect(seen[0]?.storage).toHaveLength(1);
    expect(seen[1]).toEqual({ cookies: [], storage: [] });
  });

  it('refreshes durable inputs without replacing the retained browser, and seeds a chosen fresh login with the latest snapshot', async () => {
    let closed = 0;
    const browser = {
      close: async () => {
        closed += 1;
      },
    };
    const snapshots: unknown[] = [];
    const states: unknown[] = [];
    __setAuthVerifierLadderForTest(async (input) => {
      snapshots.push(input.credentials);
      states.push(input.initialState);
      if (snapshots.length === 1) input.cdpPool?.set('fixture', browser as never);
      else if (snapshots.length === 2) expect(input.cdpPool?.get('fixture')).toBe(browser as never);
      else expect(input.cdpPool?.size).toBe(0);
      return {
        result: {
          ok: false,
          error: 'ACTION_REQUIRED',
          message: 'Current continuation',
          nextAction: 'chosen_next',
          continuation: { ticket: 'fixture-current-ticket' },
        },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    });
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start');
    const refreshed = {
      ...credentials,
      cookies: [
        { name: 'updated', value: 'fixture-new-cookie', domain: '.fixture.test', path: '/' },
      ],
      values: { ...credentials.values, password: 'fixture-updated-password' },
    };
    verifier.updateCredentials(refreshed);
    await verifier.runAction('restore');
    expect(closed).toBe(0);
    expect(snapshots[1]).toBe(refreshed);
    expect(states[1]).toEqual({ ticket: 'fixture-current-ticket' });
    expect(verifier.state).toMatchObject({
      browserActive: true,
      hasContinuation: true,
      lastAction: { action: 'restore', error: 'ACTION_REQUIRED' },
    });
    expect(JSON.stringify(verifier.state)).not.toContain('fixture-current-ticket');
    await verifier.runAction('new_login', {}, { freshSession: true });
    expect(closed).toBe(1);
    expect(snapshots[2]).toBe(refreshed);
    expect(states[2]).toBeUndefined();
    await verifier.drain();
  });

  it('cancels an active verification on disposal and prevents subsequent browser work', async () => {
    let closed = 0;
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    __setAuthVerifierLadderForTest(async (input) => {
      observedSignal = input.signal;
      started();
      input.cdpPool?.set('fixture', {
        close: async () => {
          closed += 1;
        },
      } as never);
      return await new Promise((_, reject) =>
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true }),
      );
    });
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    const pending = verifier.runAction('pause_for_network').catch((error: unknown) => error);
    await running;
    await verifier.drain();
    expect(await pending).toBeInstanceOf(Error);
    expect(observedSignal?.aborted).toBe(true);
    expect(closed).toBe(1);
    await expect(verifier.runAction('must_not_start')).rejects.toThrow();
    await verifier.drain();
    expect(closed).toBe(1);
  });

  it('isolates cancelled ladder cleanup from a later browser and continuation while keeping caller cancellation prompt', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let oldExited!: () => void;
    const oldFinished = new Promise<void>((resolve) => {
      oldExited = resolve;
    });
    let oldClosed = false;
    let newClosed = 0;
    let calls = 0;
    const pools: Array<RunnerArgs['cdpPool']> = [];
    const oldBrowser = {
      close: async () => {
        await closeHeld;
        oldClosed = true;
      },
    };
    const newBrowser = {
      close: async () => {
        newClosed += 1;
      },
    };
    __setAuthVerifierLadderForTest(async (input) => {
      pools.push(input.cdpPool);
      calls += 1;
      if (calls === 1) {
        input.cdpPool?.set('fixture', oldBrowser as never);
        entered();
        await oldHeld; // Simulates a CDP await that has not observed cancellation yet.
        await oldBrowser.close();
        input.cdpPool?.delete('fixture'); // Late backend eviction must touch only the old map.
        oldExited();
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Stale result',
            nextAction: 'old_next',
            continuation: { ticket: 'old-ticket' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      if (calls === 2) {
        expect(oldClosed).toBe(true);
        expect(input.cdpPool).not.toBe(pools[0]);
        expect(input.initialState).toBeUndefined();
        input.cdpPool?.set('fixture', newBrowser as never);
        return {
          result: {
            ok: false,
            error: 'ACTION_REQUIRED',
            message: 'Current result',
            nextAction: 'current_next',
            continuation: { ticket: 'current-ticket' },
          },
          usedBackend: 'cdp-replay',
          attempts: [],
        };
      }
      expect(input.cdpPool?.get('fixture')).toBe(newBrowser as never);
      expect(input.initialState).toEqual({ ticket: 'current-ticket' });
      expect(newClosed).toBe(0);
      return { result: { ok: true, data: {} }, usedBackend: 'cdp-replay', attempts: [] };
    });
    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    const abort = new AbortController();
    const old = verifier
      .runAction('old', {}, { signal: abort.signal })
      .catch((error: unknown) => error);
    await started;
    abort.abort(new Error('Consumer cancelled'));
    expect(await old).toBeInstanceOf(Error); // Neither oldHeld nor closeHeld is released yet.
    const recovered = verifier.runAction('recover');
    await Promise.resolve();
    expect(calls).toBe(1); // Wait for owned browser release, not the old ladder result.
    releaseClose();
    expect(await recovered).toMatchObject({ error: 'ACTION_REQUIRED', nextAction: 'current_next' });
    releaseOld();
    await oldFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(verifier.state).toMatchObject({
      browserActive: true,
      hasContinuation: true,
      lastAction: { action: 'recover', nextAction: 'current_next' },
    });
    expect(newClosed).toBe(0);
    await verifier.runAction('current_next');
    await verifier.drain();
    expect(newClosed).toBe(1);
  });

  it('closes every browser retained by the shared verifier pool', async () => {
    let closed = 0;
    __setAuthVerifierLadderForTest((async (args: RunnerArgs) => {
      args.cdpPool?.set('fixture', {
        close: async () => {
          closed++;
        },
      } as never);
      return {
        result: {
          ok: false,
          error: 'ACTION_REQUIRED',
          message: 'pause',
          nextAction: 'finish',
          continuation: {},
        },
        usedBackend: 'cdp-replay',
        attempts: [],
      };
    }) as Runner);

    const verifier = new AuthVerifier('/tmp/fixture-workflow.json', credentials);
    await verifier.runAction('start');
    await verifier.drain();
    expect(closed).toBe(1);
  });
});
