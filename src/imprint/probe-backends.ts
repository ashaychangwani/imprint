/**
 * `imprint probe-backends <site>` — try each backend once and write the
 * ranked working order to examples/<site>/backends.json. cron + MCP
 * read it at startup so they skip futile rungs every tick for sites
 * where one backend is known-blocked.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { runWithLadder } from './backend-ladder.ts';
import { createLog } from './log.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import { discoverTools } from './tool-loader.ts';
import {
  type BackendsCache,
  BackendsCacheSchema,
  type ConcreteBackend,
  CronConfigSchema,
} from './types.ts';
import { VERSION } from './version.ts';

interface ProbeBackendsOptions {
  site: string;
  examplesDir?: string;
  /** Override params instead of reading cron.json / workflow defaults. */
  paramOverrides?: Record<string, string | number | boolean>;
  /** Where to write backends.json. Defaults to <examplesDir>/<site>/backends.json. */
  outPath?: string;
}

interface ProbeBackendsResult {
  cache: BackendsCache;
  outPath: string;
}

const log = createLog('probe');

export async function probeBackends(opts: ProbeBackendsOptions): Promise<ProbeBackendsResult> {
  const examplesDir = opts.examplesDir ?? pathResolve(process.cwd(), 'examples');
  const outPath = opts.outPath ?? pathResolve(examplesDir, opts.site, 'backends.json');

  const discovered = await discoverTools(examplesDir, opts.site, '[imprint probe]');
  const tool = discovered[0];
  if (!tool) {
    throw new Error(
      `No generated tool found for site "${opts.site}". Run \`imprint emit examples/${opts.site}/workflow.json\` first.`,
    );
  }

  const params = resolveParams(opts.site, examplesDir, tool, opts.paramOverrides);

  log(`probing fetch / stealth-fetch / playbook for ${tool.workflow.toolName}…`);
  log(`  params: ${JSON.stringify(params)}`);

  // Try every backend (single-rung ladders) — operators want the full
  // matrix, not just the first that worked.
  const stealthCache = new Map<string, StealthFetch>();
  const allBackends: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];
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
    preferredOrder: working,
    results,
  };
  BackendsCacheSchema.parse(cache); // catch schema drift early

  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`);
  log(`wrote ${outPath} — preferred: ${working.join(' → ')}`);

  return { cache, outPath };
}

/** Read backends.json. Returns null on missing/malformed — runtime
 *  falls back to the default ladder; a stale cache must never break cron. */
export function loadBackendsCache(site: string, examplesDir: string): BackendsCache | null {
  const path = pathResolve(examplesDir, site, 'backends.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return BackendsCacheSchema.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[imprint] backends.json at ${path} failed to parse — ignoring (run \`imprint probe-backends ${site}\` to regenerate): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/** Param priority: caller overrides → cron.json → workflow defaults. */
function resolveParams(
  site: string,
  examplesDir: string,
  tool: { workflow: { parameters: Array<{ name: string; default?: unknown }> } },
  overrides?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const cronPath = pathResolve(examplesDir, site, 'cron.json');
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
        `Probe needs a value for required param "${p.name}". Either set it in examples/${site}/cron.json, give it a default in workflow.json, or pass --param ${p.name}=<value>.`,
      );
    }
  }
  return out;
}
