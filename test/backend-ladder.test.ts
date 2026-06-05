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
import {
  __resetCompileWinningBackendForTest,
  __setCdpBrowserFetchFactoryForTest,
  __setProbeTimeoutMsForTest,
  __setCdpJarMinterForTest,
  effectiveAutoLadder,
  evaluateBootstrapCapture,
  pickBaseUrl,
  prefersCdpReplayFirst,
  renderWorkflowRequests,
  resolveLadder,
  runWithLadder,
  runWorkflowWithLadder,
} from '../src/imprint/backend-ladder.ts';
import type { MintedJar } from '../src/imprint/cdp-browser-fetch.ts';
import { type StealthFetch, createStealthFetch } from '../src/imprint/stealth-fetch.ts';
import type { ResolvedTool } from '../src/imprint/tool-loader.ts';
import type { ToolResult, Workflow } from '../src/imprint/types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-ladder-'));
  // fetch-bootstrap now always-splices into the auto ladder and its real mint
  // launches Chrome. Stub the jar mint to null so unit tests exercise the
  // ladder's escalation logic without a real browser (mint-fail → escalate).
  __setCdpJarMinterForTest(async () => null);
  // The cdp-replay rung is spliced after fetch-bootstrap and launches real
  // Chrome. Stub its factory so the rung fails fast (mintJar throws → runCdpReplay
  // returns NETWORK → escalate) instead of launching a browser in unit tests.
  __setCdpBrowserFetchFactoryForTest(() => ({
    fetchImpl: (async () => {
      throw new Error('cdp-replay disabled in tests');
    }) as unknown as typeof fetch,
    ensureBootstrapped: async () => [],
    mintJar: async () => {
      throw new Error('cdp-replay disabled in tests');
    },
    close: async () => {},
  }));
  // Disable the compile-path .act rate gate so tests don't sleep between calls.
  process.env.IMPRINT_COMPILE_ACT_SPACING_MS = '0';
  // Shorten the parallel probe deadline so its setTimeout doesn't keep bun's
  // event loop alive past the default 5s test timeout.
  __setProbeTimeoutMsForTest(1_000);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  __setCdpJarMinterForTest(null);
  __setCdpBrowserFetchFactoryForTest(null);
  __setProbeTimeoutMsForTest(null);
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
      { skipBootstrapSplice: true },
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
      { skipBootstrapSplice: true },
    );
    expect(r.usedBackend).toBe('fetch');
    if (r.result.ok) throw new Error('expected failure');
    expect(r.result.error).toBe('AUTH_EXPIRED');
    expect(behavior.calls.stealth).toBe(0);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'failed' });
  });

  it('does NOT escalate on RATE_LIMITED — backoff is the answer, not a different transport', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'RATE_LIMITED', message: 'too many requests' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
      { skipBootstrapSplice: true },
    );
    if (r.result.ok) throw new Error('expected failure');
    expect(r.result.error).toBe('RATE_LIMITED');
    expect(r.usedBackend).toBe('fetch');
    expect(behavior.calls.stealth).toBe(0);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'failed' });
  });

  it('escalates fetch → stealth-fetch on NETWORK (likely anti-bot tarpit)', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'NETWORK', message: 'Request timed out after 30000ms' },
      stealthResult: { ok: true, data: { rescued: true } },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
      { skipBootstrapSplice: true },
    );
    expect(r.result.ok).toBe(true);
    expect(r.usedBackend).toBe('stealth-fetch');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'escalate' });
    expect(r.attempts[1]).toMatchObject({ backend: 'stealth-fetch', outcome: 'ok' });
  });

  it('returns the last NETWORK error when every rung in the ladder times out', async () => {
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'NETWORK', message: 'fetch timed out' },
      stealthResult: { ok: false, error: 'NETWORK', message: 'stealth-fetch timed out' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch'],
      tool,
      {},
      root,
      makeStealthCache(tool),
      { skipBootstrapSplice: true },
    );
    if (r.result.ok) throw new Error('expected failure');
    expect(r.result.error).toBe('NETWORK');
    expect(r.result.message).toContain('stealth-fetch timed out');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]).toMatchObject({ backend: 'fetch', outcome: 'escalate' });
    expect(r.attempts[1]).toMatchObject({ backend: 'stealth-fetch', outcome: 'escalate' });
  });

  it('escalates STATE_MISSING(stealth_bootstrap) to stealth-fetch because its first step IS a stealth-browser bootstrap', async () => {
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
      { skipBootstrapSplice: true },
    );

    expect(r.result.ok).toBe(true);
    expect(r.usedBackend).toBe('stealth-fetch');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
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
      { skipBootstrapSplice: true },
    );

    expect(r.usedBackend).toBe('fetch');
    expect(r.result.ok).toBe(false);
    expect(behavior.calls.stealth).toBe(0);
  });

  it('escalates fetch-bootstrap failure to stealth-fetch because stealth-fetch can mint browser/stealth state', async () => {
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

    // No skipBootstrapSplice: this asserts the auto-ladder splices fetch-bootstrap.
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
    // cdp-replay is spliced between fetch-bootstrap and stealth-fetch; here it
    // fails fast (stubbed) and the ladder continues on to stealth-fetch.
    expect(r.attempts.map((attempt) => attempt.backend)).toEqual([
      'fetch',
      'fetch-bootstrap',
      'cdp-replay',
      'stealth-fetch',
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
      { skipBootstrapSplice: true },
    );
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe('FORBIDDEN');
    // The last attempt's result wins.
    expect(r.result.message).toContain('stealth blocked');
    expect(behavior.calls.fetch).toBe(1);
    expect(behavior.calls.stealth).toBe(1);
  });

  it('skips playbook rung when no playbook.yaml AND no replayable URL exists', async () => {
    // The playbook rung now ALSO runs the cdp-browser (trusted real-Chrome)
    // replay, which needs only a parseable workflow URL. So it's only truly
    // "unavailable" when there's no playbook.yaml AND no replayable URL — i.e.
    // a workflow with no requests.
    const behavior: FakeToolBehavior = {
      fetchResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      stealthResult: { ok: false, error: 'FORBIDDEN', message: 'blocked' },
      calls: { fetch: 0, stealth: 0 },
    };
    const tool = makeFakeTool('alpha', behavior);
    tool.workflow.requests = []; // no requests → cdp-browser replay impossible
    const r = await runWithLadder(
      ['fetch', 'stealth-fetch', 'playbook'],
      tool,
      {},
      root,
      makeStealthCache(tool),
      { skipBootstrapSplice: true },
    );
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts[2]).toMatchObject({ backend: 'playbook', outcome: 'unavailable' });
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
      { skipBootstrapSplice: true },
    );
    // Playbook will fail too (no real browser, navigates about:blank, no
    // matching XHR) — but it WAS attempted.
    expect(r.attempts).toHaveLength(3);
    const playbookAttempt = r.attempts[2];
    if (!playbookAttempt) throw new Error('expected 3rd attempt');
    expect(playbookAttempt.backend).toBe('playbook');
    expect(['ok', 'failed', 'escalate']).toContain(playbookAttempt.outcome);
    // This rung launches a REAL Playwright Chromium (navigate about:blank, wait
    // for a never-matching XHR), so on a cold CI runner it legitimately exceeds
    // the 5s default — give it a generous timeout to de-flake (passes in <1s
    // locally; the assertion is just that playbook was ATTEMPTED).
  }, 30000);

  it('reaches stealth-fetch before playbook for state missing that stealth-bootstrap can mint', async () => {
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
      { skipBootstrapSplice: true },
    );

    expect(behavior.calls.stealth).toBe(1);
    expect(r.usedBackend).toBe('stealth-fetch');
    expect(r.attempts.map((attempt) => attempt.backend)).toEqual(['fetch', 'stealth-fetch']);
  });
});

describe('runWithLadder — stealth honors workflow bootstrap', () => {
  it('mints ${state} (cookie + html_regex) from the same stealth session and passes it to the workflow', async () => {
    let receivedState: Record<string, unknown> | undefined;
    const workflow: Workflow = {
      toolName: 'tool_bs',
      intent: { description: 'bootstrap tool' },
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: 'https://bs.example.com/api/act',
          headers: { 'X-Csrf': '${state.csrf}', 'X-Nonce': '${state.nonce}' },
        },
      ],
      site: 'bs',
      bootstrap: {
        url: 'https://bs.example.com/page',
        captures: [
          {
            source: 'cookie',
            name: 'csrf',
            cookie: 'Csrf-token',
            required: true,
            capability: 'browser_bootstrap',
            allowHttpOnlyProjection: false,
          },
          {
            source: 'html_regex',
            name: 'nonce',
            pattern: 'nonce="([0-9]+)"',
            group: 1,
            required: true,
            capability: 'browser_bootstrap',
          },
        ],
      },
    };
    const tool: ResolvedTool = {
      site: 'bs',
      dir: '',
      workflow,
      toolFn: async (_input, opts) => {
        if (opts?.fetchImpl) {
          receivedState = opts.initialState as Record<string, unknown>;
          return { ok: true, data: { ok: 1 } };
        }
        return { ok: false, error: 'UNKNOWN', message: 'fetch path not expected' };
      },
    };
    // Stealth fetch whose bootstrap returns the csrf cookie + bootstrap HTML —
    // exactly what a real Chrome navigation of the bootstrap page would mint.
    const cache = new Map<string, StealthFetch>();
    cache.set(
      'bs',
      createStealthFetch(
        { baseUrl: 'https://bs.example.com', bootstrapUrl: 'https://bs.example.com/page' },
        {
          bootstrap: async () => ({
            cookies: [{ name: 'Csrf-token', value: 'tok-abc' }],
            sensorHeaders: {},
            bootstrappedAt: Date.now(),
            bootstrapHtml: '<div nonce="42"></div>',
            bootstrapResponseHeaders: {},
          }),
        },
      ),
    );
    const r = await runWithLadder(['stealth-fetch'], tool, {}, root, cache);
    expect(r.result.ok).toBe(true);
    expect(r.usedBackend).toBe('stealth-fetch');
    // The csrf cookie and the html_regex nonce both resolved from the stealth
    // bootstrap session and were threaded into the workflow as ${state.X}.
    expect(receivedState?.csrf).toBe('tok-abc');
    expect(receivedState?.nonce).toBe('42');
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

describe('runWorkflowWithLadder', () => {
  // The synthetic ResolvedTool path: takes a workflow.json on disk and
  // dispatches through the real `runWithLadder`. We use a local HTTP
  // server to keep the test hermetic — the only thing we're really
  // checking is that the helper wires workflow → ResolvedTool → ladder
  // correctly (loadCredentialStore, dirname resolution, backends.json
  // pickup). Backend escalation itself is covered by the tests above.
  it('throws a clear error when workflow.json is missing', async () => {
    await expect(
      runWorkflowWithLadder({
        workflowPath: pathJoin(root, 'nonexistent', 'workflow.json'),
        params: {},
      }),
    ).rejects.toThrow(/workflow.json not found/);
  });

  it('runs a workflow against a real local HTTP server through the fetch rung', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/echo') {
          return new Response(JSON.stringify({ q: url.searchParams.get('q'), ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const port = server.port;
    try {
      const toolDir = pathJoin(root, 'echo-site', 'echo_tool');
      mkdirSync(toolDir, { recursive: true });
      const workflowPath = pathJoin(toolDir, 'workflow.json');
      writeFileSync(
        workflowPath,
        JSON.stringify(
          {
            toolName: 'echo_tool',
            intent: { description: 'Echo' },
            parameters: [{ name: 'q', type: 'string', description: 'query' }],
            requests: [
              {
                method: 'GET',
                url: `http://127.0.0.1:${port}/api/echo?q=\${param.q}`,
                headers: {},
              },
            ],
            site: 'echo-site',
          },
          null,
          2,
        ),
      );

      const { result, usedBackend } = await runWorkflowWithLadder({
        workflowPath,
        params: { q: 'hello' },
      });
      expect(result.ok).toBe(true);
      expect(usedBackend).toBe('fetch');
      if (result.ok) {
        expect(result.data).toEqual({ q: 'hello', ok: true });
      }
    } finally {
      server.stop(true);
    }
  });

  it('ladder is fixed to [fetch, stealth-fetch] regardless of a sibling backends.json', async () => {
    // Compile-time integration tests run BEFORE `imprint compile-playbook`
    // generates a playbook.yaml, so the playbook rung is intentionally
    // excluded. The helper must also ignore any sibling backends.json
    // (which is a runtime probe cache, not a compile-time concern) and
    // always use the same two-rung ladder. This is a regression guard
    // against drift toward runtime-coupled behavior.
    //
    // We prove it by: workflow whose fetch returns 200 (so the fetch
    // rung wins) AND a backends.json that says "only try playbook"
    // (which the helper should ignore). If the helper read backends.json,
    // it would try playbook (which doesn't exist on disk), get a skip,
    // and return a no-rungs-available error.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const port = server.port;
    try {
      const toolDir = pathJoin(root, 'mistrust-site', 'mistrust_tool');
      mkdirSync(toolDir, { recursive: true });
      const workflowPath = pathJoin(toolDir, 'workflow.json');
      writeFileSync(
        workflowPath,
        JSON.stringify({
          toolName: 'mistrust_tool',
          intent: { description: 'Should still use fetch' },
          parameters: [],
          requests: [{ method: 'GET', url: `http://127.0.0.1:${port}/api/ok`, headers: {} }],
          site: 'mistrust-site',
        }),
      );

      // Adversarial backends.json: claims preferredOrder is playbook-only.
      // Since this helper ignores backends.json, fetch must still be tried
      // and win.
      writeFileSync(
        pathJoin(toolDir, 'backends.json'),
        JSON.stringify({
          probedAt: new Date().toISOString(),
          imprintVersion: '0.1.0',
          schemaVersion: 2,
          preferredOrder: ['playbook'],
          results: {},
        }),
      );

      const { result, usedBackend, attempts } = await runWorkflowWithLadder({
        workflowPath,
        params: {},
      });
      expect(result.ok).toBe(true);
      expect(usedBackend).toBe('fetch');
      // Two-rung ladder advertised; only the first rung needed to run.
      expect(attempts.map((a) => a.backend)).toEqual(['fetch']);
    } finally {
      server.stop(true);
    }
  });

  it('memoizes the winning backend across calls without breaking the fetch path', async () => {
    __resetCompileWinningBackendForTest();
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const port = server.port;
    try {
      const toolDir = pathJoin(root, 'memo-site', 'memo_tool');
      mkdirSync(toolDir, { recursive: true });
      const workflowPath = pathJoin(toolDir, 'workflow.json');
      writeFileSync(
        workflowPath,
        JSON.stringify({
          toolName: 'memo_tool',
          intent: { description: 'Memo' },
          parameters: [],
          requests: [{ method: 'GET', url: `http://127.0.0.1:${port}/x`, headers: {} }],
          site: 'memo-site',
        }),
      );
      // First call: parallel probe — fetch wins (fastest). Second call:
      // memo=fetch, sequential from the memoized winner.
      const a = await runWorkflowWithLadder({ workflowPath, params: {} });
      const b = await runWorkflowWithLadder({ workflowPath, params: {} });
      expect(a.usedBackend).toBe('fetch');
      expect(b.usedBackend).toBe('fetch');
      // Second call uses the memo path (sequential, single-rung)
      expect(b.attempts.map((x) => x.backend)).toEqual(['fetch']);
      expect(hits).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
      __resetCompileWinningBackendForTest();
    }
  });
});

describe('evaluateBootstrapCapture — response_header source (Fix C)', () => {
  // Pure unit tests on the per-source switch. No real Chromium — `page` and
  // `html` are unused for header captures, so a stub Page cast is fine.
  const stubPage = {} as unknown as import('playwright').Page;

  it('reads a header value by case-insensitive name', async () => {
    const value = await evaluateBootstrapCapture(
      {
        name: 'csrf',
        source: 'response_header',
        header: 'X-Csrf-Token',
        mode: 'last',
        required: true,
        capability: 'browser_bootstrap',
      },
      stubPage,
      '<irrelevant html/>',
      { 'x-csrf-token': 'abc123def456' },
    );
    expect(value).toBe('abc123def456');
  });

  it('returns undefined when the header is absent', async () => {
    const value = await evaluateBootstrapCapture(
      {
        name: 'csrf',
        source: 'response_header',
        header: 'X-Csrf-Token',
        mode: 'last',
        required: false,
        capability: 'browser_bootstrap',
      },
      stubPage,
      '',
      { 'some-other-header': 'noise' },
    );
    expect(value).toBeUndefined();
  });

  it('splits comma-joined multi-valued headers per mode', async () => {
    // Playwright's allHeaders() joins multi-valued headers with ", " — pin
    // the split contract so mode: 'first'/'last' do the right thing on
    // Set-Cookie-style chains.
    const base = {
      name: 'tok' as const,
      source: 'response_header' as const,
      header: 'X-Multi',
      required: true,
      capability: 'browser_bootstrap' as const,
    };
    const headers = { 'x-multi': 'aaa, bbb, ccc' };
    expect(await evaluateBootstrapCapture({ ...base, mode: 'first' }, stubPage, '', headers)).toBe(
      'aaa',
    );
    expect(await evaluateBootstrapCapture({ ...base, mode: 'last' }, stubPage, '', headers)).toBe(
      'ccc',
    );
    expect(await evaluateBootstrapCapture({ ...base, mode: 'all' }, stubPage, '', headers)).toBe(
      'aaa, bbb, ccc',
    );
  });
});

describe('renderWorkflowRequests — offline param verification', () => {
  it('renders a param into the request body without network (deterministic diff)', async () => {
    const wf: Workflow = {
      toolName: 'render_test',
      intent: { description: 'x' },
      site: 'example.com',
      parameters: [{ name: 'city', type: 'string', description: 'c', default: 'sf' }],
      requests: [
        {
          method: 'POST',
          url: 'https://api.example.com/search',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'city=${param.city}&country=US',
        },
      ],
    };
    const over = await renderWorkflowRequests({ workflow: wf, params: { city: 'reno' } });
    const base = await renderWorkflowRequests({ workflow: wf, params: { city: 'sf' } });
    expect(over.requests).toHaveLength(1);
    expect(over.requests[0]?.body).toContain('city=reno');
    expect(base.requests[0]?.body).toContain('city=sf');
    // Overriding the param changes the field — the static coverage signal.
    expect(over.requests[0]?.body).not.toBe(base.requests[0]?.body);
  });

  it('resolves a capture from the supplied recorded response (offline chain)', async () => {
    const wf: Workflow = {
      toolName: 'chain_test',
      intent: { description: 'x' },
      site: 'example.com',
      parameters: [{ name: 'q', type: 'string', description: 'q', default: 'a' }],
      requests: [
        {
          method: 'GET',
          url: 'https://example.com/page',
          headers: {},
          captures: [
            {
              name: 'tok',
              required: true,
              capability: 'ordinary_http',
              source: 'text_regex',
              pattern: 'TOKEN=([0-9a-f]+)',
              group: 1,
            },
          ],
        },
        {
          method: 'POST',
          url: 'https://example.com/act',
          headers: { 'X-Tok': '${state.tok}' },
          body: 'q=${param.q}',
        },
      ],
    };
    const { requests } = await renderWorkflowRequests({
      workflow: wf,
      params: { q: 'hello' },
      recordedResponseFor: (_m, u) =>
        u.includes('/page') ? { status: 200, body: '<x>TOKEN=deadbeef</x>' } : undefined,
    });
    const act = requests.find((r) => r.url.includes('/act'));
    // The capture resolved from the recorded response, fully offline.
    expect(act?.headers['X-Tok'] ?? act?.headers['x-tok']).toBe('deadbeef');
    expect(act?.body).toContain('q=hello');
  });
});

describe('fetch-bootstrap happy path (cdp jar minted → plain-fetch replay)', () => {
  it('threads the minted jar cookies into credentials and the jar UA into the replay fetch', async () => {
    const jar: MintedJar = {
      cookies: [
        { name: '_abck', value: 'X~0~Y', domain: '.alpha.example.com', path: '/' },
        { name: 'sess', value: 's', domain: '.alpha.example.com', path: '/' },
      ],
      ua: 'JarUA/148',
      html: '',
      bootstrapEpoch: 1_700_000_000_000,
      abckFlag: '0',
    };
    __setCdpJarMinterForTest(async () => jar);

    let captured:
      | {
          credentials?: { cookies?: Array<{ name: string; value: string }> };
          fetchImpl?: typeof fetch;
        }
      | undefined;
    const tool: ResolvedTool = {
      site: 'alpha',
      dir: pathJoin(root, 'alpha', 'tool'),
      workflow: {
        toolName: 'tool_alpha',
        intent: { description: 'x' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://alpha.example.com/api/x', headers: {} }],
        site: 'alpha',
      },
      toolFn: async (_p, opts) => {
        const o = opts as typeof captured;
        if (o?.fetchImpl) {
          captured = o;
          return { ok: true, data: { via: 'jar' } };
        }
        // plain fetch rung → fail so the ladder escalates to fetch-bootstrap
        return { ok: false, error: 'FORBIDDEN', message: 'akamai' };
      },
    };

    const r = await runWithLadder(
      ['fetch', 'fetch-bootstrap'],
      tool,
      {},
      root,
      makeStealthCache(tool),
    );
    expect(r.usedBackend).toBe('fetch-bootstrap');
    expect(r.result.ok).toBe(true);
    // jar cookies were threaded into the replay credentials
    expect(
      captured?.credentials?.cookies?.some((c) => c.name === '_abck' && c.value === 'X~0~Y'),
    ).toBe(true);

    // the replay fetchImpl forces the jar's exact UA on the wire
    const origFetch = globalThis.fetch;
    let sentUa = '';
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sentUa = new Headers(init?.headers).get('user-agent') ?? '';
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await captured?.fetchImpl?.('https://alpha.example.com/x');
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(sentUa).toBe('JarUA/148');
  });
});

describe('effectiveAutoLadder + prefersCdpReplayFirst (Fix 4 — cdp-replay rung)', () => {
  function wf(partial: Partial<Workflow>): Workflow {
    return {
      toolName: 't',
      intent: { description: 'd' },
      parameters: [],
      site: 's',
      requests: [],
      ...partial,
    } as Workflow;
  }

  it('splices fetch-bootstrap then cdp-replay after fetch in auto mode', () => {
    const out = effectiveAutoLadder(['fetch', 'stealth-fetch', 'playbook'], wf({}));
    expect(out).toEqual(['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch', 'playbook']);
  });

  it('does not duplicate fetch-bootstrap/cdp-replay if already present', () => {
    const out = effectiveAutoLadder(
      ['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch'],
      wf({}),
    );
    expect(out).toEqual(['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch']);
  });

  it('leaves a single-rung ladder untouched', () => {
    expect(effectiveAutoLadder(['stealth-fetch'], wf({}))).toEqual(['stealth-fetch']);
  });

  it('prefersCdpReplayFirst: true for ≥2 mutating requests + a bootstrap block', () => {
    const w = wf({
      bootstrap: { url: 'https://x/boot' },
      requests: [
        { method: 'POST', url: 'https://x/a.act', headers: {} },
        { method: 'POST', url: 'https://x/b.act', headers: {} },
      ],
    });
    expect(prefersCdpReplayFirst(w)).toBe(true);
    // …and it is front-loaded so doomed fetch rungs don't pre-burn the IP budget.
    expect(effectiveAutoLadder(['fetch', 'stealth-fetch'], w)).toEqual([
      'cdp-replay',
      'fetch',
      'fetch-bootstrap',
      'stealth-fetch',
    ]);
  });

  it('prefersCdpReplayFirst: true for ≥2 mutating requests that reference ${state.X} (no bootstrap)', () => {
    const w = wf({
      requests: [
        { method: 'POST', url: 'https://x/a', headers: { 'X-Csrf': '${state.csrf}' } },
        { method: 'POST', url: 'https://x/b', headers: {} },
      ],
    });
    expect(prefersCdpReplayFirst(w)).toBe(true);
  });

  it('prefersCdpReplayFirst: false for a single state-changing request', () => {
    const w = wf({
      bootstrap: { url: 'https://x/boot' },
      requests: [
        { method: 'POST', url: 'https://x/a.act', headers: {} },
        { method: 'GET', url: 'https://x/results', headers: {} },
      ],
    });
    expect(prefersCdpReplayFirst(w)).toBe(false);
    // normal fetch-first order (cdp-replay still available as a later escalation)
    expect(effectiveAutoLadder(['fetch', 'stealth-fetch'], w)).toEqual([
      'fetch',
      'fetch-bootstrap',
      'cdp-replay',
      'stealth-fetch',
    ]);
  });

  it('prefersCdpReplayFirst: false for a plain multi-POST REST API (no bootstrap, no ${state.X})', () => {
    const w = wf({
      requests: [
        { method: 'POST', url: 'https://api/x', headers: {} },
        { method: 'POST', url: 'https://api/y', headers: {} },
      ],
    });
    expect(prefersCdpReplayFirst(w)).toBe(false);
  });

  it('splices fetch-bootstrap + cdp-replay before stealth-fetch when fetch is probed-out', () => {
    const out = effectiveAutoLadder(['stealth-fetch', 'playbook'], wf({}));
    expect(out).toEqual(['fetch-bootstrap', 'cdp-replay', 'stealth-fetch', 'playbook']);
  });

  it('does not splice fetch-bootstrap before cdp-replay when cdp-replay is explicitly in the ladder', () => {
    const out = effectiveAutoLadder(['cdp-replay', 'stealth-fetch', 'playbook'], wf({}));
    expect(out).toEqual(['cdp-replay', 'stealth-fetch', 'playbook']);
  });

  it('front-loads cdp-replay even when fetch is probed-out for multi-step anti-bot workflows', () => {
    const w = wf({
      bootstrap: { url: 'https://x/boot' },
      requests: [
        { method: 'POST', url: 'https://x/a.act', headers: {} },
        { method: 'POST', url: 'https://x/b.act', headers: {} },
      ],
    });
    expect(effectiveAutoLadder(['stealth-fetch', 'playbook'], w)).toEqual([
      'cdp-replay',
      'fetch-bootstrap',
      'stealth-fetch',
      'playbook',
    ]);
  });
});

describe('pickBaseUrl', () => {
  function toolWith(requests: Array<{ method: string; url: string; headers?: Record<string, string> }>): ResolvedTool {
    return {
      site: 'test',
      dir: '/tmp/test',
      workflow: {
        toolName: 'test_tool',
        intent: { description: 'test' },
        parameters: [],
        requests: requests.map((r) => ({ ...r, headers: r.headers ?? {} })),
        site: 'test',
      },
      toolFn: async () => ({ ok: true, data: {} }),
    };
  }

  it('uses Referer header when available', () => {
    const tool = toolWith([
      { method: 'POST', url: 'https://example.com/api/data', headers: { Referer: 'https://example.com/app/page' } },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com/app/page');
  });

  it('falls back to origin when no Referer and first request is .json', () => {
    const tool = toolWith([
      { method: 'GET', url: 'https://example.com/version.json' },
      { method: 'POST', url: 'https://example.com/api/data' },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com');
  });

  it('falls back to origin when no Referer exists', () => {
    const tool = toolWith([
      { method: 'GET', url: 'https://example.com/config.json' },
      { method: 'GET', url: 'https://example.com/schema.xml' },
      { method: 'POST', url: 'https://example.com/api/search' },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com');
  });

  it('prefers Referer from a later request over skipping logic', () => {
    const tool = toolWith([
      { method: 'GET', url: 'https://example.com/version.json' },
      { method: 'POST', url: 'https://example.com/api/data', headers: { Referer: 'https://example.com/booking/page' } },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com/booking/page');
  });

  it('falls back to origin when all requests are data endpoints', () => {
    const tool = toolWith([
      { method: 'GET', url: 'https://example.com/v1.json' },
      { method: 'GET', url: 'https://example.com/v2.json' },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com');
  });

  it('uses origin for single API request with no Referer', () => {
    const tool = toolWith([
      { method: 'POST', url: 'https://example.com/api/booking/search?q=1' },
    ]);
    expect(pickBaseUrl(tool)).toBe('https://example.com');
  });

  it('throws for empty requests', () => {
    const tool = toolWith([]);
    expect(() => pickBaseUrl(tool)).toThrow('has no requests');
  });
});
