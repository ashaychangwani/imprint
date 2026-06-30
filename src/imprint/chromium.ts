/** Launch real Chromium with CDP debugging open. Prefers Playwright's
 *  bundled Chromium (unmanaged) over system Chrome (corporate policy
 *  often blocks --remote-debugging-port). $CHROMIUM_PATH overrides. */

import { type ChildProcess, spawnSync as nodeSpawnSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDebug } from './log.ts';

/** Track launched Chrome PIDs so we can kill survivors on process exit. Set on
 *  spawn, removed on clean close. Any PIDs left when the process exits are
 *  SIGKILLed — the leak-prevention backstop for probe subprocesses that call
 *  process.exit(0) before a pool's idle-close timer fires. Lives here (the
 *  Chrome-launch module, a dependency leaf) rather than in backend-ladder so the
 *  ladder→cdp-browser-fetch import does not form a cycle. */
const chromeProcessPids = new Set<number>();

/** Register a Chrome PID for exit-time cleanup. Called on launch. */
export function __registerChromePid(pid: number): void {
  chromeProcessPids.add(pid);
}

/** Unregister a Chrome PID after clean close. */
export function __unregisterChromePid(pid: number): void {
  chromeProcessPids.delete(pid);
}

/** Kill all tracked Chrome PIDs on process exit. The 'exit' event DOES fire on
 *  process.exit(0) (unlike beforeExit), but handlers cannot be async — just
 *  SIGKILL the tracked PIDs synchronously and let the OS reap them. Harmless
 *  when a PID is already dead (ESRCH). Does NOT fire under `bun test` force-exit
 *  (that skips process event handlers), but the verifier's runCommand
 *  process-group reap covers that path. */
process.on('exit', () => {
  for (const pid of chromeProcessPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead or not owned by this process — ignore.
    }
  }
});

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

export function shouldDisableChromiumSandbox(): boolean {
  const override = process.env.IMPRINT_CHROMIUM_NO_SANDBOX?.trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'yes') return true;
  if (override === '0' || override === 'false' || override === 'no') return false;
  return process.platform === 'linux' && existsSync('/.dockerenv');
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
const require = createRequire(import.meta.url);

export function defaultPlaywrightBrowsersPath(): string | undefined {
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) return pathJoin(hermesHome, '.cache', 'ms-playwright');
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (explicit) return explicit;
  return undefined;
}

function playwrightInstallEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const browsersPath = defaultPlaywrightBrowsersPath();
  if (browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return env;
}

function playwrightChromiumCacheRoots(): string[] {
  const roots = [
    defaultPlaywrightBrowsersPath(),
    pathJoin(homedir(), 'Library/Caches/ms-playwright'),
    pathJoin(homedir(), '.cache/ms-playwright'),
  ].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}

/** Find Playwright's "Google Chrome for Testing" — newest version wins
 *  if multiple are installed. */
function findPlaywrightChromium(): string | null {
  const cacheRoots = playwrightChromiumCacheRoots();
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
        pathJoin(root, dir, 'chrome-linux64', 'chrome'),
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

function playwrightInstallCommand(): string[] {
  const playwrightCli = resolvePlaywrightCli();
  if (playwrightCli) return ['node', playwrightCli, 'install', 'chromium'];
  if (process.versions.bun) return [process.execPath, 'x', 'playwright', 'install', 'chromium'];
  return ['bunx', 'playwright', 'install', 'chromium'];
}

function resolvePlaywrightCli(): string | null {
  try {
    const packageJson = require.resolve('playwright/package.json');
    const cli = pathJoin(pathDirname(packageJson), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandText(command: string[], env: NodeJS.ProcessEnv): string {
  const prefix = env.PLAYWRIGHT_BROWSERS_PATH
    ? `PLAYWRIGHT_BROWSERS_PATH=${quoteShellArg(env.PLAYWRIGHT_BROWSERS_PATH)} `
    : '';
  return `${prefix}${command.map(quoteShellArg).join(' ')}`;
}

interface InstallerResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: string;
  timedOut?: boolean;
  timeoutMs?: number;
  logPath?: string;
}

type ChromiumInstaller = (command: string[], env: NodeJS.ProcessEnv) => InstallerResult;

let chromiumInstallerForTest: ChromiumInstaller | null = null;
let chromiumFinderForTest: (() => string | null) | null = null;
let verifiedChromiumPath: string | null = null;

export function __setPlaywrightChromiumInstallerForTest(installer: ChromiumInstaller | null): void {
  chromiumInstallerForTest = installer;
}

export function __setChromiumFinderForTest(finder: (() => string | null) | null): void {
  chromiumFinderForTest = finder;
  verifiedChromiumPath = null;
}

function runPlaywrightChromiumInstall(command: string[], env: NodeJS.ProcessEnv): InstallerResult {
  if (chromiumInstallerForTest) return chromiumInstallerForTest(command, env);
  const timeoutMs = playwrightInstallTimeoutMs();
  const logPath = pathJoin(tmpdir(), `imprint-playwright-install-${process.pid}-${Date.now()}.log`);
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'w');
    const result = nodeSpawnSync(command[0] ?? '', command.slice(1), {
      env,
      // Playwright emits frequent progress lines. Send them to a file so parent
      // command runners that capture stderr without draining it cannot block.
      stdio: ['ignore', logFd, logFd],
      timeout: timeoutMs,
    });
    const failed = result.status !== 0 || Boolean(result.error);
    if (!failed) unlinkInstallerLog(logPath);
    return formatSpawnResult(
      result,
      timeoutMs,
      failed ? readInstallerLog(logPath) : undefined,
      logPath,
    );
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

function formatSpawnResult(
  result: ReturnType<typeof nodeSpawnSync>,
  timeoutMs: number,
  output: string | undefined,
  logPath: string,
): InstallerResult {
  const error = result.error as (Error & { code?: string }) | undefined;
  return {
    exitCode: result.status,
    stderr: output,
    signal: result.signal,
    error: error?.message,
    timedOut: error?.code === 'ETIMEDOUT',
    timeoutMs,
    logPath,
  };
}

function readInstallerLog(logPath: string): string | undefined {
  try {
    const output = readFileSync(logPath, 'utf8').trim();
    const maxChars = 50_000;
    if (output.length <= maxChars) return output;
    return `[last ${maxChars} chars of ${logPath}]\n${output.slice(-maxChars)}`;
  } catch {
    return undefined;
  }
}

function unlinkInstallerLog(logPath: string): void {
  try {
    unlinkSync(logPath);
  } catch {
    // best effort cleanup
  }
}

function playwrightInstallTimeoutMs(): number {
  const raw = process.env.IMPRINT_PLAYWRIGHT_INSTALL_TIMEOUT_MS?.trim();
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

function formatInstallerFailure(result: InstallerResult): string | undefined {
  const lines: string[] = [];
  if (result.timedOut) {
    lines.push(`Timed out after ${Math.round((result.timeoutMs ?? 0) / 1000)}s.`);
  }
  if (result.signal) lines.push(`Terminated by signal: ${result.signal}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  if (output) lines.push(`Output:\n${output}`);
  else if (result.logPath) lines.push(`Installer log: ${result.logPath}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

interface EnsureChromiumResult {
  path: string;
  installed: boolean;
  command?: string;
}

function verifyChromiumExecutable(path: string): void {
  if (verifiedChromiumPath === path) return;
  const result = Bun.spawnSync([path, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode === 0) {
    verifiedChromiumPath = path;
    return;
  }
  const output = `${result.stderr.toString()}\n${result.stdout.toString()}`.trim();
  throw new Error(
    [
      `Chromium was found at ${path}, but it could not start.`,
      output ? `Output:\n${output}` : undefined,
      process.platform === 'linux'
        ? 'Install missing Linux browser libraries with: bunx playwright install --with-deps chromium'
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
  );
}

export function ensurePlaywrightChromiumInstalled(
  opts: {
    log?: (message: string) => void;
  } = {},
): EnsureChromiumResult {
  let existingPath: string | null = null;
  try {
    existingPath = findChromium();
  } catch {
    // Install below.
  }
  if (existingPath) {
    verifyChromiumExecutable(existingPath);
    return { path: existingPath, installed: false };
  }

  const env = playwrightInstallEnv();
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const command = playwrightInstallCommand();
  const displayCommand = commandText(command, env);
  opts.log?.(`Chromium not found; installing Playwright Chromium with: ${displayCommand}`);
  const result = runPlaywrightChromiumInstall(command, env);
  if (result.exitCode !== 0 || result.error) {
    const failure = formatInstallerFailure(result);
    throw new Error(
      [
        'Could not install Playwright Chromium automatically.',
        `Command: ${displayCommand}`,
        failure,
        '',
        'Retry manually with the command above.',
        process.platform === 'linux'
          ? 'If Chromium is installed but cannot launch in a fresh Linux image, install OS browser libraries with: bunx playwright install --with-deps chromium'
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
    );
  }

  try {
    const path = findChromium();
    verifyChromiumExecutable(path);
    return { path, installed: true, command: displayCommand };
  } catch (err) {
    throw new Error(
      [
        'Playwright Chromium install completed, but Imprint still could not locate or start the Chromium binary.',
        `Command: ${displayCommand}`,
        err instanceof Error ? err.message : String(err),
      ].join('\n'),
    );
  }
}

export function findChromium(): string {
  if (chromiumFinderForTest) {
    const path = chromiumFinderForTest();
    if (path) return path;
    throw new Error('Could not locate Chromium.');
  }

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
  const exe = ensurePlaywrightChromiumInstalled({
    log: (message) => process.stderr.write(`[imprint] ${message}\n`),
  }).path;
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
  if (shouldDisableChromiumSandbox()) args.push('--no-sandbox');
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
