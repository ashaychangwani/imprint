import { AsyncLocalStorage } from 'node:async_hooks';
import { abortSignalError } from './concurrency.ts';

export const MAX_TEACH_WORKERS = 10;
type Lane = 'worker' | 'provider';
interface Lease {
  id: number;
  generation: number;
  active: boolean;
  failed: boolean;
  signal?: AbortSignal;
}
interface Waiter {
  lane: Lane;
  queuedAt: number;
  signal?: AbortSignal;
  resolve: (lease: Lease) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
export interface TeachSchedulingEvent {
  type: 'admitted' | 'released' | 'capacity_failure' | 'limit_changed';
  timestamp: number;
  limit: number;
  activeWorkers: number;
  activeProviders: number;
  queued: number;
  lane?: Lane;
  attemptId?: number;
  queueMs?: number;
  previousLimit?: number;
  reason?: string;
  cooldownUntil?: number;
}
interface SchedulerOptions {
  deadline: { readonly deadlineMs: number };
  deadlineError: () => Error;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?: (event: TeachSchedulingEvent) => void;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const context = new AsyncLocalStorage<TeachScheduler>();
export const currentTeachScheduler = () => context.getStore();

/** One run owns both focused work and provider admissions. It stores no site
 * semantics. Reductions drain active work; only subsequent admissions change. */
export class TeachScheduler {
  readonly #worker = new AsyncLocalStorage<Lease | undefined>();
  readonly #provider = new AsyncLocalStorage<Lease>();
  readonly #waiters: Waiter[] = [];
  readonly #active: Record<Lane, number> = { worker: 0, provider: 0 };
  readonly #now: () => number;
  #limit = MAX_TEACH_WORKERS;
  #generation = 0;
  #nextId = 0;
  #failures: number[] = [];
  #successes = 0;
  #healthySince: number;
  #cooldownUntil = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(private readonly options: SchedulerOptions) {
    this.#now = options.now ?? Date.now;
    this.#healthySince = this.#now();
    options.signal?.addEventListener('abort', this.#pump);
  }

  get limit(): number {
    return this.#limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    return await context.run(this, work);
  }

  #emit(event: Partial<TeachSchedulingEvent> & Pick<TeachSchedulingEvent, 'type'>): void {
    this.options.onEvent?.({
      timestamp: this.#now(),
      limit: this.#limit,
      activeWorkers: this.#active.worker,
      activeProviders: this.#active.provider,
      queued: this.#waiters.length,
      ...event,
    });
  }

  #acquire(lane: Lane, signal?: AbortSignal): Promise<Lease> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        queuedAt: this.#now(),
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(signal ? abortSignalError(signal) : new Error('Teach scheduling cancelled'));
          this.#pump();
        },
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      else this.#pump();
    });
  }

  #pump = (): void => {
    if (this.#timer) (this.options.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = undefined;
    const now = this.#now();
    const terminal = this.options.signal?.aborted
      ? abortSignalError(this.options.signal)
      : now >= this.options.deadline.deadlineMs
        ? this.options.deadlineError()
        : this.#closed
          ? new Error('Teach scheduler closed')
          : undefined;
    if (terminal) {
      for (const waiter of this.#waiters.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.reject(terminal);
      }
      return;
    }
    if (
      this.#waiters.length &&
      this.#limit < MAX_TEACH_WORKERS &&
      this.#successes >= 5 &&
      now - this.#healthySince >= 60_000 &&
      now >= this.#cooldownUntil
    ) {
      this.#changeLimit(this.#limit + 1, 'successful_capacity_probe');
    }
    if (now >= this.#cooldownUntil) {
      for (let index = 0; index < this.#waiters.length; ) {
        const waiter = this.#waiters[index];
        if (!waiter) break;
        if (this.#active[waiter.lane] >= this.#limit) {
          index++;
          continue;
        }
        this.#waiters.splice(index, 1);
        waiter.signal?.removeEventListener('abort', waiter.abort);
        const lease: Lease = {
          id: ++this.#nextId,
          generation: this.#generation,
          active: true,
          failed: false,
          signal: waiter.signal,
        };
        this.#active[waiter.lane]++;
        this.#emit({
          type: 'admitted',
          lane: waiter.lane,
          attemptId: lease.id,
          queueMs: now - waiter.queuedAt,
        });
        waiter.resolve(lease);
      }
    }
    if (this.#waiters.length) {
      const wake = Math.min(
        this.options.deadline.deadlineMs,
        now < this.#cooldownUntil ? this.#cooldownUntil : Number.POSITIVE_INFINITY,
        this.#successes >= 5 && this.#limit < MAX_TEACH_WORKERS && this.#healthySince + 60_000 > now
          ? this.#healthySince + 60_000
          : Number.POSITIVE_INFINITY,
      );
      this.#timer = (this.options.setTimer ?? setTimeout)(this.#pump, Math.max(1, wake - now));
    }
  };

  #release(lane: Lane, lease: Lease): void {
    if (!lease.active) return;
    lease.active = false;
    this.#active[lane]--;
    this.#emit({ type: 'released', lane, attemptId: lease.id });
    this.#pump();
  }

  #changeLimit(limit: number, reason: string): void {
    const previousLimit = this.#limit;
    this.#limit = limit;
    this.#generation++;
    this.#failures = [];
    this.#successes = 0;
    this.#healthySince = this.#now();
    this.#emit({
      type: 'limit_changed',
      previousLimit,
      reason,
      cooldownUntil: this.#cooldownUntil,
    });
  }

  /** Called once per admitted attempt, never once per wrapper/error message. */
  capacityFailure(retryAfterMs = 0): void {
    const lease = this.#provider.getStore();
    if (!lease || lease.failed) return;
    lease.failed = true;
    const now = this.#now();
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0)
      this.#cooldownUntil = Math.max(this.#cooldownUntil, now + retryAfterMs);
    if (lease.generation !== this.#generation) {
      this.#pump();
      return;
    }
    this.#successes = 0;
    this.#healthySince = now;
    this.#failures = this.#failures.filter((time) => now - time <= 60_000);
    this.#failures.push(now);
    this.#emit({ type: 'capacity_failure', attemptId: lease.id });
    if (this.#failures.length >= 3) {
      this.#cooldownUntil = Math.max(this.#cooldownUntil, now + 30_000);
      this.#changeLimit(
        Math.max(1, Math.floor(this.#limit / 2)),
        'repeated_provider_capacity_failures',
      );
    }
    this.#pump();
  }

  async providerAttempt<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Recovery wrappers can nest. Their shared lease prevents double admission
    // and double-counted capacity events.
    if (this.#provider.getStore()?.active) return await work();
    const lease = await this.#acquire('provider', signal);
    try {
      return await this.#provider.run(lease, async () => {
        const value = await work();
        if (!lease.failed && lease.generation === this.#generation) this.#successes++;
        return value;
      });
    } finally {
      this.#release('provider', lease);
    }
  }

  async worker<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#worker.getStore()?.active) return await work();
    const lease = await this.#acquire('worker', signal);
    try {
      return await this.#worker.run(lease, work);
    } finally {
      this.#release('worker', lease);
    }
  }

  /** Awaiting child work must not hold the slot that child needs. */
  async yieldWorker<T>(work: () => Promise<T>): Promise<T> {
    const parent = this.#worker.getStore();
    if (!parent?.active) return await work();
    this.#release('worker', parent);
    try {
      return await this.#worker.run(undefined, work);
    } finally {
      const replacement = await this.#acquire('worker', parent.signal);
      Object.assign(parent, replacement);
    }
  }

  async retryWait<T>(work: () => Promise<T>): Promise<T> {
    const provider = this.#provider.getStore();
    if (provider) this.#release('provider', provider);
    return await this.yieldWorker(work);
  }

  dispose(): void {
    this.#closed = true;
    this.options.signal?.removeEventListener('abort', this.#pump);
    this.#pump();
  }
}
