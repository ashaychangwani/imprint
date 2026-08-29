/**
 * Retry only provider-side capacity failures.
 *
 * This module deliberately knows nothing about teaching strategy or artifacts.
 * It keeps one logical LLM operation alive while a provider is temporarily busy,
 * and leaves deterministic failures for the caller to handle immediately.
 */

export interface ProviderRetryEvent {
  /** Number of provider calls already made. */
  attempt: number;
  /** Delay before the next call. */
  delayMs: number;
  reason: 'capacity_or_overload';
}

export interface ProviderRetryOptions {
  /** Existing run/invocation deadline. Omit to keep retrying until cancellation. */
  deadlineMs?: number;
  signal?: AbortSignal;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Test seam for deterministic jitter. Must return a value in [0, 1]. */
  random?: () => number;
  /** Test seam for deterministic deadline checks. */
  now?: () => number;
  /** Test seam for fast sleeps. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (event: ProviderRetryEvent) => void;
  /** Preserve callers that already allow a user-approved deadline extension. */
  onDeadlineReached?: () => Promise<number | null | undefined>;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Returns true only for recognizable provider capacity/overload failures.
 * Authentication, authorization, schema, and invalid-request failures win over
 * transient-looking words so a malformed request never enters a retry loop.
 */
export function isTransientProviderCapacityError(error: unknown): boolean {
  const facts = collectErrorFacts(error);

  if (
    facts.statuses.some((status) => [400, 401, 403, 404, 405, 409, 422].includes(status)) ||
    facts.codes.some((code) =>
      /^(?:authentication|authorization|invalid_request|bad_request|input_too_large|subscription_access_disabled)$/i.test(
        code,
      ),
    ) ||
    /\b(?:invalid api key|authentication failed|not authenticated|unauthorized|forbidden|authorization failed|permission denied|access denied|invalid[_ -]?request|bad request|schema (?:error|validation|failed)|input[_ -]?(?:is )?too[_ -]?large|subscription access|usage policy|content policy|insufficient quota|billing|credit balance)\b/i.test(
      facts.text,
    )
  ) {
    return false;
  }

  if (facts.statuses.some((status) => status === 429 || status === 503 || status === 529)) {
    return true;
  }

  if (
    facts.codes.some((code) =>
      /^(?:rate_limited|rate_limit_exceeded|overloaded|overloaded_error|server_overloaded|resource_exhausted|temporarily_unavailable|service_unavailable)$/i.test(
        code,
      ),
    )
  ) {
    return true;
  }

  return /(?:\b429\b|\b503\b|\b529\b|too many requests|rate[_ -]?limit(?:ed| exceeded)?|you['’]?ve hit your usage limit|usage limit[^\n]*(?:reset|try again)|(?:provider|service|server|model|api) (?:is )?(?:temporarily )?(?:overloaded|over capacity|at capacity|busy|unavailable)|capacity (?:limit|exhausted|temporarily unavailable)|resource exhausted|try again later)/i.test(
    facts.text,
  );
}

/**
 * Retry a provider call with capped exponential backoff and bounded jitter.
 * There is intentionally no attempt cap: recovery, cancellation, or the
 * caller's existing deadline are the only terminal conditions.
 */
export async function retryTransientProviderFailure<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithSignal;
  const random = options.random ?? Math.random;
  const initialDelayMs = positiveFinite(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = positiveFinite(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  let deadlineMs = options.deadlineMs;
  let lastTransientError: unknown;
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);
    if (lastTransientError !== undefined && deadlineMs !== undefined && now() >= deadlineMs) {
      const extensionMs = await options.onDeadlineReached?.();
      if (extensionMs != null && Number.isFinite(extensionMs) && extensionMs > 0) {
        deadlineMs += extensionMs;
      } else {
        throw lastTransientError;
      }
    }
    attempt++;

    try {
      return await operation();
    } catch (error) {
      if (!isTransientProviderCapacityError(error)) throw error;
      lastTransientError = error;
      throwIfAborted(options.signal);

      const remainingMs =
        deadlineMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineMs - now());
      if (remainingMs <= 0) continue;

      const delayMs = Math.min(
        remainingMs,
        jitteredBackoffMs(attempt, initialDelayMs, maxDelayMs, random()),
      );
      options.onRetry?.({ attempt, delayMs, reason: 'capacity_or_overload' });
      await sleep(delayMs, options.signal);
    }
  }
}

export function jitteredBackoffMs(
  attempt: number,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  randomValue = Math.random(),
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (safeAttempt - 1));
  // 75%-125% jitter, capped again so maxDelayMs remains a true upper bound.
  const jitter = 0.75 + Math.min(1, Math.max(0, randomValue)) * 0.5;
  return Math.min(maxDelayMs, Math.max(0, Math.round(base * jitter)));
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Provider retry cancelled', 'AbortError');
}

async function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function collectErrorFacts(error: unknown): {
  text: string;
  statuses: number[];
  codes: string[];
} {
  const text: string[] = [];
  const statuses: number[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      text.push(current.name, current.message);
    } else if (typeof current === 'string') {
      text.push(current);
    }

    if (typeof current !== 'object') break;
    const value = current as Record<string, unknown>;
    for (const key of ['status', 'statusCode']) {
      const status = Number(value[key]);
      if (Number.isInteger(status)) statuses.push(status);
    }
    const response = value.response;
    if (response && typeof response === 'object') {
      const status = Number((response as Record<string, unknown>).status);
      if (Number.isInteger(status)) statuses.push(status);
    }
    for (const key of ['code', 'errorCode', 'type']) {
      const code = value[key];
      if (typeof code === 'string') codes.push(code);
    }
    current = value.cause;
  }

  return { text: text.join('\n'), statuses, codes };
}
