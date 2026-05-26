/**
 * Shared types for the compile-agent surface.
 *
 * Lives in its own file so both compile-agent.ts (the in-process loop driver
 * for anthropic-api) and claude-cli-compile.ts (the claude-cli MCP driver)
 * can reference them without importing each other.
 */

import type { AgentProgress } from './agent.ts';

export interface CompileAgentProgress extends AgentProgress {
  /** 1-based verification cycle. Cycle 1 is the initial agent run. Subsequent cycles
   *  happen when the agent claims done() but external verification fails. */
  verificationCycle: number;
  /** Hard cap on verification cycles (typically 5). */
  maxVerificationCycles: number;
}

export interface CompileAgentResult {
  /** True only if external verification passed. */
  success: boolean;
  /** Why we stopped — done, give_up, timeout, soft_cap, error. */
  outcome: 'done' | 'give_up' | 'timeout' | 'soft_cap' | 'error';
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
