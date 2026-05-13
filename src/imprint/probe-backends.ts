/**
 * `imprint probe-backends <site>` — try each backend once and write the
 * ranked working order to examples/<site>/<toolName>/backends.json. cron + MCP
 * read it at startup so they skip futile rungs every tick for sites
 * where one backend is known-blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { runWithLadder } from './backend-ladder.ts';
import { createLog } from './log.ts';
import { availableSitesHint } from './sites.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import { type ResolvedTool, discoverTools } from './tool-loader.ts';
import {
  type BackendsCache,
  BackendsCacheSchema,
  type ConcreteBackend,
  CronConfigSchema,
  WorkflowSchema,
} from './types.ts';
import { VERSION } from './version.ts';

interface ProbeBackendsOptions {
  site: string;
  examplesDir?: string;
  /** Override params instead of reading cron.json / workflow defaults. */
  paramOverrides?: Record<string, string | number | boolean>;
  /** Where to write backends.json. Defaults to <examplesDir>/<site>/<toolName>/backends.json. */
  outPath?: string;
}

interface ProbeBackendsResult {
  cache: BackendsCache;
  outPath: string;
}

const log = createLog('probe');

export async function probeBackends(opts: ProbeBackendsOptions): Promise<ProbeBackendsResult> {
  const examplesDir = opts.examplesDir ?? pathResolve(process.cwd(), 'examples');
  const discovered = await discoverTools(examplesDir, opts.site, '[imprint probe]');
  const tool = discovered[0];
  if (!tool) {
    throw new Error(
      `No generated tool found for site "${opts.site}".\n${availableSitesHint(examplesDir, opts.site)}\n→ run \`imprint emit examples/${opts.site}/<toolName>/workflow.json\` first.`,
    );
  }
  const outPath = opts.outPath ?? pathResolve(tool.dir, 'backends.json');

  const params = resolveParams(tool, opts.paramOverrides);

  log(`probing fetch / fetch-bootstrap / stealth-fetch / playbook for ${tool.workflow.toolName}…`);
  log(`  params: ${JSON.stringify(params)}`);

  // Try every backend (single-rung ladders) — operators want the full
  // matrix, not just the first that worked.
  const stealthCache = new Map<string, StealthFetch>();
  const allBackends: ConcreteBackend[] = workflowNeedsBootstrap(tool.workflow)
    ? ['fetch', 'fetch-bootstrap', 'stealth-fetch', 'playbook']
    : ['fetch', 'stealth-fetch', 'playbook'];
  const results: BackendsCache['results'] = {};
  const working: ConcreteBackend[] = [];

  for (const backend of allBackends) {
    log(`probing ${backend}…`);
    const t0 = Date.now();
    const { result, attempts } = await runWithLadder(
      [backend],
      tool,
      params,
      examplesDir,
      stealthCache,
    );
    const durationMs = Date.now() - t0;
    const attempt = attempts[0];

    if (!attempt) {
      results[backend] = { outcome: 'skipped', detail: 'no attempt recorded' };
      continue;
    }

    if (attempt.outcome === 'unavailable') {
      results[backend] = { outcome: 'unavailable', detail: attempt.detail };
      log(`  ${backend}: unavailable (${attempt.detail})`);
      continue;
    }

    if (result.ok) {
      results[backend] = { outcome: 'ok', durationMs };
      working.push(backend);
      log(`  ${backend}: OK in ${durationMs}ms`);
      continue;
    }

    if (result.error === 'FORBIDDEN') {
      results[backend] = {
        outcome: 'forbidden',
        durationMs,
        detail: result.message.slice(0, 200),
      };
      log(`  ${backend}: FORBIDDEN`);
    } else {
      results[backend] = {
        outcome: 'failed',
        durationMs,
        error: result.error,
        detail: result.message.slice(0, 200),
      };
      log(`  ${backend}: ${result.error} — ${result.message.slice(0, 100)}`);
    }
  }

  if (working.length === 0) {
    const hint =
      'For bot-protected sites, ensure stealth-fetch can reach the site (try `imprint cron <site> --once` with replayBackend: stealth-fetch). For sites that need DOM walks, ensure `imprint compile-playbook` produced a working playbook.yaml.';
    throw new Error(
      `No backend succeeded for ${opts.site}. Results:\n${JSON.stringify(results, null, 2)}\n${hint}`,
    );
  }

  const cache: BackendsCache = {
    probedAt: new Date().toISOString(),
    imprintVersion: VERSION,
    schemaVersion: 2,
    workflowHash: workflowHash(tool.workflow),
    capabilityHash: capabilityHash(tool.workflow),
    preferredOrder: working,
    results,
  };
  BackendsCacheSchema.parse(cache); // catch schema drift early

  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`);
  log(`wrote ${outPath} — preferred: ${working.join(' → ')}`);

  return { cache, outPath };
}

function workflowNeedsBootstrap(workflow: ResolvedTool['workflow']): boolean {
  if (workflow.bootstrap) return true;
  return workflow.requests.some((r) =>
    (r.captures ?? []).some(
      (c) => c.capability === 'browser_bootstrap' || c.capability === 'stealth_bootstrap',
    ),
  );
}

function workflowHash(workflow: ResolvedTool['workflow']): string {
  return createHash('sha256')
    .update(JSON.stringify(WorkflowSchema.parse(workflow)))
    .digest('hex');
}

function capabilityHash(workflow: ResolvedTool['workflow']): string {
  const caps = {
    bootstrap: Boolean(workflow.bootstrap),
    captures: workflow.requests.flatMap((r) =>
      (r.captures ?? []).map((c) => `${c.source}:${c.name}:${c.capability}`),
    ),
  };
  return createHash('sha256').update(JSON.stringify(caps)).digest('hex');
}

/** Read backends.json. Returns null on missing/malformed — runtime
 *  falls back to the default ladder; a stale cache must never break cron. */
export function loadBackendsCache(
  site: string,
  _examplesDir: string,
  toolDir?: string,
): BackendsCache | null {
  if (!toolDir) return null;
  const path = pathResolve(toolDir, 'backends.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = BackendsCacheSchema.parse(raw);
    if (parsed.schemaVersion && parsed.schemaVersion >= 2 && parsed.workflowHash) {
      const workflowPath = pathResolve(toolDir, 'workflow.json');
      if (existsSync(workflowPath)) {
        const currentHash = workflowHashSync(readFileSync(workflowPath, 'utf8'));
        if (currentHash !== parsed.workflowHash) {
          process.stderr.write(
            `[imprint] backends.json at ${path} is stale for current workflow — ignoring (run \`imprint probe-backends ${site}\` to regenerate)\n`,
          );
          return null;
        }
      }
    }
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[imprint] backends.json at ${path} failed to parse — ignoring (run \`imprint probe-backends ${site}\` to regenerate): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

function workflowHashSync(workflowJson: string): string {
  return createHash('sha256')
    .update(JSON.stringify(WorkflowSchema.parse(JSON.parse(workflowJson))))
    .digest('hex');
}

/** Param priority: caller overrides → cron.json → workflow defaults. */
function resolveParams(
  tool: ResolvedTool,
  overrides?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const cronPath = pathResolve(tool.dir, 'cron.json');
  let cronParams: Record<string, string | number | boolean> = {};
  if (existsSync(cronPath)) {
    try {
      const raw = JSON.parse(readFileSync(cronPath, 'utf8'));
      const parsed = CronConfigSchema.safeParse(raw);
      if (parsed.success) cronParams = parsed.data.params;
    } catch {
      // Ignore — fall through to workflow defaults
    }
  }

  const out: Record<string, string | number | boolean> = {};
  for (const p of tool.workflow.parameters) {
    if (overrides && p.name in overrides) {
      const v = overrides[p.name];
      if (v !== undefined) out[p.name] = v;
    } else if (p.name in cronParams) {
      const v = cronParams[p.name];
      if (v !== undefined) out[p.name] = v;
    } else if (p.default !== undefined) {
      out[p.name] = p.default as string | number | boolean;
    } else {
      throw new Error(
        `Probe needs a value for required param "${p.name}". Either set it in cron.json, give it a default in workflow.json, or pass --param ${p.name}=<value>.`,
      );
    }
  }
  return out;
}
