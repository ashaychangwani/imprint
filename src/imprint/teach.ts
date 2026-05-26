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
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import type { OnDeadlineReached } from './agent.ts';
import {
  type CompileAgentProgress,
  type TriageResult,
  compilePlaybook,
  generate,
  triageRequests,
} from './compile.ts';
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
import { muteLog, unmuteLog } from './log.ts';
import { MultiProgress } from './multi-progress.ts';
import { localSiteDir, localToolDir } from './paths.ts';
import { describeAgentActivity, formatElapsed } from './progress.ts';
import { record } from './record.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import { loadCredentialStore } from './runtime.ts';
import type { ClassifiedValue } from './session-diff.ts';
import { listSiteSessions, mergeSessions, writeCombinedSession } from './session-merge.ts';
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
  resolveTeachStatePath,
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
import { CronConfigSchema, SessionSchema, WorkflowSchema } from './types.ts';
import type { CronConfig, Playbook, Session, Workflow } from './types.ts';

export { buildTeachStateFromSession, resolveTeachStatePath } from './teach-state.ts';

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
  /** Per-tool compile timeout in ms. Default 10 minutes. */
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
  if (models.length <= 1) return models[0]?.model ?? 'claude-opus-4-7';

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

    spinner.start('Recording...');
    spinner.stop('Ready to record.');
    console.log('');

    const recordResult = await record({
      site: site,
      url: startUrl,
      persistProfile: opts.persistProfile,
      signal: opts.signal,
    });
    sessionPath = recordResult.sessionPath;

    checkpoint(site, state, workflowKey, {
      sessionPath: toRelative(site, sessionPath),
      completedSteps: ['record'],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // ── 1b. Combine with past sessions (optional) ────────────────────
    const originalSessionPath = sessionPath;
    sessionPath = await promptSessionCombine({
      site,
      currentSessionPath: sessionPath,
      noInteractive: opts.noInteractive ?? false,
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

    spinner.start('Redacting credentials...');
    const pageMintedHeaders = detectPageMintedHeaders(session);
    const { session: scrubbed, stats } = redactSession(session, {
      replacements: confirmedReplacements,
      keepHeaders: pageMintedHeaders,
    });
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    writeFileSync(redactedPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
    const placeholderNote =
      stats.placeholdersInjected > 0
        ? `, ${stats.placeholdersInjected} replaced with credential placeholders`
        : '';
    const freeformNote =
      stats.freeformRedactions > 0 ? `, ${stats.freeformRedactions} free-form finding(s)` : '';
    spinner.stop(
      `Redacted ${stats.totalRedactions} value(s) across ${stats.requestsRedacted} request(s) and ${stats.cookiesRedacted} cookie(s)${placeholderNote}${freeformNote}.`,
    );

    updateCheckpoint(site, state, workflowKey, 'redact', {
      redactedPath: toRelative(site, redactedPath),
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
  let triagedPath: string | null = null;
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
        triageRes?: { result: TriageResult; sessionPath: string };
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
          spinner.start('Triaging requests...');
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
          if (ws?.triagedPath) {
            localTriagedPath = resolveTeachStatePath(site, ws.triagedPath);
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
        spinner.start('Detecting candidate tools...');
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
          triageRes: localTriageResult
            ? { result: localTriageResult, sessionPath: replaySessionPath }
            : undefined,
          plans: candidatePlans,
        };
      })();

      // Wait for candidate chain (includes user interaction)
      const candidateResult = await candidatePromise;
      plans = candidateResult.plans;

      if (candidateResult.triageRes) {
        triageResult = candidateResult.triageRes.result;
        triagedPath = candidateResult.triageRes.sessionPath.replace(
          /\.redacted\.json$/,
          '.triaged.json',
        );
      }

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
        spinner.start('Waiting for replay to finish...');
      }
      siteClassifications = await replayPromise;
      if (showedSpinner) {
        spinner.stop('Replay complete.');
      }

      mp.clear();

      // Checkpoints — write sequentially after both complete
      if (needsReplay) {
        updateCheckpoint(site, state, workflowKey, 'replay-and-diff', {
          classificationsPath: siteClassifications
            ? toRelative(site, pathJoin(localSiteDir(site), '.classifications.json'))
            : undefined,
        });
      }
      if (candidateResult.triageRes && triagedPath) {
        updateCheckpoint(site, state, workflowKey, 'triage', {
          triagedPath: toRelative(site, triagedPath),
        });
      }
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
    if (ws?.triagedPath) {
      triagedPath = resolveTeachStatePath(site, ws.triagedPath);
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
    const timeoutMs = opts.maxDurationMs ?? 10 * 60 * 1000;
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
          ? 'An LLM agent will reverse-engineer the API response format.'
          : `${plans.length} LLM compile agents will reverse-engineer selected tools with concurrency 3.`,
        `Expect up to ${timeoutDisplay} per tool and moderate to high token use, depending on`,
        'the complexity of the recording. You can interrupt with Ctrl-C.',
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

  if (plans.length > 1) muteLog();
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
    });
  } finally {
    if (plans.length > 1) unmuteLog();
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

  p.outro(
    `Done! ${results.length} tool${results.length === 1 ? '' : 's'} ready: ${results.map((r) => r.workflow.toolName).join(', ')}`,
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

interface CandidateCompilePlan {
  workflowKey: string;
  startFrom: Step;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
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
}): Promise<TeachToolResult[]> {
  const concurrency = opts.plans.length === 1 ? 1 : 3;
  const mp = opts.plans.length > 1 ? new MultiProgress() : null;
  const outcomes = await mapLimitSettled(opts.plans, concurrency, async (plan) => {
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
            opts.spinner.start(`Compiling ${displayName}...`);
          }
          if (p.isCancel(extend) || !extend) return null;
          return 10 * 60 * 1000;
        }
      : undefined;

    if (!mp) opts.spinner.start(`Compiling ${displayName}...`);
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
  });

  const successes: TeachToolResult[] = [];
  const failures: string[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const displayName = opts.plans[i]?.candidate?.toolName ?? opts.plans[i]?.workflowKey ?? '?';
    if (outcome?.ok) {
      successes.push(outcome.value);
    } else {
      const msg = outcome?.error instanceof Error ? outcome.error.message : String(outcome?.error);
      failures.push(`${displayName}: ${msg.split('\n')[0]}`);
    }
  }

  if (failures.length > 0) {
    p.log.warn(
      `${successes.length} of ${outcomes.length} tools compiled. ` +
        `${failures.length} failed:\n${failures.map((f) => `  • ${f}`).join('\n')}`,
    );
  }

  return successes;
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
}): Promise<TeachToolResult> {
  const { plan, site, state } = opts;
  const startIdx = STEPS.indexOf(plan.startFrom);
  const toolName = plan.candidate?.toolName ?? plan.workflowKey;
  const workflowDir = localToolDir(site, toolName);
  mkdirSync(workflowDir, { recursive: true });

  // ── Step 1: generate (workflow.json, enriched with site-level classifications) ──
  let genResult: { workflow: Workflow; workflowPath: string };
  if (startIdx <= STEPS.indexOf('generate')) {
    const result = await generate({
      sessionPath: opts.sessionPath,
      outDir: workflowDir,
      maxDurationMs: opts.maxDurationMs,
      llmConfig: { provider: opts.providerName, model: opts.compileModel },
      keepTest: opts.keepTest,
      candidate: plan.candidate,
      sharedContext: plan.sharedContext,
      onProgress: opts.onProgress,
      onDeadlineReached: opts.onDeadlineReached,
      classifications: opts.siteClassifications,
      teachCredentials: opts.teachCredentials,
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
    const { diffTriagedSessions, triageByAlignment } = await import('./session-diff.ts');

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

    const triaged2Seqs = triageByAlignment(session.requests, replayRequests);
    const triaged2Requests = replayRequests.filter((r) => triaged2Seqs.includes(r.seq));
    const diffResult = diffTriagedSessions(session, { requests: triaged2Requests });

    const classPath = pathJoin(localSiteDir(site), '.classifications.json');
    writeFileSync(classPath, JSON.stringify(diffResult, null, 2));

    mp.clear();
    mp.remove('replay');

    const nonConstant = diffResult.classifications.filter((c) => c.classification !== 'constant');
    if (nonConstant.length > 0) {
      const counts: Record<string, number> = {};
      for (const c of nonConstant) counts[c.classification] = (counts[c.classification] ?? 0) + 1;
      const breakdown = Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      p.log.info(
        `Dual-pass: ${nonConstant.length} ephemeral values (${breakdown}). ${replayRequests.length} requests captured.`,
      );
    } else {
      p.log.info(`Dual-pass: all values constant. ${replayRequests.length} requests captured.`);
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

export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && firstError === undefined) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await fn(item);
      } catch (err) {
        firstError ??= err;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function mapLimitSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<SettledResult<R>[]> {
  const results = new Array<SettledResult<R>>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { ok: true, value: await fn(item) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}

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

// ─── Session combination (post-record, pre-redact) ────────────────────────

async function promptSessionCombine(opts: {
  site: string;
  currentSessionPath: string;
  noInteractive: boolean;
}): Promise<string> {
  if (opts.noInteractive) return opts.currentSessionPath;

  const pastSessions = listSiteSessions(opts.site).filter(
    (s) => s.absPath !== opts.currentSessionPath,
  );

  if (pastSessions.length === 0) return opts.currentSessionPath;

  const combine = await p.confirm({
    message: `Found ${pastSessions.length} past recording session${pastSessions.length === 1 ? '' : 's'} for "${opts.site}". Combine with the new recording?`,
    initialValue: false,
  });

  if (p.isCancel(combine) || !combine) return opts.currentSessionPath;

  const selected = await p.multiselect({
    message:
      'Select sessions to combine with the new recording:\n  (press [space] to toggle, [enter] to submit)',
    required: true,
    initialValues: pastSessions.map((s) => s.absPath),
    options: pastSessions.map((s) => ({
      value: s.absPath,
      label: `${s.friendlyTimestamp} — ${s.url}`,
      hint: `${s.requestCount} requests, ${s.narrationCount} narrations`,
    })),
  });

  if (p.isCancel(selected)) return opts.currentSessionPath;

  const selectedPaths = selected as string[];
  if (selectedPaths.length === 0) return opts.currentSessionPath;

  const spinner = p.spinner();
  spinner.start('Combining sessions...');

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

  const combined = mergeSessions(sessions);
  const combinedPath = writeCombinedSession(opts.site, combined);

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
      process.stderr.write(
        `[imprint teach] backend probe: fetch blocked → wrote ${backendsPath}\n`,
      );
    }
  } catch {
    // Fetch failed (timeout, network error) — don't write cache, let runtime discover
  }
}
