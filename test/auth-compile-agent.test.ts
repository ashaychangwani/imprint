import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { compileAuthAgent } from '../src/imprint/auth-compile-agent.ts';
import {
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authExternalVerification,
  authWorkflowHash,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
} from '../src/imprint/auth-compile-tools.ts';
import { __setAuthVerifierLadderForTest } from '../src/imprint/auth-verifier.ts';
import type { AuthToolPlan } from '../src/imprint/build-plan.ts';
import { type Session, type Workflow, WorkflowSchema } from '../src/imprint/types.ts';

const originalPath = process.env.PATH;
const originalHome = process.env.IMPRINT_HOME;

function session(): Session {
  return {
    site: 'fixture-site',
    startedAt: '2026-07-09T00:00:00.000Z',
    url: 'https://fixture.test/login',
    imprintVersion: '0.0.0-test',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function plan(): NonNullable<AuthToolPlan> {
  return {
    toolName: 'authenticate_fixture',
    credentialRequestSeqs: [1],
    authRequestSeqs: [1, 2],
    credentialNames: ['username', 'password'],
    captures: [],
    notes: 'Synthetic planner hints',
  };
}

function validWorkflow(): Workflow {
  return WorkflowSchema.parse({
    toolName: 'authenticate_fixture',
    toolKind: 'authenticate',
    intent: { description: 'Synthetic auth' },
    site: 'fixture-site',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Compiled action',
        default: 'begin',
        choices: ['begin', 'finish'],
      },
      { name: 'answer', type: 'string', description: 'Live answer' },
    ],
    requests: [
      {
        method: 'POST',
        url: 'https://fixture.test/begin',
        headers: {},
        captures: [{ source: 'json', name: 'ticket', path: 'ticket' }],
      },
      {
        method: 'POST',
        url: 'https://fixture.test/finish',
        headers: {},
        captures: [{ source: 'json', name: 'done', path: 'done', equals: true }],
      },
    ],
    authConfig: {
      entry: 'begin',
      actions: {
        begin: {
          parameters: [],
          steps: [{ request: 0, onError: 'fail' }],
          outcome: {
            type: 'pause',
            next: 'finish',
            evidence: ['ticket'],
            carry: ['ticket'],
            message: 'Provide the live answer.',
          },
        },
        finish: {
          parameters: ['answer'],
          steps: [{ request: 1, onError: 'fail' }],
          outcome: { type: 'success', evidence: ['done'] },
        },
      },
      persist: [],
      crossOriginCookieReinjection: false,
    },
  });
}

function writeWorkflow(dir: string, workflow: Workflow = validWorkflow()): void {
  writeFileSync(pathJoin(dir, 'workflow.json'), JSON.stringify(workflow), 'utf8');
}

afterEach(() => {
  process.env.PATH = originalPath;
  process.env.IMPRINT_HOME = originalHome;
  process.env.FAKE_CODEX_ARGS_LOG = undefined;
  process.env.FAKE_CODEX_TOOL_DIR = undefined;
  process.env.FAKE_CODEX_EARLY_STOP = undefined;
  process.env.FAKE_CODEX_PROMPT_CHECKPOINT = undefined;
  process.env.FAKE_CLAUDE_ARGS_LOG = undefined;
  process.env.FAKE_CLAUDE_TOOL_DIR = undefined;
  __setAuthVerifierLadderForTest(null);
});

describe('auth compile tools', () => {
  it('does not allow auth agents to write playbook.yaml', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-tools-'));
    try {
      const write = buildAuthCompileTools(session(), dir, '/tmp/session.json', {
        site: 'fixture-site',
        values: {},
      }).find((tool) => tool.name === 'write_file');
      expect(write).toBeDefined();
      const result = await write?.handler({
        relativePath: 'playbook.yaml',
        content: 'steps: []',
      });
      expect(result?.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks only the generic action-program contract', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-contract-'));
    try {
      const workflow = validWorkflow();
      const first = workflow.requests[0];
      if (!first) throw new Error('bad fixture');
      workflow.requests[0] = {
        ...first,
        url: 'https://fixture.test/start?code_challenge=fixture-dynamic',
        body: '{"b_hour":"12","name":"Fixture Device","items[0]":"opaque"}',
      };
      writeWorkflow(dir, workflow);
      expect(authWorkflowPreflightFailures(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid request, action, evidence, and retry references', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-invalid-'));
    try {
      const workflow = validWorkflow();
      const begin = workflow.authConfig?.actions.begin;
      if (!begin || begin.outcome.type !== 'pause') throw new Error('bad fixture');
      begin.steps = [{ request: 99, onError: 'retry' }];
      begin.outcome.next = 'missing';
      begin.outcome.evidence = ['unknown'];
      writeWorkflow(dir, workflow);
      const failures = authWorkflowPreflightFailures(dir).join('\n');
      expect(failures).toContain('missing request 99');
      expect(failures).toContain('onError="retry" without repeat bounds');
      expect(failures).toContain('unknown action "missing"');
      expect(failures).toContain('unknown evidence capture "unknown"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the public action selector to match the compiled actions', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-selector-'));
    try {
      const missing = validWorkflow();
      missing.parameters = missing.parameters.filter((parameter) => parameter.name !== 'action');
      writeWorkflow(dir, missing);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain('action selector');

      const mismatched = validWorkflow();
      const action = mismatched.parameters.find((parameter) => parameter.name === 'action');
      if (!action) throw new Error('bad fixture');
      action.choices = ['begin'];
      writeWorkflow(dir, mismatched);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain(
        'choices exactly match authConfig.actions',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown action-program fields instead of silently stripping them', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-strict-'));
    try {
      const workflow = validWorkflow();
      const begin = workflow.authConfig?.actions.begin;
      if (!begin) throw new Error('bad fixture');
      writeWorkflow(dir, {
        ...workflow,
        authConfig: {
          ...workflow.authConfig,
          actions: {
            ...workflow.authConfig?.actions,
            begin: { ...begin, undeclaredPolicy: true },
          },
        },
      } as Workflow);
      expect(authWorkflowPreflightFailures(dir).join('\n')).toContain('unrecognized_keys');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the latest live success to come from a declared success action', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-live-'));
    try {
      writeWorkflow(dir);
      const workflow = validWorkflow();
      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ action: 'begin', ok: true, workflowHash: authWorkflowHash(workflow) }),
      );
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true }).join('\n')).toContain(
        'does not declare a success outcome',
      );

      writeFileSync(
        pathJoin(dir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
        JSON.stringify({ action: 'finish', ok: true, workflowHash: authWorkflowHash(workflow) }),
      );
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true })).toEqual([]);

      const changed = validWorkflow();
      const changedRequest = changed.requests[1];
      if (!changedRequest) throw new Error('bad fixture');
      changedRequest.url = 'https://fixture.test/changed-after-verification';
      writeWorkflow(dir, changed);
      expect(authExternalVerification(dir, [], { requireLiveAttempt: true }).join('\n')).toContain(
        'changed after the most recent successful live auth verification',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires downstream header credentials in authConfig.persist', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-persist-'));
    try {
      writeWorkflow(dir);
      expect(
        authExternalVerification(dir, [
          { name: 'accessToken', usedAs: 'header:authorization' },
        ]).join('\n'),
      ).toContain('authConfig.persist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function installFakeCodex(binDir: string): void {
  const path = pathJoin(binDir, 'codex');
  const workflow = JSON.stringify(validWorkflow());
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.FAKE_CODEX_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_LOG, process.argv.slice(2).join('\\u0000') + '\\n', { flag: 'a' });
}
const toolDir = process.env.FAKE_CODEX_TOOL_DIR;
if (!toolDir) throw new Error('missing fake tool dir');
const resumed = process.argv.includes('resume');
const recoveryMarker = join(toolDir, '.fake-recovered');
if (process.env.FAKE_CODEX_EARLY_STOP && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), '{}');
} else if (process.env.FAKE_CODEX_EARLY_STOP && !existsSync(recoveryMarker)) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
  writeFileSync(recoveryMarker, '1');
} else if (process.env.FAKE_CODEX_PROMPT_CHECKPOINT && !resumed) {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'prompt_user', message: 'Confirm fixture action.' }));
} else if (resumed) {
  writeFileSync(join(toolDir, '.compile-done.json'), JSON.stringify({ verification: 'passed', summary: 'resumed' }));
} else {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  );
  chmodSync(path, 0o755);
}

function installFakeClaude(binDir: string): void {
  const path = pathJoin(binDir, 'claude');
  const workflow = JSON.stringify(validWorkflow());
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.FAKE_CLAUDE_ARGS_LOG) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n', { flag: 'a' });
}
const toolDir = process.env.FAKE_CLAUDE_TOOL_DIR;
if (!toolDir) throw new Error('missing fake tool dir');
if (process.argv.includes('--resume')) {
  writeFileSync(join(toolDir, '.compile-done.json'), JSON.stringify({ verification: 'passed', summary: 'resumed' }));
} else {
  writeFileSync(join(toolDir, 'workflow.json'), ${JSON.stringify(JSON.stringify(workflow))});
  writeFileSync(join(toolDir, '.compile-checkpoint.json'), JSON.stringify({ kind: 'run_verification', action: 'finish', parameters: { answer: 'fixture' } }));
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture-claude-session' }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture' }));
`,
  );
  chmodSync(path, 0o755);
}

describe('compileAuthAgent with Codex', () => {
  it('resumes the same Codex session after an arbitrary action checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      installFakeCodex(bin);
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(session()));

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli' },
        maxDurationMs: 30_000,
      });
      expect(result).toMatchObject({ success: true, outcome: 'done', turns: 2 });

      const commands = readFileSync(process.env.FAKE_CODEX_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\u0000'));
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('resume');
      expect(commands[1]).toContain('fixture-thread');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes Codex when a turn ends before a valid checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-recovery-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_ARGS_LOG = pathJoin(root, 'args.log');
      process.env.FAKE_CODEX_EARLY_STOP = '1';
      installFakeCodex(bin);
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(session()));

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));
      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({ success: true, outcome: 'done', turns: 3 });
      const commands = readFileSync(process.env.FAKE_CODEX_ARGS_LOG, 'utf8').trim().split('\n');
      expect(commands).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not charge user-input wait time against the compile deadline', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-codex-prompt-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CODEX_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CODEX_PROMPT_CHECKPOINT = '1';
      installFakeCodex(bin);
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(session()));

      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'codex-cli' },
        maxDurationMs: 3000,
        onPrompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 3200));
          return 'confirmed';
        },
      });

      expect(result).toMatchObject({ success: true, outcome: 'done' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('compileAuthAgent with Claude', () => {
  it('resumes the same Claude session after an arbitrary action checkpoint', async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-auth-claude-'));
    try {
      const bin = pathJoin(root, 'bin');
      const home = pathJoin(root, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      process.env.IMPRINT_HOME = home;
      process.env.FAKE_CLAUDE_TOOL_DIR = pathJoin(home, 'fixture-site', 'authenticate_fixture');
      process.env.FAKE_CLAUDE_ARGS_LOG = pathJoin(root, 'args.log');
      installFakeClaude(bin);
      const sessionPath = pathJoin(root, 'session.json');
      writeFileSync(sessionPath, JSON.stringify(session()));

      __setAuthVerifierLadderForTest(async () => ({
        result: { ok: true, data: { authenticated: true } },
        usedBackend: 'cdp-replay',
        attempts: [],
      }));
      const result = await compileAuthAgent({
        site: 'fixture-site',
        session: session(),
        sessionPath,
        authToolPlan: plan(),
        teachCredentials: {
          site: 'fixture-site',
          values: { username: 'fixture-user', password: 'fixture-pass' },
        },
        llmConfig: { provider: 'claude-cli' },
        maxDurationMs: 30_000,
      });

      expect(result).toMatchObject({ success: true, outcome: 'done', turns: 2 });
      const commands = readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain('--resume');
      expect(commands[1]).toContain('fixture-claude-session');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
