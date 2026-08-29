/**
 * compile-agent driver for claude-cli.
 *
 * claude-cli doesn't implement messageWithTools (its CLI surface only does
 * single-turn text completion), so we can't drive it turn-by-turn the way
 * runAgentLoop drives anthropic-api. Instead we shell out to
 * `claude -p` with imprint's compile tools registered as a stdio MCP server
 * and let claude-cli's own internal agent loop drive the work.
 *
 * Key design points:
 *
 * - **Subscription auth**: we deliberately do NOT pass `--bare`. Without bare
 *   mode claude-cli reads OAuth from the keychain, so a Pro/Max subscriber
 *   spends subscription tokens, not API credit.
 *
 * - **Tool dispatch happens in the MCP server**, not here. See
 *   mcp-compile-server.ts. The `done` tool there runs externalVerification
 *   inline; on failure it returns the failure list as the tool_result and the
 *   model keeps iterating in the same conversation. On success it writes a
 *   sentinel file we poll for.
 *
 * - **Progress reporting**: stream-json events from claude-cli are translated
 *   into CompileAgentProgress events for the existing onProgress callback,
 *   so the spinner UX in teach.ts is unchanged.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { type Span, context as otelContext } from '@opentelemetry/api';
import type { OnDeadlineReached } from './agent.ts';
import type { AuthCliCompileMode } from './auth-compile-tools.ts';
import { type SharedModuleManifestEntry, resolvePlanSliceFromFile } from './build-plan.ts';
import type {
  AuthCheckpoint,
  CompileAgentProgress,
  CompileAgentResult,
} from './compile-agent-types.ts';
import { formatCandidateContext, formatToolPlan } from './compile-agent-types.ts';
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
import { preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { COMPILE_SENTINELS } from './mcp-compile-server.ts';
import { type RunDeadlineRef, resolvedRunDeadline } from './provider-retry.ts';
import { ProviderTerminalAccumulator } from './provider-terminal.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  endTraceSpan,
  recordLlmUsageSpan,
  setSpanAttributes,
  startTraceSpan,
  totalPromptTokens,
  traceJsonInputOutputAttributes,
  traceLlmIoEnabled,
  traced,
} from './tracing.ts';
import type { SharedTriageSelection } from './triage-selection.ts';
import type { Session } from './types.ts';

const log = createLog('compile-claude-cli');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const MCP_SERVER_NAME = 'imprint-compile';
const MAX_VERIFICATION_CYCLES = 5;

function formatRevisionMode(enabled: boolean | undefined): string {
  return enabled
    ? 'REVISION MODE: inspect read_session_summary.revisionContext and the listed existing artifacts/diagnostics first. Preserve proven behavior; repair or honestly narrow only what evidence contradicts.'
    : '';
}

/**
 * Thinking effort for the compile agent. Deliberately `high`, not `max`:
 * empirically, max-effort thinking generates a large volume of reasoning tokens
 * on reverse-engineering tasks, which measurably raises the model's usage-policy
 * safety-filter false-positive rate. `high` keeps strong reasoning with far
 * fewer spurious refusals. Passed as an explicit `--effort` flag so it overrides
 * any CLAUDE_EFFORT inherited from the environment.
 */
const COMPILE_EFFORT_LEVEL = 'high';

interface CompileViaClaudeCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  runDeadline?: RunDeadlineRef;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  signal?: AbortSignal;
  /** Retain agent-generated tests after successful verification. Mirrors the
   *  in-process loop's `keepTest`. */
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
  /** Shared triage result for irreversible-effect propagation in the MCP server. */
  sharedTriageSelection?: SharedTriageSelection;
  /** Present → drive an auth compile rather than a data compile. */
  authMode?: AuthCliCompileMode;
  resume?: { sessionId: string; message: string };
  /** Explicit model selected by the caller. Defaults to the provider preference. */
  model?: string;
}

/** Options for the auth-compile entry point. A strict subset of the data
 *  options — the auth-specific bits live in `authMode`. */
interface AuthCompileViaClaudeCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  runDeadline?: RunDeadlineRef;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  onDeadlineReached?: OnDeadlineReached;
  signal?: AbortSignal;
  authMode: AuthCliCompileMode;
  /** Resume a prior segment (see CompileViaClaudeCliOptions.resume). */
  resume?: { sessionId: string; message: string };
  model?: string;
}

export function compileAuthViaClaudeCli(
  opts: AuthCompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  return compileViaClaudeCli({
    session: opts.session,
    absoluteToolDir: opts.absoluteToolDir,
    sessionPath: opts.sessionPath,
    systemPromptPath: opts.systemPromptPath,
    deadlineMs: opts.deadlineMs,
    runDeadline: opts.runDeadline,
    startTime: opts.startTime,
    onProgress: opts.onProgress,
    onDeadlineReached: opts.onDeadlineReached,
    signal: opts.signal,
    authMode: opts.authMode,
    resume: opts.resume,
    model: opts.model,
  });
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  // assistant/user message envelope
  message?: {
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; name: string; input?: unknown }
      | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  // result envelope (terminal event)
  result?: string;
  errors?: string[];
  is_error?: boolean;
  api_error_status?: number | string;
  terminal_reason?: string;
  error?: { type?: string; code?: string; status?: number; status_code?: number };
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // partial-message stream events
  event?: { delta?: { type?: string; text?: string } };
}

export async function compileViaClaudeCli(
  opts: CompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  return await traced(
    'compile.claude_cli_agent',
    'AGENT',
    {
      'imprint.site': opts.session.site,
      'imprint.tool_dir': opts.absoluteToolDir,
      'imprint.provider': 'claude-cli',
      'imprint.model': opts.model ?? preferredAgentModel('claude-cli'),
    },
    async (span) => {
      const result = await compileViaClaudeCliImpl(opts);
      const model = opts.model ?? preferredAgentModel('claude-cli');
      setSpanAttributes(span, {
        'imprint.compile.outcome': result.outcome,
        'imprint.compile.turns': result.turns,
        'imprint.compile.duration_ms': result.durationMs,
        'imprint.compile.input_tokens': result.inputTokens,
        'imprint.compile.output_tokens': result.outputTokens,
        'imprint.compile.cache_read_input_tokens': result.cacheReadInputTokens,
        'imprint.compile.cache_creation_input_tokens': result.cacheCreationInputTokens,
      });
      recordLlmUsageSpan(
        'compile.claude_cli_usage',
        {
          provider: 'claude-cli',
          model,
          // TOTAL prompt (uncached + cache); the cache split is passed separately
          // for cost. `result.inputTokens` alone is the uncached delta (often a
          // few hundred), which would mislabel `llm.token_count.prompt`.
          inputTokens: totalPromptTokens(
            result.inputTokens,
            result.cacheReadInputTokens,
            result.cacheCreationInputTokens,
          ),
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

async function compileViaClaudeCliImpl(
  opts: CompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  return await runClaudeCliAttempt(opts);
}

async function runClaudeCliAttempt(opts: CompileViaClaudeCliOptions): Promise<CompileAgentResult> {
  const runDeadline = resolvedRunDeadline(opts.runDeadline, opts.deadlineMs);
  // Ensure tool dir exists and clear any prior sentinels — a stale
  // sentinel from a previous run would short-circuit our success detection.
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
        unlinkSync(p); // remove, not truncate — existsSync() is what gates success/give-up detection later
      } catch {
        // best effort
      }
    }
  }

  // Build the inline MCP config. The MCP server is the same imprint binary
  // re-invoked with the hidden __mcp-compile-server verb. Use the bun runner
  // the parent was launched with so the child runs in the same TS toolchain.
  const bunPath = process.execPath;
  const sessionPathAbs = opts.sessionPath.startsWith('/')
    ? opts.sessionPath
    : pathJoin(REPO_ROOT, opts.sessionPath);

  // Auth and data compiles share the spawn + stream-json driver below; only the
  // MCP server args, the pre-approved tool list, and the initial prompt differ.
  let mcpServerArgs: string[];
  let allowedToolNames: string[];
  let initialPrompt: string;

  if (opts.authMode) {
    mcpServerArgs = [
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
    allowedToolNames = [...opts.authMode.allowedTools, 'done', 'give_up'];
    initialPrompt = opts.authMode.initialPrompt;
  } else {
    mcpServerArgs = [
      'run',
      CLI_PATH,
      '__mcp-compile-server',
      '--session-path',
      sessionPathAbs,
      '--tool-dir',
      opts.absoluteToolDir,
      '--provider',
      'claude-cli',
      ...(opts.candidate ? ['--candidate-json', JSON.stringify(opts.candidate)] : []),
      ...(opts.sharedContext ? ['--shared-context-json', JSON.stringify(opts.sharedContext)] : []),
      ...(opts.buildPlanPath ? ['--build-plan-path', opts.buildPlanPath] : []),
      ...(opts.sharedModules ? ['--shared-modules-json', JSON.stringify(opts.sharedModules)] : []),
      ...(opts.strategyKind ? ['--strategy-kind', opts.strategyKind] : []),
      ...(opts.revisionMode ? ['--revision-mode'] : []),
      ...(opts.sharedTriageSelection
        ? ['--shared-triage-json', JSON.stringify(opts.sharedTriageSelection)]
        : []),
    ];
    allowedToolNames = [
      'read_session_summary',
      'read_request',
      'inspect_body_structure',
      'read_response_body',
      'search_response_body',
      'read_file',
      'write_file',
      'run_bash',
      'run_tests',
      'read_build_plan',
      'done',
      'give_up',
    ];
    const { assignedSharedModules } = resolvePlanSliceFromFile(
      opts.buildPlanPath,
      opts.candidate?.toolName,
      opts.sharedModules,
    );
    initialPrompt = `A new compile task is starting.

Session path: ${sessionPathAbs}
Tool directory: ${opts.absoluteToolDir}
You will write artifacts into the tool directory.
${formatCandidateContext(opts.candidate, opts.sharedContext, assignedSharedModules)}
${formatToolPlan(opts.toolPlan)}
${formatRevisionMode(opts.revisionMode)}

Begin by calling read_session_summary to orient yourself, then proceed per the system prompt.`;
  }

  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: bunPath,
        args: mcpServerArgs,
        alwaysLoad: true,
      },
    },
  };

  const promptArg = opts.resume ? opts.resume.message : initialPrompt;
  const resumeArgs = opts.resume ? ['--resume', opts.resume.sessionId] : [];

  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    ...resumeArgs,
    '--system-prompt-file',
    opts.systemPromptPath,
    '--append-system-prompt',
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    // Disable the built-in tool set so claude only uses our MCP tools.
    '--tools',
    '',
    // Pre-approve every tool from our MCP server so no permission prompt
    // fires in non-interactive print mode.
    ...allowedToolNames.flatMap((name) => ['--allowedTools', `mcp__${MCP_SERVER_NAME}__${name}`]),
    // Bound the run. softTurnCap=100 in the in-process loop × up to 5
    // verification cycles = 500 hard ceiling there. Verification is now
    // in-tool so we pick a single bound that comfortably exceeds typical runs
    // (~5-15 turns per the system prompt) plus retry budget.
    '--max-turns',
    '200',
    '--permission-mode',
    'bypassPermissions',
    '--disable-slash-commands',
    // Cap thinking effort below `max` to reduce usage-policy false positives.
    '--effort',
    COMPILE_EFFORT_LEVEL,
    '--model',
    opts.model ?? preferredAgentModel('claude-cli'),
    promptArg,
  ];

  log(
    `spawning claude (max-turns=200, mcp-server=${MCP_SERVER_NAME}${opts.resume ? `, resume=${opts.resume.sessionId.slice(0, 8)}` : ''})`,
  );

  const providerControl = createCompileProviderControl(runDeadline ?? opts.deadlineMs);
  providerControl.updateSession(opts.resume?.sessionId);
  const childEnv = { ...process.env, ...providerControl.env };
  // spawnOwnedProcess merges the parent environment, so an explicit undefined
  // is required to remove this host-only payload from the child.
  childEnv.IMPRINT_TEACH_CREDENTIALS = undefined;
  let child: ChildProcess;
  try {
    child = spawnOwnedProcess('claude', args, {
      cwd: opts.absoluteToolDir,
      // Claude CLI's default MCP_TOOL_TIMEOUT is 60s. The compile MCP
      // server's `done` tool runs external verification inline: one live
      // integration suite, parser tests, typechecking, and a fresh semantic
      // verifier agent that may make a narrowly targeted follow-up call. On
      // bot-protected sites one suite can still take 10-15 minutes as each
      // assertion escalates fetch → fetch-bootstrap → stealth-fetch. Keep the
      // 30-minute cap so the agent receives semantic feedback rather than an
      // MCP connection-close midway through review. Honor user-set env so an
      // operator on a fast network can tighten it without editing source.
      // Connection-startup timeout stays at 60s for cold Playwright boot.
      env: {
        ...childEnv,
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '1800000',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    providerControl.dispose();
    return finalErrorResult(opts, `failed to spawn claude-cli: ${errMsg(err)}`);
  }

  try {
    return await driveStreamJson(child, opts, providerControl);
  } finally {
    providerControl.dispose();
  }
}

async function driveStreamJson(
  child: ChildProcess,
  opts: CompileViaClaudeCliOptions,
  providerControl: CompileProviderControl,
): Promise<CompileAgentResult> {
  // Capture OTel context so child-process event handlers can parent spans
  // under the current compile.claude_cli_agent span. Bun's event emitters
  // don't propagate AsyncLocalStorage, so without this the agent.turn.*
  // spans appear as orphaned root traces in Phoenix.
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
  const flushLog = (): void => {
    try {
      writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');
    } catch {}
  };
  const captureLlmIo = traceLlmIoEnabled();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let turn = 0;
  let capturedSessionId: string | undefined = opts.resume?.sessionId;
  const terminalParser = new ProviderTerminalAccumulator('claude-cli');
  let processErrorMessage = '';
  let stderrBuf = '';
  let currentTurnSpan: Span | null = null;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;

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

  const terminateChild = (reason: string): void => {
    log(`${reason}, terminating claude`);
    try {
      terminateCompilerProcessTree(child);
    } catch {
      // already gone
    }
  };
  const deadlineWatch = watchCompileProviderDeadline(providerControl, opts.onDeadlineReached, () =>
    terminateChild('wall-clock deadline exceeded'),
  );

  const onStdoutLine = (rawLine: string): void => {
    otelContext.with(parentCtx, () => {
      const line = rawLine.trim();
      if (!line) return;

      let evt: StreamJsonEvent;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        log(`unparseable stream-json line: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      conversationLog.push(evt);
      terminalParser.ingest(evt as unknown as Record<string, unknown>);

      // Token accounting from any event that carries usage.
      const evtInputTokens =
        (evt.usage?.input_tokens ?? 0) + (evt.message?.usage?.input_tokens ?? 0);
      const evtOutputTokens =
        (evt.usage?.output_tokens ?? 0) + (evt.message?.usage?.output_tokens ?? 0);
      if (evtInputTokens || evtOutputTokens) {
        inputTokens += evtInputTokens;
        outputTokens += evtOutputTokens;
        turnInputTokens += evtInputTokens;
        turnOutputTokens += evtOutputTokens;
      }

      if (evt.type === 'system' && evt.subtype === 'init') {
        if (evt.session_id) {
          capturedSessionId = evt.session_id;
          providerControl.updateSession(evt.session_id);
        }
        log(`session_id=${evt.session_id ?? '(none)'}`);
        return;
      }

      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        if (currentTurnSpan) {
          setSpanAttributes(currentTurnSpan, {
            'imprint.agent.turn_input_tokens': turnInputTokens,
            'imprint.agent.turn_output_tokens': turnOutputTokens,
          });
          endTraceSpan(currentTurnSpan);
        }
        flushLog();
        turn++;
        turnInputTokens = 0;
        turnOutputTokens = 0;
        currentTurnSpan = startTraceSpan(`agent.turn.${turn}`, 'CHAIN', {
          'imprint.agent.turn': turn,
          'imprint.agent.cumulative_input_tokens': inputTokens,
          'imprint.agent.cumulative_output_tokens': outputTokens,
        });
        if (currentTurnSpan && captureLlmIo) {
          setSpanAttributes(
            currentTurnSpan,
            traceJsonInputOutputAttributes('output', evt.message.content),
          );
        }
        fireProgress('thinking');
        for (const block of evt.message.content) {
          if (block && (block as { type?: string }).type === 'tool_use') {
            const fullName = (block as { name?: string }).name ?? '(unknown)';
            // Strip mcp__<server>__ prefix for human-readable progress.
            const short = fullName.replace(`mcp__${MCP_SERVER_NAME}__`, '');
            fireProgress('tool', short);
          }
        }
        return;
      }

      if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
        if (currentTurnSpan && captureLlmIo) {
          setSpanAttributes(
            currentTurnSpan,
            traceJsonInputOutputAttributes('input', evt.message.content),
          );
        }
        return;
      }

      if (evt.type === 'result') {
        if (evt.session_id) {
          capturedSessionId = evt.session_id;
          providerControl.updateSession(evt.session_id);
        }
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens ?? inputTokens;
          outputTokens = evt.usage.output_tokens ?? outputTokens;
          cacheReadInputTokens = evt.usage.cache_read_input_tokens ?? cacheReadInputTokens;
          cacheCreationInputTokens =
            evt.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
        }
        return;
      }

      if (evt.type === 'system' && evt.subtype === 'api_retry') {
        log(`api_retry: ${(evt as { error?: string }).error ?? '(unknown)'}`);
      }
    });
  };

  const onStderrChunk = (s: string): void => {
    stderrBuf += s;
    // Forward to our debug log only — don't pollute the user's console.
    log(`[claude stderr] ${s.trim()}`);
  };

  const stopProviderWatch = providerControl.watch(() =>
    terminateChild('nested live verifier provider interruption'),
  );
  let exitCode: number;
  try {
    const output = await collectOwnedProcess(child, {
      signal: opts.signal,
      onStdoutLine,
      onStderrChunk,
    });
    exitCode = output.exitCode ?? -1;
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    processErrorMessage = errMsg(error);
    exitCode = -1;
  } finally {
    stopProviderWatch();
    deadlineWatch.dispose();
  }
  if (currentTurnSpan) {
    setSpanAttributes(currentTurnSpan, {
      'imprint.agent.turn_input_tokens': turnInputTokens,
      'imprint.agent.turn_output_tokens': turnOutputTokens,
    });
    endTraceSpan(currentTurnSpan);
  }

  if (processErrorMessage) {
    recordCompilerHostError(
      conversationLogPath,
      `claude-cli process failed before emitting events: ${processErrorMessage}`,
    );
  } else {
    flushLog();
  }
  // Inspect sentinels to determine outcome.
  const doneSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.done);
  const giveUpSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.giveUp);
  const checkpointSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.checkpoint);
  const workflowPath = pathJoin(opts.absoluteToolDir, 'workflow.json');
  const parserPath = pathJoin(opts.absoluteToolDir, 'parser.ts');
  const parserTestPath = pathJoin(opts.absoluteToolDir, 'parser.test.ts');

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
    const errorMessage =
      terminal.providerError.providerMessages.join('\n') || 'unknown provider error';
    return {
      success: false,
      outcome: 'error',
      message: `claude-cli provider call failed${exitCode === 0 ? '' : ` (exit ${exitCode})`}\n${errorMessage}`,
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
      message: 'claude-cli reached the run deadline',
      providerInterruption: providerError.interruption,
      providerError,
      ...baseResult,
    };
  }

  // Auth segment: the agent paused at a checkpoint for the orchestrator to act.
  // Take precedence over done/give_up (a well-behaved segment ends ONLY here).
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
    if (payload.verification === 'mechanical_passed' || payload.verification === 'not_applicable') {
      return {
        success: true,
        outcome: 'done',
        message:
          payload.verification === 'not_applicable'
            ? `${payload.summary ?? 'Task completed'} (live verification: N/A)`
            : (payload.summary ?? 'Task completed'),
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

  // No sentinel and clean exit — claude likely hit max-turns or stopped
  // without ever calling done/give_up.
  if (exitCode === 0) {
    return {
      success: false,
      outcome: 'soft_cap',
      message:
        'claude-cli exited without calling done() or give_up(). It may have hit --max-turns or stopped early.',
      ...baseResult,
    };
  }

  // Any other exit → error.
  const errorTail = processErrorMessage || stderrBuf.trim().slice(-500);
  return {
    success: false,
    outcome: 'error',
    message: `claude-cli exited with code ${exitCode}${errorTail ? `\n${errorTail}` : ''}`,
    ...baseResult,
  };
}

function finalErrorResult(opts: CompileViaClaudeCliOptions, message: string): CompileAgentResult {
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
