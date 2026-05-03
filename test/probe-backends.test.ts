/**
 * Tests for the probe + cache. Pure-logic — no real backends. Verifies
 * the cache schema, loader behavior, and that ladderFor honors a
 * cached preferredOrder.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { loadBackendsCache } from '../src/imprint/probe-backends.ts';
import { ladderFor } from '../src/imprint/replay-backend.ts';
import { type BackendsCache, BackendsCacheSchema } from '../src/imprint/types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(pathJoin(tmpdir(), 'imprint-probe-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCache(site: string, cache: unknown): string {
  const dir = pathResolve(root, site);
  mkdirSync(dir, { recursive: true });
  const path = pathResolve(dir, 'backends.json');
  writeFileSync(path, JSON.stringify(cache, null, 2));
  return path;
}

describe('BackendsCacheSchema', () => {
  it('accepts a minimal valid cache', () => {
    const r = BackendsCacheSchema.safeParse({
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: ['stealth-fetch'],
      results: { 'stealth-fetch': { outcome: 'ok', durationMs: 1234 } },
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty preferredOrder', () => {
    const r = BackendsCacheSchema.safeParse({
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: [],
      results: {},
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid backend name in preferredOrder', () => {
    const r = BackendsCacheSchema.safeParse({
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: ['fetch', 'magic-cloud'], // not a real backend
      results: {},
    });
    expect(r.success).toBe(false);
  });

  it('discriminates probe-result outcomes correctly', () => {
    const ok = BackendsCacheSchema.safeParse({
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: ['fetch'],
      results: {
        fetch: { outcome: 'ok', durationMs: 200 },
        'stealth-fetch': { outcome: 'forbidden', durationMs: 5000, detail: '403' },
        playbook: { outcome: 'failed', durationMs: 9000, error: 'NETWORK', detail: 'timeout' },
      },
    });
    expect(ok.success).toBe(true);
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
    const loaded = loadBackendsCache('alpha', root);
    expect(loaded).not.toBeNull();
    expect(loaded?.preferredOrder).toEqual(['stealth-fetch', 'playbook']);
  });

  it('returns null + warns on malformed JSON without throwing', () => {
    const dir = pathResolve(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathResolve(dir, 'backends.json'), '{this is not json');
    expect(loadBackendsCache('broken', root)).toBeNull();
  });

  it('returns null on schema-invalid cache without throwing', () => {
    writeCache('schema-bad', {
      probedAt: '2026-05-03T22:00:00.000Z',
      imprintVersion: '0.1.0',
      preferredOrder: [], // invalid: empty
      results: {},
    });
    expect(loadBackendsCache('schema-bad', root)).toBeNull();
  });
});

describe('ladderFor honors cached preferredOrder', () => {
  it('uses the cached order for "auto" when provided', () => {
    expect(ladderFor('auto', ['stealth-fetch', 'playbook'])).toEqual(['stealth-fetch', 'playbook']);
  });

  it('falls back to default for "auto" when cache is empty', () => {
    expect(ladderFor('auto')).toEqual(['fetch', 'stealth-fetch', 'playbook']);
    expect(ladderFor('auto', [])).toEqual(['fetch', 'stealth-fetch', 'playbook']);
  });

  it('ignores the cached order for explicit non-auto backends', () => {
    expect(ladderFor('fetch', ['stealth-fetch', 'playbook'])).toEqual(['fetch']);
    expect(ladderFor('playbook', ['fetch'])).toEqual(['playbook']);
  });
});
