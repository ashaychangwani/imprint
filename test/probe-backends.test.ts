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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  backendInvariantProbeFailure,
  canRebindBackendsCacheToWorkflow,
  loadBackendsCache,
  loadBackendsCacheStatus,
  parseBackendRequestStageFacts,
  persistRuntimeBackendsCache,
  probeAllBackends,
  probeCandidateBackendsForWorkflow,
  probeResolvedTool,
  rankSuccessfulBackends,
  rebindExistingBackendsCacheToWorkflow,
  stripBackendRequestStageFacts,
  workflowCapabilityHash,
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

  it('rebinds a proven cache after metadata-only compiler annotations without probing', () => {
    const dir = pathResolve(root, 'metadata', 'search_items');
    mkdirSync(dir, { recursive: true });
    const workflow = {
      toolName: 'search_items',
      intent: { description: 'Search items' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/items', headers: {} }],
      site: 'metadata',
      liveVerified: true,
    };
    writeFileSync(pathResolve(dir, 'workflow.json'), JSON.stringify(workflow));
    writeFileSync(
      pathResolve(dir, 'backends.json'),
      JSON.stringify({
        probedAt: '2026-07-14T00:00:00.000Z',
        imprintVersion: '0.6.1',
        schemaVersion: 2,
        workflowHash: 'pre-metadata-workflow-hash',
        capabilityHash: workflowCapabilityHash(WorkflowSchema.parse(workflow)),
        preferredOrder: ['cdp-replay'],
        results: { 'cdp-replay': { outcome: 'ok', durationMs: 1_000 } },
      }),
    );

    const rebound = rebindExistingBackendsCacheToWorkflow(dir);

    expect(rebound?.preferredOrder).toEqual(['cdp-replay']);
    expect(rebound?.workflowHash).not.toBe('pre-metadata-workflow-hash');
    expect(loadBackendsCacheStatus('metadata', root, dir, { warn: false }).status).toBe('ok');
    expect(JSON.parse(readFileSync(pathResolve(dir, 'backends.json'), 'utf8')).workflowHash).toBe(
      rebound?.workflowHash,
    );
  });

  it('does not rebind a fetch-first cache after the workflow becomes browser-dependent', () => {
    const plain = WorkflowSchema.parse({
      toolName: 'reserve_item',
      intent: { description: 'Reserve an item' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/items', headers: {} }],
      site: 'capability-change',
    });
    const browserDependent = WorkflowSchema.parse({
      ...plain,
      requests: [
        {
          method: 'POST',
          url: 'https://example.com/cart',
          headers: { 'x-csrf': '${state.csrf}' },
          body: '{}',
        },
        {
          method: 'POST',
          url: 'https://example.com/reserve',
          headers: { 'x-csrf': '${state.csrf}' },
          body: '{}',
        },
      ],
    });
    const cache: BackendsCache = {
      probedAt: '2026-07-14T00:00:00.000Z',
      imprintVersion: '0.6.1',
      schemaVersion: 2,
      workflowHash: 'plain-workflow',
      capabilityHash: workflowCapabilityHash(plain),
      preferredOrder: ['fetch'],
      results: { fetch: { outcome: 'ok', durationMs: 20 } },
    };

    expect(canRebindBackendsCacheToWorkflow({ workflow: browserDependent }, cache)).toBe(false);
  });

  it('does not rebind when a bootstrap capture starts requiring a live DOM', () => {
    const htmlCapture = WorkflowSchema.parse({
      toolName: 'search_items',
      intent: { description: 'Search items' },
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://example.com/items?csrf=${state.csrf}',
          headers: {},
        },
      ],
      site: 'capture-change',
      bootstrap: {
        url: 'https://example.com',
        captures: [
          {
            name: 'csrf',
            source: 'html_regex',
            pattern: 'csrf=([^&]+)',
            capability: 'browser_bootstrap',
          },
        ],
      },
    });
    const domCapture = WorkflowSchema.parse({
      ...htmlCapture,
      bootstrap: {
        ...htmlCapture.bootstrap,
        captures: [
          {
            name: 'csrf',
            source: 'dom_attribute',
            selector: 'meta[name="csrf"]',
            attribute: 'content',
            capability: 'browser_bootstrap',
          },
        ],
      },
    });
    const cache: BackendsCache = {
      probedAt: '2026-07-14T00:00:00.000Z',
      imprintVersion: '0.6.1',
      schemaVersion: 2,
      workflowHash: 'html-workflow',
      capabilityHash: workflowCapabilityHash(htmlCapture),
      preferredOrder: ['fetch-bootstrap'],
      results: { 'fetch-bootstrap': { outcome: 'ok', durationMs: 500 } },
    };

    expect(workflowCapabilityHash(domCapture)).not.toBe(workflowCapabilityHash(htmlCapture));
    expect(canRebindBackendsCacheToWorkflow({ workflow: domCapture }, cache)).toBe(false);
  });

  it('normalizes capture requirements without hashing capture names or match details', () => {
    const first = WorkflowSchema.parse({
      toolName: 'search_items',
      intent: { description: 'Search items' },
      parameters: [],
      requests: [
        {
          method: 'GET',
          url: 'https://example.com/items',
          headers: {},
          captures: [
            { name: 'cursor', source: 'json', path: '$.next', required: false },
            { name: 'request_id', source: 'response_header', header: 'x-request-id' },
          ],
        },
      ],
      site: 'normalized-captures',
      bootstrap: {
        url: 'https://example.com',
        captures: [{ name: 'csrf', source: 'html_regex', pattern: 'csrf=([^&]+)' }],
      },
    });
    const cosmeticRevision = WorkflowSchema.parse({
      ...first,
      requests: [
        {
          ...first.requests[0],
          captures: [
            { name: 'trace', source: 'response_header', header: 'traceparent' },
            { name: 'page', source: 'json', path: '$.pagination.cursor', required: false },
          ],
        },
      ],
      bootstrap: {
        ...first.bootstrap,
        captures: [{ name: 'token', source: 'html_regex', pattern: 'token="([^"]+)"' }],
      },
    });
    const requestCaptureRevision = WorkflowSchema.parse({
      ...first,
      requests: [
        {
          ...first.requests[0],
          captures: [
            { name: 'cursor', source: 'text_regex', pattern: 'next=([^&]+)', required: false },
            { name: 'request_id', source: 'response_header', header: 'x-request-id' },
          ],
        },
      ],
    });

    expect(workflowCapabilityHash(cosmeticRevision)).toBe(workflowCapabilityHash(first));
    expect(workflowCapabilityHash(requestCaptureRevision)).not.toBe(workflowCapabilityHash(first));
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

  it('keeps playbook behind successful API transports even when it probes faster', () => {
    expect(
      rankSuccessfulBackends([
        { backend: 'playbook', durationMs: 6_000, tooSlow: false },
        { backend: 'stealth-fetch', durationMs: 20_000, tooSlow: false },
      ]),
    ).toEqual(['stealth-fetch', 'playbook']);
  });
});

describe('runtime backend learning', () => {
  it('does not rewrite a valid cache when its preferred backend succeeds', () => {
    const dir = pathResolve(root, 'learn-preferred', 'search_learn');
    mkdirSync(dir, { recursive: true });
    const workflow = WorkflowSchema.parse({
      toolName: 'search_learn',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/a', headers: {} }],
      site: 'learn-preferred',
    });
    const workflowJson = JSON.stringify(workflow);
    writeFileSync(pathResolve(dir, 'workflow.json'), workflowJson);
    const cachePath = pathResolve(dir, 'backends.json');
    const original = `${JSON.stringify(
      {
        probedAt: '2026-05-03T22:00:00.000Z',
        imprintVersion: '0.1.0',
        schemaVersion: 2,
        workflowHash: createHash('sha256').update(workflowJson).digest('hex'),
        preferredOrder: ['cdp-replay', 'stealth-fetch'],
        results: {
          'cdp-replay': {
            outcome: 'ok',
            durationMs: 12_000,
            coldDurationMs: 12_000,
            warmDurationMs: 2_000,
            rankingDurationMs: 2_000,
          },
          'stealth-fetch': { outcome: 'ok', durationMs: 20_000 },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(cachePath, original);
    const tool: ResolvedTool = {
      site: 'learn-preferred',
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
          detail: 'succeeded with an empty semantic result',
          durationMs: 38_000,
        },
      ],
    });

    expect(cache?.probedAt).toBe('2026-05-03T22:00:00.000Z');
    expect(cache?.results['cdp-replay']).toMatchObject({
      coldDurationMs: 12_000,
      warmDurationMs: 2_000,
      rankingDurationMs: 2_000,
    });
    expect(readFileSync(cachePath, 'utf8')).toBe(original);
  });

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

describe('probeCandidateBackendsForWorkflow', () => {
  it('includes cdp-replay for multi-step state-changing workflows with captured state refs', () => {
    const workflow = WorkflowSchema.parse({
      toolName: 'stateful_checkout',
      intent: { description: 'x' },
      parameters: [],
      requests: [
        {
          method: 'POST',
          url: 'https://example.com/start',
          headers: { 'X-Csrf': '${state.csrf}' },
        },
        {
          method: 'POST',
          url: 'https://example.com/confirm',
          headers: {},
        },
      ],
      site: 'stateful',
    });

    expect(probeCandidateBackendsForWorkflow(workflow)).toEqual([
      'fetch',
      'cdp-replay',
      'fetch-bootstrap',
      'stealth-fetch',
      'playbook',
    ]);
  });

  it('keeps browser-backed API probes deferred for plain workflows', () => {
    const workflow = WorkflowSchema.parse({
      toolName: 'plain_search',
      intent: { description: 'x' },
      parameters: [],
      requests: [{ method: 'GET', url: 'https://example.com/search', headers: {} }],
      site: 'plain',
    });

    expect(probeCandidateBackendsForWorkflow(workflow)).toEqual([
      'fetch',
      'stealth-fetch',
      'playbook',
    ]);
  });
});

describe('backendInvariantProbeFailure', () => {
  it('stops probing for deterministic request-transform failures', () => {
    expect(
      backendInvariantProbeFailure({
        ok: false,
        error: 'BAD_RESPONSE',
        message: 'request transform failed for request 0: brands must be a non-empty array',
      }),
    ).toBe('request transform failed for request 0: brands must be a non-empty array');
    expect(
      backendInvariantProbeFailure({
        ok: false,
        error: 'BAD_RESPONSE',
        message: 'request transform module was unavailable for request 0',
        requestStageFacts: [{ requestIndex: 0, stage: 'transform', outcome: 'unavailable' }],
      }),
    ).toBe('request transform module was unavailable for request 0');
  });

  it('keeps remote BAD_RESPONSE and transport failures eligible for fallback', () => {
    expect(
      backendInvariantProbeFailure({
        ok: false,
        error: 'BAD_RESPONSE',
        message: 'Request 0 returned 400: sensor headers required',
      }),
    ).toBeNull();
    expect(
      backendInvariantProbeFailure({
        ok: false,
        error: 'NETWORK',
        message: 'request timed out',
      }),
    ).toBeNull();
  });

  it('carries only value-free request-stage facts through a failed probe', async () => {
    const dir = pathResolve(root, 'fixture', 'search_fixture');
    mkdirSync(dir, { recursive: true });
    const tool: ResolvedTool = {
      site: 'fixture',
      dir,
      workflow: WorkflowSchema.parse({
        toolName: 'search_fixture',
        intent: { description: 'Search a fixture' },
        parameters: [],
        requests: [{ method: 'POST', url: 'https://example.com/search', headers: {} }],
        site: 'fixture',
      }),
      toolFn: async () => ({
        ok: false,
        error: 'BAD_RESPONSE',
        message: 'request transform failed for request 1: state was unavailable',
        requestStageFacts: [
          {
            requestIndex: 0,
            stage: 'send',
            outcome: 'passed',
            httpStatus: 200,
          },
          {
            requestIndex: 1,
            stage: 'transform',
            outcome: 'failed',
            bodyPresent: true,
            bodyByteLength: 42,
          },
        ],
      }),
    };

    let message = '';
    try {
      await probeResolvedTool({ site: 'fixture' }, root, tool);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(stripBackendRequestStageFacts(message)).toContain(
      'Backend-independent workflow failure for search_fixture',
    );
    expect(parseBackendRequestStageFacts(message)).toEqual([
      {
        backend: 'fetch',
        requestIndex: 0,
        stage: 'send',
        outcome: 'passed',
        httpStatus: 200,
      },
      {
        backend: 'fetch',
        requestIndex: 1,
        stage: 'transform',
        outcome: 'failed',
        bodyPresent: true,
        bodyByteLength: 42,
      },
    ]);
  });
});

describe('probeAllBackends', () => {
  it('rejects irreversible workflows before invoking the generated tool or writing a cache', async () => {
    const dir = pathResolve(root, 'orders', 'place_order');
    mkdirSync(dir, { recursive: true });
    let calls = 0;
    const tool: ResolvedTool = {
      site: 'orders',
      dir,
      workflow: WorkflowSchema.parse({
        toolName: 'place_order',
        intent: { description: 'Place an order' },
        parameters: [],
        requests: [
          {
            method: 'POST',
            url: 'https://orders.example/submit',
            headers: {},
            effect: 'irreversible',
          },
        ],
        site: 'orders',
      }),
      toolFn: async () => {
        calls++;
        return { ok: true, data: {} };
      },
    };

    await expect(probeResolvedTool({ site: 'orders' }, root, tool)).rejects.toThrow(
      /disabled for irreversible workflow/i,
    );
    expect(calls).toBe(0);
    expect(existsSync(pathResolve(dir, 'backends.json'))).toBe(false);
  });

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
    expect(results.map((r) => Object.keys(r.cache.results).sort())).toEqual([
      ['fetch', 'playbook', 'stealth-fetch'],
      ['fetch', 'playbook', 'stealth-fetch'],
    ]);
    expect(
      loadBackendsCache('multi', root, pathResolve(site, 'first_tool'))?.preferredOrder,
    ).toContain('fetch');
    expect(
      loadBackendsCache('multi', root, pathResolve(site, 'second_tool'))?.preferredOrder,
    ).toContain('fetch');
  });
});
