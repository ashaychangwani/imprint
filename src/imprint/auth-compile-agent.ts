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

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type AgentTool,
  type ConversationLogEntry,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import { AuthBrowserActionSchema } from './auth-browser-discovery.ts';
import {
  AUTH_CHECKPOINT_TOOLS,
  AUTH_COMPILE_TOOL_NAMES,
  AUTH_VERIFICATION_ATTEMPT_SENTINEL,
  authExternalVerification,
  authLivePreflightFailures,
  authWorkflowHash,
  authWorkflowPreflightFailures,
  buildAuthCompileTools,
  parseAuthCheckpoint,
} from './auth-compile-tools.ts';
import { AuthDiscoveryEvidence } from './auth-discovery-evidence.ts';
import { type AuthActionResult, AuthVerifier } from './auth-verifier.ts';
import type { AuthToolPlan } from './build-plan.ts';
import { compileAuthViaClaudeCli } from './claude-cli-compile.ts';
import { compileViaCodexCli } from './codex-cli-compile.ts';
import type {
  AuthCheckpoint,
  AuthCheckpointResult,
  CompileAgentProgress,
  CompileAgentResult,
} from './compile-agent-types.ts';
import { runCompileWithProviderRecovery } from './compile-provider-recovery.ts';
import { abortSignalError, abortableDelay, withAbortSignal } from './concurrency.ts';
import { isCredentialReference } from './credential-extract.ts';
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
import { type CredentialStore, loadCredentialStore } from './runtime.ts';
import { type Session, WorkflowSchema } from './types.ts';
import { requestAgentInteraction, resolveUserInput } from './user-interaction.ts';

const log = createLog('auth-compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

async function loadAuthCredentials(
  site: string,
  recordedValues: Record<string, string>,
): Promise<CredentialStore> {
  const stored = await loadCredentialStore(site);
  // Already-redacted recordings can reach the compiler through other callers.
  // Never let their references shadow real values from the credential backend.
  const literalValues = Object.fromEntries(
    Object.entries(recordedValues).filter(([, value]) => !isCredentialReference(value)),
  );
  return {
    site,
    cookies: stored?.cookies ?? [],
    storage: stored?.storage ?? [],
    values: { ...stored?.values, ...literalValues },
  };
}

async function promptAuthUser(
  message: string,
  options?: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await requestAgentInteraction(
    {
      action: 'prompt_user',
      prompt: { message, options, sensitive: options === undefined },
    },
    signal,
  );
  if (result.status !== 'answered' || !('value' in result)) {
    throw new Error('reason' in result ? result.reason : 'User input is unavailable');
  }
  return await resolveUserInput(result.value);
}

interface AuthCheckpointExecutorOptions {
  context: AuthCompileContext;
  session: Session;
  sessionPath: string;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
  verifier: AuthVerifier;
  signal?: AbortSignal;
  deadline?: () => number | undefined;
  onPrompt?: CompileAuthAgentOptions['onPrompt'];
  onCooldown?: CompileAuthAgentOptions['onCooldown'];
  onVerification?: (action: string, result: AuthActionResult) => void;
}

/** One operation owns its current human references. All provider adapters execute
 * the same host actions; native/API calls await them without ending an assignment. */
function createAuthCheckpointExecutor(options: AuthCheckpointExecutorOptions) {
  const promptSecrets = new Map<string, string>();
  const lifetime = new AbortController();
  return {
    dispose: () => {
      promptSecrets.clear();
      lifetime.abort(new Error('Authentication checkpoint operation ended'));
    },
    async execute(cp: AuthCheckpoint, requestSignal?: AbortSignal): Promise<AuthCheckpointResult> {
      const signal = AbortSignal.any(
        [lifetime.signal, options.signal, requestSignal].filter(
          (value): value is AbortSignal => value !== undefined,
        ),
      );
      try {
        if (signal?.aborted) throw abortSignalError(signal);
        if (cp.kind === 'prompt_user') {
          const answer = await withAbortSignal(
            () =>
              options.onPrompt
                ? options.onPrompt(cp.message, cp.options)
                : promptAuthUser(cp.message, cp.options, signal),
            signal,
          );
          if (cp.options?.includes(answer))
            return {
              result: JSON.stringify({ status: 'answered', kind: 'choice', value: answer }),
            };
          const reference = `\${prompt.${randomUUID()}}`;
          promptSecrets.set(reference, answer);
          return {
            result: answer
              ? `The user response is stored locally as ${reference}. Pass that exact reference as the appropriate run_verification parameter value; the host resolves it without exposing the answer to the model.`
              : 'The user provided no input.',
          };
        }
        if (cp.kind === 'inspect_verification_page') {
          const inspected = await options.verifier.inspectPage({
            maxChars: cp.maxChars,
            includeCookies: cp.includeCookies,
            signal,
          });
          return {
            result: inspected.ok
              ? `Current verification page snapshot:\n${JSON.stringify(inspected, null, 2)}`
              : `Verification page inspection was unavailable: ${inspected.message ?? 'unknown reason'}`,
          };
        }
        if (cp.kind === 'interact_verification_browser') {
          const action = AuthBrowserActionSchema.parse(cp);
          if ('value' in action)
            action.value = await resolveUserInput(
              promptSecrets.get(action.value) ?? action.value,
              signal,
            );
          return {
            result: options.context
              .discoveryEvidence(options.session, options.toolDir)
              .append(await options.verifier.interactBrowser(action, signal)),
          };
        }
        if (cp.kind === 'wait_for_cooldown') {
          await withAbortSignal(
            () =>
              options.onCooldown
                ? options.onCooldown(cp.minutes, cp.reason, signal)
                : abortableDelay(cp.minutes * 60_000, signal),
            signal,
          );
          return {
            result: `Requested delay of ~${cp.minutes} min completed; no live action ran during the wait.`,
          };
        }
        const failures = await authLivePreflightFailures(
          options.toolDir,
          options.session,
          options.authToolPlan.credentialNames,
          [...options.authToolPlan.credentialRequestSeqs, ...options.authToolPlan.authRequestSeqs],
          options.sessionPath,
        );
        if (signal?.aborted) throw abortSignalError(signal);
        const deadline = options.deadline?.();
        if (deadline !== undefined && Date.now() >= deadline)
          throw new ProviderDeadlineError(deadline);
        if (failures.length)
          return {
            result: `run_verification was blocked before any live login was fired because workflow.json failed auth preflight:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
            isError: true,
          };
        const workflowHash = authWorkflowHash(
          WorkflowSchema.parse(
            JSON.parse(readFileSync(pathJoin(options.toolDir, 'workflow.json'), 'utf8')),
          ),
        );
        if (cp.freshSession || cp.cleanSession) promptSecrets.clear();
        const parameters = await resolveUserInput(
          Object.fromEntries(
            Object.entries(cp.parameters ?? {}).map(([name, value]) => [
              name,
              typeof value === 'string' && promptSecrets.has(value)
                ? (promptSecrets.get(value) ?? value)
                : value,
            ]),
          ),
          signal,
        );
        const result = await options.verifier.runAction(cp.action, parameters, {
          freshSession: cp.freshSession,
          cleanSession: cp.cleanSession,
          signal,
        });
        writeFileSync(
          pathJoin(options.toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL),
          JSON.stringify({
            action: cp.action,
            ok: result.ok,
            status: result.status,
            error: result.error,
            backend: result.usedBackend,
            workflowHash,
            timestamp: Date.now(),
          }),
          { mode: 0o600 },
        );
        options.onVerification?.(cp.action, result);
        return { result: formatVerifyResult(cp.action, result) };
      } catch (error) {
        if (signal?.aborted) throw abortSignalError(signal, 'Auth checkpoint cancelled');
        const control = providerControlError(error);
        if (control) throw control;
        return {
          result: `The host could not perform ${cp.kind}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

function liveAuthTools(executor: ReturnType<typeof createAuthCheckpointExecutor>): AgentTool[] {
  return AUTH_CHECKPOINT_TOOLS.map((definition) => ({
    ...definition,
    description: `${definition.description} Await the host result and continue in this assignment.`,
    handler: async (input, request) =>
      executor.execute(parseAuthCheckpoint(definition.name, input), request?.signal),
  }));
}

/** Run-local ownership, never persisted or shared across teach runs. */
export class AuthCompileContext {
  readonly #abort = new AbortController();
  #verifier?: AuthVerifier;
  #workflowPath?: string;
  #evidence?: AuthDiscoveryEvidence;
  #dispose?: Promise<void>;
  cliSession?: { driver: 'claude-cli' | 'codex-cli'; sessionId: string };
  history: ConversationLogEntry[] = [];
  previousResult?: Pick<CompileAgentResult, 'outcome' | 'message'>;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async verifier(
    workflowPath: string,
    credentials: () => Promise<CredentialStore>,
    discoveryUrl?: string,
  ): Promise<AuthVerifier> {
    if (this.signal.aborted) throw abortSignalError(this.signal);
    if (this.#workflowPath && this.#workflowPath !== workflowPath)
      throw new Error('An authentication context belongs to one workflow workspace');
    this.#workflowPath = workflowPath;
    const values = await credentials();
    if (this.signal.aborted) throw abortSignalError(this.signal);
    if (this.#verifier) this.#verifier.updateCredentials(values);
    else this.#verifier = new AuthVerifier(workflowPath, values, discoveryUrl);
    return this.#verifier;
  }

  discoveryEvidence(session: Session, toolDir: string): AuthDiscoveryEvidence {
    this.#evidence ??= new AuthDiscoveryEvidence(session, toolDir);
    return this.#evidence;
  }

  recoveryMessage(plan: NonNullable<AuthToolPlan>): string {
    return `Continue the existing authentication task in this same workspace and browser.
Existing artifacts and earlier observations remain available; do not repeat the initial recording read by default.
Current request: ${JSON.stringify(plan)}
Previous compiler outcome: ${this.previousResult?.outcome ?? 'interrupted'}
Previous report: ${this.previousResult?.message ?? '(no terminal report)'}
Current verification metadata: ${JSON.stringify(this.#verifier?.state ?? {})}
Earlier human-response references have expired. Ask for fresh input when an action requires it.
First run a proven noninteractive session check or context-restoration action in the retained browser. If it passes, return the result so the caller can retry its own protected operation. Before starting another login or delivering a factor, inspect current evidence that the existing access is unusable and the new login/challenge is required. Revise the procedure with response-based branches when needed. A prior auth success does not prove the caller's data operation works.`;
  }

  dispose(): Promise<void> {
    if (this.#dispose) return this.#dispose;
    this.#abort.abort(new DOMException('Authentication context closed', 'AbortError'));
    this.cliSession = undefined;
    this.history = [];
    this.previousResult = undefined;
    this.#dispose = this.#verifier?.drain() ?? Promise.resolve();
    return this.#dispose;
  }
}

interface CompileAuthAgentOptions {
  /** Keep a teach's internal authentication build in its run staging directory. */
  outDir?: string;
  /** Keep browser and provider conversation for later recovery in this teach. */
  context?: AuthCompileContext;
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
  const context = opts.context ?? new AuthCompileContext();
  try {
    const result = await compileAuthWithContext({
      ...opts,
      context,
      signal: opts.signal ? AbortSignal.any([opts.signal, context.signal]) : context.signal,
    });
    context.previousResult = { outcome: result.outcome, message: result.message };
    return result;
  } catch (error) {
    context.previousResult = {
      outcome: 'error',
      message:
        'The previous authentication request was interrupted; its retained state is available for inspection.',
    };
    throw error;
  } finally {
    if (!opts.context) await context.dispose();
  }
}

async function compileAuthWithContext(
  input: CompileAuthAgentOptions & { context: AuthCompileContext },
): Promise<CompileAgentResult> {
  const startTime = Date.now();
  const { site, authToolPlan } = input;
  const toolName = authToolPlan.toolName;
  const toolDir = input.outDir ?? localToolDir(site, toolName);
  mkdirSync(toolDir, { recursive: true });
  const evidence = input.context.discoveryEvidence(input.session, toolDir);
  const opts = { ...input, session: evidence.session, sessionPath: evidence.sessionPath };
  const session = evidence.session;

  const systemPromptPath = pathJoin(PROMPTS_DIR, 'auth-compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(`Auth compile agent prompt not found at ${systemPromptPath}`);
  }

  const runDeadline = resolvedRunDeadline(
    opts.runDeadline,
    opts.deadlineMs ?? Date.now() + (opts.maxDurationMs ?? 10 * 60 * 1000),
  );
  const recovering = opts.context.cliSession !== undefined || opts.context.history.length > 0;
  const initialUserMessage = recovering
    ? opts.context.recoveryMessage(authToolPlan)
    : buildAuthInitialMessage({ site, toolName, toolDir, authToolPlan });

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
        context: opts.context,
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
        context: opts.context,
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
  const active = combinedDeadlineSignal(
    runDeadline,
    undefined,
    opts.signal,
    Date.now,
    undefined,
    opts.onDeadlineReached,
  );
  const attemptPath = pathJoin(toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL);
  if (existsSync(attemptPath)) unlinkSync(attemptPath);
  const verifier = await opts.context.verifier(
    pathJoin(toolDir, 'workflow.json'),
    () => loadAuthCredentials(site, opts.teachCredentials.values),
    session.url,
  );
  const checkpointExecutor = createAuthCheckpointExecutor({
    ...opts,
    toolDir,
    verifier,
    signal: active.signal,
    deadline: () => runDeadline?.deadlineMs,
  });
  try {
    const systemPrompt = `${readFileSync(systemPromptPath, 'utf8')}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
    const tools: AgentTool[] = [
      ...buildAuthCompileTools(session, toolDir, opts.sessionPath, opts.teachCredentials),
      ...liveAuthTools(checkpointExecutor),
      doneTool(),
      giveUpTool(),
    ];

    const conversationLogPath = pathJoin(toolDir, '.compile-log.json');

    let totalTurns = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let outcome: AgentResult['outcome'] = 'error';
    let message = '';
    let conversationLog: AgentResult['conversationLog'] = [...opts.context.history];

    let verificationCycle = 0;
    let currentInitialMessage = initialUserMessage;

    while (true) {
      verificationCycle++;
      conversationLog = completeAuthHistory(conversationLog);

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
        llm: {
          ...provider,
          messageWithTools: (input) =>
            provider.messageWithTools({
              ...input,
              messages: [...authHistoryMessages(conversationLog), ...input.messages],
            }),
        },
        onProgress: wrappedOnProgress,
        onConversationUpdate: (currentCycleLog) => {
          const fullLog = [...conversationLog, ...currentCycleLog];
          opts.context.history = fullLog;
          writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
        },
        onDeadlineReached: opts.onDeadlineReached,
        signal: active.signal,
      });

      totalTurns += result.turns;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      conversationLog = [...conversationLog, ...result.conversationLog];
      opts.context.history = conversationLog;

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
  } finally {
    checkpointExecutor.dispose();
    active.dispose();
  }
}

interface AuthSegmentLoopOptions {
  context: AuthCompileContext;
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
  if (r.requestStageFacts) s += `\nRequest stages: ${JSON.stringify(r.requestStageFacts)}`;
  if (r.authExecution) s += `\nAction execution: ${JSON.stringify(r.authExecution)}`;
  if (r.responseObservations)
    s += `\nResponse observations: ${JSON.stringify(r.responseObservations)}`;
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
 * retained until its owning context closes. CLI conversation state uses provider-native resume
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
  const verifier = await opts.context.verifier(
    workflowPath,
    () => loadAuthCredentials(opts.site, opts.teachCredentials.values),
    opts.session.url,
  );
  let resume: { sessionId: string; message: string } | undefined =
    opts.context.cliSession?.driver === opts.driver
      ? { sessionId: opts.context.cliSession.sessionId, message: opts.initialPrompt }
      : undefined;
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
  const checkpointExecutor = createAuthCheckpointExecutor({
    ...opts,
    verifier,
    signal: active.signal,
    deadline: () => runDeadline?.deadlineMs ?? opts.deadlineMs,
    onVerification: (action, result) => {
      lastVerification = {
        action,
        ok: result.ok,
        status: result.status,
        error: result.error,
        backend: result.usedBackend,
        durationMs: result.durationMs,
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
    },
  });
  const authMode = {
    site: opts.site,
    contextRef: opts.authToolPlan.contextRef,
    authPlanJson: JSON.stringify(opts.authToolPlan),
    allowedTools: AUTH_COMPILE_TOOL_NAMES,
    initialPrompt: opts.initialPrompt,
    executeCheckpoint: checkpointExecutor.execute,
  };

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
      if (result.sessionId)
        opts.context.cliSession = { driver: opts.driver, sessionId: result.sessionId };
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

      const cp = result.checkpoint;
      const { result: resultMsg } = await checkpointExecutor.execute(cp);

      const resumeMessage = `[orchestrator result for your ${cp.kind} request]\n${resultMsg}\n\nContinue from the recording and observed result. You control the next action or checkpoint.`;
      resume = {
        sessionId: result.sessionId,
        message: resumeMessage,
      };
    }
  } finally {
    active.dispose();
    checkpointExecutor.dispose();
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

/** Complete terminal tool calls before a later API recovery turn. */
function completeAuthHistory(history: ConversationLogEntry[]): ConversationLogEntry[] {
  const last = history.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return history;
  const calls = last.content.filter((block) => block.type === 'tool_use');
  if (!calls.length) return history;
  return [
    ...history,
    {
      turn: last.turn,
      role: 'user',
      content: calls.map((block) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: 'Previous authentication request ended. Continue from current evidence.',
      })),
    },
  ];
}

function authHistoryMessages(
  history: ConversationLogEntry[],
): Parameters<ToolUseProvider['messageWithTools']>[0]['messages'] {
  return completeAuthHistory(history).map(({ role, content }) => ({ role, content })) as Parameters<
    ToolUseProvider['messageWithTools']
  >[0]['messages'];
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
