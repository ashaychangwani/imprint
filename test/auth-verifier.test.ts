import { afterEach, describe, expect, it } from 'bun:test';
import { AuthVerifier, __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { ToolResult } from '../src/imprint/types.ts';

type Runner = NonNullable<Parameters<typeof __setAuthVerifierLadderForTest>[0]>;
type RunnerArgs = Parameters<Runner>[0];

const credentials = {
  site: 'fixture-site',
  cookies: [],
  values: { username: 'fixture-user', password: 'fixture-pass' },
  storage: [],
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

  it('returns observed HTTP facts without interpreting them', async () => {
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
            message: 'fixture failure',
            status: 422,
            responseBodyPreview: '{"reason":"fixture"}',
            continuation: { captured: 'state' },
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
      responseBodyPreview: '{"reason":"fixture"}',
      continuation: { captured: 'state' },
      usedBackend: 'cdp-replay',
    });
  });

  it('clears prior continuation when a later failure returns none', async () => {
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

    expect(initialStates).toEqual([undefined, { ticket: 'fixture-ticket' }, undefined]);
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
