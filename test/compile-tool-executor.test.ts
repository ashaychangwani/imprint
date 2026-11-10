import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileViaCodexCli } from '../src/imprint/codex-cli-compile.ts';
import { createCompileToolExecutor } from '../src/imprint/compile-tool-executor.ts';
import { NativeTeachAgents } from '../src/imprint/native-teach-agents.ts';
import { RunDeadline } from '../src/imprint/provider-retry.ts';
import { SessionSchema } from '../src/imprint/types.ts';

it('keeps a native assignment usable after a failed host call and journals safe failure facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-native-executor-'));
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, 'Synthetic compiler instructions');
  const session = SessionSchema.parse({
    site: 'fixture',
    url: 'https://fixture.invalid',
    startedAt: new Date().toISOString(),
    imprintVersion: 'fixture',
    requests: [],
    events: [],
    narration: [],
  });
  const family = new NativeTeachAgents(
    { root: join(root, 'native'), model: 'fixture', deadline: new RunDeadline(Date.now() + 10000) },
    async (_family, signal) =>
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
  );
  try {
    await family.run(async () => {
      const pending = compileViaCodexCli({
        session,
        sessionPath: join(root, 'not-on-disk.json'),
        absoluteToolDir: root,
        systemPromptPath: prompt,
        startTime: Date.now(),
        deadlineMs: Date.now() + 10000,
        authMode: {
          site: 'fixture',
          authPlanJson: JSON.stringify({ toolName: 'authenticate_fixture' }),
          allowedTools: [],
          initialPrompt: 'Fixture',
          executeCheckpoint: async () => {
            throw Object.assign(new TypeError('fixture-private-value'), { code: 'ECONNRESET' });
          },
        },
      });
      const offered = (await family.handle('assignments', {})) as { tasks: Array<{ id: string }> };
      const id = offered.tasks[0]?.id;
      await family.handle('read_assignment', { id, agentId: '/root/fixture' });
      await expect(
        family.handle('call_assignment_tool', {
          id,
          name: 'run_verification',
          args: { action: 'fixture' },
        }),
      ).rejects.toThrow(TypeError);
      const written = (await family.handle('call_assignment_tool', {
        id,
        name: 'write_file',
        args: { relativePath: 'parser.ts', content: 'export const fixture = true;' },
      })) as { isError?: boolean };
      expect(written.isError).toBe(false);
      await family.handle('call_assignment_tool', {
        id,
        name: 'give_up',
        args: {
          reason: 'Fixture complete',
          what_was_tried: 'Local tool route and error propagation',
        },
      });
      await family.handle('submit', { id, text: 'Synthetic diagnostic complete' });
      await pending;
      const logText = readFileSync(join(root, '.compile-log.json'), 'utf8');
      expect(logText).not.toContain('fixture-private-value');
      const events = JSON.parse(logText) as Array<Record<string, unknown>>;
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool.started', name: 'run_verification' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.settled',
          name: 'run_verification',
          status: 'threw',
          error: { name: 'TypeError', code: 'ECONNRESET' },
        }),
      );
      const lifecycle = readFileSync(join(root, 'native', 'events.jsonl'), 'utf8');
      expect(lifecycle).not.toContain('fixture-private-value');
      expect(lifecycle).toContain('ECONNRESET');
      expect(existsSync(join(root, '.native-mcp-stderr.log'))).toBe(false);
    });
  } finally {
    await family.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('reads newly captured evidence and writes artifacts without a compiler subprocess', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-executor-'));
  const session = SessionSchema.parse({
    site: 'fixture',
    url: 'https://fixture.invalid',
    startedAt: new Date().toISOString(),
    imprintVersion: 'fixture',
    requests: [],
    events: [],
    narration: [],
  });
  const executor = createCompileToolExecutor(
    {
      sessionPath: join(root, 'absent.json'),
      toolDir: root,
      authToolPlan: {
        toolName: 'auth_fixture',
        credentialRequestSeqs: [],
        authRequestSeqs: [],
        credentialNames: [],
        captures: [],
        notes: '',
      },
    },
    { session },
  );
  try {
    session.requests.push({
      seq: 1307,
      timestamp: 1,
      method: 'GET',
      resourceType: 'fetch',
      headers: {},
      url: 'https://fixture.invalid/evidence',
      response: { status: 200, headers: {}, body: 'x'.repeat(100_000) },
    });
    const evidence = await executor.callTool('read_response_body', { seq: 1307, length: 100_000 });
    expect(evidence.isError).toBe(false);
    const text = evidence.content.find((block) => block.type === 'text');
    expect(text?.type === 'text' && JSON.parse(text.text).returnedLength).toBe(100000);
    expect(
      (
        await executor.callTool('write_file', {
          relativePath: 'parser.ts',
          content: 'export const fixture = true;',
        })
      ).isError,
    ).toBe(false);
    expect((await executor.callTool('read_file', { path: 'parser.ts' })).isError).toBe(false);
    expect(readFileSync(join(root, 'parser.ts'), 'utf8')).toContain('fixture');
    const aborted = new AbortController();
    aborted.abort(new DOMException('Fixture cancelled', 'AbortError'));
    await expect(
      executor.callTool(
        'write_file',
        { relativePath: 'request.test.ts', content: 'late' },
        aborted.signal,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(root, 'request.test.ts'))).toBe(false);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('cancels only the generated test process and prevents its delayed write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imprint-executor-cancel-'));
  const session = SessionSchema.parse({
    site: 'fixture',
    url: 'https://fixture.invalid',
    startedAt: new Date().toISOString(),
    imprintVersion: 'fixture',
    requests: [],
    events: [],
    narration: [],
  });
  const executor = createCompileToolExecutor(
    { sessionPath: join(root, 'session.json'), toolDir: root },
    { session },
  );
  writeFileSync(
    join(root, 'parser.test.ts'),
    `import { test } from 'bun:test'; import { writeFileSync } from 'node:fs'; test('held', async () => { writeFileSync('started', '1'); await new Promise(r => setTimeout(r, 10000)); writeFileSync('late', '1'); });`,
  );
  try {
    const controller = new AbortController();
    const pending = executor.callTool('run_tests', {}, controller.signal);
    void pending.catch(() => {});
    const until = Date.now() + 2000;
    while (!existsSync(join(root, 'started')) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(join(root, 'started'))).toBe(true);
    controller.abort(new DOMException('Fixture test cancellation', 'AbortError'));
    await expect(pending).rejects.toThrow();
    expect(existsSync(join(root, 'late'))).toBe(false);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
