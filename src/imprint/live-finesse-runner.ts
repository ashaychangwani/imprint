import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join as pathJoin } from 'node:path';
import type { LiveIntegrationEvidence } from './compile-verification.ts';
import { LIVE_VERIFICATION_EVIDENCE_FILE, runLiveSemanticVerification } from './live-verifier.ts';
import type { ProviderName } from './llm.ts';
import type { RunDeadlineRef } from './provider-retry.ts';

const LIVE_VERIFICATION_REPORT_FILE = '.live-verification.json';
const LIVE_VERIFIER_LOG_FILE = '.live-verifier-log.jsonl';
const ISOLATED_SITE_ROOT_FILES = new Set([
  '.build-plan.json',
  '.cdp-jar.json',
  'bun.lock',
  'package.json',
]);
const OMITTED_DIRECTORY_NAMES = new Set(['.teach-runs', 'node_modules']);
const OMITTED_FILE_PREFIXES = [
  '.claude-',
  '.codex-',
  '.compile-',
  '.live-verification',
  '.live-verifier-',
];

/** Full semantic finesse uses a browser session and intentionally runs one tool
 * at a time. MVP compilation and downstream dependency work remain separate. */
export const LIVE_FINESSE_CONCURRENCY = 1;

type LiveFinesseReport = Awaited<ReturnType<typeof runLiveSemanticVerification>>['report'];

interface LiveFinesseArtifactSnapshot {
  reportJson?: string;
  evidenceJson?: string;
  logJsonl?: string;
}

interface LiveFinesseResult {
  status: 'completed' | 'inconclusive' | 'cancelled';
  provider: ProviderName;
  model?: string;
  attempts: number;
  completedReview: boolean;
  report?: LiveFinesseReport;
  artifacts: LiveFinesseArtifactSnapshot;
  message: string;
  durationMs: number;
}

interface LiveFinesseOptions {
  provider: ProviderName;
  /** Canonical MVP artifact directory. It is never passed to the verifier. */
  toolDir: string;
  evidence?: readonly LiveIntegrationEvidence[];
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  onDeadlineReached?: () => Promise<number | null>;
  signal?: AbortSignal;
}

export interface LiveFinesseDependencies {
  verify?: typeof runLiveSemanticVerification;
}

type QueueRelease = () => void;

interface QueueWaiter {
  signal?: AbortSignal;
  resolve: (release: QueueRelease | undefined) => void;
  abort?: () => void;
  settled: boolean;
}

/** A process-local queue is enough here: all callers share the same expensive
 * live browser/provider resources, while separate Imprint processes retain
 * their existing site-level live lock. */
class SingleFinesseQueue {
  private active = false;
  private readonly waiters: QueueWaiter[] = [];

  acquire(signal?: AbortSignal): Promise<QueueRelease | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: QueueWaiter = { signal, resolve, settled: false };
      if (signal) {
        waiter.abort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.abort as () => void);
          resolve(undefined);
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.active) return;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      if (waiter.signal?.aborted) {
        waiter.settled = true;
        waiter.resolve(undefined);
        continue;
      }
      waiter.settled = true;
      if (waiter.abort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abort);
      }
      this.active = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = false;
        this.dispatch();
      });
      return;
    }
  }
}

const finesseQueue = new SingleFinesseQueue();

/** Run the full parameter/breadth verifier against a disposable copy of an MVP.
 * The result is advisory: every expected failure is returned as data, and the
 * caller decides whether and where to persist the report. */
export async function runBestEffortLiveFinesse(
  opts: LiveFinesseOptions,
  dependencies: LiveFinesseDependencies = {},
): Promise<LiveFinesseResult> {
  const queuedAt = Date.now();
  const release = await finesseQueue.acquire(opts.signal);
  if (!release) {
    return cancelledResult(opts.provider, queuedAt, cancellationMessage(opts.signal));
  }

  const startedAt = Date.now();
  let isolatedRoot: string | undefined;
  let isolatedToolDir: string | undefined;
  try {
    if (opts.signal?.aborted) {
      return cancelledResult(opts.provider, startedAt, cancellationMessage(opts.signal));
    }
    const isolated = createIsolatedSiteCopy(opts.toolDir);
    isolatedRoot = isolated.root;
    isolatedToolDir = isolated.toolDir;
    const verification = await (dependencies.verify ?? runLiveSemanticVerification)({
      provider: opts.provider,
      toolDir: isolated.toolDir,
      evidence: [...(opts.evidence ?? [])],
      deadlineMs: opts.deadlineMs,
      runDeadline: opts.runDeadline,
      onDeadlineReached: opts.onDeadlineReached,
      signal: opts.signal,
    });
    const artifacts = snapshotFinesseArtifacts(isolated.toolDir);
    return {
      status: verification.completedReview ? 'completed' : 'inconclusive',
      provider: verification.provider,
      model: verification.model,
      attempts: verification.attempts,
      completedReview: verification.completedReview,
      report: verification.report,
      artifacts,
      message: verification.report.summary,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const artifacts = isolatedToolDir
      ? snapshotFinesseArtifacts(isolatedToolDir)
      : ({} satisfies LiveFinesseArtifactSnapshot);
    if (isCancellation(error, opts.signal)) {
      return {
        ...cancelledResult(opts.provider, startedAt, errorMessage(error)),
        artifacts,
      };
    }
    return {
      status: 'inconclusive',
      provider: opts.provider,
      attempts: 0,
      completedReview: false,
      artifacts,
      message: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (isolatedRoot) rmSync(isolatedRoot, { recursive: true, force: true });
    release();
  }
}

function createIsolatedSiteCopy(toolDir: string): { root: string; toolDir: string } {
  const sourceSiteDir = dirname(toolDir);
  const toolDirectoryName = basename(toolDir);
  const root = mkdtempSync(pathJoin(tmpdir(), 'imprint-live-finesse-'));
  const isolatedSiteDir = pathJoin(root, 'site');
  try {
    mkdirSync(isolatedSiteDir, { recursive: true, mode: 0o700 });

    for (const entry of readdirSync(sourceSiteDir, { withFileTypes: true })) {
      const source = pathJoin(sourceSiteDir, entry.name);
      const destination = pathJoin(isolatedSiteDir, entry.name);
      if (entry.isFile() && ISOLATED_SITE_ROOT_FILES.has(entry.name)) {
        copyFileSync(source, destination);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const isTarget = entry.name === toolDirectoryName;
      const isShared = entry.name === '.imprint-shared';
      const isSiblingTool = existsSync(pathJoin(source, 'workflow.json'));
      if (!isTarget && !isShared && !isSiblingTool) continue;
      cpSync(source, destination, {
        recursive: true,
        dereference: true,
        filter: shouldCopyFinesseArtifact,
      });
    }

    const isolatedToolDir = pathJoin(isolatedSiteDir, toolDirectoryName);
    if (!existsSync(isolatedToolDir) || !statSync(isolatedToolDir).isDirectory()) {
      throw new Error(`Cannot isolate missing tool directory ${JSON.stringify(toolDir)}`);
    }
    return { root, toolDir: isolatedToolDir };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function shouldCopyFinesseArtifact(source: string): boolean {
  const name = basename(source);
  if (OMITTED_DIRECTORY_NAMES.has(name)) return false;
  if (name === '.imprint-live-verification.lock') return false;
  return !OMITTED_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function snapshotFinesseArtifacts(toolDir: string): LiveFinesseArtifactSnapshot {
  return {
    reportJson: readOptionalText(pathJoin(toolDir, LIVE_VERIFICATION_REPORT_FILE)),
    evidenceJson: readOptionalText(pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE)),
    logJsonl: readOptionalText(pathJoin(toolDir, LIVE_VERIFIER_LOG_FILE)),
  };
}

function readOptionalText(path: string): string | undefined {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(
    signal?.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')),
  );
}

function cancellationMessage(signal: AbortSignal | undefined): string {
  return signal?.reason instanceof Error ? signal.reason.message : 'Live finesse was cancelled.';
}

function cancelledResult(
  provider: ProviderName,
  startedAt: number,
  message: string,
): LiveFinesseResult {
  return {
    status: 'cancelled',
    provider,
    attempts: 0,
    completedReview: false,
    artifacts: {},
    message,
    durationMs: Date.now() - startedAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
