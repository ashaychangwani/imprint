/**
 * `imprint teach` — interactive pipeline that chains record → redact → generate
 * → compile-playbook → emit automatically, then presents a platform picker
 * and outputs paste snippets or runs registration commands.
 *
 * Supports resuming from the last successful step, re-doing from a chosen
 * step, and multiple workflows per site (each in its own subdirectory).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename as pathBasename,
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from 'node:path';
import * as p from '@clack/prompts';
import type { OnDeadlineReached } from './agent.ts';
import { compileAuthAgent } from './auth-compile-agent.ts';
import { authWorkflowHash } from './auth-compile-tools.ts';
import {
  type SharedModuleManifestEntry,
  buildPlanSidecarPath,
  deriveTokenContractHints,
  readBuildPlanFile,
  topoLevelsForTools,
} from './build-plan.ts';
import type { CompileAgentResult } from './compile-agent-types.ts';
import {
  type CompileAgentProgress,
  type TriageResult,
  compilePlaybook,
  findAuthAdjacentSeqs,
  findCredentialBearingSeqs,
  generate,
  triageRequests,
} from './compile.ts';
import { mapLimit, mapLimitSettled } from './concurrency.ts';
import {
  type CredentialFinding,
  applyCredentialPlaceholders,
  deriveLoginCredentials,
  extractCredentials,
} from './credential-extract.ts';
import {
  getCredentialBackend,
  loadSiteCredentials,
  readSiteManifest,
  upsertManifestEntry,
} from './credential-store.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import { emit } from './emit.ts';
import {
  type Platform,
  buildRegistrationCommand,
  detectImprintCommand,
  generatePasteSnippet,
  generateSkillMd,
} from './integrations.ts';
import {
  type LLMOptions,
  type ProviderName,
  type ProviderStatus,
  detectTeachProvider,
  getProviderStatuses,
  isTeachCompatibleProvider,
} from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog, muteLog, unmuteLog } from './log.ts';
import { MultiProgress } from './multi-progress.ts';
import { localSiteDir, localToolDir } from './paths.ts';
import { rebindExistingBackendsCacheToWorkflow } from './probe-backends.ts';
import { describeAgentActivity, formatElapsed } from './progress.ts';
import { record } from './record.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import { loadCredentialStore } from './runtime.ts';
import {
  isSensitiveCredentialKey,
  isUsernameLikeKey,
  passwordLikeTokens,
} from './sensitive-keys.ts';
import type { ClassifiedValue } from './session-diff.ts';
import {
  listSessionsInDir,
  listSiteSessions,
  mergeSessions,
  writeCombinedSession,
} from './session-merge.ts';
import { clearCachedToken } from './stealth-token-cache.ts';
import { planAndBuildPrereqs } from './teach-plan.ts';
import {
  TEACH_STEPS as STEPS,
  type TeachStep as Step,
  type TeachState,
  type WorkflowState,
  analysisBlockRunsForWindow,
  buildTeachStateFromSession,
  candidateSelectionChanged,
  detectCandidatesCompletedSteps,
  discoverCompletedWorkflows,
  discoverOrphanSession,
  friendlySessionTimestamp,
  isCandidateBackedResume,
  isExistingTeachFile as isExistingFile,
  loadTeachState,
  nextTeachStep as nextStep,
  pruneStalePendingTeachWorkflows,
  pruneUnselectedCandidateWorkflows,
  resolveStepStartTarget,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
  resolvedTeachRunPolicy,
  saveTeachState,
  selectMultiToolResumePlans,
  staleCompletedToolsForRun,
  toRelativeTeachStatePath as toRelative,
} from './teach-state.ts';
import {
  type SharedCompileContext,
  type ToolCandidate,
  buildSharedCompileContext as buildCandidateSharedCompileContext,
  closeCandidateSelection,
  detectToolCandidates,
  mergeCandidateDependencies,
  primaryToolCandidate,
  sharedContextHasAuth,
} from './tool-candidates.ts';
import { planToolCompile } from './tool-plan.ts';
import { setSpanAttributes, shutdownTracing, traced } from './tracing.ts';
import { CronConfigSchema, SessionSchema, WorkflowSchema } from './types.ts';
import type { CronConfig, Playbook, Session, Workflow } from './types.ts';

export function authCompileLlmConfig(provider: ProviderName, model: string): LLMOptions {
  return { provider, model };
}

export function authCompletionMatches(
  completion: WorkflowState['authCompletion'],
  expected: { toolName: string; buildPlanHash: string; workflowHash: string },
): boolean {
  return Boolean(
    completion &&
      completion.toolName === expected.toolName &&
      completion.buildPlanHash === expected.buildPlanHash &&
      completion.workflowHash === expected.workflowHash,
  );
}

export function hasDurableAuthState(
  workflow: Workflow,
  stored: { values: Record<string, string>; cookies: unknown[]; storage?: unknown[] },
): boolean {
  const required = workflow.authConfig?.persist ?? [];
  if (required.length > 0) {
    return required.every((name) => String(stored.values[name] ?? '').length > 0);
  }
  return stored.cookies.length > 0 || (stored.storage?.length ?? 0) > 0;
}

export function resolvedArtifactCheckpointPath(
  site: string,
  _storedPath: string | undefined,
  resolvedPath: string,
): string {
  // toRelative keeps managed artifacts site-relative and genuine external
  // artifacts absolute, so both forms remain resolvable on the next resume.
  return toRelative(site, resolvedPath);
}

export function selectCompileSessionArtifact(
  resumedTriagedPath: string | null,
  redactedPath: string | null,
): { path: string | null; triaged: boolean } {
  const derivedTriagedPath = redactedPath?.replace(/\.redacted\.json$/, '.triaged.json') ?? null;
  const path =
    (resumedTriagedPath && existsSync(resumedTriagedPath) ? resumedTriagedPath : null) ??
    (derivedTriagedPath && existsSync(derivedTriagedPath) ? derivedTriagedPath : redactedPath);
  return {
    path,
    triaged: path === resumedTriagedPath || path === derivedTriagedPath,
  };
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Read replay classifications only when the sidecar belongs to the exact
 * recording being compiled. Request seq numbers are recording-local, so using
 * a site-global cache from another recording could fabricate dependency edges. */
export function loadCachedClassificationsForSession(
  classPath: string,
  sessionPath: string,
  replaySafetyHash: string,
): ClassifiedValue[] | undefined {
  if (!existsSync(classPath) || !existsSync(sessionPath)) return undefined;
  try {
    const cached = JSON.parse(readFileSync(classPath, 'utf8')) as {
      sourceSessionHash?: string;
      replaySafetyHash?: string;
      classifications?: ClassifiedValue[];
    };
    if (
      !cached.sourceSessionHash ||
      cached.sourceSessionHash !== fileSha256(sessionPath) ||
      cached.replaySafetyHash !== replaySafetyHash ||
      !Array.isArray(cached.classifications)
    ) {
      return undefined;
    }
    return cached.classifications;
  } catch {
    return undefined;
  }
}

const REPLAY_SAFETY_POLICY_VERSION = 1;

/** Stable cache identity for the triage decision that authorizes replay.
 * Runtime counters are intentionally excluded; only policy-relevant seq sets
 * affect whether classifications may be reused. */
export function replaySafetyIdentity(
  triage: Pick<TriageResult, 'selectedSeqs' | 'replaySafeSeqs' | 'irreversibleSeqs'> & {
    coveredOutboundEventSeqs?: number[];
    irreversibleEventSeqs?: number[];
  },
): string {
  const sorted = (seqs: readonly number[]): number[] => [...new Set(seqs)].sort((a, b) => a - b);
  return createHash('sha256')
    .update(
      JSON.stringify({
        policyVersion: REPLAY_SAFETY_POLICY_VERSION,
        selectedSeqs: sorted(triage.selectedSeqs),
        replaySafeSeqs: sorted(triage.replaySafeSeqs),
        irreversibleSeqs: sorted(triage.irreversibleSeqs),
        coveredOutboundEventSeqs: sorted(triage.coveredOutboundEventSeqs ?? []),
        irreversibleEventSeqs: sorted(triage.irreversibleEventSeqs ?? []),
      }),
    )
    .digest('hex');
}

export function triageAllowsReplay(
  triage: Pick<TriageResult, 'irreversibleSeqs'> & { irreversibleEventSeqs?: number[] },
): boolean {
  return triage.irreversibleSeqs.length === 0 && (triage.irreversibleEventSeqs?.length ?? 0) === 0;
}

export function triageCoversSession(
  session: Pick<Session, 'requests' | 'events'>,
  triage: Pick<TriageResult, 'replaySafeSeqs' | 'irreversibleSeqs'> & {
    coveredOutboundEventSeqs?: number[];
  },
): boolean {
  const source = [...new Set(session.requests.map((request) => request.seq))].sort((a, b) => a - b);
  const covered = [...new Set([...triage.replaySafeSeqs, ...triage.irreversibleSeqs])].sort(
    (a, b) => a - b,
  );
  const sourceOutboundEvents = [
    ...new Set(
      session.events.filter((event) => event.type === 'ws-sent').map((event) => event.seq),
    ),
  ].sort((a, b) => a - b);
  const coveredOutboundEvents = [...new Set(triage.coveredOutboundEventSeqs ?? [])].sort(
    (a, b) => a - b,
  );
  return (
    source.length === covered.length &&
    source.every((seq, index) => seq === covered[index]) &&
    sourceOutboundEvents.length === coveredOutboundEvents.length &&
    sourceOutboundEvents.every((seq, index) => seq === coveredOutboundEvents[index])
  );
}

function classificationsPlanningHash(
  classifications: ClassifiedValue[] | undefined,
): string | undefined {
  return classifications
    ? createHash('sha256').update(JSON.stringify(classifications)).digest('hex')
    : undefined;
}

export {
  buildTeachStateFromSession,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
} from './teach-state.ts';

/**
 * How many compile agents run in parallel when more than one tool is selected.
 * Each compiler can now invoke a separate live semantic verifier, so keep this
 * at 2 to avoid provider rate-limit bursts and same-site anti-bot pressure.
 * Single-tool runs still use concurrency 1.
 */
const COMPILE_CONCURRENCY = 2;

/** Module logger — suppressed during teach's spinner phases via muteLog(). */
const log = createLog('teach');

export function isProviderUsageLimitedError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}\n${err.message}` : String(err);
  return (
    /\berror_code=rate_limited\b/i.test(text) ||
    /\byou['’]?ve hit your usage limit\b/i.test(text) ||
    /\btry again at \d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(text)
  );
}

function skippedAfterProviderLimitError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `skipped because the compile provider hit a usage limit before this tool started. Retry the teach run after the provider reset; root cause: ${message.split('\n')[0] ?? message}`,
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface TeachOptions {
  site?: string;
  url?: string;
  persistProfile?: boolean;
  signal?: AbortSignal;
  noInteractive?: boolean;
  provider?: ProviderName;
  /** Override the compile model (otherwise prompted or auto-detected). */
  model?: string;
  /** Per-tool compile timeout in ms. Default 20 minutes. */
  maxDurationMs?: number;
  fromSession?: string;
  /** Retain agent-generated tests after successful compile verification. */
  keepTest?: boolean;
  /** Compile only the primary detected candidate and its upstream dependencies. */
  primaryTool?: boolean;
  /** Bounded resume: compile exactly one persisted candidate from the retained recording. */
  tool?: string;
  /** Skip the replay-and-diff stage entirely. */
  skipReplay?: boolean;
  /** Run only specific phases of the teach chain. `fromStep` resumes a PRIOR run
   *  at that step (guarded — every earlier step must already be complete so its
   *  output can be reused); `toStep` stops after that step. Together they bound a
   *  window; fromStep===toStep runs a single phase. `fromStep` is non-interactive
   *  (bypasses the resume prompt) and is not combined with `fromSession`. */
  fromStep?: Step;
  toStep?: Step;
}

interface TeachResult {
  sessionPath: string;
  workflowPath: string;
  playbookPath: string;
  indexPath: string;
  workflow: Workflow;
  playbook: Playbook;
  tools: TeachToolResult[];
}

interface TeachToolResult {
  workflowPath: string;
  playbookPath: string;
  indexPath: string;
  workflow: Workflow;
  playbook: Playbook;
}

export function assertCandidateToolName(
  artifact: string,
  actualToolName: string,
  candidate?: ToolCandidate,
): void {
  if (!candidate || actualToolName === candidate.toolName) return;
  throw new Error(
    `${artifact} toolName "${actualToolName}" does not match selected candidate "${candidate.toolName}".`,
  );
}

function requireSessionFile(
  path: string | null,
  opts: {
    site: string;
    workflowKey: string;
    startFrom: Step;
    kind: 'raw' | 'redacted' | 'triaged';
  },
): string {
  if (isExistingFile(path)) return path;

  const noun =
    opts.kind === 'raw'
      ? 'original session JSON'
      : opts.kind === 'triaged'
        ? 'triaged session JSON'
        : 'redacted session JSON';
  const redoStep = opts.kind === 'raw' ? 'record' : opts.kind === 'triaged' ? 'triage' : 'redact';
  throw new Error(
    [
      `Cannot redo "${opts.workflowKey}" from ${opts.startFrom}: the ${noun} is missing.`,
      `→ rerun with: imprint teach ${opts.site} --from-session <session.json>`,
      `→ or choose "Redo" from ${redoStep} to rebuild it.`,
    ].join('\n'),
  );
}

export function triageResultFromTriagedSession(session: Session): TriageResult {
  if (session.triage?.effectSchemaVersion !== 2) {
    throw new Error(
      [
        'Triaged session predates full-inventory replay safety classification.',
        `Run \`imprint teach ${session.site}\` interactively, choose “Redo … from a specific step”, then choose “triage”.`,
        'That supported Redo path reuses the original recording and rebuilds the triaged artifact with current safety metadata.',
      ].join('\n'),
    );
  }
  const selectedSeqs = session.requests.map((request) => request.seq);
  const irreversibleSeqs = session.triage.irreversibleSeqs;
  const irreversibleSet = new Set(irreversibleSeqs);
  return {
    session,
    selectedSeqs,
    replaySafeSeqs: session.triage.coveredSeqs.filter((seq) => !irreversibleSet.has(seq)),
    irreversibleSeqs,
    coveredOutboundEventSeqs: session.triage.coveredOutboundEventSeqs,
    irreversibleEventSeqs: session.triage.irreversibleEventSeqs,
    consideredCount: selectedSeqs.length,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
  };
}

function loadTriageResultFromTriagedPath(triagedPath: string): TriageResult {
  return triageResultFromTriagedSession(
    loadJsonFile(
      triagedPath,
      SessionSchema,
      {
        notFound: 'Triaged session file not found while resuming teach.',
        badSchema: 'Triaged session file is malformed while resuming teach.',
      },
      'session',
    ),
  );
}

// ─── Interactive prompts for missing CLI args ───────────────────────────────

function validateSiteName(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return 'Site name is required.';
  if (/[\s/\\]/.test(v))
    return 'No spaces or slashes — site becomes a folder name under ~/.imprint/.';
  return undefined;
}

async function resolveSite(opts: TeachOptions): Promise<string> {
  if (opts.site) return opts.site;
  // cli.ts already errors out when --no-interactive is set without a site,
  // so reaching here means we're free to prompt.
  const answer = await p.text({
    message: 'What should we name this site?',
    placeholder: 'google-flights',
    validate: validateSiteName,
  });
  if (p.isCancel(answer)) {
    p.outro('Cancelled.');
    process.exit(0);
  }
  return (answer as string).trim();
}

function validateStartUrl(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined; // allow empty → falls back to about:blank
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'URL must start with http:// or https://';
    }
  } catch {
    return 'Not a valid URL.';
  }
  return undefined;
}

async function resolveStartUrl(opts: TeachOptions): Promise<string | undefined> {
  if (opts.url) return opts.url;
  if (opts.noInteractive) return undefined;
  const answer = await p.text({
    message: 'Starting URL? (leave blank for about:blank)',
    placeholder: 'https://www.example.com',
    validate: validateStartUrl,
  });
  if (p.isCancel(answer)) {
    p.outro('Cancelled.');
    process.exit(0);
  }
  const trimmed = (answer as string).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface TeachProviderPickerOption {
  value: string;
  label: string;
  hint?: string;
}

interface TeachProviderPickerIO {
  select: (opts: {
    message: string;
    options: TeachProviderPickerOption[];
  }) => Promise<string | symbol>;
  note: (message: string, title?: string) => void;
  isCancel: (value: unknown) => boolean;
}

function assertTeachProvider(name: ProviderName): void {
  if (isTeachCompatibleProvider(name)) return;
  const status = getProviderStatuses().find((s) => s.name === name);
  throw new Error(
    [
      `provider "${name}" is not supported for \`imprint teach\` compile yet.`,
      status?.reason ? `detected status: ${status.reason}` : undefined,
      '→ use one of: claude-cli, codex-cli, anthropic-api',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function resolveTeachProvider(opts: TeachOptions): Promise<ProviderName> {
  if (opts.provider) {
    assertTeachProvider(opts.provider);
    return opts.provider;
  }

  if (opts.noInteractive) {
    const provider = detectTeachProvider();
    assertTeachProvider(provider);
    return provider;
  }

  const statuses = getProviderStatuses();
  const detectedCompatible = statuses.filter((s) => s.detected && s.availableForTeach);
  const onlyCompatible = detectedCompatible[0];
  if (detectedCompatible.length === 1 && onlyCompatible) return onlyCompatible.name;
  return await promptForTeachProvider(statuses);
}

export function buildTeachProviderPickerOptions(
  statuses: ProviderStatus[],
): TeachProviderPickerOption[] {
  return statuses.map((status) => {
    if (status.detected && status.availableForTeach) {
      return {
        value: `use:${status.name}`,
        label: `${status.name} (detected)`,
        hint: status.reason,
      };
    }
    if (status.detected) {
      return {
        value: `setup:${status.name}`,
        label: `${status.name} (detected, not available for teach)`,
        hint: status.reason,
      };
    }
    return {
      value: `setup:${status.name}`,
      label: `${status.name} (not detected, setup help)`,
      hint: status.reason,
    };
  });
}

export async function promptForTeachProvider(
  statuses: ProviderStatus[],
  io: TeachProviderPickerIO = {
    select: (opts) => p.select({ message: opts.message, options: opts.options }),
    note: (message, title) => p.note(message, title),
    isCancel: p.isCancel,
  },
): Promise<ProviderName> {
  while (true) {
    const choice = await io.select({
      message: 'Which LLM provider should compile this workflow?',
      options: buildTeachProviderPickerOptions(statuses),
    });
    if (io.isCancel(choice)) {
      p.outro('Cancelled.');
      process.exit(0);
    }

    const [action, rawName] = String(choice).split(':') as ['use' | 'setup', ProviderName];
    const status = statuses.find((s) => s.name === rawName);
    if (action === 'use' && status?.availableForTeach) return rawName;

    if (status) {
      io.note([status.reason, '', status.setupHint].join('\n'), `${status.name} setup`);
    }
  }
}

async function promptForModel(provider: ProviderName): Promise<string> {
  const { availableModelsForProvider } = await import('./llm.ts');
  const models = availableModelsForProvider(provider);
  if (models.length <= 1) return models[0]?.model ?? 'claude-opus-4-8';

  const choice = await p.select({
    message: 'Which model should compile this workflow?',
    options: models.map((m) => ({
      value: m.model,
      label: m.isDefault ? `${m.model} (default)` : m.model,
    })),
    initialValue: models.find((m) => m.isDefault)?.model,
  });
  if (p.isCancel(choice)) {
    p.outro('Cancelled.');
    process.exit(0);
  }
  return String(choice);
}

// ─── Main teach function ────────────────────────────────────────────────────

export async function teach(opts: TeachOptions): Promise<TeachResult> {
  const site = await resolveSite(opts);
  p.intro(`imprint teach — teaching your agent to use ${site}`);

  const state = loadTeachState(site);

  // Rename legacy _orphan_ keys to human-readable names.
  for (const key of Object.keys(state.workflows)) {
    if (!key.startsWith('_orphan_')) continue;
    const ws = state.workflows[key];
    if (!ws) continue;
    const newKey = `session from ${friendlySessionTimestamp(ws.sessionPath)}`;
    delete state.workflows[key];
    state.workflows[newKey] = ws;
  }

  // Pick up sessions that were recorded but never tracked (e.g., old teach
  // runs or manual `imprint record` invocations).
  const orphan = discoverOrphanSession(site, state);
  if (orphan) {
    const key = `session from ${friendlySessionTimestamp(orphan.sessionPath)}`;
    if (!state.workflows[key]) state.workflows[key] = orphan;
  }

  const completedWorkflows = discoverCompletedWorkflows(site);
  const completedSet = new Set(completedWorkflows);
  if (pruneStalePendingTeachWorkflows(site, state)) {
    saveTeachState(site, state);
  }
  const incompleteWorkflows = Object.entries(state.workflows).filter(
    ([name]) => !completedSet.has(name),
  );

  // Decide what to do: resume, redo, or start fresh.
  let startFrom: Step = 'record';
  let workflowKey: string | null = null;
  let sessionPath: string | null = opts.fromSession ?? null;
  let redactedPath: string | null = null;
  let resumedTriagedPath: string | null = null;
  let usingFromSession = false;
  let resumesExistingRun = false;

  const hasExisting = completedWorkflows.length > 0 || incompleteWorkflows.length > 0;

  if (opts.fromStep === 'record') {
    // `--from-step record` / `--only record` is a non-interactive fresh start:
    // record produces everything, so it needs no prior run (assertResumableAt
    // always allows 'record'). Leave workflowKey/sessionPath null so a fresh
    // _pending_ run is minted below, exactly like a normal new run — bypassing
    // resolveStepStartTarget, which requires a prior run for any later step but
    // would wrongly reject 'record' on a fresh site.
    startFrom = 'record';
  } else if (opts.fromStep) {
    // Non-interactive phase resume: start at a specific step, reusing a prior
    // run's persisted outputs. resolveStepStartTarget picks the most-recent
    // workflow and THROWS if it didn't reach far enough (the dependency guard).
    const target = resolveStepStartTarget(site, state, opts.fromStep, opts.tool);
    resumesExistingRun = true;
    workflowKey = target.workflowKey;
    startFrom = opts.fromStep;
    sessionPath = resolveTeachStatePath(site, target.ws.sessionPath);
    redactedPath = resolveTeachStatePath(site, target.ws.redactedPath);
    // Resolve a derived artifact path (.triaged/.redacted) back to the original
    // recording so earlier-than-redact restarts operate on the full session.
    if (sessionPath) {
      const original = sessionPath.replace(/\.triaged/g, '').replace(/\.redacted/g, '');
      if (original !== sessionPath && isExistingFile(original)) {
        sessionPath = original;
        redactedPath = null;
      }
    }
    // startFrom is never 'record' here (handled by the branch above), so an
    // unresolved session means a completed workflow with no stored path — recover
    // the latest recording on disk.
    if (!sessionPath) {
      const orphan = discoverOrphanSession(site, state);
      if (orphan) {
        sessionPath = resolveTeachStatePath(site, orphan.sessionPath);
        redactedPath = resolveTeachStatePath(site, orphan.redactedPath);
      }
    }
  } else if (opts.fromSession) {
    startFrom = 'redact';
    sessionPath = pathResolve(opts.fromSession);
    usingFromSession = true;
  } else if (hasExisting && !opts.noInteractive) {
    const choice = await promptResumeChoice(site, completedWorkflows, incompleteWorkflows);
    if (p.isCancel(choice)) {
      p.outro('Cancelled.');
      process.exit(0);
    }

    if (choice.action === 'new') {
      startFrom = 'record';
    } else if (choice.action === 'continue') {
      resumesExistingRun = true;
      workflowKey = choice.workflowKey;
      const ws = state.workflows[workflowKey];
      if (!ws) {
        throw new Error(
          `No state found for workflow "${workflowKey}" — try starting a new workflow.`,
        );
      }
      startFrom = nextStep(ws.completedSteps);
      sessionPath = resolveTeachStatePath(site, ws.sessionPath);
      redactedPath = resolveTeachStatePath(site, ws.redactedPath);
    } else if (choice.action === 'redo') {
      workflowKey = choice.workflowKey;
      startFrom = choice.fromStep;
      resumesExistingRun = startFrom !== 'record';
      const ws = state.workflows[workflowKey];
      if (ws) {
        sessionPath = resolveTeachStatePath(site, ws.sessionPath);
        redactedPath = resolveTeachStatePath(site, ws.redactedPath);
        // If the stored sessionPath is a derived artifact (.triaged.json,
        // .triaged.redacted.json), resolve back to the original recording
        // so redo-from-redact operates on the full session.
        if (sessionPath) {
          const original = sessionPath
            .replace(/\.triaged/g, '')
            .replace(/\.redacted/g, '')
            .replace(/\.json$/, '.json');
          if (original !== sessionPath && isExistingFile(original)) {
            sessionPath = original;
            redactedPath = null;
          }
        }
      }
      if (!sessionPath && startFrom !== 'record') {
        // Completed workflow with no state — find the latest session.
        const orphan = discoverOrphanSession(site, state);
        if (orphan) {
          sessionPath = resolveTeachStatePath(site, orphan.sessionPath);
          redactedPath = resolveTeachStatePath(site, orphan.redactedPath);
        }
      }
    }
  }

  const startIdx = STEPS.indexOf(startFrom);
  const runPolicy = resolvedTeachRunPolicy(startFrom, resumesExistingRun);
  // Upper bound of the phase window: `--to-step`/`--only` stop the chain after a
  // given step (default = the last step, i.e. run to the end). A phase runs only
  // when it falls within [startFrom, toStep].
  const stopIdx = opts.toStep ? STEPS.indexOf(opts.toStep) : STEPS.length - 1;
  // Backwards-window guard for the one path the CLI validation can't see: an
  // interactive resume (continue/redo) can pick a startFrom AFTER --to-step (e.g.
  // `--to-step redact`, then "continue" a workflow whose next step is generate),
  // producing an empty window that would silently run nothing and print a
  // backwards "generate → redact" summary. (Explicit --from-step/--to-step
  // ordering is already validated in resolveTeachPhaseWindow.)
  if (opts.toStep && startIdx > stopIdx) {
    throw new Error(
      `The workflow resumes at "${startFrom}", which is after --to-step "${opts.toStep}" — nothing would run. ` +
        `Re-run without --to-step, or with --to-step "${startFrom}" or later.`,
    );
  }
  /** True when `step` is inside the [startFrom, toStep] window. Replaces the bare
   *  `startIdx <= idx(step)` phase gates so a phase can also be skipped when it's
   *  PAST the requested stop step. */
  const inWindow = (step: Step): boolean => {
    const i = STEPS.indexOf(step);
    return startIdx <= i && i <= stopIdx;
  };
  /** Stop the run early when `--to-step`/`--only` bounded the window before the
   *  normal end. Used at each phase-group boundary so the full-compile tail never
   *  runs on a partial. Reports what ran; exits 0 (the CLI ignores the return). */
  const finishEarly = async (lastStep?: Step): Promise<never> => {
    // `lastStep` overrides the reported stop when the actual last phase differs
    // from stopIdx — the per-tool compile is atomic, so a --to-step inside it
    // (generate/compile-playbook) actually runs through emit. Report it honestly.
    p.outro(
      `Ran teach phases ${startFrom} → ${lastStep ?? STEPS[stopIdx]} for ${site}; stopped here (--to-step/--only).`,
    );
    // Flush OpenTelemetry spans before exiting: process.exit(0) bypasses the CLI's
    // shutdownTracing() (run in its .then() handler), which would otherwise lose
    // batched spans for windowed (--to-step/--only) runs when IMPRINT_TRACE=1.
    // Guard the flush so a shutdown error can't prevent the exit (this is typed
    // Promise<never> and callers rely on it never returning).
    try {
      await shutdownTracing();
    } catch {
      /* best-effort flush — exit regardless */
    }
    process.exit(0);
  };
  const spinner = p.spinner();
  let resolvedProviderName: ProviderName | null = null;
  const getProviderName = async (): Promise<ProviderName> => {
    resolvedProviderName ??= await resolveTeachProvider(opts);
    return resolvedProviderName;
  };
  let resolvedModel: string | null = null;
  const getModel = async (): Promise<string> => {
    if (resolvedModel) return resolvedModel;
    const providerName = await getProviderName();
    if (opts.model) {
      resolvedModel = opts.model;
    } else if (!opts.noInteractive) {
      resolvedModel = await promptForModel(providerName);
    } else {
      const { resolveCompileAgentModel } = await import('./compile-agent.ts');
      resolvedModel = resolveCompileAgentModel(providerName);
    }
    return resolvedModel;
  };

  // Temp key for state tracking before we know the toolName.
  if (!workflowKey) {
    workflowKey = `_pending_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }

  if (startFrom === 'redact') {
    sessionPath = requireSessionFile(sessionPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'raw',
    });
  } else if (
    startFrom === 'replay-and-diff' ||
    startFrom === 'triage' ||
    startFrom === 'detect-candidates' ||
    startFrom === 'generate' ||
    startFrom === 'compile-playbook'
  ) {
    if (!redactedPath && sessionPath) {
      redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    }
    redactedPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
  }

  if (usingFromSession && sessionPath) {
    checkpoint(
      site,
      state,
      workflowKey,
      buildTeachStateFromSession(site, sessionPath, redactedPath),
    );
  }

  if (startIdx <= STEPS.indexOf('compile-playbook') && stopIdx >= STEPS.indexOf('triage')) {
    await getProviderName();
  }

  // ── 1. Record ──────────────────────────────────────────────────────
  if (inWindow('record')) {
    const startUrl = await resolveStartUrl(opts);

    spinner.start('Recording');
    spinner.stop('Ready to record.');
    console.log('');

    const recordResult = await traced(
      'teach.record',
      'CHAIN',
      { 'imprint.site': site, 'imprint.url': startUrl },
      async (span) => {
        const res = await record({
          site: site,
          url: startUrl,
          persistProfile: opts.persistProfile,
          signal: opts.signal,
        });
        setSpanAttributes(span, { 'imprint.record.event_count': res.count });
        return res;
      },
    );
    sessionPath = recordResult.sessionPath;

    checkpoint(site, state, workflowKey, {
      sessionPath: toRelative(site, sessionPath),
      completedSteps: ['record'],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // ── 1b. Combine with past sessions (optional) ──────────────────────
  // Runs after recording OR when --from-session is provided. Skipped when
  // resuming from a checkpoint (the checkpoint already stores the final
  // session path, possibly combined from a previous run).
  if (sessionPath && (startIdx <= STEPS.indexOf('record') || usingFromSession)) {
    const isCombinedSession = pathBasename(sessionPath).startsWith('combined-');
    if (!isCombinedSession) {
      const originalSessionPath = sessionPath;
      sessionPath = await combineAvailableSessions({
        site,
        currentSessionPath: sessionPath,
        noInteractive: opts.noInteractive ?? false,
        fromSession: usingFromSession,
      });
      if (sessionPath !== originalSessionPath) {
        checkpoint(site, state, workflowKey, {
          sessionPath: toRelative(site, sessionPath),
          completedSteps: ['record'],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  // ── 2. Redact ──────────────────────────────────────────────────────
  let teachCredentials: { site: string; values: Record<string, string> } | undefined;
  let credentialFindings: CredentialFinding[] = [];
  if (inWindow('redact')) {
    sessionPath = requireSessionFile(sessionPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'raw',
    });

    const session = loadJsonFile(
      sessionPath,
      SessionSchema,
      {
        notFound: 'Session file not found after recording.',
        badSchema: 'Session file is malformed.',
      },
      'session',
    );

    // Extract credentials from the raw session BEFORE redaction so we can
    // swap their values for ${credential.X} placeholders in the redacted
    // artifact.  ALL credential values are redacted for security.  The
    // actual storage prompt is deferred until after detect-candidates so
    // the LLM can determine which login attempt actually succeeded.
    const extracted = extractCredentials(session);
    credentialFindings = extracted.findings;
    const { replacements } = extracted;

    spinner.start('Redacting credentials');
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    const { stats } = await traced(
      'teach.redact',
      'CHAIN',
      { 'imprint.site': site },
      async (span) => {
        const pageMintedHeaders = detectPageMintedHeaders(session);
        const redaction = redactSession(session, {
          replacements,
          keepHeaders: pageMintedHeaders,
        });
        writeFileSync(
          redactedPath as string,
          `${JSON.stringify(redaction.session, null, 2)}\n`,
          'utf8',
        );
        setSpanAttributes(span, {
          'imprint.redact.totalRedactions': redaction.stats.totalRedactions,
          'imprint.redact.requestsRedacted': redaction.stats.requestsRedacted,
          'imprint.redact.cookiesRedacted': redaction.stats.cookiesRedacted,
          'imprint.redact.placeholdersInjected': redaction.stats.placeholdersInjected,
          'imprint.redact.freeformRedactions': redaction.stats.freeformRedactions,
        });
        return redaction;
      },
    );
    const placeholderNote =
      stats.placeholdersInjected > 0
        ? `, ${stats.placeholdersInjected} replaced with credential placeholders`
        : '';
    const freeformNote =
      stats.freeformRedactions > 0 ? `, ${stats.freeformRedactions} free-form finding(s)` : '';
    spinner.stop(
      `Redacted ${stats.totalRedactions} value(s) across ${stats.requestsRedacted} request(s) and ${stats.cookiesRedacted} cookie(s)${placeholderNote}${freeformNote}.`,
    );

    // Post-redact pairing audit: if any request body contained a
    // password-shaped field but credential extraction failed to produce a
    // confirmed username+password pair, the downstream compile stage will
    // template credentials as `${param.X}` instead of `${credential.X}` —
    // shipping a broken MCP tool that asks callers to provide credentials
    // by hand instead of pulling from the credential store.
    //
    // The most common reason is an unusual request framing (custom
    // Content-Type, unusual key naming) that the extractor's dictionaries
    // or parsers don't yet cover. Surface this loudly so the user can
    // either re-record, file a bug, or proceed knowing the tool needs
    // hand-editing.
    const warnings: string[] = [];
    const unpairedPasswordSeqs = findUnpairedPasswordRequests(session);
    if (unpairedPasswordSeqs.length > 0 && replacements.length === 0) {
      warnings.push('credentials_not_paired');
      const seqList = unpairedPasswordSeqs.slice(0, 5).join(', ');
      const more = unpairedPasswordSeqs.length > 5 ? ', …' : '';
      p.log.warn(
        [
          `Detected ${unpairedPasswordSeqs.length} request(s) with a password-shaped field (seqs: ${seqList}${more}) but no username+password pair was extracted.`,
          'The generated workflow will treat credentials as plain parameters and will NOT pull from the credential store.',
          'This usually means the request body uses an unusual framing (Content-Type, key naming, multipart variant) the extractor did not recognise.',
          `→ Recommended: file a bug with the redacted session at ${toRelative(site, redactedPath)}, then re-record once the extractor is fixed.`,
          '→ To proceed anyway, just continue — the tool will need manual credential wiring before it works.',
        ].join('\n'),
      );
    }

    updateCheckpoint(site, state, workflowKey, 'redact', {
      redactedPath: toRelative(site, redactedPath),
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  if (!redactedPath) {
    redactedPath = sessionPath ? sessionPath.replace(/\.json$/, '.redacted.json') : null;
  }

  // Only require the redacted session once a phase that consumes it is in the
  // window. A `--to-step record|redact` window stops before triage (the
  // first consumer), so `.redacted.json` may not exist yet — the finishEarly()
  // just below handles the clean stop. Without the stopIdx guard, `--to-step
  // record` throws on the missing file before ever reaching that early-exit.
  if (startIdx <= STEPS.indexOf('generate') && stopIdx >= STEPS.indexOf('triage')) {
    redactedPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
  }

  // ── 2b+3. Triage → (Replay || Detect → Select) — deep parallelism ──
  //
  // Triage is the safety boundary: its durable artifact and checkpoint must
  // exist before replay can launch a browser. Once that boundary is complete,
  // replay-and-diff (~2 min) and detect→select (~30s) can run in parallel.
  let siteClassifications: ClassifiedValue[] | undefined;
  let triageResult: TriageResult | undefined;
  // Early stop: `--to-step record|redact` finishes before the analysis block.
  if (stopIdx < STEPS.indexOf('triage')) await finishEarly();

  let plans: CandidateCompilePlan[];
  let candidateBackedResume = false;

  // The triage→replay→detect-candidates stages share orchestration and the
  // triaged session, while the requested phase window still bounds which stages
  // run. The block is entered whenever [startFrom, toStep] overlaps that range.
  const runsAnalysis = analysisBlockRunsForWindow(startIdx, stopIdx);
  let needsReplay = runsAnalysis && inWindow('replay-and-diff') && !opts.skipReplay;
  const needsCandidates = runsAnalysis && inWindow('detect-candidates');

  if (needsReplay && !opts.noInteractive) {
    const runReplay = await p.confirm({
      message:
        'Run the replay stage? This replays your flow in a fresh browser session to identify browser-minted tokens, CSRF values, and other ephemeral parameters. It can take a couple of minutes but improves workflow accuracy.',
      initialValue: true,
    });
    if (p.isCancel(runReplay) || !runReplay) {
      needsReplay = false;
    }
  }

  if (!needsReplay && inWindow('replay-and-diff')) {
    p.log.warn(
      "Skipping replay-and-diff stage. The compile agent won't be able to distinguish browser-minted values (timestamps, CSRF tokens) from constants — this may reduce workflow accuracy for sites with ephemeral request parameters.",
    );
  }

  if (runsAnalysis) {
    const replaySessionPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });

    // Resolve provider eagerly so triage/detect don't block on prompt mid-parallel
    if (inWindow('triage') || needsCandidates) await getProviderName();

    muteLog();
    try {
      const mp = new MultiProgress();

      // ── triage safety boundary ──
      // Complete and persist triage before either downstream branch starts.
      // Replay consumes the full redacted recording plus this decision; candidate
      // detection consumes the narrower triaged artifact.
      let localTriageResult: TriageResult | undefined;
      let localTriagedPath: string | null = null;
      if (inWindow('triage')) {
        const triageSession = loadJsonFile(
          replaySessionPath,
          SessionSchema,
          {
            notFound: 'Redacted session file not found before triage.',
            badSchema: 'Redacted session file is malformed.',
          },
          'session',
        );
        const providerName = await getProviderName();
        const model = await getModel();
        mp.pause();
        mp.clear();
        const credentialSeqs = findCredentialBearingSeqs(triageSession);
        const authAdjacentSeqs = findAuthAdjacentSeqs(triageSession, credentialSeqs);
        const allLoginSeqs = [...new Set([...credentialSeqs, ...authAdjacentSeqs])];
        spinner.start('Triaging requests');
        localTriageResult = await triageRequests(
          triageSession,
          {
            provider: providerName,
            model,
          },
          allLoginSeqs.length > 0
            ? {
                sharedContext: {
                  loginRequestSeqs: credentialSeqs,
                  credentialNames: [],
                  tokenExtractionNotes: '',
                  sharedHelperNotes: '',
                  authRequestSeqs: allLoginSeqs,
                  authNotes: '',
                },
              }
            : {},
        );
        spinner.stop(
          `Triaged to ${localTriageResult.selectedSeqs.length} requests (from ${triageSession.requests.length}).`,
        );
        mp.resume();

        localTriagedPath = replaySessionPath.replace(/\.redacted\.json$/, '.triaged.json');
        writeFileSync(
          localTriagedPath,
          `${JSON.stringify(localTriageResult.session, null, 2)}\n`,
          'utf8',
        );
        // Candidate detection and browser replay are separate failure boundaries.
        // Persist now so Continue/Redo can reuse the safety decision even if either
        // downstream branch fails.
        updateCheckpoint(site, state, workflowKey, 'triage', {
          triagedPath: toRelative(site, localTriagedPath),
        });
      } else {
        const ws = state.workflows[workflowKey];
        localTriagedPath = resolveWorkflowTriagedPath(site, ws);
        if (ws && localTriagedPath && !ws.triagedPath) {
          updateCheckpoint(site, state, workflowKey, 'triage', {
            triagedPath: toRelative(site, localTriagedPath),
          });
        }
        if (localTriagedPath) {
          localTriageResult = loadTriageResultFromTriagedPath(localTriagedPath);
        }
      }

      if (!localTriageResult || !localTriagedPath) {
        throw new Error(
          'A current triage artifact is required before replay or candidate detection. Re-run from "triage".',
        );
      }

      // A triage-only window ends at the durable safety boundary. Do not start
      // either downstream promise after the requested stop point.
      if (stopIdx < STEPS.indexOf('replay-and-diff')) {
        mp.clear();
        await finishEarly();
      }

      if (!needsReplay && inWindow('replay-and-diff')) {
        updateCheckpoint(site, state, workflowKey, 'replay-and-diff', {});
      }

      // Branch A: replay-and-diff (slow, ~2 min)
      const replayPromise = (async () => {
        if (!needsReplay) {
          const classPath = pathJoin(localSiteDir(site), '.classifications.json');
          const cached = loadCachedClassificationsForSession(
            classPath,
            replaySessionPath,
            replaySafetyIdentity(localTriageResult),
          );
          if (!cached && existsSync(classPath)) {
            p.log.warn(
              'Ignoring cached replay classifications because they belong to a different recording or triage safety decision.',
            );
          }
          return cached;
        }
        return siteReplayAndDiff(site, replaySessionPath, localTriagedPath, localTriageResult, mp);
      })();

      // Branch B: detect-candidates → user selection (fast, ~30s)
      type CandidateChainResult =
        | {
            triageResult?: TriageResult;
            plans: CandidateCompilePlan[];
          }
        | {
            triageResult?: TriageResult;
            detection: Awaited<ReturnType<typeof detectTeachCandidates>>;
            preliminarySelected: ToolCandidate[];
            baseState: WorkflowState;
            pendingKey: string | null;
          };
      const candidatePromise = (async (): Promise<CandidateChainResult> => {
        if (!needsCandidates) {
          const ws = state.workflows[workflowKey];
          return {
            triageResult: localTriageResult,
            plans: [
              {
                workflowKey,
                startFrom,
                candidate: ws?.candidate,
                sharedContext: ws?.sharedContext,
              },
            ],
          };
        }

        // ── detect candidates ──
        const compileSessionPath = requireSessionFile(localTriagedPath ?? redactedPath, {
          site,
          workflowKey,
          startFrom,
          kind: localTriagedPath ? 'triaged' : 'redacted',
        });
        const providerName = await getProviderName();
        const model = await getModel();
        mp.pause();
        mp.clear();
        spinner.start('Detecting candidate tools');
        const detected = await detectTeachCandidates({
          sessionPath: compileSessionPath,
          providerName,
          model,
          trustSessionScope: !!localTriagedPath,
        });
        const detection = detected;
        spinner.stop(
          `Detected ${detection.candidates.length} candidate tool${detection.candidates.length === 1 ? '' : 's'}.`,
        );

        // ── interactive selection — keep mp paused during prompt ──
        const selected = await selectTeachCandidates(detection, opts);
        mp.resume();

        // ── Credential prompt (deferred until here so the LLM decides which login succeeded) ──
        const llmLoginSeqs = new Set(detection.sharedContext?.loginRequestSeqs ?? []);
        if (credentialFindings.length > 0 && llmLoginSeqs.size > 0) {
          const isPlaceholder = (v: string) => /^\$\{credential\./.test(v);
          const validFindings = credentialFindings.filter(
            (f) =>
              llmLoginSeqs.has(f.requestSeq) &&
              !isPlaceholder(f.usernameValue) &&
              !isPlaceholder(f.passwordValue),
          );
          if (validFindings.length > 0) {
            // De-dup by username — keep the last (most recent password)
            const byUser = new Map<string, CredentialFinding>();
            for (const f of validFindings) byUser.set(f.usernameValue, f);
            const candidates = [...byUser.values()];
            const finding = candidates[candidates.length - 1] as CredentialFinding;

            const maskedUser = maskUsername(finding.usernameValue);
            p.note(
              [
                'Detected a successful login in this recording.',
                `  username: ${maskedUser}`,
                `  password: ${'*'.repeat(Math.min(finding.passwordValue.length, 16))}`,
                `  request:  ${finding.requestLabel}`,
                '',
                'Imprint will store these credentials in your local credential manager',
                '(OS keychain when available, libsodium-encrypted file otherwise).',
              ].join('\n'),
              'Credential capture',
            );

            let shouldStore = true;
            if (!opts.noInteractive) {
              const proceed = await p.confirm({
                message: `Save credentials for "${site}" to the credential manager?`,
                initialValue: true,
              });
              shouldStore = !p.isCancel(proceed) && !!proceed;
            }

            if (shouldStore) {
              await persistFinding({ site, finding });
              teachCredentials = {
                site,
                values: {
                  [finding.usernameName]: finding.usernameValue,
                  [finding.passwordName]: finding.passwordValue,
                },
              };
            } else {
              p.log.warn('Skipping credential save — workflow will not be able to log in.');
            }
          }
        }

        const pendingKey = workflowKey.startsWith('_pending_') ? workflowKey : null;
        const rawSessionPath = requireSessionFile(sessionPath, {
          site,
          workflowKey,
          startFrom,
          kind: 'raw',
        });
        const baseState = buildTeachStateFromSession(site, rawSessionPath, redactedPath);
        if (localTriagedPath) {
          baseState.triagedPath = toRelative(site, localTriagedPath);
        }
        return {
          triageResult: localTriageResult,
          detection,
          preliminarySelected: selected,
          baseState,
          pendingKey,
        };
      })();

      // Wait for candidate chain (includes user interaction)
      const candidateResult = await candidatePromise;
      triageResult = candidateResult.triageResult;

      // Wait for replay — may already be done, or show progress while waiting
      let replaySettled = false;
      replayPromise.then(
        () => {
          replaySettled = true;
        },
        () => {
          replaySettled = true;
        },
      );
      await new Promise((r) => setTimeout(r, 0));
      const showedSpinner = !replaySettled;
      if (showedSpinner) {
        spinner.start('Waiting for replay to finish');
      }
      siteClassifications = await replayPromise;
      if (showedSpinner) {
        spinner.stop('Replay complete.');
      }

      mp.clear();

      if ('plans' in candidateResult) {
        plans = candidateResult.plans;
      } else {
        const finalizedSelection = finalizeTeachCandidateSelection(
          candidateResult.detection.candidates,
          candidateResult.preliminarySelected.map((candidate) => candidate.toolName),
          siteClassifications,
        );
        const candidates = finalizedSelection.candidates;
        const finalDetection = { ...candidateResult.detection, candidates };
        const notice = formatTeachCandidateAutoAddNotice(finalizedSelection.autoAdded, 'replay');
        if (notice) p.note(notice.body, notice.title);
        for (const cycle of finalizedSelection.cycles) {
          p.log.warn(`Tool dependency cycle detected: ${cycle.join(' → ')}`);
        }

        const sharedContext = buildCandidateSharedCompileContext(
          finalDetection,
          finalizedSelection.selected,
        );
        const classificationsHash = classificationsPlanningHash(siteClassifications);
        const selectedNames = new Set(
          finalizedSelection.selected.map((candidate) => candidate.toolName),
        );
        const selectionChanged = candidateSelectionChanged(
          state,
          candidateResult.baseState.sessionPath,
          finalizedSelection.selected,
          sharedContext,
          classificationsHash,
        );
        pruneUnselectedCandidateWorkflows(
          state,
          candidateResult.baseState.sessionPath,
          selectedNames,
        );
        plans = finalizedSelection.selected.map((candidate) => {
          checkpoint(site, state, candidate.toolName, {
            ...candidateResult.baseState,
            // Preserve prior progress only when re-detecting the SAME recording, so
            // a re-run of the analysis block doesn't regress a tool that already
            // reached generate…register. A different recording must not inherit the
            // old plan-prereqs marker or shared-module build.
            completedSteps: detectCandidatesCompletedSteps(
              selectionChanged ? undefined : state.workflows[candidate.toolName],
              candidateResult.baseState.sessionPath,
            ),
            candidate,
            sharedContext,
            classificationsHash,
          });
          return {
            workflowKey: candidate.toolName,
            startFrom: 'generate' as Step,
            candidate,
            sharedContext,
          };
        });
        if (candidateResult.pendingKey && state.workflows[candidateResult.pendingKey]) {
          delete state.workflows[candidateResult.pendingKey];
          saveTeachState(site, state);
        }
      }

      // Checkpoints — write sequentially after both complete
      updateCandidateStageCheckpoints({
        site,
        state,
        plans,
        fallbackWorkflowKey: workflowKey,
        replay: needsReplay
          ? {
              classificationsPath: siteClassifications
                ? toRelative(site, pathJoin(localSiteDir(site), '.classifications.json'))
                : undefined,
            }
          : undefined,
      });
    } finally {
      unmuteLog();
    }
  } else {
    // Resuming from generate or later — load cached data
    const classPath = pathJoin(localSiteDir(site), '.classifications.json');
    const ws = state.workflows[workflowKey];
    const resolvedTriagedPath = resolveWorkflowTriagedPath(site, ws);
    resumedTriagedPath = resolvedTriagedPath;
    if (
      ws &&
      resolvedTriagedPath &&
      resolveTeachStatePath(site, ws.triagedPath) !== resolvedTriagedPath
    ) {
      updateCheckpoint(site, state, workflowKey, 'triage', {
        triagedPath: resolvedArtifactCheckpointPath(site, ws.triagedPath, resolvedTriagedPath),
      });
    }
    if (resolvedTriagedPath) triageResult = loadTriageResultFromTriagedPath(resolvedTriagedPath);
    if (redactedPath && triageResult) {
      siteClassifications = loadCachedClassificationsForSession(
        classPath,
        redactedPath,
        replaySafetyIdentity(triageResult),
      );
    }
    // A candidate-backed resume reconstructs the prior run's tools from persisted
    // state (shared-module planning may need ≥2 tools). This applies both to an
    // explicit `--from-step` and to the interactive Continue/Redo paths.
    // Resume defaults to the full persisted set. --primary-tool narrows to the
    // primary candidate plus its upstream dependency closure.
    // selectMultiToolResumePlans scopes reconstruction to the same recording as the
    // resume target and to tools that actually reached `startFrom`'s prerequisites,
    // so a sibling from a different run can't be compiled against the wrong session
    // and one that failed earlier can't crash loading a missing artifact.
    candidateBackedResume = isCandidateBackedResume(ws);
    const allCandidatePlans: CandidateCompilePlan[] = [];
    if (candidateBackedResume) {
      let plannedToolNames: Set<string> | undefined;
      const persistedBuildPlanPath = resolveTeachStatePath(site, ws?.buildPlanPath);
      if (persistedBuildPlanPath && existsSync(persistedBuildPlanPath)) {
        const persistedBuildPlan = readBuildPlanFile(persistedBuildPlanPath);
        if (persistedBuildPlan) {
          plannedToolNames = new Set(persistedBuildPlan.perTool.map((tool) => tool.toolName));
        }
      }
      const selection = selectMultiToolResumePlans(state, workflowKey, startFrom, {
        primaryTool: opts.primaryTool,
        toolName: opts.tool,
        plannedToolNames,
      });
      for (const { workflowKey: skippedKey, reason } of selection.skipped) {
        p.log.warn(
          reason === 'different-recording'
            ? `Skipping tool "${skippedKey}" while resuming from ${startFrom}: it belongs to a different recording than the resume target.`
            : reason === 'not-in-build-plan'
              ? `Skipping tool "${skippedKey}" while resuming from ${startFrom}: it is not in the current build plan.`
              : `Skipping tool "${skippedKey}" while resuming from ${startFrom}: its prior run didn't reach "${startFrom}" — resume an earlier step or re-run it.`,
        );
      }
      for (const cycle of selection.cycles) {
        p.log.warn(`Tool dependency cycle detected: ${cycle.join(' → ')}`);
      }
      for (const sel of selection.plans) {
        allCandidatePlans.push({
          workflowKey: sel.workflowKey,
          startFrom,
          candidate: sel.candidate,
          sharedContext: sel.sharedContext,
        });
      }
    }
    if (candidateBackedResume && allCandidatePlans.length === 0) {
      throw new Error(
        `Cannot resume from "${startFrom}": the selected recording has no resumable candidates. Re-run from "detect-candidates".`,
      );
    }
    plans = candidateBackedResume
      ? allCandidatePlans
      : [{ workflowKey, startFrom, candidate: ws?.candidate, sharedContext: ws?.sharedContext }];
  }

  // Early stop: `--to-step triage|replay-and-diff|detect-candidates` finishes
  // after the requested analysis phase, before shared-module planning / compile
  // (the compile unit below remains atomic).
  if (stopIdx < STEPS.indexOf('plan-prereqs')) await finishEarly();

  const needsCompileProvider = plans.some(
    (plan) => STEPS.indexOf(plan.startFrom) <= STEPS.indexOf('compile-playbook'),
  );
  const compileProviderName = needsCompileProvider
    ? await getProviderName()
    : ('claude-cli' as ProviderName);
  let compileModel = '';
  if (needsCompileProvider) {
    compileModel = await getModel();
    const timeoutMs = opts.maxDurationMs ?? 20 * 60 * 1000;
    const timeoutDisplay =
      timeoutMs >= 3_600_000
        ? `${Math.round(timeoutMs / 3_600_000)}h`
        : timeoutMs >= 60_000
          ? `${Math.round(timeoutMs / 60_000)}m`
          : `${Math.round(timeoutMs / 1000)}s`;
    p.note(
      [
        `Provider: ${compileProviderName}    Model: ${compileModel}`,
        `Timeout: ${timeoutDisplay} per tool`,
        '',
        plans.length === 1
          ? 'An LLM agent will reverse-engineer the API response format,'
          : `${plans.length} LLM compile agents will reverse-engineer selected tools with concurrency ${COMPILE_CONCURRENCY},`,
        'write the MCP server, and run thorough verification tests.',
        'Most complex tools take 10-15 minutes — please be patient.',
        `Timeout: ${timeoutDisplay} per tool. You can interrupt with Ctrl-C.`,
        ...(plans.length > 1
          ? [
              '',
              'Shared helper modules are planned + built once under _shared/ before',
              'the tools compile, so each tool reuses them. Set IMPRINT_NO_BUILD_PLAN=1',
              'to disable and compile every tool independently.',
            ]
          : []),
        '',
        'To persist the generated tests after compilation, set IMPRINT_KEEP_TEST=1',
        'or pass --keep-test.',
      ].join('\n'),
      'Compile step',
    );
  }

  // Prefer the triaged session for compile (data AND auth tools). Triage keeps
  // every load-bearing, auth, and DOM-event the agents need (events are kept in
  // full) while dropping the bulk of telemetry/asset/noise requests — e.g. 415
  // vs 4396 requests on a big multi-tool site. Handing the agent the entire
  // redacted recording instead makes it burn its turn/time budget exploring
  // thousands of irrelevant requests (large auth recordings otherwise may never converge on a
  // playbook because of this). The detect-candidates summary already triages;
  // this aligns the compile session with it.
  const compileSessionArtifact = selectCompileSessionArtifact(resumedTriagedPath, redactedPath);
  const compileSessionPath = requireSessionFile(compileSessionArtifact.path, {
    site,
    workflowKey: plans[0]?.workflowKey ?? workflowKey,
    startFrom,
    kind: compileSessionArtifact.triaged ? 'triaged' : 'redacted',
  });

  // ── Clean up stale tools from previous teach runs ──
  // Skipped on every resume, including interactive Continue/Redo: a resume is scoped to a subset of
  // the site's tools (selectMultiToolResumePlans intentionally leaves other
  // recordings' tools — and same-recording tools that didn't reach the step —
  // alone), so "not in the resume set" does NOT mean "stale". Treating it as stale
  // here would silently rmSync a tool the resume just promised to preserve. Cleanup
  // only applies to a fresh run that produces a superseding tool set.
  const incomingToolNames = new Set(plans.map((pl) => pl.candidate?.toolName ?? pl.workflowKey));
  const staleTools = staleCompletedToolsForRun(
    discoverCompletedWorkflows(site),
    incomingToolNames,
    runPolicy.cleanupStaleTools,
  );
  if (staleTools.length > 0) {
    let shouldReplace = true;
    if (!opts.noInteractive) {
      const answer = await p.confirm({
        message: `Found ${staleTools.length} existing tool${staleTools.length === 1 ? '' : 's'} from previous runs. Replace with the ${incomingToolNames.size} new tool${incomingToolNames.size === 1 ? '' : 's'}?`,
        initialValue: true,
      });
      if (p.isCancel(answer)) throw new Error('Cancelled.');
      shouldReplace = answer;
    }
    if (shouldReplace) {
      for (const name of staleTools) {
        rmSync(localToolDir(site, name), { recursive: true, force: true });
        delete state.workflows[name];
      }
      saveTeachState(site, state);
    }
  }

  // ── plan-prereqs: plan + build shared modules once before the fan-out ──
  // Engages for ≥2 selected tools (to plan shared modules) OR when the recording
  // carries ANY login (with or without 2FA). The planner is the ONLY producer of
  // the build-plan `authTool`, so an authenticated single-tool site must still run
  // it — otherwise the login is detected but never compiled into a reusable auth
  // tool, and every data tool re-logs-in inline (hammering the site at compile
  // time). Resumes-past-generate are unchanged.
  const selectedCandidates = plans.map((pl) => pl.candidate).filter((c): c is ToolCandidate => !!c);
  const willGenerate = plans.some((pl) => STEPS.indexOf(pl.startFrom) <= STEPS.indexOf('generate'));
  // Detected login/auth → the planner must run (even for a single data tool) so it
  // emits the build-plan `authTool` the auth-compile block below consumes.
  const authDetected = plans.some((pl) => sharedContextHasAuth(pl.sharedContext));
  let buildPlanPath = '';
  let sharedModulesManifest: SharedModuleManifestEntry[] = [];
  const sidecar = buildPlanSidecarPath(site);
  const firstWs = state.workflows[plans[0]?.workflowKey ?? ''];
  // A bounded primary-only resume still belongs to its original multi-tool
  // build plan. Reuse that durable contract even though this invocation selects
  // one tool; otherwise its assigned shared modules and producer-token contract
  // silently disappear from the revision agent's context.
  const alreadyPlanned =
    runPolicy.reuseExistingBuildPlan &&
    plans.every((pl) => state.workflows[pl.workflowKey]?.completedSteps.includes('plan-prereqs')) &&
    existsSync(sidecar);
  if (willGenerate && compileModel && alreadyPlanned && firstWs) {
    buildPlanPath = sidecar;
    sharedModulesManifest = firstWs.sharedModules ?? [];
  } else if ((selectedCandidates.length >= 2 || authDetected) && willGenerate && compileModel) {
    // Mute raw `[imprint …]` logs from the planning subtree (build-plan,
    // teach-plan, prereq-builder) while the spinner is live — progress flows
    // through onProgress → spinner.message instead, matching the replay and
    // compile phases. The skip/timeout reason is surfaced cleanly below.
    muteLog();
    spinner.start('Planning shared modules');
    try {
      const prereq = await planAndBuildPrereqs({
        site,
        redactedSessionPath: compileSessionPath,
        candidates: selectedCandidates,
        sharedContext: plans[0]?.sharedContext,
        siteClassifications,
        providerName: compileProviderName,
        model: compileModel,
        onProgress: (msg) => spinner.message(msg),
      });
      buildPlanPath = prereq.buildPlanPath;
      sharedModulesManifest = prereq.sharedModules;
      const verified = sharedModulesManifest.filter((m) => m.verified).length;
      spinner.stop(
        buildPlanPath
          ? `Build plan ready (${verified}/${sharedModulesManifest.length} shared module${sharedModulesManifest.length === 1 ? '' : 's'} verified).`
          : 'Build plan skipped.',
      );
      if (prereq.skippedReason) p.log.warn(prereq.skippedReason);
    } catch (err) {
      spinner.stop('Build planning failed — compiling tools independently.');
      p.log.warn(
        `Build planning failed: ${err instanceof Error ? err.message : String(err)}\nTools will compile without shared modules.`,
      );
      buildPlanPath = '';
      sharedModulesManifest = [];
    } finally {
      unmuteLog();
    }
    for (const pl of plans) {
      updateCheckpoint(site, state, pl.workflowKey, 'plan-prereqs', {
        buildPlanPath: buildPlanPath ? toRelative(site, buildPlanPath) : undefined,
        sharedModules: sharedModulesManifest,
      });
    }
  }

  // Early stop: `--to-step plan-prereqs` finishes after shared-module planning,
  // before any tool (auth or data) compiles.
  if (stopIdx < STEPS.indexOf('generate')) await finishEarly();

  if (authDetected && willGenerate && !buildPlanPath) {
    throw new Error(
      'Authentication was detected, but auth planning did not produce a build plan. Data-tool compilation was not started.',
    );
  }

  // ── auth-tool: agentic compile loop + interactive 2FA ──
  if (buildPlanPath && willGenerate) {
    const buildPlan = readBuildPlanFile(buildPlanPath);
    if (buildPlan?.authTool) {
      const authPlan = buildPlan.authTool;
      const buildPlanHash = fileSha256(buildPlanPath);
      const existingAuthWorkflowPath = pathJoin(
        localToolDir(site, authPlan.toolName),
        'workflow.json',
      );
      const existingAuthIndexPath = pathJoin(localToolDir(site, authPlan.toolName), 'index.ts');
      const existingAuthWorkflow =
        existsSync(existingAuthWorkflowPath) && existsSync(existingAuthIndexPath)
          ? WorkflowSchema.parse(JSON.parse(readFileSync(existingAuthWorkflowPath, 'utf8')))
          : undefined;
      const storedAuthState = existingAuthWorkflow
        ? await loadSiteCredentials(site).catch(() => null)
        : null;
      const existingAuthWorkflowHash = existingAuthWorkflow
        ? authWorkflowHash(existingAuthWorkflow)
        : undefined;
      const reusableCompletion =
        existingAuthWorkflow &&
        existingAuthWorkflowHash &&
        storedAuthState &&
        hasDurableAuthState(existingAuthWorkflow, storedAuthState)
          ? plans
              .map((plan) => state.workflows[plan.workflowKey]?.authCompletion)
              .find((completion) =>
                authCompletionMatches(completion, {
                  toolName: authPlan.toolName,
                  buildPlanHash,
                  workflowHash: existingAuthWorkflowHash as string,
                }),
              )
          : undefined;
      if (reusableCompletion) {
        p.log.info(
          `Reusing verified auth tool "${authPlan.toolName}"; auth artifacts are unchanged.`,
        );
      } else {
        const redactedSession = SessionSchema.parse(
          JSON.parse(readFileSync(compileSessionPath, 'utf8')),
        );
        // A resumed generate step may still have valid credentials from an earlier
        // successful teach. Prefer those over values reconstructed from the old
        // recording so a stale recording cannot overwrite the credential store.
        if (!teachCredentials) {
          const view = await loadSiteCredentials(site).catch(() => null);
          const storedValues = selectCompleteAuthCredentials(
            view?.values ?? {},
            authPlan.credentialNames,
          );
          if (storedValues) {
            teachCredentials = { site, values: storedValues };
            if (authPlan.credentialNames.length > 0) {
              p.log.info(
                `Using stored credentials for "${site}": ${authPlan.credentialNames.join(', ')}`,
              );
            }
          }
        }

        // Passwordless / OTP-only logins (e.g. email + emailed code, magic link)
        // carry no password for the username+password extractor to pair, so
        // teachCredentials can be empty. If no complete stored set exists, derive
        // the planner-declared credential values from the recorded login request(s),
        // persist them, and back-fill ${credential.X} into the redacted session the
        // agent reads.
        if (!teachCredentials && sessionPath && existsSync(sessionPath)) {
          try {
            const rawForCreds = SessionSchema.parse(JSON.parse(readFileSync(sessionPath, 'utf8')));
            const derived = deriveLoginCredentials(
              rawForCreds,
              authPlan.credentialRequestSeqs,
              authPlan.credentialNames,
            );
            if (Object.keys(derived.values).length > 0) {
              const backend = await getCredentialBackend();
              for (const [name, value] of Object.entries(derived.values)) {
                await backend.setSecret(site, name, value);
                upsertManifestEntry(site, {
                  name,
                  kind: 'username',
                  description: 'Login identifier',
                });
              }
              applyCredentialPlaceholders(redactedSession, derived.replacements);
              teachCredentials = { site, values: derived.values };
              p.log.success(
                `Derived ${Object.keys(derived.values).length} credential(s) for passwordless login: ${Object.keys(derived.values).join(', ')}`,
              );
            }
          } catch (err) {
            p.log.warn(
              `Credential derivation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // The recording cannot always yield credentials because the capture layer
        // masks sensitive fields. Reuse a complete stored set or prompt for the
        // credential names identified during planning.
        if (!teachCredentials && !opts.noInteractive && authPlan.credentialNames.length > 0) {
          let detectedUsername: string | undefined;
          if (sessionPath && existsSync(sessionPath)) {
            try {
              detectedUsername = detectRecordedUsername(
                SessionSchema.parse(JSON.parse(readFileSync(sessionPath, 'utf8'))),
              );
            } catch {
              /* best-effort pre-fill only */
            }
          }
          teachCredentials = await promptForCredentials({
            site,
            names: authPlan.credentialNames,
            detectedUsername,
          });
        }

        if (!teachCredentials) {
          const hint = opts.noInteractive
            ? ` Set them with \`imprint credential set ${site} <name>\` (${authPlan.credentialNames.join(', ') || 'the login credentials'}), then resume with \`imprint teach ${site} --from-step generate\`.`
            : '';
          throw new Error(
            `Auth tool "${authPlan.toolName}" was planned but no credentials are available.${hint} Data-tool compilation was not started.`,
          );
        }

        spinner.start(`Compiling auth tool: ${authPlan.toolName}`);
        try {
          muteLog();
          const authResult = await compileAuthAgent({
            site,
            session: redactedSession,
            sessionPath: compileSessionPath,
            authToolPlan: authPlan,
            teachCredentials,
            llmConfig: authCompileLlmConfig(compileProviderName, compileModel),
            maxDurationMs: 20 * 60 * 1000,
            onProgress: (prog) => spinner.message(formatAuthProgress(prog)),
            // Render agent-requested user input outside the spinner.
            onPrompt: opts.noInteractive
              ? undefined
              : async (message, options) => {
                  unmuteLog();
                  spinner.stop('Authentication requires your input.');
                  let answer = '';
                  if (options && options.length > 0) {
                    const sel = await p.select({
                      message,
                      options: options.map((o) => ({ value: o, label: o })),
                    });
                    answer = p.isCancel(sel) ? '' : String(sel);
                  } else {
                    const txt = await p.text({ message, placeholder: 'type your answer' });
                    answer = p.isCancel(txt) ? '' : String(txt ?? '');
                  }
                  muteLog();
                  spinner.start('Continuing authentication verification');
                  return answer;
                },
            // Honor an agent-requested delay without firing a live action.
            onCooldown: async (minutes, reason) => {
              const envMs = Number(process.env.IMPRINT_AUTH_COOLOFF_MS);
              const ms = Number.isFinite(envMs)
                ? Math.max(0, envMs)
                : Math.max(0, minutes) * 60_000;
              unmuteLog();
              p.log.info(
                `Cooling off ~${Math.round(ms / 60000)} min before retrying the login${reason ? ` (${reason})` : ''} — no login fires during the wait.`,
              );
              muteLog();
              spinner.start(`Cooling off (~${Math.round(ms / 60000)} min, no login)…`);
              await new Promise((resolve) => setTimeout(resolve, ms));
            },
          });
          unmuteLog();

          assertSuccessfulAuthCompile(authResult);
          emit({
            workflowPath: authResult.workflowPath,
            outDir: pathDirname(authResult.workflowPath),
            force: true,
          });
          const emittedWorkflow = WorkflowSchema.parse(
            JSON.parse(readFileSync(authResult.workflowPath, 'utf8')),
          );
          const storedState = await loadSiteCredentials(site).catch(() => null);
          const sessionStored = Boolean(
            storedState && hasDurableAuthState(emittedWorkflow, storedState),
          );
          const completion = {
            toolName: authPlan.toolName,
            buildPlanHash,
            workflowHash: authWorkflowHash(emittedWorkflow),
            completedAt: new Date().toISOString(),
          };
          if (sessionStored) {
            for (const plan of plans) {
              const ws = state.workflows[plan.workflowKey];
              if (ws) ws.authCompletion = completion;
            }
            saveTeachState(site, state);
          }
          spinner.stop(
            sessionStored
              ? `Auth tool compiled + session stored (${authResult.turns} turns, ${Math.round(authResult.durationMs / 1000)}s) — data tools will reuse it.`
              : `Auth tool compiled (${authResult.turns} turns) — no live session stored; data tools will be unverified until you run \`imprint login ${site}\`.`,
          );
        } catch (err) {
          unmuteLog();
          spinner.stop('Auth tool compilation failed.');
          throw new Error(
            `Auth stage failed; data-tool compilation was not started: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
    }
  }

  // Mute raw `[imprint …]` logs from the compile subtree while the spinner /
  // MultiProgress is live. This covers single-tool runs too: they drive the
  // shared spinner and would otherwise leak compile.ts diagnostics into it,
  // just as concurrent multi-tool runs would interleave their logs.
  muteLog();
  let results: TeachToolResult[];
  try {
    results = await compileCandidatePlans({
      plans,
      site,
      state,
      sessionPath: compileSessionPath,
      providerName: compileProviderName,
      compileModel,
      maxDurationMs: opts.maxDurationMs,
      keepTest: opts.keepTest,
      spinner,
      sharedTriageResult: triageResult,
      siteClassifications,
      teachCredentials,
      buildPlanPath: buildPlanPath || undefined,
      sharedModules: sharedModulesManifest.length > 0 ? sharedModulesManifest : undefined,
      resumeExistingArtifacts: runPolicy.reviseExistingArtifacts,
    });
  } finally {
    unmuteLog();
    // Drop the transient compile-time stealth token (shared across this site's
    // per-tool `bun test` processes) now that every tool has compiled. In the
    // finally so it runs on compile failure too: otherwise a thrown compile (or
    // the `results.length === 0` throw below, or any later throw / early exit)
    // would leak a file holding a live session token on disk.
    clearCachedToken(localSiteDir(site));
  }

  if (results.length === 0) {
    throw new Error('No selected tools were compiled.');
  }

  for (const result of results) {
    const creds = referencedCredentialNames(result.workflow, result.playbook);
    if (creds.size > 0) {
      const store = await loadCredentialStore(site);
      const storedNames = store ? new Set(Object.keys(store.values)) : new Set<string>();
      const missing = [...creds].filter((name) => !storedNames.has(name));
      if (missing.length > 0) {
        p.log.warn(
          `Tool "${result.workflow.toolName}" needs credentials [${missing.join(', ')}] but they are not in the credential store.\nRun: ${missing.map((n) => `imprint credential set ${site} ${n}`).join(' && ')}`,
        );
      }
    }
  }

  const primaryResult = selectPrimaryNamedResult(results, plans) as TeachToolResult;

  // ── 6. Platform integration ────────────────────────────────────────
  if (inWindow('register')) {
    if (opts.noInteractive) {
      const imprintCommand = detectImprintCommand();
      const platforms: Platform[] = [
        'claude-code',
        'codex',
        'claude-desktop',
        'openclaw',
        'hermes',
      ];
      console.log('\n── Integration snippets ──\n');
      for (const plat of platforms) {
        console.log(`[${plat}]`);
        console.log(
          generatePasteSnippet({
            site,
            workflow: primaryResult.workflow,
            workflows: results.map((r) => r.workflow),
            platform: plat,
            imprintCommand,
          }),
        );
        console.log('');
      }
    } else {
      await interactivePlatformSetup({
        site,
        workflowDir: pathResolve(primaryResult.workflowPath, '..'),
        workflow: primaryResult.workflow,
        workflows: results.map((r) => r.workflow),
        playbook: primaryResult.playbook,
        playbooks: results.map((r) => r.playbook),
      });
    }

    // Record `register` complete only when registration actually ran. A
    // `--to-step emit/generate/compile-playbook` window skips this block; marking
    // register here anyway would make `.teach-state.json` claim platform
    // integration happened when it didn't.
    for (const result of results) {
      updateCheckpoint(site, state, result.workflow.toolName, 'register');
    }
  }

  // Surface any tools that shipped without a passing live integration test
  // (waived during compile due to anti-bot / infra). These rely on the runtime
  // playbook last-ditch path, which is a degraded fallback — operators should
  // know rather than discover at audit/runtime.
  const unverified = results.filter((r) => r.workflow.liveVerified === false);
  if (unverified.length > 0) {
    for (const r of unverified) {
      const waiver = r.workflow.liveVerifiedWaiver;
      const reason = waiver
        ? `${waiver.kind} (exhausted: ${waiver.exhaustedBackends.join(', ') || 'n/a'}; first error: ${waiver.firstError})`
        : 'reason not recorded';
      p.log.warn(
        `tool "${r.workflow.toolName}" shipped without live verification: ${reason}\n  → runtime callers fall through to the playbook last-ditch rung; treat this tool as unverified until audit confirms it.`,
      );
    }
  }

  // Capability reductions are agent decisions, not silent compile losses.
  // Keep the reasoning in workflow.json and repeat it in the final teach
  // result so operators can distinguish an intentionally smaller honest tool
  // from a compiler that simply forgot an input.
  for (const result of results) {
    for (const limitation of result.workflow.limitations ?? []) {
      const omitted = limitation.omittedParameters?.length
        ? `; omitted inputs: ${limitation.omittedParameters.join(', ')}`
        : '';
      p.log.warn(
        `tool "${result.workflow.toolName}" capability limitation — ${limitation.feature}: ${limitation.reason}${omitted}`,
      );
    }
  }

  // `--to-step emit/generate/compile-playbook` runs the per-tool compile but stops
  // before register (platform integration) — inWindow('register') already skipped
  // it above. Finish with the phase-window summary instead of the normal "Done!"
  // outro, after clearCachedToken + unverified warnings have run so the compile
  // token is cleaned up and waivers are still surfaced.
  // The per-tool compile is atomic (generate→compile-playbook→emit), so any
  // --to-step landing inside it ran through emit — report that, not the requested
  // mid-compile stopIdx.
  if (stopIdx < STEPS.indexOf('register')) await finishEarly('emit');
  p.outro(
    `Done! ${results.length} tool${results.length === 1 ? '' : 's'} ready: ${results.map((r) => r.workflow.toolName).join(', ')}${
      unverified.length > 0 ? ` (${unverified.length} unverified — see warnings above)` : ''
    }`,
  );

  return {
    sessionPath: sessionPath ?? '',
    workflowPath: primaryResult.workflowPath,
    playbookPath: primaryResult.playbookPath,
    indexPath: primaryResult.indexPath,
    workflow: primaryResult.workflow,
    playbook: primaryResult.playbook,
    tools: results,
  };
}

// ─── Candidate detection + per-tool compile ────────────────────────────────

export interface CandidateCompilePlan {
  workflowKey: string;
  startFrom: Step;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
}

function candidateStageCheckpointKeys(
  plans: CandidateCompilePlan[],
  fallbackWorkflowKey: string,
): string[] {
  const keys = plans.map((plan) => plan.workflowKey).filter((key) => key.length > 0);
  return [...new Set(keys.length > 0 ? keys : [fallbackWorkflowKey])];
}

export function updateCandidateStageCheckpoints(opts: {
  site: string;
  state: TeachState;
  plans: CandidateCompilePlan[];
  fallbackWorkflowKey: string;
  replay?: Partial<WorkflowState>;
  triage?: Partial<WorkflowState>;
}): void {
  const keys = candidateStageCheckpointKeys(opts.plans, opts.fallbackWorkflowKey);
  for (const key of keys) {
    if (opts.replay) updateCheckpoint(opts.site, opts.state, key, 'replay-and-diff', opts.replay);
    if (opts.triage) updateCheckpoint(opts.site, opts.state, key, 'triage', opts.triage);
  }
}

async function detectTeachCandidates(opts: {
  sessionPath: string;
  providerName: ProviderName;
  model?: string;
  trustSessionScope?: boolean;
}): Promise<Awaited<ReturnType<typeof detectToolCandidates>>> {
  const session = loadJsonFile(
    opts.sessionPath,
    SessionSchema,
    {
      notFound: 'Redacted session file not found before candidate detection.',
      badSchema: 'Redacted session file is malformed.',
    },
    'session',
  );
  return await detectToolCandidates(
    session,
    { provider: opts.providerName, model: opts.model },
    { trustSessionScope: opts.trustSessionScope },
  );
}

export async function selectTeachCandidates(
  detection: Awaited<ReturnType<typeof detectToolCandidates>>,
  opts: TeachOptions,
): Promise<ToolCandidate[]> {
  if (detection.candidates.length === 1) return [detection.candidates[0] as ToolCandidate];

  if (opts.primaryTool) {
    const primary = primaryToolCandidate(detection);
    const closure = finalizeTeachCandidateSelection(detection.candidates, [primary.toolName]);
    for (const cycle of closure.cycles) {
      p.log.warn(`Tool dependency cycle detected: ${cycle.join(' → ')}`);
    }
    return closure.selected;
  }

  if (opts.noInteractive) {
    return detection.candidates;
  }

  const picker = buildTeachCandidatePicker(detection.candidates);
  const answer = await p.multiselect({
    message:
      'Which tools should Imprint compile from this recording?\n  (press [space] to toggle, [enter] to submit)',
    required: true,
    initialValues: picker.initialValues,
    options: picker.options,
  });
  if (p.isCancel(answer)) {
    p.outro('Cancelled.');
    process.exit(0);
  }

  const closure = finalizeTeachCandidateSelection(detection.candidates, answer as string[]);
  if (closure.selected.length === 0) {
    throw new Error('At least one tool candidate must be selected.');
  }
  const notice = formatTeachCandidateAutoAddNotice(closure.autoAdded, 'structural');
  if (notice) p.note(notice.body, notice.title);
  for (const cycle of closure.cycles) {
    p.log.warn(`Tool dependency cycle detected: ${cycle.join(' → ')}`);
  }
  return closure.selected;
}

export function buildTeachCandidatePicker(candidates: ToolCandidate[]): {
  initialValues: string[];
  options: Array<{ value: string; label: string; hint: string }>;
} {
  return {
    initialValues: candidates.map((candidate) => candidate.toolName),
    options: candidates.map((candidate) => ({
      value: candidate.toolName,
      label: `${candidate.toolName}${candidate.primary ? ' (primary)' : ''}`,
      hint: [
        `${Math.round(candidate.confidence * 100)}% — ${candidate.description}`,
        candidate.dependsOnTools.length > 0
          ? `requires ${candidate.dependsOnTools.join(', ')}`
          : undefined,
      ]
        .filter(Boolean)
        .join(' — '),
    })),
  };
}

/** Merge replay-grounded producer edges using the persisted ClassifiedValue
 * shape. The token deriver deliberately accepts a value-only projection so raw
 * recorded values stay out of planner payloads; adapt value1 at this boundary. */
export function mergeReplayCandidateDependencies(
  candidates: ToolCandidate[],
  siteClassifications?: ClassifiedValue[],
): ToolCandidate[] {
  const tokenHints = siteClassifications
    ? deriveTokenContractHints({
        selectedTools: candidates,
        ephemeralValues: siteClassifications.map((classification) => ({
          classification: classification.classification,
          originalSeq: classification.originalSeq,
          location: classification.location,
          producerSeq: classification.producerSeq,
          producerPath: classification.producerPath,
          value: classification.value1,
        })),
      })
    : [];
  return mergeCandidateDependencies(
    candidates,
    tokenHints.map((hint) => ({
      consumerTool: hint.consumerTool,
      producerTool: hint.producerTool,
    })),
  );
}

/** Pure boundary between detected candidates, optional replay evidence, and
 * the exact dependency-closed set handed to checkpointing/build planning. */
export function finalizeTeachCandidateSelection(
  candidates: ToolCandidate[],
  selectedToolNames: Iterable<string>,
  siteClassifications?: ClassifiedValue[],
): ReturnType<typeof closeCandidateSelection> & { candidates: ToolCandidate[] } {
  const mergedCandidates = mergeReplayCandidateDependencies(candidates, siteClassifications);
  return {
    candidates: mergedCandidates,
    ...closeCandidateSelection(mergedCandidates, selectedToolNames),
  };
}

export function formatTeachCandidateAutoAddNotice(
  autoAdded: ToolCandidate[],
  source: 'structural' | 'replay',
): { body: string; title: string } | undefined {
  if (autoAdded.length === 0) return undefined;
  return {
    body: autoAdded.map((candidate) => `  + ${candidate.toolName}`).join('\n'),
    title: source === 'replay' ? 'Added recorded prerequisites' : 'Added required upstream tools',
  };
}

/** Select the compiled result corresponding to the detected primary candidate.
 * Dependency closure preserves detection order, which need not put primary first. */
export function selectPrimaryNamedResult<T extends { workflow: { toolName: string } }>(
  results: readonly T[],
  plans: ReadonlyArray<{ candidate?: { toolName: string; primary: boolean } }>,
): T | undefined {
  const primaryToolName = plans.find((plan) => plan.candidate?.primary)?.candidate?.toolName;
  return results.find((result) => result.workflow.toolName === primaryToolName) ?? results[0];
}

async function compileCandidatePlans(opts: {
  plans: CandidateCompilePlan[];
  site: string;
  state: TeachState;
  sessionPath: string;
  providerName: ProviderName;
  compileModel: string;
  maxDurationMs?: number;
  keepTest?: boolean;
  spinner: ReturnType<typeof p.spinner>;
  sharedTriageResult?: TriageResult;
  siteClassifications?: ClassifiedValue[];
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest (verified flags) for this site. */
  sharedModules?: SharedModuleManifestEntry[];
  /** The user explicitly resumed a prior teach phase; generated artifacts that
   *  already exist are revision inputs, not disposable scratch output. */
  resumeExistingArtifacts?: boolean;
}): Promise<TeachToolResult[]> {
  const concurrency = opts.plans.length === 1 ? 1 : COMPILE_CONCURRENCY;
  const mp = opts.plans.length > 1 ? new MultiProgress() : null;

  // Mutex for deadline prompts: concurrent compile agents can hit their
  // deadline at the same time, but only one p.confirm() can be active on
  // stdin at a time. Without serialization, a second prompt cancels/steals
  // input from the first, causing it to auto-resolve as cancelled.
  let promptLock: Promise<void> = Promise.resolve();

  const compileOne = async (plan: CandidateCompilePlan) => {
    const displayName = plan.candidate?.toolName ?? plan.workflowKey;
    let lastActivity = '';
    const onProgress = (progress: CompileAgentProgress): void => {
      const activity = formatCompileProgress(progress);
      if (activity === lastActivity) return;
      lastActivity = activity;
      if (mp) {
        mp.update(displayName, `[imprint teach] ${displayName}: ${activity}`);
      } else {
        opts.spinner.message(activity);
      }
    };
    const compileStart = Date.now();
    const onDeadlineReached: OnDeadlineReached | undefined = process.stdin.isTTY
      ? async () => {
          // Serialize deadline prompts so only one p.confirm() is active at a time.
          const prev = promptLock;
          let releaseLock: () => void = () => {};
          promptLock = new Promise<void>((r) => {
            releaseLock = r;
          });
          await prev;

          try {
            const elapsed = Math.round((Date.now() - compileStart) / 60000);
            if (mp) {
              mp.clear();
              mp.pause();
            } else {
              opts.spinner.stop();
            }
            const extend = await p.confirm({
              message: `${displayName} has been compiling for ${elapsed} minutes. Give it more time?`,
            });
            if (mp) {
              mp.resume();
            } else {
              opts.spinner.start(`Compiling ${displayName}`);
            }
            if (p.isCancel(extend) || !extend) return null;
            return 10 * 60 * 1000;
          } finally {
            releaseLock();
          }
        }
      : undefined;

    if (!mp) opts.spinner.start(`Compiling ${displayName}`);
    try {
      const result = await compileSelectedCandidate({
        ...opts,
        plan,
        onProgress,
        onDeadlineReached,
      });
      if (mp) {
        mp.clear();
        mp.remove(displayName);
        p.log.success(`${displayName} compiled.`);
        mp.render();
      } else {
        opts.spinner.stop(`${displayName} compiled.`);
      }
      return result;
    } catch (err) {
      const ws = opts.state.workflows[plan.workflowKey];
      if (ws) {
        ws.error = err instanceof Error ? err.message : String(err);
        ws.updatedAt = new Date().toISOString();
        saveTeachState(opts.site, opts.state);
      }
      if (mp) {
        mp.clear();
        mp.remove(displayName);
        p.log.warn(`${displayName} failed: ${err instanceof Error ? err.message : String(err)}`);
        mp.render();
      } else {
        opts.spinner.stop(`${displayName} failed.`);
        p.log.warn(`${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
  };

  // Compile producer tools before their consumers so a consumer's chained
  // verification test can mint a fresh token from the producer's live workflow.
  // With no token contracts declared, every tool lands in a single level — the
  // behavior is identical to the prior single concurrent fan-out.
  type CompileOutcome = { ok: true; value: TeachToolResult } | { ok: false; error: unknown };
  const buildPlan = opts.buildPlanPath ? readBuildPlanFile(opts.buildPlanPath) : null;
  const levels = topoLevelsForTools(
    opts.plans.map((plan) => ({ toolName: plan.candidate?.toolName ?? plan.workflowKey, plan })),
    buildPlan,
  );
  const outcomeByKey = new Map<string, CompileOutcome>();
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const level = levels[levelIndex];
    if (!level) continue;
    const levelPlans = level.map((k) => k.plan);
    const levelOutcomes = await mapLimitSettled(levelPlans, concurrency, compileOne, {
      stopOnError: isProviderUsageLimitedError,
    });
    levelPlans.forEach((plan, i) => {
      const outcome = levelOutcomes[i];
      if (outcome) outcomeByKey.set(plan.workflowKey, outcome);
    });
    const usageLimitOutcome = levelOutcomes.find(
      (outcome) => outcome && !outcome.ok && isProviderUsageLimitedError(outcome.error),
    );
    if (usageLimitOutcome && !usageLimitOutcome.ok) {
      const skippedError = skippedAfterProviderLimitError(usageLimitOutcome.error);
      for (const plan of levelPlans) {
        if (!outcomeByKey.has(plan.workflowKey)) {
          outcomeByKey.set(plan.workflowKey, { ok: false, error: skippedError });
        }
      }
      for (const remainingLevel of levels.slice(levelIndex + 1)) {
        for (const { plan } of remainingLevel) {
          outcomeByKey.set(plan.workflowKey, { ok: false, error: skippedError });
        }
      }
      break;
    }
  }
  const outcomes: CompileOutcome[] = opts.plans.map(
    (plan) =>
      outcomeByKey.get(plan.workflowKey) ?? {
        ok: false,
        error: new Error(`no compile outcome recorded for ${plan.workflowKey}`),
      },
  );

  const summary = summarizeCompileOutcomes(outcomes, opts.plans);

  // Print the structured summary on every multi-tool run so users see
  // exactly what compiled vs what failed — a single warn line buried in
  // log output is easy to miss when 4 of 6 tools compiled cleanly.
  if (opts.plans.length > 1) {
    const lines = renderCompileSummary(summary);
    if (summary.failures.length === 0) {
      p.log.success(lines.join('\n'));
    } else {
      p.log.warn(lines.join('\n'));
    }
  } else if (summary.failures.length > 0) {
    // Single-tool run: keep the old single-line warn for backwards-compat
    // since there's nothing to summarize.
    const first = summary.failures[0];
    if (first) p.log.warn(`${first.name}: ${first.firstLineError}`);
  }

  assertCompleteSelectedToolSet(summary.failures.length, opts.plans.length);

  return summary.successes;
}

/** Enforce that compilation never ships a partial selected set. A missing
 * producer can make every otherwise-successful consumer unusable. */
export function assertCompleteSelectedToolSet(failureCount: number, selectedCount: number): void {
  if (failureCount === 0) return;
  throw new Error(
    `Selected tool set is incomplete: ${failureCount} of ${selectedCount} tools failed to compile. See the summary above and re-run \`imprint teach\` after addressing the failures.`,
  );
}

/** Pure summarizer — extracted so unit tests can drive arbitrary outcome
 *  shapes without spinning up real compile pipelines. */
interface CompileOutcomeSummary {
  detected: number;
  successes: TeachToolResult[];
  successNames: string[];
  failures: Array<{ name: string; firstLineError: string }>;
}

export function summarizeCompileOutcomes(
  outcomes: Array<{ ok: true; value: TeachToolResult } | { ok: false; error: unknown } | null>,
  plans: CandidateCompilePlan[],
): CompileOutcomeSummary {
  const successes: TeachToolResult[] = [];
  const successNames: string[] = [];
  const failures: Array<{ name: string; firstLineError: string }> = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const displayName = plans[i]?.candidate?.toolName ?? plans[i]?.workflowKey ?? '?';
    if (outcome?.ok) {
      successes.push(outcome.value);
      successNames.push(displayName);
    } else {
      const msg = outcome?.error instanceof Error ? outcome.error.message : String(outcome?.error);
      failures.push({ name: displayName, firstLineError: msg.split('\n')[0] ?? '' });
    }
  }
  return { detected: plans.length, successes, successNames, failures };
}

function renderCompileSummary(summary: CompileOutcomeSummary): string[] {
  const lines: string[] = [];
  lines.push(`Compile summary: ${summary.successes.length}/${summary.detected} tools compiled.`);
  if (summary.successNames.length > 0) {
    lines.push(`Compiled: ${summary.successNames.join(', ')}`);
  }
  if (summary.failures.length > 0) {
    lines.push(`Failed (${summary.failures.length}):`);
    for (const f of summary.failures) {
      lines.push(`  • ${f.name}: ${f.firstLineError}`);
    }
  }
  return lines;
}

type SuccessfulAuthCompile = CompileAgentResult & { success: true; workflowPath: string };

export function assertSuccessfulAuthCompile(
  result: CompileAgentResult,
): asserts result is SuccessfulAuthCompile {
  if (!result.success) {
    throw new Error(`Auth agent did not complete successfully: ${result.message}`);
  }
  if (!result.workflowPath) {
    throw new Error('Auth agent reported success without producing workflow.json.');
  }
}

export function selectCompleteAuthCredentials(
  values: Record<string, string>,
  requiredNames: string[],
): Record<string, string> | null {
  const selected: Record<string, string> = {};
  for (const name of requiredNames) {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0) return null;
    selected[name] = value;
  }
  return selected;
}

async function compileSelectedCandidate(opts: {
  plan: CandidateCompilePlan;
  site: string;
  state: TeachState;
  sessionPath: string;
  providerName: ProviderName;
  compileModel: string;
  maxDurationMs?: number;
  keepTest?: boolean;
  onProgress: (progress: CompileAgentProgress) => void;
  onDeadlineReached?: OnDeadlineReached;
  sharedTriageResult?: TriageResult;
  siteClassifications?: ClassifiedValue[];
  teachCredentials?: { site: string; values: Record<string, string> };
  buildPlanPath?: string;
  sharedModules?: SharedModuleManifestEntry[];
  resumeExistingArtifacts?: boolean;
}): Promise<TeachToolResult> {
  const { plan, site, state } = opts;
  const startIdx = STEPS.indexOf(plan.startFrom);
  const toolName = plan.candidate?.toolName ?? plan.workflowKey;
  const workflowDir = localToolDir(site, toolName);
  mkdirSync(workflowDir, { recursive: true });
  const revisionMode =
    Boolean(opts.resumeExistingArtifacts) && existsSync(pathJoin(workflowDir, 'workflow.json'));

  // The per-tool compile (generate → compile-playbook → emit) is ATOMIC by design:
  // each phase gates on startIdx ONLY (not the window's stopIdx), so once started it
  // runs through emit. Stopping mid-compile would leave artifact gaps the result
  // tail (results array, register, audit) assumes exist — see the "Granularity"
  // section of docs/plans/teach-phase-window.md. `--from-step` can RESUME mid-compile
  // (each `else` branch loads the prior phase's artifact from disk); `--to-step`
  // within the compile runs the whole unit and stops before register. Do NOT add a
  // stopIdx gate here without also handling partial-artifact results downstream.
  // ── Step 1: plan THEN execute (workflow.json) ──
  let genResult: { workflow: Workflow; workflowPath: string } | undefined;
  if (startIdx <= STEPS.indexOf('generate')) {
    const llmConfig = { provider: opts.providerName, model: opts.compileModel };

    // Plan THEN execute: derive a per-tool implementation plan (param→field
    // mapping, request construction, response parsing, shared-module imports),
    // then run a single compile that follows it. Best-effort — a timeout or
    // error yields no plan and the compile proceeds exactly as before.
    const toolPlan =
      plan.candidate && !revisionMode
        ? await planToolCompile({
            site,
            toolName,
            candidate: plan.candidate,
            sharedContext: plan.sharedContext,
            sessionPath: opts.sessionPath,
            buildPlanPath: opts.buildPlanPath,
            sharedModules: opts.sharedModules,
            providerName: opts.providerName,
            model: opts.compileModel,
          })
        : undefined;

    const result = await generate({
      sessionPath: opts.sessionPath,
      outDir: workflowDir,
      maxDurationMs: opts.maxDurationMs,
      llmConfig,
      keepTest: opts.keepTest,
      candidate: plan.candidate,
      sharedContext: plan.sharedContext,
      onProgress: opts.onProgress,
      onDeadlineReached: opts.onDeadlineReached,
      classifications: opts.siteClassifications,
      teachCredentials: opts.teachCredentials,
      buildPlanPath: opts.buildPlanPath,
      sharedModules: opts.sharedModules,
      toolPlan,
      revisionMode,
      preTriagedSession: opts.sharedTriageResult,
    });

    assertCandidateToolName('Compiled workflow', result.workflow.toolName, plan.candidate);
    genResult = { workflow: result.workflow, workflowPath: result.workflowPath };
    updateCheckpoint(site, state, plan.workflowKey, 'generate', {
      candidate: plan.candidate,
      sharedContext: plan.sharedContext,
    });
  } else {
    const workflowPath = pathJoin(workflowDir, 'workflow.json');
    const workflow = loadJsonFile(
      workflowPath,
      WorkflowSchema,
      { notFound: `workflow.json not found at ${workflowPath}` },
      'workflow.json',
    );
    genResult = { workflow, workflowPath };
  }
  if (!genResult) {
    throw new Error(`generate step did not produce a workflow for "${toolName}".`);
  }
  // Semantic verification may revise the workflow after generate() returns
  // (for example, omitting an unsupported secondary parameter and recording a
  // limitation). Reload that final artifact before compiling any fallback so
  // later agents cannot work from the pre-verification object.
  genResult.workflow = loadJsonFile(
    genResult.workflowPath,
    WorkflowSchema,
    { notFound: `workflow.json not found at ${genResult.workflowPath}` },
    'workflow.json',
  );

  // ── Step 2: compile-playbook (after generate — runtime artifact, not needed for dual-pass) ──
  let pbResult: { playbook: Playbook; playbookPath: string };
  if (startIdx <= STEPS.indexOf('compile-playbook')) {
    const result = await compilePlaybook({
      sessionPath: opts.sessionPath,
      outPath: pathJoin(workflowDir, 'playbook.yaml'),
      llmConfig: { provider: opts.providerName },
      candidate: plan.candidate,
      workflow: genResult.workflow,
      sharedContext: plan.sharedContext,
      preTriagedSession: opts.sharedTriageResult,
    });
    assertCandidateToolName('Compiled playbook', result.playbook.toolName, plan.candidate);
    pbResult = { playbook: result.playbook, playbookPath: result.playbookPath };
    updateCheckpoint(site, state, plan.workflowKey, 'compile-playbook');
  } else {
    const playbookPath = pathJoin(workflowDir, 'playbook.yaml');
    const { parsePlaybook } = await import('./playbook-parser.ts');
    const playbook = parsePlaybook(readFileSync(playbookPath, 'utf8'));
    assertCandidateToolName('Stored playbook', playbook.toolName, plan.candidate);
    pbResult = { playbook, playbookPath };
  }

  // ── Step 3: emit ──
  let emitOutPath: string;
  if (startIdx <= STEPS.indexOf('emit')) {
    const emitResult = emit({
      workflowPath: genResult.workflowPath,
      outDir: workflowDir,
      force: true,
    });
    emitOutPath = emitResult.outPath;
    updateCheckpoint(site, state, plan.workflowKey, 'emit');
  } else {
    emitOutPath = pathJoin(workflowDir, 'index.ts');
  }

  exportSiteManifest(site, workflowDir, genResult.workflow, pbResult.playbook);

  // Emission and post-verification annotations can change workflow.json's
  // metadata hash without changing the already-proven transport behavior.
  // Reuse the existing no-network rebind so a bounded resume does not trigger
  // an unnecessary comprehensive probe on its first real call.
  rebindExistingBackendsCacheToWorkflow(workflowDir);
  await writeQuickBackendsCache(workflowDir, genResult.workflow);

  return {
    workflowPath: genResult.workflowPath,
    playbookPath: pbResult.playbookPath,
    indexPath: emitOutPath,
    workflow: genResult.workflow,
    playbook: pbResult.playbook,
  };
}

/**
 * Site-level replay-and-diff: replay the entire original recording in a fresh
 * browser, capture all requests, diff against the original to classify values.
 * Runs once per teach, not per-tool.
 */
async function siteReplayAndDiff(
  site: string,
  sessionPath: string,
  triagedPath: string,
  triageResult: TriageResult,
  mp: MultiProgress,
): Promise<ClassifiedValue[] | undefined> {
  try {
    const { replayRawSession } = await import('./replay-capture.ts');
    const { diffTriagedSessions, triageByAlignment, mergeClassifications } = await import(
      './session-diff.ts'
    );

    const session = loadJsonFile(
      sessionPath,
      SessionSchema,
      { notFound: 'Session not found for replay.' },
      'session',
    );
    // Re-read the durable artifact before opening a browser. Besides catching a
    // missing/corrupt checkpoint, this guarantees replay never depends only on
    // an in-memory triage result that was not persisted successfully.
    const persistedTriageResult = triageResultFromTriagedSession(
      loadJsonFile(
        triagedPath,
        SessionSchema,
        { notFound: 'Triaged session not found before replay.' },
        'session',
      ),
    );
    if (replaySafetyIdentity(persistedTriageResult) !== replaySafetyIdentity(triageResult)) {
      throw new Error('Persisted triage safety decision changed before replay could start.');
    }
    if (!triageCoversSession(session, persistedTriageResult)) {
      throw new Error(
        'Persisted triage safety decision does not cover the complete source recording. Re-run from "triage".',
      );
    }
    if (!triageAllowsReplay(triageResult)) {
      mp.clear();
      mp.remove('replay');
      p.log.warn(
        `Skipping replay because triage identified ${triageResult.irreversibleSeqs.length} irreversible request(s) and ${triageResult.irreversibleEventSeqs.length} irreversible outbound WebSocket event(s). Compilation will use the original recording without opening a replay browser.`,
      );
      mp.render();
      return undefined;
    }

    mp.update('replay', 'Replaying session in fresh browser...');
    const replayResult = await replayRawSession({
      session,
      site,
      onProgress: (current, total, captured) => {
        mp.update('replay', `Replaying event ${current}/${total} (${captured} requests captured)`);
      },
    });

    const replayRequests = replayResult.requests;

    if (!replayResult.ok) {
      mp.clear();
      mp.remove('replay');
      p.log.warn(`Automated replay failed: ${replayResult.error}`);
      p.log.warn(
        'Continuing with partial automated replay traffic and existing sibling recordings only; a manual re-record cannot inherit the original recording’s safety decision.',
      );
      mp.render();
    }

    mp.update('replay', 'Diffing replay against original...');

    const diffOriginalSession = triageResult.session;

    // Pass 1: original recording vs the automated browser replay.
    const triaged2Seqs = triageByAlignment(diffOriginalSession.requests, replayRequests);
    const triaged2Requests = replayRequests.filter((r) => triaged2Seqs.includes(r.seq));
    const replayDiff = diffTriagedSessions(diffOriginalSession, { requests: triaged2Requests });
    const diffPasses: ClassifiedValue[][] = [replayDiff.classifications];

    // Additional passes: original recording vs every OTHER real recording of
    // this site. Real recordings come from a trusted browser, so they reproduce
    // anti-bot-protected requests the automated replay may be blocked from
    // making (e.g. Akamai denies Playwright at the page level). A value
    // identical across time-separated recordings is static infrastructure
    // (GraphQL safelisting signatures, persisted-query hashes, app keys) and
    // must be kept even when the replay never observed it — see
    // mergeClassifications. All passes share `diffOriginalSession` as the original, so
    // originalSeq aligns them.
    let crossRecordingCount = 0;
    try {
      const sessionAbs = pathResolve(sessionPath);
      const others = listSiteSessions(site).filter((s) => pathResolve(s.absPath) !== sessionAbs);
      for (const info of others) {
        try {
          const other = loadJsonFile(
            info.absPath,
            SessionSchema,
            { notFound: 'Other recording not found.' },
            'session',
          );
          const seqs = triageByAlignment(diffOriginalSession.requests, other.requests);
          const reqs = other.requests.filter((r) => seqs.includes(r.seq));
          diffPasses.push(
            diffTriagedSessions(diffOriginalSession, { requests: reqs }).classifications,
          );
          crossRecordingCount++;
        } catch {
          // Skip a malformed sibling recording; the other passes still stand.
        }
      }
    } catch {
      // No sibling recordings available — replay-only classification stands.
    }

    const diffResult = {
      ...replayDiff,
      classifications: mergeClassifications(diffPasses),
    };

    const classPath = pathJoin(localSiteDir(site), '.classifications.json');
    writeFileSync(
      classPath,
      JSON.stringify(
        {
          ...diffResult,
          sourceSessionHash: fileSha256(sessionPath),
          replaySafetyHash: replaySafetyIdentity(triageResult),
        },
        null,
        2,
      ),
    );

    mp.clear();
    mp.remove('replay');

    const sourcesLabel =
      crossRecordingCount > 0
        ? `replay + ${crossRecordingCount} recording${crossRecordingCount === 1 ? '' : 's'}`
        : 'replay';
    const nonConstant = diffResult.classifications.filter((c) => c.classification !== 'constant');
    if (nonConstant.length > 0) {
      const counts: Record<string, number> = {};
      for (const c of nonConstant) counts[c.classification] = (counts[c.classification] ?? 0) + 1;
      const breakdown = Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      p.log.info(
        `Dual-pass (${sourcesLabel}): ${nonConstant.length} ephemeral values (${breakdown}). ${replayRequests.length} requests captured.`,
      );
    } else {
      p.log.info(
        `Dual-pass (${sourcesLabel}): all values constant. ${replayRequests.length} requests captured.`,
      );
    }

    mp.render();
    return diffResult.classifications;
  } catch (err) {
    mp.clear();
    mp.remove('replay');
    p.log.warn(`Dual-pass analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    mp.render();
    return undefined;
  }
}

// Bounded-concurrency fan-out helpers now live in concurrency.ts (so teach-plan.ts
// can reuse them without an import cycle). Re-exported here for existing callers.
export { mapLimit, mapLimitSettled };

// ─── Credential capture helpers ─────────────────────────────────────────────

function maskUsername(raw: string): string {
  if (raw.length <= 4) return '***';
  return `${raw.slice(0, 3)}${'*'.repeat(raw.length - 3)}`;
}

/** Find request seqs whose body contains a password-shaped key (per the
 *  shared sensitive-keys dictionary) — regardless of whether credential
 *  extraction succeeded in pairing it with a username.
 *
 *  Used by the post-redact pairing audit to detect the failure mode where
 *  a recorded login *did* happen but the extractor couldn't pair its
 *  fields, so the redacted session has no `${credential.X}` placeholders
 *  and the compile stage will template credentials as plain parameters.
 *
 *  Body shapes covered:
 *    - JSON (any nesting depth)
 *    - form-urlencoded (`a=b&c=d`)
 *    - multipart/form-data (sniffed by leading `--<boundary>`)
 *    - URL query string (covers GET-based logins)
 *
 *  The scan is intentionally lossy and fast: we substring-check for
 *  password-like key names in the raw body text plus exact-key checks in
 *  parsed JSON. False positives are tolerable here (one extra warning);
 *  false negatives are not (silent failure recurrence). */
export function findUnpairedPasswordRequests(session: Session): number[] {
  const PASSWORD_LIKE_TOKENS = passwordLikeTokens();
  const out: number[] = [];
  for (const req of session.requests) {
    let hit = false;
    // 1. Check URL query string for password-shaped param names.
    try {
      const u = new URL(req.url);
      for (const k of u.searchParams.keys()) {
        if (isSensitiveCredentialKey(k)) {
          hit = true;
          break;
        }
      }
    } catch {
      // Bad URL — skip URL-side check.
    }

    // 2. Check body — try JSON first, then fall back to substring scan
    //    that covers form-urlencoded and multipart in one pass.
    if (!hit && req.body) {
      const body = req.body;
      // JSON path.
      try {
        const parsed = JSON.parse(body);
        if (hasPasswordLikeKey(parsed)) hit = true;
      } catch {
        // Not JSON — substring scan handles form / multipart / anything
        // else that contains the key name verbatim.
      }
      if (!hit) {
        const lower = body.toLowerCase();
        for (const tok of PASSWORD_LIKE_TOKENS) {
          // Match a key-shaped occurrence: `"password"` (JSON), `password=`
          // (form/query), or `name="password"` (multipart). Avoid bare
          // substring matches that could fire on prose payloads.
          if (
            lower.includes(`"${tok}"`) ||
            lower.includes(`${tok}=`) ||
            lower.includes(`name="${tok}"`)
          ) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) out.push(req.seq);
  }
  return out;
}

/** Recursive helper for findUnpairedPasswordRequests' JSON path. */
function hasPasswordLikeKey(node: unknown): boolean {
  if (Array.isArray(node)) {
    for (const v of node) if (hasPasswordLikeKey(v)) return true;
    return false;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (isSensitiveCredentialKey(k)) return true;
      if (hasPasswordLikeKey(v)) return true;
    }
  }
  return false;
}

/** Write `<workflowDir>/credentials.manifest.json` so consumers of the
 *  generated tool know what credentials to provision. No values, just names. */
function exportSiteManifest(
  site: string,
  workflowDir: string,
  workflow: Workflow,
  playbook: Playbook,
): void {
  const m = readSiteManifest(site);
  if (!m || (m.secrets.length === 0 && (m.storage?.length ?? 0) === 0)) return;
  const requiredSecrets = referencedCredentialNames(workflow, playbook);
  const requiredStorageKeys = referencedStorageKeys(workflow, playbook);
  const secrets = m.secrets.filter((s) => requiredSecrets.has(s.name));
  const storage = (m.storage ?? []).filter((s) =>
    requiredStorageKeys.has(`${s.origin}\n${s.kind}\n${s.key}`),
  );
  if (secrets.length === 0 && storage.length === 0) return;
  const out = {
    site: m.site,
    secrets: secrets.map((s) => ({
      name: s.name,
      kind: s.kind,
      description: s.description,
    })),
    storage: storage.map((s) => ({
      origin: s.origin,
      kind: s.kind,
      key: s.key,
    })),
    note: 'Provision these on the consuming agent via `imprint credential set <site> <name>` or by importing an encrypted bundle (`imprint credential import`). Values never travel inside the skill.',
  };
  writeFileSync(
    pathJoin(workflowDir, 'credentials.manifest.json'),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8',
  );
}

function referencedCredentialNames(workflow: Workflow, playbook: Playbook): Set<string> {
  const names = new Set<string>();
  const text = `${JSON.stringify(workflow)}\n${JSON.stringify(playbook)}`;
  for (const match of text.matchAll(/\$\{credential\.([^}]+)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function referencedStorageKeys(workflow: Workflow, _playbook: Playbook): Set<string> {
  const refs = new Set<string>();
  for (const capture of workflow.bootstrap?.captures ?? []) {
    if (capture.source === 'local_storage') {
      refs.add(`${capture.origin}\nlocalStorage\n${capture.key}`);
    } else if (capture.source === 'session_storage') {
      refs.add(`${capture.origin}\nsessionStorage\n${capture.key}`);
    }
  }
  return refs;
}

async function persistFinding(opts: {
  site: string;
  finding: CredentialFinding;
}): Promise<void> {
  const backend = await getCredentialBackend();
  await backend.setSecret(opts.site, opts.finding.usernameName, opts.finding.usernameValue);
  await backend.setSecret(opts.site, opts.finding.passwordName, opts.finding.passwordValue);
  upsertManifestEntry(opts.site, {
    name: opts.finding.usernameName,
    kind: 'username',
    description: 'Login identifier (email or username)',
  });
  upsertManifestEntry(opts.site, {
    name: opts.finding.passwordName,
    kind: 'password',
    description: 'Login password',
  });
  p.log.success(
    `Stored credentials for "${opts.site}" — ${opts.finding.usernameName}, ${opts.finding.passwordName} (backend: ${backend.id})`,
  );
}

/** The identifier the user actually typed into a login form, recovered from the
 *  recording's DOM submit events. The capture listener masks password fields
 *  (`[redacted]`) but leaves the username/email visible, so this is the one
 *  credential value a hosted-login recording reliably carries — used to pre-fill
 *  the interactive credential prompt. */
export function detectRecordedUsername(session: Session): string | undefined {
  for (const ev of session.events ?? []) {
    if (ev.type !== 'submit') continue;
    try {
      const detail = JSON.parse(ev.detail) as {
        fields?: Array<{ name?: string; type?: string; value?: string }>;
      };
      for (const f of detail.fields ?? []) {
        if (
          f.name &&
          f.value &&
          f.type !== 'password' &&
          isUsernameLikeKey(f.name) &&
          !/^\[redacted\]$/i.test(f.value)
        ) {
          return f.value;
        }
      }
    } catch {
      // ignore malformed details
    }
  }
  return undefined;
}

/** Prompt the user for the login credentials the detection LLM identified for
 *  this site (`authPlan.credentialNames`), then persist them. Used when the
 *  recording couldn't yield them automatically — hosted/redirect logins submit
 *  the password as a page navigation (no XHR body) and password fields are masked
 *  at capture. We ask for EXACTLY the names the LLM named (it saw the login flow);
 *  the live one-time 2FA code is intentionally absent from that list and is
 *  entered during verification. Sensitive names get a masked input; a username is
 *  pre-filled from the recording. Returns the stored values, or undefined if the
 *  list is empty or the user cancels (no partial store). */
async function promptForCredentials(opts: {
  site: string;
  names: string[];
  detectedUsername?: string;
}): Promise<{ site: string; values: Record<string, string> } | undefined> {
  const { site, names, detectedUsername } = opts;
  if (names.length === 0) return undefined;

  p.note(
    [
      "This login's credentials weren't captured in the recording.",
      'Hosted logins (Auth0, Okta, …) submit the password as a page navigation,',
      'and Imprint masks password fields at capture time — so there is nothing to',
      'extract. Enter them now to compile the auth tool; they go straight to your',
      'local credential manager (OS keychain when available, encrypted file else).',
    ].join('\n'),
    'Credentials needed',
  );

  const values: Record<string, string> = {};
  const backend = await getCredentialBackend();
  for (const name of names) {
    const sensitive = isSensitiveCredentialKey(name);
    const usernameLike = isUsernameLikeKey(name);
    const answer = sensitive
      ? await p.password({
          message: `Enter ${name} for "${site}"`,
          mask: '*',
          validate: (v) => (!v || v.length === 0 ? 'Cannot be empty.' : undefined),
        })
      : await p.text({
          message: `Enter ${name} for "${site}"`,
          initialValue: usernameLike ? (detectedUsername ?? '') : '',
          validate: (v) => (!v || v.length === 0 ? 'Cannot be empty.' : undefined),
        });
    if (p.isCancel(answer)) {
      p.log.warn('Credential entry cancelled — skipping auth compile.');
      return undefined;
    }
    const value = String(answer);
    values[name] = value;
    await backend.setSecret(site, name, value);
    upsertManifestEntry(site, {
      name,
      kind: sensitive ? 'password' : usernameLike ? 'username' : 'opaque',
      description: usernameLike
        ? 'Login identifier'
        : sensitive
          ? 'Login password'
          : 'Login credential',
    });
  }
  p.log.success(
    `Stored ${Object.keys(values).length} credential(s) for "${site}": ${Object.keys(values).join(', ')}`,
  );
  return { site, values };
}

// ─── Checkpoint helpers ─────────────────────────────────────────────────────

function checkpoint(site: string, state: TeachState, key: string, ws: WorkflowState): void {
  state.workflows[key] = ws;
  saveTeachState(site, state);
}

function updateCheckpoint(
  site: string,
  state: TeachState,
  key: string,
  step: Step,
  extra?: Partial<WorkflowState>,
): void {
  const ws = state.workflows[key] ?? {
    sessionPath: '',
    completedSteps: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!ws.completedSteps.includes(step)) {
    ws.completedSteps.push(step);
  }
  ws.updatedAt = new Date().toISOString();
  ws.error = undefined;
  if (extra) Object.assign(ws, extra);
  state.workflows[key] = ws;
  saveTeachState(site, state);
}

// ─── Resume TUI ─────────────────────────────────────────────────────────────

interface ResumeChoice {
  action: 'new' | 'continue' | 'redo';
  workflowKey: string;
  fromStep: Step;
}

async function promptResumeChoice(
  _site: string,
  completed: string[],
  incomplete: [string, WorkflowState][],
): Promise<ResumeChoice | symbol> {
  // Show what exists.
  if (completed.length > 0 || incomplete.length > 0) {
    const lines: string[] = [];
    for (const name of completed) lines.push(`  ✓ ${name} (complete)`);
    for (const [name, ws] of incomplete) {
      const next = nextStep(ws.completedSteps) ?? 'unknown';
      const errHint = ws.error ? ` — error: ${ws.error.slice(0, 60)}` : '';
      lines.push(`  ✗ ${name} (stopped at: ${next}${errHint})`);
    }
    p.log.info(`Found existing workflows:\n${lines.join('\n')}`);
  }

  type OptionValue = string;
  const options: { value: OptionValue; label: string }[] = [];

  // Offer continue for incomplete workflows.
  for (const [name, ws] of incomplete) {
    const next = nextStep(ws.completedSteps);
    if (next) {
      options.push({
        value: `continue:${name}`,
        label: `Continue "${name}" from ${next}`,
      });
    }
  }

  // Offer redo for all workflows (incomplete + completed).
  for (const [name] of incomplete) {
    options.push({
      value: `redo:${name}`,
      label: `Redo "${name}" from a specific step`,
    });
  }
  for (const name of completed) {
    options.push({
      value: `redo:${name}`,
      label: `Redo "${name}" from a specific step`,
    });
  }

  options.push({
    value: 'new',
    label: 'Start a new workflow (record a new session)',
  });

  const choice = await p.select({
    message: 'What would you like to do?',
    options,
  });

  if (p.isCancel(choice)) return choice;

  const choiceStr = choice as string;

  if (choiceStr === 'new') {
    return { action: 'new', workflowKey: '', fromStep: 'record' };
  }

  if (choiceStr.startsWith('continue:')) {
    const key = choiceStr.slice('continue:'.length);
    const ws = incomplete.find(([n]) => n === key)?.[1];
    const from = ws ? (nextStep(ws.completedSteps) ?? 'record') : 'record';
    return { action: 'continue', workflowKey: key, fromStep: from };
  }

  if (choiceStr.startsWith('redo:')) {
    const key = choiceStr.slice('redo:'.length);

    const stepChoice = await p.select({
      message: `Redo "${key}" — start from which step?`,
      options: STEPS.map((s) => ({ value: s, label: s })),
    });

    if (p.isCancel(stepChoice)) return stepChoice;

    return { action: 'redo', workflowKey: key, fromStep: stepChoice as Step };
  }

  return { action: 'new', workflowKey: '', fromStep: 'record' };
}

// ─── Platform integration (unchanged) ───────────────────────────────────────

async function interactivePlatformSetup(opts: {
  site: string;
  workflowDir: string;
  workflow: Workflow;
  workflows?: Workflow[];
  playbook: Playbook;
  playbooks?: Playbook[];
}): Promise<void> {
  const { site, workflowDir, workflow, workflows, playbook, playbooks } = opts;
  const imprintCommand = detectImprintCommand();

  const platformChoice = await p.select({
    message: 'Which platform will use this tool?',
    options: [
      { value: 'claude-code' as Platform, label: 'Claude Code' },
      { value: 'codex' as Platform, label: 'Codex CLI' },
      { value: 'claude-desktop' as Platform, label: 'Claude Desktop' },
      { value: 'openclaw' as Platform, label: 'OpenClaw' },
      { value: 'hermes' as Platform, label: 'Hermes' },
      { value: 'skip' as const, label: 'Other / manual' },
    ],
  });

  if (p.isCancel(platformChoice) || platformChoice === 'skip') return;

  const platform = platformChoice as Platform;
  const regCommand = buildRegistrationCommand({ site, platform, imprintCommand });

  if (regCommand !== null) {
    const setupChoice = await p.select({
      message: 'How would you like to set it up?',
      options: [
        { value: 'run' as const, label: 'Run the command now' },
        { value: 'snippet' as const, label: 'Print paste snippet' },
        { value: 'skip' as const, label: 'Skip' },
      ],
    });

    if (p.isCancel(setupChoice) || setupChoice === 'skip') return;

    if (setupChoice === 'run') {
      const spinner = p.spinner();
      const cmdDisplay = regCommand.join(' ');
      spinner.start(`Running: ${cmdDisplay}`);
      try {
        let proc = Bun.spawnSync(regCommand, { stdio: ['ignore', 'pipe', 'pipe'] });

        // If it failed because the server already exists, ask to replace.
        if (proc.exitCode !== 0 && proc.stderr.toString().includes('already exists')) {
          spinner.stop(`imprint-${site} is already registered.`);
          const replace = await p.confirm({
            message: 'Replace existing registration?',
            initialValue: true,
          });
          if (!p.isCancel(replace) && replace) {
            const toolName = `imprint-${site}`;
            if (platform === 'claude-code') {
              Bun.spawnSync(['claude', 'mcp', 'remove', '--scope', 'user', toolName], {
                stdio: ['ignore', 'ignore', 'ignore'],
              });
            } else if (platform === 'codex') {
              Bun.spawnSync(['codex', 'mcp', 'remove', toolName], {
                stdio: ['ignore', 'ignore', 'ignore'],
              });
            }
            spinner.start(`Re-registering: ${cmdDisplay}`);
            proc = Bun.spawnSync(regCommand, { stdio: ['ignore', 'pipe', 'pipe'] });
            if (proc.exitCode === 0) {
              spinner.stop(
                `imprint-${site} replaced in ${platform === 'claude-code' ? 'Claude Code' : 'Codex'}.`,
              );
            } else {
              const stderr = proc.stderr.toString().trim();
              spinner.stop(
                `Command exited with code ${proc.exitCode}${stderr ? `: ${stderr}` : ''}`,
              );
            }
          }
        } else if (proc.exitCode === 0) {
          spinner.stop(
            `imprint-${site} is now available in ${platform === 'claude-code' ? 'Claude Code' : 'Codex'}.`,
          );
        } else {
          const stderr = proc.stderr.toString().trim();
          spinner.stop(`Command exited with code ${proc.exitCode}${stderr ? `: ${stderr}` : ''}`);
          console.log('\nRun this manually instead:');
          console.log(`  ${cmdDisplay}\n`);
        }
      } catch (err) {
        spinner.stop(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('\nRun this manually instead:');
        console.log(`  ${cmdDisplay}\n`);
      }
    } else {
      const snippet = generatePasteSnippet({
        site,
        workflow,
        workflows,
        platform,
        imprintCommand,
      });
      console.log('\nPaste this into your terminal or AI tool:\n');
      console.log(`  ${snippet}\n`);
    }
  } else {
    const snippet = generatePasteSnippet({ site, workflow, workflows, platform, imprintCommand });
    console.log(`\n${snippet}\n`);
  }

  if (platform === 'openclaw' || platform === 'hermes') {
    await offerSkillExport({
      site,
      workflowDir,
      workflow,
      workflows,
      playbook,
      playbooks,
      platform,
    });
  }
}

async function offerSkillExport(opts: {
  site: string;
  workflowDir: string;
  workflow: Workflow;
  workflows?: Workflow[];
  playbook: Playbook;
  playbooks?: Playbook[];
  platform: 'openclaw' | 'hermes';
}): Promise<void> {
  const { site, workflowDir, workflow, workflows, playbook, playbooks, platform } = opts;

  const cronPath = pathResolve(workflowDir, 'cron.json');
  let cronConfig: CronConfig | undefined;
  if (existsSync(cronPath)) {
    try {
      cronConfig = CronConfigSchema.parse(JSON.parse(readFileSync(cronPath, 'utf8')));
    } catch {
      // Ignore malformed cron.json — it's optional context.
    }
  }

  const exportConfirm = await p.confirm({
    message: `Export as SKILL.md for ${platform === 'openclaw' ? 'OpenClaw' : 'Hermes'}?`,
    initialValue: false,
  });

  if (p.isCancel(exportConfirm) || !exportConfirm) return;

  const skillContent = generateSkillMd({
    site,
    workflow,
    workflows,
    playbook,
    playbooks,
    cronConfig,
    platform,
  });

  let outDir: string;
  if (platform === 'hermes') {
    const hermesSkills = pathResolve(homedir(), '.hermes', 'skills', `imprint-${site}`);
    if (existsSync(pathResolve(homedir(), '.hermes'))) {
      outDir = hermesSkills;
    } else {
      outDir = pathResolve(process.cwd(), `imprint-${site}`);
    }
  } else {
    outDir = pathResolve(process.cwd(), `imprint-${site}`);
  }

  mkdirSync(outDir, { recursive: true });
  const outPath = pathJoin(outDir, 'SKILL.md');
  writeFileSync(outPath, skillContent, 'utf8');

  p.log.success(`SKILL.md → ${outPath}`);

  if (platform === 'openclaw') {
    p.log.info(`Install: openclaw skill install ${outDir}`);
  }
}

// ─── Session combination (post-record or post-from-session, pre-redact) ──

async function combineAvailableSessions(opts: {
  site: string;
  currentSessionPath: string;
  noInteractive: boolean;
  fromSession: boolean;
}): Promise<string> {
  // Discover sibling sessions. For --from-session, look in the source
  // directory (which may differ from the target site's sessions dir).
  // For normal recordings, look in the site's sessions directory.
  const pastSessions = opts.fromSession
    ? listSessionsInDir(pathDirname(opts.currentSessionPath)).filter(
        (s) => s.absPath !== opts.currentSessionPath,
      )
    : listSiteSessions(opts.site).filter((s) => s.absPath !== opts.currentSessionPath);

  if (pastSessions.length === 0) return opts.currentSessionPath;

  let selectedPaths: string[];

  if (opts.noInteractive) {
    // Auto-combine all available sessions
    selectedPaths = pastSessions.map((s) => s.absPath);
    p.log.info(`Auto-combining ${pastSessions.length + 1} session(s) for "${opts.site}".`);
  } else {
    const combine = await p.confirm({
      message: `Found ${pastSessions.length} past recording session${pastSessions.length === 1 ? '' : 's'}${opts.fromSession ? ' in the source directory' : ` for "${opts.site}"`}. Combine with the ${opts.fromSession ? 'provided' : 'new'} recording?`,
      initialValue: true,
    });

    if (p.isCancel(combine) || !combine) return opts.currentSessionPath;

    const selected = await p.multiselect({
      message: 'Select sessions to combine:\n  (press [space] to toggle, [enter] to submit)',
      required: true,
      initialValues: pastSessions.map((s) => s.absPath),
      options: pastSessions.map((s) => ({
        value: s.absPath,
        label: `${s.friendlyTimestamp} — ${s.url}`,
        hint: `${s.requestCount} requests, ${s.narrationCount} narrations`,
      })),
    });

    if (p.isCancel(selected)) return opts.currentSessionPath;

    selectedPaths = selected as string[];
    if (selectedPaths.length === 0) return opts.currentSessionPath;
  }

  const spinner = p.spinner();
  spinner.start('Combining sessions');

  const sessions: Session[] = [];
  for (const path of selectedPaths) {
    sessions.push(
      loadJsonFile(
        path,
        SessionSchema,
        { notFound: `Past session not found: ${path}`, badSchema: 'Session file is malformed.' },
        'session',
      ),
    );
  }
  sessions.push(
    loadJsonFile(
      opts.currentSessionPath,
      SessionSchema,
      { notFound: 'Current session not found.', badSchema: 'Session file is malformed.' },
      'session',
    ),
  );

  const { combined, combinedPath } = await traced(
    'teach.combine_sessions',
    'CHAIN',
    { 'imprint.site': opts.site },
    async (span) => {
      const merged = mergeSessions(sessions);
      const path = writeCombinedSession(opts.site, merged);
      setSpanAttributes(span, {
        'imprint.combine.session_count': sessions.length,
        'imprint.combine.request_count': merged.requests.length,
        'imprint.combine.narration_count': merged.narration.length,
      });
      return { combined: merged, combinedPath: path };
    },
  );

  spinner.stop(
    `Combined ${sessions.length} sessions (${combined.requests.length} requests, ${combined.narration.length} narrations).`,
  );

  return combinedPath;
}

function formatCompileProgress(progress: CompileAgentProgress): string {
  const activity = describeAgentActivity(progress);
  const retry = progress.verificationCycle > 1 ? `, retry ${progress.verificationCycle - 1}` : '';
  return `Compiling • ${activity} (${formatElapsed(progress.elapsedMs)}${retry})`;
}

/** Build the auth-compile spinner line. Turns stay monotonic across resumed
 *  segments; live failures surface the requested action and observed status. */
export function formatAuthProgress(progress: CompileAgentProgress): string {
  const base = `Auth compile: turn ${progress.turn}`;
  const lv = progress.lastVerification;
  if (lv && !lv.ok) {
    const status = typeof lv.status === 'number' ? ` HTTP ${lv.status}` : '';
    return `${base} — verify ${lv.action} FAILED (${lv.error ?? 'error'}${status}) — agent revising`;
  }
  return base;
}

// ─── Quick backend probe (after emit) ────────────────────────────────────────

/**
 * After a workflow is emitted, quickly probe whether plain fetch works.
 * If it returns FORBIDDEN (bot protection), write a backends.json that
 * skips fetch so the MCP server goes straight to stealth-fetch → playbook.
 * This avoids the ~16s wasted on failing backends when the MCP tool is called.
 */
async function writeQuickBackendsCache(workflowDir: string, workflow: Workflow): Promise<void> {
  if (workflowHasIrreversibleEffect(workflow)) return;
  const backendsPath = pathJoin(workflowDir, 'backends.json');
  if (existsSync(backendsPath)) return;
  const { createHash } = await import('node:crypto');

  const defaults: Record<string, string | number | boolean> = {};
  for (const param of workflow.parameters) {
    if (param.default !== undefined) {
      defaults[param.name] = param.default;
    } else {
      defaults[param.name] = param.type === 'number' ? 0 : param.type === 'boolean' ? false : '';
    }
  }

  const body = workflow.requests[0]?.body;
  const url = workflow.requests[0]?.url;
  if (!url) return;

  const { substituteString } = await import('./runtime.ts');
  const emptyState = { site: workflow.site ?? '', cookies: [], values: {} };
  let resolvedUrl: string;
  let resolvedBody: string | undefined;
  try {
    resolvedUrl = substituteString(url, defaults, emptyState, []);
    resolvedBody = body ? substituteString(body, defaults, emptyState, []) : undefined;
  } catch {
    return;
  }

  const method = workflow.requests[0]?.method ?? 'GET';
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(workflow.requests[0]?.headers ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }

  try {
    const resp = await fetch(resolvedUrl, {
      method,
      headers,
      body: method !== 'GET' ? resolvedBody : undefined,
      signal: AbortSignal.timeout(5000),
    });

    const wfHash = createHash('sha256')
      .update(JSON.stringify(WorkflowSchema.parse(workflow)))
      .digest('hex');

    const hasPlaybook = existsSync(pathJoin(workflowDir, 'playbook.yaml'));

    if (resp.status === 403) {
      const preferred = hasPlaybook ? ['stealth-fetch', 'playbook'] : ['stealth-fetch'];
      const cache = {
        probedAt: new Date().toISOString(),
        imprintVersion: '0.1.0',
        schemaVersion: 2,
        workflowHash: wfHash,
        preferredOrder: preferred,
        results: {
          fetch: {
            outcome: 'forbidden' as const,
            durationMs: 0,
            detail: `Quick probe during teach: HTTP ${resp.status}`,
          },
        },
      };
      writeFileSync(backendsPath, `${JSON.stringify(cache, null, 2)}\n`);
      log(`backend probe: fetch blocked → wrote ${backendsPath}`);
    }
  } catch {
    // Fetch failed (timeout, network error) — don't write cache, let runtime discover
  }
}
