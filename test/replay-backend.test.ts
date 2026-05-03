/**
 * Tests for the backend ladder. Pure-logic — no real Chromium, no real
 * network. Synthesizes fake ResolvedTool instances and exercises
 * runWithLadder against fake backend implementations.
 *
 * The actual backends (fetch / stealth-fetch / playbook) have their
 * own test files; this file is about the ladder's escalation logic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import type { ResolvedTool } from '../src/imprint/discover-tools.ts';
import { runWithLadder } from '../src/imprint/replay-backend.ts';
import { type StealthFetch, createStealthFetch } from '../src/imprint/stealth-fetch.ts';
import type { ToolResult, Workflow } from '../src/imprint/types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-ladder-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Build a fake ResolvedTool whose toolFn returns whatever the test
 * dictates per call. The function distinguishes API-path calls (no
 * fetchImpl) from stealth-fetch path calls (fetchImpl injected) so
 * tests can assert which backend ran.
 */
interface FakeToolBehavior {
  /** Result for the API/fetch path call (no fetchImpl). */
  fetchResult?: ToolResult;
  /** Result for the stealth-fetch path call (fetchImpl injected). */
  stealthResult?: ToolResult;
  /** Track which paths were actually invoked. */
  calls: { fetch: number; stealth: number };
}

function makeFakeTool(site: string, behavior: FakeToolBehavior): ResolvedTool {
  const workflow: Workflow = {
    toolName: `tool_${site}`,
    intent: { description: `tool for ${site}` },
    parameters: [],
    requests: [
      {
        method: 'GET',
        url: `https://${site}.example.com/api/x`,
        headers: {},
      },
    ],
    site,
  };
  const toolFn = async (
    _input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<ToolResult> => {
    if (opts?.fetchImpl) {
      behavior.calls.stealth++;
      return behavior.stealthResult ?? { ok: true, data: { via: 'stealth' } };
    }
    behavior.calls.fetch++;
    return behavior.fetchResult ?? { ok: true, data: { via: 'fetch' } };
  };
  return { site, workflow, toolFn };
}

/**
 * Per-test stealth cache. Pre-populated with a stub for the tool so the
 * ladder doesn't try to launch real Chromium when stealth-fetch is in
 * the mix. The fake tool's toolFn doesn't actually CALL the fetchImpl,
 * so this stub is never invoked — it just satisfies the type.
 */
function makeStealthCache(tool: ResolvedTool): Map<string, StealthFetch> {
  const cache = new Map<string, StealthFetch>();
  cache.set(tool.site, createStealthFetch(`https://${tool.site}.example.com`));
  return cache;
}

describe('runWithLadder — single-rung explicit', () => {
  it('returns the fetch result directly when explicit "fetch"', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: true, data: { x: 1 } },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(['fetch'], tool, {}, root, makeStealthCache(tool));
    expect(r.usedBackend).toBe('fetch');
    expect(r.result.ok).toBe(true);
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(0);
  });

  it('does NOT escalate on FORBIDDEN when ladder has only one rung', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(['fetch'], tool, {}, root, makeStealthCache(tool));
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe('FORBIDDEN');
    expect(r.usedBackend).toBe('fetch');
    expect(behavior.calls.stealth).toBe(0);
  });
});

describe('runWithLadder — auto escalation', () => {
  it('escalates fetch → stealth-fetch on FORBIDDEN', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'akamai' },
      stealthResult: { ok: true, data: { prices: [42] } },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    expect(r.result.ok).toBe(true);
    expect(r.usedBackend).toBe('stealth-fetch');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
    // Two attempts logged: fetch (escalate) + stealth-fetch (ok)
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'escalate' });
    expect(r.attempts[1]).toMatchObject({ backend: 'stealth-fetch', outcome: 'ok' });
  });

  it('does NOT escalate on AUTH_EXPIRED — that is a different problem', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: {
        ok: false,
        error: 'AUTH_EXPIRED',
        message: 'session expired',
        remediation: 'log in',
      },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    expect(r.usedBackend).toBe('fetch');
    if (r.result.ok) throw new Error('expected failure');
    expect(r.result.error).toBe('AUTH_EXPIRED');
    expect(behavior.calls.stealth).toBe(0);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'failed' });
  });

  it('returns the last FORBIDDEN when every rung escalates', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'fetch blocked' },
      stealthResult: { ok: false, error: 'FORBIDDEN', message: 'stealth blocked' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe('FORBIDDEN');
    // The last attempt's result wins.
    expect(r.result.message).toContain('stealth blocked');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
  });

  it('skips playbook rung when no playbook.yaml exists', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      stealthResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    // examplesDir/alpha/playbook.yaml does NOT exist
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch', 'playbook'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts[2]).toMatchObject({ backend: 'playbook', outcome: 'unavailable' });
    // Last actual result is the second escalated FORBIDDEN
    expect(r.result.ok).toBe(false);
  });

  it('reaches playbook when playbook.yaml exists', async () => {
    // Create the playbook.yaml file so playbook rung is "available"
    const siteDir = pathResolve(root, 'alpha');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(
      pathResolve(siteDir, 'playbook.yaml'),
      `toolName: tool_alpha
summary: x
parameters: []
steps:
  - action: navigate
    url: about:blank
result:
  source: xhr
  url_pattern: never
  extract: x
  return_as: r
`,
    );
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      stealthResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch', 'playbook'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    // Playbook will fail too (no real browser, navigates about:blank, no
    // matching XHR) — but it WAS attempted.
    expect(r.attempts).toHaveLength(3);
    const playbookAttempt = r.attempts[2];
    if (!playbookAttempt) throw new Error('expected 3rd attempt');
    expect(playbookAttempt.backend).toBe('playbook');
    expect(['ok', 'failed', 'escalate']).toContain(playbookAttempt.outcome);
  });
});

describe('runWithLadder — empty ladder', () => {
  it('throws on an empty ladder', async () => {
    const tool = makeFakeTool('alpha', { calls: { fetch: 0, stealth: 0 } });
    await expect(runWithLadder([], tool, {}, root, makeStealthCache(tool))).rejects.toThrow(
      /empty ladder/,
    );
  });
});
