/** Logger factory: `createLog('cron')('hi')` → stderr `[imprint cron] hi`.
 *  Suppressed entirely when `IMPRINT_QUIET=1` (set by `imprint cron --quiet`
 *  for OS-scheduler-friendly silent runs). Errors should not flow through
 *  this; they should go to stderr via `console.error` directly. */

type Log = (msg: string) => void;

export function createLog(area: string): Log {
  const prefix = `[imprint ${area}]`;
  return (msg: string): void => {
    if (process.env.IMPRINT_QUIET === '1') return;
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}
