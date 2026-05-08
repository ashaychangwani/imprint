/**
 * `imprint teach` — interactive pipeline that chains record → redact → generate
 * → compile-playbook → emit automatically, then presents a platform picker
 * and outputs paste snippets or runs registration commands.
 *
 * Supports resuming from the last successful step, re-doing from a chosen
 * step, and multiple workflows per site (each in its own subdirectory).
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
import { homedir } from 'node:os';
import { isAbsolute as pathIsAbsolute, join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import { type CompileAgentProgress, compilePlaybook, generate } from './compile.ts';
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
  detectProvider,
  getProviderStatuses,
  isTeachCompatibleProvider,
} from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { describeAgentActivity, formatElapsed } from './progress.ts';
import { record } from './record.ts';
import { redactSession } from './redact.ts';
import { CronConfigSchema, SessionSchema, WorkflowSchema } from './types.ts';
import type { CronConfig, Playbook, Workflow } from './types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

const STEPS = ['record', 'redact', 'generate', 'compile-playbook', 'emit', 'register'] as const;
type Step = (typeof STEPS)[number];

interface WorkflowState {
  sessionPath: string;
  redactedPath?: string;
  completedSteps: Step[];
  error?: string;
  startedAt: string;
  updatedAt: string;
}

interface TeachState {
  workflows: Record<string, WorkflowState>;
}

interface TeachOptions {
  site?: string;
  url?: string;
  persistProfile?: boolean;
  signal?: AbortSignal;
  noInteractive?: boolean;
  provider?: ProviderName;
  fromSession?: string;
  /** Retain parser.test.ts after successful compile-agent verification. */
  keepTest?: boolean;
}

interface TeachResult {
  sessionPath: string;
  workflowPath: string;
  playbookPath: string;
  indexPath: string;
  workflow: Workflow;
  playbook: Playbook;
}

export function resolveTeachStatePath(
  site: string,
  storedPath: string | null | undefined,
): string | null {
  const value = storedPath?.trim();
  if (!value) return null;
  return pathIsAbsolute(value) ? value : pathResolve('examples', site, value);
}

export function buildTeachStateFromSession(
  site: string,
  sessionPath: string,
  redactedPath: string | null,
): WorkflowState {
  const now = new Date().toISOString();
  const ws: WorkflowState = {
    sessionPath: toRelative(site, sessionPath),
    completedSteps: redactedPath ? ['record', 'redact'] : ['record'],
    startedAt: now,
    updatedAt: now,
  };
  if (redactedPath) ws.redactedPath = toRelative(site, redactedPath);
  return ws;
}

// ─── State management ───────────────────────────────────────────────────────

function statePath(site: string): string {
  return pathResolve('examples', site, '.teach-state.json');
}

function loadTeachState(site: string): TeachState {
  const path = statePath(site);
  if (!existsSync(path)) return { workflows: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TeachState;
  } catch {
    return { workflows: {} };
  }
}

function saveTeachState(site: string, state: TeachState): void {
  const path = statePath(site);
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

function nextStep(completed: Step[]): Step {
  if (completed.length === 0) return 'record';
  const last = completed.at(-1);
  if (!last) return 'record';
  const lastIdx = STEPS.indexOf(last);
  if (lastIdx < 0 || lastIdx >= STEPS.length - 1) return 'record';
  return STEPS[lastIdx + 1] as Step;
}

/** Scan examples/<site>/ for completed workflows. A workflow is "complete"
 *  only when its tool directory has index.ts (emit ran successfully). */
function discoverCompletedWorkflows(site: string): string[] {
  const siteDir = pathResolve('examples', site);
  if (!existsSync(siteDir)) return [];
  const names: string[] = [];

  for (const entry of readdirSync(siteDir)) {
    if (entry === 'sessions' || entry.startsWith('.')) continue;
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

/** Find the latest session in examples/<site>/sessions/ that has no
 *  matching state entry. Returns an incomplete WorkflowState or null. */
function discoverOrphanSession(site: string, state: TeachState): WorkflowState | null {
  const sessDir = pathResolve('examples', site, 'sessions');
  if (!existsSync(sessDir)) return null;

  const trackedPaths = new Set(Object.values(state.workflows).map((ws) => ws.sessionPath));

  const sessions = readdirSync(sessDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.redacted.json'))
    .sort()
    .reverse();

  for (const file of sessions) {
    const relPath = `sessions/${file}`;
    if (trackedPaths.has(relPath)) continue;

    const absPath = pathJoin(sessDir, file);
    const redactedPath = absPath.replace(/\.json$/, '.redacted.json');
    const hasRedacted = existsSync(redactedPath);
    const completedSteps: Step[] = ['record'];
    if (hasRedacted) completedSteps.push('redact');

    return {
      sessionPath: relPath,
      redactedPath: hasRedacted
        ? `sessions/${file.replace(/\.json$/, '.redacted.json')}`
        : undefined,
      completedSteps,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

function isExistingFile(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requireSessionFile(
  path: string | null,
  opts: { site: string; workflowKey: string; startFrom: Step; kind: 'raw' | 'redacted' },
): string {
  if (isExistingFile(path)) return path;

  const noun = opts.kind === 'raw' ? 'original session JSON' : 'redacted session JSON';
  const redoStep = opts.kind === 'raw' ? 'record' : 'redact';
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
    return 'No spaces or slashes — site becomes a folder name under examples/.';
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
      '→ use one of: claude-cli, codex-cli, anthropic-api, vertex',
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
    const provider = detectProvider();
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

  if (hasExisting && !opts.noInteractive) {
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
      }
      if (!sessionPath && startFrom !== 'record') {
        // Completed workflow with no state — find the latest session.
        const orphan = discoverOrphanSession(site, state);
        if (orphan) {
          sessionPath = pathResolve('examples', site, orphan.sessionPath);
          redactedPath = orphan.redactedPath
            ? pathResolve('examples', site, orphan.redactedPath)
            : null;
        }
      }
    }
  } else if (opts.fromSession) {
    const candidateRedacted = opts.fromSession.replace(/\.json$/, '.redacted.json');
    startFrom = isExistingFile(candidateRedacted) ? 'generate' : 'redact';
    sessionPath = pathResolve(opts.fromSession);
    if (isExistingFile(candidateRedacted)) redactedPath = pathResolve(candidateRedacted);
    usingFromSession = true;
  }

  const startIdx = STEPS.indexOf(startFrom);
  const spinner = p.spinner();
  let providerName: ProviderName | null = null;
  const getProviderName = async (): Promise<ProviderName> => {
    providerName ??= await resolveTeachProvider(opts);
    return providerName;
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
  } else if (startFrom === 'generate' || startFrom === 'compile-playbook') {
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
  }

  // ── 2. Redact ──────────────────────────────────────────────────────
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
    }

    spinner.start('Redacting credentials...');
    const { session: scrubbed, stats } = redactSession(session, {
      replacements: confirmedReplacements,
    });
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    writeFileSync(redactedPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
    const placeholderNote =
      stats.placeholdersInjected > 0
        ? `, ${stats.placeholdersInjected} replaced with credential placeholders`
        : '';
    spinner.stop(
      `Redacted ${stats.totalRedactions} value(s) across ${stats.requestsRedacted} request(s) and ${stats.cookiesRedacted} cookie(s)${placeholderNote}.`,
    );

    updateCheckpoint(site, state, workflowKey, 'redact', {
      redactedPath: toRelative(site, redactedPath),
    });
  }

  if (!redactedPath) {
    redactedPath = sessionPath ? sessionPath.replace(/\.json$/, '.redacted.json') : null;
  }

  if (startIdx <= STEPS.indexOf('compile-playbook')) {
    redactedPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
  }

  // ── 3. Generate workflow (agentic — long-running) ──────────────────
  let workflowDir: string;
  let genResult: { workflow: Workflow; workflowPath: string };

  if (startIdx <= STEPS.indexOf('generate')) {
    const compileSessionPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
    const providerName = await getProviderName();
    const { resolveCompileAgentModel } = await import('./compile-agent.ts');
    const compileModel = resolveCompileAgentModel(providerName);
    p.note(
      [
        `Provider: ${providerName}    Model: ${compileModel}`,
        '',
        'An LLM agent will reverse-engineer the API response format.',
        'Expect ~3-5 minutes and moderate to high token use, depending on',
        'the complexity of the recording. You can interrupt with Ctrl-C.',
      ].join('\n'),
      'Compile step',
    );

    spinner.start('Compiling...');
    // compileAgent writes workflow.json (+ parser.ts etc.) to examples/<site>/.
    // We move them into the toolName subdirectory after we know the name.
    const result = await generate({
      sessionPath: compileSessionPath,
      llmConfig: { provider: providerName, model: compileModel },
      keepTest: opts.keepTest,
      onProgress: (progress) => {
        spinner.message(formatCompileProgress(progress));
      },
    });

    const toolName = result.workflow.toolName;
    workflowDir = pathResolve('examples', site, toolName);
    mkdirSync(workflowDir, { recursive: true });

    // Move agent-written artifacts into the workflow subdirectory.
    const siteDir = pathResolve('examples', site);
    for (const artifact of ['workflow.json', 'parser.ts', 'parser.test.ts']) {
      const src = pathJoin(siteDir, artifact);
      if (!existsSync(src)) continue;
      const dest = pathJoin(workflowDir, artifact);
      try {
        renameSync(src, dest);
      } catch {
        writeFileSync(dest, readFileSync(src, 'utf8'), 'utf8');
        unlinkSync(src);
      }
    }

    const finalWorkflowPath = pathJoin(workflowDir, 'workflow.json');
    genResult = { workflow: result.workflow, workflowPath: finalWorkflowPath };

    spinner.stop(
      `workflow.json → ${toolName} (${result.workflow.requests.length} request(s), ${result.workflow.parameters.length} param(s))`,
    );

    // Rename state key from temp to toolName, carrying over prior state.
    if (workflowKey !== toolName) {
      const prior = state.workflows[workflowKey];
      delete state.workflows[workflowKey];
      workflowKey = toolName;
      if (prior) state.workflows[workflowKey] = prior;
    }

    updateCheckpoint(site, state, workflowKey, 'generate');
  } else {
    // Resuming after generate — workflowKey IS the toolName.
    workflowDir = pathResolve('examples', site, workflowKey);
    const workflowPath = pathJoin(workflowDir, 'workflow.json');
    const workflow = loadJsonFile(
      workflowPath,
      WorkflowSchema,
      { notFound: `workflow.json not found at ${workflowPath}` },
      'workflow.json',
    );
    genResult = { workflow, workflowPath };
  }

  // ── 4. Compile playbook ────────────────────────────────────────────
  let pbResult: { playbook: Playbook; playbookPath: string };

  if (startIdx <= STEPS.indexOf('compile-playbook')) {
    const compileSessionPath = requireSessionFile(redactedPath, {
      site,
      workflowKey,
      startFrom,
      kind: 'redacted',
    });
    const providerName = await getProviderName();
    spinner.start('Compiling DOM playbook...');
    const playbookOutPath = pathJoin(workflowDir, 'playbook.yaml');
    const result = await compilePlaybook({
      sessionPath: compileSessionPath,
      outPath: playbookOutPath,
      llmConfig: { provider: providerName },
    });
    pbResult = { playbook: result.playbook, playbookPath: result.playbookPath };
    spinner.stop(
      `playbook.yaml → ${result.playbook.steps.length} step(s), ${result.playbook.parameters.length} param(s)`,
    );

    updateCheckpoint(site, state, workflowKey, 'compile-playbook');
  } else {
    const playbookPath = pathJoin(workflowDir, 'playbook.yaml');
    const { parsePlaybook } = await import('./playbook-parser.ts');
    const playbook = parsePlaybook(readFileSync(playbookPath, 'utf8'));
    pbResult = { playbook, playbookPath };
  }

  // ── 5. Emit ────────────────────────────────────────────────────────
  let emitOutPath: string;

  if (startIdx <= STEPS.indexOf('emit')) {
    spinner.start('Emitting tool...');
    const emitResult = emit({
      workflowPath: genResult.workflowPath,
      outDir: workflowDir,
      force: true,
    });
    emitOutPath = emitResult.outPath;
    spinner.stop(`${emitOutPath} generated.`);

    updateCheckpoint(site, state, workflowKey, 'emit');
  } else {
    emitOutPath = pathJoin(workflowDir, 'index.ts');
  }

  // Write a sibling credentials manifest so a downstream agent that consumes
  // this skill knows which credentials to ask for. Manifest contains names +
  // descriptions only — no values.
  exportSiteManifest(site, workflowDir);

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
            site: site,
            workflow: genResult.workflow,
            platform: plat,
            imprintCommand,
          }),
        );
        console.log('');
      }
    } else {
      await interactivePlatformSetup({
        site: site,
        workflowDir,
        workflow: genResult.workflow,
        playbook: pbResult.playbook,
      });
    }
  }

  // Mark all steps complete (keep the entry for future redo).
  updateCheckpoint(site, state, workflowKey, 'register');

  p.outro('Done! Your agent is ready.');

  return {
    sessionPath: sessionPath ?? '',
    workflowPath: genResult.workflowPath,
    playbookPath: pbResult.playbookPath,
    indexPath: emitOutPath,
    workflow: genResult.workflow,
    playbook: pbResult.playbook,
  };
}

// ─── Credential capture (interactive) ───────────────────────────────────────

interface CredentialPromptResult {
  replacements: Replacement[];
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
    await persistFinding({ site: opts.site, finding: unique[0] as CredentialFinding });
    return { replacements: opts.replacements };
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
  };
}

/** Write `<workflowDir>/credentials.manifest.json` so consumers of the
 *  shared skill know what credentials to provision. No values, just names. */
function exportSiteManifest(site: string, workflowDir: string): void {
  const m = readSiteManifest(site);
  if (!m || m.secrets.length === 0) return;
  const out = {
    site: m.site,
    secrets: m.secrets.map((s) => ({
      name: s.name,
      kind: s.kind,
      description: s.description,
    })),
    note: 'Provision these on the consuming agent via `imprint credential set <site> <name>` or by importing an encrypted bundle (`imprint credential import`). Values never travel inside the skill.',
  };
  writeFileSync(
    pathJoin(workflowDir, 'credentials.manifest.json'),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8',
  );
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

function friendlySessionTimestamp(sessionPath: string): string {
  const m = sessionPath.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (!m) return 'unknown';
  return `${m[1]} ${m[2]}:${m[3]}`;
}

function toRelative(site: string, absPath: string): string {
  const siteDir = pathResolve('examples', site);
  if (absPath.startsWith(siteDir)) {
    return absPath.slice(siteDir.length + 1);
  }
  return absPath;
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
  playbook: Playbook;
}): Promise<void> {
  const { site, workflowDir, workflow, playbook } = opts;
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
      const snippet = generatePasteSnippet({ site, workflow, platform, imprintCommand });
      console.log('\nPaste this into your terminal or AI tool:\n');
      console.log(`  ${snippet}\n`);
    }
  } else {
    const snippet = generatePasteSnippet({ site, workflow, platform, imprintCommand });
    console.log(`\n${snippet}\n`);
  }

  if (platform === 'openclaw' || platform === 'hermes') {
    await offerSkillExport({ site, workflowDir, workflow, playbook, platform });
  }
}

async function offerSkillExport(opts: {
  site: string;
  workflowDir: string;
  workflow: Workflow;
  playbook: Playbook;
  platform: 'openclaw' | 'hermes';
}): Promise<void> {
  const { site, workflowDir, workflow, playbook, platform } = opts;

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

  const skillContent = generateSkillMd({ site, workflow, playbook, cronConfig, platform });

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

function formatCompileProgress(progress: CompileAgentProgress): string {
  const activity = describeAgentActivity(progress);
  const retry = progress.verificationCycle > 1 ? `, retry ${progress.verificationCycle - 1}` : '';
  return `Compiling • ${activity} (${formatElapsed(progress.elapsedMs)}${retry})`;
}
