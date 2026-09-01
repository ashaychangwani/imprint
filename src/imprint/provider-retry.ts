import { abortSignalError, abortableDelay } from './concurrency.ts';

export interface ProviderRetryEvent {
  attempt: number;
  delayMs: number;
  reason: ProviderInterruptionReason;
}

export type ProviderInterruptionReason =
  | 'capacity_or_overload'
  | 'transient_safety_filter'
  | 'provider_process_interrupted';

export interface ProviderRetryOptions {
  runDeadline?: RunDeadlineRef;
  phaseDeadlineMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  initialDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (event: ProviderRetryEvent) => void;
  onDeadlineReached?: () => Promise<number | null | undefined>;
}

export interface ProviderFailureFacts {
  statuses?: readonly number[];
  codes?: readonly string[];
  messages?: readonly string[];
}

export class ProviderReportedError extends Error {
  readonly provider: string;
  readonly statuses: readonly number[];
  readonly codes: readonly string[];
  readonly providerMessages: readonly string[];
  readonly interruption?: ProviderInterruptionReason;

  constructor(
    provider: string,
    facts: ProviderFailureFacts,
    cause?: unknown,
    interruption?: ProviderInterruptionReason,
  ) {
    const messages = facts.messages?.map((message) => message.trim()).filter(Boolean) ?? [];
    super(`${provider} provider error${messages[0] ? `: ${messages[0]}` : ''}`, { cause });
    this.name = 'ProviderReportedError';
    this.provider = provider;
    this.statuses = facts.statuses ?? [];
    this.codes = facts.codes ?? [];
    this.providerMessages = messages;
    this.interruption = interruption;
  }

  facts(): ProviderFailureFacts {
    return {
      statuses: this.statuses,
      codes: this.codes,
      messages: this.providerMessages,
    };
  }
}

export class ProviderUnavailableError extends Error {
  constructor(
    cause: unknown,
    message = 'The model provider remained unavailable until the current operation deadline.',
  ) {
    super(message, { cause });
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderDeadlineError extends Error {
  readonly deadlineMs: number;
  readonly scope: 'run' | 'phase';

  constructor(deadlineMs: number, cause?: unknown, scope: 'run' | 'phase' = 'run') {
    super(`Provider call exceeded its deadline (${new Date(deadlineMs).toISOString()})`, { cause });
    this.name = 'ProviderDeadlineError';
    this.deadlineMs = deadlineMs;
    this.scope = scope;
  }
}

const DETERMINISTIC_CODE =
  /(?:^|_)(?:auth(?:entication|orization)?|unauthorized|forbidden|permission|invalid|bad_request|schema|validation|request_too_large|input_too_large|context_length_exceeded|subscription_access_disabled|insufficient_quota|billing|payment_required)(?:_|$)/i;
const TRANSIENT_CODE =
  /^(?:rate_limited|rate_limit_exceeded|overloaded|overloaded_error|server_overloaded|resource_exhausted|temporarily_unavailable|service_unavailable)$/i;
const DETERMINISTIC_MESSAGE =
  /\b(?:invalid api key|authentication failed|not authenticated|unauthorized|forbidden|authorization failed|permission denied|access denied|invalid[_ -]?request|bad request|schema (?:error|validation|failed)|input[_ -]?(?:is )?too[_ -]?large|subscription access|insufficient[_ -]?quota|billing|credit balance|payment required)\b/i;
const TRANSIENT_MESSAGE =
  /(?:too many requests|rate[_ -]?limit(?:ed| exceeded)?|you['’]?ve hit your usage limit|usage limit[^\n]*(?:reset|try again)|(?:provider|service|server|model|api) (?:is )?(?:temporarily )?(?:overloaded|over capacity|at capacity|busy|unavailable)|capacity (?:limit|exhausted|temporarily unavailable)|resource exhausted|try again later)/i;

export function hasDeterministicProviderFailureFacts(facts: ProviderFailureFacts): boolean {
  return (
    (facts.statuses ?? []).some((status) => status >= 400 && status < 500 && status !== 429) ||
    (facts.codes ?? []).some((code) =>
      DETERMINISTIC_CODE.test(
        code
          .trim()
          .toLowerCase()
          .replace(/[\s.-]+/g, '_'),
      ),
    ) ||
    (facts.messages ?? []).some((message) => DETERMINISTIC_MESSAGE.test(message))
  );
}

export function isTransientProviderFailureFacts(facts: ProviderFailureFacts): boolean {
  if (hasDeterministicProviderFailureFacts(facts)) return false;
  return (
    (facts.statuses ?? []).some((status) => status === 429 || status === 503 || status === 529) ||
    (facts.codes ?? []).some((code) =>
      TRANSIENT_CODE.test(
        code
          .trim()
          .toLowerCase()
          .replace(/[\s.-]+/g, '_'),
      ),
    ) ||
    (facts.messages ?? []).some((message) => TRANSIENT_MESSAGE.test(message))
  );
}

function findCause<T>(error: unknown, match: (value: unknown) => value is T): T | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (match(current)) return current;
    current =
      typeof current === 'object' && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

export function providerReportedError(error: unknown): ProviderReportedError | undefined {
  return findCause(error, (value): value is ProviderReportedError =>
    Boolean(value instanceof ProviderReportedError),
  );
}

export function isTransientProviderCapacityError(error: unknown): boolean {
  const reported = providerReportedError(error);
  if (!reported || hasDeterministicProviderFailureFacts(reported.facts())) return false;
  return Boolean(reported.interruption) || isTransientProviderFailureFacts(reported.facts());
}

export function providerControlError(error: unknown): Error | undefined {
  return findCause(
    error,
    (value): value is Error =>
      value instanceof ProviderUnavailableError ||
      value instanceof ProviderDeadlineError ||
      (value instanceof Error && value.name === 'AbortError'),
  );
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RunDeadlineRef {
  readonly deadlineMs: number;
  readonly scope?: 'run' | 'phase';
  onChange(listener: () => void): () => void;
  requestExtension?(
    request: (() => Promise<number | null | undefined>) | undefined,
  ): Promise<boolean>;
}

export class RunDeadline implements RunDeadlineRef {
  private value: number;
  private readonly listeners = new Set<() => void>();
  private extensionRequest?: Promise<boolean>;
  private declinedDeadlineMs?: number;

  constructor(deadlineMs: number) {
    if (!Number.isFinite(deadlineMs)) throw new Error('Run deadline must be finite');
    this.value = deadlineMs;
  }

  get deadlineMs(): number {
    return this.value;
  }

  readonly scope = 'run' as const;

  extend(extensionMs: number): number {
    if (!Number.isFinite(extensionMs) || extensionMs <= 0) return this.value;
    this.value += extensionMs;
    this.declinedDeadlineMs = undefined;
    for (const listener of this.listeners) listener();
    return this.value;
  }

  requestExtension(
    request: (() => Promise<number | null | undefined>) | undefined,
  ): Promise<boolean> {
    if (!request) return Promise.resolve(false);
    if (this.declinedDeadlineMs === this.value) return Promise.resolve(false);
    const requestedDeadlineMs = this.value;
    this.extensionRequest ??= request()
      .then((extensionMs) => {
        if (extensionMs == null || !Number.isFinite(extensionMs) || extensionMs <= 0) {
          if (this.value === requestedDeadlineMs) this.declinedDeadlineMs = requestedDeadlineMs;
          return false;
        }
        this.extend(extensionMs);
        return true;
      })
      .finally(() => {
        this.extensionRequest = undefined;
      });
    return this.extensionRequest;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function resolvedRunDeadline(
  ref: RunDeadlineRef | undefined,
  deadlineMs: number | undefined,
): RunDeadlineRef | undefined {
  return ref ?? (deadlineMs === undefined ? undefined : new RunDeadline(deadlineMs));
}

export function boundedRunDeadline(
  runDeadline: RunDeadlineRef | undefined,
  phaseDeadlineMs: number | undefined,
): RunDeadlineRef | undefined {
  if (!runDeadline) {
    return phaseDeadlineMs === undefined
      ? undefined
      : {
          deadlineMs: phaseDeadlineMs,
          scope: 'phase',
          onChange: () => () => {},
        };
  }
  if (phaseDeadlineMs === undefined) return runDeadline;
  return {
    get deadlineMs(): number {
      return Math.min(runDeadline.deadlineMs, phaseDeadlineMs);
    },
    get scope(): 'run' | 'phase' {
      return phaseDeadlineMs <= runDeadline.deadlineMs ? 'phase' : 'run';
    },
    onChange: (listener) => runDeadline.onChange(listener),
    requestExtension: (request) =>
      phaseDeadlineMs <= runDeadline.deadlineMs
        ? Promise.resolve(false)
        : (runDeadline.requestExtension?.(request) ?? Promise.resolve(false)),
  };
}

function effectiveDeadline(
  runDeadline: RunDeadlineRef | undefined,
  phaseDeadlineMs: number | undefined,
): { deadlineMs?: number; scope: 'run' | 'phase' } {
  const run = runDeadline?.deadlineMs;
  if (phaseDeadlineMs !== undefined && (run === undefined || phaseDeadlineMs <= run)) {
    return { deadlineMs: phaseDeadlineMs, scope: 'phase' };
  }
  return { deadlineMs: run, scope: runDeadline?.scope ?? 'run' };
}

export async function retryTransientProviderFailure<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const random = options.random ?? Math.random;
  const initialDelayMs = positive(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = positive(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const runDeadline = resolvedRunDeadline(options.runDeadline, options.deadlineMs);
  let lastTransient: ProviderReportedError | undefined;
  let attempt = 0;

  const requestExtension = async (): Promise<boolean> =>
    (await runDeadline?.requestExtension?.(options.onDeadlineReached)) ?? false;

  while (true) {
    throwIfAborted(options.signal);
    const deadline = effectiveDeadline(runDeadline, options.phaseDeadlineMs);
    if (deadline.deadlineMs !== undefined && now() >= deadline.deadlineMs) {
      if (deadline.scope === 'run' && (await requestExtension())) continue;
      if (lastTransient) throw new ProviderUnavailableError(lastTransient);
      throw new ProviderDeadlineError(deadline.deadlineMs, undefined, deadline.scope);
    }

    attempt++;
    const active = combinedDeadlineSignal(
      runDeadline,
      options.phaseDeadlineMs,
      options.signal,
      now,
      lastTransient,
      options.onDeadlineReached,
    );
    try {
      return await operation(active.signal);
    } catch (error) {
      if (options.signal?.aborted) throw abortSignalError(options.signal);
      const reported = providerReportedError(error);
      if (reported && !isTransientProviderCapacityError(reported)) throw reported;
      if (reported) lastTransient = reported;
      const activeControl = active.signal?.aborted
        ? providerControlError(active.signal.reason)
        : undefined;
      const control = activeControl ?? providerControlError(error);
      if (control instanceof ProviderUnavailableError) throw control;
      if (control instanceof ProviderDeadlineError) {
        if (control.scope === 'run' && (await requestExtension())) continue;
        if (!lastTransient) throw control;
        throw new ProviderUnavailableError(lastTransient);
      }
      if (control) throw control;
      if (!reported) throw error;
      const nextDeadline = effectiveDeadline(runDeadline, options.phaseDeadlineMs).deadlineMs;
      const remaining =
        nextDeadline === undefined ? Number.POSITIVE_INFINITY : nextDeadline - now();
      if (remaining <= 0) continue;
      const delayMs = Math.min(
        remaining,
        jitteredBackoffMs(attempt, initialDelayMs, maxDelayMs, random()),
      );
      options.onRetry?.({
        attempt,
        delayMs,
        reason: reported.interruption ?? 'capacity_or_overload',
      });
      await sleep(delayMs, options.signal);
    } finally {
      active.dispose();
    }
  }
}

export function combinedDeadlineSignal(
  runDeadline: RunDeadlineRef | undefined,
  phaseDeadlineMs: number | undefined,
  parent: AbortSignal | undefined,
  now: () => number = Date.now,
  cause?: unknown,
  onDeadlineReached?: () => Promise<number | null | undefined>,
): {
  signal?: AbortSignal;
  waitForDeadlineDecision: () => Promise<void>;
  dispose: () => void;
} {
  if (!parent && !runDeadline && phaseDeadlineMs === undefined)
    return { waitForDeadlineDecision: async () => {}, dispose: () => {} };
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(
      parent?.reason instanceof Error
        ? parent.reason
        : new DOMException('Provider call cancelled', 'AbortError'),
    );
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let deadlineDecision: Promise<void> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    const deadline = effectiveDeadline(runDeadline, phaseDeadlineMs);
    if (deadline.deadlineMs === undefined || controller.signal.aborted) return;
    timer = setTimeout(() => void reachDeadline(), Math.max(0, deadline.deadlineMs - now()));
    timer.unref?.();
  };
  const decideDeadline = async (): Promise<void> => {
    while (!disposed && !controller.signal.aborted) {
      let current = effectiveDeadline(runDeadline, phaseDeadlineMs);
      if (current.deadlineMs === undefined || now() < current.deadlineMs) {
        schedule();
        return;
      }
      if (current.scope === 'run') {
        try {
          if (await runDeadline?.requestExtension?.(onDeadlineReached)) {
            // The extension decision may have taken long enough for a later,
            // nonextendable phase boundary to expire. Re-evaluate it before
            // releasing any operation waiting on this shared decision.
            continue;
          }
        } catch (error) {
          if (!disposed && !controller.signal.aborted)
            controller.abort(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (disposed || controller.signal.aborted) return;
      current = effectiveDeadline(runDeadline, phaseDeadlineMs);
      if (current.deadlineMs === undefined || now() < current.deadlineMs) {
        schedule();
        return;
      }
      controller.abort(new ProviderDeadlineError(current.deadlineMs, cause, current.scope));
    }
  };
  const reachDeadline = (): Promise<void> => {
    if (deadlineDecision) return deadlineDecision;
    const decision = decideDeadline();
    deadlineDecision = decision;
    void decision.finally(() => {
      if (deadlineDecision === decision) deadlineDecision = undefined;
    });
    return decision;
  };
  const stopChanges = runDeadline?.onChange(schedule);
  schedule();
  return {
    signal: controller.signal,
    waitForDeadlineDecision: async () => {
      await reachDeadline();
      if (controller.signal.aborted) throw abortSignalError(controller.signal);
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      stopChanges?.();
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function jitteredBackoffMs(
  attempt: number,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  randomValue = Math.random(),
): number {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (Math.max(1, attempt) - 1));
  return Math.min(
    maxDelayMs,
    Math.max(0, Math.round(base * (0.75 + Math.min(1, Math.max(0, randomValue)) * 0.5))),
  );
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortSignalError(signal, 'Provider retry cancelled');
}
