/**
 * Backend ladder for replay.
 *
 * Three backends, in increasing order of cost + bot-detection robustness:
 *   1. `fetch`         — captured workflow.json via Node fetch (~200ms)
 *   2. `stealth-fetch` — Playwright-bootstrapped sensor tokens + native
 *                        fetch (~12s bootstrap one-time, ~1s per call)
 *   3. `playbook`      — full Playwright + stealth + DOM walk (~9.4s)
 *
 * `runWithLadder([...], tool, params, examplesDir, stealthCache)` walks
 * them in order, escalating only on FORBIDDEN. Other error classes
 * (AUTH_EXPIRED, NETWORK, RATE_LIMITED, etc) return immediately —
 * a different backend can't fix those.
 *
 * The principle: as long as some backend would have worked, the call
 * succeeds. "Imprint can't help here" is the failure mode we're
 * eliminating.
 */

import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { createLog } from './log.ts';
import { runPlaybook } from './playbook-runner.ts';
import { type StealthFetch, createStealthFetch } from './stealth-fetch.ts';
import type { ResolvedTool } from './tool-loader.ts';
import type { ReplayBackend, ToolResult } from './types.ts';

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
 * Lazily mint a per-site stealth fetcher, cached across calls so the
 * Playwright bootstrap cost is paid once per site per process.
 */
function ensureStealthFetch(tool: ResolvedTool, cache: Map<string, StealthFetch>): StealthFetch {
  const cached = cache.get(tool.site);
  if (cached) return cached;
  const sf = createStealthFetch({ baseUrl: pickBaseUrl(tool) });
  cache.set(tool.site, sf);
  return sf;
}

/**
 * Heuristic: use the workflow's first request URL's origin as the base
 * for the stealth-fetch bootstrap. This is the right domain to load so
 * Akamai's sensor JS runs and binds tokens to that origin. The origin
 * comes from the URL prefix before any path segment, which is always
 * literal — `${param.X}` substitutions only appear after the domain in
 * well-formed workflows — so a regex extract is safe and doesn't need
 * access to runtime substitution.
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

function playbookPath(examplesDir: string, site: string): string {
  return pathResolve(examplesDir, site, 'playbook.yaml');
}
