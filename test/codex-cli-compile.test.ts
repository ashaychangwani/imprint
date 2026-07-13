import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { compileViaCodexCli } from '../src/imprint/codex-cli-compile.ts';
import type { Session } from '../src/imprint/types.ts';

const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function fixtureSession(): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-07-09T00:00:00.000Z',
    url: 'https://example.test/login',
    imprintVersion: '0.0.0-test',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function installFakeCodex(binDir: string): void {
  const codexPath = pathJoin(binDir, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

if (process.env.FAKE_CODEX_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_LOG, process.argv.slice(2).join('\\u0000') + '\\n', { flag: 'a' });
}

const prompt = await new Response(Bun.stdin.stream()).text();
if (process.env.FAKE_CODEX_PROMPT_LOG) {
  writeFileSync(process.env.FAKE_CODEX_PROMPT_LOG, prompt + '\\n---PROMPT---\\n', { flag: 'a' });
}

let toolDir = process.env.FAKE_CODEX_TOOL_DIR;
for (const arg of process.argv.slice(2)) {
  const prefix = 'mcp_servers.imprint-compile.args=';
  if (!arg.startsWith(prefix)) continue;
  const mcpArgs = JSON.parse(arg.slice(prefix.length));
  const idx = mcpArgs.indexOf('--tool-dir');
  if (idx >= 0) toolDir = mcpArgs[idx + 1];
}
if (!toolDir) throw new Error('fake codex could not find --tool-dir');

if (process.env.FAKE_CODEX_WRAPPER_CHILD === '1') {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({type:"thread.started",thread_id:"fake-child-thread"})); console.log(JSON.stringify({type:"turn.started"})); setInterval(() => console.log(JSON.stringify({type:"agent_reasoning_delta",delta:"still thinking"})), 100);',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  await child.exited;
  process.exit(child.exitCode ?? 0);
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
if (process.env.FAKE_CODEX_ARTIFACT_BEFORE_MCP === '1') {
  writeFileSync(pathJoin(toolDir, 'workflow.json'), '{}', 'utf8');
  await new Promise(() => {});
}
if (process.env.FAKE_CODEX_BOOTSTRAP_RESUME === '1' && !process.argv.includes('resume')) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'summary-call',
      type: 'mcp_tool_call',
      server: 'imprint-compile',
      name: 'read_session_summary',
      status: 'completed',
      output: { ok: true },
    },
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }));
  process.exit(0);
}
if (process.env.FAKE_CODEX_STALL_ACTIVE_TOOL === '1') {
  console.log(JSON.stringify({
    type: 'item.started',
    item: {
      id: 'stalled-summary-call',
      type: 'mcp_tool_call',
      server: 'imprint-compile',
      tool: 'read_session_summary',
      status: 'in_progress',
    },
  }));
  await new Promise(() => {});
}
if (process.env.FAKE_CODEX_IDLE_AFTER_TURN === '1') {
  if (process.env.FAKE_CODEX_CHATTER_AFTER_TURN === '1') {
    setInterval(() => {
      console.log(JSON.stringify({ type: 'agent_reasoning_delta', delta: 'still thinking' }));
    }, 100);
  }
  await new Promise(() => {});
}

writeFileSync(
  pathJoin(toolDir, '.compile-checkpoint.json'),
  JSON.stringify({ kind: 'run_verification', phase: 'initiate', timestamp: 1 }),
  'utf8',
);
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }));
if (process.env.FAKE_CODEX_HANG_AFTER_CHECKPOINT === '1') {
  await new Promise(() => {});
}
`,
    'utf8',
  );
  chmodSync(codexPath, 0o755);
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ''}`;
}

describe('compileViaCodexCli auth checkpoints', () => {
  it('returns checkpoint outcome for auth-mode codex runs and captures a resumable session id', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      const argsLog = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_ARGS_LOG = argsLog;
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');
      writeFileSync(
        pathJoin(toolDir, '.compile-checkpoint.json'),
        JSON.stringify({ kind: 'run_verification', phase: 'complete', timestamp: 0 }),
        'utf8',
      );

      const result = await compileViaCodexCli({
        session: fixtureSession(),
        absoluteToolDir: toolDir,
        sessionPath,
        systemPromptPath,
        deadlineMs: Date.now() + 30_000,
        startTime: Date.now(),
        authMode: {
          site: 'fixture-site',
          authPlanJson: '{}',
          allowedTools: [],
          initialPrompt: 'compile authenticate_fixture',
        },
      });

      expect(result.outcome).toBe('checkpoint');
      expect(result.checkpoint).toMatchObject({
        kind: 'run_verification',
        phase: 'initiate',
      });
      expect(result.turns).toBe(1);
      expect(result.inputTokens).toBe(3);
      expect(result.outputTokens).toBe(5);
      expect(result.sessionId).toBe('fake-thread');
      const args = readFileSync(argsLog, 'utf8').trim().split('\u0000');
      expect(args).toContain('exec');
      expect(args).not.toContain('--ephemeral');
      expect(args).toContain('mcp_servers.imprint-compile.required=true');
      expect(args).toContain('plugins');
      expect(args[args.indexOf('plugins') - 1]).toBe('--disable');
    } finally {
      process.env.FAKE_CODEX_ARGS_LOG = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes auth-mode codex segments with codex exec resume', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-resume-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      const argsLog = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_ARGS_LOG = argsLog;
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

      const result = await compileViaCodexCli({
        session: fixtureSession(),
        absoluteToolDir: toolDir,
        sessionPath,
        systemPromptPath,
        deadlineMs: Date.now() + 30_000,
        startTime: Date.now(),
        authMode: {
          site: 'fixture-site',
          authPlanJson: '{}',
          allowedTools: [],
          initialPrompt: 'compile authenticate_fixture',
        },
        resume: {
          sessionId: 'fake-thread',
          message: 'continue after checkpoint',
        },
      });

      expect(result.outcome).toBe('checkpoint');
      const args = readFileSync(argsLog, 'utf8').trim().split('\u0000');
      const execIndex = args.indexOf('exec');
      expect(args.slice(execIndex, execIndex + 4)).toEqual([
        'exec',
        'resume',
        '--disable',
        'plugins',
      ]);
      expect(args).toContain('fake-thread');
      expect(args).not.toContain('--ephemeral');
      expect(args).toContain('mcp_servers.imprint-compile.required=true');
      expect(args).toContain('plugins');
      expect(args[args.indexOf('plugins') - 1]).toBe('--disable');
    } finally {
      process.env.FAKE_CODEX_ARGS_LOG = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts auth-mode codex with the canonical system prompt and provider framing', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-compact-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      const argsLog = pathJoin(root, 'args.log');
      const promptLog = pathJoin(root, 'prompts.log');
      process.env.FAKE_CODEX_ARGS_LOG = argsLog;
      process.env.FAKE_CODEX_PROMPT_LOG = promptLog;
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(
        systemPromptPath,
        '# Canonical auth compiler\n\nCANONICAL_AUTH_PROMPT_MARKER',
        'utf8',
      );
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

      const result = await compileViaCodexCli({
        session: fixtureSession(),
        absoluteToolDir: toolDir,
        sessionPath,
        systemPromptPath,
        deadlineMs: Date.now() + 30_000,
        startTime: Date.now(),
        authMode: {
          site: 'fixture-site',
          authPlanJson: '{}',
          allowedTools: [],
          initialPrompt:
            'compile authenticate_fixture\n\nMANDATORY FIRST ACTION: call read_session_summary now. Do not write prose, do not inspect repository files, and do not plan silently before that tool call. After read_session_summary returns, examine requests.',
        },
      });

      expect(result.outcome).toBe('checkpoint');
      expect(result.sessionId).toBe('fake-thread');
      const argRuns = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(argRuns).toHaveLength(1);
      expect((argRuns[0] ?? '').split('\u0000')).not.toContain('resume');
      const prompts = readFileSync(promptLog, 'utf8').split('\n---PROMPT---\n');
      expect(prompts[0] ?? '').toContain('<system_instructions>');
      expect(prompts[0] ?? '').toContain('CANONICAL_AUTH_PROMPT_MARKER');
      expect(prompts[0] ?? '').toContain('compile authenticate_fixture');
      expect(prompts[0] ?? '').toContain('MANDATORY FIRST ACTION: call read_session_summary now');
      expect(prompts[0] ?? '').toContain('Codex provider framing:');
    } finally {
      process.env.FAKE_CODEX_ARGS_LOG = undefined;
      process.env.FAKE_CODEX_PROMPT_LOG = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes an explicitly selected model to codex', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-model-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      const argsLog = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_ARGS_LOG = argsLog;
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

      await compileViaCodexCli({
        session: fixtureSession(),
        absoluteToolDir: toolDir,
        sessionPath,
        systemPromptPath,
        deadlineMs: Date.now() + 30_000,
        startTime: Date.now(),
        model: 'gpt-5.6-terra',
        authMode: {
          site: 'fixture-site',
          authPlanJson: '{}',
          allowedTools: [],
          initialPrompt: 'compile authenticate_fixture',
        },
      });

      const args = readFileSync(argsLog, 'utf8').trim().split('\u0000');
      expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
    } finally {
      process.env.FAKE_CODEX_ARGS_LOG = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns checkpoint outcome when codex does not exit after recording checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-hang-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      process.env.FAKE_CODEX_HANG_AFTER_CHECKPOINT = '1';
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');
      writeFileSync(pathJoin(toolDir, 'workflow.json'), '{"stale":true}', 'utf8');

      const startedAt = Date.now();
      const result = await compileViaCodexCli({
        session: fixtureSession(),
        absoluteToolDir: toolDir,
        sessionPath,
        systemPromptPath,
        deadlineMs: Date.now() + 30_000,
        startTime: Date.now(),
        authMode: {
          site: 'fixture-site',
          authPlanJson: '{}',
          allowedTools: [],
          initialPrompt: 'compile authenticate_fixture',
        },
      });

      expect(result.outcome).toBe('checkpoint');
      expect(result.sessionId).toBe('fake-thread');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      process.env.FAKE_CODEX_HANG_AFTER_CHECKPOINT = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
