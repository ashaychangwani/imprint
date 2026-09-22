import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTeachAgents, currentNativeTeachAgents } from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';

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
      await expect(
        family.handle('call_assignment_tool', { id: offered[0]?.id, name: 'test', args: {} }),
      ).rejects.toThrow('completed');
    } finally {
      await family.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
