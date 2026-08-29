/**
 * Agentic auth tool compilation — the agent examines the session, writes
 * workflow.json, tests its declared actions live, and iterates until login works.
 *
 * Mirrors compile-agent.ts for data tools but with the auth-specific live-test
 * tool (run_verification) and lighter verification. Authentication runs on a
 * persistent headed cdp-replay session so browser state survives checkpoints.
 *
 * Provider paths mirror compile-agent.ts exactly:
 *   - claude-cli / codex-cli: shell out with the auth toolset registered as a
 *     stdio MCP server (mcp-compile-server.ts in auth mode). The user's CLI
 *     auth drives the loop; subscription tokens, not API credit.
 *   - anthropic-api (or any ToolUseProvider): drive in-process via runAgentLoop.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type AgentTool,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import {
  AUTH_COMPILE_TOOL_NAMES,
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authExternalVerification,
  authLivePreflightFailures,
  authWorkflowHash,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
} from './auth-compile-tools.ts';
import { type AuthActionResult, AuthVerifier } from './auth-verifier.ts';
import type { AuthToolPlan } from './build-plan.ts';
import { compileAuthViaClaudeCli } from './claude-cli-compile.ts';
import { compileViaCodexCli } from './codex-cli-compile.ts';
import type {
  AuthCheckpoint,
  CompileAgentProgress,
  CompileAgentResult,
} from './compile-agent-types.ts';
import { runCompileWithProviderRecovery } from './compile-provider-recovery.ts';
import { abortSignalError, abortableDelay, withAbortSignal } from './concurrency.ts';
import {
  type LLMOptions,
  type ToolUseProvider,
  isToolUseProvider,
  resolveProvider,
} from './llm.ts';
import { createLog } from './log.ts';
import { localToolDir } from './paths.ts';
import {
  ProviderDeadlineError,
  type RunDeadlineRef,
  combinedDeadlineSignal,
  providerControlError,
  resolvedRunDeadline,
} from './provider-retry.ts';
import { loadCredentialStore } from './runtime.ts';
import { type Session, WorkflowSchema } from './types.ts';

const log = createLog('auth-compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

interface CompileAuthAgentOptions {
  site: string;
  session: Session;
  sessionPath: string;
  authToolPlan: NonNullable<AuthToolPlan>;
  teachCredentials: { site: string; values: Record<string, string> };
  llmConfig?: LLMOptions;
  llmProvider?: ToolUseProvider;
  maxDurationMs?: number;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  onProgress?: (p: CompileAgentProgress) => void;
  onDeadlineReached?: () => Promise<number | null>;
  signal?: AbortSignal;
  /** Interactive bridge for the agent's `prompt_user` checkpoint: shows the
   *  agent-generated message (+ optional choices) in the teach TUI and returns
   *  the user's input. When omitted, the agent receives an empty response and
   *  decides how to proceed. */
  onPrompt?: (message: string, options?: string[]) => Promise<string>;
  /** Cool-off bridge for the agent's `wait_for_cooldown` checkpoint: wait the
   *  given minutes (informing the user, firing NO login). Default sleeps. */
  onCooldown?: (minutes: number, reason?: string, signal?: AbortSignal) => Promise<void>;
}

/** Build the initial user message handed to the agent on its first turn.
 *  Shared verbatim by every provider path so the agent's framing is identical. */
function buildAuthInitialMessage(opts: {
  site: string;
  toolName: string;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
}): string {
  const { site, toolName, toolDir, authToolPlan } = opts;
  const durableCaptures = (authToolPlan.captures ?? []).filter((c) => {
    const u = (c.usedAs ?? '').toLowerCase();
    // Cookies persist automatically. Every other downstream transport needs a
    // durable credential contract, including JSON/form body fields.
    return u.length > 0 && u !== 'header:cookie' && u !== 'header:set-cookie';
  });
  const durableCaptureNote =
    durableCaptures.length > 0
      ? `\n- durable credential contracts (data tools consume these as \${credential.<name>}): ${durableCaptures
          .map(
            (c) => `${c.name} (used as ${c.usedAs}; seed source ${c.source}, locator ${c.locator})`,
          )
          .join(
            '; ',
          )}\n  → These names are downstream credential interface names, not required internal capture names. Capture each value on the recording-grounded producing request and include the interface name in authConfig.persist. If you choose a different capture name, declare authConfig.persistBindings[interfaceName] = captureName. The seed source/locator is only a hint.`
      : '';
  return `A new auth compile task is starting.

Site: ${site}
Tool name: ${toolName}
Tool directory: ${toolDir}

Auth tool plan:
- credential-request hints: ${JSON.stringify(authToolPlan.credentialRequestSeqs)}
- related-auth-request hints: ${JSON.stringify(authToolPlan.authRequestSeqs)}
- credentialNames: ${JSON.stringify(authToolPlan.credentialNames)}${durableCaptureNote}
- notes: ${authToolPlan.notes || '(none)'}

MANDATORY FIRST ACTION: call read_session_summary now. Do not write prose, do not inspect repository files, and do not plan silently before that tool call. After read_session_summary returns, examine the login requests and write workflow.json per the system prompt.`;
}

export async function compileAuthAgent(opts: CompileAuthAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();
  const { site, session, authToolPlan } = opts;
  const toolName = authToolPlan.toolName;
  const toolDir = localToolDir(site, toolName);
  mkdirSync(toolDir, { recursive: true });

  const systemPromptPath = pathJoin(PROMPTS_DIR, 'auth-compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(`Auth compile agent prompt not found at ${systemPromptPath}`);
  }

  const runDeadline = resolvedRunDeadline(
    opts.runDeadline,
    opts.deadlineMs ?? Date.now() + (opts.maxDurationMs ?? 10 * 60 * 1000),
  );
  const initialUserMessage = buildAuthInitialMessage({ site, toolName, toolDir, authToolPlan });

  // Provider dispatch mirrors compile-agent.ts. CLI providers don't implement
  // messageWithTools — shell out with the auth toolset as a stdio MCP server.
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolved = resolveProvider(opts.llmConfig);
    if (resolved.name === 'claude-cli') {
      return await runAuthSegmentLoop({
        driver: 'claude-cli',
        site,
        session,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs: runDeadline?.deadlineMs ?? Date.now(),
        runDeadline,
        startTime,
        toolDir,
        authToolPlan,
        teachCredentials: opts.teachCredentials,
        model: opts.llmConfig?.model,
        initialPrompt: initialUserMessage,
        onProgress: opts.onProgress,
        onDeadlineReached: opts.onDeadlineReached,
        signal: opts.signal,
        onPrompt: opts.onPrompt,
        onCooldown: opts.onCooldown,
      });
    }
    if (resolved.name === 'codex-cli') {
      return await runAuthSegmentLoop({
        driver: 'codex-cli',
        site,
        session,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs: runDeadline?.deadlineMs ?? Date.now(),
        runDeadline,
        startTime,
        toolDir,
        authToolPlan,
        teachCredentials: opts.teachCredentials,
        model: opts.llmConfig?.model,
        initialPrompt: initialUserMessage,
        onProgress: opts.onProgress,
        onDeadlineReached: opts.onDeadlineReached,
        signal: opts.signal,
        onPrompt: opts.onPrompt,
        onCooldown: opts.onCooldown,
      });
    }
    if (!isToolUseProvider(resolved)) {
      throw new Error(
        [
          `provider "${resolved.name}" does not support tool use, which the auth compile agent requires.`,
          '→ use one of: claude-cli, codex-cli, anthropic-api (install a supported CLI, or set ANTHROPIC_API_KEY)',
        ].join('\n'),
      );
    }
    provider = resolved;
  }

  // ─── In-process runAgentLoop path (anthropic-api / injected provider) ───────
  const systemPrompt = `${readFileSync(systemPromptPath, 'utf8')}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
  const tools: AgentTool[] = [
    ...buildAuthCompileTools(session, toolDir, opts.sessionPath, opts.teachCredentials),
    doneTool(),
    giveUpTool(),
  ];

  const conversationLogPath = pathJoin(toolDir, '.compile-log.json');

  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let outcome: AgentResult['outcome'] = 'error';
  let message = '';
  let conversationLog: AgentResult['conversationLog'] = [];

  let verificationCycle = 0;
  let currentInitialMessage = initialUserMessage;

  while (true) {
    verificationCycle++;

    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle,
          })
      : undefined;

    const result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs: runDeadline?.deadlineMs ?? Date.now(),
      runDeadline,
      softTurnCap: 30,
      llm: provider,
      onProgress: wrappedOnProgress,
      onConversationUpdate: (currentCycleLog) => {
        const fullLog = [...conversationLog, ...currentCycleLog];
        writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
      },
      onDeadlineReached: opts.onDeadlineReached,
      signal: opts.signal,
    });

    totalTurns += result.turns;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    conversationLog = [...conversationLog, ...result.conversationLog];

    outcome = result.outcome;

    if (result.outcome !== 'done') {
      message = buildMessageFromOutcome(result);
      break;
    }

    const failures = authExternalVerification(
      toolDir,
      (authToolPlan.captures ?? []).map((c) => ({ name: c.name, usedAs: c.usedAs })),
      {
        requireLiveAttempt: true,
        requiredCredentialNames: authToolPlan.credentialNames,
      },
    );

    if (failures.length === 0) {
      message = result.doneSummary ?? 'Auth tool compiled';
      break;
    }

    log(`auth verification failed (cycle ${verificationCycle}), resuming agent loop...`);
    currentInitialMessage = `You called done but verification failed:

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with run_verification, and call done again.`;
  }

  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  const workflowPath = pathJoin(toolDir, 'workflow.json');

  return {
    success: outcome === 'done',
    outcome,
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    message,
    conversationLogPath,
    turns: totalTurns,
    durationMs: Date.now() - startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

interface AuthSegmentLoopOptions {
  driver: 'claude-cli' | 'codex-cli';
  site: string;
  session: Session;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  runDeadline?: RunDeadlineRef;
  startTime: number;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
  teachCredentials: { site: string; values: Record<string, string> };
  model?: string;
  initialPrompt: string;
  onProgress?: (p: CompileAgentProgress) => void;
  onDeadlineReached?: () => Promise<number | null>;
  signal?: AbortSignal;
  onPrompt?: (message: string, options?: string[]) => Promise<string>;
  onCooldown?: (minutes: number, reason?: string, signal?: AbortSignal) => Promise<void>;
}

/** The full set of live-execution facts every verification result carries, so the
 *  agent never has to re-run (or reverse-engineer the runtime) to see what
 *  happened: rung, timing, HTTP status, error code, and the response body. */
function verifyFacts(r: AuthActionResult): string {
  const parts = [`backend=${r.usedBackend}`, `duration=${r.durationMs}ms`];
  if (typeof r.status === 'number') parts.push(`httpStatus=${r.status}`);
  if (r.error) parts.push(`error=${r.error}`);
  let s = `[${parts.join(' | ')}]`;
  if (r.responseBodyPreview) s += `\nResponse body (truncated): ${r.responseBodyPreview}`;
  return s;
}

/** Render an AuthVerifier action result into the message the agent receives on
 *  resume — channel-agnostic, grounded only in the result. Always includes the
 *  full execution facts (status, timing, backend, body) so the agent can decide
 *  its next move without inspecting the runtime. */
function formatVerifyResult(action: string, r: AuthActionResult): string {
  const facts = verifyFacts(r);
  if (r.ok) {
    return `Verification action "${action}" SUCCEEDED. ${facts}\nThe action's declared success outcome was reached. Call done with a one-line summary.`;
  }
  if (r.error === 'ACTION_REQUIRED') {
    return `Verification action "${action}" reached its declared pause outcome. ${facts}\nnextAction=${r.nextAction ?? '(missing)'}\n${r.message ?? ''}\nUse the recording and this result to decide whether to prompt the user or run the next action directly.`;
  }
  return `Verification action "${action}" FAILED. ${facts}\n${r.message ?? ''}\nUse the recording and observed response to revise the action program or choose the next checkpoint.`;
}

/**
 * Drive a CLI auth compile as a sequence of checkpointed SEGMENTS. The
 * agent shapes from the recording, then pauses at checkpoint tools; this loop
 * (the durable orchestrator) executes each checkpoint — run_verification or
 * page inspection on the persistent AuthVerifier session, prompt_user via the
 * TUI bridge, or a cool-off wait — then feeds the result into the next segment.
 * The ONE stateful thing (the live browser) lives in the AuthVerifier and is
 * drained at the end. CLI conversation state is carried by provider-native resume
 * (`claude --resume`, `codex exec resume`), not retained here.
 */
async function runAuthSegmentLoop(opts: AuthSegmentLoopOptions): Promise<CompileAgentResult> {
  const runDeadline = resolvedRunDeadline(opts.runDeadline, opts.deadlineMs);
  const active = combinedDeadlineSignal(
    runDeadline,
    undefined,
    opts.signal,
    Date.now,
    undefined,
    opts.onDeadlineReached,
  );
  const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
  const verificationAttemptPath = pathJoin(opts.toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL);
  if (existsSync(verificationAttemptPath)) unlinkSync(verificationAttemptPath);
  const storedCredentials = await loadCredentialStore(opts.site);
  const credsForRun = {
    site: opts.site,
    cookies: storedCredentials?.cookies ?? [],
    values: { ...(storedCredentials?.values ?? {}), ...opts.teachCredentials.values },
    storage: storedCredentials?.storage ?? [],
  };
  const verifier = new AuthVerifier(workflowPath, credsForRun);
  const authMode = {
    site: opts.site,
    authPlanJson: JSON.stringify(opts.authToolPlan),
    allowedTools: AUTH_COMPILE_TOOL_NAMES,
    initialPrompt: opts.initialPrompt,
  };

  const onPrompt = opts.onPrompt ?? (async () => '');
  const onCooldown =
    opts.onCooldown ??
    (async (minutes: number, _reason?: string, signal?: AbortSignal) =>
      abortableDelay(minutes * 60_000, signal));

  let resume: { sessionId: string; message: string } | undefined;
  let last: CompileAgentResult | undefined;
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  // The most recent live verification, surfaced on the orchestrator's progress
  // line so a failure (e.g. a 403) is visible the instant it happens.
  let lastVerification: CompileAgentProgress['lastVerification'];
  let segment = 0;
  const promptSecrets = new Map<string, string>();
  let promptSecretSequence = 0;

  try {
    while (true) {
      segment++;
      // Each resumed/restarted segment has its own per-segment `turn` at 0; add
      // the prior segments' turns so the displayed count is monotonic (no reset).
      const offset = totalTurns; // turns from prior segments only (read BEFORE the += below)
      const wrappedOnProgress = opts.onProgress
        ? (p: CompileAgentProgress): void =>
            opts.onProgress?.({
              ...p,
              turn: offset + p.turn,
              segment,
              lastVerification,
            })
        : undefined;

      const result = await runCompileWithProviderRecovery({
        runDeadline,
        deadlineMs: opts.deadlineMs,
        initialResume: resume,
        signal: opts.signal,
        onDeadlineReached: opts.onDeadlineReached,
        onRetry: ({ attempt, delayMs, sessionId }) =>
          log(
            `${opts.driver} provider interruption after auth segment ${segment}.${attempt}; ` +
              `${sessionId ? `will resume ${sessionId.slice(0, 8)}` : 'no session started yet'} ` +
              `in ${Math.round(delayMs / 1000)}s`,
          ),
        run: (providerResume, segmentDeadline) => {
          const common = {
            session: opts.session,
            absoluteToolDir: opts.toolDir,
            sessionPath: opts.sessionPath,
            systemPromptPath: opts.systemPromptPath,
            deadlineMs: segmentDeadline?.deadlineMs ?? opts.deadlineMs,
            runDeadline: segmentDeadline,
            startTime: opts.startTime,
            onProgress: wrappedOnProgress,
            onDeadlineReached: opts.onDeadlineReached,
            signal: opts.signal,
            authMode,
            resume: providerResume,
            model: opts.model,
          };
          return opts.driver === 'claude-cli'
            ? compileAuthViaClaudeCli(common)
            : compileViaCodexCli(common);
        },
      });
      last = result;
      totalTurns += result.turns;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheReadInputTokens += result.cacheReadInputTokens;
      totalCacheCreationInputTokens += result.cacheCreationInputTokens;

      if (result.outcome !== 'checkpoint' || !result.checkpoint) {
        if (
          result.outcome === 'soft_cap' &&
          result.sessionId &&
          Date.now() < (runDeadline?.deadlineMs ?? opts.deadlineMs)
        ) {
          const failures = authWorkflowPreflightFailures(
            opts.toolDir,
            opts.session,
            opts.authToolPlan.credentialNames,
          );
          resume = {
            sessionId: result.sessionId,
            message: `You stopped without calling done, give_up, or recording a checkpoint. Continue the auth compile now.${
              failures.length > 0
                ? ` Current workflow preflight failures:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
                : ''
            }`,
          };
          continue;
        }
        break;
      }
      if (!result.sessionId) {
        last = {
          ...result,
          outcome: 'error',
          success: false,
          message: `checkpoint reached but no ${opts.driver} session id was captured — cannot resume the agent.`,
        };
        break;
      }

      const cp: AuthCheckpoint = result.checkpoint;
      let resultMsg: string;
      try {
        if (cp.kind === 'run_verification') {
          const preflightFailures = await authLivePreflightFailures(
            opts.toolDir,
            opts.session,
            opts.authToolPlan.credentialNames,
            [...opts.authToolPlan.credentialRequestSeqs, ...opts.authToolPlan.authRequestSeqs],
            opts.sessionPath,
          );
          if (Date.now() >= (runDeadline?.deadlineMs ?? opts.deadlineMs)) {
            throw new ProviderDeadlineError(runDeadline?.deadlineMs ?? opts.deadlineMs);
          }
          if (preflightFailures.length > 0) {
            resultMsg = `run_verification was blocked before any live login was fired because workflow.json failed auth preflight:\n${preflightFailures
              .map((failure) => `- ${failure}`)
              .join('\n')}`;
          } else {
            const verifiedWorkflowHash = authWorkflowHash(
              WorkflowSchema.parse(
                JSON.parse(readFileSync(pathJoin(opts.toolDir, 'workflow.json'), 'utf8')),
              ),
            );
            const resolvedParameters = Object.fromEntries(
              Object.entries(cp.parameters ?? {}).map(([name, value]) => [
                name,
                typeof value === 'string' && promptSecrets.has(value)
                  ? (promptSecrets.get(value) ?? '')
                  : value,
              ]),
            );
            const r = await verifier.runAction(cp.action, resolvedParameters, {
              freshSession: cp.freshSession,
              cleanSession: cp.cleanSession,
              signal: active.signal,
            });
            writeFileSync(
              verificationAttemptPath,
              JSON.stringify(
                {
                  action: cp.action,
                  ok: r.ok,
                  status: r.status,
                  error: r.error,
                  backend: r.usedBackend,
                  workflowHash: verifiedWorkflowHash,
                  timestamp: Date.now(),
                },
                null,
                2,
              ),
              'utf8',
            );
            // Record + immediately surface the result so the spinner reflects a
            // failure the moment it happens — not only on the next agent turn.
            lastVerification = {
              action: cp.action,
              ok: r.ok,
              status: r.status,
              error: r.error,
              backend: r.usedBackend,
              durationMs: r.durationMs,
              checkpoint: 'run_verification',
            };
            opts.onProgress?.({
              turn: totalTurns,
              phase: 'tool',
              elapsedMs: Date.now() - opts.startTime,
              budgetMs: Math.max(0, (runDeadline?.deadlineMs ?? opts.deadlineMs) - Date.now()),
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              verificationCycle: 1,
              segment,
              lastVerification,
            });
            resultMsg = formatVerifyResult(cp.action, r);
          }
        } else if (cp.kind === 'inspect_verification_page') {
          const inspected = await verifier.inspectPage({
            maxChars: cp.maxChars,
            includeCookies: cp.includeCookies,
            signal: active.signal,
          });
          resultMsg = inspected.ok
            ? `Current verification page snapshot:\n${JSON.stringify(inspected, null, 2)}`
            : `Verification page inspection was unavailable: ${inspected.message ?? 'unknown reason'}`;
        } else if (cp.kind === 'prompt_user') {
          const answer = await withAbortSignal(
            () => onPrompt(cp.message, cp.options),
            active.signal,
          );
          const reference = `\${prompt.${++promptSecretSequence}}`;
          promptSecrets.set(reference, answer);
          resultMsg = answer
            ? `The user response is stored locally as ${reference}. Pass that exact reference as the appropriate run_verification parameter value; the orchestrator resolves it without exposing the answer to the model.`
            : 'The user provided no input.';
        } else {
          await withAbortSignal(
            () => onCooldown(cp.minutes, cp.reason, active.signal),
            active.signal,
          );
          resultMsg = `Requested delay of ~${cp.minutes} min completed; no live action ran during the wait.`;
        }
      } catch (err) {
        if (opts.signal?.aborted) throw abortSignalError(opts.signal, 'Auth compile cancelled');
        const control = providerControlError(active.signal?.aborted ? active.signal.reason : err);
        if (control) throw control;
        resultMsg = `The orchestrator could not perform ${cp.kind}: ${err instanceof Error ? err.message : String(err)}`;
      }

      const resumeMessage = `[orchestrator result for your ${cp.kind} request]\n${resultMsg}\n\nContinue from the recording and observed result. You control the next action or checkpoint.`;
      resume = {
        sessionId: result.sessionId,
        message: resumeMessage,
      };
    }
  } finally {
    active.dispose();
    await verifier.drain();
  }

  if (!last) {
    return {
      success: false,
      outcome: 'error',
      message: 'Auth segment loop produced no result.',
      conversationLogPath: pathJoin(opts.toolDir, '.compile-log.json'),
      turns: 0,
      durationMs: Date.now() - opts.startTime,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
  }
  // Each segment result already includes any same-session provider retries.
  // Add each completed auth segment exactly once.
  return {
    ...last,
    turns: totalTurns,
    durationMs: Date.now() - opts.startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadInputTokens: totalCacheReadInputTokens,
    cacheCreationInputTokens: totalCacheCreationInputTokens,
  };
}

function buildMessageFromOutcome(result: AgentResult): string {
  switch (result.outcome) {
    case 'give_up':
      return `Auth agent gave up: ${result.giveUpReason ?? 'unknown reason'}\n${result.giveUpDetail ?? ''}`;
    case 'timeout':
      return 'Auth agent timed out before completion';
    case 'soft_cap':
      return 'Auth agent exceeded soft turn cap (30 turns)';
    case 'error':
      return `Auth agent error: ${result.errorMessage ?? 'unknown error'}`;
    default:
      return 'Unknown outcome';
  }
}
