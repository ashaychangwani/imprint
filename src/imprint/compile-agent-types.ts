/**
 * Shared types for the compile-agent surface.
 *
 * Lives in its own file so both compile-agent.ts (the in-process loop driver
 * for anthropic-api) and claude-cli-compile.ts (the claude-cli MCP driver)
 * can reference them without importing each other.
 */

import type { AgentProgress } from './agent.ts';
import { type AssignedSharedModule, describeAssignedModules } from './build-plan.ts';
import type { ProviderReportedError } from './provider-retry.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';

/** Only an independent semantic-verifier result consumes the bounded review
 * budget. Deterministic preflight failures remain deadline-bounded but do not
 * spend a compiler↔reviewer iteration. */
export function advanceSemanticVerificationCycle(
  current: number,
  semanticReviewCompleted: boolean,
): number {
  return semanticReviewCompleted ? current + 1 : current;
}

/** Bound verifier infrastructure failures separately from semantic review
 * cycles. One verifier invocation already includes its own provider retry; a
 * second failed invocation gives the compiler one chance to react without
 * allowing a missing provider to extend the compile deadline forever. */
export function advanceIncompleteSemanticVerificationRuns(
  current: number,
  semanticReviewAttempted: boolean,
  semanticReviewCompleted: boolean,
): number {
  if (semanticReviewCompleted) return 0;
  return semanticReviewAttempted ? current + 1 : current;
}

/** Render a per-tool implementation proposal (param→field mapping, request
 *  construction, response parsing, reusable-module ideas, edge cases) into an
 *  initial-message section the compile agent evaluates. Shared verbatim by the
 *  in-process loop and both CLI drivers. Generic — carries no site-specific
 *  content; the proposal itself is derived per-tool from the recording. */
export function formatToolPlan(toolPlan: string | undefined): string {
  const plan = toolPlan?.trim();
  if (!plan) return '';
  return `

IMPLEMENTATION PLAN — a planning pass analyzed the recording for THIS tool and produced the advisory plan below. Inspect its evidence and accept, revise, or reject each proposed parameter, request, parser choice, and shared module. Shared modules are reuse options, not runtime-required imports.

${plan}`;
}

/** Render the selected candidate + shared compile context (and reusable-module
 *  proposals) into the compile agent's initial message. Shared verbatim by the
 *  in-process loop and both CLI drivers. */
export function formatCandidateContext(
  candidate: ToolCandidate | undefined,
  sharedContext: SharedCompileContext | undefined,
  sharedModuleProposals?: AssignedSharedModule[],
): string {
  if (!candidate && !sharedContext) return '';
  return `
Selected candidate context:
${candidate ? JSON.stringify(candidate, null, 2) : '(none)'}

Shared compile context:
${sharedContext ? JSON.stringify(sharedContext, null, 2) : '(none)'}

Compile only the selected candidate. Do not create tools for other actions in the recording.${
    sharedModuleProposals ? describeAssignedModules(sharedModuleProposals) : ''
  }`;
}

export interface CompileAgentProgress extends AgentProgress {
  /** 1-based semantic-review cycle. Deterministic preflight retries leave this
   *  value unchanged. */
  verificationCycle: number;
  /** Verification cap for bounded data-tool compiles; auth is deadline-bounded. */
  maxVerificationCycles?: number;
  // ── Auth segments only (all optional; data-compile + codex paths leave unset) ──
  /** 1-based current segment index in the resumable auth loop. */
  segment?: number;
  /** The most recent live verification result, so the orchestrator's progress
   *  line can surface a failure (e.g. a 403) the instant it happens instead of
   *  only feeding it to the agent. Grounded purely in AuthPhaseResult fields. */
  lastVerification?: {
    action: string;
    ok: boolean;
    status?: number;
    error?: string;
    backend?: string;
    durationMs?: number;
    /** Which checkpoint produced it — drives the "retrying" vs "cooling-off" hint. */
    checkpoint?: 'run_verification' | 'prompt_user' | 'wait_for_cooldown';
  };
}

/** A mid-loop checkpoint the auth compile agent reaches: it calls a checkpoint
 *  tool (which writes a sentinel) and then STOPS its turn. The orchestrator
 *  (teach) performs the action — it owns the live browser session, the TUI, and
 *  the cooldown — then resumes the agent (`claude --resume`) with the result as a
 *  follow-up user message. Site/channel-agnostic. */
export type AuthCheckpoint =
  | {
      kind: 'run_verification';
      action: string;
      parameters?: Record<string, string | number | boolean>;
      freshSession?: boolean;
      cleanSession?: boolean;
    }
  | {
      kind: 'inspect_verification_page';
      maxChars?: number;
      includeCookies?: boolean;
    }
  | { kind: 'prompt_user'; message: string; options?: string[] }
  | { kind: 'wait_for_cooldown'; minutes: number; reason?: string };

export interface CompileAgentResult {
  /** True only if external verification passed. */
  success: boolean;
  /** Why we stopped — done, give_up, timeout, soft_cap, error, or (auth segments)
   *  checkpoint: the agent paused at a checkpoint tool for the orchestrator to act
   *  and resume. */
  outcome: 'done' | 'give_up' | 'timeout' | 'soft_cap' | 'error' | 'checkpoint';
  /** Auth segments only: the checkpoint the agent reached (when outcome ===
   *  'checkpoint'). The orchestrator performs it and resumes with the result. */
  checkpoint?: AuthCheckpoint;
  /** claude-cli session id (from the init event) — `--resume` target for the
   *  next auth segment. */
  sessionId?: string;
  /** A provider-adapter fact that permits the host to retry this exact logical
   *  compile. This is intentionally narrow: ordinary policy/content failures
   *  remain deterministic errors unless an adapter identifies its provider's
   *  known transient false-positive response. */
  providerInterruption?: 'capacity_or_overload' | 'transient_safety_filter';
  /** Full provider-owned terminal facts; never populated from tool/site text. */
  providerError?: ProviderReportedError;
  /** Path to workflow.json if written. */
  workflowPath?: string;
  /** Path to parser.ts if written. */
  parserPath?: string;
  /** Path to parser.test.ts if written. */
  parserTestPath?: string;
  /** Free-form summary, error message, or give-up reason. */
  message: string;
  /** Conversation log saved to this path. */
  conversationLogPath: string;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
