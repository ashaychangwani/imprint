/**
 * compile-agent driver for codex-cli.
 *
 * Codex CLI can run non-interactively with JSONL progress and stdio MCP
 * servers. This mirrors the claude-cli compile path: expose the compile tools
 * through the existing MCP server, let Codex drive the agent loop, and accept
 * success only after the MCP done() tool writes the verified sentinel.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute as pathIsAbsolute, join as pathJoin } from 'node:path';
import { type Span, context as otelContext } from '@opentelemetry/api';
import type { AuthCliCompileMode } from './auth-compile-tools.ts';
import { type SharedModuleManifestEntry, resolvePlanSliceFromFile } from './build-plan.ts';
import type {
  AuthCheckpoint,
  CompileAgentProgress,
  CompileAgentResult,
  CompileVerificationMode,
} from './compile-agent-types.ts';
import {
  formatCandidateContext,
  formatCompileVerificationMode,
  formatToolPlan,
} from './compile-agent-types.ts';
import { parseCompileDoneSentinel } from './compile-done-sentinel.ts';
import {
  type CompileProviderControl,
  compileProviderInterruptionError,
  createCompileProviderControl,
  watchCompileProviderDeadline,
} from './compile-provider-control.ts';
import type { CompileStrategyKind } from './compile-strategy.ts';
import { recordCompilerHostError } from './compiler-log.ts';
import {
  collectOwnedProcess,
  spawnOwnedProcess,
  terminateCompilerProcessTree,
} from './compiler-process.ts';
import { cliExitError, preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { COMPILE_SENTINELS } from './mcp-compile-server.ts';
import {
  ProviderReportedError,
  type RunDeadlineRef,
  resolvedRunDeadline,
} from './provider-retry.ts';
import { ProviderTerminalAccumulator } from './provider-terminal.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  endTraceSpan,
  recordLlmUsageSpan,
  setSpanAttributes,
  startTraceSpan,
  traceInputOutputAttributes,
  traceJsonInputOutputAttributes,
  traceLlmIoEnabled,
  traceToolIoEnabled,
  traced,
} from './tracing.ts';
import type { SharedTriageSelection } from './triage-selection.ts';
import type { Session } from './types.ts';

const log = createLog('compile-codex-cli');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const MCP_SERVER_NAME = 'imprint-compile';
const MAX_VERIFICATION_CYCLES = 5;
const MAX_MCP_TOOL_TIMEOUT_SEC = 1800;
const SENTINEL_USAGE_GRACE_MS = 15_000;

interface SentinelGraceController {
  observeSentinel(): void;
  observeTurnCompleted(): void;
  dispose(): void;
}

interface TurnActivityTracker {
  isActive(): boolean;
  started(): void;
  completed(): void;
}

/** Track Codex turn lifecycle without depending on optional tracing spans. */
export function createTurnActivityTracker(): TurnActivityTracker {
  let active = false;
  return {
    isActive: () => active,
    started: () => {
      active = true;
    },
    completed: () => {
      active = false;
    },
  };
}

/**
 * Wait just long enough for the terminal Codex usage event after done/give_up.
 * A completed turn terminates immediately; the timer is only a bounded fallback
 * for CLI versions that never emit turn.completed.
 */
export function createSentinelGraceController(opts: {
  hasActiveTurn: () => boolean;
  terminate: () => void;
  fallbackMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): SentinelGraceController {
  const schedule = opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = opts.cancel ?? clearTimeout;
  let sentinelObserved = false;
  let terminated = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const terminateOnce = (): void => {
    if (terminated) return;
    terminated = true;
    if (fallbackTimer) cancel(fallbackTimer);
    fallbackTimer = undefined;
    opts.terminate();
  };

  return {
    observeSentinel(): void {
      sentinelObserved = true;
      if (!opts.hasActiveTurn()) {
        terminateOnce();
        return;
      }
      if (fallbackTimer || terminated) return;
      fallbackTimer = schedule(terminateOnce, opts.fallbackMs ?? SENTINEL_USAGE_GRACE_MS);
      fallbackTimer.unref?.();
    },
    observeTurnCompleted(): void {
      if (sentinelObserved) terminateOnce();
    },
    dispose(): void {
      if (fallbackTimer) cancel(fallbackTimer);
      fallbackTimer = undefined;
    },
  };
}

function formatRevisionMode(enabled: boolean | undefined): string {
  return enabled
    ? 'REVISION MODE: inspect read_session_summary.revisionContext and the listed existing artifacts/diagnostics first. Preserve proven behavior; repair or honestly narrow only what evidence contradicts.'
    : '';
}

interface CompileViaCodexCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  runDeadline?: RunDeadlineRef;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  onDeadlineReached?: () => Promise<number | null | undefined>;
  signal?: AbortSignal;
  keepTest?: boolean;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Per-tool implementation plan injected into the agent's initial message. */
  toolPlan?: string;
  /** Master-accepted execution strategy for this focused compile. */
  strategyKind?: CompileStrategyKind;
  /** Revise existing generated artifacts from durable verification feedback. */
  revisionMode?: boolean;
  /** Master-only deterministic MVP boundary. */
  verificationMode?: CompileVerificationMode;
  /** Shared triage result for irreversible-effect propagation in the MCP server. */
  sharedTriageSelection?: SharedTriageSelection;
  /** Present → drive an auth compile rather than a data compile. */
  authMode?: AuthCliCompileMode;
  resume?: { sessionId: string; message: string };
  /** Explicit model selected by the caller. Defaults to the provider preference. */
  model?: string;
}

interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  response_item?: unknown;
  event_msg?: unknown;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    content?: unknown;
    name?: string;
    tool_name?: string;
    tool?: string;
    server?: string;
    command?: string[];
    arguments?: unknown;
    args?: unknown;
    input?: unknown;
    result?: unknown;
    output?: unknown;
    error?: unknown;
    status?: string;
    is_error?: boolean;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  message?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
    status?: number;
    status_code?: number;
  };
  status?: number;
  status_code?: number;
  error_code?: string;
  is_error?: boolean;
}

export async function compileViaCodexCli(
  opts: CompileViaCodexCliOptions,
): Promise<CompileAgentResult> {
  return await traced(
    'compile.codex_cli_agent',
    'AGENT',
    {
      'imprint.site': opts.session.site,
      'imprint.tool_name': opts.candidate?.toolName,
      'imprint.session_path': opts.sessionPath,
      'imprint.tool_dir': opts.absoluteToolDir,
      'imprint.model': opts.model ?? preferredAgentModel('codex-cli'),
    },
    async (span) => {
      const result = await compileViaCodexCliImpl(opts, span);
      const model = opts.model ?? preferredAgentModel('codex-cli');
      setSpanAttributes(span, {
        'imprint.compile.outcome': result.outcome,
        'imprint.compile.success': result.success,
        'imprint.compile.turns': result.turns,
        'imprint.compile.duration_ms': result.durationMs,
        'imprint.compile.input_tokens': result.inputTokens,
        'imprint.compile.output_tokens': result.outputTokens,
        'imprint.compile.conversation_log': result.conversationLogPath,
      });
      // Codex reports input_tokens as the total prompt; cached_input_tokens is
      // a subset, not an additional token bucket.
      recordLlmUsageSpan(
        'compile.codex_cli_usage',
        {
          provider: 'codex-cli',
          model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheWriteTokens: result.cacheCreationInputTokens,
        },
        { 'imprint.compile.turns': result.turns },
      );
      return result;
    },
  );
}

async function compileViaCodexCliImpl(
  opts: CompileViaCodexCliOptions,
  traceSpan?: Span,
): Promise<CompileAgentResult> {
  const runDeadline = resolvedRunDeadline(opts.runDeadline, opts.deadlineMs);
  mkdirSync(opts.absoluteToolDir, { recursive: true });
  const staleSentinels = [
    COMPILE_SENTINELS.done,
    COMPILE_SENTINELS.giveUp,
    COMPILE_SENTINELS.checkpoint,
    ...(!opts.resume ? [COMPILE_SENTINELS.verificationState] : []),
  ];
  for (const name of staleSentinels) {
    const p = pathJoin(opts.absoluteToolDir, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // best effort
      }
    }
  }

  const bunPath = process.execPath;
  const sessionPathAbs = pathIsAbsolute(opts.sessionPath)
    ? opts.sessionPath
    : pathJoin(REPO_ROOT, opts.sessionPath);

  let systemPrompt: string;
  try {
    systemPrompt = `${readFileSync(opts.systemPromptPath, 'utf8')}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
  } catch (err) {
    return finalErrorResult(opts, `failed to read system prompt: ${errMsg(err)}`);
  }

  // Auth and data compiles share the spawn + JSONL driver below; only the MCP
  // server args and the initial prompt body differ. Auth compiles are resumable
  // segments; resumed segments get only the orchestrator result as the next
  // user message because Codex restores the prior conversation by session id.
  let mcpArgs: string[];
  let initialPrompt: string;

  if (opts.authMode) {
    mcpArgs = [
      'run',
      CLI_PATH,
      '__mcp-compile-server',
      '--session-path',
      sessionPathAbs,
      '--tool-dir',
      opts.absoluteToolDir,
      '--site',
      opts.authMode.site,
      '--auth-plan-json',
      opts.authMode.authPlanJson,
    ];
    initialPrompt = opts.resume
      ? opts.resume.message
      : buildAuthCodexInitialPrompt(systemPrompt, opts.authMode.initialPrompt);
  } else {
    mcpArgs = [
      'run',
      CLI_PATH,
      '__mcp-compile-server',
      '--session-path',
      sessionPathAbs,
      '--tool-dir',
      opts.absoluteToolDir,
      '--provider',
      'codex-cli',
      ...(opts.candidate ? ['--candidate-json', JSON.stringify(opts.candidate)] : []),
      ...(opts.sharedContext ? ['--shared-context-json', JSON.stringify(opts.sharedContext)] : []),
      ...(opts.buildPlanPath ? ['--build-plan-path', opts.buildPlanPath] : []),
      ...(opts.sharedModules ? ['--shared-modules-json', JSON.stringify(opts.sharedModules)] : []),
      ...(opts.strategyKind ? ['--strategy-kind', opts.strategyKind] : []),
      ...(opts.revisionMode ? ['--revision-mode'] : []),
      ...(opts.verificationMode ? ['--verification-mode', opts.verificationMode] : []),
      ...(opts.sharedTriageSelection
        ? ['--shared-triage-json', JSON.stringify(opts.sharedTriageSelection)]
        : []),
    ];
    const { assignedSharedModules } = resolvePlanSliceFromFile(
      opts.buildPlanPath,
      opts.candidate?.toolName,
      opts.sharedModules,
    );
    initialPrompt = opts.resume
      ? opts.resume.message
      : `<system_instructions>
${systemPrompt}
</system_instructions>

A new compile task is starting.

Session path: ${sessionPathAbs}
Tool directory: ${opts.absoluteToolDir}
You will write artifacts into the tool directory.
${formatCandidateContext(opts.candidate, opts.sharedContext, assignedSharedModules)}
${formatToolPlan(opts.toolPlan)}
${formatRevisionMode(opts.revisionMode)}
${formatCompileVerificationMode(opts.verificationMode)}

Use the imprint-compile MCP tools to inspect the session, write artifacts, run tests, and call done(). Begin by calling read_session_summary, then proceed per the system instructions.`;
  }

  const model = opts.model ?? preferredAgentModel('codex-cli');
  const captureLlmIo = traceLlmIoEnabled();
  // done() owns a separately bounded live-verification phase, so its transport
  // timeout cannot be derived from the compiler's remaining reasoning budget.
  const mcpToolTimeoutSec = MAX_MCP_TOOL_TIMEOUT_SEC;
  setSpanAttributes(traceSpan, {
    ...(captureLlmIo ? traceInputOutputAttributes('input', initialPrompt) : {}),
    'imprint.compile.initial_prompt_chars': initialPrompt.length,
    'imprint.compile.command': 'codex exec',
    'imprint.compile.sandbox': 'workspace-write',
    'imprint.compile.tool_timeout_sec': mcpToolTimeoutSec,
  });

  const execArgs = opts.resume ? ['exec', 'resume'] : ['exec'];

  const args = [
    '-a',
    'never',
    '-C',
    opts.absoluteToolDir,
    '-s',
    'workspace-write',
    '-m',
    model,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(bunPath)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(mcpArgs)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode=${JSON.stringify('approve')}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${mcpToolTimeoutSec}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.required=true`,
    '-c',
    'shell_environment_policy.inherit=all',
    ...execArgs,
    // Compiler subprocesses need only the explicitly configured imprint MCP
    // server. Desktop plugins add unrelated tools/instructions and can delay the
    // mandatory first auth MCP call long enough to trip the progress watchdog.
    '--disable',
    'plugins',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    ...(opts.resume ? [opts.resume.sessionId] : []),
    '-',
  ];

  log(
    `spawning codex (mcp-server=${MCP_SERVER_NAME}${opts.resume ? `, resume=${opts.resume.sessionId.slice(0, 8)}` : ''})`,
  );

  const providerControl = createCompileProviderControl(runDeadline ?? opts.deadlineMs);
  providerControl.updateSession(opts.resume?.sessionId);
  const childEnv = { ...process.env, ...providerControl.env };
  // spawnOwnedProcess merges the parent environment, so an explicit undefined
  // is required to remove this host-only payload from the child.
  childEnv.IMPRINT_TEACH_CREDENTIALS = undefined;
  let child: ChildProcess;
  try {
    child = spawnOwnedProcess('codex', args, {
      cwd: opts.absoluteToolDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The npm `codex` launcher is a Node wrapper around the native binary.
      // Give the wrapper and its descendants a dedicated process group so a
      // watchdog can terminate the whole tree, including descendants that keep
      // the inherited stdout pipe open after the wrapper exits.
    });
  } catch (err) {
    providerControl.dispose();
    return finalErrorResult(opts, `failed to spawn codex-cli: ${errMsg(err)}`);
  }

  try {
    await sendCompilerPrompt(child, initialPrompt);
  } catch (err) {
    terminateCompilerProcessTree(child);
    await collectOwnedProcess(child).catch(() => undefined);
    providerControl.dispose();
    return finalErrorResult(opts, `failed to send prompt to codex-cli: ${errMsg(err)}`);
  }

  try {
    const result = await driveJsonl(child, opts, traceSpan, providerControl);
    setSpanAttributes(traceSpan, {
      'imprint.compile.message': result.message,
      ...(captureLlmIo ? traceInputOutputAttributes('output', result.message) : {}),
    });
    return result;
  } finally {
    providerControl.dispose();
  }
}

function sendCompilerPrompt(child: ChildProcess, prompt: string): Promise<void> {
  const input = child.stdin;
  if (!input) return Promise.reject(new Error('codex-cli stdin is unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      child.removeListener('error', fail);
      input.removeListener('error', fail);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    child.once('error', fail);
    input.once('error', fail);
    input.end(prompt, finish);
  });
}

function buildAuthCodexInitialPrompt(systemPrompt: string, initialPrompt: string): string {
  return `<system_instructions>
${systemPrompt}
</system_instructions>

${initialPrompt}

Codex provider framing: use only the imprint-compile MCP tools exposed for this task. Your first response must be the requested read_session_summary tool call, without preceding prose.`;
}

async function driveJsonl(
  child: ChildProcess,
  opts: CompileViaCodexCliOptions,
  traceSpan: Span | undefined,
  providerControl: CompileProviderControl,
): Promise<CompileAgentResult> {
  // Bun's child-process event emitters do not preserve AsyncLocalStorage.
  // Restore the compile span context inside stdout callbacks so turn/tool
  // spans remain children of compile.codex_cli_agent in Phoenix.
  const parentCtx = otelContext.active();
  const conversationLogPath = pathJoin(opts.absoluteToolDir, '.compile-log.json');
  const conversationLog: unknown[] = (() => {
    if (!opts.resume || !existsSync(conversationLogPath)) return [];
    try {
      const prior = JSON.parse(readFileSync(conversationLogPath, 'utf8'));
      return Array.isArray(prior) ? prior : [];
    } catch {
      return [];
    }
  })();
  const rawStdoutPath = pathJoin(opts.absoluteToolDir, '.codex-stdout.jsonl');
  const rawStderrPath = pathJoin(opts.absoluteToolDir, '.codex-stderr.log');
  const flushLog = (): void => {
    try {
      writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');
    } catch {}
  };
  let flushLogTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLogFlush = (): void => {
    if (flushLogTimer) return;
    flushLogTimer = setTimeout(() => {
      flushLogTimer = undefined;
      flushLog();
    }, 50);
    flushLogTimer.unref?.();
  };
  const rawStdoutChunks: string[] = [];
  const rawStderrChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let turn = 0;
  const terminalParser = new ProviderTerminalAccumulator('codex-cli');
  let stderrBuf = '';
  let agentMessageCount = 0;
  let processErrorMessage = '';
  let capturedSessionId: string | undefined = opts.resume?.sessionId;
  const toolSpans = new Map<string, Span>();
  let currentTurnSpan: Span | null = null;
  const turnActivity = createTurnActivityTracker();
  let onTurnCompletedAfterSentinel: (() => void) | undefined;

  const runDeadline = providerControl.deadline;
  const budgetMs = Math.max(0, runDeadline.deadlineMs - Date.now());
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
      maxVerificationCycles: opts.authMode ? undefined : MAX_VERIFICATION_CYCLES,
    });
  };

  const doneSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.done);
  const giveUpSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.giveUp);
  const checkpointSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.checkpoint);
  const workflowPath = pathJoin(opts.absoluteToolDir, 'workflow.json');
  const parserPath = pathJoin(opts.absoluteToolDir, 'parser.ts');
  const parserTestPath = pathJoin(opts.absoluteToolDir, 'parser.test.ts');
  const terminateChild = (graceMs: number): void => {
    try {
      terminateCompilerProcessTree(child, 'SIGTERM', graceMs);
    } catch {
      // already gone
    }
  };
  const deadlineWatch = watchCompileProviderDeadline(
    providerControl,
    opts.onDeadlineReached,
    () => {
      log('wall-clock deadline exceeded, terminating codex');
      terminateChild(5000);
    },
  );

  const onStdoutLine = (rawLine: string): void => {
    otelContext.with(parentCtx, () => {
      const line = rawLine.trim();
      if (!line) return;

      let evt: CodexJsonEvent;
      try {
        evt = JSON.parse(line) as CodexJsonEvent;
      } catch (err) {
        log(`unparseable jsonl line: ${errMsg(err)}`);
        return;
      }

      conversationLog.push(evt);
      terminalParser.ingest(evt as unknown as Record<string, unknown>);
      scheduleLogFlush();

      if (evt.type === 'thread.started') {
        log(`thread_id=${evt.thread_id ?? '(none)'}`);
        setSpanAttributes(traceSpan, { 'codex.thread_id': evt.thread_id });
        if (evt.thread_id) {
          capturedSessionId = evt.thread_id;
          providerControl.updateSession(evt.thread_id);
        }
        return;
      }

      if (evt.type === 'turn.started') {
        turnActivity.started();
        if (currentTurnSpan) endTraceSpan(currentTurnSpan);
        flushLog();
        turn++;
        currentTurnSpan = startTraceSpan(`agent.turn.${turn}`, 'CHAIN', {
          'imprint.agent.turn': turn,
          'imprint.agent.cumulative_input_tokens': inputTokens,
          'imprint.agent.cumulative_output_tokens': outputTokens,
        });
        fireProgress('thinking');
        return;
      }

      const normalizedToolEvt = normalizeCodexToolEvent(evt);
      if (normalizedToolEvt) {
        const { eventType, item } = normalizedToolEvt;
        const toolName = codexToolName(item);
        if (toolName) {
          traceCodexToolEvent(toolSpans, eventType, item, toolName);
          fireProgress(eventType === 'item.started' ? 'tool' : 'thinking', toolName);
        }
        return;
      }

      if ((evt.type === 'item.started' || evt.type === 'item.completed') && evt.item) {
        const agentMessage = codexAgentMessageText(evt.item);
        if (agentMessage && evt.type === 'item.completed') {
          agentMessageCount++;
          setSpanAttributes(traceSpan, {
            'imprint.codex.agent_messages': agentMessageCount,
            'imprint.codex.last_agent_message_chars': agentMessage.length,
            ...(traceLlmIoEnabled()
              ? traceInputOutputAttributes('output', agentMessage, undefined, 'agent_message')
              : {}),
          });
          return;
        }
        return;
      }

      if (evt.type === 'turn.completed') {
        const turnInput = evt.usage?.input_tokens ?? 0;
        const turnOutput = evt.usage?.output_tokens ?? 0;
        const turnCacheRead = evt.usage?.cached_input_tokens ?? 0;
        const turnCacheWrite = evt.usage?.cache_write_input_tokens ?? 0;
        inputTokens += turnInput;
        outputTokens += turnOutput;
        cacheReadInputTokens += turnCacheRead;
        cacheCreationInputTokens += turnCacheWrite;
        if (currentTurnSpan) {
          setSpanAttributes(currentTurnSpan, {
            'imprint.agent.turn_input_tokens': turnInput,
            'imprint.agent.turn_output_tokens': turnOutput,
            'imprint.agent.turn_cache_read_input_tokens': turnCacheRead,
            'imprint.agent.turn_cache_creation_input_tokens': turnCacheWrite,
          });
          endTraceSpan(currentTurnSpan);
          currentTurnSpan = null;
        }
        turnActivity.completed();
        onTurnCompletedAfterSentinel?.();
        return;
      }
    });
  };

  const onStderrChunk = (s: string): void => {
    rawStderrChunks.push(s);
    stderrBuf += s;
    log(`[codex stderr] ${s.trim()}`);
  };

  const sentinelGrace = createSentinelGraceController({
    hasActiveTurn: turnActivity.isActive,
    terminate: () => terminateCompilerProcessTree(child, 'SIGTERM', 2_000),
  });
  onTurnCompletedAfterSentinel = sentinelGrace.observeTurnCompleted;
  const sentinelTimer = setInterval(() => {
    const checkpointReached = opts.authMode && existsSync(checkpointSentinel);
    if (!existsSync(doneSentinel) && !existsSync(giveUpSentinel) && !checkpointReached) return;
    sentinelGrace.observeSentinel();
  }, 500);
  const stopProviderWatch = providerControl.watch(() => terminateChild(2_000));

  let exitCode: number;
  try {
    const output = await collectOwnedProcess(child, {
      signal: opts.signal,
      onStdoutLine,
      onStdoutChunk: (chunk) => rawStdoutChunks.push(chunk),
      onStderrChunk,
    });
    exitCode = output.exitCode ?? -1;
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    processErrorMessage = errMsg(error);
    exitCode = -1;
  } finally {
    stopProviderWatch();
    sentinelGrace.dispose();
    onTurnCompletedAfterSentinel = undefined;
    clearInterval(sentinelTimer);
    deadlineWatch.dispose();
  }
  turnActivity.completed();
  if (currentTurnSpan) endTraceSpan(currentTurnSpan);
  for (const span of toolSpans.values()) endTraceSpan(span);
  toolSpans.clear();

  try {
    writeFileSync(rawStdoutPath, rawStdoutChunks.join(''), {
      encoding: 'utf8',
      flag: opts.resume ? 'a' : 'w',
    });
    writeFileSync(rawStderrPath, rawStderrChunks.join(''), {
      encoding: 'utf8',
      flag: opts.resume ? 'a' : 'w',
    });
  } catch {
    // best effort diagnostics
  }
  if (flushLogTimer) clearTimeout(flushLogTimer);
  if (processErrorMessage) {
    recordCompilerHostError(
      conversationLogPath,
      `codex-cli process failed before emitting events: ${processErrorMessage}`,
    );
  } else {
    flushLog();
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
    | 'cacheReadInputTokens'
    | 'cacheCreationInputTokens'
    | 'sessionId'
  > = {
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    parserPath: existsSync(parserPath) ? parserPath : undefined,
    parserTestPath: existsSync(parserTestPath) ? parserTestPath : undefined,
    conversationLogPath,
    turns: turn,
    durationMs: Date.now() - opts.startTime,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    sessionId: capturedSessionId,
  };

  terminalParser.ingestStderr(stderrBuf);
  const terminal = terminalParser.result();
  if (terminal.providerError) {
    return {
      success: false,
      outcome: 'error',
      message: `codex-cli provider turn failed${exitCode === 0 ? '' : ` (exit ${exitCode})`}\n${terminal.providerError.providerMessages.join('\n') || 'unknown provider error'}`,
      providerInterruption: terminal.interruption,
      providerError: terminal.providerError,
      ...baseResult,
    };
  }

  const nestedInterruption = providerControl.interruption();
  if (nestedInterruption) {
    const providerError = compileProviderInterruptionError(nestedInterruption);
    return {
      success: false,
      outcome: 'error',
      message: `nested live verifier provider ${nestedInterruption.reason}`,
      providerInterruption: providerError.interruption,
      providerError,
      ...baseResult,
      sessionId: nestedInterruption.sessionId ?? baseResult.sessionId,
    };
  }

  if (deadlineWatch.expired) {
    const providerError = compileProviderInterruptionError({
      reason: 'deadline',
      deadlineMs: runDeadline.deadlineMs,
    });
    return {
      success: false,
      outcome: 'error',
      message: 'codex-cli reached the run deadline',
      providerInterruption: providerError.interruption,
      providerError,
      ...baseResult,
    };
  }

  // Auth segment: the agent paused at a checkpoint for the orchestrator to act.
  // The auth orchestrator resumes the same Codex session with the checkpoint
  // result after running live verification.
  if (opts.authMode && existsSync(checkpointSentinel)) {
    let cp: AuthCheckpoint | undefined;
    try {
      const raw = readFileSync(checkpointSentinel, 'utf8').trim();
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      if (parsed && typeof parsed.kind === 'string') cp = parsed as unknown as AuthCheckpoint;
    } catch (err) {
      log(`failed to parse checkpoint sentinel: ${errMsg(err)}`);
    }
    if (cp) {
      return {
        success: false,
        outcome: 'checkpoint',
        checkpoint: cp,
        message: `checkpoint:${cp.kind}`,
        ...baseResult,
      };
    }
  }

  if (existsSync(doneSentinel)) {
    let raw = '';
    try {
      raw = readFileSync(doneSentinel, 'utf8').trim();
    } catch (err) {
      log(`failed to read done sentinel: ${errMsg(err)}`);
    }
    const parsed = parseCompileDoneSentinel(raw, {
      toolDir: opts.absoluteToolDir,
      expectedMode: opts.verificationMode,
      authMode: Boolean(opts.authMode),
    });
    if (parsed.ok) {
      return {
        success: true,
        outcome: 'done',
        message: parsed.message,
        ...(parsed.verification ? { verification: parsed.verification } : {}),
        ...baseResult,
      };
    }
    return {
      success: false,
      outcome: 'error',
      message: parsed.message,
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

  const errorTail = processErrorMessage || stderrBuf.trim().slice(-500);
  const exitError = cliExitError('codex-cli', exitCode, errorTail);
  if (exitError instanceof ProviderReportedError) {
    return {
      success: false,
      outcome: 'error',
      message: exitError.message,
      providerInterruption: exitError.interruption,
      providerError: exitError,
      ...baseResult,
    };
  }
  return {
    success: false,
    outcome: 'error',
    message: `codex-cli exited with code ${exitCode}${errorTail ? `\n${errorTail}` : ''}`,
    ...baseResult,
  };
}

function traceCodexToolEvent(
  spans: Map<string, Span>,
  eventType: string,
  item: NonNullable<CodexJsonEvent['item']>,
  toolName: string,
): void {
  const id = item.id ?? `${toolName}:${spans.size}`;
  const captureIo = traceToolIoEnabled();
  if (eventType === 'item.started') {
    const span = startTraceSpan(`mcp.${toolName}`, 'TOOL', {
      'mcp.server': item.server ?? MCP_SERVER_NAME,
      'mcp.tool_name': toolName,
      'codex.item_id': id,
      'codex.item_type': item.type,
      ...(captureIo && codexToolInput(item) !== undefined
        ? traceJsonInputOutputAttributes('input', codexToolInput(item), `mcp.${toolName}.input`)
        : {}),
    });
    if (span) spans.set(id, span);
    return;
  }
  const completionAttributes = {
    'codex.item_status': item.status,
    ...(captureIo && codexToolOutput(item) !== undefined
      ? traceJsonInputOutputAttributes('output', codexToolOutput(item), `mcp.${toolName}.output`)
      : {}),
  };
  const toolError = codexToolError(item);
  const span = spans.get(id);
  if (!span) {
    const completedSpan = startTraceSpan(`mcp.${toolName}`, 'TOOL', {
      'mcp.server': item.server ?? MCP_SERVER_NAME,
      'mcp.tool_name': toolName,
      'codex.item_id': id,
      'codex.item_type': item.type,
      'codex.event': 'completed_without_start',
      ...completionAttributes,
    });
    endTraceSpan(completedSpan, toolError);
    return;
  }
  setSpanAttributes(span, completionAttributes);
  endTraceSpan(span, toolError);
  spans.delete(id);
}

function normalizeCodexToolEvent(evt: CodexJsonEvent):
  | {
      eventType: 'item.started' | 'item.completed';
      item: NonNullable<CodexJsonEvent['item']>;
    }
  | undefined {
  if (
    (evt.type === 'item.started' || evt.type === 'item.completed') &&
    evt.item &&
    codexToolName(evt.item)
  ) {
    return { eventType: evt.type, item: evt.item };
  }

  const responseItem = isRecord(evt.response_item)
    ? evt.response_item
    : evt.type === 'response_item' && isRecord(evt.item)
      ? evt.item
      : undefined;
  if (responseItem) {
    const responseType = stringField(responseItem, 'type');
    const name = stringField(responseItem, 'name') ?? stringField(responseItem, 'tool_name');
    if (responseType === 'function_call' && name) {
      return {
        eventType:
          stringField(responseItem, 'status') === 'in_progress' ? 'item.started' : 'item.completed',
        item: {
          id: stringField(responseItem, 'id') ?? stringField(responseItem, 'call_id'),
          type: 'mcp_tool_call',
          name,
          arguments: responseItem.arguments,
          status: stringField(responseItem, 'status'),
        },
      };
    }
  }

  const eventMsg = isRecord(evt.event_msg)
    ? evt.event_msg
    : evt.type === 'event_msg' && isRecord(evt.item)
      ? evt.item
      : undefined;
  if (eventMsg) {
    const name = stringField(eventMsg, 'name') ?? stringField(eventMsg, 'tool_name');
    if (name) {
      const msgType = stringField(eventMsg, 'type') ?? evt.type;
      return {
        eventType:
          msgType.includes('start') || msgType.includes('begin')
            ? 'item.started'
            : 'item.completed',
        item: {
          id: stringField(eventMsg, 'id') ?? stringField(eventMsg, 'call_id'),
          type: 'mcp_tool_call',
          name,
          status: stringField(eventMsg, 'status'),
          result: eventMsg.result ?? eventMsg.output,
          error: eventMsg.error,
        },
      };
    }
  }

  return undefined;
}

function codexAgentMessageText(item: NonNullable<CodexJsonEvent['item']>): string | undefined {
  if (item.type !== 'agent_message') return undefined;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (isRecord(block) && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('');
    return text || undefined;
  }
  return undefined;
}

function codexToolName(item: NonNullable<CodexJsonEvent['item']>): string | undefined {
  const type = item.type ?? '';
  if (type === 'agent_message') return undefined;
  const name = item.name ?? item.tool_name ?? item.tool;
  if (!name) return undefined;
  return name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
}

function codexToolInput(item: NonNullable<CodexJsonEvent['item']>): unknown {
  return (
    item.arguments ??
    item.args ??
    item.input ??
    (item.command ? { command: item.command } : undefined)
  );
}

function codexToolOutput(item: NonNullable<CodexJsonEvent['item']>): unknown {
  return (
    item.result ??
    item.output ??
    item.content ??
    item.error ??
    (item.status ? { status: item.status } : undefined)
  );
}

function codexToolError(item: NonNullable<CodexJsonEvent['item']>): Error | undefined {
  if (!item.is_error && item.status !== 'error' && item.status !== 'failed') return undefined;
  const message =
    item.error === undefined
      ? `${codexToolName(item) ?? 'tool'} failed`
      : typeof item.error === 'string'
        ? item.error
        : JSON.stringify(item.error);
  return new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function finalErrorResult(opts: CompileViaCodexCliOptions, message: string): CompileAgentResult {
  mkdirSync(opts.absoluteToolDir, { recursive: true });
  const conversationLogPath = pathJoin(opts.absoluteToolDir, '.compile-log.json');
  recordCompilerHostError(conversationLogPath, message);
  return {
    success: false,
    outcome: 'error',
    message,
    conversationLogPath,
    turns: 0,
    durationMs: Date.now() - opts.startTime,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
