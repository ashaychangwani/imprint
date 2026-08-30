/**
 * `imprint probe-backends <site>` — try each backend once and write the
 * ranked working order to <IMPRINT_HOME>/<site>/<toolName>/backends.json. cron + MCP
 * read it at startup so they skip futile rungs every tick for sites
 * where one backend is known-blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  type BackendsCacheStatus,
  loadBackendsCache,
  loadBackendsCacheStatus,
} from './backend-cache.ts';
import { prefersCdpReplayFirst, runWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
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
  type RequestStageFact,
  type ToolResult,
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

export type BackendRequestStageFact = RequestStageFact & { backend: ConcreteBackend };

const REQUEST_STAGE_FACTS_MARKER = 'IMPRINT_REQUEST_STAGE_FACTS=';
const MAX_BACKEND_REQUEST_STAGE_FACTS = 32;

function backendRequestStageFacts(
  backend: ConcreteBackend,
  value: unknown,
): BackendRequestStageFact[] {
  if (!Array.isArray(value)) return [];
  const facts: BackendRequestStageFact[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const fact = candidate as Record<string, unknown>;
    if (typeof fact.requestIndex !== 'number' || !Number.isInteger(fact.requestIndex)) continue;
    if (!['preparation', 'transform', 'send'].includes(String(fact.stage))) continue;
    if (!['passed', 'failed', 'skipped', 'unavailable'].includes(String(fact.outcome))) continue;
    facts.push({
      backend,
      requestIndex: fact.requestIndex,
      stage: fact.stage as RequestStageFact['stage'],
      outcome: fact.outcome as RequestStageFact['outcome'],
      ...(typeof fact.bodyPresent === 'boolean' ? { bodyPresent: fact.bodyPresent } : {}),
      ...(typeof fact.bodyByteLength === 'number' &&
      Number.isInteger(fact.bodyByteLength) &&
      fact.bodyByteLength >= 0
        ? { bodyByteLength: fact.bodyByteLength }
        : {}),
      ...(typeof fact.bodyChanged === 'boolean' ? { bodyChanged: fact.bodyChanged } : {}),
      ...(typeof fact.httpStatus === 'number' &&
      Number.isInteger(fact.httpStatus) &&
      fact.httpStatus >= 100 &&
      fact.httpStatus <= 599
        ? { httpStatus: fact.httpStatus }
        : {}),
    });
  }
  return facts.slice(-MAX_BACKEND_REQUEST_STAGE_FACTS);
}

function requestStageFactsSuffix(facts: readonly BackendRequestStageFact[]): string {
  if (facts.length === 0) return '';
  return `\n${REQUEST_STAGE_FACTS_MARKER}${JSON.stringify(
    facts.slice(-MAX_BACKEND_REQUEST_STAGE_FACTS),
  )}`;
}

export function parseBackendRequestStageFacts(text: string): BackendRequestStageFact[] {
  const markerIndex = text.lastIndexOf(REQUEST_STAGE_FACTS_MARKER);
  if (markerIndex < 0) return [];
  const encoded = text
    .slice(markerIndex + REQUEST_STAGE_FACTS_MARKER.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!encoded) return [];
  try {
    return sanitizeBackendRequestStageFacts(JSON.parse(encoded) as unknown);
  } catch {
    return [];
  }
}

/** Whitelist subprocess facts before retaining or returning them. */
export function sanitizeBackendRequestStageFacts(value: unknown): BackendRequestStageFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((candidate): BackendRequestStageFact[] => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const backend = (candidate as { backend?: unknown }).backend;
      if (
        backend !== 'fetch' &&
        backend !== 'fetch-bootstrap' &&
        backend !== 'cdp-replay' &&
        backend !== 'stealth-fetch' &&
        backend !== 'playbook'
      ) {
        return [];
      }
      return backendRequestStageFacts(backend, [candidate]);
    })
    .slice(-MAX_BACKEND_REQUEST_STAGE_FACTS);
}

/** Remove the internal subprocess transport trailer before surfacing an error.
 * The parsed, whitelisted facts are returned separately to verifier callers. */
export function stripBackendRequestStageFacts(text: string): string {
  const markerIndex = text.lastIndexOf(REQUEST_STAGE_FACTS_MARKER);
  if (markerIndex < 0) return text;
  const prefix = text.slice(0, markerIndex);
  return prefix.endsWith('\n') ? prefix.slice(0, -1).trimEnd() : prefix.trimEnd();
}

const log = createLog('probe');
const DEFAULT_PREFERRED_MAX_MS = 90_000;

export { loadBackendsCache, loadBackendsCacheStatus, type BackendsCacheStatus };

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

export async function probeResolvedTool(
  opts: Pick<ProbeBackendsOptions, 'site' | 'paramOverrides'>,
  assetRoot: string,
  tool: ResolvedTool,
  explicitOutPath?: string,
): Promise<ProbeBackendsResult> {
  if (workflowHasIrreversibleEffect(tool.workflow)) {
    throw new Error(
      `Backend probing is disabled for irreversible workflow "${tool.workflow.toolName}". Invoke it only through an intentional production tool call.`,
    );
  }
  const outPath = explicitOutPath ?? pathResolve(tool.dir, 'backends.json');

  const params = resolveParams(tool, opts.paramOverrides);

  log(`probing backends for ${tool.workflow.toolName}…`);
  log(`  parameter names: ${JSON.stringify(Object.keys(params).sort())}`);

  // Probe the workflow's normal candidates first. Plain workflows keep the
  // cheap fetch/stealth/playbook path; browser-backed API transports are only
  // added if none of those candidates works.
  const stealthCache = new Map<string, StealthFetch>();
  const cdpPool = new Map<string, CdpBrowserFetch>();
  const allBackends = probeCandidateBackendsForWorkflow(tool.workflow);
  const results: BackendsCache['results'] = {};
  const working: BackendProbeCandidate[] = [];
  const requestStageFacts: BackendRequestStageFact[] = [];
  const preferredMaxMs = preferredBackendMaxMs();
  const persistCurrentCache = (): BackendsCache => {
    const cache: BackendsCache = {
      probedAt: new Date().toISOString(),
      imprintVersion: VERSION,
      schemaVersion: 2,
      workflowHash: workflowHash(tool.workflow),
      capabilityHash: workflowCapabilityHash(tool.workflow),
      preferredOrder: rankSuccessfulBackends(working),
      results,
    };
    BackendsCacheSchema.parse(cache);
    writeFileSync(outPath, `${JSON.stringify(cache, null, 2)}\n`);
    return cache;
  };

  const probeCandidates = async (backends: ConcreteBackend[]): Promise<void> => {
    for (const backend of backends) {
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
      if (!result.ok) {
        requestStageFacts.push(...backendRequestStageFacts(backend, result.requestStageFacts));
      }

      const invariantFailure = backendInvariantProbeFailure(result);
      if (invariantFailure) {
        log(`  ${backend}: workflow rejected the request before transport — stopping probe`);
        throw new Error(
          `Backend-independent workflow failure for ${tool.workflow.toolName}: ${invariantFailure}${requestStageFactsSuffix(requestStageFacts)}`,
        );
      }

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
        // Keep a valid preferred backend durable as soon as one succeeds. A
        // later optional candidate may tarpit until the aggregate preparation
        // deadline; losing this earlier success would force an unnecessary
        // reprobe and leave the suite with no prepared backend.
        persistCurrentCache();
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
  };

  try {
    await probeCandidates(allBackends);
    if (working.length === 0 && !allBackends.includes('cdp-replay')) {
      log('default backends failed; probing browser-backed API fallbacks…');
      await probeCandidates(['cdp-replay', 'fetch-bootstrap']);
    }
  } finally {
    await closeProbeCdpPool(cdpPool);
  }

  if (working.length === 0) {
    const hint =
      'For bot-protected sites, ensure stealth-fetch can reach the site (try `imprint cron <site> --once` with replayBackend: stealth-fetch). For sites that need DOM walks, ensure `imprint compile-playbook` produced a working playbook.yaml.';
    throw new Error(
      `No backend succeeded for ${opts.site}. Results:\n${JSON.stringify(results, null, 2)}\n${hint}${requestStageFactsSuffix(requestStageFacts)}`,
    );
  }

  const cache = persistCurrentCache();
  log(`wrote ${outPath} — preferred: ${cache.preferredOrder.join(' → ')}`);

  return { cache, outPath };
}

/**
 * Some generated-workflow failures happen before any HTTP request is sent.
 * Retrying those through browser-backed transports is both expensive and
 * misleading: a different transport cannot repair a deterministic transform.
 * Keep remote HTTP BAD_RESPONSE failures probeable because bot defenses can
 * return backend-specific 4xx responses.
 */
export function backendInvariantProbeFailure(result: ToolResult): string | null {
  if (result.ok || result.error !== 'BAD_RESPONSE') return null;
  const transformCouldNotPrepareRequest = result.requestStageFacts?.some(
    ({ stage, outcome }) =>
      stage === 'transform' && (outcome === 'failed' || outcome === 'unavailable'),
  );
  return transformCouldNotPrepareRequest ||
    /^request transform (?:failed for request \d+:|module was unavailable)/i.test(result.message)
    ? result.message
    : null;
}

export function rankSuccessfulBackends(candidates: BackendProbeCandidate[]): ConcreteBackend[] {
  return [...candidates]
    .sort((a, b) => {
      if (a.tooSlow !== b.tooSlow) return a.tooSlow ? 1 : -1;
      if ((a.backend === 'playbook') !== (b.backend === 'playbook')) {
        return a.backend === 'playbook' ? 1 : -1;
      }
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
  return workflow.requests.some((request) =>
    (request.captures ?? []).some(
      (capture) =>
        capture.capability === 'browser_bootstrap' || capture.capability === 'stealth_bootstrap',
    ),
  );
}

export function probeCandidateBackendsForWorkflow(
  workflow: ResolvedTool['workflow'],
): ConcreteBackend[] {
  return workflowNeedsBootstrap(workflow) || prefersCdpReplayFirst(workflow)
    ? ['fetch', 'cdp-replay', 'fetch-bootstrap', 'stealth-fetch', 'playbook']
    : ['fetch', 'stealth-fetch', 'playbook'];
}

function workflowHash(workflow: ResolvedTool['workflow']): string {
  return createHash('sha256')
    .update(JSON.stringify(WorkflowSchema.parse(workflow)))
    .digest('hex');
}

export function workflowCapabilityHash(workflow: ResolvedTool['workflow']): string {
  const caps = {
    bootstrap: Boolean(workflow.bootstrap),
    prefersCdpReplayFirst: prefersCdpReplayFirst(workflow),
    requestModes: normalizedUnique(workflow.requests.map((request) => request.mode ?? 'fetch')),
    captures: normalizedUnique([
      ...(workflow.bootstrap?.captures ?? []).map(
        (capture) => `bootstrap:${capture.source}:${capture.capability}:${capture.required}`,
      ),
      ...workflow.requests.flatMap((request) =>
        (request.captures ?? []).map(
          (capture) => `request:${capture.source}:${capture.capability}:${capture.required}`,
        ),
      ),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(caps)).digest('hex');
}

function normalizedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function canRebindBackendsCacheToWorkflow(
  tool: Pick<ResolvedTool, 'workflow'>,
  cache: BackendsCache,
): boolean {
  return (
    typeof cache.capabilityHash === 'string' &&
    cache.capabilityHash === workflowCapabilityHash(tool.workflow)
  );
}

/** Carry a previously proven backend preference across a compile-time workflow
 * revision without performing network I/O. Runtime cache loading remains
 * hash-strict; this adapter deliberately rebinds only after the verifier has
 * decided the existing preference is still applicable. */
export function rebindBackendsCacheToWorkflow(
  tool: Pick<ResolvedTool, 'workflow' | 'dir'>,
  cache: BackendsCache,
  outPath = pathResolve(tool.dir, 'backends.json'),
): BackendsCache {
  if (!canRebindBackendsCacheToWorkflow(tool, cache)) {
    throw new Error('backend cache capabilities changed; run a fresh probe instead of rebinding');
  }
  const rebound: BackendsCache = {
    ...cache,
    workflowHash: workflowHash(tool.workflow),
    capabilityHash: workflowCapabilityHash(tool.workflow),
  };
  BackendsCacheSchema.parse(rebound);
  writeFileSync(outPath, `${JSON.stringify(rebound, null, 2)}\n`);
  return rebound;
}

/** Rebind an already-proven cache after compile-time metadata is stamped onto
 * workflow.json. This performs no network I/O and intentionally does nothing
 * for missing/invalid caches. */
export function rebindExistingBackendsCacheToWorkflow(toolDir: string): BackendsCache | null {
  const workflowPath = pathResolve(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return null;

  let workflow: ResolvedTool['workflow'];
  try {
    workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  } catch {
    return null;
  }

  const assetRoot = pathResolve(toolDir, '..', '..');
  const status = loadBackendsCacheStatus(workflow.site, assetRoot, toolDir, {
    warn: false,
    toolName: workflow.toolName,
  });
  if (status.status !== 'ok' && status.status !== 'stale') return null;
  if (!canRebindBackendsCacheToWorkflow({ workflow }, status.cache)) return null;
  return rebindBackendsCacheToWorkflow({ workflow, dir: toolDir }, status.cache);
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
  const soleAttempt = opts.attempts.length === 1 ? opts.attempts[0] : undefined;
  if (
    status.status === 'ok' &&
    status.cache.preferredOrder[0] === opts.usedBackend &&
    soleAttempt?.backend === opts.usedBackend &&
    soleAttempt.outcome === 'ok'
  ) {
    // A normal call through the already-proven preferred backend is not a
    // probe or a new backend-learning event. Preserve the original probe time
    // and its richer cold/warm/ranking diagnostics byte-for-byte on disk.
    return status.cache;
  }
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
    capabilityHash: workflowCapabilityHash(opts.tool.workflow),
    preferredOrder,
    results,
  };

  BackendsCacheSchema.parse(cache);
  writeFileSync(pathResolve(opts.tool.dir, 'backends.json'), `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
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
