/**
 * `imprint cron <site>` — polling daemon for a generated tool. Loads
 * examples/<site>/cron.json, schedules via node-cron, runs the tool
 * through the configured backend ladder per tick, and pushes via
 * notify.ts on failure (or on a notifyWhen predicate match).
 *
 * One process per schedule by design — matches how systemd timers /
 * launchd are organized and keeps failure isolation clean.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import cron from 'node-cron';
import { resolveLadder, runWithLadder } from './backend-ladder.ts';
import { createLog } from './log.ts';
import { evaluateNotifyWhen, notify } from './notify.ts';
import { loadBackendsCache } from './probe-backends.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import { type ResolvedTool, buildZodValidator, discoverTools } from './tool-loader.ts';
import {
  type CronConfig,
  CronConfigSchema,
  type NotifyWhen,
  type ReplayBackend,
  type ToolResult,
} from './types.ts';

interface RunCronOptions {
  /** Example directory under examples/, e.g. "discoverandgo". */
  site: string;
  /** Override examples directory. Defaults to <cwd>/examples. */
  examplesDir?: string;
  /** Override config path. Defaults to <examplesDir>/<site>/cron.json. */
  configPath?: string;
  /** Run a single tick and exit. Mutually exclusive with runNow. */
  once?: boolean;
  /** Run immediately on startup AND continue scheduling. */
  runNow?: boolean;
  /** Inject for tests; defaults to global fetch. Used by Pushover/ntfy notifications. */
  notifyFetchImpl?: typeof fetch;
}

const log = createLog('cron');

function loadCronConfig(configPath: string): CronConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `cron.json not found at ${configPath}\n→ create one with: {"schedule":"0 9 * * *","params":{},"replayBackend":"auto"}\n→ see docs/getting-started.md for full schema.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return CronConfigSchema.parse(raw);
}

/** One tool tick: walk the ladder, log, push notification on result. */
async function runOnce(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
  notifyFetchImpl: typeof fetch | undefined,
  notifyWhen: NotifyWhen | undefined,
  ladder: ReplayBackend[],
  examplesDir: string,
  stealthCache: Map<string, StealthFetch>,
): Promise<ToolResult> {
  const startedAt = new Date();
  log(
    `${startedAt.toISOString()} ${tool.workflow.toolName} starting (ladder: ${ladder.join(' → ')})`,
  );
  const t0 = Date.now();

  const { result, usedBackend, attempts } = await runWithLadder(
    ladder,
    tool,
    params,
    examplesDir,
    stealthCache,
  );

  const elapsed = Date.now() - t0;
  for (const a of attempts) {
    if (a.outcome === 'escalate') log(`  ${a.backend} → ${a.detail} (escalating)`);
  }

  if (result.ok) {
    const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    // Cap the inline preview at ~500 chars; full payload available via
    // IMPRINT_DEBUG=1. Long-running daemons flood stderr otherwise.
    const preview =
      process.env.IMPRINT_DEBUG || data.length <= 500
        ? data
        : `${data.slice(0, 500)}…(${data.length - 500} more chars; set IMPRINT_DEBUG=1 to log full payload)`;
    log(`  OK in ${elapsed}ms via ${usedBackend}: ${preview}`);
    if (notifyWhen) {
      try {
        const decision = evaluateNotifyWhen(notifyWhen, result.data, tool.workflow.toolName);
        if (decision.notify) {
          await notify(
            decision.title ?? `imprint: ${tool.workflow.toolName}`,
            decision.message ?? '(no message)',
            notifyFetchImpl,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  notifyWhen evaluation failed: ${msg}`);
      }
    }
  } else {
    // Failures must surface even in --quiet mode — that's the whole point
    // (cron runs silently on success, mails on failure). Bypass createLog's
    // quiet-aware path and write directly to stderr.
    process.stderr.write(
      `[imprint cron]   FAILED [${result.error}] via ${usedBackend} in ${elapsed}ms: ${result.message}\n`,
    );
    if (result.remediation) {
      process.stderr.write(`[imprint cron]   → ${result.remediation}\n`);
    }
    await notify(
      `imprint: ${tool.workflow.toolName} failed`,
      `[${result.error}] ${result.message}${result.remediation ? `\n→ ${result.remediation}` : ''}`,
      notifyFetchImpl,
    );
  }
  return result;
}

export async function runCron(opts: RunCronOptions): Promise<void> {
  if (opts.once && opts.runNow) {
    throw new Error('cannot combine --once with --run-now (use one or the other)');
  }

  const examplesDir = opts.examplesDir ?? pathResolve(process.cwd(), 'examples');
  const configPath = opts.configPath ?? pathResolve(examplesDir, opts.site, 'cron.json');
  if (!existsSync(configPath)) {
    throw new Error(
      `cron.json not found at ${configPath}\n${availableSitesHint(examplesDir, opts.site)}\n→ create one with: {"schedule":"0 9 * * *","params":{},"replayBackend":"auto"}\n→ see docs/getting-started.md for full schema.`,
    );
  }
  const config = loadCronConfig(configPath);
  log(`config: ${configPath}`);

  const discovered = await discoverTools(examplesDir, opts.site, '[imprint cron]');
  const tool = discovered[0];
  if (!tool) {
    throw new Error(
      `No generated tool found for site "${opts.site}".\n${availableSitesHint(examplesDir, opts.site)}\n→ run \`imprint emit examples/${opts.site}/workflow.json\` first.`,
    );
  }

  if (!cron.validate(config.schedule)) {
    throw new Error(`Invalid cron expression in ${configPath}: "${config.schedule}"`);
  }

  const replayBackend = config.replayBackend ?? 'fetch';
  const playbookPath = pathResolve(examplesDir, opts.site, 'playbook.yaml');
  if (replayBackend === 'playbook' && !existsSync(playbookPath)) {
    throw new Error(
      `replayBackend="playbook" but ${playbookPath} doesn't exist. Run \`imprint compile-playbook\` first.`,
    );
  }

  // Probe cache reorders the 'auto' ladder to start with the empirically
  // cheapest known-working backend.
  const cached = loadBackendsCache(opts.site, examplesDir);
  if (cached) {
    log(
      `backends.json: probed ${cached.probedAt}, preferred order: ${cached.preferredOrder.join(' → ')}`,
    );
  }

  // Validate params against the API workflow only when fetch/stealth-fetch
  // is in the ladder; playbook has its own param schema with different names.
  const ladder = resolveLadder(replayBackend, cached?.preferredOrder);
  let params: Record<string, string | number | boolean>;
  if (ladder.includes('fetch') || ladder.includes('stealth-fetch')) {
    const validator = buildZodValidator(tool.workflow.parameters);
    const parsed = validator.safeParse(config.params);
    if (!parsed.success) {
      const issues = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`cron.json params invalid for ${tool.workflow.toolName}: ${issues}`);
    }
    params = parsed.data;
  } else {
    params = config.params;
  }

  log(`tool: ${tool.workflow.toolName} (${tool.workflow.parameters.length} param(s))`);
  log(`schedule: ${config.schedule}`);
  if (config.notifyWhen) log(`notifyWhen: ${config.notifyWhen.type}`);
  log(
    `replayBackend: ${replayBackend}${ladder.length > 1 ? ` (ladder: ${ladder.join(' → ')})` : ''}`,
  );

  // Per-site stealth-fetch cache — bootstrap cost paid once per process.
  const stealthCache = new Map<string, StealthFetch>();

  const tickArgs = [
    tool,
    params,
    opts.notifyFetchImpl,
    config.notifyWhen,
    ladder,
    examplesDir,
    stealthCache,
  ] as const;

  if (opts.once) {
    await runOnce(...tickArgs);
    return;
  }

  if (opts.runNow) {
    await runOnce(...tickArgs);
  }

  // node-cron's callbacks are sync; we kick off the async work and let it
  // run, swallowing the promise locally (errors are already logged in
  // runOnce). Two ticks could theoretically overlap if the workflow takes
  // longer than the schedule period — fine for v0.1, callers picking
  // sub-second cadences should handle their own concurrency.
  const task = cron.schedule(config.schedule, () => {
    void runOnce(...tickArgs);
  });
  task.start();
  log('scheduled — Ctrl-C to stop');

  await new Promise<void>((resolve) => {
    const shutdown = (sig: NodeJS.Signals): void => {
      log(`received ${sig}, stopping schedule`);
      task.stop();
      // Clean up StealthFetch instances (no-op currently, but future-
      // proof for if we add long-lived browser support).
      for (const sf of stealthCache.values()) {
        void sf.close();
      }
      resolve();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}

/** List the configured sites under examples/ to suggest in error messages. */
function availableSitesHint(examplesDir: string, badSite: string): string {
  if (!existsSync(examplesDir)) {
    return "→ examples/ doesn't exist — run `imprint record <site>` to create one.";
  }
  const sites = readdirSync(examplesDir).filter((d) => {
    try {
      return statSync(pathResolve(examplesDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (sites.length === 0) {
    return '→ examples/ is empty — run `imprint record <site>` to create one.';
  }
  return `→ available sites: ${sites.join(', ')} (you asked for "${badSite}").`;
}
