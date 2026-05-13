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
import { resolveLadder, runWithLadder } from '../src/imprint/backend-ladder.ts';
import { type StealthFetch, createStealthFetch } from '../src/imprint/stealth-fetch.ts';
import type { ResolvedTool } from '../src/imprint/tool-loader.ts';
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

function makeFakeTool(site: string, behavior: FakeToolBehavior, dir = ''): ResolvedTool {
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
  return { site, dir, workflow, toolFn };
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

describe('resolveLadder', () => {
  it('expands "auto" with no cached order to the default ladder', () => {
    expect(resolveLadder('auto')).toEqual(['fetch', 'stealth-fetch', 'playbook']);
  });

  it('expands "auto" with an empty cached order to the default ladder', () => {
    expect(resolveLadder('auto', [])).toEqual(['fetch', 'stealth-fetch', 'playbook']);
  });

  it('uses the cached preferred order for "auto" when provided', () => {
    expect(resolveLadder('auto', ['stealth-fetch', 'playbook'])).toEqual([
      'stealth-fetch',
      'playbook',
    ]);
  });

  it.each(['fetch', 'fetch-bootstrap', 'stealth-fetch', 'playbook'] as const)(
    'returns single-rung ladder for explicit %s',
    (backend) => {
      expect(resolveLadder(backend)).toEqual([backend]);
    },
  );

  it('ignores the cached order when an explicit backend is named', () => {
    expect(resolveLadder('fetch', ['stealth-fetch', 'playbook'])).toEqual(['fetch']);
  });
});

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

  it('does not escalate STATE_MISSING to stealth-fetch because it cannot fill state placeholders', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: {
        ok: false,
        error: 'STATE_MISSING',
        message: 'missing bot state',
        missing: [
          {
            name: 'sensor',
            source: 'state',
            capability: 'stealth_bootstrap',
            required: true,
            failure: 'producer_unavailable',
            message: 'sensor missing',
          },
        ],
      },
      stealthResult: { ok: true, data: { via: 'stealth' } },
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
    expect(r.usedBackend).toBe('fetch');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(0);
  });

  it('does not escalate STATE_MISSING when the next backend cannot satisfy it', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: {
        ok: false,
        error: 'STATE_MISSING',
        message: 'missing credential',
        missing: [
          {
            name: 'patron',
            source: 'credential',
            capability: 'credential_required',
            required: true,
            failure: 'credential_missing',
            message: 'credential missing',
          },
        ],
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
    expect(r.result.ok).toBe(false);
    expect(behavior.calls.stealth).toBe(0);
  });

  it('does not claim stealth-fetch can satisfy missing state captures by itself', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: {
        ok: false,
        error: 'STATE_MISSING',
        message: 'missing sensor state',
        missing: [
          {
            name: 'sensor',
            source: 'state',
            capability: 'stealth_bootstrap',
            required: true,
            failure: 'producer_unavailable',
            message: 'sensor missing',
          },
        ],
      },
      stealthResult: { ok: true, data: { via: 'stealth' } },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    tool.workflow.bootstrap = {
      url: 'about:blank',
      captures: [
        {
          name: 'sensor',
          source: 'dom_text',
          selector: '#missing-sensor',
          timeoutMs: 1,
          capability: 'stealth_bootstrap',
          required: true,
        },
      ],
    };

    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );

    expect(r.result.ok).toBe(false);
    expect(r.usedBackend).toBe('fetch-bootstrap');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(0);
    expect(r.attempts.map((attempt) => [attempt.backend, attempt.outcome])).toEqual([
      ['fetch', 'escalate'],
      ['fetch-bootstrap', 'failed'],
    ]);
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
    // assetRoot/alpha/playbook.yaml does NOT exist
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
    const tool = makeFakeTool('alpha', behavior, siteDir);
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

  it('skips stealth-fetch and reaches playbook for state missing that only DOM replay can bypass', async () => {
    const siteDir = pathResolve(root, 'stateful', 'search_stateful');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(
      pathResolve(siteDir, 'playbook.yaml'),
      `toolName: tool_stateful
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
      fetchResult: {
        ok: false,
        error: 'STATE_MISSING',
        message: 'missing bot state',
        missing: [
          {
            name: 'sensor',
            source: 'state',
            capability: 'stealth_bootstrap',
            required: true,
            failure: 'producer_unavailable',
            message: 'sensor missing',
          },
        ],
      },
      stealthResult: { ok: true, data: { via: 'stealth' } },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('stateful', behavior, siteDir);

    const r = await runWithLadder(
      ['fetch', 'stealth-fetch', 'playbook'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );

    expect(behavior.calls.stealth).toBe(0);
    expect(r.attempts.map((attempt) => attempt.backend)).toEqual(['fetch', 'playbook']);
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
