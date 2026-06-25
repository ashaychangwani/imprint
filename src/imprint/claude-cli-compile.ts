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

import { type ChildProcess, spawn } from 'node:child_process';
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
import { preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { COMPILE_SENTINELS } from './mcp-compile-server.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  endTraceSpan,
  llmSpanAttributes,
  setSpanAttributes,
  startTraceSpan,
  totalPromptTokens,
  traceJsonInputOutputAttributes,
  traceLlmIoEnabled,
  traced,
} from './tracing.ts';
import type { Session } from './types.ts';

const log = createLog('compile-claude-cli');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const MCP_SERVER_NAME = 'imprint-compile';
const MAX_VERIFICATION_CYCLES = 5;

/**
 * Thinking effort for the compile agent. Deliberately `high`, not `max`:
 * empirically, max-effort thinking generates a large volume of reasoning tokens
 * on reverse-engineering tasks, which measurably raises the model's usage-policy
 * safety-filter false-positive rate. `high` keeps strong reasoning with far
 * fewer spurious refusals. Passed as an explicit `--effort` flag so it overrides
 * any CLAUDE_EFFORT inherited from the environment.
 */
const COMPILE_EFFORT_LEVEL = 'high';

/**
 * Signature of Claude Code's usage-policy safety refusal (surfaced in the
 * terminal result event / our error message). The block is a transient,
 * probabilistic false positive on legitimate compiles, so we retry a fresh
 * session a few times before surfacing it as a hard failure.
 */
const USAGE_POLICY_REFUSAL =
  /unable to respond to this request|appears to violate our Usage Policy/i;

/** Total attempts (1 initial + retries) when a usage-policy refusal is hit. */
const MAX_USAGE_POLICY_ATTEMPTS = 3;

/** Exponential backoff with jitter between refusal retries. Spacing matters:
 *  bursts of near-identical requests raise the safety-filter trip rate. */
function usagePolicyBackoffMs(attempt: number): number {
  const base = 5000 * 2 ** (attempt - 1); // 5s, 10s, ...
  return base + Math.floor(Math.random() * base * 0.5);
}

interface CompileViaClaudeCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  /** Retain parser.test.ts after successful verification. Mirrors the
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
  /** Present → drive an auth compile rather than a data compile. */
  authMode?: AuthCliCompileMode;
  /** Auth segments only: resume a prior segment's claude session with a new user
   *  message (the orchestrator's result for the checkpoint the agent reached).
   *  When set, `--resume <sessionId>` is used and `message` replaces the initial
   *  prompt. Requires session persistence (auth mode keeps it on). */
  resume?: { sessionId: string; message: string };
}

/** Options for the auth-compile entry point. A strict subset of the data
 *  options — the auth-specific bits live in `authMode`. */
interface AuthCompileViaClaudeCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
  onDeadlineReached?: OnDeadlineReached;
  authMode: AuthCliCompileMode;
  /** Resume a prior segment (see CompileViaClaudeCliOptions.resume). */
  resume?: { sessionId: string; message: string };
}

/** Auth-compile entry point for claude-cli. Delegates to the same trace +
 *  usage-policy-retry + stream-json driver as the data path; the only
 *  differences (MCP args, allowedTools, prompts, verification) are carried by
 *  `authMode` and resolved inside runClaudeCliAttempt. */
export function compileAuthViaClaudeCli(
  opts: AuthCompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  return compileViaClaudeCli({
    session: opts.session,
    absoluteToolDir: opts.absoluteToolDir,
    sessionPath: opts.sessionPath,
    systemPromptPath: opts.systemPromptPath,
    deadlineMs: opts.deadlineMs,
    startTime: opts.startTime,
    onProgress: opts.onProgress,
    onDeadlineReached: opts.onDeadlineReached,
    authMode: opts.authMode,
    resume: opts.resume,
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
  is_error?: boolean;
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
      'imprint.model': preferredAgentModel('claude-cli'),
    },
    async (span) => {
      const result = await compileViaClaudeCliImpl(opts);
      setSpanAttributes(span, {
        'imprint.compile.outcome': result.outcome,
        'imprint.compile.turns': result.turns,
        'imprint.compile.duration_ms': result.durationMs,
        'imprint.compile.input_tokens': result.inputTokens,
        'imprint.compile.output_tokens': result.outputTokens,
        'imprint.compile.cache_read_input_tokens': result.cacheReadInputTokens,
        'imprint.compile.cache_creation_input_tokens': result.cacheCreationInputTokens,
        ...llmSpanAttributes({
          provider: 'claude-cli',
          model: preferredAgentModel('claude-cli'),
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
        }),
      });
      return result;
    },
  );
}

/**
 * Drives the compile, retrying a fresh claude-cli session when an attempt is
 * blocked by the usage-policy safety filter. The block is a flaky false positive
 * (see USAGE_POLICY_REFUSAL); a re-roll almost always succeeds. All other
 * outcomes (success, give_up, verification failure, timeout) return immediately.
 */
async function compileViaClaudeCliImpl(
  opts: CompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  let lastResult: CompileAgentResult | undefined;
  for (let attempt = 1; attempt <= MAX_USAGE_POLICY_ATTEMPTS; attempt++) {
    const result = await runClaudeCliAttempt(opts);
    const isRefusal = !result.success && USAGE_POLICY_REFUSAL.test(result.message ?? '');
    if (!isRefusal) return result;
    lastResult = result;
    if (attempt < MAX_USAGE_POLICY_ATTEMPTS) {
      const backoffMs = usagePolicyBackoffMs(attempt);
      log(
        `usage-policy refusal on attempt ${attempt}/${MAX_USAGE_POLICY_ATTEMPTS}; ` +
          `retrying a fresh session in ${Math.round(backoffMs / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Every attempt was blocked. Annotate the final error so the operator knows
  // it was the (flaky) safety filter, not their recording or workflow.
  const exhausted = lastResult as CompileAgentResult;
  return {
    ...exhausted,
    message: `${exhausted.message}\n\nBlocked by the model's usage-policy safety filter on all ${MAX_USAGE_POLICY_ATTEMPTS} attempts. This is typically a transient false positive on reverse-engineering compiles — re-run this tool, or compile it with a different provider (e.g. codex-cli).`,
  };
}

async function runClaudeCliAttempt(opts: CompileViaClaudeCliOptions): Promise<CompileAgentResult> {
  // Ensure tool dir exists and clear any prior sentinels — a stale
  // sentinel from a previous run would short-circuit our success detection.
  mkdirSync(opts.absoluteToolDir, { recursive: true });
  for (const name of [
    COMPILE_SENTINELS.done,
    COMPILE_SENTINELS.giveUp,
    COMPILE_SENTINELS.checkpoint,
  ]) {
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
      ...(opts.candidate ? ['--candidate-json', JSON.stringify(opts.candidate)] : []),
      ...(opts.sharedContext ? ['--shared-context-json', JSON.stringify(opts.sharedContext)] : []),
      ...(opts.buildPlanPath ? ['--build-plan-path', opts.buildPlanPath] : []),
      ...(opts.sharedModules ? ['--shared-modules-json', JSON.stringify(opts.sharedModules)] : []),
    ];
    allowedToolNames = [
      'read_session_summary',
      'read_request',
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

  // Auth compiles run in resumable SEGMENTS: each segment ends when the agent
  // reaches a checkpoint tool; the orchestrator acts and resumes the same
  // session with the result. That needs session persistence ON (so --resume
  // works) and, on a resume, `--resume <id>` + the result as the new prompt.
  const promptArg = opts.resume ? opts.resume.message : initialPrompt;
  const resumeArgs = opts.resume ? ['--resume', opts.resume.sessionId] : [];
  // Data compiles are single-shot — keep session persistence OFF. Auth keeps it
  // ON so the segment loop can resume.
  const persistenceArgs = opts.authMode ? [] : ['--no-session-persistence'];

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
    ...persistenceArgs,
    '--disable-slash-commands',
    // Cap thinking effort below `max` to reduce usage-policy false positives.
    '--effort',
    COMPILE_EFFORT_LEVEL,
    '--model',
    preferredAgentModel('claude-cli'),
    promptArg,
  ];

  log(
    `spawning claude (max-turns=200, mcp-server=${MCP_SERVER_NAME}${opts.resume ? `, resume=${opts.resume.sessionId.slice(0, 8)}` : ''})`,
  );

  let child: ChildProcess;
  try {
    child = spawn('claude', args, {
      cwd: REPO_ROOT,
      // Claude CLI's default MCP_TOOL_TIMEOUT is 60s. The compile MCP
      // server's `done` tool runs external verification inline — bun test
      // (up to 60s × 3 retries for the integration suite + 120s for the
      // parser suite) plus typechecking. On bot-protected sites where the
      // integration test escalates fetch → fetch-bootstrap → stealth-fetch
      // for every assertion, a single bun test pass can run 30s × 3
      // rungs × N tests = 10-15 min before the outer wrapper kills it,
      // and 3 retries push the total well past 30 min. A 10-min cap was
      // not enough — set 30 min so the worst-case verification can
      // actually complete and the agent receives the failure feedback
      // (and ships with `liveVerified: false` via the waiver path)
      // rather than getting `-32000: Connection closed` mid-call and
      // wasting the rest of its turn budget. Honor user-set env so an
      // operator on a fast network can tighten without editing source.
      // Connection-startup timeout stays at 60s for cold Playwright boot.
      env: {
        ...process.env,
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '1800000',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return finalErrorResult(opts, `failed to spawn claude-cli: ${errMsg(err)}`);
  }

  const result = await driveStreamJson(child, opts);
  return result;
}

async function driveStreamJson(
  child: ChildProcess,
  opts: CompileViaClaudeCliOptions,
): Promise<CompileAgentResult> {
  // Capture OTel context so child-process event handlers can parent spans
  // under the current compile.claude_cli_agent span. Bun's event emitters
  // don't propagate AsyncLocalStorage, so without this the agent.turn.*
  // spans appear as orphaned root traces in Phoenix.
  const parentCtx = otelContext.active();

  const conversationLog: unknown[] = [];
  const conversationLogPath = pathJoin(opts.absoluteToolDir, '.compile-log.json');
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
  let capturedSessionId: string | undefined;
  let lastErrorEvent: StreamJsonEvent | null = null;
  let stderrBuf = '';
  let currentTurnSpan: Span | null = null;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;

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

  // Wall-clock guard: if we hit the deadline, ask the user or kill the child.
  let currentDeadlineMs = opts.deadlineMs;
  let childExited = false;

  const killChild = (): void => {
    log('wall-clock deadline exceeded, terminating claude');
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    } catch {
      // already gone
    }
  };

  const scheduleDeadlineCheck = (): ReturnType<typeof setTimeout> => {
    const remaining = Math.max(0, currentDeadlineMs - Date.now());
    return setTimeout(async () => {
      if (childExited) return;
      if (opts.onDeadlineReached) {
        const extensionMs = await opts.onDeadlineReached();
        if (childExited) return;
        if (extensionMs != null && extensionMs > 0) {
          currentDeadlineMs += extensionMs;
          deadlineTimer = scheduleDeadlineCheck();
          return;
        }
      }
      killChild();
    }, remaining);
  };

  let deadlineTimer = scheduleDeadlineCheck();

  // Stdout: newline-delimited stream-json events.
  let stdoutBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    otelContext.with(parentCtx, () => {
      stdoutBuf += chunk.toString('utf8');
      while (true) {
        const nl = stdoutBuf.indexOf('\n');
        if (nl < 0) break;
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;

        let evt: StreamJsonEvent;
        try {
          evt = JSON.parse(line);
        } catch (err) {
          log(`unparseable stream-json line: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        conversationLog.push(evt);

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
          if (evt.session_id) capturedSessionId = evt.session_id;
          log(`session_id=${evt.session_id ?? '(none)'}`);
          continue;
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
          continue;
        }

        if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
          if (currentTurnSpan && captureLlmIo) {
            setSpanAttributes(
              currentTurnSpan,
              traceJsonInputOutputAttributes('input', evt.message.content),
            );
          }
          continue;
        }

        if (evt.type === 'result') {
          if (evt.usage) {
            inputTokens = evt.usage.input_tokens ?? inputTokens;
            outputTokens = evt.usage.output_tokens ?? outputTokens;
            cacheReadInputTokens = evt.usage.cache_read_input_tokens ?? cacheReadInputTokens;
            cacheCreationInputTokens =
              evt.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
          }
          if (evt.is_error) {
            lastErrorEvent = evt;
          }
          continue;
        }

        if (evt.type === 'system' && evt.subtype === 'api_retry') {
          log(`api_retry: ${(evt as { error?: string }).error ?? '(unknown)'}`);
        }
      }
    });
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderrBuf += s;
    // Forward to our debug log only — don't pollute the user's console.
    log(`[claude stderr] ${s.trim()}`);
  });

  // Wait for the child to exit on its own. Sentinel detection happens after.
  const exitCode: number = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? -1));
    child.once('error', () => resolve(-1));
  });
  childExited = true;
  clearTimeout(deadlineTimer);
  if (currentTurnSpan) {
    setSpanAttributes(currentTurnSpan, {
      'imprint.agent.turn_input_tokens': turnInputTokens,
      'imprint.agent.turn_output_tokens': turnOutputTokens,
    });
    endTraceSpan(currentTurnSpan);
  }

  // Drain any remaining buffered output.
  if (stdoutBuf.trim()) {
    log(`unflushed stdout tail (${stdoutBuf.length} bytes) discarded`);
  }

  // Final flush of the complete conversation log.
  flushLog();

  // Inspect sentinels to determine outcome.
  const doneSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.done);
  const giveUpSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.giveUp);
  const checkpointSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.checkpoint);
  const workflowPath = pathJoin(opts.absoluteToolDir, 'workflow.json');
  const parserPath = pathJoin(opts.absoluteToolDir, 'parser.ts');
  const parserTestPath = pathJoin(opts.absoluteToolDir, 'parser.test.ts');

  // Determine success up-front so we can clean up the ephemeral parser.test.ts
  // before constructing baseResult (which captures parserTestPath via existsSync).
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

  // Wall-clock deadline exceeded?
  if (Date.now() > currentDeadlineMs && !existsSync(doneSentinel) && !existsSync(giveUpSentinel)) {
    return {
      success: false,
      outcome: 'timeout',
      message: `claude-cli exceeded the ${Math.round((currentDeadlineMs - opts.startTime) / 60000)} minute deadline before completing.`,
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
  const errorTail =
    (lastErrorEvent as StreamJsonEvent | null)?.result ?? stderrBuf.trim().slice(-500);
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
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
