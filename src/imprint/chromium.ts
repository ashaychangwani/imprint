/** Launch real Chromium with CDP debugging open. Prefers Playwright's
 *  bundled Chromium (unmanaged) over system Chrome (corporate policy
 *  often blocks --remote-debugging-port). $CHROMIUM_PATH overrides. */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDebug } from './log.ts';

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
  /** X display for HEADED Chrome on Linux (e.g. ":0", ":99"). Defaults to
   *  `process.env.DISPLAY`; if that's also empty AND we're launching headed on
   *  Linux, a virtual framebuffer (Xvfb) is started automatically and torn down
   *  on close(). Ignored on macOS/Windows (they use the native window server)
   *  and for headless launches (which need no display). */
  display?: string;
  /** Upstream proxy for ALL of this Chrome's traffic, e.g.
   *  "http://host:port" or "socks5://host:port". Use to egress the trusted
   *  bootstrap + in-page requests through a RESIDENTIAL IP — Akamai (and most
   *  bot defenses) heavily penalize datacenter/cloud egress, so minting a
   *  high-trust `_abck` from an AWS/GCP box needs a residential proxy here.
   *  Defaults to `proxyUrl()` (IMPRINT_PROXY env). Note: Chrome's
   *  `--proxy-server` takes no inline credentials; use an IP-authed proxy or a
   *  scheme://host:port URL (auth is handled separately if needed). */
  proxy?: string;
}

/** The configured upstream proxy (IMPRINT_PROXY), or undefined. Centralized so
 *  the browser launch and every plain-fetch replay path egress through the SAME
 *  IP — otherwise a jar minted via the proxy would be replayed from the box's
 *  (datacenter) IP and Akamai would drop it on the mismatch. */
export function proxyUrl(): string | undefined {
  const p = process.env.IMPRINT_PROXY?.trim();
  return p && p.length > 0 ? p : undefined;
}

/** Strip inline credentials for Chrome's `--proxy-server` (which rejects them),
 *  keeping scheme://host:port. Returns null if unparseable. */
export function chromeProxyArg(proxy: string): string | null {
  if (proxy.includes('://')) {
    try {
      const u = new URL(proxy);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }
  // Plain host:port (new URL would misparse the host as a scheme).
  return /^[\w.-]+:\d+$/.test(proxy) ? proxy : null;
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
      'Fix:',
      '  bunx playwright install chromium    # installs an unmanaged Chromium',
      '  export CHROMIUM_PATH=/path/to/chromium    # explicit override',
      '',
      'Or run `imprint doctor` to see exactly which prerequisites are missing.',
      '',
      'On corporate-managed devices the system Chrome usually has a policy that',
      "disallows `--remote-debugging-port`. Playwright's bundled Chromium isn't",
      'managed and is the recommended path.',
    ].join('\n'),
  );
}

interface XvfbHandle {
  display: string;
  close(): Promise<void>;
}

const XVFB_HINT =
  'The trusted-browser replay needs a display. Install Xvfb (Debian/Ubuntu: ' +
  '`apt-get install xvfb`), or run with an existing display: `DISPLAY=:0 imprint …`. ' +
  'Run `imprint doctor` to check.';

function xvfbErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ENOENT') return `Xvfb not found on PATH.\n${XVFB_HINT}`;
  return `Failed to start Xvfb: ${err instanceof Error ? err.message : String(err)}\n${XVFB_HINT}`;
}

/**
 * Spawn a virtual X framebuffer so HEADED Chrome can run on a Linux server with
 * no physical display. Headed real Chrome (not `--headless`) is the only config
 * some behavioral anti-bot services trust — it has a real GPU/compositor and
 * real window geometry, none of which a headless build exposes. Xvfb is
 * transparent to Chrome: same window + GPU code path, just no monitor. Picks a
 * free `:NN` display, waits for its socket, and returns a teardown handle.
 */
async function startXvfb(): Promise<XvfbHandle> {
  // Pick a display number whose socket doesn't already exist.
  let displayNum = 99;
  for (; displayNum < 120; displayNum++) {
    if (!existsSync(`/tmp/.X11-unix/X${displayNum}`)) break;
  }
  const display = `:${displayNum}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', isDebug() ? 'pipe' : 'ignore'],
    detached: false,
  });
  let spawnError: unknown;
  proc.on('error', (err) => {
    spawnError = err;
  });
  if (isDebug()) proc.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  const teardown = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => proc.once('exit', () => resolve())),
        sleep(1000),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  };

  // Wait for the X socket to appear (or the process to fail).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(xvfbErrorMessage(spawnError));
    if (proc.exitCode !== null) {
      throw new Error(
        `Xvfb exited early (code ${proc.exitCode}) — could not start a virtual display.\n${XVFB_HINT}`,
      );
    }
    if (existsSync(`/tmp/.X11-unix/X${displayNum}`)) {
      return { display, close: teardown };
    }
    await sleep(100);
  }
  await teardown();
  throw new Error(`Xvfb did not create display ${display} within 5s.\n${XVFB_HINT}`);
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
    '--use-mock-keychain',
  ];
  if (opts.headless) args.push('--headless=new');
  const proxy = opts.proxy ?? proxyUrl();
  if (proxy) {
    const arg = chromeProxyArg(proxy);
    if (arg) {
      args.push(`--proxy-server=${arg}`);
      // Route ALL hosts through the proxy (don't let Chrome bypass any) so the
      // egress IP is uniform; without this Chrome may direct-connect some hosts.
      args.push('--proxy-bypass-list=<-loopback>');
    }
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(opts.url ?? 'about:blank');

  // Resolve a display for HEADED Chrome. macOS/Windows use the native window
  // server, so DISPLAY is meaningless there — this only applies on Linux. An
  // existing physical/forwarded display ($DISPLAY, or an explicit opts.display)
  // is used as-is; on a headless Linux server with none, spin up a virtual
  // framebuffer so the trusted headed-Chrome replay still works. A headless
  // launch needs no display.
  let xvfb: XvfbHandle | undefined;
  let display = opts.display ?? process.env.DISPLAY;
  if (process.platform === 'linux' && !opts.headless && !display) {
    xvfb = await startXvfb();
    display = xvfb.display;
  }

  const child = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
    env: display ? { ...process.env, DISPLAY: display } : process.env,
  });

  // Chromium is noisy — only surface stderr under IMPRINT_DEBUG.
  if (isDebug()) {
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
    // Tear down the virtual display we started for this launch (if any).
    await xvfb?.close().catch(() => {});
  };

  return { process: child, port, userDataDir, ready, close };
}
