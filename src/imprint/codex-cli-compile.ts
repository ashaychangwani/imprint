/**
 * compile-agent driver for codex-cli.
 *
 * Codex CLI can run non-interactively with JSONL progress and stdio MCP
 * servers. This mirrors the claude-cli compile path: expose the compile tools
 * through the existing MCP server, let Codex drive the agent loop, and accept
 * success only after the MCP done() tool writes the verified sentinel.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { CompileAgentProgress, CompileAgentResult } from './compile-agent-types.ts';
import { preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { COMPILE_SENTINELS } from './mcp-compile-server.ts';
import type { Session } from './types.ts';

const log = createLog('compile-codex-cli');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const MCP_SERVER_NAME = 'imprint-compile';
const MAX_VERIFICATION_CYCLES = 5;

interface CompileViaCodexCliOptions {
  session: Session;
  absoluteExampleDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  keepTest?: boolean;
}

interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    tool_name?: string;
    tool?: string;
    server?: string;
    command?: string[];
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
}

export async function compileViaCodexCli(
  opts: CompileViaCodexCliOptions,
): Promise<CompileAgentResult> {
  mkdirSync(opts.absoluteExampleDir, { recursive: true });
  for (const name of [COMPILE_SENTINELS.done, COMPILE_SENTINELS.giveUp]) {
    const p = pathJoin(opts.absoluteExampleDir, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // best effort
      }
    }
  }

  const bunPath = process.execPath;
  const sessionPathAbs = opts.sessionPath.startsWith('/')
    ? opts.sessionPath
    : pathJoin(REPO_ROOT, opts.sessionPath);
  const mcpArgs = [
    'run',
    CLI_PATH,
    '__mcp-compile-server',
    '--session-path',
    sessionPathAbs,
    '--example-dir',
    opts.absoluteExampleDir,
  ];

  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(opts.systemPromptPath, 'utf8');
  } catch (err) {
    return finalErrorResult(opts, `failed to read system prompt: ${errMsg(err)}`);
  }

  const initialPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

A new compile task is starting.

Session path: ${sessionPathAbs}
Example directory: ${opts.absoluteExampleDir}
You will write artifacts into the example directory.

Use the imprint-compile MCP tools to inspect the session, write artifacts, run tests, and call done(). Begin by calling read_session_summary, then proceed per the system instructions.`;

  const args = [
    '-a',
    'never',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C',
    REPO_ROOT,
    '-s',
    'workspace-write',
    '-m',
    preferredAgentModel('codex-cli'),
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(bunPath)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(mcpArgs)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode=${JSON.stringify('approve')}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=300`,
    '-c',
    'shell_environment_policy.inherit=all',
    '-',
  ];

  log(`spawning codex (mcp-server=${MCP_SERVER_NAME})`);

  let child: ChildProcess;
  try {
    child = spawn('codex', args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return finalErrorResult(opts, `failed to spawn codex-cli: ${errMsg(err)}`);
  }

  try {
    child.stdin?.end(initialPrompt);
  } catch (err) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    return finalErrorResult(opts, `failed to send prompt to codex-cli: ${errMsg(err)}`);
  }

  return await driveJsonl(child, opts);
}

async function driveJsonl(
  child: ChildProcess,
  opts: CompileViaCodexCliOptions,
): Promise<CompileAgentResult> {
  const conversationLog: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turn = 0;
  let lastErrorMessage = '';
  let stderrBuf = '';

  const budgetMs = Math.max(0, opts.deadlineMs - Date.now());
  const fireProgress = (phase: 'thinking' | 'tool', toolName?: string): void => {
    opts.onProgress?.({
      turn,
      phase,
      toolName,
      elapsedMs: Date.now() - opts.startTime,
      budgetMs,
      inputTokens,
      outputTokens,
      verificationCycle: 1,
      maxVerificationCycles: MAX_VERIFICATION_CYCLES,
    });
  };

  const doneSentinel = pathJoin(opts.absoluteExampleDir, COMPILE_SENTINELS.done);
  const giveUpSentinel = pathJoin(opts.absoluteExampleDir, COMPILE_SENTINELS.giveUp);

  const sentinelTimer = setInterval(() => {
    if (!existsSync(doneSentinel) && !existsSync(giveUpSentinel)) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }, 500);

  const deadlineTimer = setTimeout(
    () => {
      log('wall-clock deadline exceeded, terminating codex');
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      } catch {
        // already gone
      }
    },
    Math.max(0, opts.deadlineMs - Date.now()),
  );

  let stdoutBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    while (true) {
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;

      let evt: CodexJsonEvent;
      try {
        evt = JSON.parse(line) as CodexJsonEvent;
      } catch (err) {
        log(`unparseable jsonl line: ${errMsg(err)}`);
        continue;
      }

      conversationLog.push(evt);

      if (evt.type === 'thread.started') {
        log(`thread_id=${evt.thread_id ?? '(none)'}`);
        continue;
      }

      if (evt.type === 'turn.started') {
        turn++;
        fireProgress('thinking');
        continue;
      }

      if ((evt.type === 'item.started' || evt.type === 'item.completed') && evt.item) {
        const toolName = codexToolName(evt.item);
        if (toolName) fireProgress('tool', toolName);
        continue;
      }

      if (evt.type === 'turn.completed' && evt.usage) {
        inputTokens += evt.usage.input_tokens ?? 0;
        outputTokens += evt.usage.output_tokens ?? 0;
        continue;
      }

      if (evt.type === 'error' || evt.type === 'turn.failed') {
        lastErrorMessage = evt.message ?? evt.error?.message ?? JSON.stringify(evt);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderrBuf += s;
    log(`[codex stderr] ${s.trim()}`);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? -1));
    child.once('error', () => resolve(-1));
  });
  clearInterval(sentinelTimer);
  clearTimeout(deadlineTimer);

  if (stdoutBuf.trim()) {
    log(`unflushed stdout tail (${stdoutBuf.length} bytes) discarded`);
  }

  const conversationLogPath = pathJoin(opts.absoluteExampleDir, '.compile-log.json');
  try {
    writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');
  } catch (err) {
    log(`failed to persist conversation log: ${errMsg(err)}`);
  }

  const workflowPath = pathJoin(opts.absoluteExampleDir, 'workflow.json');
  const parserPath = pathJoin(opts.absoluteExampleDir, 'parser.ts');
  const parserTestPath = pathJoin(opts.absoluteExampleDir, 'parser.test.ts');

  const verifiedOk =
    existsSync(doneSentinel) &&
    (() => {
      try {
        const raw = readFileSync(doneSentinel, 'utf8').trim();
        return raw ? JSON.parse(raw).verification === 'passed' : false;
      } catch {
        return false;
      }
    })();
  if (verifiedOk && !opts.keepTest && existsSync(parserTestPath)) {
    try {
      unlinkSync(parserTestPath);
    } catch {
      // best effort
    }
  }

  const baseResult: Pick<
    CompileAgentResult,
    | 'workflowPath'
    | 'parserPath'
    | 'parserTestPath'
    | 'conversationLogPath'
    | 'turns'
    | 'durationMs'
    | 'inputTokens'
    | 'outputTokens'
  > = {
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    parserPath: existsSync(parserPath) ? parserPath : undefined,
    parserTestPath: existsSync(parserTestPath) ? parserTestPath : undefined,
    conversationLogPath,
    turns: turn,
    durationMs: Date.now() - opts.startTime,
    inputTokens,
    outputTokens,
  };

  if (Date.now() > opts.deadlineMs && !existsSync(doneSentinel) && !existsSync(giveUpSentinel)) {
    return {
      success: false,
      outcome: 'timeout',
      message: `codex-cli exceeded the ${Math.round((opts.deadlineMs - opts.startTime) / 60000)} minute deadline before completing.`,
      ...baseResult,
    };
  }

  if (existsSync(doneSentinel)) {
    let payload: {
      summary?: string;
      verification?: string;
      cycles?: number;
      failures?: string[];
    } = {};
    try {
      const raw = readFileSync(doneSentinel, 'utf8').trim();
      if (raw) payload = JSON.parse(raw);
    } catch (err) {
      log(`failed to parse done sentinel: ${errMsg(err)}`);
    }
    if (payload.verification === 'passed') {
      return {
        success: true,
        outcome: 'done',
        message: payload.summary ?? 'Task completed',
        ...baseResult,
      };
    }
    return {
      success: false,
      outcome: 'error',
      message: `Verification failed after ${payload.cycles ?? '?'} cycles. Final failures:\n${(payload.failures ?? []).join('\n')}`,
      ...baseResult,
    };
  }

  if (existsSync(giveUpSentinel)) {
    let payload: { reason?: string; what_was_tried?: string } = {};
    try {
      const raw = readFileSync(giveUpSentinel, 'utf8').trim();
      if (raw) payload = JSON.parse(raw);
    } catch (err) {
      log(`failed to parse give_up sentinel: ${errMsg(err)}`);
    }
    return {
      success: false,
      outcome: 'give_up',
      message: `Agent gave up: ${payload.reason ?? 'unknown reason'}\n${payload.what_was_tried ?? ''}`,
      ...baseResult,
    };
  }

  if (exitCode === 0) {
    return {
      success: false,
      outcome: 'soft_cap',
      message: 'codex-cli exited without calling done() or give_up(). It may have stopped early.',
      ...baseResult,
    };
  }

  const errorTail = lastErrorMessage || stderrBuf.trim().slice(-500);
  return {
    success: false,
    outcome: 'error',
    message: `codex-cli exited with code ${exitCode}${errorTail ? `\n${errorTail}` : ''}`,
    ...baseResult,
  };
}

function codexToolName(item: NonNullable<CodexJsonEvent['item']>): string | undefined {
  const type = item.type ?? '';
  if (type === 'agent_message') return undefined;
  const name = item.name ?? item.tool_name ?? item.tool;
  if (!name) return undefined;
  return name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
}

function finalErrorResult(opts: CompileViaCodexCliOptions, message: string): CompileAgentResult {
  mkdirSync(opts.absoluteExampleDir, { recursive: true });
  const conversationLogPath = pathJoin(opts.absoluteExampleDir, '.compile-log.json');
  try {
    writeFileSync(conversationLogPath, JSON.stringify({ error: message }, null, 2), 'utf8');
  } catch {
    // best effort
  }
  return {
    success: false,
    outcome: 'error',
    message,
    conversationLogPath,
    turns: 0,
    durationMs: Date.now() - opts.startTime,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
