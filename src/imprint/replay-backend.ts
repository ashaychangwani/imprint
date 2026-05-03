/**
 * Backend ladder for replay.
 *
 * Three backends, in increasing order of cost + bot-detection robustness:
 *   1. `fetch`         — captured workflow.json via Node fetch (~200ms)
 *   2. `stealth-fetch` — Playwright-bootstrapped sensor tokens + native
 *                        fetch (~12s bootstrap one-time, ~1s per call)
 *   3. `playbook`      — full Playwright + stealth + DOM walk (~9.4s)
 *
 * `runWithLadder(['fetch','stealth-fetch','playbook'], ctx)` walks them
 * in order, escalating only on FORBIDDEN. Other error classes
 * (AUTH_EXPIRED, NETWORK, RATE_LIMITED, etc) return immediately —
 * a different backend can't fix those.
 *
 * The principle: as long as some backend would have worked, the call
 * succeeds. "Imprint can't help here" is the failure mode we're
 * eliminating.
 */

import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { ResolvedTool } from './discover-tools.ts';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import { StealthFetch, createStealthFetchImpl } from './stealth-fetch.ts';
import type { ReplayBackend, ToolResult } from './types.ts';

export interface BackendContext {
  tool: ResolvedTool;
  params: Record<string, string | number | boolean>;
  examplesDir: string;
  /**
   * Per-process cache of long-lived StealthFetch instances. Keyed by
   * site so the bootstrap cost is paid once per site per process.
   * Caller (cron / mcp-server) owns the cache and passes it in.
   */
  stealthCache: Map<string, StealthFetch>;
}

export interface LadderResult {
  result: ToolResult;
  /** Which backend produced the returned result. */
  usedBackend: ReplayBackend;
  /** Per-backend log entries — one per ladder rung that was tried. */
  attempts: Array<{
    backend: ReplayBackend;
    outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
    detail: string;
    durationMs: number;
  }>;
}

const log = createLog('backend');

/**
 * Walk a list of backends in order, escalating on FORBIDDEN. Returns
 * the first non-FORBIDDEN result OR the last FORBIDDEN if every
 * backend failed.
 */
export async function runWithLadder(
  ladder: ReplayBackend[],
  ctx: BackendContext,
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const attempts: LadderResult['attempts'] = [];
  let lastResult: ToolResult | null = null;

  for (const backend of ladder) {
    if (!(await backendAvailable(backend, ctx))) {
      attempts.push({
        backend,
        outcome: 'unavailable',
        detail: backend === 'playbook' ? 'no playbook.yaml' : 'prerequisite missing',
        durationMs: 0,
      });
      log(`${backend}: skipped (prerequisite missing)`);
      continue;
    }

    const t0 = Date.now();
    log(`trying ${backend}…`);
    const result = await runBackend(backend, ctx);
    const durationMs = Date.now() - t0;
    lastResult = result;

    if (result.ok) {
      attempts.push({
        backend,
        outcome: 'ok',
        detail: `succeeded in ${durationMs}ms`,
        durationMs,
      });
      log(`${backend}: OK in ${durationMs}ms`);
      return { result, usedBackend: backend, attempts };
    }

    if (result.error === 'FORBIDDEN') {
      attempts.push({
        backend,
        outcome: 'escalate',
        detail: `${result.error}: ${result.message.slice(0, 120)}`,
        durationMs,
      });
      log(`${backend}: FORBIDDEN in ${durationMs}ms — escalating`);
      continue;
    }

    // Non-FORBIDDEN errors don't escalate — a different backend can't
    // fix AUTH_EXPIRED or NETWORK or RATE_LIMITED.
    attempts.push({
      backend,
      outcome: 'failed',
      detail: `${result.error}: ${result.message.slice(0, 120)}`,
      durationMs,
    });
    log(`${backend}: ${result.error} in ${durationMs}ms — non-escalatable, returning`);
    return { result, usedBackend: backend, attempts };
  }

  // Every backend either escalated (FORBIDDEN) or was unavailable.
  // Return the last actual result; if everything was unavailable
  // there's no result to return.
  if (!lastResult) {
    return {
      result: {
        ok: false,
        error: 'UNKNOWN',
        message: `Every backend in the ladder was unavailable: ${ladder.join(', ')}. For "auto" mode, ensure at least workflow.json exists; for the playbook rung, run \`imprint compile-playbook\` first.`,
      },
      usedBackend: ladder[ladder.length - 1] ?? 'fetch',
      attempts,
    };
  }
  log(`every backend escalated; returning last error from ${ladder[ladder.length - 1]}`);
  return {
    result: lastResult,
    usedBackend: ladder[ladder.length - 1] ?? 'fetch',
    attempts,
  };
}

/**
 * Translate a `replayBackend` config value into the ordered ladder
 * the runner walks. When `auto` is requested AND a backends.json
 * probe cache exists for the site, prefer the cached order — it's the
 * empirical "what worked at probe time" rather than the default
 * fetch → stealth-fetch → playbook. The cached order's tail still
 * acts as a fallback in case the preferred backend stops working.
 */
export function ladderFor(backend: ReplayBackend, cachedOrder?: ReplayBackend[]): ReplayBackend[] {
  switch (backend) {
    case 'auto':
      if (cachedOrder && cachedOrder.length > 0) return cachedOrder;
      return ['fetch', 'stealth-fetch', 'playbook'];
    case 'fetch':
    case 'stealth-fetch':
    case 'playbook':
      return [backend];
  }
}

async function backendAvailable(backend: ReplayBackend, ctx: BackendContext): Promise<boolean> {
  if (backend === 'auto') return true; // never used directly
  if (backend === 'fetch' || backend === 'stealth-fetch') return true;
  if (backend === 'playbook') {
    return existsSync(playbookPath(ctx));
  }
  return false;
}

async function runBackend(backend: ReplayBackend, ctx: BackendContext): Promise<ToolResult> {
  switch (backend) {
    case 'fetch':
      return runFetch(ctx);
    case 'stealth-fetch':
      return runStealthFetch(ctx);
    case 'playbook':
      return runPlaybookBackend(ctx);
    case 'auto':
      throw new Error('auto is a meta-backend; expand via ladderFor() before runBackend()');
  }
}

async function runFetch(ctx: BackendContext): Promise<ToolResult> {
  try {
    return await ctx.tool.toolFn(ctx.params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'UNKNOWN', message: `tool threw: ${msg}` };
  }
}

async function runStealthFetch(ctx: BackendContext): Promise<ToolResult> {
  const sf = ensureStealthFetch(ctx);
  const stealthImpl = createStealthFetchImpl(sf);
  try {
    return await ctx.tool.toolFn(ctx.params, { fetchImpl: stealthImpl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'UNKNOWN', message: `stealth-fetch threw: ${msg}` };
  }
}

async function runPlaybookBackend(ctx: BackendContext): Promise<ToolResult> {
  return runPlaybook({
    playbook: playbookPath(ctx),
    params: ctx.params,
  });
}

function playbookPath(ctx: BackendContext): string {
  return pathResolve(ctx.examplesDir, ctx.tool.site, 'playbook.yaml');
}

/**
 * Lazily mint a per-site StealthFetch instance, cached on the context.
 * The bootstrap probe URL is the first request URL from the captured
 * workflow (post-substitution) — Akamai's interceptor only injects
 * sensor headers for paths it recognizes, so a site-relevant probe is
 * required.
 */
function ensureStealthFetch(ctx: BackendContext): StealthFetch {
  const cached = ctx.stealthCache.get(ctx.tool.site);
  if (cached) return cached;

  const baseUrl = pickBaseUrl(ctx.tool);
  const sf = new StealthFetch({ baseUrl });
  ctx.stealthCache.set(ctx.tool.site, sf);
  return sf;
}

/**
 * Heuristic: use the workflow's first request URL's origin as the base
 * for the StealthFetch bootstrap. This is the right domain to load so
 * Akamai's sensor JS runs and binds tokens to that origin. The origin
 * comes from the URL prefix before any path segment, which is
 * always literal — `${param.X}` substitutions only appear after the
 * domain in well-formed workflows — so a regex extract is safe and
 * doesn't need access to runtime substitution.
 */
function pickBaseUrl(tool: ResolvedTool): string {
  const firstRequest = tool.workflow.requests[0];
  if (!firstRequest) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — stealth-fetch needs at least one request URL to derive the bootstrap origin.`,
    );
  }
  const m = firstRequest.url.match(/^(https?:\/\/[^/]+)/);
  if (m?.[1]) return m[1];
  throw new Error(`Could not derive bootstrap origin from URL: ${firstRequest.url}`);
}
