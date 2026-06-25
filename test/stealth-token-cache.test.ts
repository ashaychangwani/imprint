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
      const token: TokenCache = {
        ...tokenAt(5),
        bootstrapHtml: '<html>fixture</html>',
        bootstrapResponseHeaders: { 'x-bootstrap': 'yes' },
        observedRequests: [
          {
            method: 'POST',
            url: 'https://example.com/api/bootstrap',
            headers: { 'X-Browser-Minted': 'token' },
            response: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"stale":true}',
            },
          },
        ],
        userAgent: 'RealChrome/148',
        clientHints: { 'sec-ch-ua-platform': '"Linux"' },
      };
      saveCachedToken(dir, token);
      const loaded = loadCachedToken(dir, 600);
      expect(loaded).not.toBeNull();
      expect(loaded?.cookies).toEqual(token.cookies);
      expect(loaded?.sensorHeaders).toEqual(token.sensorHeaders);
      expect(loaded?.bootstrappedAt).toBe(token.bootstrappedAt);
      expect(loaded?.bootstrapHtml).toBe(token.bootstrapHtml);
      expect(loaded?.bootstrapResponseHeaders).toEqual(token.bootstrapResponseHeaders);
      expect(loaded?.observedRequests).toEqual([
        {
          method: 'POST',
          url: 'https://example.com/api/bootstrap',
          headers: { 'X-Browser-Minted': 'token' },
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        },
      ]);
      expect(loaded?.userAgent).toBe(token.userAgent);
      expect(loaded?.clientHints).toEqual(token.clientHints);
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
