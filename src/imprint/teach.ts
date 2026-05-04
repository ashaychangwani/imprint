/**
 * `imprint teach` — interactive pipeline that chains record → redact → generate
 * → compile-playbook → emit automatically, then presents a platform picker
 * and outputs paste snippets or runs registration commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import { compilePlaybook, generate } from './compile.ts';
import { emit } from './emit.ts';
import {
  type Platform,
  buildRegistrationCommand,
  detectImprintCommand,
  generatePasteSnippet,
  generateSkillMd,
} from './integrations.ts';
import { loadJsonFile } from './load-json.ts';
import { record } from './record.ts';
import { redactSession } from './redact.ts';
import { CronConfigSchema, SessionSchema } from './types.ts';
import type { CronConfig, Playbook, Workflow } from './types.ts';

interface TeachOptions {
  site: string;
  url?: string;
  persistProfile?: boolean;
  signal?: AbortSignal;
  /** Skip interactive prompts — print all snippets. For CI/scripting. */
  noInteractive?: boolean;
}

interface TeachResult {
  sessionPath: string;
  workflowPath: string;
  playbookPath: string;
  indexPath: string;
  workflow: Workflow;
  playbook: Playbook;
}

export async function teach(opts: TeachOptions): Promise<TeachResult> {
  p.intro(`imprint teach — teaching your agent to use ${opts.site}`);

  // ── 1. Record ──────────────────────────────────────────────────────
  const spinner = p.spinner();
  spinner.start('Recording...');
  // Stop the spinner before recording because record() is interactive
  // (user drives the browser and types narration)
  spinner.stop('Ready to record.');

  console.log(''); // blank line before record output
  const recordResult = await record({
    site: opts.site,
    url: opts.url,
    persistProfile: opts.persistProfile,
    signal: opts.signal,
  });
  const { sessionPath } = recordResult;

  // ── 2. Redact ──────────────────────────────────────────────────────
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
  const redactedPath = sessionPath.replace(/\.json$/, '.redacted.json');
  writeFileSync(redactedPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
  spinner.stop(
    `Redacted ${stats.totalRedactions} value(s) across ${stats.requestsRedacted} request(s) and ${stats.cookiesRedacted} cookie(s).`,
  );

  // ── 3. Generate workflow ───────────────────────────────────────────
  spinner.start('Generating API workflow...');
  const genResult = await generate({ sessionPath: redactedPath });
  spinner.stop(
    `workflow.json → ${genResult.workflow.toolName} (${genResult.workflow.requests.length} request(s), ${genResult.workflow.parameters.length} param(s))`,
  );

  // ── 4. Compile playbook ────────────────────────────────────────────
  spinner.start('Compiling DOM playbook...');
  const pbResult = await compilePlaybook({ sessionPath: redactedPath });
  spinner.stop(
    `playbook.yaml → ${pbResult.playbook.steps.length} step(s), ${pbResult.playbook.parameters.length} param(s)`,
  );

  // ── 5. Emit ────────────────────────────────────────────────────────
  spinner.start('Emitting tool...');
  const emitResult = emit({
    workflowPath: genResult.workflowPath,
    force: true, // teach always overwrites
  });
  spinner.stop(`${emitResult.outPath} generated.`);

  // ── 6. Platform integration ────────────────────────────────────────
  if (opts.noInteractive) {
    // Print all snippets for every platform.
    const imprintCommand = detectImprintCommand();
    const platforms: Platform[] = ['claude-code', 'codex', 'claude-desktop', 'openclaw', 'hermes'];
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

  p.outro('Done! Your agent is ready.');

  return {
    sessionPath,
    workflowPath: genResult.workflowPath,
    playbookPath: pbResult.playbookPath,
    indexPath: emitResult.outPath,
    workflow: genResult.workflow,
    playbook: pbResult.playbook,
  };
}

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
    // Platform supports auto-registration (claude-code, codex).
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
      spinner.start(`Running: ${regCommand}`);
      try {
        const proc = Bun.spawnSync(regCommand.split(' '), { stdio: ['ignore', 'pipe', 'pipe'] });
        if (proc.exitCode === 0) {
          spinner.stop(
            `imprint-${site} is now available in ${platform === 'claude-code' ? 'Claude Code' : 'Codex'}.`,
          );
        } else {
          const stderr = proc.stderr.toString().trim();
          spinner.stop(`Command exited with code ${proc.exitCode}${stderr ? `: ${stderr}` : ''}`);
          // Fall back to showing the snippet.
          console.log('\nRun this manually instead:');
          console.log(`  ${regCommand}\n`);
        }
      } catch (err) {
        spinner.stop(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('\nRun this manually instead:');
        console.log(`  ${regCommand}\n`);
      }
    } else {
      // Print paste snippet.
      const snippet = generatePasteSnippet({ site, workflow, platform, imprintCommand });
      console.log('\nPaste this into your terminal or AI tool:\n');
      console.log(`  ${snippet}\n`);
    }
  } else {
    // Platform requires manual config (claude-desktop, openclaw, hermes).
    const snippet = generatePasteSnippet({ site, workflow, platform, imprintCommand });
    console.log(`\n${snippet}\n`);
  }

  // For OpenClaw/Hermes, offer SKILL.md export.
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

  // Check for optional cron config.
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

  // Determine output path.
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
