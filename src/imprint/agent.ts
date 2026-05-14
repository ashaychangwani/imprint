/**
 * General-purpose tool-using agent loop.
 *
 * Implements the standard Anthropic tool-use pattern:
 * 1. Model returns tool_use blocks → dispatch tools → append tool_result
 * 2. Loop until done() / give_up() or timeout / soft cap
 * 3. Return conversation log + outcome + token stats
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import type { ToolUseProvider } from './llm.ts';

export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  handler: (input: unknown) => Promise<{ result: string; isError?: boolean }>;
}

export interface AgentProgress {
  /** 1-based turn number (turn 1 is the first LLM call). */
  turn: number;
  /** What the agent is doing right now. */
  phase: 'thinking' | 'tool';
  /** When phase is 'tool': the name of the tool being dispatched. */
  toolName?: string;
  /** Wall-clock time since the loop started, in ms. */
  elapsedMs: number;
  /** Total wall-clock budget (deadlineMs - startMs at loop start), in ms. */
  budgetMs: number;
  /** Cumulative input tokens across all turns so far. */
  inputTokens: number;
  /** Cumulative output tokens across all turns so far. */
  outputTokens: number;
}

export interface AgentResult {
  outcome: 'done' | 'give_up' | 'timeout' | 'soft_cap' | 'error';
  doneSummary?: string;
  giveUpReason?: string;
  giveUpDetail?: string;
  errorMessage?: string;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  conversationLog: ConversationLogEntry[];
}

export interface ConversationLogEntry {
  turn: number;
  role: 'user' | 'assistant';
  // Mirrors Anthropic.MessageParam.content — string OR array of content blocks
  content: unknown;
}

interface AgentLoopOptions {
  systemPrompt: string;
  initialUserMessage: string;
  tools: AgentTool[];
  /** wall-clock deadline in ms since epoch (Date.now()) */
  deadlineMs: number;
  /** soft cap on number of LLM turns; default 100 */
  softTurnCap?: number;
  llm: ToolUseProvider;
  /** called before each LLM call and tool dispatch with structured progress */
  onProgress?: (p: AgentProgress) => void;
}

/** Helper: creates the standard 'done' tool */
export function doneTool(): AgentTool {
  return {
    name: 'done',
    description: 'Call this when you have successfully completed the task.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished',
        },
      },
      required: ['summary'],
    },
    handler: async () => {
      throw new Error('reserved tool — should not be invoked');
    },
  };
}

/** Helper: creates the standard 'give_up' tool */
export function giveUpTool(): AgentTool {
  return {
    name: 'give_up',
    description:
      'Call this when you have encountered a categorical impossibility and cannot proceed.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why you cannot complete the task',
        },
        what_was_tried: {
          type: 'string',
          description: 'Summary of approaches you tried before giving up',
        },
      },
      required: ['reason', 'what_was_tried'],
    },
    handler: async () => {
      throw new Error('reserved tool — should not be invoked');
    },
  };
}

const TOOL_RESULT_TRUNCATE_LIMIT = 32 * 1024; // 32KB

/**
 * Run an agent loop with tool-use.
 *
 * Continues until:
 * - Model calls done() or give_up()
 * - Wall-clock deadline exceeded
 * - Turn count exceeds soft cap
 * - Unexpected error
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentResult> {
  const startTime = Date.now();
  const softTurnCap = opts.softTurnCap ?? 100;
  const startMs = Date.now();
  const budgetMs = Math.max(0, opts.deadlineMs - startMs);

  // Convert AgentTools to Anthropic.Tool format (strip handlers)
  const anthropicTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Build messages array starting with initial user message
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.initialUserMessage }];

  let turn = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const conversationLog: ConversationLogEntry[] = [];

  // Add initial user message to log
  conversationLog.push({
    turn: 0,
    role: 'user',
    content: opts.initialUserMessage,
  });

  while (true) {
    // Check wall-clock deadline
    if (Date.now() > opts.deadlineMs) {
      return {
        outcome: 'timeout',
        turns: turn,
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
        conversationLog,
      };
    }

    // Check soft turn cap
    if (turn > softTurnCap) {
      return {
        outcome: 'soft_cap',
        turns: turn,
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
        conversationLog,
      };
    }

    turn++;
    opts.onProgress?.({
      turn,
      phase: 'thinking',
      elapsedMs: Date.now() - startMs,
      budgetMs,
      inputTokens,
      outputTokens,
    });

    // Call LLM with tools
    let response: Anthropic.Message;
    try {
      response = await opts.llm.messageWithTools({
        system: opts.systemPrompt,
        messages,
        tools: anthropicTools,
      });
    } catch (err) {
      return {
        outcome: 'error',
        errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        turns: turn,
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
        conversationLog,
      };
    }

    // Update token counts
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    // Append assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    // Add to conversation log
    conversationLog.push({
      turn,
      role: 'assistant',
      content: response.content,
    });

    // Extract tool_use blocks regardless of stop_reason — a max_tokens or
    // end_turn response can still contain completed tool_use blocks that
    // need matching tool_result blocks in the next user message.
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUseBlocks.length > 0) {
      // Check for done() or give_up() first
      for (const block of toolUseBlocks) {
        if (block.name === 'done') {
          const input = block.input as { summary?: string };
          return {
            outcome: 'done',
            doneSummary: input.summary ?? 'Task completed',
            turns: turn,
            durationMs: Date.now() - startTime,
            inputTokens,
            outputTokens,
            conversationLog,
          };
        }
        if (block.name === 'give_up') {
          const input = block.input as { reason?: string; what_was_tried?: string };
          return {
            outcome: 'give_up',
            giveUpReason: input.reason ?? 'Cannot proceed',
            giveUpDetail: input.what_was_tried,
            turns: turn,
            durationMs: Date.now() - startTime,
            inputTokens,
            outputTokens,
            conversationLog,
          };
        }
      }

      // Dispatch all other tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const tool = opts.tools.find((t) => t.name === block.name);
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: unknown tool "${block.name}"`,
            is_error: true,
          });
          continue;
        }

        // Fire progress before tool execution
        opts.onProgress?.({
          turn,
          phase: 'tool',
          toolName: tool.name,
          elapsedMs: Date.now() - startMs,
          budgetMs,
          inputTokens,
          outputTokens,
        });

        // Call the tool handler
        let result: { result: string; isError?: boolean };
        try {
          result = await tool.handler(block.input);
        } catch (err) {
          result = {
            result: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }

        // Truncate large results
        let content = result.result;
        if (content.length > TOOL_RESULT_TRUNCATE_LIMIT) {
          const originalLength = content.length;
          content = `${content.slice(0, TOOL_RESULT_TRUNCATE_LIMIT)}\n[…truncated, original length ${originalLength}…]`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          is_error: result.isError ?? false,
        });
      }

      // Build the user response: tool results first, plus an optional
      // continuation nudge if the model was cut off mid-output.
      const userContent: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [
        ...toolResults,
      ];
      if (response.stop_reason === 'max_tokens') {
        userContent.push({
          type: 'text',
          text: 'You hit max_tokens. Continue from where you stopped.',
        });
      }

      messages.push({ role: 'user', content: userContent });
      conversationLog.push({ turn, role: 'user', content: userContent });
    } else if (response.stop_reason === 'end_turn') {
      // Model stopped without calling any tools or done()/give_up()
      const nudgeMessage =
        'You stopped without calling done() or give_up(). If you are finished, call done. If you encountered a categorical impossibility, call give_up. Otherwise continue working.';
      messages.push({ role: 'user', content: nudgeMessage });
      conversationLog.push({
        turn,
        role: 'user',
        content: nudgeMessage,
      });
    } else if (response.stop_reason === 'max_tokens') {
      // Model hit max_tokens with no tool calls
      const continueMessage = 'You hit max_tokens. Continue from where you stopped.';
      messages.push({ role: 'user', content: continueMessage });
      conversationLog.push({
        turn,
        role: 'user',
        content: continueMessage,
      });
    } else if (response.stop_reason !== 'tool_use') {
      // Unexpected stop reason (tool_use with zero blocks would be odd but harmless)
      return {
        outcome: 'error',
        errorMessage: `unexpected stop_reason: ${response.stop_reason}`,
        turns: turn,
        durationMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
        conversationLog,
      };
    }

    // Loop continues...
  }
}
