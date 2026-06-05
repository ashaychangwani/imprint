/**
 * Drives the Chrome-leak reproduction THROUGH the real `runCommand` — the exact
 * path the compile verifier uses (detached process group + close-time reap).
 * scripts/repro-chrome-leak.sh runs this, then checks whether the Chrome PID
 * recorded by the inner `bun test` survived.
 */
import { writeFileSync } from 'node:fs';
import { runCommand } from '../src/imprint/compile-tools.ts';

const pidfile = process.env.REPRO_PIDFILE ?? '/tmp/repro-chrome-pids.txt';
writeFileSync(pidfile, '');

const r = await runCommand('bun run scripts/repro-chrome-leak-inner.ts', process.cwd(), 60_000, {
  REPRO_PIDFILE: pidfile,
});
const parsed = JSON.parse(r.result) as { exitCode: number; timedOut: boolean };
console.log(`runCommand done: exitCode=${parsed.exitCode} timedOut=${parsed.timedOut}`);
