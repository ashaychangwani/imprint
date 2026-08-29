import { describe, expect, it } from 'bun:test';
import {
  ProviderDeadlineError,
  ProviderReportedError,
  ProviderUnavailableError,
  RunDeadline,
  boundedRunDeadline,
  combinedDeadlineSignal,
  isTransientProviderCapacityError,
  jitteredBackoffMs,
  retryTransientProviderFailure,
} from '../src/imprint/provider-retry.ts';

describe('isTransientProviderCapacityError', () => {
  it('recognizes provider-neutral capacity and overload shapes', () => {
    expect(
      isTransientProviderCapacityError(
        new ProviderReportedError('fixture', { statuses: [429], messages: ['busy'] }),
      ),
    ).toBe(true);
    expect(
      isTransientProviderCapacityError(
        new ProviderReportedError('fixture', { codes: ['resource_exhausted'] }),
      ),
    ).toBe(true);
    expect(
      isTransientProviderCapacityError(
        new Error('wrapped provider error', {
          cause: new ProviderReportedError('fixture', { statuses: [529] }),
        }),
      ),
    ).toBe(true);
    expect(
      isTransientProviderCapacityError(
        new ProviderReportedError('fixture', {
          messages: ["You've hit your usage limit. Try again at 3:24 AM."],
        }),
      ),
    ).toBe(true);
  });

  it('does not classify arbitrary orchestration or target text', () => {
    expect(isTransientProviderCapacityError(new Error('target returned HTTP 429'))).toBe(false);
    expect(isTransientProviderCapacityError(new Error('provider overloaded'))).toBe(false);
  });

  it('does not retry deterministic provider request or access failures', () => {
    for (const error of [
      new ProviderReportedError('fixture', { statuses: [400] }),
      new ProviderReportedError('fixture', { statuses: [401], messages: ['rate limit'] }),
      new ProviderReportedError('fixture', { codes: ['authorization'] }),
      new ProviderReportedError('fixture', { codes: ['input_too_large'] }),
      new ProviderReportedError('fixture', { messages: ['insufficient quota; update billing'] }),
    ]) {
      expect(isTransientProviderCapacityError(error)).toBe(false);
    }
  });

  it('treats every non-rate-limit 4xx and deterministic provider code as non-retryable', () => {
    for (let status = 400; status < 500; status++) {
      if (status === 429) continue;
      expect(
        isTransientProviderCapacityError(
          new ProviderReportedError('fixture', {
            statuses: [429, status],
            codes: ['rate_limited'],
          }),
        ),
      ).toBe(false);
    }
    for (const code of [
      'schema_error',
      'permission_denied',
      'request-too-large',
      'invalid_request',
      'authentication-error',
      'authorization.failed',
      'billing_required',
    ]) {
      expect(
        isTransientProviderCapacityError(
          new ProviderReportedError('fixture', { statuses: [429], codes: [code] }),
        ),
      ).toBe(false);
    }
  });

  it('lets deterministic provider facts override simultaneous transient facts', () => {
    expect(
      isTransientProviderCapacityError(
        new ProviderReportedError('claude-cli', {
          statuses: [429],
          codes: ['rate_limited', 'insufficient_quota'],
          messages: ['provider overloaded', 'invalid API key'],
        }),
      ),
    ).toBe(false);
    expect(
      isTransientProviderCapacityError(
        new ProviderReportedError('codex-cli', {
          statuses: [429],
          codes: ['insufficient_quota'],
        }),
      ),
    ).toBe(false);
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
  it('asks only once when the caller declines an extension for the current deadline', async () => {
    const runDeadline = new RunDeadline(100);
    let requests = 0;
    const decline = async () => {
      requests++;
      return null;
    };
    expect(
      await Promise.all([
        runDeadline.requestExtension(decline),
        runDeadline.requestExtension(decline),
      ]),
    ).toEqual([false, false]);
    expect(await runDeadline.requestExtension(decline)).toBe(false);
    expect(requests).toBe(1);
    runDeadline.extend(10);
    expect(await runDeadline.requestExtension(async () => 5)).toBe(true);
    expect(runDeadline.deadlineMs).toBe(115);
  });

  it('extends only the run boundary and never a shorter phase boundary', async () => {
    const phaseBoundRun = new RunDeadline(200);
    let phasePrompts = 0;
    const phaseError = retryTransientProviderFailure(async () => 'not called', {
      runDeadline: boundedRunDeadline(phaseBoundRun, 150),
      now: () => 160,
      onDeadlineReached: async () => {
        phasePrompts++;
        return 100;
      },
    });
    await expect(phaseError).rejects.toMatchObject({ scope: 'phase' });
    expect(phasePrompts).toBe(0);

    await expect(
      retryTransientProviderFailure(async () => 'not called', {
        runDeadline: boundedRunDeadline(undefined, 150),
        now: () => 160,
        onDeadlineReached: async () => {
          phasePrompts++;
          return 100;
        },
      }),
    ).rejects.toMatchObject({ scope: 'phase' });
    expect(phasePrompts).toBe(0);

    const runBound = new RunDeadline(150);
    let runPrompts = 0;
    expect(
      await retryTransientProviderFailure(async () => 'continued', {
        runDeadline: boundedRunDeadline(runBound, 300),
        now: () => 160,
        onDeadlineReached: async () => {
          runPrompts++;
          return 100;
        },
      }),
    ).toBe('continued');
    expect(runPrompts).toBe(1);
    expect(runBound.deadlineMs).toBe(250);
  });

  it('treats equal run and phase deadlines as the nonextendable phase boundary', async () => {
    const runDeadline = new RunDeadline(150);
    let extensionRequests = 0;
    await expect(
      retryTransientProviderFailure(async () => 'not called', {
        runDeadline: boundedRunDeadline(runDeadline, 150),
        now: () => 150,
        onDeadlineReached: async () => {
          extensionRequests += 1;
          return 100;
        },
      }),
    ).rejects.toMatchObject({ scope: 'phase' });
    expect(extensionRequests).toBe(0);
    expect(runDeadline.deadlineMs).toBe(150);
  });

  it('reschedules an already-active deadline signal when the run is extended', async () => {
    const runDeadline = new RunDeadline(Date.now() + 40);
    const active = combinedDeadlineSignal(runDeadline, undefined, undefined);
    try {
      const aborted = new Promise<unknown>((resolve) =>
        active.signal?.addEventListener('abort', () => resolve(active.signal?.reason), {
          once: true,
        }),
      );
      await Bun.sleep(10);
      runDeadline.extend(100);
      await Bun.sleep(50);
      expect(active.signal?.aborted).toBe(false);
      expect(await aborted).toBeInstanceOf(ProviderDeadlineError);
    } finally {
      active.dispose();
    }
  });

  it('keeps an active operation alive when the caller accepts at the deadline', async () => {
    const runDeadline = new RunDeadline(Date.now() + 25);
    let prompts = 0;
    const active = combinedDeadlineSignal(
      runDeadline,
      undefined,
      undefined,
      Date.now,
      undefined,
      async () => {
        prompts++;
        return 100;
      },
    );
    try {
      await Bun.sleep(50);
      expect(prompts).toBe(1);
      expect(active.signal?.aborted).toBe(false);
    } finally {
      active.dispose();
    }
  });

  it('does not start an operation when the absolute deadline already passed', async () => {
    let calls = 0;
    await expect(
      retryTransientProviderFailure(
        async () => {
          calls++;
          return 'impossible';
        },
        { deadlineMs: 99, now: () => 100 },
      ),
    ).rejects.toBeInstanceOf(ProviderDeadlineError);
    expect(calls).toBe(0);
  });

  it('retries a typed exact safety interruption without a fabricated status', async () => {
    let calls = 0;
    const safety = new ProviderReportedError(
      'claude-cli',
      {
        messages: [
          'I am unable to respond to this request because it appears to violate our Usage Policy.',
        ],
      },
      undefined,
      'transient_safety_filter',
    );
    const value = await retryTransientProviderFailure(
      async () => {
        calls++;
        if (calls === 1) throw safety;
        return 'recovered';
      },
      { sleep: async () => {} },
    );
    expect(value).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry a typed safety interruption contradicted by deterministic facts', async () => {
    let calls = 0;
    await expect(
      retryTransientProviderFailure(
        async () => {
          calls++;
          throw new ProviderReportedError(
            'claude-cli',
            { codes: ['invalid_api_key'] },
            undefined,
            'transient_safety_filter',
          );
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ProviderReportedError);
    expect(calls).toBe(1);
  });

  it('aborts an active provider call at the hard deadline', async () => {
    let activeSignal: AbortSignal | undefined;
    await expect(
      retryTransientProviderFailure(
        async (signal) => {
          activeSignal = signal;
          return await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        { deadlineMs: Date.now() + 10 },
      ),
    ).rejects.toBeInstanceOf(ProviderDeadlineError);
    expect(activeSignal?.aborted).toBe(true);
  });

  it('preserves the last provider cause when a recovery attempt reaches its deadline', async () => {
    const providerCause = new ProviderReportedError('fixture', { statuses: [529] });
    let calls = 0;
    await expect(
      retryTransientProviderFailure(
        async (signal) => {
          calls++;
          if (calls === 1) throw providerCause;
          return await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        {
          deadlineMs: Date.now() + 20,
          initialDelayMs: 1,
          random: () => 0.5,
        },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toBe(2);
  });

  it('keeps the same logical operation alive until the provider recovers', async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryAttempts: number[] = [];

    const result = await retryTransientProviderFailure(
      async () => {
        calls++;
        if (calls < 4) throw new ProviderReportedError('fixture', { statuses: [529] });
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
          throw new ProviderReportedError('fixture', { codes: ['rate_limited'] });
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
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

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
        if (calls === 1) throw new ProviderReportedError('fixture', { statuses: [529] });
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
          throw new ProviderReportedError('fixture', { statuses: [429] });
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
          throw new ProviderReportedError('fixture', {
            statuses: [400],
            messages: ['bad schema'],
          });
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
