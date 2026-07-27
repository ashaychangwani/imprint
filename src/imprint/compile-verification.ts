import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { loadBackendsCacheStatus } from './backend-cache.ts';
import { runWorkflowWithLadder } from './backend-ladder.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import type { CredentialStore } from './runtime.ts';
import { WorkflowSchema } from './types.ts';

export const LIVE_EVIDENCE_PATH_ENV = 'IMPRINT_LIVE_EVIDENCE_PATH';
export const LIVE_PREFERRED_BACKEND_ONLY_ENV = 'IMPRINT_LIVE_PREFERRED_BACKEND_ONLY';

type WorkflowParams = Record<string, string | number | boolean>;
type LadderRun = Awaited<ReturnType<typeof runWorkflowWithLadder>>;

export interface LiveIntegrationEvidence {
  schemaVersion: 1;
  kind: 'call';
  label: string;
  caseName: string;
  toolName: string;
  requestedParams: WorkflowParams;
  effectiveParams: WorkflowParams;
  result: LadderRun['result'];
  usedBackend: LadderRun['usedBackend'];
  attempts: LadderRun['attempts'];
  durationMs: number;
}

function scalarDefaults(parameters: Array<{ name: string; default?: unknown }>): WorkflowParams {
  const defaults: WorkflowParams = {};
  for (const parameter of parameters) {
    const value = parameter.default;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      defaults[parameter.name] = value;
    }
  }
  return defaults;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireSiteLiveLock(
  workflowPath: string,
  deadlineMs = Date.now() + 10 * 60_000,
): Promise<() => void> {
  const siteDir = dirname(dirname(workflowPath));
  const lockPath = pathJoin(siteDir, '.imprint-live-verification.lock');
  const deadline = Math.min(deadlineMs, Date.now() + 10 * 60_000);

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Best effort: a later acquisition can clean up a stale lock.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          pid?: number;
          createdAt?: number;
        };
        const stale =
          typeof current.pid === 'number'
            ? !processIsAlive(current.pid)
            : Date.now() - (current.createdAt ?? 0) > 10 * 60_000;
        if (stale) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          // Another process can observe the lock between exclusive creation
          // and the tiny metadata write. Never delete a fresh, partially
          // written lock; only reap malformed metadata after a long stale age.
          if (Date.now() - statSync(lockPath).mtimeMs > 10 * 60_000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Another process may have released/replaced the lock. Retry below.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for same-site live verification lock: ${lockPath}`);
}

/**
 * Compile-only wrapper around the backend ladder. Production generated tools do
 * not use this function. During `imprint teach`, it captures the actual tool
 * input and parsed result for an independent semantic verifier.
 */
export async function runCapturedIntegrationCase(opts: {
  caseName: string;
  workflowPath: string;
  params: WorkflowParams;
  credentials?: CredentialStore;
  /** Final semantic verification pins the cache winner so a failed preferred
   * backend becomes explicit reprobe feedback instead of a hidden ladder walk. */
  preferredOnlyBackend?: boolean;
}): Promise<LadderRun> {
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowPath, 'utf8')));
  if (workflowHasIrreversibleEffect(workflow)) {
    throw new Error(
      `Live integration is disabled for irreversible workflow ${JSON.stringify(workflow.toolName)}.`,
    );
  }
  const release = await acquireSiteLiveLock(opts.workflowPath);
  const startedAt = Date.now();
  let run: LadderRun;
  try {
    let forceBackend: LadderRun['usedBackend'] | undefined;
    if (opts.preferredOnlyBackend || process.env[LIVE_PREFERRED_BACKEND_ONLY_ENV] === '1') {
      const toolDir = dirname(opts.workflowPath);
      const status = loadBackendsCacheStatus(
        workflow.site ?? '',
        dirname(dirname(toolDir)),
        toolDir,
        { warn: false, toolName: workflow.toolName },
      );
      forceBackend = status.status === 'ok' ? status.cache.preferredOrder[0] : undefined;
      if (!forceBackend) {
        throw new Error(
          `Live verifier backend is not prepared for ${workflow.toolName}; call prepare_live_backend before running the suite.`,
        );
      }
    }
    run = await runWorkflowWithLadder({
      workflowPath: opts.workflowPath,
      params: opts.params,
      credentials: opts.credentials,
      forceBackend,
    });
  } finally {
    release();
  }

  const evidencePath = process.env[LIVE_EVIDENCE_PATH_ENV];
  if (evidencePath) {
    const evidence: LiveIntegrationEvidence = {
      schemaVersion: 1,
      kind: 'call',
      label: `${opts.caseName}:${randomUUID().slice(0, 8)}`,
      caseName: opts.caseName,
      toolName: workflow.toolName,
      requestedParams: opts.params,
      effectiveParams: { ...scalarDefaults(workflow.parameters), ...opts.params },
      result: run.result,
      usedBackend: run.usedBackend,
      attempts: run.attempts,
      durationMs: Date.now() - startedAt,
    };
    appendFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  }
  return run;
}

export function readLiveIntegrationEvidence(path: string): LiveIntegrationEvidence[] {
  if (!existsSync(path)) return [];
  const evidence: LiveIntegrationEvidence[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as LiveIntegrationEvidence;
    if (parsed.schemaVersion !== 1 || parsed.kind !== 'call' || !parsed.label || !parsed.toolName) {
      throw new Error('invalid live integration evidence record');
    }
    evidence.push(parsed);
  }
  return evidence;
}
