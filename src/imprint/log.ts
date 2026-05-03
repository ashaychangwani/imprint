/**
 * Tiny logger factory. Every Imprint module wants `[imprint <area>] msg`
 * on stderr; this dedupes the boilerplate.
 *
 *   const log = createLog('cron');
 *   log('starting');   // → [imprint cron] starting
 */

export type Log = (msg: string) => void;

export function createLog(area: string): Log {
  const prefix = `[imprint ${area}]`;
  return (msg: string): void => {
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}
