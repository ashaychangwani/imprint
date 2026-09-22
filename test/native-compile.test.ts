import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileViaCodexCli } from '../src/imprint/codex-cli-compile.ts';
import { NativeTeachAgents } from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import { ToolCandidateSchema } from '../src/imprint/tool-candidates.ts';
import { SessionSchema } from '../src/imprint/types.ts';

it('retains native compilers across revision directories and isolates other public tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-native-compile-'));
  const session = SessionSchema.parse({
    site: 'fixture.invalid',
    startedAt: '2026-01-01T00:00:00Z',
    url: 'https://fixture.invalid/',
    imprintVersion: '0.6.6',
    requests: [],
    events: [],
    narration: [],
  });
  const sessionPath = join(root, 'session.json');
  const systemPromptPath = join(root, 'prompt.md');
  writeFileSync(sessionPath, JSON.stringify(session));
  writeFileSync(systemPromptPath, 'Synthetic compiler fixture.');
  const deadline = new RunDeadline(Date.now() + 15_000);
  const family = new NativeTeachAgents(
    { root, model: 'fixture', deadline },
    async (family, signal) => {
      for (let turn = 0; turn < 3; turn++) {
        const { tasks } = (await family.handle('assignments', {})) as {
          tasks: Array<{ id: string; retainedAgentId?: string }>;
        };
        const id = tasks[0]?.id;
        const agentId = turn === 2 ? '/root/other-compiler' : '/root/fixture-compiler';
        expect(tasks[0]?.retainedAgentId).toBe(turn === 1 ? agentId : undefined);
        await family.handle('read_assignment', { id, agentId });
        const listing = (await family.handle('list_assignment_tools', { id })) as {
          tools: Array<{ name: string }>;
        };
        expect(listing.tools.some(({ name }) => name === 'write_file')).toBeTrue();
        await family.handle('call_assignment_tool', { id, name: 'read_session_summary', args: {} });
        await family.handle('call_assignment_tool', {
          id,
          name: 'give_up',
          args: {
            reason: 'Synthetic missing evidence',
            what_was_tried: 'Inspected empty synthetic recording',
          },
        });
        await family.handle('submit', { id, text: 'Cannot compile without evidence.' });
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  );
  try {
    await family.run(async () => {
      for (let turn = 0; turn < 3; turn++) {
        const result = await compileViaCodexCli({
          session,
          sessionPath,
          systemPromptPath,
          absoluteToolDir: join(root, `revision-${turn}`, turn === 2 ? 'other' : 'tool'),
          candidate: ToolCandidateSchema.parse({
            toolName: turn === 2 ? 'other' : 'tool',
            description: 'Synthetic tool with missing recording evidence.',
            rationale: 'Exercise retained compiler ownership, not website behavior.',
            confidence: 1,
          }),
          ...(turn === 1
            ? {
                resume: {
                  sessionId: '/root/fixture-compiler',
                  message: 'Repair this tool in its new revision workspace.',
                },
              }
            : {}),
          deadlineMs: deadline.deadlineMs,
          runDeadline: deadline,
          startTime: Date.now(),
          verificationMode: 'master_mvp',
        });
        expect(result.success).toBeFalse();
        expect(result.outcome).toBe('give_up');
        expect(result.message).toContain('Synthetic missing evidence');
        expect(result.sessionId).toBe(
          turn === 2 ? '/root/other-compiler' : '/root/fixture-compiler',
        );
        expect(result.inputTokens).toBeNull(); // usage comes from native rollouts, never invented
      }
    });
  } finally {
    await family.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
