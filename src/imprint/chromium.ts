/**
 * Launch a real Chromium with the CDP debugging port open.
 *
 * On macOS we default to Google Chrome at the standard /Applications path.
 * Override with $CHROMIUM_PATH if you've installed Chromium / Edge / Brave
 * elsewhere.
 *
 * The launched process is a foreground child — we wire SIGINT/SIGTERM to it
 * so Ctrl+C in the recording terminal actually closes the browser.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LaunchOptions {
  /** CDP port. If omitted, picks a free ephemeral port. */
  port?: number;
  /** Initial URL to open. Defaults to about:blank. */
  url?: string;
  /** Launch headless. Default false (recording = visible browser the user drives). */
  headless?: boolean;
  /** Extra Chromium flags (advanced). */
  extraArgs?: string[];
}

export interface LaunchedChromium {
  process: ChildProcess;
  port: number;
  userDataDir: string;
  /** Resolves once Chromium is accepting CDP connections, or rejects after timeout. */
  ready: Promise<void>;
  close(): Promise<void>;
}

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChromium(): string {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  if (process.platform === 'darwin' && existsSync(MAC_CHROME)) return MAC_CHROME;
  if (process.platform === 'linux') {
    for (const candidate of LINUX_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    'Could not locate Chromium. Set $CHROMIUM_PATH or install Chrome at the standard path.',
  );
}

export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine assigned port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(
    `Chromium did not open CDP on port ${port} within ${timeoutMs}ms (${String(lastError)})`,
  );
}

export async function launchChromium(opts: LaunchOptions = {}): Promise<LaunchedChromium> {
  const exe = findChromium();
  const port = opts.port ?? (await pickFreePort());
  const userDataDir = pathJoin(tmpdir(), `imprint-chrome-${Date.now()}-${process.pid}`);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-popup-blocking',
  ];
  if (opts.headless) args.push('--headless=new');
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(opts.url ?? 'about:blank');

  const child = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });

  // Forward stderr in debug mode only — Chromium is noisy.
  if (process.env.IMPRINT_DEBUG) {
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  }

  const ready = waitForCdp(port);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      // Give it a moment to exit cleanly, then SIGKILL.
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(2000),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  return { process: child, port, userDataDir, ready, close };
}
