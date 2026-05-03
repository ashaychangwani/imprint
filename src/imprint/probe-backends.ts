/**
 * `imprint probe-backends <site>` — try each backend once at record
 * time, write the ranked order to `examples/<site>/backends.json`.
 *
 * cron + MCP read this at startup so they don't burn a fetch attempt
 * on every tick for known-blocked sites. Without the probe, an
 * `"auto"` cron tick logs `fetch FORBIDDEN → escalate` every single
 * tick — wasted work + log noise. With it, the runtime starts with
 * the cheapest known-working backend and falls back through the rest
 * only if the preferred one stops working between probes.
 *
 * The probe uses cron.json's params if present (most realistic — those
 * are the values the operator actually intends to use). Otherwise
 * falls back to workflow defaults. If neither, fails loudly so the
 * operator supplies them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { discoverTools } from './discover-tools.ts';
import { type BackendContext, runWithLadder } from './replay-backend.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import { type BackendsCache, BackendsCacheSchema, CronConfigSchema } from './types.ts';

export interface ProbeBackendsOptions {
  site: string;
  examplesDir?: string;
  /** Override params instead of reading cron.json / workflow defaults. */
  paramOverrides?: Record<string, string | number | boolean>;
  /** Where to write backends.json. Defaults to <examplesDir>/<site>/backends.json. */
  outPath?: string;
}

export interface ProbeBackendsResult {
  cache: BackendsCache;
  outPath: string;
}

const IMPRINT_VERSION = '0.1.0';
const log = (msg: string): void => {
  process.stderr.write(`[imprint probe] ${msg}\n`);
};

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

  // Probe the full ladder. Unlike runtime use, the probe attempts EVERY
  // rung even when an earlier one succeeded — operators want to know
  // which backends WOULD work, not just the first one that did.
  const stealthCache = new Map<string, StealthFetch>();
  const ctx: BackendContext = {
    tool,
    params,
    examplesDir,
    stealthCache,
  };
  // The probe targets the three real backends (not 'auto', which is a
  // meta-value that expands to a ladder of these).
  type ConcreteBackend = 'fetch' | 'stealth-fetch' | 'playbook';
  const allBackends: ConcreteBackend[] = ['fetch', 'stealth-fetch', 'playbook'];
  const results: BackendsCache['results'] = {};
  const working: ConcreteBackend[] = [];

  for (const backend of allBackends) {
    log(`probing ${backend}…`);
    const t0 = Date.now();
    // Run each rung as a single-rung ladder so escalation logic doesn't
    // skip over any backends.
    const { result, attempts } = await runWithLadder([backend], ctx);
    const durationMs = Date.now() - t0;
    const attempt = attempts[0];

    if (!attempt) {
      // Shouldn't happen — runWithLadder always records at least one attempt.
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
      'For bot-protected sites, ensure stealth-fetch can reach the site (try `imprint cron <site> --once` with replayBackend: stealth-fetch). For sites that need DOM walks, ensure `imprint compile-playbook` produced a working playbook.md.';
    throw new Error(
      `No backend succeeded for ${opts.site}. Results:\n${JSON.stringify(results, null, 2)}\n${hint}`,
    );
  }

  const cache: BackendsCache = {
    probedAt: new Date().toISOString(),
    imprintVersion: IMPRINT_VERSION,
    preferredOrder: working,
    results,
  };
  // Validate via Zod before write — catches schema drift early.
  BackendsCacheSchema.parse(cache);

  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`);
  log(`wrote ${outPath} — preferred: ${working.join(' → ')}`);

  return { cache, outPath };
}

/**
 * Read the backends.json cache for a site. Returns null if the file
 * doesn't exist or fails to parse — runtime falls back to the default
 * ladder. Schema validation errors are warnings, not throws, since a
 * stale cache shouldn't break the cron loop.
 */
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

/**
 * Pick params for the probe in priority order:
 *   1. Explicit overrides passed by the caller
 *   2. cron.json's params block (most realistic — what the operator
 *      will actually use in production)
 *   3. The workflow's parameter defaults
 * Throws if no values can be assembled for a required parameter.
 */
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
