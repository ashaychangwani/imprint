/**
 * Shared types for the compile-agent surface.
 *
 * Lives in its own file so both compile-agent.ts (the in-process loop driver
 * for anthropic-api) and claude-cli-compile.ts (the claude-cli MCP driver)
 * can reference them without importing each other.
 */

import type { AgentProgress } from './agent.ts';
import { type AssignedSharedModule, describeAssignedModules } from './build-plan.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';

/** Render a per-tool implementation plan (param→field mapping, request
 *  construction, response parsing, shared-module imports, edge cases) into an
 *  initial-message section the compile agent must follow. Shared verbatim by the
 *  in-process loop and both CLI drivers. Generic — carries no site-specific
 *  content; the plan itself is derived per-tool from the recording. */
export function formatToolPlan(toolPlan: string | undefined): string {
  const plan = toolPlan?.trim();
  if (!plan) return '';
  return `

IMPLEMENTATION PLAN — a planning pass analyzed the recording for THIS tool and produced the plan below. Follow it. It maps each parameter to its recorded field, specifies how to construct the request(s) and parse the response, and names the shared modules to import. Deviate only where the recorded data plainly contradicts the plan; if you do, note the correction in a brief code comment.

${plan}`;
}

/** Render the selected candidate + shared compile context (and any assigned
 *  shared modules) into the compile agent's initial message. Shared verbatim by
 *  the in-process loop and both CLI drivers. */
export function formatCandidateContext(
  candidate: ToolCandidate | undefined,
  sharedContext: SharedCompileContext | undefined,
  assignedSharedModules?: AssignedSharedModule[],
): string {
  if (!candidate && !sharedContext) return '';
  return `
Selected candidate context:
${candidate ? JSON.stringify(candidate, null, 2) : '(none)'}

Shared compile context:
${sharedContext ? JSON.stringify(sharedContext, null, 2) : '(none)'}

Compile only the selected candidate. Do not create tools for other actions in the recording.${
    assignedSharedModules ? describeAssignedModules(assignedSharedModules) : ''
  }`;
}

export interface CompileAgentProgress extends AgentProgress {
  /** 1-based verification cycle. Cycle 1 is the initial agent run. Subsequent cycles
   *  happen when the agent claims done() but external verification fails. */
  verificationCycle: number;
  /** Hard cap on verification cycles (typically 5). */
  maxVerificationCycles: number;
  // ── Auth segments only (all optional; data-compile + codex paths leave unset) ──
  /** 1-based current segment index in the resumable auth loop. */
  segment?: number;
  /** Total segment budget (MAX_AUTH_SEGMENTS). */
  maxSegments?: number;
  /** Live `initiate` attempts spent so far (AuthVerifier.attemptsUsed). */
  attempt?: number;
  /** Attempt cap (AuthVerifier.maxInitiateAttempts). */
  maxAttempts?: number;
  /** The most recent live verification result, so the orchestrator's progress
   *  line can surface a failure (e.g. a 403) the instant it happens instead of
   *  only feeding it to the agent. Grounded purely in AuthPhaseResult fields. */
  lastVerification?: {
    phase: string;
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
  | { kind: 'run_verification'; phase: 'initiate' | 'submit_otp' | 'complete'; otp_code?: string }
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
