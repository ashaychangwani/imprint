import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runNativeAgentPass } from '../src/imprint/native-agent-pass.ts';
import {
  NativeTeachAgents,
  createNativeTeachMcpBridge,
  currentNativeTeachAgents,
} from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import { UserInteraction } from '../src/imprint/user-interaction.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'imprint-native-family-'));
  const family = new NativeTeachAgents(
    { root, model: 'fixture', deadline: new RunDeadline(Date.now() + 10_000) },
    async (_family, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  );
  return { family, root };
}
const tasks = async (family: NativeTeachAgents) =>
  (await family.handle('assignments', {})) as {
    tasks: Array<{ id: string; conversation: string; retainedAgentId?: string }>;
  };

describe('native teach family bridge', () => {
  it('cancels a timed-out HTTP question and lets its same-assignment retry reach the human queue', async () => {
    const started: string[] = [];
    const promptSignals: AbortSignal[] = [];
    const settled: string[] = [];
    const interaction = new UserInteraction(async (prompt, signal) => {
      started.push(prompt.message);
      if (!signal) throw new Error('Missing prompt signal');
      promptSignals.push(signal);
      if (prompt.message === 'First fixture question') {
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { status: 'cancelled', reason: 'Fixture request ended' };
        } finally {
          settled.push(prompt.message);
        }
      }
      return { status: 'answered', value: 'Ready' };
    });
    const { family, root } = interaction.run(fixture);
    const bridge = await createNativeTeachMcpBridge((...args) => family.handle(...args));
    const client = new Client({ name: 'fixture-native-http-cancellation', version: '1' });
    try {
      const assignment = family.submit('HTTP question ownership');
      void assignment.catch(() => {});
      const id = (await tasks(family)).tasks[0]?.id;
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
      await client.callTool({
        name: 'read_assignment',
        arguments: { id, agentId: '/root/http-question' },
      });
      await expect(
        client.callTool(
          { name: 'prompt_user', arguments: { id, message: 'First fixture question' } },
          undefined,
          { timeout: 80 },
        ),
      ).rejects.toThrow('timed out');
      const retry = await client.callTool(
        {
          name: 'prompt_user',
          arguments: { id, message: 'Retry fixture question', options: ['Ready', 'Unable'] },
        },
        undefined,
        { timeout: 1_000 },
      );
      expect(retry).toMatchObject({
        content: [{ type: 'text', text: JSON.stringify({ status: 'answered', value: 'Ready' }) }],
      });
      expect(started).toEqual(['First fixture question', 'Retry fixture question']);
      expect(settled).toEqual(['First fixture question']);
      expect(promptSignals.map(({ aborted }) => aborted)).toEqual([true, false]);
      await client.callTool({
        name: 'submit',
        arguments: { id, text: 'Continued the retained assignment after request timeout' },
      });
      expect((await assignment).agentId).toBe('/root/http-question');
    } finally {
      await client.close();
      await bridge.close();
      await family.close();
      await interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps HTTP cancellation scoped to the client session that owns the matching request id', async () => {
    const signals: Record<string, AbortSignal> = {};
    let secondStarted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let answerSecond: (() => void) | undefined;
    const interaction = new UserInteraction(async (prompt, signal) => {
      if (!signal) throw new Error('Missing fixture prompt signal');
      signals[prompt.message] = signal;
      if (prompt.message === 'Second client') {
        secondStarted?.();
        await new Promise<void>((resolve) => {
          answerSecond = resolve;
        });
        return { status: 'answered', value: 'Ready' };
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { status: 'cancelled', reason: 'First client timed out' };
    });
    const { family, root } = interaction.run(fixture);
    const bridge = await createNativeTeachMcpBridge((...args) => family.handle(...args));
    const clients = ['first', 'second'].map(
      (name) => new Client({ name: `fixture-native-${name}`, version: '1' }),
    );
    try {
      const assignments = [family.submit('first client role'), family.submit('second client role')];
      for (const assignment of assignments) void assignment.catch(() => {});
      const ids = (await tasks(family)).tasks.map(({ id }) => id);
      for (const [i, client] of clients.entries()) {
        await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
        await client.callTool({
          name: 'read_assignment',
          arguments: { id: ids[i], agentId: `/root/client-${i}` },
        });
      }
      // Both clients have made the same number of calls, so these tool requests
      // reuse the same JSON-RPC id in two distinct initialized sessions.
      const first = clients[0]?.callTool(
        { name: 'prompt_user', arguments: { id: ids[0], message: 'First client' } },
        undefined,
        { timeout: 80 },
      );
      const second = clients[1]?.callTool(
        { name: 'prompt_user', arguments: { id: ids[1], message: 'Second client' } },
        undefined,
        { timeout: 1_000 },
      );
      await expect(first).rejects.toThrow('timed out');
      await ready;
      expect(signals['First client']?.aborted).toBe(true);
      expect(signals['Second client']?.aborted).toBe(false);
      answerSecond?.();
      expect(await second).toMatchObject({
        content: [{ type: 'text', text: JSON.stringify({ status: 'answered', value: 'Ready' }) }],
      });
      for (const [i, client] of clients.entries())
        await client.callTool({ name: 'submit', arguments: { id: ids[i], text: `Result ${i}` } });
      expect(await Promise.all(assignments)).toHaveLength(2);
    } finally {
      answerSecond?.();
      await Promise.allSettled(clients.map((client) => client.close()));
      await bridge.close();
      await family.close();
      await interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases an outstanding HTTP question when its initialized client session is terminated', async () => {
    let started: (() => void) | undefined;
    const questionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let promptSignal: AbortSignal | undefined;
    const interaction = new UserInteraction(async (prompt, signal) => {
      if (prompt.message === 'After session termination')
        return { status: 'answered', value: 'Ready' };
      if (!signal) throw new Error('Missing fixture signal');
      promptSignal = signal;
      started?.();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { status: 'cancelled', reason: 'Fixture client session ended' };
    });
    const bridge = await createNativeTeachMcpBridge(async (_name, args, signal) =>
      interaction.request(
        {
          action: 'prompt_user',
          prompt: { message: String((args as { message: string }).message), sensitive: false },
        },
        signal,
      ),
    );
    const client = new Client({ name: 'fixture-session-termination', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url));
    try {
      await client.connect(transport);
      const question = client
        .callTool(
          { name: 'prompt_user', arguments: { message: 'Before session termination' } },
          undefined,
          { timeout: 1_000 },
        )
        .catch((error: unknown) => error);
      await questionStarted;
      await transport.terminateSession();
      expect(promptSignal?.aborted).toBe(true);
      await client.close();
      expect(await question).toBeInstanceOf(Error);
      expect(
        await interaction.request({
          action: 'prompt_user',
          prompt: { message: 'After session termination', sensitive: false },
        }),
      ).toEqual({ status: 'answered', value: 'Ready' });
    } finally {
      await client.close();
      await bridge.close();
      await interaction.clear();
    }
  });

  it('wakes an idle assignment wait immediately when independent work arrives', async () => {
    const { family, root } = fixture();
    try {
      const first = family.submit('first role');
      const firstId = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id: firstId, agentId: '/root/first' });
      let returned = false;
      const waiting = tasks(family).then((offered) => {
        returned = true;
        return offered;
      });
      await Promise.resolve();
      expect(returned).toBeFalse();
      const second = family.submit('second independent role');
      const offered = await waiting;
      const secondId = offered.tasks.find(({ id }) => id !== firstId)?.id;
      expect(secondId).toBeDefined();
      await family.handle('read_assignment', { id: secondId, agentId: '/root/second' });
      await family.handle('submit', { id: firstId, text: 'first result' });
      await family.handle('submit', { id: secondId, text: 'second result' });
      expect(await Promise.all([first, second])).toHaveLength(2);
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wakes assignment waits when a bound task is cancelled and when the family closes', async () => {
    const { family, root } = fixture();
    const abort = new AbortController();
    try {
      const pending = family
        .submit('cancelled role', { signal: abort.signal })
        .catch((error) => error);
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/cancelled' });
      const waiting = tasks(family);
      abort.abort(new Error('fixture task cancellation'));
      expect((await waiting).tasks).toEqual([]);
      expect(await pending).toBeInstanceOf(Error);
      const closing = family.handle('assignments', {});
      await family.close();
      expect(await closing).toEqual({ stopped: true, tasks: [] });
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels an idle assignment wait even when no assignment owns the family signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-native-idle-cancel-'));
    const abort = new AbortController();
    const family = new NativeTeachAgents({
      root,
      model: 'fixture',
      deadline: new RunDeadline(Date.now() + 10_000),
      signal: abort.signal,
    });
    try {
      const waiting = family.handle('assignments', {}).catch((error) => error);
      abort.abort(new Error('fixture family cancellation'));
      expect(((await waiting) as Error).message).toBe('fixture family cancellation');
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards request cancellation without cancelling the retained assignment', async () => {
    const { family, root } = fixture();
    const request = new AbortController();
    let called: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      called = resolve;
    });
    try {
      const pending = family.submit('retained host operations', {
        contextRef: 'fixture-context',
        call: async (name, _args, signal) => {
          if (name === 'held') {
            called?.();
            return await new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          expect(signal?.aborted).toBe(false);
          return { observed: name };
        },
      });
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/retained' });
      const held = family
        .handle(
          'call_assignment_tool',
          {
            id,
            name: 'held',
            args: { fixtureInput: 'do-not-journal-fixture-value' },
          },
          request.signal,
        )
        .catch((error: unknown) => error);
      await started;
      request.abort(new Error('fixture transport request cancelled'));
      expect(((await held) as Error).message).toBe('fixture transport request cancelled');
      expect(
        await family.handle('call_assignment_tool', {
          id,
          name: 'recovery',
          args: {},
        }),
      ).toEqual({ observed: 'recovery' });
      await family.handle('submit', { id, text: 'Continued in the same assignment' });
      expect((await pending).agentId).toBe('/root/retained');
      const journal = readFileSync(join(root, 'events.jsonl'), 'utf8');
      expect(journal).not.toContain('do-not-journal-fixture-value');
      const events = journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.filter(({ type }) => type === 'assignment.created')).toHaveLength(1);
      expect(
        events.find(({ type, name }) => type === 'assignment.tool.completed' && name === 'held'),
      ).toMatchObject({ contextRef: 'fixture-context', status: 'cancelled' });
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards request cancellation to a human question while preserving its assignment', async () => {
    const interaction = new UserInteraction(async () => await new Promise(() => {}));
    const { family, root } = interaction.run(fixture);
    const request = new AbortController();
    try {
      const pending = family.submit('question request ownership');
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/question' });
      const question = family
        .handle(
          'prompt_user',
          {
            id,
            message: 'Current fixture challenge',
          },
          request.signal,
        )
        .catch((error: unknown) => error);
      await Promise.resolve();
      request.abort(new Error('fixture question request cancelled'));
      expect(await question).toBeInstanceOf(Error);
      await family.handle('submit', { id, text: 'Question cancelled without approval' });
      expect((await pending).agentId).toBe('/root/question');
    } finally {
      await family.close();
      await interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels a pending user question with its requesting assignment', async () => {
    const interaction = new UserInteraction(async () => await new Promise(() => {}));
    const { family, root } = interaction.run(fixture);
    const abort = new AbortController();
    try {
      const pending = family
        .submit('fixture research', { signal: abort.signal })
        .catch((error: unknown) => error);
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/researcher' });
      const question = family
        .handle('prompt_user', { id, message: 'Approve fixture action' })
        .catch((error: unknown) => error);
      await Promise.resolve();
      abort.abort(new Error('Fixture assignment cancelled'));
      expect(await pending).toBeInstanceOf(Error);
      expect(await question).toBeInstanceOf(Error);
    } finally {
      await family.close();
      interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('lets a bound research agent ask the parent UI without direct assignment tools', async () => {
    const interaction = new UserInteraction(async () => ({
      status: 'answered',
      value: 'fixture-secret-otp',
    }));
    const { family, root } = interaction.run(fixture);
    try {
      const pending = family.submit('fixture research');
      const id = (await tasks(family)).tasks[0]?.id;
      await expect(
        family.handle('prompt_user', { id, message: 'Enter code', sensitive: true }),
      ).rejects.toThrow('Read this assignment');
      await family.handle('read_assignment', { id, agentId: '/root/researcher' });
      const answer = (await family.handle('prompt_user', {
        id,
        message: 'Enter code',
        sensitive: true,
      })) as { status: string; value: string };
      expect(answer.status).toBe('answered');
      expect(JSON.stringify(answer)).not.toContain('fixture-secret-otp');
      expect(interaction.resolve(answer.value)).toBe('fixture-secret-otp');
      await family.handle('submit', { id, text: 'Continued after input' });
      await pending;
      expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).not.toContain('fixture-secret-otp');
    } finally {
      await family.close();
      interaction.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('releases a validated pass when the child never acknowledges completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-native-ack-'));
    let assignmentId: string | undefined;
    const family = new NativeTeachAgents(
      { root, model: 'fixture', deadline: new RunDeadline(Date.now() + 10_000) },
      async (bridge) => {
        const id = (await tasks(bridge)).tasks[0]?.id;
        assignmentId = id;
        await bridge.handle('read_assignment', { id, agentId: '/root/researcher' });
        expect(
          await bridge.handle('call_assignment_tool', {
            id,
            name: 'respond',
            args: { step: 1, text: '{"proven":true}' },
          }),
        ).toEqual({ complete: true });
        // Simulate a native child that remains alive after the host pass.
      },
    );
    try {
      expect(
        await runNativeAgentPass({
          family,
          conversation: 'tool:lookup:api-researcher',
          logPath: join(root, 'pass.jsonl'),
          acknowledgmentGraceMs: 10,
          run: async (analyzer) => JSON.parse((await analyzer.analyze('role', {})).text),
        }),
      ).toEqual({ proven: true });
      expect(readFileSync(join(root, 'pass.jsonl'), 'utf8')).toContain(
        'pass.acknowledgment_timeout',
      );
      expect(readFileSync(join(root, 'events.jsonl'), 'utf8')).toContain('assignment.cancelled');
      await expect(
        family.handle('submit', { id: assignmentId, text: 'late acknowledgment' }),
      ).rejects.toThrow('Unknown or cancelled assignment');
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects failed creation journaling without enqueueing orphan work', async () => {
    const { family, root } = fixture();
    try {
      mkdirSync(join(root, 'events.jsonl'));
      await expect(family.submit('must not dispatch')).rejects.toThrow();
      await family.close();
      expect((await tasks(family)).tasks).toEqual([]);
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('settles a failed completion journal write instead of accepting an unresolved task', async () => {
    const { family, root } = fixture();
    try {
      const pending = family.submit('fixture');
      const outcome = pending.catch((error: unknown) => error);
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: 'fixture-agent' });
      renameSync(join(root, 'events.jsonl'), join(root, 'retained-events.jsonl'));
      mkdirSync(join(root, 'events.jsonl'));
      await expect(family.handle('submit', { id, text: 'actual response' })).rejects.toThrow();
      expect(await outcome).toBeInstanceOf(Error);
      await expect(family.handle('submit', { id, text: 'actual response' })).rejects.toThrow(
        'Unknown',
      );
      await family.close();
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels family-owned assignments even when a distinct caller signal remains live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imprint-native-cancel-'));
    const abort = new AbortController();
    const caller = new AbortController();
    let release!: () => void;
    const family = new NativeTeachAgents(
      {
        root,
        model: 'fixture',
        deadline: new RunDeadline(Date.now() + 10_000),
        signal: abort.signal,
      },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const outcome = family
        .submit('fixture', { signal: caller.signal })
        .catch((error: unknown) => error);
      abort.abort(new Error('family cancelled'));
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('family cancelled');
      expect(caller.signal.aborted).toBe(false);
    } finally {
      release();
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hands independent work to the provider and retains the same conversation across repair', async () => {
    const { family, root } = fixture();
    try {
      await family.run(async () => {
        expect(currentNativeTeachAgents()).toBe(family);
        const pending = Array.from({ length: 12 }, (_, i) =>
          family.submit(`role ${i}`, { conversation: `role-${i}` }),
        );
        const offered = await tasks(family);
        expect(offered.tasks).toHaveLength(12); // host has no worker admission queue
        for (const task of offered.tasks) {
          await family.handle('read_assignment', {
            id: task.id,
            agentId: `native-${task.conversation}`,
          });
          await family.handle('submit', {
            id: task.id,
            text: '{"actual":"rejected by downstream schema"}',
          });
        }
        expect(await Promise.all(pending)).toHaveLength(12);
        const repaired = family.submit(
          'Schema says missing inner field. Repair your prior output.',
          { conversation: 'role-0' },
        );
        const task = (await tasks(family)).tasks[0];
        expect(task?.retainedAgentId).toBe('native-role-0');
        await expect(
          family.handle('read_assignment', { id: task?.id, agentId: 'different-agent' }),
        ).rejects.toThrow('same retained conversation');
        await family.handle('read_assignment', { id: task?.id, agentId: 'native-role-0' });
        await family.handle('submit', { id: task?.id, text: '{"actual":"fixed"}' });
        expect((await repaired).text).toBe('{"actual":"fixed"}');
        await expect(
          family.handle('submit', { id: task?.id, text: 'replacement' }),
        ).rejects.toThrow('Cannot replace');
      });
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains large task instructions with explicit bounded paging', async () => {
    const { family, root } = fixture();
    try {
      const prompt = `${'a'.repeat(24_000)}last required instruction`;
      const pending = family.submit(prompt);
      const id = (await tasks(family)).tasks[0]?.id;
      const first = (await family.handle('read_assignment', { id, agentId: 'native-fixture' })) as {
        executionMode: string;
        prompt: string;
        nextOffset: number;
      };
      const next = (await family.handle('read_assignment', {
        id,
        agentId: 'native-fixture',
        offset: first.nextOffset,
      })) as {
        prompt: string;
        nextOffset: null;
      };
      expect(first.executionMode).toBe('role_response');
      await expect(family.handle('list_assignment_tools', { id })).rejects.toThrow(
        'submit the role JSON action',
      );
      expect(first.prompt.length).toBe(24_000);
      expect(first.prompt + next.prompt).toBe(prompt);
      expect(next.nextOffset).toBeNull();
      await family.handle('read_assignment', { id, agentId: 'native-fixture' });
      await family.handle('submit', { id, text: 'read all pages' });
      await pending;
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates task tool calls, rejects foreign ids, and releases cancelled assignments', async () => {
    const { family, root } = fixture();
    try {
      const abort = new AbortController();
      const first = family.submit('Compiler A', {
        conversation: 'a',
        call: async () => 'workspace-a',
      });
      const second = family.submit('Compiler B', {
        conversation: 'b',
        signal: abort.signal,
        call: async () => 'workspace-b',
      });
      const rejected = second.catch((error) => error);
      const offered = (await tasks(family)).tasks;
      for (const task of offered)
        await family.handle('read_assignment', {
          id: task.id,
          agentId: `native-${task.conversation}`,
        });
      expect(
        await family.handle('call_assignment_tool', { id: offered[0]?.id, name: 'test', args: {} }),
      ).toBe('workspace-a');
      expect(
        await family.handle('call_assignment_tool', { id: offered[1]?.id, name: 'test', args: {} }),
      ).toBe('workspace-b');
      await expect(family.handle('read_assignment', { id: 'other-run' })).rejects.toThrow(
        'Unknown',
      );
      abort.abort(new Error('fixture cancellation'));
      expect(String(await rejected)).toContain('fixture cancellation');
      await expect(
        family.handle('call_assignment_tool', { id: offered[1]?.id, name: 'test', args: {} }),
      ).rejects.toThrow('Unknown');
      await family.handle('submit', { id: offered[0]?.id, text: 'done' });
      await first;
      expect(await family.handle('submit', { id: offered[0]?.id, text: 'done' })).toEqual({
        accepted: true,
      });
      await expect(
        family.handle('read_assignment', { id: offered[0]?.id, agentId: 'native-a' }),
      ).rejects.toThrow('completed');
      await expect(
        family.handle('call_assignment_tool', { id: offered[0]?.id, name: 'test', args: {} }),
      ).rejects.toThrow('completed');
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an assignment open when its host pass has not validated the final step', async () => {
    const { family, root } = fixture();
    try {
      let completed = false;
      const pending = family.submit('Repair step', {
        conversation: 'focused-planner',
        call: async () => ({ complete: completed }),
        beforeSubmit: () => {
          if (!completed) throw new Error('Host validation still awaits step 3; call respond');
        },
      });
      const id = (await tasks(family)).tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/planner' });
      await expect(family.handle('submit', { id, text: '{"plan":"unvalidated"}' })).rejects.toThrow(
        'Host validation still awaits step 3',
      );
      expect(await family.handle('list_assignment_tools', { id })).toEqual({ complete: false });
      completed = true;
      await family.handle('submit', { id, text: 'Host-validated pass complete' });
      expect((await pending).text).toBe('Host-validated pass complete');
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
