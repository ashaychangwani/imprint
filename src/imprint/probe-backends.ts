/**
 * `imprint probe-backends <site>` — try each backend once and write the
 * ranked working order to <IMPRINT_HOME>/<site>/<toolName>/backends.json. cron + MCP
 * read it at startup so they skip futile rungs every tick for sites
 * where one backend is known-blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve as pathResolve } from 'node:path';
import { runWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { availableSitesHint } from './sites.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import { type ResolvedTool, discoverTools } from './tool-loader.ts';
import { selectGeneratedTool } from './tool-selection.ts';
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
  /** Override generated asset root. Defaults to IMPRINT_HOME (~/.imprint). */
  assetRoot?: string;
  /** Override params instead of reading cron.json / workflow defaults. */
  paramOverrides?: Record<string, string | number | boolean>;
  /** Where to write backends.json. Defaults to <assetRoot>/<site>/<toolName>/backends.json. */
  outPath?: string;
  /** Select a specific generated tool when a site has more than one. */
  toolName?: string;
}

interface ProbeBackendsResult {
  cache: BackendsCache;
  outPath: string;
}

const log = createLog('probe');
const DEFAULT_PREFERRED_MAX_MS = 90_000;

type BackendProbeCandidate = {
  backend: ConcreteBackend;
  durationMs: number;
  rankingDurationMs?: number;
  coldDurationMs?: number;
  warmDurationMs?: number;
  tooSlow: boolean;
};

type BackendRuntimeAttempt = {
  backend: ConcreteBackend;
  outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
  detail: string;
  durationMs: number;
};

export type BackendsCacheStatus =
  | {
      status: 'missing';
      path: string | null;
      remediation: string;
    }
  | {
      status: 'ok';
      path: string;
      cache: BackendsCache;
    }
  | {
      status: 'stale' | 'invalid';
      path: string;
      reason: string;
      remediation: string;
    };

export async function probeBackends(opts: ProbeBackendsOptions): Promise<ProbeBackendsResult> {
  const assetRoot = opts.assetRoot ?? imprintHomeDir();
  const discovered = await discoverTools(assetRoot, opts.site, '[imprint probe]');
  const tool = selectGeneratedTool({
    site: opts.site,
    tools: discovered,
    purpose: 'probe',
    toolName: opts.toolName,
    pathHint: opts.outPath,
    pathHintLabel: '--out',
  });
  if (!tool) {
    throw new Error(
      `No generated tool found for site "${opts.site}".\n${availableSitesHint(assetRoot, opts.site)}\n→ run \`imprint teach ${opts.site}\` or \`imprint emit ~/.imprint/${opts.site}/<toolName>/workflow.json\` first.`,
    );
  }
  return await probeResolvedTool(opts, assetRoot, tool, opts.outPath);
}

export async function probeAllBackends(
  opts: Omit<ProbeBackendsOptions, 'outPath' | 'toolName'>,
): Promise<ProbeBackendsResult[]> {
  const assetRoot = opts.assetRoot ?? imprintHomeDir();
  const discovered = await discoverTools(assetRoot, opts.site, '[imprint probe]');
  if (discovered.length === 0) {
    throw new Error(
      `No generated tools found for site "${opts.site}".\n${availableSitesHint(assetRoot, opts.site)}\n→ run \`imprint teach ${opts.site}\` or \`imprint emit ~/.imprint/${opts.site}/<toolName>/workflow.json\` first.`,
    );
  }

  const results: ProbeBackendsResult[] = [];
  for (const tool of [...discovered].sort((a, b) =>
    a.workflow.toolName.localeCompare(b.workflow.toolName),
  )) {
    results.push(await probeResolvedTool(opts, assetRoot, tool));
  }
  return results;
}

async function probeResolvedTool(
  opts: Pick<ProbeBackendsOptions, 'site' | 'paramOverrides'>,
  assetRoot: string,
  tool: ResolvedTool,
  explicitOutPath?: string,
): Promise<ProbeBackendsResult> {
  const outPath = explicitOutPath ?? pathResolve(tool.dir, 'backends.json');

  const params = resolveParams(tool, opts.paramOverrides);

  log(`probing backends for ${tool.workflow.toolName}…`);
  log(`  params: ${JSON.stringify(params)}`);

  // Try every backend (single-rung ladders) — operators want the full
  // matrix, not just the first that worked. cdp-replay is included so it
  // lands in preferredOrder when it works — without it, runtime always
  // falls through fetch-bootstrap (~30-60s) before reaching the spliced-in
  // cdp-replay rung, wasting time on every call.
  const stealthCache = new Map<string, StealthFetch>();
  const cdpPool = new Map<string, CdpBrowserFetch>();
  const allBackends: ConcreteBackend[] = workflowNeedsBootstrap(tool.workflow)
    ? ['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch', 'playbook']
    : ['fetch', 'stealth-fetch', 'playbook'];
  const results: BackendsCache['results'] = {};
  const working: BackendProbeCandidate[] = [];
  const preferredMaxMs = preferredBackendMaxMs();

  try {
    for (const backend of allBackends) {
      log(`probing ${backend}…`);
      const t0 = Date.now();
      const { result, attempts } = await runWithLadder(
        [backend],
        tool,
        params,
        assetRoot,
        stealthCache,
        backend === 'cdp-replay' ? { cdpPool, skipBootstrapSplice: true } : undefined,
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
        const warm =
          backend === 'cdp-replay'
            ? await probeWarmCdpReplay(tool, params, assetRoot, stealthCache, cdpPool)
            : null;
        const tooSlow = durationMs > preferredMaxMs;
        const rankingDurationMs = warm?.ok ? warm.durationMs : durationMs;
        const detailParts: string[] = [];
        if (tooSlow)
          detailParts.push(`cold start exceeded preferred backend threshold ${preferredMaxMs}ms`);
        if (warm?.ok) detailParts.push(`warm cdp-replay succeeded in ${warm.durationMs}ms`);
        else if (warm) detailParts.push(`warm cdp-replay failed: ${warm.detail}`);
        results[backend] = {
          outcome: 'ok',
          durationMs,
          ...(backend === 'cdp-replay'
            ? {
                coldDurationMs: durationMs,
                ...(warm?.ok ? { warmDurationMs: warm.durationMs, rankingDurationMs } : {}),
              }
            : {}),
          ...(tooSlow ? { tooSlow: true } : {}),
          ...(detailParts.length ? { detail: detailParts.join('; ') } : {}),
        };
        working.push({
          backend,
          durationMs,
          ...(backend === 'cdp-replay' ? { coldDurationMs: durationMs } : {}),
          ...(warm?.ok ? { warmDurationMs: warm.durationMs, rankingDurationMs } : {}),
          tooSlow,
        });
        log(
          `  ${backend}: OK in ${durationMs}ms${warm?.ok ? ` (warm ${warm.durationMs}ms)` : ''}${tooSlow ? ' (cold slow)' : ''}`,
        );
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
  } finally {
    await closeProbeCdpPool(cdpPool);
  }

  if (working.length === 0) {
    const hint =
      'For bot-protected sites, ensure stealth-fetch can reach the site (try `imprint cron <site> --once` with replayBackend: stealth-fetch). For sites that need DOM walks, ensure `imprint compile-playbook` produced a working playbook.yaml.';
    throw new Error(
      `No backend succeeded for ${opts.site}. Results:\n${JSON.stringify(results, null, 2)}\n${hint}`,
    );
  }

  const preferredOrder = rankSuccessfulBackends(working);
  const cache: BackendsCache = {
    probedAt: new Date().toISOString(),
    imprintVersion: VERSION,
    schemaVersion: 2,
    workflowHash: workflowHash(tool.workflow),
    capabilityHash: capabilityHash(tool.workflow),
    preferredOrder,
    results,
  };
  BackendsCacheSchema.parse(cache); // catch schema drift early

  writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`);
  log(`wrote ${outPath} — preferred: ${preferredOrder.join(' → ')}`);

  return { cache, outPath };
}

export function rankSuccessfulBackends(candidates: BackendProbeCandidate[]): ConcreteBackend[] {
  return [...candidates]
    .sort((a, b) => {
      if (a.tooSlow !== b.tooSlow) return a.tooSlow ? 1 : -1;
      return effectiveRankingDuration(a) - effectiveRankingDuration(b);
    })
    .map((c) => c.backend);
}

function effectiveRankingDuration(candidate: BackendProbeCandidate): number {
  return candidate.rankingDurationMs ?? candidate.warmDurationMs ?? candidate.durationMs;
}

function backendResultTooSlow(result: BackendsCache['results'][string] | undefined): boolean {
  return result?.outcome === 'ok' && result.tooSlow === true;
}

function invalidPreferredOrderReason(cache: BackendsCache): string | null {
  for (const backend of cache.preferredOrder) {
    const result = cache.results[backend];
    if (backend === 'playbook' && result?.outcome !== 'ok') {
      return 'preferredOrder includes playbook without a successful playbook result';
    }
    if (result && result.outcome !== 'ok') {
      return `preferredOrder includes ${backend} with ${result.outcome} result`;
    }
  }
  return null;
}

function existingBackendUsable(
  backend: ConcreteBackend,
  result: BackendsCache['results'][string] | undefined,
): boolean {
  if (!result) return backend !== 'playbook';
  return result.outcome === 'ok';
}

async function probeWarmCdpReplay(
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
  assetRoot: string,
  stealthCache: Map<string, StealthFetch>,
  cdpPool: Map<string, CdpBrowserFetch>,
): Promise<{ ok: true; durationMs: number } | { ok: false; detail: string } | null> {
  if (!cdpPool.has(tool.site)) return null;
  log('probing cdp-replay warm reuse…');
  const t0 = Date.now();
  const { result } = await runWithLadder(['cdp-replay'], tool, params, assetRoot, stealthCache, {
    cdpPool,
    skipBootstrapSplice: true,
  });
  const durationMs = Date.now() - t0;
  if (result.ok) return { ok: true, durationMs };
  return { ok: false, detail: `${result.error}: ${result.message.slice(0, 160)}` };
}

async function closeProbeCdpPool(cdpPool: Map<string, CdpBrowserFetch>): Promise<void> {
  const sessions = [...cdpPool.values()];
  cdpPool.clear();
  await Promise.allSettled(sessions.map((session) => session.close()));
}

function preferredBackendMaxMs(): number {
  const raw = Number(process.env.IMPRINT_BACKEND_PREFERRED_MAX_MS ?? DEFAULT_PREFERRED_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREFERRED_MAX_MS;
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

/** Read backends.json with status information. Runtime can still fall back to
 *  the default ladder, while status commands can explain why a cache was not
 *  usable. */
export function loadBackendsCacheStatus(
  site: string,
  _assetRoot: string,
  toolDir?: string,
  opts: { warn?: boolean; toolName?: string } = {},
): BackendsCacheStatus {
  const remediation = backendsCacheRemediation(site, opts.toolName ?? toolDirName(toolDir));
  if (!toolDir) return { status: 'missing', path: null, remediation };
  const path = pathResolve(toolDir, 'backends.json');
  if (!existsSync(path)) return { status: 'missing', path, remediation };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = BackendsCacheSchema.parse(raw);
    if (parsed.schemaVersion && parsed.schemaVersion >= 2 && parsed.workflowHash) {
      const workflowPath = pathResolve(toolDir, 'workflow.json');
      if (existsSync(workflowPath)) {
        const currentHash = workflowHashSync(readFileSync(workflowPath, 'utf8'));
        if (currentHash !== parsed.workflowHash) {
          const reason = 'workflow hash changed';
          if (opts.warn !== false) {
            process.stderr.write(
              `[imprint] backends.json at ${path} is stale for current workflow — ignoring (run \`${remediation}\` to regenerate)\n`,
            );
          }
          return { status: 'stale', path, reason, remediation };
        }
      }
    }
    const invalidPreferredReason = invalidPreferredOrderReason(parsed);
    if (invalidPreferredReason) {
      if (opts.warn !== false) {
        process.stderr.write(
          `[imprint] backends.json at ${path} has unsafe preferred backends — ignoring (run \`${remediation}\` to regenerate): ${invalidPreferredReason}\n`,
        );
      }
      return { status: 'invalid', path, reason: invalidPreferredReason, remediation };
    }
    return { status: 'ok', path, cache: parsed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.warn !== false) {
      process.stderr.write(
        `[imprint] backends.json at ${path} failed to parse — ignoring (run \`${remediation}\` to regenerate): ${reason}\n`,
      );
    }
    return { status: 'invalid', path, reason, remediation };
  }
}

/** Read backends.json. Returns null on missing/malformed — runtime
 *  falls back to the default ladder; a stale cache must never break cron. */
export function loadBackendsCache(
  site: string,
  _assetRoot: string,
  toolDir?: string,
): BackendsCache | null {
  const status = loadBackendsCacheStatus(site, _assetRoot, toolDir);
  return status.status === 'ok' ? status.cache : null;
}

export function persistRuntimeBackendsCache(opts: {
  tool: ResolvedTool;
  assetRoot: string;
  usedBackend: ConcreteBackend;
  attempts: BackendRuntimeAttempt[];
}): BackendsCache | null {
  const status = loadBackendsCacheStatus(opts.tool.site, opts.assetRoot, opts.tool.dir, {
    warn: false,
    toolName: opts.tool.workflow.toolName,
  });
  const results: BackendsCache['results'] =
    status.status === 'ok' ? { ...status.cache.results } : {};

  for (const attempt of opts.attempts) {
    if (attempt.outcome === 'ok') {
      const tooSlow = attempt.durationMs > preferredBackendMaxMs();
      results[attempt.backend] = {
        outcome: 'ok',
        durationMs: attempt.durationMs,
        ...(tooSlow
          ? {
              tooSlow: true,
              detail: `exceeded preferred backend threshold ${preferredBackendMaxMs()}ms`,
            }
          : {}),
      };
    } else if (attempt.outcome === 'unavailable') {
      results[attempt.backend] = { outcome: 'unavailable', detail: attempt.detail };
    } else if (attempt.detail.startsWith('FORBIDDEN:')) {
      results[attempt.backend] = {
        outcome: 'forbidden',
        durationMs: attempt.durationMs,
        detail: attempt.detail.slice(0, 200),
      };
    } else {
      const error = attempt.detail.split(':')[0] || 'UNKNOWN';
      results[attempt.backend] = {
        outcome: 'failed',
        durationMs: attempt.durationMs,
        error,
        detail: attempt.detail.slice(0, 200),
      };
    }
  }

  const existingPreferred = status.status === 'ok' ? status.cache.preferredOrder : [];
  const observedOkAttempts = opts.attempts
    .filter((a) => a.outcome === 'ok')
    .sort((a, b) => a.durationMs - b.durationMs);
  const observedOk = observedOkAttempts.map((a) => a.backend);
  const slowObservedOk = observedOkAttempts
    .filter((a) => a.durationMs > preferredBackendMaxMs())
    .map((a) => a.backend);
  const fastObservedOk = observedOk.filter((backend) => !slowObservedOk.includes(backend));
  const usedOkAttempt = observedOkAttempts.find((a) => a.backend === opts.usedBackend);
  const usedBackendTooSlow =
    usedOkAttempt !== undefined && usedOkAttempt.durationMs > preferredBackendMaxMs();
  const existingUsable = existingPreferred.filter((backend) =>
    existingBackendUsable(backend, results[backend]),
  );
  const existingFast = existingUsable.filter((backend) => !backendResultTooSlow(results[backend]));
  const existingSlow = existingUsable.filter((backend) => backendResultTooSlow(results[backend]));
  const preferredOrder = uniqueBackends([
    ...(usedOkAttempt && !usedBackendTooSlow ? [opts.usedBackend] : []),
    ...existingFast,
    ...fastObservedOk,
    ...existingSlow,
    ...slowObservedOk,
    ...(usedOkAttempt && usedBackendTooSlow ? [opts.usedBackend] : []),
  ]);
  const cache: BackendsCache = {
    probedAt: new Date().toISOString(),
    imprintVersion: VERSION,
    schemaVersion: 2,
    workflowHash: workflowHash(opts.tool.workflow),
    capabilityHash: capabilityHash(opts.tool.workflow),
    preferredOrder,
    results,
  };

  BackendsCacheSchema.parse(cache);
  writeFileSync(pathResolve(opts.tool.dir, 'backends.json'), `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

function workflowHashSync(workflowJson: string): string {
  return createHash('sha256')
    .update(JSON.stringify(WorkflowSchema.parse(JSON.parse(workflowJson))))
    .digest('hex');
}

function backendsCacheRemediation(site: string, toolName?: string): string {
  return toolName
    ? `imprint probe-backends ${site} --tool ${toolName}`
    : `imprint probe-backends ${site}`;
}

function toolDirName(toolDir?: string): string | undefined {
  return toolDir ? basename(toolDir) : undefined;
}

function uniqueBackends(backends: ConcreteBackend[]): ConcreteBackend[] {
  const seen = new Set<ConcreteBackend>();
  const out: ConcreteBackend[] = [];
  for (const backend of backends) {
    if (seen.has(backend)) continue;
    seen.add(backend);
    out.push(backend);
  }
  return out;
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
