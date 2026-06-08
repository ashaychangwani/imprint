/**
 * `imprint teach` — interactive pipeline that chains record → redact → generate
 * → compile-playbook → emit automatically, then presents a platform picker
 * and outputs paste snippets or runs registration commands.
 *
 * Supports resuming from the last successful step, re-doing from a chosen
 * step, and multiple workflows per site (each in its own subdirectory).
 */

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
import {
  type SharedModuleManifestEntry,
  buildPlanSidecarPath,
  readBuildPlanFile,
  topoLevelsForTools,
} from './build-plan.ts';
import {
  type CompileAgentProgress,
  type TriageResult,
  compilePlaybook,
  generate,
  triageRequests,
} from './compile.ts';
import { mapLimit, mapLimitSettled } from './concurrency.ts';
import {
  type CredentialFinding,
  type Replacement,
  extractCredentials,
} from './credential-extract.ts';
import { getCredentialBackend, readSiteManifest, upsertManifestEntry } from './credential-store.ts';
import { emit } from './emit.ts';
import {
  type Platform,
  buildRegistrationCommand,
  detectImprintCommand,
  generatePasteSnippet,
  generateSkillMd,
} from './integrations.ts';
import {
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
import { describeAgentActivity, formatElapsed } from './progress.ts';
import { record } from './record.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import { loadCredentialStore } from './runtime.ts';
import { isSensitiveCredentialKey, passwordLikeTokens } from './sensitive-keys.ts';
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
  buildTeachStateFromSession,
  discoverCompletedWorkflows,
  discoverOrphanSession,
  friendlySessionTimestamp,
  isExistingTeachFile as isExistingFile,
  loadTeachState,
  nextTeachStep as nextStep,
  pruneStalePendingTeachWorkflows,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
  saveTeachState,
  toRelativeTeachStatePath as toRelative,
} from './teach-state.ts';
import {
  type SharedCompileContext,
  type ToolCandidate,
  buildSharedCompileContext as buildCandidateSharedCompileContext,
  detectToolCandidates,
  primaryToolCandidate,
} from './tool-candidates.ts';
import { planToolCompile } from './tool-plan.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import { CronConfigSchema, SessionSchema, WorkflowSchema } from './types.ts';
import type { CronConfig, Playbook, Session, Workflow } from './types.ts';

export {
  buildTeachStateFromSession,
  resolveTeachStatePath,
  resolveWorkflowTriagedPath,
} from './teach-state.ts';

/**
 * How many compile agents run in parallel when more than one tool is selected.
 * Kept at 2 (not 3): bursts of near-identical reverse-engineering requests in a
 * short window raise the model's usage-policy safety-filter false-positive rate,
 * so we trade a little wall-clock for fewer spurious refusals. Single-tool runs
 * still use concurrency 1.
 */
const COMPILE_CONCURRENCY = 2;

/** Module logger — suppressed during teach's spinner phases via muteLog(). */
const log = createLog('teach');

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
  /** Retain parser.test.ts after successful compile-agent verification. */
  keepTest?: boolean;
  /** Non-interactive: compile every detected candidate instead of primary only. */
  allTools?: boolean;
  /** Skip the replay-and-diff stage entirely. */
  skipReplay?: boolean;
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
  if (pruneStalePendingTeachWorkflows(site, state, completedWorkflows)) {
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
  let usingFromSession = false;

  const hasExisting = completedWorkflows.length > 0 || incompleteWorkflows.length > 0;

  if (opts.fromSession) {
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

  if (startIdx <= STEPS.indexOf('compile-playbook')) {
    await getProviderName();
  }

  // ── 1. Record ──────────────────────────────────────────────────────
  if (startIdx <= STEPS.indexOf('record')) {
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
  if (startIdx <= STEPS.indexOf('redact')) {
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
    // both stash the values in the credential manager AND swap them for
    // ${credential.X} placeholders in the redacted artifact.
    const { findings, replacements } = extractCredentials(session);
    let confirmedReplacements: Replacement[] = [];
    if (findings.length > 0) {
      const result = await promptAndPersistCredentials({
        site,
        findings,
        replacements,
        noInteractive: opts.noInteractive ?? false,
      });
      confirmedReplacements = result.replacements;
      if (result.confirmedFinding) {
        const f = result.confirmedFinding;
        teachCredentials = {
          site,
          values: {
            [f.usernameName ?? 'username']: f.usernameValue,
            [f.passwordName ?? 'password']: f.passwordValue,
          },
        };
      }
    }

    spinner.start('Redacting credentials');
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    const { stats } = await traced(
      'teach.redact',
      'CHAIN',
      { 'imprint.site': site },
      async (span) => {
        const pageMintedHeaders = detectPageMintedHeaders(session);
        const redaction = redactSession(session, {
          replacements: confirmedReplacements,
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
    if (unpairedPasswordSeqs.length > 0 && confirmedReplacements.length === 0) {
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

  if (startIdx <= STEPS.indexOf('generate')) {
    redactedPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
  }

  // ── 2b+3. Replay || (Triage → Detect → Select) — deep parallelism ──
  //
  // replay-and-diff is slow (~2 min) and only needed at compile time.
  // triage→detect→select is fast (~30s) and independent of replay.
  // Run them in parallel so the user can select tools while replay runs.
  let siteClassifications: ClassifiedValue[] | undefined;
  let triageResult: TriageResult | undefined;
  let plans: CandidateCompilePlan[];

  let needsReplay = startIdx <= STEPS.indexOf('replay-and-diff') && !opts.skipReplay;
  const needsCandidates = startIdx <= STEPS.indexOf('detect-candidates');

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

  if (!needsReplay && startIdx <= STEPS.indexOf('replay-and-diff')) {
    p.log.warn(
      "Skipping replay-and-diff stage. The compile agent won't be able to distinguish browser-minted values (timestamps, CSRF tokens) from constants — this may reduce workflow accuracy for sites with ephemeral request parameters.",
    );
    updateCheckpoint(site, state, workflowKey, 'replay-and-diff', {});
  }

  if (needsReplay || needsCandidates) {
    const replaySessionPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });

    // Resolve provider eagerly so triage/detect don't block on prompt mid-parallel
    if (needsCandidates) await getProviderName();

    muteLog();
    try {
      const mp = new MultiProgress();

      // Branch A: replay-and-diff (slow, ~2 min)
      const replayPromise = (async () => {
        if (!needsReplay) {
          const classPath = pathJoin(localSiteDir(site), '.classifications.json');
          if (existsSync(classPath)) {
            try {
              return JSON.parse(readFileSync(classPath, 'utf8'))
                .classifications as ClassifiedValue[];
            } catch {
              /* proceed without */
            }
          }
          return undefined;
        }
        return siteReplayAndDiff(site, replaySessionPath, mp);
      })();

      // Branch B: triage → detect-candidates → user selection (fast, ~30s)
      type CandidateChainResult = {
        triageResult?: TriageResult;
        plans: CandidateCompilePlan[];
      };
      const candidatePromise = (async (): Promise<CandidateChainResult> => {
        if (!needsCandidates) {
          const ws = state.workflows[workflowKey];
          return {
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

        // ── triage ──
        let localTriageResult: TriageResult | undefined;
        let localTriagedPath: string | null = null;
        if (startIdx <= STEPS.indexOf('triage')) {
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
          spinner.start('Triaging requests');
          localTriageResult = await triageRequests(triageSession, {
            provider: providerName,
            model,
          });
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
        } else {
          const ws = state.workflows[workflowKey];
          localTriagedPath = resolveWorkflowTriagedPath(site, ws);
          if (ws && localTriagedPath && !ws.triagedPath) {
            updateCheckpoint(site, state, workflowKey, 'triage', {
              triagedPath: toRelative(site, localTriagedPath),
            });
          }
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
        const detection = await detectTeachCandidates({
          sessionPath: compileSessionPath,
          providerName,
          model,
        });
        spinner.stop(
          `Detected ${detection.candidates.length} candidate tool${detection.candidates.length === 1 ? '' : 's'}.`,
        );

        // ── interactive selection — keep mp paused during prompt ──
        const selected = await selectTeachCandidates(detection, opts);
        mp.resume();

        const sharedContext = buildCandidateSharedCompileContext(detection, selected);
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
        const candidatePlans = selected.map((candidate) => {
          checkpoint(site, state, candidate.toolName, {
            ...baseState,
            completedSteps: ['record', 'redact', 'replay-and-diff', 'triage', 'detect-candidates'],
            candidate,
            sharedContext,
          });
          return {
            workflowKey: candidate.toolName,
            startFrom: 'generate' as Step,
            candidate,
            sharedContext,
          };
        });

        if (pendingKey && state.workflows[pendingKey]) {
          delete state.workflows[pendingKey];
          saveTeachState(site, state);
        }

        return {
          triageResult: localTriageResult,
          plans: candidatePlans,
        };
      })();

      // Wait for candidate chain (includes user interaction)
      const candidateResult = await candidatePromise;
      plans = candidateResult.plans;

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
    if (existsSync(classPath)) {
      try {
        siteClassifications = JSON.parse(readFileSync(classPath, 'utf8')).classifications;
      } catch {
        /* proceed without */
      }
    }
    const ws = state.workflows[workflowKey];
    const resolvedTriagedPath = resolveWorkflowTriagedPath(site, ws);
    if (ws && resolvedTriagedPath && !ws.triagedPath) {
      updateCheckpoint(site, state, workflowKey, 'triage', {
        triagedPath: toRelative(site, resolvedTriagedPath),
      });
    }
    plans = [
      {
        workflowKey,
        startFrom,
        candidate: ws?.candidate,
        sharedContext: ws?.sharedContext,
      },
    ];
  }

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

  const compileSessionPath = requireSessionFile(redactedPath, {
    site,
    workflowKey: plans[0]?.workflowKey ?? workflowKey,
    startFrom,
    kind: 'redacted',
  });

  // ── Clean up stale tools from previous teach runs ──
  const incomingToolNames = new Set(plans.map((pl) => pl.candidate?.toolName ?? pl.workflowKey));
  const existingTools = discoverCompletedWorkflows(site);
  const staleTools = existingTools.filter((name) => !incomingToolNames.has(name));
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
  // Only engages for ≥2 selected tools that are about to be (re)generated.
  // Single-tool runs and resumes-past-generate are unchanged.
  const selectedCandidates = plans.map((pl) => pl.candidate).filter((c): c is ToolCandidate => !!c);
  const willGenerate = plans.some((pl) => STEPS.indexOf(pl.startFrom) <= STEPS.indexOf('generate'));
  let buildPlanPath = '';
  let sharedModulesManifest: SharedModuleManifestEntry[] = [];
  if (selectedCandidates.length >= 2 && willGenerate && compileModel) {
    const sidecar = buildPlanSidecarPath(site);
    const firstWs = state.workflows[plans[0]?.workflowKey ?? ''];
    const alreadyPlanned =
      plans.every((pl) =>
        state.workflows[pl.workflowKey]?.completedSteps.includes('plan-prereqs'),
      ) && existsSync(sidecar);
    if (alreadyPlanned && firstWs) {
      // Resume past plan-prereqs — reuse the persisted plan + manifest.
      buildPlanPath = sidecar;
      sharedModulesManifest = firstWs.sharedModules ?? [];
    } else {
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
      allTools: opts.allTools,
      buildPlanPath: buildPlanPath || undefined,
      sharedModules: sharedModulesManifest.length > 0 ? sharedModulesManifest : undefined,
    });
  } finally {
    unmuteLog();
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

  const primaryResult = results[0] as TeachToolResult;

  // ── 6. Platform integration ────────────────────────────────────────
  if (startIdx <= STEPS.indexOf('register')) {
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
  }

  for (const result of results) {
    updateCheckpoint(site, state, result.workflow.toolName, 'register');
  }

  // Drop the transient compile-time stealth token (shared across this site's
  // per-tool `bun test` processes). It holds a live session token and is no
  // longer needed once every tool has compiled.
  clearCachedToken(localSiteDir(site));

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
  return await detectToolCandidates(session, { provider: opts.providerName, model: opts.model });
}

async function selectTeachCandidates(
  detection: Awaited<ReturnType<typeof detectToolCandidates>>,
  opts: TeachOptions,
): Promise<ToolCandidate[]> {
  if (detection.candidates.length === 1) return [detection.candidates[0] as ToolCandidate];

  if (opts.noInteractive) {
    if (opts.allTools) return detection.candidates;
    const primary = primaryToolCandidate(detection);
    p.log.warn(
      `Detected ${detection.candidates.length} candidate tools; --no-interactive compiles only primary "${primary.toolName}". Pass --all-tools to compile all.`,
    );
    return [primary];
  }

  const answer = await p.multiselect({
    message:
      'Which tools should Imprint compile from this recording?\n  (press [space] to toggle, [enter] to submit)',
    required: true,
    initialValues: detection.candidates
      .filter((candidate) => candidate.primary)
      .map((c) => c.toolName),
    options: detection.candidates.map((candidate) => ({
      value: candidate.toolName,
      label: `${candidate.toolName}${candidate.primary ? ' (primary)' : ''}`,
      hint: `${Math.round(candidate.confidence * 100)}% — ${candidate.description}`,
    })),
  });
  if (p.isCancel(answer)) {
    p.outro('Cancelled.');
    process.exit(0);
  }

  const selectedNames = new Set(answer as string[]);
  const selected = detection.candidates.filter((candidate) =>
    selectedNames.has(candidate.toolName),
  );
  if (selected.length === 0) {
    throw new Error('At least one tool candidate must be selected.');
  }
  return selected;
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
  /** Mirror of TeachOptions.allTools — when true, partial failures abort
   *  the run with a non-zero exit so the user notices missing tools instead
   *  of getting a silent warning. */
  allTools?: boolean;
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest (verified flags) for this site. */
  sharedModules?: SharedModuleManifestEntry[];
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
  for (const level of levels) {
    const levelPlans = level.map((k) => k.plan);
    const levelOutcomes = await mapLimitSettled(levelPlans, concurrency, compileOne);
    levelPlans.forEach((plan, i) => {
      const outcome = levelOutcomes[i];
      if (outcome) outcomeByKey.set(plan.workflowKey, outcome);
    });
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

  // Hard-fail when --all-tools was requested AND any tool failed. Silent
  // partial compiles ship MCP servers with missing tools; the user only
  // notices later when an LLM tries to call one that doesn't exist.
  if (opts.allTools && summary.failures.length > 0) {
    throw new Error(
      `--all-tools requested but ${summary.failures.length} of ${opts.plans.length} tools failed to compile. See the summary above; re-run \`imprint teach\` after addressing the failures (or omit --all-tools to ship only what compiled).`,
    );
  }

  return summary.successes;
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
}): Promise<TeachToolResult> {
  const { plan, site, state } = opts;
  const startIdx = STEPS.indexOf(plan.startFrom);
  const toolName = plan.candidate?.toolName ?? plan.workflowKey;
  const workflowDir = localToolDir(site, toolName);
  mkdirSync(workflowDir, { recursive: true });

  // ── Step 1: plan THEN execute (workflow.json) ──
  let genResult: { workflow: Workflow; workflowPath: string } | undefined;
  if (startIdx <= STEPS.indexOf('generate')) {
    const llmConfig = { provider: opts.providerName, model: opts.compileModel };

    // Plan THEN execute: derive a per-tool implementation plan (param→field
    // mapping, request construction, response parsing, shared-module imports),
    // then run a single compile that follows it. Best-effort — a timeout or
    // error yields no plan and the compile proceeds exactly as before.
    const toolPlan = plan.candidate
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

  // ── Step 2: compile-playbook (after generate — runtime artifact, not needed for dual-pass) ──
  let pbResult: { playbook: Playbook; playbookPath: string };
  if (startIdx <= STEPS.indexOf('compile-playbook')) {
    const result = await compilePlaybook({
      sessionPath: opts.sessionPath,
      outPath: pathJoin(workflowDir, 'playbook.yaml'),
      llmConfig: { provider: opts.providerName },
      candidate: plan.candidate,
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

    mp.update('replay', 'Replaying session in fresh browser...');
    const replayResult = await replayRawSession({
      session,
      site,
      onProgress: (current, total, captured) => {
        mp.update('replay', `Replaying event ${current}/${total} (${captured} requests captured)`);
      },
    });

    let replayRequests = replayResult.requests;

    if (!replayResult.ok) {
      mp.clear();
      mp.remove('replay');
      p.log.warn(`Automated replay failed: ${replayResult.error}`);
      p.log.info(
        'Recording the same flow again in a fresh browser for dual-pass analysis.\n' +
          'No narration needed — just repeat the same actions, then close the browser.',
      );
      mp.render();

      const recordResult = await record({ site, url: session.url });
      const secondSession = loadJsonFile(
        recordResult.sessionPath,
        SessionSchema,
        { notFound: 'Second recording session not found.' },
        'session',
      );

      replayRequests = secondSession.requests;
    }

    mp.update('replay', 'Diffing replay against original...');

    // Pass 1: original recording vs the automated browser replay.
    const triaged2Seqs = triageByAlignment(session.requests, replayRequests);
    const triaged2Requests = replayRequests.filter((r) => triaged2Seqs.includes(r.seq));
    const replayDiff = diffTriagedSessions(session, { requests: triaged2Requests });
    const diffPasses: ClassifiedValue[][] = [replayDiff.classifications];

    // Additional passes: original recording vs every OTHER real recording of
    // this site. Real recordings come from a trusted browser, so they reproduce
    // anti-bot-protected requests the automated replay may be blocked from
    // making (e.g. Akamai denies Playwright at the page level). A value
    // identical across time-separated recordings is static infrastructure
    // (GraphQL safelisting signatures, persisted-query hashes, app keys) and
    // must be kept even when the replay never observed it — see
    // mergeClassifications. All passes share `session` as the original, so
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
          const seqs = triageByAlignment(session.requests, other.requests);
          const reqs = other.requests.filter((r) => seqs.includes(r.seq));
          diffPasses.push(diffTriagedSessions(session, { requests: reqs }).classifications);
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
    writeFileSync(classPath, JSON.stringify(diffResult, null, 2));

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

// ─── Credential capture (interactive) ───────────────────────────────────────

interface CredentialPromptResult {
  replacements: Replacement[];
  confirmedFinding?: CredentialFinding;
}

async function promptAndPersistCredentials(opts: {
  site: string;
  findings: CredentialFinding[];
  replacements: Replacement[];
  noInteractive: boolean;
}): Promise<CredentialPromptResult> {
  // De-duplicate findings by username+password value so a re-recorded session
  // with the same login attempt across multiple seqs only prompts once.
  const seen = new Set<string>();
  const unique: CredentialFinding[] = [];
  for (const f of opts.findings) {
    const key = `${f.usernameValue}${f.passwordValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  if (unique.length === 0) return { replacements: opts.replacements };

  const summary = unique
    .map(
      (f, i) =>
        `  ${i + 1}. ${f.requestLabel}\n     username: ${f.usernameValue}\n     password: ${'*'.repeat(Math.min(f.passwordValue.length, 16))}`,
    )
    .join('\n');
  p.note(
    [
      `Detected ${unique.length} login form submission(s) in this recording.`,
      'Imprint will store the credentials in your local credential manager (OS keychain when',
      'available, libsodium-encrypted file otherwise) and rewrite their values to',
      '${credential.username} / ${credential.password} placeholders before sending the',
      'session to the LLM. The plaintext values never enter the workflow artifact.',
      '',
      summary,
    ].join('\n'),
    'Credential capture',
  );

  if (opts.noInteractive) {
    // Persist silently in non-interactive mode — keeps automated runs working.
    const finding = unique[0] as CredentialFinding;
    await persistFinding({ site: opts.site, finding });
    return { replacements: opts.replacements, confirmedFinding: finding };
  }

  const proceed = await p.confirm({
    message: `Save credentials for "${opts.site}" to the credential manager?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn('Skipping credential save — workflow will not be able to log in.');
    return { replacements: [] };
  }

  // For v1 we only support one set of credentials per site (flat
  // username/password names). If multiple distinct logins were found,
  // ask which one to persist.
  let chosen: CredentialFinding | undefined = unique[0];
  if (unique.length > 1) {
    const pick = await p.select({
      message: 'Which login should be stored?',
      options: unique.map((f, i) => ({
        value: String(i),
        label: `${i + 1}. ${f.requestLabel} — ${f.usernameValue}`,
      })),
    });
    if (p.isCancel(pick)) {
      p.log.warn('Skipped.');
      return { replacements: [] };
    }
    chosen = unique[Number.parseInt(pick as string, 10)];
  }

  if (!chosen) return { replacements: opts.replacements };

  await persistFinding({ site: opts.site, finding: chosen });

  return {
    replacements: opts.replacements.filter(
      (r) => r.originalValue === chosen?.usernameValue || r.originalValue === chosen?.passwordValue,
    ),
    confirmedFinding: chosen,
  };
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

// ─── Quick backend probe (after emit) ────────────────────────────────────────

/**
 * After a workflow is emitted, quickly probe whether plain fetch works.
 * If it returns FORBIDDEN (bot protection), write a backends.json that
 * skips fetch so the MCP server goes straight to stealth-fetch → playbook.
 * This avoids the ~16s wasted on failing backends when the MCP tool is called.
 */
async function writeQuickBackendsCache(workflowDir: string, workflow: Workflow): Promise<void> {
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
