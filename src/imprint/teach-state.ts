/**
 * Compatibility reader for legacy `.teach-state.json` diagnostics.
 *
 * Fresh master-led teaches use `FreshTeachJournal`; this module remains only so
 * audit, session discovery, and MCP maintenance can inspect or prune older site
 * metadata. It deliberately contains no resume, phase-window, or tool-selection
 * controller logic.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import type { SharedModuleManifestEntry } from './build-plan.ts';
import { localSiteDir, resolveLocalSitePath } from './paths.ts';
import {
  type SharedCompileContext,
  SharedCompileContextSchema,
  type ToolCandidate,
} from './tool-candidates.ts';

/** Historical step names retained as the on-disk metadata vocabulary. */
export type TeachStep =
  | 'record'
  | 'redact'
  | 'triage'
  | 'replay-and-diff'
  | 'detect-candidates'
  | 'plan-prereqs'
  | 'generate'
  | 'compile-playbook'
  | 'emit'
  | 'register';

export interface WorkflowState {
  sessionPath: string;
  redactedPath?: string;
  triagedPath?: string;
  classificationsPath?: string;
  classificationsHash?: string;
  completedSteps: TeachStep[];
  error?: string;
  startedAt: string;
  updatedAt: string;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  buildPlanPath?: string;
  sharedModules?: SharedModuleManifestEntry[];
  authCompletion?: {
    toolName: string;
    buildPlanHash: string;
    workflowHash: string;
    completedAt: string;
  };
  warnings?: string[];
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
  const legacyPath = legacyStatePath(site);
  const isLegacy = !existsSync(path) && existsSync(legacyPath);
  const loadPath = isLegacy ? legacyPath : path;
  if (!existsSync(loadPath)) return { workflows: {} };
  try {
    const state = JSON.parse(readFileSync(loadPath, 'utf8')) as TeachState;
    for (const workflow of Object.values(state.workflows)) {
      if (workflow.sharedContext) {
        const parsed = SharedCompileContextSchema.safeParse(workflow.sharedContext);
        workflow.sharedContext = parsed.success ? parsed.data : undefined;
      }
      if (isLegacy) {
        if (workflow.sessionPath && !pathIsAbsolute(workflow.sessionPath)) {
          workflow.sessionPath = pathResolve('examples', site, workflow.sessionPath);
        }
        if (workflow.redactedPath && !pathIsAbsolute(workflow.redactedPath)) {
          workflow.redactedPath = pathResolve('examples', site, workflow.redactedPath);
        }
      }
    }
    return state;
  } catch {
    return { workflows: {} };
  }
}

export function saveTeachState(site: string, state: TeachState): void {
  const path = teachStatePath(site);
  mkdirSync(pathJoin(path, '..'), { recursive: true });
  if (Object.keys(state.workflows).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // The compatibility file may not exist.
    }
    return;
  }
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporaryPath, path);
  } catch {
    writeFileSync(path, readFileSync(temporaryPath, 'utf8'), 'utf8');
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup after the cross-platform overwrite fallback.
    }
  }
}

export function resolveTeachStatePath(
  site: string,
  storedPath: string | null | undefined,
): string | null {
  const value = storedPath?.trim();
  if (!value) return null;
  return pathIsAbsolute(value) ? value : resolveLocalSitePath(site, value);
}

function isExistingTeachFile(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function pruneStalePendingTeachWorkflows(site: string, state: TeachState): boolean {
  let changed = false;
  for (const [key, workflow] of Object.entries(state.workflows)) {
    if (!key.startsWith('_pending_')) continue;
    const hasRecording =
      isExistingTeachFile(resolveTeachStatePath(site, workflow.sessionPath)) ||
      isExistingTeachFile(resolveTeachStatePath(site, workflow.redactedPath));
    if (hasRecording) continue;
    delete state.workflows[key];
    changed = true;
  }
  return changed;
}

export function friendlySessionTimestamp(sessionPath: string): string {
  const match = sessionPath.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!match) return pathBasename(sessionPath);
  return `${match[1]} ${match[2]}:${match[3]}`;
}
