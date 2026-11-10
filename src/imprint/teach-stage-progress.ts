/** Keep long agent stages visible without changing their execution or deadline. */
export async function withTeachStageProgress<T>(
  options: {
    label: string;
    report?: (message: string) => void;
    intervalMs?: number;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (!options.report) return await work();
  const startedAt = performance.now();
  const elapsed = (): string => {
    const seconds = Math.floor((performance.now() - startedAt) / 1_000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const report = (message: string): void => {
    try {
      options.report?.(message);
    } catch {
      // A diagnostic callback must not interrupt work or replace its error.
    }
  };
  report(`${options.label} started`);
  const timer = setInterval(
    () => report(`${options.label} pending (${elapsed()} elapsed)`),
    options.intervalMs ?? 30_000,
  );
  timer.unref();
  let completed = false;
  try {
    const result = await work();
    completed = true;
    return result;
  } finally {
    clearInterval(timer);
    report(`${options.label} ${completed ? 'finished' : 'stopped'} (${elapsed()} elapsed)`);
  }
}
