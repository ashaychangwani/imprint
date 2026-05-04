/**
 * Walk a list of backends in order, escalating on FORBIDDEN; any
 * non-FORBIDDEN error returns immediately. Three backends in cost
 * order: fetch (~200ms) → stealth-fetch (~12s bootstrap then ~1s) →
 * playbook (~9.4s, universal). See docs/architecture.md for design.
 */

import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import { type StealthFetch, createStealthFetch } from './stealth-fetch.ts';
import type { ResolvedTool } from './tool-loader.ts';
import type { ReplayBackend, ToolResult } from './types.ts';

interface LadderResult {
  result: ToolResult;
  usedBackend: ReplayBackend;
  /** One entry per rung that was tried. */
  attempts: Array<{
    backend: ReplayBackend;
    outcome: 'ok' | 'escalate' | 'failed' | 'unavailable';
    detail: string;
    durationMs: number;
  }>;
}

const log = createLog('backend');

const DEFAULT_LADDER: ReplayBackend[] = ['fetch', 'stealth-fetch', 'playbook'];

/** Expand a replayBackend choice into a concrete ladder. 'auto' prefers
 *  the probed order (if any), else the default. Explicit choice → single rung. */
export function resolveLadder(
  backend: ReplayBackend,
  cachedPreferredOrder?: ReplayBackend[],
): ReplayBackend[] {
  if (backend === 'auto') {
    return cachedPreferredOrder && cachedPreferredOrder.length > 0
      ? cachedPreferredOrder
      : DEFAULT_LADDER;
  }
  return [backend];
}

/** First non-FORBIDDEN result wins; last FORBIDDEN returned if every rung escalates. */
export async function runWithLadder(
  ladder: ReplayBackend[],
  tool: ResolvedTool,
  params: Record<string, string | number | boolean>,
  examplesDir: string,
  stealthCache: Map<string, StealthFetch>,
): Promise<LadderResult> {
  if (ladder.length === 0) {
    throw new Error('runWithLadder: empty ladder');
  }

  const attempts: LadderResult['attempts'] = [];
  let lastResult: ToolResult | null = null;

  for (const backend of ladder) {
    if (backend === 'playbook' && !existsSync(playbookPath(examplesDir, tool.site))) {
      attempts.push({
        backend,
        outcome: 'unavailable',
        detail: 'no playbook.yaml',
        durationMs: 0,
      });
      log(`${backend}: skipped (prerequisite missing)`);
      continue;
    }

    const t0 = Date.now();
    log(`trying ${backend}…`);
    let result: ToolResult;
    try {
      switch (backend) {
        case 'fetch':
          result = await tool.toolFn(params);
          break;
        case 'stealth-fetch': {
          const sf = ensureStealthFetch(tool, stealthCache);
          result = await tool.toolFn(params, { fetchImpl: sf.fetchImpl });
          break;
        }
        case 'playbook':
          result = await runPlaybook({
            playbook: playbookPath(examplesDir, tool.site),
            params,
          });
          break;
        case 'auto':
          throw new Error('auto is a meta-backend; expand before runWithLadder()');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: 'UNKNOWN', message: `${backend} threw: ${msg}` };
    }
    const durationMs = Date.now() - t0;
    lastResult = result;

    if (result.ok) {
      attempts.push({ backend, outcome: 'ok', detail: `succeeded in ${durationMs}ms`, durationMs });
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

    // Non-FORBIDDEN errors don't escalate — different backend can't fix
    // AUTH_EXPIRED, NETWORK, RATE_LIMITED.
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

/** Per-site stealth fetcher; bootstrap pays its ~12s once per process. */
function ensureStealthFetch(tool: ResolvedTool, cache: Map<string, StealthFetch>): StealthFetch {
  const cached = cache.get(tool.site);
  if (cached) return cached;
  const sf = createStealthFetch({ baseUrl: pickBaseUrl(tool) });
  cache.set(tool.site, sf);
  return sf;
}

/** First request URL's origin — Akamai binds sensor tokens to that
 *  origin, and the origin is always literal (substitutions only appear
 *  after the domain in well-formed workflows). */
function pickBaseUrl(tool: ResolvedTool): string {
  const firstRequest = tool.workflow.requests[0];
  if (!firstRequest) {
    throw new Error(
      `Workflow ${tool.workflow.toolName} has no requests — stealth-fetch needs at least one request URL.\n→ re-record the session; recording probably stopped before any XHR fired.`,
    );
  }
  const m = firstRequest.url.match(/^(https?:\/\/[^/]+)/);
  if (m?.[1]) return m[1];
  throw new Error(
    `Could not derive bootstrap origin from URL: ${firstRequest.url}\n→ check workflow.json — the first request URL must start with https://<domain>.`,
  );
}

function playbookPath(examplesDir: string, site: string): string {
  return pathResolve(examplesDir, site, 'playbook.yaml');
}
