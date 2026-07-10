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

  it('starts auth-mode codex with a compact prompt instead of the full markdown system prompt', async () => {
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
      expect(prompts[0] ?? '').toContain('Auth compile rules');
      expect(prompts[0] ?? '').toContain('Your first response MUST be a call');
      expect(prompts[0] ?? '').toContain(
        'Preserve its encryptedData/signature/publicKey fields in the first workflow and call run_verification',
      );
      expect(prompts[0] ?? '').toContain(
        'Only a concrete pre-challenge verification failure may prove it stale',
      );
      expect(prompts[0] ?? '').toContain(
        'There is no request phase, bodyJson, singular capture, transform, expect, poll, id, or seq field',
      );
      expect(prompts[0] ?? '').toContain(
        'make the final initiate request capture at least one of them as concrete delivery evidence',
      );
      expect(prompts[0] ?? '').not.toContain('system prompt');
      expect(prompts[0] ?? '').not.toContain(
        'MANDATORY FIRST ACTION: call read_session_summary now',
      );
    } finally {
      process.env.FAKE_CODEX_ARGS_LOG = undefined;
      process.env.FAKE_CODEX_PROMPT_LOG = undefined;
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

  it('fails auth-mode codex runs that start a turn without tool or artifact progress', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-idle-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      process.env.FAKE_CODEX_IDLE_AFTER_TURN = '1';
      process.env.FAKE_CODEX_CHATTER_AFTER_TURN = '1';
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = '1000';
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

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

      expect(result.outcome).toBe('error');
      expect(result.message).toContain('no required auth compile progress');
      expect(result.turns).toBe(1);
      expect(result.sessionId).toBe('fake-thread');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      process.env.FAKE_CODEX_IDLE_AFTER_TURN = undefined;
      process.env.FAKE_CODEX_CHATTER_AFTER_TURN = undefined;
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminates an MCP tool call that starts but never completes', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-active-tool-idle-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      process.env.FAKE_CODEX_STALL_ACTIVE_TOOL = '1';
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = '1000';
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

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

      expect(result.outcome).toBe('error');
      expect(result.message).toContain('no required auth compile progress');
      expect(result.turns).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      process.env.FAKE_CODEX_STALL_ACTIVE_TOOL = undefined;
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminates the native child behind a stalled codex wrapper', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-wrapper-idle-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      process.env.FAKE_CODEX_WRAPPER_CHILD = '1';
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = '1000';
      const systemPromptPath = pathJoin(root, 'system.md');
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(systemPromptPath, 'system prompt', 'utf8');
      writeFileSync(sessionPath, JSON.stringify(fixtureSession()), 'utf8');

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

      expect(result.outcome).toBe('error');
      expect(result.message).toContain('no required auth compile progress');
      expect(result.sessionId).toBe('fake-child-thread');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      process.env.FAKE_CODEX_WRAPPER_CHILD = undefined;
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a real MCP event even when an artifact changes first', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-codex-auth-artifact-idle-'));
    try {
      const binDir = pathJoin(root, 'bin');
      const toolDir = pathJoin(root, 'tool');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(toolDir, { recursive: true });
      installFakeCodex(binDir);

      process.env.FAKE_CODEX_ARTIFACT_BEFORE_MCP = '1';
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = '1000';
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
      });

      expect(result.outcome).toBe('error');
      expect(result.message).toContain('no required auth compile progress');
      expect(result.turns).toBe(1);
    } finally {
      process.env.FAKE_CODEX_ARTIFACT_BEFORE_MCP = undefined;
      process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
