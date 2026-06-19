/**
 * Tests for the probe + cache. Pure-logic — no real backends. Verifies
 * the cache schema and loader behavior. The "cached preferredOrder is
 * honored as the auto ladder" behavior used to live in a `ladderFor`
 * helper that was tested here; it now lives inline in cron.ts and
 * mcp-server.ts as a 3-line `replayBackend === 'auto' ? cached : default`
 * switch and is exercised end-to-end by the cron tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  loadBackendsCache,
  loadBackendsCacheStatus,
  persistRuntimeBackendsCache,
  probeAllBackends,
  rankSuccessfulBackends,
} from '../src/imprint/probe-backends.ts';
import type { ResolvedTool } from '../src/imprint/tool-loader.ts';
import { type BackendsCache, BackendsCacheSchema, WorkflowSchema } from '../src/imprint/types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-probe-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCache(site: string, cache: unknown): string {
  const dir = pathResolve(root, site, site);
  mkdirSync(dir, { recursive: true });
  const path = pathResolve(dir, 'backends.json');
  writeFileSync(path, JSON.stringify(cache, null, 2));
  return path;
}

describe('BackendsCacheSchema', () => {
  const TS = '2026-05-03T22:00:00.000Z';
  const VER = '0.1.0';

  it('accepts a minimal cache + a multi-outcome cache', () => {
    expect(
      BackendsCacheSchema.safeParse({
        probedAt: TS,
        imprintVersion: VER,
        preferredOrder: ['stealth-fetch'],
        results: {
          'stealth-fetch': {
            outcome: 'ok',
            durationMs: 1234,
            tooSlow: true,
            detail: 'exceeded preferred backend threshold 90000ms',
          },
          'cdp-replay': {
            outcome: 'ok',
            durationMs: 30000,
            coldDurationMs: 30000,
            warmDurationMs: 2500,
            rankingDurationMs: 2500,
            detail: 'warm cdp-replay succeeded in 2500ms',
          },
        },
      }).success,
    ).toBe(true);

    expect(
      BackendsCacheSchema.safeParse({
        probedAt: TS,
        imprintVersion: VER,
        preferredOrder: ['fetch'],
        results: {
          fetch: { outcome: 'ok', durationMs: 200 },
          'stealth-fetch': { outcome: 'forbidden', durationMs: 5000, detail: '403' },
          playbook: { outcome: 'failed', durationMs: 9000, error: 'NETWORK', detail: 'timeout' },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'empty preferredOrder',
      { probedAt: TS, imprintVersion: VER, preferredOrder: [], results: {} },
    ],
    [
      'invalid backend name',
      {
        probedAt: TS,
        imprintVersion: VER,
        preferredOrder: ['fetch', 'magic-cloud'],
        results: {},
      },
    ],
  ])('rejects: %s', (_label, input) => {
    expect(BackendsCacheSchema.safeParse(input).success).toBe(false);
  });
});

describe('loadBackendsCache', () => {
  it('returns null when the file does not exist', () => {
    expect(loadBackendsCache('nope', root)).toBeNull();
  });

  it('reads + parses a valid cache file', () => {
    const cache: BackendsCache = {
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: ['stealth-fetch', 'playbook'],
      results: {
        fetch: { outcome: 'forbidden', durationMs: 300 },
        'stealth-fetch': { outcome: 'ok', durationMs: 12000 },
        playbook: { outcome: 'ok', durationMs: 9000 },
      },
    };
    writeCache('alpha', cache);
    const loaded = loadBackendsCache('alpha', root, pathResolve(root, 'alpha', 'alpha'));
    expect(loaded).not.toBeNull();
    expect(loaded?.preferredOrder).toEqual(['stealth-fetch', 'playbook']);
  });

  it('returns null + warns on malformed JSON without throwing', () => {
    const dir = pathResolve(root, 'broken', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathResolve(dir, 'backends.json'), '{this is not json');
    expect(loadBackendsCache('broken', root, dir)).toBeNull();
  });

  it('returns null on schema-invalid cache without throwing', () => {
    writeCache('schema-bad', {
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: [], // invalid: empty
      results: {},
    });
    expect(
      loadBackendsCache('schema-bad', root, pathResolve(root, 'schema-bad', 'schema-bad')),
    ).toBeNull();
  });

  it('reports invalid cache status with remediation', () => {
    const dir = pathResolve(root, 'invalid', 'search_invalid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathResolve(dir, 'backends.json'), '{not-json');

    const status = loadBackendsCacheStatus('invalid', root, dir, {
      warn: false,
      toolName: 'search_invalid',
    });

    expect(status.status).toBe('invalid');
    if (status.status === 'invalid') {
      expect(status.remediation).toBe('imprint probe-backends invalid --tool search_invalid');
      expect(status.reason).toContain('JSON');
    }
  });

  it('reports unsafe preferred playbook caches as invalid', () => {
    const dir = pathResolve(root, 'unsafe-playbook', 'search_flights');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pathResolve(dir, 'backends.json'),
      JSON.stringify({
        probedAt: '2026-05-03T22:00:00.000Z',
        imprintVersion: '0.4.2',
        preferredOrder: ['stealth-fetch', 'playbook'],
        results: { 'stealth-fetch': { outcome: 'ok', durationMs: 9_000 } },
      }),
    );

    expect(loadBackendsCache('unsafe-playbook', root, dir)).toBeNull();
    const status = loadBackendsCacheStatus('unsafe-playbook', root, dir, {
      warn: false,
      toolName: 'search_flights',
    });

    expect(status.status).toBe('invalid');
    if (status.status === 'invalid') {
      expect(status.reason).toContain('playbook');
      expect(status.remediation).toBe(
        'imprint probe-backends unsafe-playbook --tool search_flights',
      );
    }
  });

  it('ignores schema v2 caches whose workflow hash is stale', () => {
    const dir = pathResolve(root, 'stale', 'stale');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pathResolve(dir, 'workflow.json'),
      JSON.stringify({
        toolName: 'tool',
        intent: { description: 'x' },
        parameters: [],
        requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
        site: 'stale',
      }),
    );
    const cache: BackendsCache = {
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      schemaVersion: 2,
      workflowHash: createHash('sha256')
        .update(JSON.stringify({ old: true }))
        .digest('hex'),
      capabilityHash: 'capability',
      preferredOrder: ['fetch'],
      results: { fetch: { outcome: 'ok', durationMs: 20 } },
    };
    writeFileSync(pathResolve(dir, 'backends.json'), JSON.stringify(cache, null, 2));

    expect(loadBackendsCache('stale', root, dir)).toBeNull();

    const status = loadBackendsCacheStatus('stale', root, dir, {
      warn: false,
      toolName: 'tool',
    });
    expect(status.status).toBe('stale');
    if (status.status === 'stale') {
      expect(status.remediation).toBe('imprint probe-backends stale --tool tool');
    }
  });

  it('accepts fresh v2 caches when workflow.json omits schema-defaulted capture fields', () => {
    const dir = pathResolve(root, 'defaults', 'defaults');
    mkdirSync(dir, { recursive: true });
    const rawWorkflow = {
      toolName: 'tool',
      intent: { description: 'x' },
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://example.com/a',
          headers: { 'x-csrf': '${state.csrf}' },
          captures: [{ name: 'csrf', source: 'cookie', cookie: 'XSRF-TOKEN' }],
        },
      ],
      site: 'defaults',
    };
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(rawWorkflow));
    const cache: BackendsCache = {
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      schemaVersion: 2,
      workflowHash: createHash('sha256')
        .update(JSON.stringify(WorkflowSchema.parse(rawWorkflow)))
        .digest('hex'),
      capabilityHash: 'capability',
      preferredOrder: ['fetch'],
      results: { fetch: { outcome: 'ok', durationMs: 20 } },
    };
    writeFileSync(pathResolve(dir, 'backends.json'), JSON.stringify(cache, null, 2));

    expect(loadBackendsCache('defaults', root, dir)?.preferredOrder).toEqual(['fetch']);
  });
});

describe('backend preference ranking', () => {
  it('uses warm cdp-replay runtime when the cold start is still timeout-safe', () => {
    expect(
      rankSuccessfulBackends([
        {
          backend: 'cdp-replay',
          durationMs: 30_000,
          warmDurationMs: 2_000,
          rankingDurationMs: 2_000,
          tooSlow: false,
        },
        { backend: 'stealth-fetch', durationMs: 9_000, tooSlow: false },
      ]),
    ).toEqual(['cdp-replay', 'stealth-fetch']);
  });

  it('keeps cold-too-slow cdp-replay behind timeout-safe successful backends', () => {
    expect(
      rankSuccessfulBackends([
        {
          backend: 'cdp-replay',
          durationMs: 140_000,
          warmDurationMs: 2_000,
          rankingDurationMs: 2_000,
          tooSlow: true,
        },
        { backend: 'stealth-fetch', durationMs: 9_000, tooSlow: false },
        { backend: 'fetch', durationMs: 200, tooSlow: false },
      ]),
    ).toEqual(['fetch', 'stealth-fetch', 'cdp-replay']);
  });
});

describe('runtime backend learning', () => {
  it('persists the successful runtime backend ahead of failed rungs', () => {
    const dir = pathResolve(root, 'learn', 'search_learn');
    mkdirSync(dir, { recursive: true });
    const workflow = WorkflowSchema.parse({
      toolName: 'search_learn',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
      site: 'learn',
    });
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(workflow));
    const tool: ResolvedTool = {
      site: 'learn',
      dir,
      workflow,
      toolFn: async () => ({ ok: true, data: {} }),
    };

    const cache = persistRuntimeBackendsCache({
      tool,
      assetRoot: root,
      usedBackend: 'stealth-fetch',
      attempts: [
        {
          backend: 'fetch',
          outcome: 'escalate',
          detail: 'FORBIDDEN: 403',
          durationMs: 12,
        },
        {
          backend: 'fetch-bootstrap',
          outcome: 'failed',
          detail: 'NETWORK: timeout',
          durationMs: 90_000,
        },
        {
          backend: 'stealth-fetch',
          outcome: 'ok',
          detail: 'succeeded',
          durationMs: 9_000,
        },
      ],
    });

    expect(cache?.preferredOrder).toEqual(['stealth-fetch']);
    expect(loadBackendsCache('learn', root, dir)?.preferredOrder).toEqual(['stealth-fetch']);
    expect(cache?.results.fetch?.outcome).toBe('forbidden');
    expect(cache?.results['fetch-bootstrap']?.outcome).toBe('failed');
  });

  it('does not preserve playbook as a structural fallback when learning from runtime', () => {
    const dir = pathResolve(root, 'learn-playbook', 'search_learn');
    mkdirSync(dir, { recursive: true });
    const workflow = WorkflowSchema.parse({
      toolName: 'search_learn',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
      site: 'learn-playbook',
    });
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(workflow));
    writeFileSync(pathResolve(dir, 'playbook.yaml'), 'steps: []\n');
    const tool: ResolvedTool = {
      site: 'learn-playbook',
      dir,
      workflow,
      toolFn: async () => ({ ok: true, data: {} }),
    };

    const cache = persistRuntimeBackendsCache({
      tool,
      assetRoot: root,
      usedBackend: 'stealth-fetch',
      attempts: [
        {
          backend: 'stealth-fetch',
          outcome: 'ok',
          detail: 'succeeded',
          durationMs: 9_000,
        },
      ],
    });

    expect(cache?.preferredOrder).toEqual(['stealth-fetch']);
    expect(loadBackendsCache('learn-playbook', root, dir)?.preferredOrder).toEqual([
      'stealth-fetch',
    ]);
  });

  it('preserves playbook only when an existing cache proved it works', () => {
    const dir = pathResolve(root, 'learn-proven-playbook', 'search_learn');
    mkdirSync(dir, { recursive: true });
    const workflow = WorkflowSchema.parse({
      toolName: 'search_learn',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
      site: 'learn-proven-playbook',
    });
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(workflow));
    writeFileSync(
      pathResolve(dir, 'backends.json'),
      JSON.stringify({
        probedAt: '2026-05-03T22:00:00.000Z',
        imprintVersion: '0.1.0',
        preferredOrder: ['playbook'],
        results: { playbook: { outcome: 'ok', durationMs: 4_000 } },
      }),
    );
    const tool: ResolvedTool = {
      site: 'learn-proven-playbook',
      dir,
      workflow,
      toolFn: async () => ({ ok: true, data: {} }),
    };

    const cache = persistRuntimeBackendsCache({
      tool,
      assetRoot: root,
      usedBackend: 'stealth-fetch',
      attempts: [
        {
          backend: 'stealth-fetch',
          outcome: 'ok',
          detail: 'succeeded',
          durationMs: 9_000,
        },
      ],
    });

    expect(cache?.preferredOrder).toEqual(['stealth-fetch', 'playbook']);
    expect(loadBackendsCache('learn-proven-playbook', root, dir)?.preferredOrder).toEqual([
      'stealth-fetch',
      'playbook',
    ]);
  });

  it('does not durable-frontload a cold-too-slow cdp-replay success ahead of known good backends', () => {
    const dir = pathResolve(root, 'learn-slow-cdp', 'search_learn');
    mkdirSync(dir, { recursive: true });
    const workflow = WorkflowSchema.parse({
      toolName: 'search_learn',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
      site: 'learn-slow-cdp',
    });
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(workflow));
    writeFileSync(
      pathResolve(dir, 'backends.json'),
      JSON.stringify({
        probedAt: '2026-05-03T22:00:00.000Z',
        imprintVersion: '0.1.0',
        preferredOrder: ['stealth-fetch'],
        results: { 'stealth-fetch': { outcome: 'ok', durationMs: 9_000 } },
      }),
    );
    const tool: ResolvedTool = {
      site: 'learn-slow-cdp',
      dir,
      workflow,
      toolFn: async () => ({ ok: true, data: {} }),
    };

    const cache = persistRuntimeBackendsCache({
      tool,
      assetRoot: root,
      usedBackend: 'cdp-replay',
      attempts: [
        {
          backend: 'cdp-replay',
          outcome: 'ok',
          detail: 'succeeded',
          durationMs: 140_000,
        },
      ],
    });

    expect(cache?.preferredOrder).toEqual(['stealth-fetch', 'cdp-replay']);
    expect(cache?.results['cdp-replay']).toMatchObject({
      outcome: 'ok',
      durationMs: 140_000,
      tooSlow: true,
    });
  });
});

describe('probeAllBackends', () => {
  it('writes a cache for every generated tool in a site', async () => {
    const site = pathResolve(root, 'multi');
    for (const toolName of ['first_tool', 'second_tool']) {
      const dir = pathResolve(site, toolName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        pathResolve(dir, 'index.ts'),
        [
          `export const WORKFLOW = ${JSON.stringify({
            toolName,
            intent: { description: toolName },
            parameters: [],
            requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
            site: 'multi',
          })};`,
          `export async function ${toolName === 'first_tool' ? 'firstTool' : 'secondTool'}(_input, _opts) { return { ok: true, data: { tool: '${toolName}' } }; }`,
        ].join('\n'),
      );
    }

    const results = await probeAllBackends({ site: 'multi', assetRoot: root });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.cache.preferredOrder.sort())).toEqual([
      ['fetch', 'stealth-fetch'],
      ['fetch', 'stealth-fetch'],
    ]);
    expect(
      loadBackendsCache('multi', root, pathResolve(site, 'first_tool'))?.preferredOrder,
    ).toContain('fetch');
    expect(
      loadBackendsCache('multi', root, pathResolve(site, 'second_tool'))?.preferredOrder,
    ).toContain('fetch');
  });
});
