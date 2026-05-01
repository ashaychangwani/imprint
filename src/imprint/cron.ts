/**
 * `imprint cron <site>` — polling daemon for a generated workflow.
 *
 * Loads `examples/<site>/cron.json`, validates the schedule + params
 * against the generated workflow, then schedules the tool function via
 * node-cron. Each tick logs start/end + result; failures additionally
 * fire a Pushover notification when configured.
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
import { notifyPushover } from './notify.ts';
import { type CronConfig, CronConfigSchema, type ToolResult } from './types.ts';

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
  /** Inject for tests; defaults to global fetch. Forwarded to the tool function. */
  fetchImpl?: typeof fetch;
  /** Inject for tests; defaults to global fetch. Used by Pushover notifications. */
  notifyFetchImpl?: typeof fetch;
}

const log = (msg: string): void => {
  process.stderr.write(`[imprint cron] ${msg}\n`);
};

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
 * One execution of the workflow + result handling. Used both for
 * scheduled ticks and the --once / --run-now paths.
 */
async function runOnce(
  tool: ResolvedTool,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch | undefined,
  notifyFetchImpl: typeof fetch | undefined,
): Promise<ToolResult> {
  const startedAt = new Date();
  log(`${startedAt.toISOString()} ${tool.workflow.toolName} starting`);
  const t0 = Date.now();
  let result: ToolResult;
  try {
    result = await tool.toolFn(params, fetchImpl ? { fetchImpl } : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { ok: false, error: 'UNKNOWN', message: `tool threw: ${msg}` };
  }
  const elapsed = Date.now() - t0;
  if (result.ok) {
    const data = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    log(`  OK in ${elapsed}ms: ${data}`);
  } else {
    log(`  FAILED [${result.error}] ${result.message} (${elapsed}ms)`);
    if (result.remediation) log(`  → ${result.remediation}`);
    await notifyPushover(
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

  // Validate params against the workflow's parameter declarations so a typo
  // in cron.json fails fast at startup, not on the first tick.
  const validator = buildZodValidator(tool.workflow.parameters);
  const parsed = validator.safeParse(config.params);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`cron.json params invalid for ${tool.workflow.toolName}: ${issues}`);
  }
  const params = parsed.data;

  if (!cron.validate(config.schedule)) {
    throw new Error(`Invalid cron expression in ${configPath}: "${config.schedule}"`);
  }

  log(`tool: ${tool.workflow.toolName} (${tool.workflow.parameters.length} param(s))`);
  log(`schedule: ${config.schedule}`);

  if (opts.once) {
    await runOnce(tool, params, opts.fetchImpl, opts.notifyFetchImpl);
    return;
  }

  if (opts.runNow) {
    await runOnce(tool, params, opts.fetchImpl, opts.notifyFetchImpl);
  }

  // node-cron's callbacks are sync; we kick off the async work and let it
  // run, swallowing the promise locally (errors are already logged in
  // runOnce). Two ticks could theoretically overlap if the workflow takes
  // longer than the schedule period — fine for v0.1, callers picking
  // sub-second cadences should handle their own concurrency.
  const task = cron.schedule(config.schedule, () => {
    void runOnce(tool, params, opts.fetchImpl, opts.notifyFetchImpl);
  });
  task.start();
  log('scheduled — Ctrl-C to stop');

  await new Promise<void>((resolve) => {
    const shutdown = (sig: NodeJS.Signals): void => {
      log(`received ${sig}, stopping schedule`);
      task.stop();
      resolve();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}
