/**
 * Unit tests for the general-purpose agent loop (agent.ts).
 *
 * Uses a MockLLM to script deterministic tool-use conversations without
 * calling the real Anthropic API.
 */

import { describe, expect, it } from 'bun:test';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { AgentTool } from '../src/imprint/agent.ts';
import { doneTool, giveUpTool, runAgentLoop } from '../src/imprint/agent.ts';
import type { ProviderName, ToolUseProvider } from '../src/imprint/llm.ts';

// ─── Mock Provider ───────────────────────────────────────────────────────────

class MockProvider implements ToolUseProvider {
  readonly name: ProviderName = 'anthropic-api';
  callCount = 0;
  capturedCalls: Array<{ system: string; messages: unknown; tools: unknown }> = [];

  constructor(private responses: Anthropic.Message[]) {}

  async messageWithTools(opts: {
    system: string;
    messages: unknown;
    tools: unknown;
  }): Promise<Anthropic.Message> {
    this.capturedCalls.push(opts);
    const response = this.responses[this.callCount];
    if (!response) throw new Error(`MockProvider: no scripted response for call ${this.callCount}`);
    this.callCount++;
    return response;
  }

  async analyze(): Promise<never> {
    throw new Error('MockProvider does not implement analyze');
  }
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

function assistantToolUse(
  toolUses: Array<{ name: string; input: object; id?: string }>,
  opts?: { tokens?: { in: number; out: number } },
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: toolUses.map((t, i) => ({
      type: 'tool_use' as const,
      id: t.id ?? `tu_${i}`,
      name: t.name,
      input: t.input,
    })),
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: opts?.tokens?.in ?? 10, output_tokens: opts?.tokens?.out ?? 20 },
  } as unknown as Anthropic.Message;
}

function assistantText(
  text: string,
  stop_reason: 'end_turn' | 'max_tokens' = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

function assistantToolUseWithStopReason(
  toolUses: Array<{ name: string; input: object; id?: string }>,
  stop_reason: 'tool_use' | 'max_tokens' | 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: toolUses.map((t, i) => ({
      type: 'tool_use' as const,
      id: t.id ?? `tu_${i}`,
      name: t.name,
      input: t.input,
    })),
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runAgentLoop — loop semantics', () => {
  it('dispatches tool, receives result, and exits on done', async () => {
    let fooToolCalled = false;
    const fooTool: AgentTool = {
      name: 'foo_tool',
      description: 'Test tool',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        fooToolCalled = true;
        return { result: 'foo executed' };
      },
    };

    const llm = new MockProvider([
      assistantToolUse([{ name: 'foo_tool', input: {} }]),
      assistantToolUse([{ name: 'done', input: { summary: 'finished' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [fooTool, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    expect(result.doneSummary).toBe('finished');
    expect(fooToolCalled).toBe(true);
    expect(result.turns).toBe(2);
    expect(llm.callCount).toBe(2);
  });

  it('reports tool errors back to the agent via isError: true', async () => {
    const errorTool: AgentTool = {
      name: 'error_tool',
      description: 'Throws error',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('intentional failure');
      },
    };

    const llm = new MockProvider([
      assistantToolUse([{ name: 'error_tool', input: {} }]),
      assistantToolUse([{ name: 'done', input: { summary: 'done despite error' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [errorTool, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    // Verify the error was passed back in the conversation log
    const toolResultEntry = result.conversationLog.find(
      (e) => e.role === 'user' && Array.isArray(e.content),
    );
    expect(toolResultEntry).toBeDefined();
    const toolResults = toolResultEntry?.content as Array<{
      type: string;
      is_error?: boolean;
      content: string;
    }>;
    const errorResult = toolResults?.find((r) => r.is_error);
    expect(errorResult).toBeDefined();
    expect(errorResult?.content).toContain('intentional failure');
  });

  it('handles multiple tool_use blocks in one assistant turn', async () => {
    let aCalls = 0;
    let bCalls = 0;
    const toolA: AgentTool = {
      name: 'tool_a',
      description: 'A',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        aCalls++;
        return { result: 'a done' };
      },
    };
    const toolB: AgentTool = {
      name: 'tool_b',
      description: 'B',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        bCalls++;
        return { result: 'b done' };
      },
    };

    const llm = new MockProvider([
      assistantToolUse([
        { name: 'tool_a', input: {} },
        { name: 'tool_b', input: {} },
      ]),
      assistantToolUse([{ name: 'done', input: { summary: 'multi-tool turn done' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [toolA, toolB, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    // Verify both results were batched in a single user message
    const userMsgs = result.conversationLog.filter((e) => e.role === 'user');
    // 1 initial + 1 tool_result batch + (possibly 0 or more nudges) — check the second user message has 2 tool_results
    const toolResultMsg = userMsgs[1];
    expect(Array.isArray(toolResultMsg?.content)).toBe(true);
    const toolResults = toolResultMsg?.content as Array<{ type: string }>;
    const toolResultBlocks = toolResults.filter((b) => b.type === 'tool_result');
    expect(toolResultBlocks.length).toBe(2);
  });

  it('sends nudge when agent returns end_turn without done/give_up', async () => {
    const llm = new MockProvider([
      assistantText('I am thinking...', 'end_turn'),
      assistantToolUse([{ name: 'done', input: { summary: 'finished after nudge' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    // Find the nudge message in the log
    const nudgeMsg = result.conversationLog.find(
      (e) =>
        e.role === 'user' &&
        typeof e.content === 'string' &&
        e.content.includes('stopped without calling'),
    );
    expect(nudgeMsg).toBeDefined();
  });

  it('sends nudge when agent hits max_tokens', async () => {
    const llm = new MockProvider([
      assistantText('This response was cut off because', 'max_tokens'),
      assistantToolUse([{ name: 'done', input: { summary: 'recovered from max_tokens' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    const maxTokensNudge = result.conversationLog.find(
      (e) =>
        e.role === 'user' && typeof e.content === 'string' && e.content.includes('hit max_tokens'),
    );
    expect(maxTokensNudge).toBeDefined();
  });

  it('dispatches tool_use blocks in a max_tokens response before continuing', async () => {
    let toolCalled = false;
    const myTool: AgentTool = {
      name: 'my_tool',
      description: 'Test tool',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        toolCalled = true;
        return { result: 'tool executed' };
      },
    };

    const llm = new MockProvider([
      // Turn 1: model calls a tool but hits max_tokens mid-output
      assistantToolUseWithStopReason([{ name: 'my_tool', input: {}, id: 'tu_max' }], 'max_tokens'),
      // Turn 2: model finishes
      assistantToolUse([
        { name: 'done', input: { summary: 'finished after max_tokens recovery' } },
      ]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [myTool, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    expect(toolCalled).toBe(true);

    // The user message after the max_tokens turn should contain both
    // the tool result AND the continuation nudge
    const userMsg = result.conversationLog.find((e) => {
      if (e.role !== 'user' || !Array.isArray(e.content)) return false;
      const hasToolResult = (e.content as Array<{ type: string }>).some(
        (b) => b.type === 'tool_result',
      );
      const hasContinueText = (e.content as Array<{ type: string; text?: string }>).some(
        (b) => b.type === 'text' && b.text?.includes('max_tokens'),
      );
      return hasToolResult && hasContinueText;
    });
    expect(userMsg).toBeDefined();
  });
});

describe('runAgentLoop — termination', () => {
  it('returns outcome: done with doneSummary when agent calls done()', async () => {
    const llm = new MockProvider([
      assistantToolUse([{ name: 'done', input: { summary: 'task complete' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    expect(result.doneSummary).toBe('task complete');
    expect(result.turns).toBe(1);
  });

  it('returns outcome: give_up with reason and detail when agent calls give_up()', async () => {
    const llm = new MockProvider([
      assistantToolUse([
        {
          name: 'give_up',
          input: { reason: 'impossible constraint', what_was_tried: 'tried A, B, C' },
        },
      ]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('give_up');
    expect(result.giveUpReason).toBe('impossible constraint');
    expect(result.giveUpDetail).toBe('tried A, B, C');
  });

  it('returns outcome: timeout before making any LLM call if deadline already passed', async () => {
    const llm = new MockProvider([
      // Should never be called
      assistantToolUse([{ name: 'done', input: { summary: 'should not reach' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() - 1000, // already expired
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('timeout');
    expect(llm.callCount).toBe(0);
  });

  it('extends deadline when onDeadlineReached returns positive ms', async () => {
    const llm = new MockProvider([
      assistantToolUse([{ name: 'done', input: { summary: 'finished after extension' } }]),
    ]);

    let callbackCalled = false;
    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() - 1000, // already expired
      llm: llm as ToolUseProvider,
      onDeadlineReached: async () => {
        callbackCalled = true;
        return 60000; // extend by 60s
      },
    });

    expect(callbackCalled).toBe(true);
    expect(result.outcome).toBe('done');
    expect(llm.callCount).toBe(1);
  });

  it('times out when onDeadlineReached returns null', async () => {
    const llm = new MockProvider([
      assistantToolUse([{ name: 'done', input: { summary: 'should not reach' } }]),
    ]);

    let callbackCalled = false;
    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() - 1000, // already expired
      llm: llm as ToolUseProvider,
      onDeadlineReached: async () => {
        callbackCalled = true;
        return null;
      },
    });

    expect(callbackCalled).toBe(true);
    expect(result.outcome).toBe('timeout');
    expect(llm.callCount).toBe(0);
  });

  it('returns outcome: soft_cap when turn count exceeds softTurnCap', async () => {
    const llm = new MockProvider([
      assistantText('turn 1', 'end_turn'),
      assistantText('turn 2', 'end_turn'),
      assistantText('turn 3', 'end_turn'),
      assistantText('turn 4', 'end_turn'),
      assistantText('turn 5', 'end_turn'),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      softTurnCap: 2,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('soft_cap');
    // Should exceed after turn 2, so turn 3 triggers soft_cap
    expect(result.turns).toBe(3);
  });
});

describe('runAgentLoop — token counting', () => {
  it('accumulates input and output tokens across turns', async () => {
    const llm = new MockProvider([
      assistantText('turn 1', 'end_turn'), // default: 10 in, 5 out
      assistantToolUse([{ name: 'done', input: { summary: 'done' } }], {
        tokens: { in: 100, out: 50 },
      }),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    expect(result.inputTokens).toBe(110); // 10 + 100
    expect(result.outputTokens).toBe(55); // 5 + 50
  });
});

describe('runAgentLoop — conversation log', () => {
  it('logs user and assistant turns in order', async () => {
    const llm = new MockProvider([
      assistantText('thinking', 'end_turn'),
      assistantToolUse([{ name: 'done', input: { summary: 'done' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start task',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.conversationLog.length).toBeGreaterThanOrEqual(4); // initial user, assistant, nudge, assistant
    expect(result.conversationLog[0]?.role).toBe('user');
    expect(result.conversationLog[0]?.content).toBe('start task');
    expect(result.conversationLog[1]?.role).toBe('assistant');
  });
});

describe('runAgentLoop — tool result truncation', () => {
  it('truncates tool result content exceeding 32KB', async () => {
    const largeTool: AgentTool = {
      name: 'large_tool',
      description: 'Returns large result',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        // 50KB of 'x'
        return { result: 'x'.repeat(50 * 1024) };
      },
    };

    const llm = new MockProvider([
      assistantToolUse([{ name: 'large_tool', input: {} }]),
      assistantToolUse([{ name: 'done', input: { summary: 'done' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [largeTool, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    // Check the captured messages passed to the second LLM call
    const secondCall = llm.capturedCalls[1];
    expect(secondCall).toBeDefined();
    const messages = secondCall?.messages as Array<{ role: string; content: unknown }>;
    const toolResultMsg = messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const toolResults = toolResultMsg?.content as Array<{ type: string; content: string }>;
    const largeResult = toolResults?.find((r) => r.type === 'tool_result');
    expect(largeResult?.content.length).toBeLessThan(33 * 1024); // 32KB + truncation suffix
    expect(largeResult?.content).toContain('truncated');
  });
});

describe('runAgentLoop — error handling', () => {
  it('returns outcome: error when LLM call throws', async () => {
    const llm = new MockProvider([]);
    // Override to throw
    llm.messageWithTools = async () => {
      throw new Error('API error');
    };

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toContain('API error');
  });

  it('returns tool_result with is_error when tool handler throws', async () => {
    const throwingTool: AgentTool = {
      name: 'throwing_tool',
      description: 'Throws',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('tool explosion');
      },
    };

    const llm = new MockProvider([
      assistantToolUse([{ name: 'throwing_tool', input: {} }]),
      assistantToolUse([{ name: 'done', input: { summary: 'recovered' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [throwingTool, doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    // Check the tool_result content
    const toolResultEntry = result.conversationLog.find(
      (e) => e.role === 'user' && Array.isArray(e.content),
    );
    const toolResults = toolResultEntry?.content as Array<{
      type: string;
      is_error?: boolean;
      content: string;
    }>;
    const errorResult = toolResults?.find((r) => r.is_error);
    expect(errorResult).toBeDefined();
    expect(errorResult?.content).toContain('tool explosion');
  });

  it('returns tool_result with is_error for unknown tool', async () => {
    const llm = new MockProvider([
      assistantToolUse([{ name: 'unknown_tool', input: {} }]),
      assistantToolUse([{ name: 'done', input: { summary: 'done' } }]),
    ]);

    const result = await runAgentLoop({
      systemPrompt: 'test',
      initialUserMessage: 'start',
      tools: [doneTool(), giveUpTool()],
      deadlineMs: Date.now() + 60000,
      llm: llm as ToolUseProvider,
    });

    expect(result.outcome).toBe('done');
    const toolResultEntry = result.conversationLog.find(
      (e) => e.role === 'user' && Array.isArray(e.content),
    );
    const toolResults = toolResultEntry?.content as Array<{
      type: string;
      is_error?: boolean;
      content: string;
    }>;
    const errorResult = toolResults?.find((r) => r.is_error);
    expect(errorResult).toBeDefined();
    expect(errorResult?.content).toContain('unknown tool');
  });
});
