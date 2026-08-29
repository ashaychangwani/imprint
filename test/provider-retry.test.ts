import { describe, expect, it } from 'bun:test';
import {
  isTransientProviderCapacityError,
  jitteredBackoffMs,
  retryTransientProviderFailure,
} from '../src/imprint/provider-retry.ts';

describe('isTransientProviderCapacityError', () => {
  it('recognizes provider-neutral capacity and overload shapes', () => {
    expect(
      isTransientProviderCapacityError(Object.assign(new Error('busy'), { status: 429 })),
    ).toBe(true);
    expect(isTransientProviderCapacityError(new Error('API is temporarily overloaded'))).toBe(true);
    expect(
      isTransientProviderCapacityError(
        Object.assign(new Error('request failed'), { code: 'resource_exhausted' }),
      ),
    ).toBe(true);
    expect(
      isTransientProviderCapacityError(
        new Error('wrapped provider error', {
          cause: Object.assign(new Error('upstream'), { status: 529 }),
        }),
      ),
    ).toBe(true);
    expect(
      isTransientProviderCapacityError(
        new Error("You've hit your usage limit. Try again at 3:24 AM."),
      ),
    ).toBe(true);
  });

  it('does not retry deterministic request or access failures', () => {
    for (const error of [
      Object.assign(new Error('invalid request'), { status: 400 }),
      Object.assign(new Error('rate limit text in an invalid API key hint'), { status: 401 }),
      Object.assign(new Error('forbidden'), { errorCode: 'authorization' }),
      new Error('workflow schema validation failed'),
      new Error('input_too_large'),
      new Error('insufficient quota; update billing'),
    ]) {
      expect(isTransientProviderCapacityError(error)).toBe(false);
    }
  });
});

describe('jitteredBackoffMs', () => {
  it('grows exponentially, jitters, and never exceeds the cap', () => {
    expect(jitteredBackoffMs(1, 1_000, 30_000, 0)).toBe(750);
    expect(jitteredBackoffMs(2, 1_000, 30_000, 0.5)).toBe(2_000);
    expect(jitteredBackoffMs(3, 1_000, 30_000, 1)).toBe(5_000);
    expect(jitteredBackoffMs(20, 1_000, 30_000, 1)).toBe(30_000);
  });
});

describe('retryTransientProviderFailure', () => {
  it('keeps the same logical operation alive until the provider recovers', async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryAttempts: number[] = [];

    const result = await retryTransientProviderFailure(
      async () => {
        calls++;
        if (calls < 4) throw new Error('provider overloaded; try again later');
        return 'recovered';
      },
      {
        initialDelayMs: 100,
        maxDelayMs: 1_000,
        random: () => 0.5,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        onRetry: ({ attempt }) => retryAttempts.push(attempt),
      },
    );

    expect(result).toBe('recovered');
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
    expect(retryAttempts).toEqual([1, 2, 3]);
  });

  it('stops at the existing deadline without starting another provider call', async () => {
    let now = 1_000;
    let calls = 0;
    const delays: number[] = [];

    await expect(
      retryTransientProviderFailure(
        async () => {
          calls++;
          throw new Error('rate_limited');
        },
        {
          deadlineMs: 1_250,
          initialDelayMs: 1_000,
          random: () => 0.5,
          now: () => now,
          sleep: async (delayMs) => {
            delays.push(delayMs);
            now += delayMs;
          },
        },
      ),
    ).rejects.toThrow('rate_limited');

    expect(calls).toBe(1);
    expect(delays).toEqual([250]);
  });

  it('applies one caller-approved deadline extension to the retry clock', async () => {
    let now = 100;
    let calls = 0;
    let extensionCalls = 0;

    const result = await retryTransientProviderFailure(
      async () => {
        calls++;
        if (calls === 1) throw new Error('provider overloaded');
        return 'done';
      },
      {
        deadlineMs: 110,
        initialDelayMs: 100,
        random: () => 0.5,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
        onDeadlineReached: async () => {
          extensionCalls++;
          return 50;
        },
      },
    );

    expect(result).toBe('done');
    expect(calls).toBe(2);
    expect(extensionCalls).toBe(1);
    expect(now).toBe(110);
  });

  it('honors cancellation between attempts', async () => {
    const controller = new AbortController();
    let calls = 0;

    await expect(
      retryTransientProviderFailure(
        async () => {
          calls++;
          throw new Error('429 too many requests');
        },
        {
          signal: controller.signal,
          random: () => 0.5,
          sleep: async () => {
            controller.abort(new Error('cancelled by user'));
          },
        },
      ),
    ).rejects.toThrow('cancelled by user');
    expect(calls).toBe(1);
  });

  it('immediately returns deterministic failures', async () => {
    let slept = false;
    let calls = 0;

    await expect(
      retryTransientProviderFailure(
        async () => {
          calls++;
          throw Object.assign(new Error('bad schema'), { status: 400 });
        },
        {
          sleep: async () => {
            slept = true;
          },
        },
      ),
    ).rejects.toThrow('bad schema');

    expect(calls).toBe(1);
    expect(slept).toBe(false);
  });
});
