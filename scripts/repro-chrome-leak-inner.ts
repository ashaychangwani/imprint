/**
 * Inner repro process for the orphaned-Chrome leak.
 *
 * Launches Chrome via the same `launchChromium` the compile cdp pool uses,
 * schedules cleanup on a 15s idle timer WITHOUT awaiting it (mirroring
 * backend-ladder's `armCompileCdpIdleClose`), then `process.exit(0)` — which
 * reproduces the exact condition the compile verifier creates: the process
 * ends before the idle timer can fire, leaving the Chrome child running and
 * orphaned in this process's group.
 *
 * In production the verifier is `bun test`, which calls process.exit() on suite
 * completion and (confirmed by diagnostic) runs NO 'exit'/'beforeExit' handlers
 * — only afterAll. The runCommand fix doesn't depend on how the child exits: it
 * reaps the child's whole process group after close, so this plain process.exit
 * is a faithful stand-in for the verifier's force-exit.
 *
 * Run via repro-chrome-leak.ts (which invokes this through the real runCommand).
 */
import { appendFileSync } from 'node:fs';
import { launchChromium } from '../src/imprint/chromium.ts';

const c = await launchChromium({ headless: true });
await c.ready.catch(() => {});

const pidfile = process.env.REPRO_PIDFILE;
if (pidfile) appendFileSync(pidfile, `${c.process.pid}\n`);

// Mirror Fix B's cleanup strategy: schedule the close on an idle timer, do NOT
// await it. The process exits below before the timer fires.
setTimeout(() => void c.close(), 15_000);

// Force-exit (the verifier's behavior). Chrome is left orphaned in this group.
process.exit(0);
