/**
 * Bounded-concurrency fan-out helpers shared across the teach pipeline.
 *
 * Lives in its own module (rather than teach.ts) so leaf modules like
 * teach-plan.ts can reuse it without importing teach.ts, which would create an
 * import cycle (teach.ts → teach-plan.ts → teach.ts). teach.ts re-exports both
 * for backwards compatibility with existing callers + tests.
 */

/** Run `fn` over `items` with at most `concurrency` in flight, preserving input
 *  order in the result. Throws the first error encountered (after in-flight work
 *  settles); use mapLimitSettled when you need per-item success/failure. */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && firstError === undefined) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await fn(item);
      } catch (err) {
        firstError ??= err;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** Like mapLimit, but never throws: each item resolves to a tagged
 *  success/failure entry, preserving input order. */
export async function mapLimitSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<SettledResult<R>[]> {
  const results = new Array<SettledResult<R>>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { ok: true, value: await fn(item) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
