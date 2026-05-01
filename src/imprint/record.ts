/**
 * `imprint record` — capture a teaching session.
 *
 * Spawns a real Chromium with `--remote-debugging-port`, connects via the
 * Chrome DevTools Protocol (CDP), and streams every network request, DOM
 * mutation, and user narration to a JSONL session file.
 *
 * The user does their workflow in the visible browser window. A terminal
 * prompt periodically asks "what are you doing now?" and merges the answer
 * into the session timeline. Ctrl+C stops the recording cleanly.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import type { CapturedEvent, CapturedRequest, Narration, Session } from './types.ts';

// Day 1 stub: the actual implementation lands here over days 1-2.
// The exported signature is locked so cli.ts can call it.

export interface RecordOptions {
  /** Site label, e.g. "southwest". Determines output path. */
  site: string;
  /** Starting URL. Defaults to a per-site map (TBD) or asks at runtime. */
  url?: string;
  /** Output path for session.json. Defaults to examples/<site>/sessions/<timestamp>.json */
  outPath?: string;
  /** Chromium debugging port. Defaults to a random free port. */
  port?: number;
}

const VERSION = '0.1.0';

export async function record(opts: RecordOptions): Promise<void> {
  // Day 1 stub. Wires up the call path so the CLI verb works end-to-end.
  // Real CDP integration lands next.
  console.log(`[imprint] record stub: site=${opts.site} url=${opts.url ?? '(prompt)'}`);
  console.log('[imprint] day 1 work: CDP wiring + session.json streaming lands here.');
  console.log('[imprint] day 2 work: narration loop merges into the same file.');

  // Touch unused imports so tsc/biome see them as live for day-1 PR.
  void spawn;
  void createInterface;
  void createWriteStream;
  void mkdirSync;
  void existsSync;
  void dirname;
  void pathResolve;
  void sleep;
  void CDP;
  void VERSION;

  // Surface types for downstream consumers without using them yet.
  const _shapes: { req?: CapturedRequest; ev?: CapturedEvent; nar?: Narration; sess?: Session } =
    {};
  void _shapes;
}

// Internal helpers (will be filled in during day 1-2):
//
//   launchChromium(port: number): ChildProcess
//   attachCDP(port: number): Promise<CDP.Client>
//   subscribeNetwork(client, sink): Disposable
//   subscribeDom(client, sink): Disposable
//   startNarrationLoop(sink): Disposable
//   sessionWriter(path): { write(record): void; close(): Promise<void> }
//
// Each subscriber emits onto a single SessionWriter that streams JSONL to
// disk so a Ctrl+C mid-recording still leaves a valid file.

// Mark unused but imported types so the stub typechecks under noUnusedParameters.
void ({} as ChildProcess);
