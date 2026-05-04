/** Logger factory: `createLog('cron')('hi')` → stderr `[imprint cron] hi`. */

export type Log = (msg: string) => void;

export function createLog(area: string): Log {
  const prefix = `[imprint ${area}]`;
  return (msg: string): void => {
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}
