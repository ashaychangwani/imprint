/**
 * `imprint teach` — interactive pipeline that chains record → redact → generate
 * → compile-playbook → emit automatically, then presents a platform picker
 * and outputs paste snippets or runs registration commands.
 *
 * Supports resuming from the last successful step, re-doing from a chosen
 * step, and multiple workflows per site (each in its own subdirectory).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import { type CompileAgentProgress, compilePlaybook, generate } from './compile.ts';
import { emit } from './emit.ts';
import {
  type Platform,
  buildRegistrationCommand,
  detectImprintCommand,
  generatePasteSnippet,
  generateSkillMd,
} from './integrations.ts';
import { type ProviderName, detectProvider } from './llm.ts';
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
  site: string;
  url?: string;
  persistProfile?: boolean;
  signal?: AbortSignal;
  noInteractive?: boolean;
  provider?: ProviderName;
  fromSession?: string;
}

interface TeachResult {
  sessionPath: string;
  workflowPath: string;
  playbookPath: string;
  indexPath: string;
  workflow: Workflow;
  playbook: Playbook;
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
    // Clean up empty state file.
    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(path);
    } catch {
      // File might not exist — fine.
    }
    return;
  }
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function nextStep(completed: Step[]): Step {
  if (completed.length === 0) return 'record';
  const last = completed[completed.length - 1]!;
  const lastIdx = STEPS.indexOf(last);
  if (lastIdx < 0 || lastIdx >= STEPS.length - 1) return 'record';
  return STEPS[lastIdx + 1] as Step;
}

/** Scan examples/<site>/ for completed workflow subdirectories (have index.ts). */
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

// ─── Main teach function ────────────────────────────────────────────────────

export async function teach(opts: TeachOptions): Promise<TeachResult> {
  p.intro(`imprint teach — teaching your agent to use ${opts.site}`);

  const state = loadTeachState(opts.site);
  const completedWorkflows = discoverCompletedWorkflows(opts.site);
  const incompleteWorkflows = Object.entries(state.workflows);

  // Decide what to do: resume, redo, or start fresh.
  let startFrom: Step = 'record';
  let workflowKey: string | null = null;
  let sessionPath: string | null = opts.fromSession ?? null;
  let redactedPath: string | null = null;

  const hasExisting = completedWorkflows.length > 0 || incompleteWorkflows.length > 0;

  if (hasExisting && !opts.noInteractive) {
    const choice = await promptResumeChoice(opts.site, completedWorkflows, incompleteWorkflows);
    if (p.isCancel(choice)) {
      p.outro('Cancelled.');
      process.exit(0);
    }

    if (choice.action === 'new') {
      startFrom = 'record';
    } else if (choice.action === 'continue') {
      workflowKey = choice.workflowKey;
      const ws = state.workflows[workflowKey]!;
      startFrom = nextStep(ws.completedSteps);
      sessionPath = pathResolve('examples', opts.site, ws.sessionPath);
      redactedPath = ws.redactedPath ? pathResolve('examples', opts.site, ws.redactedPath) : null;
    } else if (choice.action === 'redo') {
      workflowKey = choice.workflowKey;
      startFrom = choice.fromStep;
      const ws = state.workflows[workflowKey];
      if (ws) {
        sessionPath = pathResolve('examples', opts.site, ws.sessionPath);
        redactedPath = ws.redactedPath ? pathResolve('examples', opts.site, ws.redactedPath) : null;
      }
    }
  } else if (opts.fromSession) {
    startFrom = existsSync(opts.fromSession.replace(/\.json$/, '.redacted.json'))
      ? 'generate'
      : 'redact';
    sessionPath = pathResolve(opts.fromSession);
    const candidateRedacted = opts.fromSession.replace(/\.json$/, '.redacted.json');
    if (existsSync(candidateRedacted)) redactedPath = pathResolve(candidateRedacted);
  }

  const startIdx = STEPS.indexOf(startFrom);
  const spinner = p.spinner();
  const providerName = opts.provider ?? detectProvider();

  // Temp key for state tracking before we know the toolName.
  if (!workflowKey) {
    workflowKey = `_pending_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }

  // ── 1. Record ──────────────────────────────────────────────────────
  if (startIdx <= STEPS.indexOf('record')) {
    spinner.start('Recording...');
    spinner.stop('Ready to record.');
    console.log('');

    const recordResult = await record({
      site: opts.site,
      url: opts.url,
      persistProfile: opts.persistProfile,
      signal: opts.signal,
    });
    sessionPath = recordResult.sessionPath;

    checkpoint(opts.site, state, workflowKey, {
      sessionPath: toRelative(opts.site, sessionPath),
      completedSteps: ['record'],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!sessionPath) {
    throw new Error(
      'No session path — cannot continue. Re-run with --from-session or start fresh.',
    );
  }

  // ── 2. Redact ──────────────────────────────────────────────────────
  if (startIdx <= STEPS.indexOf('redact')) {
    spinner.start('Redacting credentials...');
    const session = loadJsonFile(
      sessionPath,
      SessionSchema,
      {
        notFound: 'Session file not found after recording.',
        badSchema: 'Session file is malformed.',
      },
      'session',
    );
    const { session: scrubbed, stats } = redactSession(session);
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
    writeFileSync(redactedPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
    spinner.stop(
      `Redacted ${stats.totalRedactions} value(s) across ${stats.requestsRedacted} request(s) and ${stats.cookiesRedacted} cookie(s).`,
    );

    updateCheckpoint(opts.site, state, workflowKey, 'redact', {
      redactedPath: toRelative(opts.site, redactedPath),
    });
  }

  if (!redactedPath) {
    redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
  }

  // ── 3. Generate workflow (agentic — long-running) ──────────────────
  let workflowDir: string;
  let genResult: { workflow: Workflow; workflowPath: string };

  if (startIdx <= STEPS.indexOf('generate')) {
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
    // Write to a temp path first; we'll know the toolName after.
    const tempOutPath = pathResolve('examples', opts.site, '_temp_workflow.json');
    const result = await generate({
      sessionPath: redactedPath,
      outPath: tempOutPath,
      llmConfig: { provider: providerName, model: compileModel },
      onProgress: (progress) => {
        spinner.message(formatCompileProgress(progress));
      },
    });

    // Now we know the toolName — create the workflow subdirectory.
    const toolName = result.workflow.toolName;
    workflowDir = pathResolve('examples', opts.site, toolName);
    mkdirSync(workflowDir, { recursive: true });

    const finalWorkflowPath = pathJoin(workflowDir, 'workflow.json');
    const { renameSync } = require('node:fs');
    renameSync(tempOutPath, finalWorkflowPath);

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

    updateCheckpoint(opts.site, state, workflowKey, 'generate');
  } else {
    // Resuming after generate — workflowKey IS the toolName.
    workflowDir = pathResolve('examples', opts.site, workflowKey);
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
    spinner.start('Compiling DOM playbook...');
    const playbookOutPath = pathJoin(workflowDir, 'playbook.yaml');
    const result = await compilePlaybook({
      sessionPath: redactedPath,
      outPath: playbookOutPath,
      llmConfig: { provider: providerName },
    });
    pbResult = { playbook: result.playbook, playbookPath: result.playbookPath };
    spinner.stop(
      `playbook.yaml → ${result.playbook.steps.length} step(s), ${result.playbook.parameters.length} param(s)`,
    );

    updateCheckpoint(opts.site, state, workflowKey, 'compile-playbook');
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

    updateCheckpoint(opts.site, state, workflowKey, 'emit');
  } else {
    emitOutPath = pathJoin(workflowDir, 'index.ts');
  }

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
            site: opts.site,
            workflow: genResult.workflow,
            platform: plat,
            imprintCommand,
          }),
        );
        console.log('');
      }
    } else {
      await interactivePlatformSetup({
        site: opts.site,
        workflow: genResult.workflow,
        playbook: pbResult.playbook,
      });
    }
  }

  // All steps complete — remove from state.
  delete state.workflows[workflowKey];
  saveTeachState(opts.site, state);

  p.outro('Done! Your agent is ready.');

  return {
    sessionPath: sessionPath!,
    workflowPath: genResult.workflowPath,
    playbookPath: pbResult.playbookPath,
    indexPath: emitOutPath,
    workflow: genResult.workflow,
    playbook: pbResult.playbook,
  };
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
  workflow: Workflow;
  playbook: Playbook;
}): Promise<void> {
  const { site, workflow, playbook } = opts;
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
        const proc = Bun.spawnSync(regCommand, { stdio: ['ignore', 'pipe', 'pipe'] });
        if (proc.exitCode === 0) {
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
    await offerSkillExport({ site, workflow, playbook, platform });
  }
}

async function offerSkillExport(opts: {
  site: string;
  workflow: Workflow;
  playbook: Playbook;
  platform: 'openclaw' | 'hermes';
}): Promise<void> {
  const { site, workflow, playbook, platform } = opts;

  const cronPath = pathResolve(process.cwd(), 'examples', site, 'cron.json');
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
