/**
 * Shared persistence helpers for `imprint teach` checkpoint state.
 *
 * The state file is intentionally small JSON today, but callers should go
 * through this module so a future DB-backed implementation can keep the same
 * behavior at the CLI boundary.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename as pathBasename,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  resolve as pathResolve,
} from 'node:path';
import {
  localSessionsDir,
  localSiteDir,
  relativeToLocalSite,
  resolveLocalSitePath,
} from './paths.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';

export const TEACH_STEPS = [
  'record',
  'redact',
  'replay-and-diff',
  'triage',
  'detect-candidates',
  'generate',
  'compile-playbook',
  'emit',
  'register',
] as const;

export type TeachStep = (typeof TEACH_STEPS)[number];

export interface WorkflowState {
  sessionPath: string;
  redactedPath?: string;
  triagedPath?: string;
  classificationsPath?: string;
  completedSteps: TeachStep[];
  error?: string;
  startedAt: string;
  updatedAt: string;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
}

export interface TeachState {
  workflows: Record<string, WorkflowState>;
}

export function teachStatePath(site: string): string {
  return pathJoin(localSiteDir(site), '.teach-state.json');
}

function legacyStatePath(site: string): string {
  return pathResolve('examples', site, '.teach-state.json');
}

export function loadTeachState(site: string): TeachState {
  const path = teachStatePath(site);
  const isLegacy = !existsSync(path) && existsSync(legacyStatePath(site));
  const loadPath = isLegacy ? legacyStatePath(site) : path;
  if (!existsSync(loadPath)) return { workflows: {} };
  try {
    const state = JSON.parse(readFileSync(loadPath, 'utf8')) as TeachState;
    return isLegacy ? normalizeLegacyTeachState(site, state) : state;
  } catch {
    return { workflows: {} };
  }
}

function normalizeLegacyTeachState(site: string, state: TeachState): TeachState {
  const legacyRoot = pathResolve('examples', site);
  for (const ws of Object.values(state.workflows)) {
    if (ws.sessionPath && !pathIsAbsolute(ws.sessionPath)) {
      ws.sessionPath = pathResolve(legacyRoot, ws.sessionPath);
    }
    if (ws.redactedPath && !pathIsAbsolute(ws.redactedPath)) {
      ws.redactedPath = pathResolve(legacyRoot, ws.redactedPath);
    }
  }
  return state;
}

export function saveTeachState(site: string, state: TeachState): void {
  const path = teachStatePath(site);
  mkdirSync(pathJoin(path, '..'), { recursive: true });
  if (Object.keys(state.workflows).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // File might not exist — fine.
    }
    return;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    // On Windows, rename can fail if dest exists. Fall back to overwrite.
    writeFileSync(path, readFileSync(tmp, 'utf8'), 'utf8');
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function resolveTeachStatePath(
  site: string,
  storedPath: string | null | undefined,
): string | null {
  const value = storedPath?.trim();
  if (!value) return null;
  if (pathIsAbsolute(value)) return value;
  return resolveLocalSitePath(site, value);
}

export function toRelativeTeachStatePath(site: string, absPath: string): string {
  const localRelative = relativeToLocalSite(site, absPath);
  if (localRelative) return localRelative;
  return `_external_/${pathBasename(absPath)}`;
}

export function buildTeachStateFromSession(
  site: string,
  sessionPath: string,
  redactedPath: string | null,
): WorkflowState {
  const now = new Date().toISOString();
  const ws: WorkflowState = {
    sessionPath: toRelativeTeachStatePath(site, sessionPath),
    completedSteps: redactedPath ? ['record', 'redact'] : ['record'],
    startedAt: now,
    updatedAt: now,
  };
  if (redactedPath) ws.redactedPath = toRelativeTeachStatePath(site, redactedPath);
  return ws;
}

export function nextTeachStep(completed: TeachStep[]): TeachStep {
  if (completed.length === 0) return 'record';
  const last = completed.at(-1);
  if (!last) return 'record';
  const lastIdx = TEACH_STEPS.indexOf(last);
  if (lastIdx < 0 || lastIdx >= TEACH_STEPS.length - 1) return 'record';
  return TEACH_STEPS[lastIdx + 1] as TeachStep;
}

/** Scan <IMPRINT_HOME>/<site>/ for completed workflows. A workflow is "complete"
 * only when its tool directory has index.ts (emit ran successfully). */
export function discoverCompletedWorkflows(site: string): string[] {
  const siteDir = localSiteDir(site);
  if (!existsSync(siteDir)) return [];
  const names: string[] = [];

  for (const entry of readdirSync(siteDir)) {
    if (entry === 'sessions' || entry === '_shared' || entry.startsWith('.')) continue;
    const dir = pathResolve(siteDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(pathJoin(dir, 'index.ts'))) {
      names.push(entry);
    }
  }
  return names;
}

/** Find the latest session that has no matching state entry.
 * Recordings live under ~/.imprint/<site>/sessions/. */
export function discoverOrphanSession(site: string, state: TeachState): WorkflowState | null {
  const trackedPaths = new Set(Object.values(state.workflows).map((ws) => ws.sessionPath));

  const candidates: Array<{ absPath: string; file: string }> = [];
  for (const sessDir of [localSessionsDir(site), pathResolve('examples', site, 'sessions')]) {
    if (!existsSync(sessDir)) continue;
    const sessions = readdirSync(sessDir).filter(
      (f) => f.endsWith('.json') && !f.includes('.redacted') && !f.includes('.triaged'),
    );
    for (const file of sessions) candidates.push({ absPath: pathJoin(sessDir, file), file });
  }

  candidates.sort((a, b) => b.file.localeCompare(a.file));

  for (const { absPath } of candidates) {
    const relPath = toRelativeTeachStatePath(site, absPath);
    if (trackedPaths.has(relPath) || trackedPaths.has(absPath)) continue;

    const redactedPath = absPath.replace(/\.json$/, '.redacted.json');
    const hasRedacted = existsSync(redactedPath);
    const completedSteps: TeachStep[] = ['record'];
    if (hasRedacted) completedSteps.push('redact');

    return {
      sessionPath: relPath,
      redactedPath: hasRedacted ? toRelativeTeachStatePath(site, redactedPath) : undefined,
      completedSteps,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

export function isExistingTeachFile(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function friendlySessionTimestamp(sessionPath: string): string {
  const m = sessionPath.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!m) return pathBasename(sessionPath);
  return `${m[1]} ${m[2]}:${m[3]}`;
}
