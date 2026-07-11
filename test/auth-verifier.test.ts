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
    expect(JSON.stringify(inspected)).not.toContain('must-not-leak');

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

  it('sanitizes raw and encoded secrets in every error-facing result string', async () => {
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
    expect(result.message).toBe('Login [REDACTED] failed with [REDACTED] and [REDACTED].');
    expect(result.responseBodyPreview).toBe(
      'password=[REDACTED]&email=[REDACTED]&device=[REDACTED]&ticket=[REDACTED]&nonce=[REDACTED]',
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
