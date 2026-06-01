import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { TokenCache } from '../src/imprint/stealth-fetch.ts';
import {
  clearCachedToken,
  loadCachedToken,
  saveCachedToken,
} from '../src/imprint/stealth-token-cache.ts';

function scratchDir(): string {
  const root = pathJoin(import.meta.dir, '..', '.context');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(pathJoin(root, 'stealth-token-'));
}

function tokenAt(ageSeconds: number): TokenCache {
  return {
    cookies: [{ name: 'abck', value: 'fixture-cookie' }],
    sensorHeaders: { 'x-acf-sensor-data': 'fixture-sensor' },
    bootstrappedAt: Date.now() - ageSeconds * 1000,
  };
}

describe('stealth-token-cache', () => {
  it('round-trips a fresh token', () => {
    const dir = scratchDir();
    try {
      const token = tokenAt(5);
      saveCachedToken(dir, token);
      const loaded = loadCachedToken(dir, 600);
      expect(loaded).not.toBeNull();
      expect(loaded?.cookies).toEqual(token.cookies);
      expect(loaded?.sensorHeaders).toEqual(token.sensorHeaders);
      expect(loaded?.bootstrappedAt).toBe(token.bootstrappedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a token older than the max age', () => {
    const dir = scratchDir();
    try {
      saveCachedToken(dir, tokenAt(700));
      expect(loadCachedToken(dir, 600)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no token file exists', () => {
    const dir = scratchDir();
    try {
      expect(loadCachedToken(dir, 600)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a malformed token file', () => {
    const dir = scratchDir();
    try {
      writeFileSync(pathJoin(dir, '.stealth-token.json'), '{ not json', 'utf8');
      expect(loadCachedToken(dir, 600)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears a cached token', () => {
    const dir = scratchDir();
    try {
      saveCachedToken(dir, tokenAt(1));
      expect(existsSync(pathJoin(dir, '.stealth-token.json'))).toBe(true);
      clearCachedToken(dir);
      expect(existsSync(pathJoin(dir, '.stealth-token.json'))).toBe(false);
      expect(loadCachedToken(dir, 600)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
