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
import { loadBackendsCache } from '../src/imprint/probe-backends.ts';
import { type BackendsCache, BackendsCacheSchema } from '../src/imprint/types.ts';

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
        results: { 'stealth-fetch': { outcome: 'ok', durationMs: 1234 } },
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
  });
});
