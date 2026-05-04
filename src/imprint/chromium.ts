/** Launch real Chromium with CDP debugging open. Prefers Playwright's
 *  bundled Chromium (unmanaged) over system Chrome (corporate policy
 *  often blocks --remote-debugging-port). $CHROMIUM_PATH overrides. */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

interface LaunchOptions {
  /** CDP port. If omitted, picks a free ephemeral port. */
  port?: number;
  /** Initial URL to open. Defaults to about:blank. */
  url?: string;
  /** Launch headless. Default false (recording = visible browser the user drives). */
  headless?: boolean;
  /** Persist cookies + login by passing an explicit path; otherwise a throwaway tmp dir. */
  userDataDir?: string;
  /** Extra Chromium flags (advanced). */
  extraArgs?: string[];
}

interface LaunchedChromium {
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

/** Find Playwright's "Google Chrome for Testing" — newest version wins
 *  if multiple are installed. */
function findPlaywrightChromium(): string | null {
  const cacheRoots = [
    pathJoin(homedir(), 'Library/Caches/ms-playwright'),
    pathJoin(homedir(), '.cache/ms-playwright'),
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => {
          const an = Number.parseInt(a.split('-')[1] ?? '0', 10);
          const bn = Number.parseInt(b.split('-')[1] ?? '0', 10);
          return bn - an; // newest first
        });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const candidates = [
        // macOS arm64 layout
        pathJoin(
          root,
          dir,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        // macOS x64 layout
        pathJoin(
          root,
          dir,
          'chrome-mac',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        // Linux layout
        pathJoin(root, dir, 'chrome-linux', 'chrome'),
      ];
      for (const c of candidates) {
        try {
          if (existsSync(c) && statSync(c).isFile()) return c;
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

export function findChromium(): string {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  // Prefer Playwright's bundled Chromium — never blocked by corporate policy.
  const pw = findPlaywrightChromium();
  if (pw) return pw;

  if (process.platform === 'darwin' && existsSync(MAC_CHROME)) return MAC_CHROME;
  if (process.platform === 'linux') {
    for (const candidate of LINUX_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    [
      'Could not locate Chromium.',
      '',
      'Try one of:',
      '  bunx playwright install chromium    # installs an unmanaged Chromium',
      '  export CHROMIUM_PATH=/path/to/chromium    # explicit override',
      '',
      'On corporate-managed devices, the system Chrome usually has a policy that',
      "disallows `--remote-debugging-port`. Playwright's bundled Chromium does NOT",
      'pick up those policies and is the recommended path.',
    ].join('\n'),
  );
}

async function pickFreePort(): Promise<number> {
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
  const userDataDir =
    opts.userDataDir ?? pathJoin(tmpdir(), `imprint-chrome-${Date.now()}-${process.pid}`);

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

  // Chromium is noisy — only surface stderr under IMPRINT_DEBUG.
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
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(2000),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  return { process: child, port, userDataDir, ready, close };
}
