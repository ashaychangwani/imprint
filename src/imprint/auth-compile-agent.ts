/**
 * Agentic auth tool compilation — the agent examines the session, writes
 * workflow.json, tests it against the live site, iterates until login works.
 *
 * Mirrors compile-agent.ts for data tools but with the auth-specific live-test
 * tool (run_verification) and lighter verification. Authentication runs on a
 * single rung — headed cdp-replay (a real visible browser that replays the
 * recorded requests in-page); see AUTH_RUNGS in auth-verifier.ts. There is no
 * bespoke login backend and no playbook rung in the auth path.
 *
 * Provider paths mirror compile-agent.ts exactly:
 *   - claude-cli / codex-cli: shell out with the auth toolset registered as a
 *     stdio MCP server (mcp-compile-server.ts in auth mode). The user's CLI
 *     auth drives the loop; subscription tokens, not API credit.
 *   - anthropic-api (or any ToolUseProvider): drive in-process via runAgentLoop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type AgentTool,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import { ensureAuthBootstrap } from './auth-bootstrap.ts';
import {
  AUTH_COMPILE_TOOL_NAMES,
  authExternalVerification,
  buildAuthCompileTools,
} from './auth-compile-tools.ts';
import { type AuthPhaseResult, AuthVerifier } from './auth-verifier.ts';
import type { AuthToolPlan } from './build-plan.ts';
import { compileAuthViaClaudeCli } from './claude-cli-compile.ts';
import type {
  AuthCheckpoint,
  CompileAgentProgress,
  CompileAgentResult,
} from './compile-agent-types.ts';
import {
  type LLMOptions,
  type ToolUseProvider,
  isToolUseProvider,
  resolveProvider,
} from './llm.ts';
import { createLog } from './log.ts';
import { localToolDir } from './paths.ts';
import type { Session } from './types.ts';

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
  onProgress?: (p: CompileAgentProgress) => void;
  /** Interactive bridge for the agent's `prompt_user` checkpoint: shows the
   *  agent-generated message (+ optional choices) in the teach TUI and returns
   *  the user's input (the live OTP, a confirmation, etc.). When omitted
   *  (--no-interactive), a placeholder is supplied so the run still ATTEMPTS the
   *  completion unattended. */
  onPrompt?: (message: string, options?: string[]) => Promise<string>;
  /** Cool-off bridge for the agent's `wait_for_cooldown` checkpoint: wait the
   *  given minutes (informing the user, firing NO login). Default sleeps. */
  onCooldown?: (minutes: number, reason?: string) => Promise<void>;
}

/** Unattended OTP placeholder when no interactive prompt bridge is supplied. */
const ATTEMPT_OTP_PLACEHOLDER = '000000';
/** Runaway guard on the number of agent segments per auth run. */
const MAX_AUTH_SEGMENTS = 16;

/** Build the initial user message handed to the agent on its first turn.
 *  Shared verbatim by every provider path so the agent's framing is identical. */
function buildAuthInitialMessage(opts: {
  site: string;
  toolName: string;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
}): string {
  const { site, toolName, toolDir, authToolPlan } = opts;
  const headerCaptures = (authToolPlan.captures ?? []).filter((c) => {
    const u = (c.usedAs ?? '').toLowerCase();
    // Cookies persist automatically — only surface NON-cookie header contracts.
    return u.startsWith('header:') && u !== 'header:cookie' && u !== 'header:set-cookie';
  });
  const sessionCaptureNote =
    headerCaptures.length > 0
      ? `\n- sessionCapture contracts (data tools consume these as \${credential.<name>}): ${headerCaptures
          .map(
            (c) => `${c.name} (used as ${c.usedAs}; seed source ${c.source}, locator ${c.locator})`,
          )
          .join(
            '; ',
          )}\n  → For each, add an authConfig.sessionCapture that reads this token from the login COMPLETION response (verify the real source/locator against the recorded response; the seed is a hint). Verification fails without it.`
      : '';
  return `A new auth compile task is starting.

Site: ${site}
Tool name: ${toolName}
Tool directory: ${toolDir}

Auth tool plan:
- loginRequestSeqs: ${JSON.stringify(authToolPlan.loginRequestSeqs)}
- twoFactorRequestSeqs: ${JSON.stringify(authToolPlan.twoFactorRequestSeqs)}
- twoFactorType: ${authToolPlan.twoFactorType}
- credentialNames: ${JSON.stringify(authToolPlan.credentialNames)}${sessionCaptureNote}
- notes: ${authToolPlan.notes || '(none)'}

Begin by calling read_session_summary to orient yourself, then examine the login requests and write workflow.json per the system prompt.`;
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

  const deadlineMs = Date.now() + (opts.maxDurationMs ?? 10 * 60 * 1000);
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
        site,
        session,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        startTime,
        toolDir,
        authToolPlan,
        teachCredentials: opts.teachCredentials,
        initialPrompt: initialUserMessage,
        onProgress: opts.onProgress,
        onPrompt: opts.onPrompt,
        onCooldown: opts.onCooldown,
      });
    }
    if (resolved.name === 'codex-cli') {
      // Auth verification is checkpoint-based: the agent calls run_verification and
      // STOPS, and the orchestrator must resume the SAME session past that
      // checkpoint with the live result. codex-cli runs ephemerally (no resume) and
      // its driver only recognizes the done/give_up sentinels — not the checkpoint
      // sentinel — so a run_verification checkpoint exits 0, is misread as "stopped
      // early", and every codex auth compile fails with a misleading message.
      // Reject it up front rather than fail late. (Data-tool compiles, which never
      // checkpoint, still run on codex-cli.)
      throw new Error(
        [
          'provider "codex-cli" cannot compile an authenticate tool: live 2FA verification is checkpoint-based and codex-cli runs ephemerally — it cannot resume past a run_verification checkpoint.',
          '→ use one of: claude-cli, anthropic-api (set ANTHROPIC_API_KEY)',
        ].join('\n'),
      );
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

  const MAX_VERIFICATION_CYCLES = 3;
  let verificationCycle = 0;
  let currentInitialMessage = initialUserMessage;

  while (verificationCycle < MAX_VERIFICATION_CYCLES) {
    verificationCycle++;

    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle,
            maxVerificationCycles: MAX_VERIFICATION_CYCLES,
          })
      : undefined;

    const result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs,
      softTurnCap: 30,
      llm: provider,
      onProgress: wrappedOnProgress,
      onConversationUpdate: (currentCycleLog) => {
        const fullLog = [...conversationLog, ...currentCycleLog];
        writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
      },
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
    );

    if (failures.length === 0) {
      message = result.doneSummary ?? 'Auth tool compiled';
      break;
    }

    if (verificationCycle >= MAX_VERIFICATION_CYCLES) {
      outcome = 'error';
      message = `Auth verification failed after ${MAX_VERIFICATION_CYCLES} cycles. Failures:\n${failures.join('\n')}`;
      break;
    }

    log(`auth verification failed (cycle ${verificationCycle}), resuming agent loop...`);
    currentInitialMessage = `You called done but verification failed:

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with run_verification, and call done again.`;
  }

  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  // Same credential-entry bootstrap safety net as the segmented path.
  injectAuthBootstrapArtifact(toolDir, session, authToolPlan);

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
  site: string;
  session: Session;
  sessionPath: string;
  systemPromptPath: string;
  deadlineMs: number;
  startTime: number;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
  teachCredentials: { site: string; values: Record<string, string> };
  initialPrompt: string;
  onProgress?: (p: CompileAgentProgress) => void;
  onPrompt?: (message: string, options?: string[]) => Promise<string>;
  onCooldown?: (minutes: number, reason?: string) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The full set of live-execution facts every verification result carries, so the
 *  agent never has to re-run (or reverse-engineer the runtime) to see what
 *  happened: rung, timing, HTTP status, error code, and the response body. */
function verifyFacts(r: AuthPhaseResult): string {
  const parts = [`backend=${r.usedBackend}`, `duration=${r.durationMs}ms`];
  if (typeof r.status === 'number') parts.push(`httpStatus=${r.status}`);
  if (r.error) parts.push(`error=${r.error}`);
  let s = `[${parts.join(' | ')}]`;
  if (r.responseBodyPreview) s += `\nResponse body (truncated): ${r.responseBodyPreview}`;
  return s;
}

/** Render an AuthVerifier phase result into the message the agent receives on
 *  resume — channel-agnostic, grounded only in the result. Always includes the
 *  full execution facts (status, timing, backend, body) so the agent can decide
 *  its next move without inspecting the runtime. */
function formatVerifyResult(phase: string, r: AuthPhaseResult): string {
  const facts = verifyFacts(r);
  if (r.ok) {
    return `Verification phase "${phase}" SUCCEEDED. ${facts}\nThe login completed and the session token is now stored for data tools. Call done with a one-line summary.`;
  }
  if (r.error === 'AWAITING_2FA') {
    const ctxKeys = r.twoFactorContext ? Object.keys(r.twoFactorContext) : [];
    return `Verification phase "${phase}" reached the 2FA challenge (AWAITING_2FA, type=${r.twoFactorType ?? 'unknown'}). ${facts}\nThe OTP/push has been delivered to the user${ctxKeys.length ? ` (carried token keys: ${ctxKeys.join(', ')})` : ''}. Now call prompt_user to ask them for the live second factor, then run_verification for the completion phase.`;
  }
  if (r.error === 'BUDGET_EXHAUSTED') {
    return `Verification refused: ${r.message} ${facts}\nDo not request another initiate — give_up if you cannot complete.`;
  }
  if (r.error === 'ATTEMPT_BUDGET_EXHAUSTED') {
    return `Verification refused: ${r.message} ${facts}\nEvery initiate failed before delivering a 2FA challenge, so cool-off will not help. Stop requesting initiates and give_up — leave the corrected artifacts for a fresh run.`;
  }
  return `Verification phase "${phase}" FAILED. ${facts}\n${r.message ?? ''}\nThis attempt did NOT consume your 2FA-challenge budget (no challenge was delivered). If it looks like the site rate-flagging repeated logins, call wait_for_cooldown. If it's a defect in workflow.json (e.g. a bot-block 403 because the login page sensor never ran — make sure a top-level bootstrap points at the credential-entry page), fix it and run_verification again.`;
}

/**
 * Drive the claude-cli auth compile as a sequence of resumable SEGMENTS. The
 * agent shapes from the recording, then pauses at checkpoint tools; this loop
 * (the durable orchestrator) executes each checkpoint — run_verification on the
 * persistent AuthVerifier session, prompt_user via the TUI bridge, or a
 * cool-off wait — and resumes the same claude session with the result. The ONE
 * stateful thing (the live browser) lives in the AuthVerifier and is drained at
 * the end. Conversation state is carried by `--resume`, not retained here.
 */
async function runAuthSegmentLoop(opts: AuthSegmentLoopOptions): Promise<CompileAgentResult> {
  const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
  const credsForRun = { site: opts.site, cookies: [], values: opts.teachCredentials.values };
  const verifier = new AuthVerifier(workflowPath, credsForRun);
  const authMode = {
    site: opts.site,
    authPlanJson: JSON.stringify(opts.authToolPlan),
    allowedTools: AUTH_COMPILE_TOOL_NAMES,
    initialPrompt: opts.initialPrompt,
  };

  const onPrompt = opts.onPrompt ?? (async () => ATTEMPT_OTP_PLACEHOLDER); // unattended: placeholder
  const onCooldown =
    opts.onCooldown ?? (async (minutes: number) => sleep(Math.min(minutes, 10) * 60_000));

  let resume: { sessionId: string; message: string } | undefined;
  let last: CompileAgentResult | undefined;
  let totalTurns = 0;
  // The most recent live verification, surfaced on the orchestrator's progress
  // line so a failure (e.g. a 403) is visible the instant it happens.
  let lastVerification: CompileAgentProgress['lastVerification'];

  try {
    for (let seg = 0; seg < MAX_AUTH_SEGMENTS; seg++) {
      // Each resumed segment restarts claude-cli's per-segment `turn` at 0; add
      // the prior segments' turns so the displayed count is monotonic (no reset).
      const offset = totalTurns; // turns from prior segments only (read BEFORE the += below)
      const wrappedOnProgress = opts.onProgress
        ? (p: CompileAgentProgress): void =>
            opts.onProgress?.({
              ...p,
              turn: offset + p.turn,
              segment: seg + 1,
              maxSegments: MAX_AUTH_SEGMENTS,
              attempt: verifier.attemptsUsed,
              maxAttempts: verifier.maxInitiateAttempts,
              lastVerification,
            })
        : undefined;

      const result = await compileAuthViaClaudeCli({
        session: opts.session,
        absoluteToolDir: opts.toolDir,
        sessionPath: opts.sessionPath,
        systemPromptPath: opts.systemPromptPath,
        deadlineMs: opts.deadlineMs,
        startTime: opts.startTime,
        onProgress: wrappedOnProgress,
        authMode,
        resume,
      });
      last = result;
      totalTurns += result.turns;

      if (result.outcome !== 'checkpoint' || !result.checkpoint) break; // terminal
      if (!result.sessionId) {
        last = {
          ...result,
          outcome: 'error',
          success: false,
          message: 'checkpoint reached but no session id was captured — cannot resume the agent.',
        };
        break;
      }

      const cp: AuthCheckpoint = result.checkpoint;
      let resultMsg: string;
      try {
        if (cp.kind === 'run_verification') {
          const r = await verifier.runPhase(cp.phase, { otp_code: cp.otp_code });
          // Record + immediately surface the result so the spinner reflects a
          // failure the moment it happens — not only on the next agent turn.
          lastVerification = {
            phase: cp.phase,
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
            budgetMs: Math.max(0, opts.deadlineMs - Date.now()),
            inputTokens: 0,
            outputTokens: 0,
            verificationCycle: 1,
            maxVerificationCycles: 1,
            segment: seg + 1,
            maxSegments: MAX_AUTH_SEGMENTS,
            attempt: verifier.attemptsUsed,
            maxAttempts: verifier.maxInitiateAttempts,
            lastVerification,
          });
          resultMsg = formatVerifyResult(cp.phase, r);
        } else if (cp.kind === 'prompt_user') {
          const answer = await onPrompt(cp.message, cp.options);
          resultMsg = `The user responded: ${answer || '(no input provided)'}`;
        } else {
          await onCooldown(cp.minutes, cp.reason);
          resultMsg = `Cool-off of ~${cp.minutes} min complete (no login was fired during the wait). You may run_verification once more.`;
        }
      } catch (err) {
        resultMsg = `The orchestrator could not perform ${cp.kind}: ${err instanceof Error ? err.message : String(err)}`;
      }

      resume = {
        sessionId: result.sessionId,
        message: `[orchestrator result for your ${cp.kind} request]\n${resultMsg}\n\nProceed: shape any next phase from the recording if needed, then call the appropriate next tool (run_verification / prompt_user / wait_for_cooldown / done / give_up).`,
      };
    }
  } finally {
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
  // Safety net: make sure the auth workflow navigates the credential-entry page
  // before the login POST (so cdp-replay validates the login page's anti-bot
  // token). The agent is told to set this; fill it in deterministically if it
  // didn't, so a forgetful LLM never costs a wasted live-login attempt.
  injectAuthBootstrapArtifact(opts.toolDir, opts.session, opts.authToolPlan);

  // Surface the cumulative turn count across segments.
  return { ...last, turns: totalTurns };
}

/** Read the compiled auth workflow.json and inject a derived credential-entry
 *  `bootstrap` if it lacks one. Best-effort: never fails the compile. */
function injectAuthBootstrapArtifact(
  toolDir: string,
  session: Session,
  plan: NonNullable<AuthToolPlan>,
): void {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  try {
    if (!existsSync(workflowPath)) return;
    const wf = JSON.parse(readFileSync(workflowPath, 'utf8'));
    const { changed, url } = ensureAuthBootstrap(
      wf,
      session,
      plan.loginRequestSeqs,
      plan.credentialNames,
    );
    if (changed) {
      writeFileSync(workflowPath, JSON.stringify(wf, null, 2), 'utf8');
      log(`injected credential-entry bootstrap into workflow.json: ${url}`);
    }
  } catch {
    // best-effort — a bootstrap convenience must never break the compile
  }
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
