import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  estimateTokensFromText,
  legacyTraceCostEnvNames,
  llmSpanAttributes,
  resolveTraceTokenCount,
  sanitizeTraceErrorMessage,
  totalPromptTokens,
  traceBatchEnabled,
  traceInputOutputAttributes,
  traceIoMaxChars,
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

describe('legacy trace cost configuration', () => {
  it('detects removed local-pricing variables but ignores current tracing settings', () => {
    expect(
      legacyTraceCostEnvNames({
        IMPRINT_TRACE_INPUT_USD_PER_1M: '5',
        IMPRINT_TRACE_COST_OPENAI_GPT_TEST_OUTPUT_USD_PER_1M: '30',
        IMPRINT_TRACE_PROJECT: 'fixture',
        IMPRINT_TRACE_OUTPUT_USD_PER_1M: '',
      }),
    ).toEqual([
      'IMPRINT_TRACE_COST_OPENAI_GPT_TEST_OUTPUT_USD_PER_1M',
      'IMPRINT_TRACE_INPUT_USD_PER_1M',
    ]);
  });
});

describe('trace error diagnostics', () => {
  it('caps verbose error messages before recording them on spans', () => {
    expect(sanitizeTraceErrorMessage('abcdef', 4)).toBe('abcd\n...[truncated 2 chars]');
    expect(sanitizeTraceErrorMessage('abcdef', 0)).toBe('...[truncated 6 chars]');
  });

  it('does not let an unreachable collector change command success or failure', async () => {
    const tracingUrl = new URL('../src/imprint/tracing.ts', import.meta.url).href;
    const run = async (mode: 'success' | 'failure') => {
      const env = { ...process.env, PHOENIX_HOST: undefined };
      Object.assign(env, {
        IMPRINT_TRACE: '1',
        IMPRINT_TRACE_BATCH: '1',
        PHOENIX_COLLECTOR_ENDPOINT: 'http://127.0.0.1:1',
      });
      const script = `
        import { shutdownTracing, traced } from ${JSON.stringify(tracingUrl)};
        const mode = ${JSON.stringify(mode)};
        try {
          await traced('trace-shutdown-fixture', 'CHAIN', {}, async () => {
            if (mode === 'failure') throw new Error('APPLICATION_FAILURE');
          });
          await shutdownTracing();
          console.log('COMMAND_SUCCESS');
        } catch (error) {
          console.error('COMMAND_FAILURE:', error.message);
          await shutdownTracing();
          process.exitCode = 23;
        }
      `;
      const child = Bun.spawn([process.execPath, '-e', script], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };

    const success = await run('success');
    expect(success.exitCode).toBe(0);
    expect(success.stdout).toContain('COMMAND_SUCCESS');
    expect(success.stderr).toContain(
      'warning: tracing export failed; command result is unaffected',
    );
    expect(success.stderr).not.toContain('error: ECONNREFUSED');

    const failure = await run('failure');
    expect(failure.exitCode).toBe(23);
    expect(failure.stderr).toContain('COMMAND_FAILURE: APPLICATION_FAILURE');
    expect(failure.stderr).toContain(
      'warning: tracing export failed; command result is unaffected',
    );
    expect(failure.stderr).not.toContain('error: ECONNREFUSED');
  });

  it('runs application work when tracing initialization fails', async () => {
    const tracingUrl = new URL('../src/imprint/tracing.ts', import.meta.url).href;
    const env = { ...process.env, IMPRINT_TRACE: '1' };
    const script = `
      import { mock } from 'bun:test';
      const actual = await import('@arizeai/phoenix-otel');
      mock.module('@arizeai/phoenix-otel', () => ({
        ...actual,
        register() { throw new Error('REGISTER_FAILURE'); },
      }));
      const { shutdownTracing, traced } = await import(${JSON.stringify(`${tracingUrl}?register-failure`)});
      await traced('trace-init-success', 'CHAIN', {}, async () => {
        console.log('SUCCESS_WORK_RAN');
      });
      try {
        await traced('trace-init-failure', 'CHAIN', {}, async () => {
          throw new Error('APPLICATION_FAILURE');
        });
      } catch (error) {
        console.error('COMMAND_FAILURE:', error.message);
        process.exitCode = 23;
      }
      await shutdownTracing();
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(23);
    expect(stdout).toContain('SUCCESS_WORK_RAN');
    expect(stderr).toContain('warning: tracing initialization failed; tracing is disabled');
    expect(stderr).toContain('REGISTER_FAILURE');
    expect(stderr).toContain('COMMAND_FAILURE: APPLICATION_FAILURE');
  });
});

describe('LLM trace usage attributes', () => {
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

  it('adds OpenInference model, token, and message attributes without local pricing', () => {
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
    expect(attrs['llm.model_name']).toBe('gpt-test');
    expect(attrs['llm.provider']).toBe('openai');
    expect(attrs['llm.cost.prompt']).toBeUndefined();
    expect(attrs['llm.cost.completion']).toBeUndefined();
    expect(attrs['llm.cost.total']).toBeUndefined();
    expect(attrs['llm.input_messages.0.message.role']).toBe('user');
    expect(attrs['llm.input_messages.0.message.content']).toBe('hello');
    expect(attrs['llm.output_messages.0.message.content']).toBe('world');
    expect(attrs['imprint.llm.tokens_estimated']).toBe(true);
    expect(attrs['imprint.llm.input_tokens_source']).toBe('estimated');
    expect(attrs['imprint.llm.output_tokens_source']).toBe('provider');
  });

  it('sums total prompt tokens from the uncached + cache split', () => {
    // Providers report input_tokens as uncached-only; the total prompt is
    // uncached + cache_read + cache_write.
    expect(totalPromptTokens(152, 354_298, 49_253)).toBe(403_703);
    // Missing cache counts default to 0.
    expect(totalPromptTokens(100, undefined, undefined)).toBe(100);
    expect(totalPromptTokens(100, null, null)).toBe(100);
    // Unknown uncached count → null (caller estimates from text instead).
    expect(totalPromptTokens(null, 354_298, 49_253)).toBeNull();
    expect(totalPromptTokens(undefined, 1, 2)).toBeNull();
  });

  it('emits the total prompt and cache breakdown Phoenix needs for server-side cost', () => {
    // Real numbers from a playbook-compilation llm.analyze call: 152 uncached,
    // 354,298 cache_read, 49,253 cache_write, 7,034 output. The analyze path now
    // feeds llmSpanAttributes the TOTAL prompt + the cache split (as traceAnalyze
    // does), allowing Phoenix to apply the configured model pricing.
    const uncached = 152;
    const cacheRead = 354_298;
    const cacheWrite = 49_253;
    const output = 7_034;
    const attrs = llmSpanAttributes({
      provider: 'claude-cli',
      model: 'claude-opus-4-8',
      inputTokens: totalPromptTokens(uncached, cacheRead, cacheWrite) ?? undefined,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    expect(attrs['llm.token_count.prompt']).toBe(uncached + cacheRead + cacheWrite);
    expect(attrs['llm.token_count.prompt_details.cache_read']).toBe(cacheRead);
    expect(attrs['llm.token_count.prompt_details.cache_write']).toBe(cacheWrite);
    expect(attrs['llm.cost.total']).toBeUndefined();
  });

  it('omits cache detail attributes when no cache tokens are present', () => {
    const attrs = llmSpanAttributes({
      provider: 'anthropic-api',
      model: 'claude-sonnet-4-6',
      inputTokens: 500_000,
      outputTokens: 100_000,
    });

    expect(attrs['llm.token_count.prompt_details.cache_read']).toBeUndefined();
    expect(attrs['llm.token_count.prompt_details.cache_write']).toBeUndefined();
  });
});
