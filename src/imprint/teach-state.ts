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
import type { SharedModuleManifestEntry } from './build-plan.ts';
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
  'plan-prereqs',
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
  /** Site-relative path to the multi-tool build plan sidecar (.build-plan.json),
   *  set at the plan-prereqs step. Threaded into the per-tool compile drivers so
   *  each agent reads its slice via the read_build_plan tool. */
  buildPlanPath?: string;
  /** Shared modules built + verified before the per-tool fan-out. The verifier
   *  asserts a tool imports the modules the plan assigned it; entries with
   *  `verified: false` are excluded from that assertion. */
  sharedModules?: SharedModuleManifestEntry[];
  /** Non-fatal flags raised by upstream stages that downstream stages (and
   *  the user) should know about. Currently used by the redact stage to
   *  record `'credentials_not_paired'` when a password-shaped body field
   *  was scrubbed but no username+password pair could be extracted —
   *  meaning the generated workflow will template credentials as plain
   *  parameters instead of `${credential.X}` references. */
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

export function resolveWorkflowTriagedPath(
  site: string,
  ws: WorkflowState | undefined,
): string | null {
  if (!ws) return null;

  const explicitPath = resolveTeachStatePath(site, ws.triagedPath);
  if (explicitPath) return explicitPath;

  if (!ws.completedSteps.includes('triage')) return null;

  const redactedPath = resolveTeachStatePath(site, ws.redactedPath);
  if (!redactedPath?.endsWith('.redacted.json')) return null;

  const derivedPath = redactedPath.replace(/\.redacted\.json$/, '.triaged.json');
  return existsSync(derivedPath) ? derivedPath : null;
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

/** Find the latest local session that has no matching state entry.
 *  Recordings live under IMPRINT_HOME/<site>/sessions/. */
export function discoverOrphanSession(site: string, state: TeachState): WorkflowState | null {
  const trackedPaths = new Set(Object.values(state.workflows).map((ws) => ws.sessionPath));

  const candidates: Array<{ absPath: string; file: string }> = [];
  const sessDir = localSessionsDir(site);
  if (!existsSync(sessDir)) return null;
  const sessions = readdirSync(sessDir).filter(
    (f) => f.endsWith('.json') && !f.includes('.redacted') && !f.includes('.triaged'),
  );
  for (const file of sessions) candidates.push({ absPath: pathJoin(sessDir, file), file });

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

function hasRecoverableRawOrRedactedSession(site: string, ws: WorkflowState): boolean {
  return (
    isExistingTeachFile(resolveTeachStatePath(site, ws.sessionPath)) ||
    isExistingTeachFile(resolveTeachStatePath(site, ws.redactedPath))
  );
}

export function pruneStalePendingTeachWorkflows(site: string, state: TeachState): boolean {
  let changed = false;
  for (const [key, ws] of Object.entries(state.workflows)) {
    if (!key.startsWith('_pending_')) continue;
    if (hasRecoverableRawOrRedactedSession(site, ws)) continue;
    delete state.workflows[key];
    changed = true;
  }

  return changed;
}

export function friendlySessionTimestamp(sessionPath: string): string {
  const m = sessionPath.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!m) return pathBasename(sessionPath);
  return `${m[1]} ${m[2]}:${m[3]}`;
}

/** The furthest step (by TEACH_STEPS order) a workflow has completed, or null. */
function furthestCompletedStep(ws: WorkflowState): TeachStep | null {
  let bestIdx = -1;
  for (const s of ws.completedSteps) {
    const i = TEACH_STEPS.indexOf(s);
    if (i > bestIdx) bestIdx = i;
  }
  return bestIdx >= 0 ? (TEACH_STEPS[bestIdx] as TeachStep) : null;
}

/** The earlier steps a resume at `fromStep` requires. Excludes `plan-prereqs`
 *  (shared-module planning): it only runs — and is only recorded — for ≥2-tool
 *  runs, so a fully-completed single-tool run never has it. Treating it as a hard
 *  prerequisite would make every `--from-step generate/compile-playbook/emit/
 *  register` wrongly fail on single-tool sites; a ≥2-tool resume that needs the
 *  plan rebuilds it on demand (see teach.ts). `record` (index 0) and unknown
 *  steps require nothing. */
function requiredStepsBefore(fromStep: TeachStep): TeachStep[] {
  const fromIdx = TEACH_STEPS.indexOf(fromStep);
  if (fromIdx <= 0) return [];
  return TEACH_STEPS.slice(0, fromIdx).filter((s) => s !== 'plan-prereqs');
}

/** Non-throwing counterpart to {@link assertResumableAt}: true when `ws` completed
 *  every step a resume at `fromStep` needs. Used to filter multi-tool resume
 *  targets without throwing on the ones that didn't reach far enough. */
export function isResumableAt(ws: WorkflowState, fromStep: TeachStep): boolean {
  return requiredStepsBefore(fromStep).every((s) => ws.completedSteps.includes(s));
}

/** Throw unless `ws` has completed every step before `fromStep` — i.e. a prior run
 *  reached or crossed that point, so starting there won't be missing an earlier
 *  phase's output (the redacted/triaged session, classifications, build plan, …).
 *  Starting at `record` is always allowed (it produces everything fresh). */
export function assertResumableAt(
  site: string,
  workflowKey: string,
  ws: WorkflowState,
  fromStep: TeachStep,
): void {
  const required = requiredStepsBefore(fromStep);
  const missing = required.filter((s) => !ws.completedSteps.includes(s));
  if (missing.length === 0) return;
  const reached = furthestCompletedStep(ws);
  const resumeAt: TeachStep = reached ? nextTeachStep(ws.completedSteps) : 'record';
  throw new Error(
    [
      `Cannot start "${workflowKey}" (${site}) at "${fromStep}": the prior run is missing required ` +
        `earlier step(s) [${missing.join(', ')}].`,
      `  Latest completed step: ${reached ?? '(none)'}. Start at "${resumeAt}" or earlier, or run a full teach first.`,
    ].join('\n'),
  );
}

/** Pick which persisted workflow a `--from-step` run should resume (the
 *  most-recently-updated one), and validate the guard via assertResumableAt.
 *  Throws a clear, actionable error when there's no prior run or it didn't reach
 *  far enough. */
export function resolveStepStartTarget(
  site: string,
  state: TeachState,
  fromStep: TeachStep,
): { workflowKey: string; ws: WorkflowState } {
  // Exclude in-progress `_pending_*` placeholders: they never carry a candidate
  // and never reached far enough, so a stale one with a newer timestamp would
  // shadow a real completed workflow and make the guard throw "run a full teach
  // first" even though a valid resume target sits right next to it. (Mirrors the
  // sibling-plan reconstruction filter in teach.ts.)
  const entries = Object.entries(state.workflows).filter(([k]) => !k.startsWith('_pending_'));
  if (entries.length === 0) {
    throw new Error(
      [
        `Cannot start \`imprint teach ${site}\` at "${fromStep}": no prior teach run found for "${site}".`,
        '  --from-step resumes a previous run; run a full `imprint teach` first (or omit --from-step).',
      ].join('\n'),
    );
  }
  // Most-recently-updated workflow — the run a developer just executed and wants
  // to resume a single phase of.
  const [workflowKey, ws] = entries.sort((a, b) =>
    (b[1].updatedAt ?? '').localeCompare(a[1].updatedAt ?? ''),
  )[0] as [string, WorkflowState];
  assertResumableAt(site, workflowKey, ws, fromStep);
  return { workflowKey, ws };
}

/** A multi-tool `--from-step` resume reconstructs the prior run's tools from
 *  persisted state. Scope it to (a) tools from the SAME recording as the resume
 *  target — cross-recording tools have a different session and would otherwise be
 *  compiled against the wrong one — and (b) tools whose prior run actually reached
 *  `fromStep`'s prerequisites — a tool that failed earlier has no
 *  generate/compile-playbook output to resume from and would crash loading it.
 *  Tools excluded for either reason are returned in `skipped` so the caller can
 *  warn instead of silently dropping or crashing. */
interface MultiToolResumeSelection {
  plans: {
    workflowKey: string;
    candidate: WorkflowState['candidate'];
    sharedContext: WorkflowState['sharedContext'];
  }[];
  skipped: { workflowKey: string; reason: 'different-recording' | 'not-resumable' }[];
}

export function selectMultiToolResumePlans(
  state: TeachState,
  targetWorkflowKey: string,
  fromStep: TeachStep,
): MultiToolResumeSelection {
  const target = state.workflows[targetWorkflowKey];
  const plans: MultiToolResumeSelection['plans'] = [];
  const skipped: MultiToolResumeSelection['skipped'] = [];
  for (const [key, ws] of Object.entries(state.workflows)) {
    if (key.startsWith('_pending_') || !ws.candidate) continue;
    if (target && ws.sessionPath !== target.sessionPath) {
      skipped.push({ workflowKey: key, reason: 'different-recording' });
      continue;
    }
    if (!isResumableAt(ws, fromStep)) {
      skipped.push({ workflowKey: key, reason: 'not-resumable' });
      continue;
    }
    plans.push({ workflowKey: key, candidate: ws.candidate, sharedContext: ws.sharedContext });
  }
  return { plans, skipped };
}

/** True when the `[startIdx, stopIdx]` phase window overlaps the atomic analysis
 *  block (replay-and-diff → triage → detect-candidates), i.e. that block must run.
 *  Indices are positions in TEACH_STEPS (stopIdx defaults to the last step when no
 *  `--to-step` is given). Classic interval-overlap check, extracted so it can be
 *  unit-tested independently of teach()'s runtime flow. */
export function analysisBlockRunsForWindow(startIdx: number, stopIdx: number): boolean {
  return (
    startIdx <= TEACH_STEPS.indexOf('detect-candidates') &&
    stopIdx >= TEACH_STEPS.indexOf('replay-and-diff')
  );
}

/** The shared-pipeline steps recorded when the analysis block
 *  (replay-and-diff → triage → detect-candidates) completes. */
export const ANALYSIS_COMPLETED_STEPS: TeachStep[] = [
  'record',
  'redact',
  'replay-and-diff',
  'triage',
  'detect-candidates',
];

/** Merge the analysis-block steps into a workflow's prior completedSteps WITHOUT
 *  losing later progress. A re-run of detect-candidates (`--from-step`/`--only
 *  detect-candidates`, or interactive redo) reuses an existing workflowKey, and the
 *  candidate checkpoint replaces the whole WorkflowState — writing only the analysis
 *  steps would regress a tool that already reached generate…register. The union
 *  preserves prior steps; a first run (no prior entry) just gets the analysis steps. */
export function mergeAnalysisCompletedSteps(prior: TeachStep[] | undefined): TeachStep[] {
  return [...new Set<TeachStep>([...(prior ?? []), ...ANALYSIS_COMPLETED_STEPS])];
}

/** completedSteps to record for a freshly-detected candidate. Preserve the prior
 *  workflow's progress (so a later `--from-step register` still sees
 *  generate…register) ONLY when it came from the SAME recording — matched by
 *  sessionPath. A fresh or different recording that happens to produce the same
 *  toolName must reset to just the analysis steps: inheriting a stale `plan-prereqs`
 *  marker would let the alreadyPlanned shortcut skip re-planning and compile the new
 *  recording against the previous recording's `_shared/` modules. */
export function detectCandidatesCompletedSteps(
  prior: WorkflowState | undefined,
  currentSessionPath: string,
): TeachStep[] {
  const sameRecording = prior !== undefined && prior.sessionPath === currentSessionPath;
  return mergeAnalysisCompletedSteps(sameRecording ? prior.completedSteps : undefined);
}

/** Validate and resolve the `imprint teach` phase-window flags (`--from-step`,
 *  `--to-step`, `--only`) against the canonical step list. `--only X` expands to
 *  `--from-step X --to-step X`. Returns the resolved window, or an `error` string
 *  (the exact message the CLI prints before exiting 2). Extracted from the CLI so
 *  every validation rule is unit-testable without spawning the binary. */
export function resolveTeachPhaseWindow(values: {
  'from-step'?: string;
  'to-step'?: string;
  only?: string;
  'from-session'?: string;
}): { fromStep?: TeachStep; toStep?: TeachStep } | { error: string } {
  // `--only` is shorthand for `--from-step X --to-step X`; combining it with an
  // explicit --from-step/--to-step is contradictory (and the nullish-coalescing
  // below would otherwise silently drop --only). Reject it with a clear message.
  if (
    values.only !== undefined &&
    (values['from-step'] !== undefined || values['to-step'] !== undefined)
  ) {
    return {
      error:
        'error: --only cannot combine with --from-step or --to-step. Use either --only <step>, or --from-step/--to-step.',
    };
  }
  // Error messages name the flag the user actually typed: `--only` expands to both
  // fromStep and toStep, so a raw `--from-step` in the message would be confusing.
  const usingOnly = values.only !== undefined;
  const fromStep = values['from-step'] ?? values.only;
  const toStep = values['to-step'] ?? values.only;
  const steps = TEACH_STEPS as readonly string[];
  for (const [flag, val] of [
    [usingOnly ? '--only' : '--from-step', fromStep],
    [usingOnly ? '--only' : '--to-step', toStep],
  ] as const) {
    if (val !== undefined && !steps.includes(val)) {
      return { error: `error: invalid ${flag} "${val}" — valid steps: ${TEACH_STEPS.join(', ')}` };
    }
  }
  if (fromStep && toStep && steps.indexOf(fromStep) > steps.indexOf(toStep)) {
    return { error: `error: --from-step "${fromStep}" comes after --to-step "${toStep}"` };
  }
  if (fromStep && values['from-session']) {
    return {
      error: `error: ${usingOnly ? '--only' : '--from-step'} resumes a prior run; it cannot combine with --from-session. Use --to-step with --from-session to cap phases on a fresh session.`,
    };
  }
  // --from-session enters the chain at `redact`, so a --to-step before redact
  // forms a backwards/empty window that runs nothing yet exits 0 with a
  // nonsensical "redact → record" summary.
  if (values['from-session'] && toStep && steps.indexOf(toStep) < steps.indexOf('redact')) {
    return {
      error: `error: --from-session starts at "redact"; --to-step "${toStep}" comes before it. Use --to-step "redact" or later.`,
    };
  }
  return { fromStep: fromStep as TeachStep | undefined, toStep: toStep as TeachStep | undefined };
}
