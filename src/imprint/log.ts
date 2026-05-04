/** Logger factory + env-flag helpers.
 *
 *  createLog('cron')('hi') → stderr `[imprint cron] hi`.
 *
 *  Suppressed entirely when IMPRINT_QUIET=1 (set by `imprint cron --quiet`
 *  for OS-scheduler-friendly silent runs). Errors should not flow through
 *  this; they should go to stderr via console.error or process.stderr.write
 *  directly so they survive --quiet.
 *
 *  IMPRINT_DEBUG=1 enables verbose tracing in record.ts / chromium.ts.
 *  Both flags check the literal '1' value (not truthy coercion) so
 *  IMPRINT_DEBUG=0 actually disables, as the user expects. */

type Log = (msg: string) => void;

const isQuiet = (): boolean => process.env.IMPRINT_QUIET === '1';
export const isDebug = (): boolean => process.env.IMPRINT_DEBUG === '1';

export function createLog(area: string): Log {
  const prefix = `[imprint ${area}]`;
  return (msg: string): void => {
    if (isQuiet()) return;
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}
