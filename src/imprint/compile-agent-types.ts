/**
 * Shared types for the compile-agent surface.
 *
 * Lives in its own file so both compile-agent.ts (the in-process loop driver
 * for anthropic-api) and claude-cli-compile.ts (the claude-cli MCP driver)
 * can reference them without importing each other.
 */

import type { AgentProgress } from './agent.ts';
import { type AssignedSharedModule, describeAssignedModules } from './build-plan.ts';
import type { ProviderInterruptionReason, ProviderReportedError } from './provider-retry.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';

/** How far a data-tool compiler must verify before returning its artifact.
 *
 * `full` preserves the standalone `imprint generate` behavior: deterministic
 * artifact checks are followed by an independent live semantic review.
 * `master_mvp` is reserved for the master-led teach flow. It returns as soon
 * as the deterministic artifact contract passes so dependent tools can be
 * compiled without waiting for breadth/perfection work. */
export type CompileVerificationMode = 'full' | 'master_mvp';

export interface CompileVerificationSummary {
  mode: CompileVerificationMode;
  deterministic: 'passed';
  semantic: 'approved' | 'not_run' | 'not_applicable';
  /** Durable independent-review report when a full semantic review ran. */
  reportPath?: string;
}

/** Extra task framing shared verbatim by the in-process, Claude CLI, and Codex
 * CLI compiler paths. The selected candidate is the master's accepted public
 * contract in MVP mode, rather than the shipped detector's initial proposal. */
export function formatCompileVerificationMode(mode: CompileVerificationMode | undefined): string {
  if (mode !== 'master_mvp') return '';
  return `

MASTER MVP COMPILE MODE — return the smallest useful implementation that satisfies the accepted artifact contract and deterministic checks. The selected candidate's tool name and public parameter names/types are the master's current contract: never add, remove, rename, or retype them in this compile. Ground the request construction and parser in the supplied recording, write meaningful offline tests, and provide one simple baseline integration case for later review. Before writing files, identify the smallest directly recorded request that returns the core result, require an exact producer path and consumer location for every earlier dependency, and name the live source of every changing transport value. Reuse applicable sibling bootstrap evidence included in the plan, but do not assume shared runtime state. For an ordinary safe API, write the smallest valid request-only workflow first, omit parserModule, and use probe_api as a curl-like loop through the existing fetch/fetch-bootstrap/CDP-replay/stealth-fetch ladder. Repair request construction in this retained conversation; only write the parser after a probe returns a credible raw response. If the master or observed facts identify rate limiting or repeated bot challenges, stop compiler-side live calls and infer from the recording so the independent verifier owns the next live call. Do not silently implement unnecessary dependencies, stale session literals, or a plan with missing transport provenance: call give_up with the exact request sequence/path and plan contradiction so the master can revise the plan and return it to this retained compiler conversation. Do not spend this compile broadening result fields or trying to prove every parameter live. If exact recording evidence proves that any accepted parameter cannot be implemented honestly, do not weaken or rewrite the contract: call give_up with the exact parameter, request sequence/path, and contradiction. After deterministic verification passes, the host will return the artifact to the master for one independent confirmation; separate best-effort agents own live parameter testing and breadth improvements.`;
}

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
  providerInterruption?: ProviderInterruptionReason;
  /** Full provider-owned terminal facts; never populated from tool/site text. */
  providerError?: ProviderReportedError;
  /** Factual verification boundary reached by a successful compile. */
  verification?: CompileVerificationSummary;
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
