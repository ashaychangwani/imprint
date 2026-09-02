import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { abortSignalError, abortableDelay } from './concurrency.ts';

const OWNER_ENV = 'IMPRINT_PROCESS_OWNER_TOKEN';
const DRAIN_MS = 150;
const KILL_WAIT_MS = 500;

type OwnedRow = { pid: number; pgid: number };
type RootResult = { code: number | null; error?: Error };
type OwnedChild = ChildProcess & { readonly __imprintOwnerToken?: string };

const owners = new WeakMap<ChildProcess, ProcessOwner>();
const activeOwners = new Set<ProcessOwner>();
let parentHandlersInstalled = false;
let sigintOwnerPresentAtInstall = false;
let sigintDelegated = false;

export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const token = randomBytes(24).toString('hex');
  const child = spawn(command, [...args], {
    ...options,
    detached: true,
    env: { ...process.env, ...options.env, [OWNER_ENV]: token },
  }) as OwnedChild;
  Object.defineProperty(child, '__imprintOwnerToken', { value: token });
  ownerFor(child, token);
  return child;
}

function tokenPids(token: string): OwnedRow[] {
  if (process.platform === 'linux') {
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      return [];
    }
    const rows: OwnedRow[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const env = readFileSync(`/proc/${name}/environ`);
        if (!env.includes(Buffer.from(`${OWNER_ENV}=${token}\0`))) continue;
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const afterCommand = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
        const pgid = Number(afterCommand[2]);
        if (Number.isInteger(pgid)) rows.push({ pid: Number(name), pgid });
      } catch {}
    }
    return rows;
  }

  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['eww', '-axo', 'pid=,pgid=,command='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (ps.status !== 0 || typeof ps.stdout !== 'string') return [];
    const needle = `${OWNER_ENV}=${token}`;
    return ps.stdout.split('\n').flatMap((line) => {
      if (!line.includes(needle)) return [];
      const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
      return match?.[1] && match[2] ? [{ pid: Number(match[1]), pgid: Number(match[2]) }] : [];
    });
  }

  return [];
}

function signalRows(rows: OwnedRow[], rootPid: number | undefined, signal: NodeJS.Signals): void {
  const pids = new Set(rows.map((row) => row.pid));
  const groups = new Set(rows.map((row) => row.pgid).filter((pgid) => pgid > 1));
  if (rootPid && pids.has(rootPid)) groups.add(rootPid);
  for (const pgid of groups) signalPid(-pgid, signal);
  for (const pid of pids) signalPid(pid, signal);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalRoot(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) signalPid(-child.pid, signal);
  else child.kill(signal);
}

class ProcessOwner {
  readonly root: Promise<RootResult>;
  private cleanupPromise?: Promise<void>;
  private graceMs = 5_000;
  private parentRegistered = 0;

  constructor(
    readonly child: ChildProcess,
    readonly token: string | undefined,
  ) {
    this.root =
      typeof child.exitCode === 'number' || child.signalCode != null
        ? Promise.resolve({ code: child.exitCode })
        : new Promise((resolve) => {
            let error: Error | undefined;
            child.once('error', (value) => {
              error = value;
              if (child.pid === undefined) resolve({ code: null, error });
            });
            child.once('exit', (code) => resolve({ code, error }));
          });
    void this.root.then(() => this.cleanup(false));
  }

  register(graceMs: number): void {
    this.graceMs = Math.max(0, graceMs);
    this.parentRegistered++;
    activeOwners.add(this);
    installParentHandlers();
  }

  unregister(): void {
    this.parentRegistered = Math.max(0, this.parentRegistered - 1);
    if (this.parentRegistered === 0) activeOwners.delete(this);
    removeParentHandlersIfIdle();
  }

  terminate(graceMs = this.graceMs, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.graceMs = Math.max(0, graceMs);
    if (this.cleanupPromise) {
      this.signalOwned(true, signal);
      return this.cleanupPromise;
    }
    return this.cleanup(true, signal);
  }

  cleanup(includeRoot: boolean, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.cleanupPromise ??= this.cleanupOnce(includeRoot, signal).finally(() => {
      activeOwners.delete(this);
      removeParentHandlersIfIdle();
    });
    return this.cleanupPromise;
  }

  private async cleanupOnce(includeRoot: boolean, signal: NodeJS.Signals): Promise<void> {
    let rows = this.token ? tokenPids(this.token) : [];
    const observedPids = new Set(rows.map(({ pid }) => pid));
    const rootAlive = this.child.exitCode == null && this.child.signalCode == null;
    this.signalOwned(includeRoot, signal, rows);

    const end = Date.now() + this.graceMs;
    while (rows.length > 0 && Date.now() < end) {
      await abortableDelay(Math.min(25, Math.max(1, end - Date.now())));
      rows = this.token ? tokenPids(this.token) : [];
      for (const { pid } of rows) observedPids.add(pid);
    }
    if (rows.length > 0) signalRows(rows, this.child.pid, 'SIGKILL');
    else if (
      includeRoot &&
      rootAlive &&
      this.child.exitCode == null &&
      this.child.signalCode == null
    ) {
      try {
        signalRoot(this.child, 'SIGKILL');
      } catch {}
    }

    const killEnd = Date.now() + KILL_WAIT_MS;
    while (Date.now() < killEnd) {
      const ownedRows = this.token ? tokenPids(this.token) : [];
      for (const { pid } of ownedRows) observedPids.add(pid);
      if (ownedRows.length === 0 && ![...observedPids].some(pidIsAlive)) break;
      await abortableDelay(20);
    }
  }

  private signalOwned(includeRoot: boolean, signal: NodeJS.Signals, knownRows?: OwnedRow[]): void {
    const rows = knownRows ?? (this.token ? tokenPids(this.token) : []);
    if (rows.length > 0) {
      signalRows(rows, this.child.pid, signal);
    } else if (includeRoot && this.child.exitCode == null && this.child.signalCode == null) {
      try {
        signalRoot(this.child, signal);
      } catch {}
    }
  }
}

function ownerFor(child: ChildProcess, token?: string): ProcessOwner {
  const existing = owners.get(child);
  if (existing) return existing;
  const owner = new ProcessOwner(child, token ?? (child as OwnedChild).__imprintOwnerToken);
  owners.set(child, owner);
  return owner;
}

const parentSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const parentSignalHandlers = new Map<NodeJS.Signals, () => void>();
let parentSignalInFlight = false;
let parentSignalWork: Promise<void> | undefined;
let pendingFatalSignal: 'SIGTERM' | 'SIGHUP' | undefined;
let pendingSigintDelegate: boolean | undefined;
const parentExit = (): void => {
  for (const owner of activeOwners) void owner.terminate(0);
};

function queueParentSignal(
  signal: NodeJS.Signals,
  handler: () => void,
  delegateSigint: boolean,
): void {
  if (signal === 'SIGTERM' || signal === 'SIGHUP') pendingFatalSignal = signal;
  else if (pendingSigintDelegate === undefined) pendingSigintDelegate = delegateSigint;

  const cleanup = terminateOwnedCompilerProcesses(signal);
  parentSignalWork = parentSignalWork
    ? Promise.allSettled([parentSignalWork, cleanup]).then(() => undefined)
    : cleanup;
  if (parentSignalInFlight) return;
  parentSignalInFlight = true;
  void (async () => {
    for (;;) {
      const work: Promise<void> | undefined = parentSignalWork;
      if (!work) break;
      await work;
      if (work === parentSignalWork) break;
    }
    const fatal = pendingFatalSignal;
    const delegate = pendingSigintDelegate === true;
    parentSignalWork = undefined;
    pendingFatalSignal = undefined;
    pendingSigintDelegate = undefined;
    parentSignalInFlight = false;
    if (!fatal && delegate) {
      sigintDelegated = true;
      removeParentHandlersIfIdle();
      return;
    }
    const finalSignal = fatal ?? signal;
    if (finalSignal === 'SIGTERM' || finalSignal === 'SIGHUP') {
      process.removeAllListeners(finalSignal);
    } else {
      process.removeListener(finalSignal, handler);
    }
    try {
      process.kill(process.pid, finalSignal);
    } catch {
      process.exit(finalSignal === 'SIGINT' ? 130 : finalSignal === 'SIGTERM' ? 143 : 129);
    }
  })();
}

function installParentHandlers(): void {
  if (parentHandlersInstalled) return;
  parentHandlersInstalled = true;
  sigintOwnerPresentAtInstall = process.listenerCount('SIGINT') > 0;
  sigintDelegated = false;
  process.once('exit', parentExit);
  for (const signal of parentSignals) {
    const handler = (): void => {
      const otherHandlerOwnsSignal = process
        .listeners(signal)
        .some((listener) => listener !== handler);
      const delegateSigint =
        signal === 'SIGINT' &&
        !sigintDelegated &&
        (sigintOwnerPresentAtInstall || otherHandlerOwnsSignal);
      queueParentSignal(signal, handler, delegateSigint);
    };
    parentSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeParentHandlersIfIdle(): void {
  if (!parentHandlersInstalled || activeOwners.size > 0 || parentSignalInFlight) return;
  parentHandlersInstalled = false;
  sigintOwnerPresentAtInstall = false;
  sigintDelegated = false;
  process.removeListener('exit', parentExit);
  for (const [signal, handler] of parentSignalHandlers) process.removeListener(signal, handler);
  parentSignalHandlers.clear();
}

export function terminateCompilerProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  shutdownGraceMs = 5_000,
): void {
  void ownerFor(child).terminate(shutdownGraceMs, signal);
}

export async function terminateOwnedCompilerProcesses(
  signal: NodeJS.Signals,
  shutdownGraceMs?: number,
): Promise<void> {
  await Promise.allSettled(
    [...activeOwners].map((owner) => owner.terminate(shutdownGraceMs, signal)),
  );
}

export function registerCompilerProcessCleanup(
  child: ChildProcess,
  shutdownGraceMs = 5_000,
): () => void {
  if (typeof child.exitCode === 'number' || child.signalCode != null) return () => {};
  const owner = ownerFor(child);
  owner.register(shutdownGraceMs);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    owner.unregister();
  };
}

type OwnedProcessOutput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type CollectOwnedProcessOptions = {
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  onStdoutLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
};

export async function collectOwnedProcess(
  child: ChildProcess,
  opts: CollectOwnedProcessOptions = {},
): Promise<OwnedProcessOutput> {
  const owner = ownerFor(child);
  const unregister = registerCompilerProcessCleanup(child, opts.shutdownGraceMs ?? 5_000);
  const stdout = readStream(child.stdout, opts.onStdoutChunk, opts.onStdoutLine);
  const stderr = readStream(child.stderr, opts.onStderrChunk);
  let cancelled: Error | undefined;
  const abort = (): void => {
    cancelled = opts.signal
      ? abortSignalError(opts.signal)
      : new DOMException('Aborted', 'AbortError');
    void owner.terminate(opts.shutdownGraceMs ?? 5_000);
  };
  if (opts.signal?.aborted) abort();
  else opts.signal?.addEventListener('abort', abort, { once: true });

  try {
    const root = await owner.root;
    await owner.cleanup(Boolean(cancelled));
    const drained = Promise.all([stdout, stderr]);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainTimeout = new Promise<'timeout'>((resolve) => {
      drainTimer = setTimeout(() => resolve('timeout'), DRAIN_MS);
      drainTimer.unref?.();
    });
    let drainResult: 'done' | 'timeout';
    try {
      drainResult = await Promise.race([drained.then(() => 'done' as const), drainTimeout]);
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    if (drainResult === 'timeout') {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    const [stdoutText, stderrText] = await drained;
    if (cancelled) throw cancelled;
    if (root.error) throw root.error;
    return { stdout: stdoutText, stderr: stderrText, exitCode: root.code };
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    unregister();
  }
}

async function readStream(
  stream: NodeJS.ReadableStream | null,
  onChunk?: (chunk: string) => void,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return '';
  const chunks: string[] = [];
  let pending = '';
  try {
    for await (const value of stream) {
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      chunks.push(text);
      onChunk?.(text);
      if (!onLine) continue;
      pending += text;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        onLine(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
    }
  } catch (error) {
    if (!(stream as { destroyed?: boolean }).destroyed) throw error;
  }
  if (onLine && pending) onLine(pending.replace(/\r$/, ''));
  return chunks.join('');
}

export async function runOwnedCli(opts: {
  command: string;
  args: readonly string[];
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  onStdoutLine?: (line: string) => void;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}): Promise<OwnedProcessOutput> {
  const child = spawnOwnedProcess(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(opts.input);
  return await collectOwnedProcess(child, opts);
}
