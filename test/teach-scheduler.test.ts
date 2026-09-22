import { describe, expect, it } from 'bun:test';
import {
  ProviderReportedError,
  providerRetryAfterMs,
  retryTransientProviderFailure,
} from '../src/imprint/provider-retry.ts';
import { TeachScheduler, type TeachSchedulingEvent } from '../src/imprint/teach-scheduler.ts';

const flush = () => Bun.sleep(0);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(deadline = 1_000_000) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const events: TeachSchedulingEvent[] = [];
  const scheduler = new TeachScheduler({
    deadline: { deadlineMs: deadline },
    deadlineError: () => new Error('fixture deadline'),
    now: () => now,
    onEvent: (event) => events.push(event),
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      timers.delete(id as unknown as number);
    },
  });
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
    await flush();
  };
  return { scheduler, events, advance };
}

describe('teach scheduler', () => {
  it('counts coordinator provider calls beside ten focused workers', async () => {
    const { scheduler, events } = fixture();
    const gate = deferred();
    try {
      await scheduler.run(async () => {
        const jobs = Array.from({ length: 10 }, () =>
          scheduler.worker(() => retryTransientProviderFailure(() => gate.promise)),
        );
        await flush();
        let masterStarted = false;
        const master = retryTransientProviderFailure(async () => {
          masterStarted = true;
        });
        await flush();
        expect(masterStarted).toBe(false);
        gate.resolve();
        await Promise.all([...jobs, master]);
        expect(masterStarted).toBe(true);
        expect(events.every((event) => event.activeProviders <= 10)).toBe(true);
      });
    } finally {
      gate.resolve();
      scheduler.dispose();
    }
  });

  it('admits ten workers across independent queues and releases cancelled waiters', async () => {
    const { scheduler, events } = fixture();
    const gate = deferred();
    const jobs = Array.from({ length: 10 }, () => scheduler.worker(() => gate.promise));
    await flush();
    const abort = new AbortController();
    const queued = scheduler.worker(async () => {
      throw new Error('must not start');
    }, abort.signal);
    const cancelled = queued.catch((error: Error) => error);
    abort.abort(new Error('fixture cancelled'));
    expect((await cancelled)?.message).toBe('fixture cancelled');
    expect(events.filter((event) => event.type === 'admitted')).toHaveLength(10);
    gate.resolve();
    await Promise.all(jobs);
    await scheduler.worker(async () => {});
    expect(events.at(-1)?.activeWorkers).toBe(0);
    scheduler.dispose();
  });

  it('halves on three distinct failures, ignores duplicates and drains old attempts', async () => {
    const { scheduler, advance, events } = fixture();
    const oldGate = deferred();
    const old = scheduler.providerAttempt(async () => {
      await oldGate.promise;
      scheduler.capacityFailure();
    });
    for (let index = 0; index < 3; index++)
      await scheduler.providerAttempt(async () => {
        scheduler.capacityFailure();
        scheduler.capacityFailure();
      });
    expect(scheduler.limit).toBe(5);
    oldGate.resolve();
    await old;
    expect(events.filter((event) => event.type === 'capacity_failure')).toHaveLength(3);
    let admitted = false;
    const next = scheduler.providerAttempt(async () => {
      admitted = true;
    });
    await advance(29_999);
    expect(admitted).toBe(false);
    await advance(1);
    await next;
    for (const expected of [2, 1, 1]) {
      for (let index = 0; index < 3; index++)
        await scheduler.providerAttempt(async () => scheduler.capacityFailure());
      expect(scheduler.limit).toBe(expected);
      await advance(30_000);
    }
    scheduler.dispose();
  });

  it('honors longer provider delays and probes upward only with healthy queued demand', async () => {
    const { scheduler, advance } = fixture();
    for (let index = 0; index < 2; index++)
      await scheduler.providerAttempt(async () => scheduler.capacityFailure());
    await scheduler.providerAttempt(async () => scheduler.capacityFailure(90_000));
    const gate = deferred();
    const jobs = Array.from({ length: 5 }, () => scheduler.providerAttempt(() => gate.promise));
    await advance(60_000);
    expect(scheduler.limit).toBe(5);
    await advance(30_000);
    gate.resolve();
    await Promise.all(jobs);
    expect(scheduler.limit).toBe(5); // No queued work: no artificial probing.
    await scheduler.providerAttempt(async () => {});
    expect(scheduler.limit).toBe(6);
    scheduler.dispose();
  });

  it('discards old failure windows and cannot increase before sixty healthy seconds', async () => {
    const { scheduler, advance } = fixture();
    await scheduler.providerAttempt(async () => scheduler.capacityFailure());
    await advance(60_001);
    for (let index = 0; index < 2; index++)
      await scheduler.providerAttempt(async () => scheduler.capacityFailure());
    expect(scheduler.limit).toBe(10);
    await scheduler.providerAttempt(async () => scheduler.capacityFailure());
    await advance(30_000);
    for (let index = 0; index < 6; index++) await scheduler.providerAttempt(async () => {});
    expect(scheduler.limit).toBe(5);
    await advance(30_000);
    await scheduler.providerAttempt(async () => {});
    expect(scheduler.limit).toBe(6);
    scheduler.dispose();
  });

  it('parents yield worker slots while children run, even at the minimum limit', async () => {
    const { scheduler, advance, events } = fixture();
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 3; index++)
        await scheduler.providerAttempt(async () => scheduler.capacityFailure());
      await advance(30_000);
    }
    expect(scheduler.limit).toBe(1);
    const result = await scheduler.worker(() =>
      scheduler.yieldWorker(() =>
        Promise.all([scheduler.worker(async () => 1), scheduler.worker(async () => 2)]),
      ),
    );
    expect(result).toEqual([1, 2]);
    expect(events.every((event) => event.activeWorkers <= 1)).toBe(true);
    scheduler.dispose();
  });

  it('deadline and disposal reject queued work without cancelling existing jobs', async () => {
    const { scheduler, advance } = fixture(50);
    const gate = deferred();
    const active = Array.from({ length: 10 }, () => scheduler.worker(() => gate.promise));
    const queued = scheduler.worker(async () => {});
    const expired = queued.catch((error: Error) => error);
    await advance(50);
    expect((await expired)?.message).toBe('fixture deadline');
    gate.resolve();
    await Promise.all(active);
    scheduler.dispose();
    const fresh = fixture();
    fresh.scheduler.dispose();
    await expect(fresh.scheduler.worker(async () => {})).rejects.toThrow('closed');
  });

  it('feeds retries into one admission layer and excludes non-capacity failures', async () => {
    const { scheduler, events } = fixture();
    await scheduler.run(async () => {
      let calls = 0;
      const value = await retryTransientProviderFailure(
        async () => {
          calls++;
          if (calls < 3) throw new ProviderReportedError('fixture', { statuses: [429] });
          return 'recovered';
        },
        { sleep: async () => {} },
      );
      expect(value).toBe('recovered');
      for (const error of [
        new Error('website HTTP 429'),
        new ProviderReportedError('fixture', { statuses: [400] }),
        new ProviderReportedError('fixture', { messages: ['authentication failed'] }),
      ]) {
        await expect(
          retryTransientProviderFailure(async () => {
            throw error;
          }),
        ).rejects.toThrow();
      }
      let interrupted = true;
      await retryTransientProviderFailure(
        async () => {
          if (interrupted) {
            interrupted = false;
            throw new ProviderReportedError(
              'fixture',
              {},
              undefined,
              'provider_process_interrupted',
            );
          }
        },
        { sleep: async () => {} },
      );
    });
    expect(events.filter((event) => event.type === 'capacity_failure')).toHaveLength(2);
    expect(events.at(-1)?.activeProviders).toBe(0);
    expect(scheduler.limit).toBe(10);
    scheduler.dispose();
  });

  it('nested recovery wrappers do not duplicate admissions or retain retry permits', async () => {
    const { scheduler, events } = fixture();
    await scheduler.run(() =>
      retryTransientProviderFailure(() =>
        retryTransientProviderFailure(
          async () => {
            if (!events.some((event) => event.type === 'capacity_failure'))
              throw new ProviderReportedError('fixture', { statuses: [503] });
            return 'ok';
          },
          {
            sleep: async () => {
              expect(events.at(-1)?.activeProviders).toBe(0);
            },
          },
        ),
      ),
    );
    expect(events.filter((event) => event.type === 'capacity_failure')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'admitted' && event.lane === 'provider'),
    ).toHaveLength(2);
    scheduler.dispose();
  });
});

it('uses explicit provider Retry-After headers in seconds or HTTP-date form', async () => {
  expect(providerRetryAfterMs(new Headers({ 'retry-after': '75' }))).toBe(75_000);
  expect(providerRetryAfterMs({ 'Retry-After': 'Thu, 01 Jan 1970 00:02:00 GMT' }, 30_000)).toBe(
    90_000,
  );
  expect(providerRetryAfterMs({ 'retry-after': 'not a date' })).toBeUndefined();
  const delays: number[] = [];
  let calls = 0;
  await retryTransientProviderFailure(
    async () => {
      if (calls++ === 0)
        throw new ProviderReportedError('fixture', { statuses: [429], retryAfterMs: 75_000 });
    },
    {
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0,
    },
  );
  expect(delays).toEqual([75_000]);
});
