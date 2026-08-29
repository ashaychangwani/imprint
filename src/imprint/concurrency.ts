/**
 * Bounded-concurrency fan-out helpers shared across the teach pipeline.
 *
 * Lives in its own module (rather than teach.ts) so leaf modules like
 * teach-plan.ts can reuse it without importing teach.ts, which would create an
 * import cycle (teach.ts → teach-plan.ts → teach.ts). teach.ts re-exports both
 * for backwards compatibility with existing callers + tests.
 */

/** Error thrown by withTimeout when the deadline elapses before the work settles.
 *  A distinct class lets callers tell a timeout apart from a genuine failure. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${Math.round(ms / 1000)}s timeout`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise against a timeout. The underlying work (e.g. a CLI child) is
 *  NOT cancelled — the caller just stops awaiting it and decides how to degrade.
 *  Throws TimeoutError on timeout. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return withTimeoutCleanup(work, ms, label);
}

/** Like withTimeout, but runs cleanup exactly when the deadline fires. Use this
 *  for work with external resources, such as spawned CLI providers, so timeout
 *  fallback does not leave a child process alive. Cleanup is best-effort and its
 *  errors are deliberately ignored in favor of the TimeoutError. */
export async function withTimeoutCleanup<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Preserve the timeout as the actionable failure.
      }
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function abortSignalError(signal: AbortSignal, message = 'Operation cancelled'): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(message, 'AbortError');
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortSignalError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal ? abortSignalError(signal) : new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function withAbortSignal<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await work();
  if (signal.aborted) throw abortSignalError(signal);
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      cleanup();
      reject(abortSignalError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    work().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
