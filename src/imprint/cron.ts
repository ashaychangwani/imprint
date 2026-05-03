/**
 * `imprint cron <site>` — polling daemon for a generated workflow.
 *
 * Loads `examples/<site>/cron.json`, validates the schedule + params,
 * then schedules the tool via node-cron. Each tick walks the configured
 * replayBackend ladder (fetch → stealth-fetch → playbook in 'auto')
 * and logs which backend produced the result. Failures additionally
 * fire a notification when configured.
 *
 * USAGE:
 *
 *   imprint cron discoverandgo                  # schedule and block until SIGINT
 *   imprint cron discoverandgo --run-now        # also run once immediately
 *   imprint cron discoverandgo --once           # run once and exit (for tests / OS scheduler)
 *   imprint cron discoverandgo --config /tmp/x  # override config path
 *
 * The cron daemon is single-example by design — run one process per
 * schedule. This matches how systemd timers and launchd are typically
 * organized and keeps failure isolation clean.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import cron from 'node-cron';
import { type ResolvedTool, buildZodValidator, discoverTools } from './discover-tools.ts';
import { createLog } from './log.ts';
import { evaluateNotifyWhen, notify } from './notify.ts';
import { loadBackendsCache } from './probe-backends.ts';
import { runWithLadder } from './replay-backend.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import {
  type CronConfig,
  CronConfigSchema,
  type NotifyWhen,
  type ReplayBackend,
  type ToolResult,
} from './types.ts';

export interface RunCronOptions {
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
      `cron.json not found at ${configPath}. Create one with {"schedule":"...","params":{...}}.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return CronConfigSchema.parse(raw);
}

/**
 * One execution of the workflow + result handling. Walks the
 * configured replayBackend ladder; first non-FORBIDDEN result wins.
 */
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
    log(`  OK in ${elapsed}ms via ${usedBackend}: ${data}`);
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
    log(`  FAILED [${result.error}] via ${usedBackend} in ${elapsed}ms: ${result.message}`);
    if (result.remediation) log(`  → ${result.remediation}`);
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
  const config = loadCronConfig(configPath);
  log(`config: ${configPath}`);

  const discovered = await discoverTools(examplesDir, opts.site, '[imprint cron]');
  const tool = discovered[0];
  if (!tool) {
    throw new Error(
      `No generated tool found for site "${opts.site}". Run \`imprint emit examples/${opts.site}/workflow.json\` first.`,
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

  // Read the probe cache if it exists. For replayBackend "auto" this
  // reorders the ladder to start from the empirically-cheapest known-
  // working backend instead of always trying fetch first.
  const cached = loadBackendsCache(opts.site, examplesDir);
  if (cached) {
    log(
      `backends.json: probed ${cached.probedAt}, preferred order: ${cached.preferredOrder.join(' → ')}`,
    );
  }

  // Param validation runs against the API workflow's parameters when
  // the fetch path can run (i.e., the ladder includes 'fetch'). For
  // backends with their own param schema (playbook), we accept whatever
  // the operator provided and let the runner enforce its own validation
  // — names typically differ (e.g., Southwest's `origin` vs
  // `origin_airport_code`) and the ladder fail-softs on mismatch.
  //
  // 'auto' expands to the cached preferred order (set by `imprint
  // probe-backends`) when available, otherwise the default cost-ranked
  // ladder. Explicit single-backend choices become single-rung ladders.
  const ladder: ReplayBackend[] =
    replayBackend === 'auto'
      ? (cached?.preferredOrder ?? ['fetch', 'stealth-fetch', 'playbook'])
      : [replayBackend];
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

  // Per-process StealthFetch cache so the bootstrap cost is paid once
  // per site and reused across all cron ticks in this process.
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
