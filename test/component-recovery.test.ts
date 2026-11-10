import { describe, expect, it } from 'bun:test';
import {
  type ComponentRecoveryOwner,
  ComponentRecoveryQueue,
  runWithComponentRecovery,
} from '../src/imprint/component-recovery.ts';
import { selectLiveComponentRecovery } from '../src/imprint/live-component-recovery.ts';
import { requestLiveComponentRecovery } from '../src/imprint/master-teach-agents.ts';
import type { ToolResult } from '../src/imprint/types.ts';
import { UserInteraction } from '../src/imprint/user-interaction.ts';

const rejected = (
  error: 'AUTH_EXPIRED' | 'STATE_MISSING' | 'BAD_RESPONSE' | 'FORBIDDEN' = 'AUTH_EXPIRED',
) => ({
  result: {
    ok: false,
    error,
    status: 401,
    message: 'Synthetic failed caller',
  } as ToolResult<unknown>,
});
const passed = { result: { ok: true, data: { items: [1] } } as ToolResult<unknown> };
const input = {
  toolId: 'search_items',
  toolName: 'search_items',
  parameters: { query: 'example' },
  failure: { error: 'AUTH_EXPIRED', status: 401, message: 'Session expired' },
  previousRecoveries: 0,
  recordedAuthentication: {
    credentialRequestSeqs: [1],
    authRequestSeqs: [2],
    credentialNames: ['username'],
    notes: 'Recorded login',
  },
  owners: [] as ComponentRecoveryOwner[],
};
const owner = (id: string, recover: ComponentRecoveryOwner['recover']): ComponentRecoveryOwner => ({
  id,
  kind: id,
  label: id,
  toolIds: ['search_items'],
  recover,
});
const analyzer = (decision: unknown) => ({
  analyze: async () => ({ text: JSON.stringify(decision) }),
});

describe('component recovery engine', () => {
  for (const [kind, error] of [
    ['authentication', 'AUTH_EXPIRED'],
    ['prerequisite', 'STATE_MISSING'],
    ['shared-module', 'BAD_RESPONSE'],
  ] as const) {
    it(`records each ${kind} failure before recovery and retries the same caller`, async () => {
      const events: string[] = [];
      let calls = 0;
      const result = await runWithComponentRecovery({
        invoke: async () => {
          events.push('call');
          return calls++ ? passed : rejected(error);
        },
        select: async (failed) => {
          expect(failed.result).toMatchObject({ error });
          return {
            reason: 'Selected component',
            owner: owner(kind, async () => {
              events.push('repair');
              return true;
            }),
          };
        },
        onAttempt: (r) => events.push(r.result.ok ? 'passed receipt' : 'failed receipt'),
      });
      expect(result).toBe(passed);
      expect(events).toEqual(['call', 'failed receipt', 'repair', 'call', 'passed receipt']);
    });
  }

  it('shares completed recovery only across calls with the same declared owner', async () => {
    const queue = new ComponentRecoveryQueue();
    const attempts = [0, 0];
    let repairs = 0;
    const component = owner('producer:fixture', async () => {
      repairs++;
      return true;
    });
    const results = await Promise.all(
      [0, 1].map((index) =>
        runWithComponentRecovery({
          queue,
          invoke: async () => {
            attempts[index] = (attempts[index] ?? 0) + 1;
            return attempts[index] === 1 ? rejected('STATE_MISSING') : passed;
          },
          select: async () => ({ owner: component, reason: 'Refresh declared producer' }),
          onAttempt: () => {},
        }),
      ),
    );
    expect(results).toEqual([passed, passed]);
    expect(attempts).toEqual([2, 2]);
    expect(repairs).toBe(1);
  });

  it('does not coalesce independent components or separate run queues', async () => {
    let repairs = 0;
    for (const separateRuns of [false, true]) {
      const queue = new ComponentRecoveryQueue();
      await Promise.all(
        ['site-a', 'site-b'].map((id) => {
          let calls = 0;
          return runWithComponentRecovery({
            queue: separateRuns ? new ComponentRecoveryQueue() : queue,
            invoke: async () => (calls++ ? passed : rejected()),
            select: async () => ({
              owner: owner(separateRuns ? 'same-id' : id, async () => {
                repairs++;
                return true;
              }),
              reason: 'Independent owner',
            }),
            onAttempt: () => {},
          });
        }),
      );
    }
    expect(repairs).toBe(4);
  });

  it('allows an unrelated owner to run while another owner is held', async () => {
    const queue = new ComponentRecoveryQueue();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run('a', () => held);
    let entered = false;
    await queue.run('b', async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    release();
    await first;
  });

  it('cancels a queued repair without allowing later calls to overtake its active owner', async () => {
    const queue = new ComponentRecoveryQueue();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run('a', () => held);
    const abort = new AbortController();
    let entered = false;
    const second = queue.run(
      'a',
      async () => {
        entered = true;
      },
      abort.signal,
    );
    abort.abort(new Error('Cancelled queued recovery'));
    await expect(second).rejects.toThrow('Cancelled queued recovery');
    let thirdEntered = false;
    const third = queue.run('a', async () => {
      thirdEntered = true;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(thirdEntered).toBe(false);
    release();
    await first;
    await third;
    expect(thirdEntered).toBe(true);
  });

  it('preserves unresolved calls when the agent declines or the owner defers repair', async () => {
    for (const select of [
      async () => undefined,
      async () => ({ owner: owner('deferred', async () => false), reason: 'Rebuild first' }),
    ]) {
      const attempts: unknown[] = [];
      const failed = rejected();
      const result = await runWithComponentRecovery({
        invoke: async () => failed,
        select,
        onAttempt: (r) => attempts.push(r),
      });
      expect(result).toBe(failed);
      expect(attempts).toEqual([failed]);
    }
  });

  it('returns rejection to the agent with prior recovery counts without imposing a retry cap', async () => {
    const counts: number[] = [];
    let calls = 0;
    const result = await runWithComponentRecovery({
      invoke: async () => (++calls < 4 ? rejected('STATE_MISSING') : passed),
      select: async (_failed, previous) => {
        counts.push(previous);
        return { owner: owner('prerequisite', async () => true), reason: 'New evidence' };
      },
      onAttempt: () => {},
    });
    expect(result).toBe(passed);
    expect(counts).toEqual([0, 1, 2]);
    expect(calls).toBe(4);
  });

  it('does not infer a repair from a status or error code', async () => {
    for (const error of ['AUTH_EXPIRED', 'FORBIDDEN', 'STATE_MISSING', 'BAD_RESPONSE'] as const) {
      const failed = rejected(error);
      expect(
        await runWithComponentRecovery({
          invoke: async () => failed,
          select: async () => undefined,
          onAttempt: () => {},
        }),
      ).toBe(failed);
    }
  });

  it('preserves the failed receipt when repair is cancelled or throws', async () => {
    for (const cancel of [false, true]) {
      const abort = new AbortController();
      const attempts: unknown[] = [];
      const failed = rejected();
      await expect(
        runWithComponentRecovery({
          invoke: async () => failed,
          select: async () => ({
            reason: 'Repair selected owner',
            owner: owner('component', async () => {
              if (cancel) {
                abort.abort(new Error('Cancelled recovery'));
                return true;
              }
              throw new Error('Provider unavailable');
            }),
          }),
          onAttempt: (r) => attempts.push(r),
          signal: abort.signal,
        }),
      ).rejects.toThrow(cancel ? 'Cancelled recovery' : 'Provider unavailable');
      expect(attempts).toEqual([failed]);
    }
  });
});

describe('component recovery owner selection', () => {
  for (const status of ['authenticated', 'failed', 'unavailable'] as const) {
    it(`dispatches an explicit auth decision through the existing owner (${status})`, async () => {
      const interaction = new UserInteraction();
      let calls = 0;
      interaction.setAuthenticate(async (plan) => {
        calls++;
        expect(plan.toolName).toBe('authenticate_fixture');
        expect(plan.credentialRequestSeqs).toEqual([1]);
        return { status, message: 'Synthetic auth result' };
      });
      try {
        await interaction.run(async () => {
          const selected = await selectLiveComponentRecovery({
            ...input,
            agent: {
              analyzer: analyzer({
                action: 'authenticate',
                reason: 'Renew the recorded login',
                plan: { toolName: 'authenticate_fixture', ...input.recordedAuthentication },
              }),
            },
          });
          expect(calls).toBe(0);
          expect(
            await selected?.owner.recover({
              failure: rejected().result as Extract<ToolResult<unknown>, { ok: false }>,
              previousRecoveries: 0,
              reason: selected.reason,
            }),
          ).toBe(status === 'authenticated');
          expect(calls).toBe(1);
        });
      } finally {
        await interaction.clear();
      }
    });
  }

  for (const kind of ['prerequisite', 'shared-module', 'artifact']) {
    it(`selects an explicitly declared ${kind} owner without an auth host`, async () => {
      let repairs = 0;
      const component = owner(kind, async () => {
        repairs++;
        return true;
      });
      const selected = await selectLiveComponentRecovery({
        ...input,
        owners: [component],
        agent: {
          analyzer: analyzer({
            action: 'recover_component',
            componentId: kind,
            reason: 'Evidence identifies this owner',
          }),
        },
      });
      expect(selected?.owner).toBe(component);
      expect(repairs).toBe(0);
      await selected?.owner.recover({
        failure: { ok: false, error: 'STATE_MISSING', message: 'Fixture' },
        previousRecoveries: 0,
        reason: selected.reason,
      });
      expect(repairs).toBe(1);
    });
  }

  it('does not ask a model when no applicable owner exists', async () => {
    expect(
      await selectLiveComponentRecovery({
        ...input,
        owners: [{ ...owner('unrelated', async () => true), toolIds: ['another-tool'] }],
        agent: {
          analyzer: {
            analyze: async () => {
              throw new Error('Unexpected model call');
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it('can return an unresolved failure without dispatching any owner', async () => {
    const selected = await selectLiveComponentRecovery({
      ...input,
      owners: [
        owner('artifact', async () => {
          throw new Error('Unexpected repair');
        }),
      ],
      agent: {
        analyzer: analyzer({
          action: 'return_failure',
          reason: 'Contract change needs master review',
        }),
      },
    });
    expect(selected).toBeUndefined();
  });

  for (const decision of [
    { action: 'recover_component', componentId: 'guessed-owner', reason: 'Invalid owner' },
    {
      action: 'authenticate',
      plan: { toolName: 'invented_login', ...input.recordedAuthentication },
      reason: 'No host',
    },
  ]) {
    it(`rejects an unavailable ${decision.action} owner`, async () => {
      await expect(
        requestLiveComponentRecovery(
          { ...input, authenticationAvailable: false, components: [], contexts: [] },
          { analyzer: analyzer(decision) },
        ),
      ).rejects.toThrow();
    });
  }
});
