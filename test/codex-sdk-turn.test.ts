import { describe, expect, it } from 'bun:test';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import { runCodexSdkTurn } from '../src/imprint/codex-sdk-turn.ts';
import {
  ProviderReportedError,
  ProviderUnavailableError,
  retryTransientProviderFailure,
} from '../src/imprint/provider-retry.ts';

const capacity: ThreadEvent = {
  type: 'turn.failed',
  error: { message: 'Selected model is at capacity. Please try a different model.' },
};
const completed: ThreadEvent[] = [
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '{"ok":true}' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 123,
      cached_input_tokens: 100,
      cache_write_input_tokens: 4,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    },
  },
];

function fixture(turns: ThreadEvent[][]) {
  const inputs: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let closed = 0;
  const thread: Pick<Thread, 'runStreamed'> = {
    async runStreamed(input, options) {
      inputs.push(String(input));
      signals.push(options?.signal);
      const turn = turns[inputs.length - 1];
      if (!turn) throw new Error('Unexpected extra SDK call');
      return {
        events: (async function* () {
          try {
            yield* turn;
          } finally {
            closed++;
          }
        })(),
      };
    },
  };
  return { thread, inputs, signals, closed: () => closed };
}

describe('Codex SDK terminal evidence', () => {
  it('finishes at the terminal event without an additional stream read', async () => {
    let nextCalls = 0;
    let closed = 0;
    const thread: Pick<Thread, 'runStreamed'> = {
      async runStreamed() {
        return {
          events: {
            [Symbol.asyncIterator]() {
              return this;
            },
            async throw(error: unknown): Promise<never> {
              throw error;
            },
            async next() {
              const value = completed[nextCalls++];
              if (!value) return await new Promise<IteratorResult<ThreadEvent>>(() => {});
              return { done: false as const, value };
            },
            async return() {
              closed++;
              return { done: true as const, value: undefined };
            },
          },
        };
      },
    };
    const result = await runCodexSdkTurn(thread, 'fixture', {}, { cleanupTimeoutMs: 5 });
    expect(result.finalResponse).toBe('{"ok":true}');
    expect(nextCalls).toBe(2);
    expect(closed).toBe(1);
    expect(result.usage?.cached_input_tokens).toBe(100);
  });

  it('preserves semantic completion during hanging cleanup and prevents overlapping turns', async () => {
    let calls = 0;
    let finishCleanup: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const events: string[] = [];
    const signals: AbortSignal[] = [];
    const thread: Pick<Thread, 'runStreamed'> = {
      async runStreamed(_input, options) {
        calls++;
        if (options?.signal) signals.push(options.signal);
        let next = 0;
        return {
          events: {
            [Symbol.asyncIterator]() {
              return this;
            },
            async throw(error: unknown): Promise<never> {
              throw error;
            },
            async next() {
              const value = completed[next++];
              return value
                ? { done: false as const, value }
                : { done: true as const, value: undefined };
            },
            async return() {
              await cleanup;
              return { done: true as const, value: undefined };
            },
          },
        };
      },
    };
    const result = await runCodexSdkTurn(
      thread,
      'first',
      {},
      { cleanupTimeoutMs: 5, onEvent: (event) => events.push(event.type) },
    );
    expect(result.usage?.output_tokens).toBe(7);
    expect(signals[0]?.aborted).toBeTrue();
    expect(events).toContain('sdk.cleanup_pending');
    await expect(runCodexSdkTurn(thread, 'blocked', {}, { cleanupTimeoutMs: 5 })).rejects.toThrow(
      'cleanup is unfinished',
    );
    expect(calls).toBe(1);
    finishCleanup();
    expect(
      (await runCodexSdkTurn(thread, 'next', {}, { cleanupTimeoutMs: 50 })).finalResponse,
    ).toBe('{"ok":true}');
    expect(calls).toBe(2);
    expect(events).toContain('sdk.cleanup_completed');
  });

  it('retries capacity on the same thread and prompt, retaining completed usage', async () => {
    const f = fixture([[capacity], completed]);
    const retries: string[] = [];
    const result = await retryTransientProviderFailure(
      (signal) => runCodexSdkTurn(f.thread, 'same investigation', { signal }),
      {
        deadlineMs: Date.now() + 10000,
        sleep: async () => {},
        onRetry: (e) => retries.push(e.reason),
      },
    );
    expect(f.inputs).toEqual(['same investigation', 'same investigation']);
    expect(f.signals.every(Boolean)).toBe(true);
    expect(f.closed()).toBe(2);
    expect(retries).toEqual(['capacity_or_overload']);
    expect(result.finalResponse).toBe('{"ok":true}');
    expect(result.items).toHaveLength(1);
    expect(result.usage).toEqual(
      completed[1]?.type === 'turn.completed' ? completed[1].usage : null,
    );
  });

  it('keeps capacity bounded by the existing deadline', async () => {
    const f = fixture([[capacity], [capacity]]);
    let now = 0;
    await expect(
      retryTransientProviderFailure(() => runCodexSdkTurn(f.thread, 'same investigation'), {
        deadlineMs: 15,
        now: () => now,
        initialDelayMs: 10,
        random: () => 0.5,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(f.inputs).toHaveLength(2);
    expect(now).toBe(15);
    expect(f.closed()).toBe(2);
  });

  it('does not retry deterministic terminal failures', async () => {
    const f = fixture([[{ type: 'turn.failed', error: { message: 'Invalid API key' } }]]);
    await expect(
      retryTransientProviderFailure(() => runCodexSdkTurn(f.thread, 'request')),
    ).rejects.toBeInstanceOf(ProviderReportedError);
    expect(f.inputs).toHaveLength(1);
    expect(f.closed()).toBe(1);
  });

  it('does not classify capacity words in ordinary output or arbitrary thrown errors', async () => {
    const f = fixture([
      [
        {
          type: 'item.completed',
          item: { id: 'reason', type: 'reasoning', text: 'model is at capacity' },
        },
        {
          type: 'item.completed',
          item: { id: 'message', type: 'agent_message', text: 'target returned HTTP 429' },
        },
        ...completed,
      ],
    ]);
    expect((await runCodexSdkTurn(f.thread, 'request')).items).toHaveLength(3);
    const error = new Error('Selected model is at capacity. Please try a different model.');
    let calls = 0;
    const thread = {
      async runStreamed(): Promise<never> {
        calls++;
        throw error;
      },
    };
    await expect(
      retryTransientProviderFailure(() => runCodexSdkTurn(thread, 'request')),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});
