/**
 * compile-agent driver for codex-cli.
 *
 * Codex CLI can run non-interactively with JSONL progress and stdio MCP
 * servers. This mirrors the claude-cli compile path: expose the compile tools
 * through the existing MCP server, let Codex drive the agent loop, and accept
 * success only after the MCP done() tool writes the verified sentinel.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute as pathIsAbsolute, join as pathJoin } from 'node:path';
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
  type Span,
  endTraceSpan,
  llmSpanAttributes,
  resolveTraceTokenCount,
  setSpanAttributes,
  startTraceSpan,
  traceJsonInputOutputAttributes,
  traceLlmIoEnabled,
  traceLlmMessages,
  traceToolIoEnabled,
  traced,
} from './tracing.ts';
import type { Session } from './types.ts';

const log = createLog('compile-codex-cli');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const MCP_SERVER_NAME = 'imprint-compile';
const MAX_VERIFICATION_CYCLES = 5;
const MIN_MCP_TOOL_TIMEOUT_SEC = 300;
const MAX_MCP_TOOL_TIMEOUT_SEC = 1800;
const DEFAULT_AUTH_CODEX_IDLE_TIMEOUT_MS = 120_000;

interface CompileViaCodexCliOptions {
  session: Session;
  absoluteToolDir: string;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  startTime: number;
  onProgress?: (p: CompileAgentProgress) => void;
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
  /** Auth segments only: resume the same non-interactive Codex session. */
  resume?: { sessionId: string; message: string };
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
    reasoning_output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
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
      'imprint.model': preferredAgentModel('codex-cli'),
    },
    async (span) => {
      const result = await compileViaCodexCliImpl(opts, span);
      setSpanAttributes(span, {
        'imprint.compile.outcome': result.outcome,
        'imprint.compile.success': result.success,
        'imprint.compile.turns': result.turns,
        'imprint.compile.duration_ms': result.durationMs,
        'imprint.compile.input_tokens': result.inputTokens,
        'imprint.compile.output_tokens': result.outputTokens,
        'imprint.compile.conversation_log': result.conversationLogPath,
      });
      return result;
    },
  );
}

async function compileViaCodexCliImpl(
  opts: CompileViaCodexCliOptions,
  traceSpan?: Span,
): Promise<CompileAgentResult> {
  mkdirSync(opts.absoluteToolDir, { recursive: true });
  for (const name of [
    COMPILE_SENTINELS.done,
    COMPILE_SENTINELS.giveUp,
    COMPILE_SENTINELS.checkpoint,
  ]) {
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
      : buildAuthCodexInitialPrompt(opts.authMode.initialPrompt);
  } else {
    mcpArgs = [
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
    const { assignedSharedModules } = resolvePlanSliceFromFile(
      opts.buildPlanPath,
      opts.candidate?.toolName,
      opts.sharedModules,
    );
    initialPrompt = `<system_instructions>
${systemPrompt}
</system_instructions>

A new compile task is starting.

Session path: ${sessionPathAbs}
Tool directory: ${opts.absoluteToolDir}
You will write artifacts into the tool directory.
${formatCandidateContext(opts.candidate, opts.sharedContext, assignedSharedModules)}
${formatToolPlan(opts.toolPlan)}

Use the imprint-compile MCP tools to inspect the session, write artifacts, run tests, and call done(). Begin by calling read_session_summary, then proceed per the system instructions.`;
  }

  const model = preferredAgentModel('codex-cli');
  const initialTokenCount = resolveTraceTokenCount(null, initialPrompt);
  const captureLlmIo = traceLlmIoEnabled();
  const mcpToolTimeoutSec = resolveMcpToolTimeoutSec(opts.deadlineMs);
  setSpanAttributes(traceSpan, {
    ...llmSpanAttributes({
      provider: 'codex-cli',
      model,
      inputTokens: initialTokenCount.tokens,
      tokenCountsEstimated: true,
      inputTokenSource: initialTokenCount.source,
      inputMessages: captureLlmIo
        ? traceLlmMessages([{ role: 'user', content: initialPrompt }])
        : undefined,
      inputValue: captureLlmIo ? initialPrompt : undefined,
      invocationParameters: {
        command: 'codex exec',
        json: true,
        sandbox: 'workspace-write',
        tool_timeout_sec: mcpToolTimeoutSec,
      },
    }),
    'imprint.compile.initial_prompt_chars': initialPrompt.length,
  });

  const execArgs = opts.resume
    ? ['exec', 'resume']
    : [
        'exec',
        // Data compiles are single-shot. Auth compiles need persisted sessions
        // because run_verification checkpoints resume through `codex exec resume`.
        ...(!opts.authMode ? ['--ephemeral'] : []),
      ];

  const args = [
    '-a',
    'never',
    '-C',
    REPO_ROOT,
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

  let child: ChildProcess;
  try {
    child = spawn('codex', args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The npm `codex` launcher is a Node wrapper around the native binary.
      // Give the wrapper and its descendants a dedicated process group so a
      // watchdog can terminate the whole tree, including descendants that keep
      // the inherited stdout pipe open after the wrapper exits.
      detached: true,
    });
  } catch (err) {
    return finalErrorResult(opts, `failed to spawn codex-cli: ${errMsg(err)}`);
  }

  try {
    child.stdin?.end(initialPrompt);
  } catch (err) {
    try {
      signalCodexProcessTree(child, 'SIGTERM');
    } catch {
      // already gone
    }
    return finalErrorResult(opts, `failed to send prompt to codex-cli: ${errMsg(err)}`);
  }

  const result = await driveJsonl(child, opts, traceSpan);
  const hasActualUsage = result.inputTokens > 0 || result.outputTokens > 0;
  const inputTokenCount = resolveTraceTokenCount(
    hasActualUsage ? result.inputTokens : null,
    initialPrompt,
  );
  const outputTokenCount = resolveTraceTokenCount(
    hasActualUsage ? result.outputTokens : null,
    result.message,
  );
  setSpanAttributes(traceSpan, {
    ...llmSpanAttributes({
      provider: 'codex-cli',
      model,
      inputTokens: inputTokenCount.tokens,
      outputTokens: outputTokenCount.tokens,
      tokenCountsEstimated:
        inputTokenCount.source === 'estimated' || outputTokenCount.source === 'estimated',
      inputTokenSource: inputTokenCount.source,
      outputTokenSource: outputTokenCount.source,
    }),
    'imprint.compile.message': result.message,
  });
  return result;
}

function resolveMcpToolTimeoutSec(deadlineMs: number, now = Date.now()): number {
  const remainingSec = Math.ceil(Math.max(0, deadlineMs - now) / 1000);
  return Math.max(
    MIN_MCP_TOOL_TIMEOUT_SEC,
    Math.min(MAX_MCP_TOOL_TIMEOUT_SEC, remainingSec || MIN_MCP_TOOL_TIMEOUT_SEC),
  );
}

function buildAuthCodexInitialPrompt(initialPrompt: string): string {
  const authPrompt = stripAuthInitialFirstAction(initialPrompt);
  return `You are compiling an Imprint authenticate tool with the imprint-compile MCP tools.

${authPrompt}

Auth compile rules:
- Use the recording and auth plan as the source of truth. Inspect with read_session_summary, search_requests, read_request, and read_response_body before writing files. Use search_requests instead of guessing sparse sequence IDs, especially to find Document requests preceding an OAuth/API chain.
- Write workflow.json for toolKind "authenticate". Include an action parameter with choices ["initiate","complete","submit_otp"], authConfig, bootstrap.url, and both initiate and completion phase requests.
- Use only the canonical workflow schema: request entries use method, url, headers, optional body (a string), optional captures (an array of {source,name,...} with optional scalar equals), effect, optional, and the browser-native mode described below. There is no request phase, bodyJson, singular capture, transform, expect, poll, id, or seq field. Set authConfig.twoFactorType explicitly to "push", "otp", or "none"; authConfig.type is invalid. Put the split in authConfig.initiateRequestCount, push polling in authConfig.pollEndpoint/pollBody/pollTerminal, and the module path in top-level requestTransformModule.
- When a recorded top-level Document page generates coupled browser state or drives redirects (OAuth PKCE is the standard example), represent that recorded GET as {"mode":"navigate","navigation":{"urlIncludes":"..."}} or use navigation.cookie {name,domain?,path?} grounded in the recording. A urlIncludes completion predicate must identify a destination and must not already match the starting URL. This runs the real page JavaScript in the persistent cdp-replay browser. Do not synthesize verifier cookies, guess framework cookie names, or replace the page with manual OAuth API calls.
- Runtime templates use the exact \${credential.X}, \${state.X}, \${generated.uuid}, and \${response[N].path} syntax, never double-brace templates. Serialize JSON request bodies into body strings. For 2FA, list the carried values in authConfig.twoFactorContext and make the final initiate request capture at least one of them as concrete delivery evidence.
- Do not write playbook.yaml. Under the default no-playbook policy, use workflow.json plus a legitimate request-transform.ts.
- Do not freeze recorded-only freshness values such as request IDs, OAuth nonces/challenges/verifiers, browser clock fields, or concrete device/account labels. Generate, capture, transform, or give up after verification proves a required value cannot be represented.
- A recorded encrypted/signed credential envelope is not a freshness value and is not proven stale by static inspection, browser-side generation, opacity, or variation across recordings. Preserve its encryptedData/signature/publicKey fields in the first workflow and call run_verification. Only a concrete pre-challenge verification failure may prove it stale and justify give_up.
- Do not replace a recorded encrypted/signed credential submit with a raw password form unless a request transform derives the equivalent live fields, and do not attempt to reimplement unknown site crypto before testing the recorded envelope.
- Verify with run_verification. It is a checkpoint: after run_verification, prompt_user, or wait_for_cooldown, stop and let the orchestrator resume you.
- Once initiate reaches AWAITING_2FA, do not rerun initiate just to check it again. Prompt the user if needed, then complete/submit_otp once and call done only after verification passes.
- Do not inspect Imprint source or runtime internals before the first workflow.json unless a concrete verification failure requires it.

Your first response MUST be a call to the imprint-compile read_session_summary tool. Do not answer in prose or spend the first turn planning before that tool call.`;
}

function stripAuthInitialFirstAction(initialPrompt: string): string {
  return initialPrompt.replace(
    /\n*MANDATORY FIRST ACTION:\s*call read_session_summary now\.\s*Do not write prose, do not inspect repository files, and do not plan silently before that tool call\.\s*After read_session_summary returns,\s*/m,
    '\n',
  );
}

async function driveJsonl(
  child: ChildProcess,
  opts: CompileViaCodexCliOptions,
  traceSpan?: Span,
): Promise<CompileAgentResult> {
  const conversationLog: unknown[] = [];
  const conversationLogPath = pathJoin(opts.absoluteToolDir, '.compile-log.json');
  const rawStdoutPath = pathJoin(opts.absoluteToolDir, '.codex-stdout.jsonl');
  const rawStderrPath = pathJoin(opts.absoluteToolDir, '.codex-stderr.log');
  const flushLog = (): void => {
    try {
      writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');
    } catch {}
  };
  const rawStdoutChunks: string[] = [];
  const rawStderrChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turn = 0;
  let activeToolCount = 0;
  let lastErrorMessage = '';
  let stderrBuf = '';
  let agentMessageCount = 0;
  let capturedSessionId: string | undefined;
  let lastProgressAt = Date.now();
  let authIdleTimedOut = false;
  let authMcpProgressSeen = false;
  let firstAuthMcpTimer: ReturnType<typeof setTimeout> | undefined;
  const toolSpans = new Map<string, Span>();
  let currentTurnSpan: Span | null = null;

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

  const doneSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.done);
  const giveUpSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.giveUp);
  const checkpointSentinel = pathJoin(opts.absoluteToolDir, COMPILE_SENTINELS.checkpoint);
  const workflowPath = pathJoin(opts.absoluteToolDir, 'workflow.json');
  const parserPath = pathJoin(opts.absoluteToolDir, 'parser.ts');
  const parserTestPath = pathJoin(opts.absoluteToolDir, 'parser.test.ts');
  const requestTransformPath = pathJoin(opts.absoluteToolDir, 'request-transform.ts');
  const segmentStartedAt = Date.now();
  const artifactBaselineMtimes = new Map(
    [workflowPath, requestTransformPath, doneSentinel, giveUpSentinel, checkpointSentinel].map(
      (p) => [p, fileMtimeMs(p)] as const,
    ),
  );
  const authIdleTimeoutMs = resolveAuthCodexIdleTimeoutMs();
  const markProgress = (): void => {
    lastProgressAt = Date.now();
  };
  const clearFirstAuthMcpTimer = (): void => {
    if (!firstAuthMcpTimer) return;
    clearTimeout(firstAuthMcpTimer);
    firstAuthMcpTimer = undefined;
  };
  const terminateChild = (graceMs: number): void => {
    try {
      signalCodexProcessTree(child, 'SIGTERM');
    } catch {
      // already gone
    }
    const forceTimer = setTimeout(() => {
      try {
        signalCodexProcessTree(child, 'SIGKILL');
      } catch {
        // already gone
      }
    }, graceMs);
    forceTimer.unref?.();
  };
  const terminateForAuthIdle = (reason: string): void => {
    if (authIdleTimedOut) return;
    authIdleTimedOut = true;
    log(reason);
    // A stalled native Codex process can ignore SIGTERM while retaining the
    // wrapper's stdout pipe. This path has no checkpoint state to flush, so kill
    // the dedicated process group immediately.
    signalCodexProcessTree(child, 'SIGKILL');
  };
  const checkAuthFirstMcpTimeout = (): void => {
    if (!opts.authMode || authIdleTimedOut || authMcpProgressSeen || turn <= 0) return;
    if (Date.now() - lastProgressAt < authIdleTimeoutMs) return;
    clearFirstAuthMcpTimer();
    terminateForAuthIdle(
      `auth codex segment streamed without imprint-compile MCP/artifact progress for ${Math.round(authIdleTimeoutMs / 1000)}s; terminating`,
    );
  };
  const armFirstAuthMcpTimer = (): void => {
    if (!opts.authMode || authMcpProgressSeen || firstAuthMcpTimer) return;
    log(`auth codex first-MCP watchdog armed for turn ${turn}: ${authIdleTimeoutMs}ms`);
    firstAuthMcpTimer = setTimeout(() => {
      firstAuthMcpTimer = undefined;
      if (authMcpProgressSeen) return;
      terminateForAuthIdle(
        `auth codex segment made no imprint-compile MCP/artifact progress for ${Math.round(authIdleTimeoutMs / 1000)}s; terminating`,
      );
    }, authIdleTimeoutMs);
  };
  const hasFreshAuthArtifactProgress = (): boolean =>
    [workflowPath, requestTransformPath, doneSentinel, giveUpSentinel, checkpointSentinel].some(
      (p) => fileChangedSince(p, artifactBaselineMtimes.get(p), segmentStartedAt),
    );

  const deadlineTimer = setTimeout(
    () => {
      log('wall-clock deadline exceeded, terminating codex');
      terminateChild(5000);
    },
    Math.max(0, opts.deadlineMs - Date.now()),
  );

  let stdoutBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    checkAuthFirstMcpTimeout();
    const chunkText = chunk.toString('utf8');
    rawStdoutChunks.push(chunkText);
    stdoutBuf += chunkText;
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
        setSpanAttributes(traceSpan, { 'codex.thread_id': evt.thread_id });
        if (evt.thread_id) capturedSessionId = evt.thread_id;
        continue;
      }

      if (evt.type === 'turn.started') {
        if (currentTurnSpan) endTraceSpan(currentTurnSpan);
        flushLog();
        turn++;
        markProgress();
        armFirstAuthMcpTimer();
        currentTurnSpan = startTraceSpan(`agent.turn.${turn}`, 'CHAIN', {
          'imprint.agent.turn': turn,
          'imprint.agent.cumulative_input_tokens': inputTokens,
          'imprint.agent.cumulative_output_tokens': outputTokens,
        });
        fireProgress('thinking');
        continue;
      }

      const normalizedToolEvt = normalizeCodexToolEvent(evt);
      if (normalizedToolEvt) {
        const { eventType, item } = normalizedToolEvt;
        const toolName = codexToolName(item);
        if (toolName) {
          traceCodexToolEvent(toolSpans, eventType, item, toolName);
          if (eventType === 'item.started') activeToolCount++;
          if (eventType === 'item.completed') activeToolCount = Math.max(0, activeToolCount - 1);
          markProgress();
          if (opts.authMode && isCodexMcpCompileTool(item)) {
            authMcpProgressSeen = true;
            clearFirstAuthMcpTimer();
          }
          fireProgress(eventType === 'item.started' ? 'tool' : 'thinking', toolName);
        }
        continue;
      }

      if ((evt.type === 'item.started' || evt.type === 'item.completed') && evt.item) {
        const agentMessage = codexAgentMessageText(evt.item);
        if (agentMessage && evt.type === 'item.completed') {
          agentMessageCount++;
          setSpanAttributes(traceSpan, {
            'imprint.codex.agent_messages': agentMessageCount,
            'imprint.codex.last_agent_message_chars': agentMessage.length,
            ...(traceLlmIoEnabled()
              ? llmSpanAttributes({
                  provider: 'codex-cli',
                  model: preferredAgentModel('codex-cli'),
                  outputMessages: traceLlmMessages([{ role: 'assistant', content: agentMessage }]),
                  outputValue: agentMessage,
                })
              : {}),
          });
          continue;
        }
        continue;
      }

      if (evt.type === 'turn.completed') {
        const turnInput = evt.usage?.input_tokens ?? 0;
        const turnOutput = evt.usage?.output_tokens ?? 0;
        inputTokens += turnInput;
        outputTokens += turnOutput;
        if (currentTurnSpan) {
          setSpanAttributes(currentTurnSpan, {
            'imprint.agent.turn_input_tokens': turnInput,
            'imprint.agent.turn_output_tokens': turnOutput,
          });
          endTraceSpan(currentTurnSpan);
          currentTurnSpan = null;
        }
        continue;
      }

      if (evt.type === 'error' || evt.type === 'turn.failed') {
        lastErrorMessage = evt.message ?? evt.error?.message ?? JSON.stringify(evt);
      }
    }
    checkAuthFirstMcpTimeout();
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    checkAuthFirstMcpTimeout();
    const s = chunk.toString('utf8');
    rawStderrChunks.push(s);
    stderrBuf += s;
    log(`[codex stderr] ${s.trim()}`);
  });

  const exitCode: number = await new Promise((resolve) => {
    let resolved = false;
    let forcedKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      clearInterval(sentinelTimer);
      clearInterval(idleTimer);
      resolve(code);
    };
    const terminateForSentinel = (): void => {
      try {
        signalCodexProcessTree(child, 'SIGTERM');
      } catch {
        // already gone
      }
      forcedKillTimer = setTimeout(() => {
        if (resolved) return;
        try {
          signalCodexProcessTree(child, 'SIGKILL');
        } catch {
          // already gone
        }
        // A checkpoint sentinel is enough to let the auth orchestrator proceed;
        // don't wait forever for Codex to acknowledge SIGTERM.
        finish(-1);
      }, 2000);
      forcedKillTimer.unref?.();
    };
    const sentinelTimer = setInterval(() => {
      const checkpointReached = opts.authMode && existsSync(checkpointSentinel);
      if (!existsSync(doneSentinel) && !existsSync(giveUpSentinel) && !checkpointReached) return;
      terminateForSentinel();
    }, 500);
    const idleTimer = setInterval(() => {
      if (!opts.authMode) return;
      if (hasFreshAuthArtifactProgress()) {
        markProgress();
        return;
      }
      // A tool START is progress, but it must not exempt the subprocess forever.
      // Auth shaping tools are checkpointed/read-only and individually bounded;
      // if no completion, artifact, or later event arrives within this window,
      // the MCP call itself is stalled and the whole Codex process tree must go.
      if (turn <= 0 || Date.now() - lastProgressAt < authIdleTimeoutMs) {
        return;
      }
      authIdleTimedOut = true;
      log(
        `auth codex segment made no completed tool/artifact progress for ${Math.round(authIdleTimeoutMs / 1000)}s${activeToolCount > 0 ? ` (${activeToolCount} tool call(s) still active)` : ''}; terminating`,
      );
      terminateForSentinel();
    }, 1000);
    child.once('close', (code) => {
      finish(code ?? -1);
    });
    child.once('error', () => {
      finish(-1);
    });
  });
  clearTimeout(deadlineTimer);
  clearFirstAuthMcpTimer();
  if (currentTurnSpan) endTraceSpan(currentTurnSpan);
  for (const span of toolSpans.values()) endTraceSpan(span);
  toolSpans.clear();

  if (stdoutBuf.trim()) {
    log(`unflushed stdout tail (${stdoutBuf.length} bytes) discarded`);
  }

  try {
    writeFileSync(rawStdoutPath, rawStdoutChunks.join(''), 'utf8');
    writeFileSync(rawStderrPath, rawStderrChunks.join(''), 'utf8');
  } catch {
    // best effort diagnostics
  }
  flushLog();

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
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    sessionId: capturedSessionId,
  };

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

  if (Date.now() > opts.deadlineMs) {
    return {
      success: false,
      outcome: 'timeout',
      message: `codex-cli exceeded the ${Math.round((opts.deadlineMs - opts.startTime) / 60000)} minute deadline before completing.`,
      ...baseResult,
    };
  }

  if (authIdleTimedOut) {
    return {
      success: false,
      outcome: 'error',
      message: `codex-cli auth segment made no required auth compile progress within ${Math.round(authIdleTimeoutMs / 1000)}s after starting a turn.`,
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

function signalCodexProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  child.kill(signal);
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

function isCodexMcpCompileTool(item: NonNullable<CodexJsonEvent['item']>): boolean {
  if (item.server === MCP_SERVER_NAME) return true;
  const name = item.name ?? item.tool_name ?? item.tool;
  return typeof name === 'string' && name.startsWith(`mcp__${MCP_SERVER_NAME}__`);
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

function fileMtimeMs(p: string): number | undefined {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}

function fileChangedSince(
  p: string,
  baselineMtimeMs: number | undefined,
  sinceMs: number,
): boolean {
  const currentMtimeMs = fileMtimeMs(p);
  if (currentMtimeMs === undefined) return false;
  if (baselineMtimeMs === undefined) return currentMtimeMs >= sinceMs - 1;
  return currentMtimeMs > baselineMtimeMs;
}

function finalErrorResult(opts: CompileViaCodexCliOptions, message: string): CompileAgentResult {
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

function resolveAuthCodexIdleTimeoutMs(): number {
  const raw = process.env.IMPRINT_AUTH_CODEX_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_AUTH_CODEX_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUTH_CODEX_IDLE_TIMEOUT_MS;
  return Math.max(1_000, Math.round(parsed));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
