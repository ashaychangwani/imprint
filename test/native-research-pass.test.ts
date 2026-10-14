import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeAgentPass } from '../src/imprint/native-agent-pass.ts';
import type { NativeTeachAgents } from '../src/imprint/native-teach-agents.ts';

type SubmitOptions = NonNullable<Parameters<NativeTeachAgents['submit']>[1]>;
type Call = NonNullable<SubmitOptions['call']>;
interface Page {
  complete: boolean;
  step: number;
  prompt: string;
  nextOffset: number | null;
}
function fixture(child: (call: Call, options: SubmitOptions, prompt: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'imprint-native-research-'));
  const assignments: string[] = [];
  const family: Pick<NativeTeachAgents, 'submit'> = {
    submit: async (prompt, options = {}) => {
      assignments.push(options.conversation ?? 'missing');
      if (!options.call) throw new Error('Expected assignment tools');
      await child(options.call, options, prompt);
      return { text: 'acknowledged', agentId: '/root/researcher' };
    },
  };
  return {
    family,
    assignments,
    root,
    logPath: join(root, 'pass.jsonl'),
    conversation: 'tool:fixture:api-researcher',
  };
}

describe('persistent native research pass', () => {
  for (const stage of ['response', 'completion', 'event'] as const)
    it(`settles both sides when ${stage} logging fails`, async () => {
      const breakLog = () => {
        renameSync(f.logPath, `${f.logPath}.preserved`);
        mkdirSync(f.logPath);
      };
      const f = fixture(async (call) => {
        if (stage === 'response') breakLog();
        expect(await call('respond', { step: 1, text: 'accepted' })).toEqual({ complete: true });
      });
      let cleaned = false;
      try {
        await expect(
          runNativeAgentPass({
            ...f,
            run: async (analyzer) => {
              try {
                await analyzer.analyze(
                  'role',
                  {},
                  {
                    onEvent: () => {
                      if (stage === 'event') throw new Error('fixture event failure');
                    },
                  },
                );
                if (stage === 'completion') breakLog();
                return 'accepted';
              } finally {
                cleaned = true;
              }
            },
          }),
        ).rejects.toThrow(stage === 'event' ? 'fixture event failure' : 'EISDIR');
        expect(cleaned).toBeTrue();
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  it('delivers immediate continuations and complete paged inputs in one assignment', async () => {
    const f = fixture(async (call, _options, prompt) => {
      expect(prompt).toContain('Current step: 1');
      expect(prompt).not.toContain('<user_payload_json>');
      expect(await call('read_context', { step: 1, offset: 0 })).toHaveProperty('prompt');
      expect(await call('__list', {})).toHaveProperty('tools');
      const second = (await call('respond', { step: 1, text: 'first' })) as Page;
      expect(second.step).toBe(2);
      let text = second.prompt;
      let offset = second.nextOffset;
      while (offset !== null) {
        const page = (await call('read_context', { step: 2, offset })) as Page;
        text += page.prompt;
        offset = page.nextOffset;
      }
      expect(text).toContain('last required fact');
      await expect(call('respond', { step: 1, text: 'stale' })).rejects.toThrow('Stale');
      expect(await call('respond', { step: 2, text: 'second' })).toEqual({ complete: true });
      await expect(call('respond', { step: 2, text: 'duplicate' })).rejects.toThrow('completed');
    });
    try {
      const result = await runNativeAgentPass({
        ...f,
        run: async (analyzer) => {
          expect((await analyzer.analyze('role', { first: true })).text).toBe('first');
          expect(
            (
              await analyzer.analyze('repair role', {
                large: `${'x'.repeat(50_000)}last required fact`,
              })
            ).text,
          ).toBe('second');
          return 'host accepted';
        },
      });
      expect(result).toBe('host accepted');
      expect(f.assignments).toEqual([f.conversation]);
      const events = readFileSync(f.logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.type)).toEqual([
        'step.input',
        'step.output',
        'step.input',
        'step.output',
        'pass.completed',
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects concurrent and delayed duplicate responses without replaying execution', async () => {
    let release!: () => void;
    const execution = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (call) => {
      const pending = call('respond', { step: 1, text: 'execute' });
      await expect(call('respond', { step: 1, text: 'execute' })).rejects.toThrow(
        'already executing',
      );
      release();
      expect(((await pending) as Page).step).toBe(2);
      await expect(call('respond', { step: 1, text: 'execute' })).rejects.toThrow('Stale');
      await call('respond', { step: 2, text: 'done' });
    });
    let executed = 0;
    try {
      await runNativeAgentPass({
        ...f,
        run: async (analyzer) => {
          await analyzer.analyze('role', {});
          executed++;
          await execution;
          await analyzer.analyze('role', { observation: 'actual' });
        },
      });
      expect(executed).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('keeps the host outcome authoritative for factual blocking and acknowledgement failure', async () => {
    const failure = new Error('factual block with retained observations');
    const f = fixture(async (call) => {
      expect(await call('respond', { step: 1, text: 'blocked' })).toEqual({ complete: true });
      throw new Error('acknowledgement failed');
    });
    try {
      await expect(
        runNativeAgentPass({
          ...f,
          run: async (analyzer) => {
            await analyzer.analyze('role', {});
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects early acknowledgement and settles host cleanup', async () => {
    const f = fixture(async () => {});
    let cleaned = false;
    try {
      await expect(
        runNativeAgentPass({
          ...f,
          run: async (analyzer) => {
            try {
              await analyzer.analyze('role', {});
            } finally {
              cleaned = true;
            }
          },
        }),
      ).rejects.toThrow('acknowledged before completing');
      expect(cleaned).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  for (const duringExecution of [false, true])
    it(`cancels both sides and settles cleanup: executing=${duringExecution}`, async () => {
      const abort = new AbortController();
      let cleaned = false;
      const f = fixture(async (call, options) => {
        const cancelled = new Promise<never>((_resolve, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        );
        const response = duringExecution
          ? call('respond', { step: 1, text: 'execute' })
          : undefined;
        abort.abort(new Error('fixture cancelled'));
        if (response) await response;
        await cancelled;
      });
      try {
        await expect(
          runNativeAgentPass({
            ...f,
            signal: abort.signal,
            run: async (analyzer, signal) => {
              try {
                await analyzer.analyze('role', {});
                if (signal.aborted) throw signal.reason;
                await new Promise((_resolve, reject) =>
                  signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
                );
              } finally {
                cleaned = true;
              }
            },
          }),
        ).rejects.toThrow('fixture cancelled');
        expect(cleaned).toBe(true);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

  it('does not bind the whole pass lifetime to the first individual request signal', async () => {
    const first = new AbortController();
    const f = fixture(async (call) => {
      expect(((await call('respond', { step: 1, text: 'one' })) as Page).step).toBe(2);
      first.abort(new Error('old request disposed'));
      expect(await call('respond', { step: 2, text: 'two' })).toEqual({ complete: true });
    });
    try {
      await runNativeAgentPass({
        ...f,
        run: async (analyzer) => {
          await analyzer.analyze('role', {}, { signal: first.signal });
          await analyzer.analyze('role', {});
        },
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
