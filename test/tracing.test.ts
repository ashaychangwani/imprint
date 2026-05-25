import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  estimateTokensFromText,
  llmSpanAttributes,
  resolveTraceTokenCount,
  traceBatchEnabled,
  traceInputOutputAttributes,
  traceIoMaxChars,
  traceLlmCostRates,
  traceLlmIoEnabled,
  traceToolIoEnabled,
} from '../src/imprint/tracing.ts';

const ENV_KEYS = [
  'IMPRINT_TRACE',
  'IMPRINT_TRACING',
  'OPENINFERENCE_TRACE',
  'PHOENIX_COLLECTOR_ENDPOINT',
  'PHOENIX_HOST',
  'IMPRINT_TRACE_LLM_IO',
  'IMPRINT_TRACE_TOOL_IO',
  'IMPRINT_TRACE_IO',
  'IMPRINT_TRACE_FULL',
  'IMPRINT_TRACE_IO_MAX_CHARS',
  'IMPRINT_TRACE_INPUT_USD_PER_1M',
  'IMPRINT_TRACE_OUTPUT_USD_PER_1M',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('traceBatchEnabled', () => {
  it('defaults to batched export when IMPRINT_TRACE_BATCH is unset', () => {
    expect(traceBatchEnabled(undefined)).toBe(true);
  });

  it('allows immediate export only when explicitly disabled', () => {
    expect(traceBatchEnabled('false')).toBe(false);
    expect(traceBatchEnabled('0')).toBe(false);
    expect(traceBatchEnabled('true')).toBe(true);
    expect(traceBatchEnabled('1')).toBe(true);
  });
});

describe('trace I/O controls', () => {
  it('defaults IO capture to on when tracing is enabled', () => {
    expect(traceLlmIoEnabled()).toBe(false);
    expect(traceToolIoEnabled()).toBe(false);

    process.env.IMPRINT_TRACE = '1';

    expect(traceLlmIoEnabled()).toBe(true);
    expect(traceToolIoEnabled()).toBe(true);
  });

  it('allows granular opt-out of IO capture', () => {
    process.env.IMPRINT_TRACE = '1';

    process.env.IMPRINT_TRACE_LLM_IO = '0';
    expect(traceLlmIoEnabled()).toBe(false);
    expect(traceToolIoEnabled()).toBe(true);

    process.env.IMPRINT_TRACE_TOOL_IO = '0';
    expect(traceToolIoEnabled()).toBe(false);
  });

  it('uses a bounded default trace payload size', () => {
    expect(traceIoMaxChars(undefined)).toBe(50_000);
    expect(traceIoMaxChars('0')).toBe(0);
    expect(traceIoMaxChars('-1')).toBe(50_000);
    expect(traceIoMaxChars('not-a-number')).toBe(50_000);
  });

  it('truncates captured input and records trace metadata', () => {
    process.env.IMPRINT_TRACE_IO_MAX_CHARS = '4';

    const attrs = traceInputOutputAttributes('input', 'abcdef');

    expect(attrs['input.value']).toBe('abcd\n...[truncated 2 chars]');
    expect(attrs['input.mime_type']).toBe('text/plain');
    expect(attrs['imprint.trace.input.chars']).toBe(6);
    expect(attrs['imprint.trace.input.truncated']).toBe(true);
    expect(attrs['imprint.trace.input.max_chars']).toBe(4);
  });

  it('captures no payload body when the trace char limit is zero', () => {
    process.env.IMPRINT_TRACE_IO_MAX_CHARS = '0';

    const attrs = traceInputOutputAttributes('output', 'abcdef');

    expect(attrs['output.value']).toBe('...[truncated 6 chars]');
    expect(attrs['imprint.trace.output.chars']).toBe(6);
    expect(attrs['imprint.trace.output.truncated']).toBe(true);
    expect(attrs['imprint.trace.output.max_chars']).toBe(0);
  });
});

describe('LLM trace usage and cost attributes', () => {
  it('estimates missing token counts from text', () => {
    expect(estimateTokensFromText('abcdefgh')).toBe(2);
    expect(resolveTraceTokenCount(12, 'ignored')).toEqual({
      tokens: 12,
      source: 'provider',
    });
    expect(resolveTraceTokenCount(null, 'abcdefgh')).toEqual({
      tokens: 2,
      source: 'estimated',
    });
  });

  it('falls back to estimation when provider count is suspiciously low', () => {
    const longText = 'x'.repeat(1000); // estimated ~250 tokens
    expect(resolveTraceTokenCount(6, longText)).toEqual({
      tokens: 250,
      source: 'estimated',
    });
  });

  it('trusts provider when count is within reasonable range', () => {
    const longText = 'x'.repeat(1000); // estimated ~250 tokens
    expect(resolveTraceTokenCount(200, longText)).toEqual({
      tokens: 200,
      source: 'provider',
    });
  });

  it('does not sanity-check provider count of zero', () => {
    expect(resolveTraceTokenCount(0, 'x'.repeat(1000))).toEqual({
      tokens: 0,
      source: 'provider',
    });
  });

  it('falls back to built-in model rates when env vars are not set', () => {
    expect(traceLlmCostRates('claude-cli', 'claude-opus-4-7')).toEqual({
      inputUsdPer1M: 5,
      outputUsdPer1M: 25,
    });
    expect(traceLlmCostRates('claude-cli', 'claude-sonnet-4-6')).toEqual({
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
    });
    expect(traceLlmCostRates('claude-cli', 'unknown-model')).toBeNull();
  });

  it('prefers env vars over built-in model rates', () => {
    process.env.IMPRINT_TRACE_INPUT_USD_PER_1M = '99';
    process.env.IMPRINT_TRACE_OUTPUT_USD_PER_1M = '199';

    expect(traceLlmCostRates('claude-cli', 'claude-opus-4-7')).toEqual({
      inputUsdPer1M: 99,
      outputUsdPer1M: 199,
    });
  });

  it('calculates cost using cache-specific rates when cache tokens are provided', () => {
    const attrs = llmSpanAttributes({
      provider: 'claude-cli',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 100_000,
    });

    // uncached: 100K @ $5/M = $0.50
    // cache read: 800K @ $0.50/M = $0.40
    // cache write: 100K @ $6.25/M = $0.625
    // total prompt = $1.525
    // output: 100K @ $25/M = $2.50
    const promptCost = attrs['llm.cost.prompt'] as number;
    const completionCost = attrs['llm.cost.completion'] as number;
    expect(promptCost).toBeCloseTo(1.525, 3);
    expect(completionCost).toBeCloseTo(2.5, 3);
    expect(attrs['llm.cost.total'] as number).toBeCloseTo(4.025, 3);
  });

  it('adds OpenInference token, cost, and message attributes when rates are configured', () => {
    process.env.IMPRINT_TRACE_INPUT_USD_PER_1M = '2';
    process.env.IMPRINT_TRACE_OUTPUT_USD_PER_1M = '10';

    expect(traceLlmCostRates('codex-cli', 'gpt-test')).toEqual({
      inputUsdPer1M: 2,
      outputUsdPer1M: 10,
    });

    const attrs = llmSpanAttributes({
      provider: 'codex-cli',
      model: 'gpt-test',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      tokenCountsEstimated: true,
      inputTokenSource: 'estimated',
      outputTokenSource: 'provider',
      inputMessages: [{ role: 'user', content: 'hello' }],
      outputMessages: [{ role: 'assistant', content: 'world' }],
    });

    expect(attrs['llm.token_count.prompt']).toBe(1_000_000);
    expect(attrs['llm.token_count.completion']).toBe(500_000);
    expect(attrs['llm.token_count.total']).toBe(1_500_000);
    expect(attrs['llm.cost.prompt']).toBe(2);
    expect(attrs['llm.cost.completion']).toBe(5);
    expect(attrs['llm.cost.total']).toBe(7);
    expect(attrs['llm.input_messages.0.message.role']).toBe('user');
    expect(attrs['llm.input_messages.0.message.content']).toBe('hello');
    expect(attrs['llm.output_messages.0.message.content']).toBe('world');
    expect(attrs['imprint.llm.tokens_estimated']).toBe(true);
    expect(attrs['imprint.llm.input_tokens_source']).toBe('estimated');
    expect(attrs['imprint.llm.output_tokens_source']).toBe('provider');
  });
});
