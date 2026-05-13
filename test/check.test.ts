/**
 * `imprint check` is a sanity-checker for captured sessions. It's the
 * first verb a recently-onboarded user runs to verify their recording
 * isn't garbage. The branches that fire warnings are heuristics, so a
 * test pinning their behavior is cheap insurance against regressions
 * (e.g. someone renaming `cookieSnapshots` and silently dropping the
 * "no end snapshot" warning).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { checkSession } from '../src/imprint/check.ts';
import type { Session } from '../src/imprint/types.ts';

function withTemp<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-check-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSession(dir: string, session: Session): string {
  const path = pathJoin(dir, 'session.json');
  writeFileSync(path, JSON.stringify(session, null, 2));
  return path;
}

const HAPPY_SESSION: Session = {
  site: 'example',
  startedAt: '2026-01-01T00:00:00.000Z',
  url: 'https://example.com',
  imprintVersion: '0.1.0',
  requests: [
    {
      seq: 0,
      timestamp: 100,
      method: 'GET',
      url: 'https://example.com/',
      headers: {},
      resourceType: 'Document',
      response: { status: 200, headers: {} },
    },
    {
      seq: 1,
      timestamp: 8000,
      method: 'POST',
      url: 'https://example.com/api/order',
      headers: {},
      resourceType: 'XHR',
      response: { status: 200, headers: {} },
    },
  ],
  events: [
    { seq: 2, timestamp: 200, type: 'navigation', detail: 'https://example.com' },
    { seq: 3, timestamp: 6000, type: 'click', detail: '{"selector":"#go"}' },
    { seq: 4, timestamp: 7500, type: 'submit', detail: '{"selector":"form"}' },
  ],
  narration: [{ seq: 5, timestamp: 6500, text: 'place the order' }],
  cookieSnapshots: [
    { takenAt: 'a', timestamp: 0, label: 'start', cookies: [] },
    { takenAt: 'b', timestamp: 9000, label: 'end', cookies: [] },
  ],
  storageSnapshots: [],
};

describe('checkSession', () => {
  it('reports ok with no warnings on a complete session', () => {
    withTemp((dir) => {
      const path = writeSession(dir, HAPPY_SESSION);
      const result = checkSession(path);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.summary).toContain('site:        example');
      expect(result.summary).toContain('1 doc, 1 xhr, 1 POST/PUT/DELETE');
    });
  });

  it('returns ok=false with the file-not-found warning for missing paths', () => {
    const result = checkSession('/definitely/not/a/real/file.json');
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/file not found/i);
  });

  it('warns when narration is empty (LLM intent works best with it)', () => {
    withTemp((dir) => {
      const path = writeSession(dir, { ...HAPPY_SESSION, narration: [] });
      const result = checkSession(path);
      expect(result.ok).toBe(false);
      expect(result.warnings.some((w) => /narration/i.test(w))).toBe(true);
    });
  });

  it('warns when no POST/PUT/DELETE fired (likely incomplete capture)', () => {
    withTemp((dir) => {
      const requestsNoPost = HAPPY_SESSION.requests.filter((r) => r.method === 'GET');
      const path = writeSession(dir, { ...HAPPY_SESSION, requests: requestsNoPost });
      const result = checkSession(path);
      expect(result.warnings.some((w) => /POST\/PUT\/DELETE/.test(w))).toBe(true);
    });
  });

  it('warns when end-of-session cookie snapshot is missing (recorder crashed)', () => {
    withTemp((dir) => {
      const path = writeSession(dir, {
        ...HAPPY_SESSION,
        cookieSnapshots: HAPPY_SESSION.cookieSnapshots?.filter((c) => c.label !== 'end') ?? [],
      });
      const result = checkSession(path);
      expect(result.warnings.some((w) => /end-of-session/i.test(w))).toBe(true);
    });
  });

  it('warns when no clicks or submits captured (injector failed)', () => {
    withTemp((dir) => {
      const path = writeSession(dir, {
        ...HAPPY_SESSION,
        events: HAPPY_SESSION.events.filter((e) => e.type === 'navigation'),
      });
      const result = checkSession(path);
      expect(result.warnings.some((w) => /clicks or form submits/i.test(w))).toBe(true);
    });
  });

  it('warns when 4xx/5xx outnumber 2xx (auth or anti-bot blocking)', () => {
    withTemp((dir) => {
      const requests: Session['requests'] = [];
      // 4 errors, 1 success
      for (let i = 0; i < 4; i++) {
        requests.push({
          seq: i,
          timestamp: 100 + i * 100,
          method: 'GET',
          url: `https://example.com/api/${i}`,
          headers: {},
          resourceType: 'XHR',
          response: { status: 403, headers: {} },
        });
      }
      requests.push({
        seq: 4,
        timestamp: 8000,
        method: 'POST',
        url: 'https://example.com/api/order',
        headers: {},
        resourceType: 'XHR',
        response: { status: 200, headers: {} },
      });
      const path = writeSession(dir, { ...HAPPY_SESSION, requests });
      const result = checkSession(path);
      expect(result.warnings.some((w) => /Auth or anti-bot/i.test(w))).toBe(true);
    });
  });

  it('returns a parse-failure warning on malformed JSON', () => {
    withTemp((dir) => {
      const path = pathJoin(dir, 'session.json');
      writeFileSync(path, '{not valid json');
      const result = checkSession(path);
      expect(result.ok).toBe(false);
      expect(result.warnings[0]).toMatch(/failed to parse/i);
    });
  });
});
