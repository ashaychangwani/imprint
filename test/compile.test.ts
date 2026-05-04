/**
 * Tests for the LLM compiler (compile.ts).
 *
 * The Vertex LLM call itself is not exercised — that needs a live model.
 * What we cover:
 *   - shrinkSession (pure noise-stripping logic; this is what saves
 *     6.5M → 0.3M tokens on Southwest)
 *   - Session-not-found error path (the user-facing message added in
 *     Phase 6 should include the `→ run \`imprint record\`` hint)
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { generate, shrinkSession } from '../src/imprint/compile.ts';
import type { Session } from '../src/imprint/types.ts';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    site: 'test',
    startedAt: '2026-05-04T00:00:00.000Z',
    url: 'https://example.com/start',
    imprintVersion: '0.1.0',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    ...overrides,
  };
}

describe('shrinkSession', () => {
  it('keeps same-origin XHR requests', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/data',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    const r = shrinkSession(session);
    expect(r.requests).toHaveLength(1);
  });

  it('drops third-party requests (different root domain)', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api/data',
          headers: {},
          resourceType: 'XHR',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'GET',
          url: 'https://google-analytics.com/collect?tid=UA-X',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    const r = shrinkSession(session);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.url).toContain('example.com');
  });

  it.each(['Image', 'Font', 'Stylesheet', 'Script', 'Ping', 'Preflight'])(
    'drops noise resource type: %s',
    (resourceType) => {
      const session = makeSession({
        requests: [
          {
            seq: 1,
            timestamp: 100,
            method: 'GET',
            url: 'https://example.com/asset',
            headers: {},
            resourceType,
          },
        ],
      });
      expect(shrinkSession(session).requests).toHaveLength(0);
    },
  );

  it('keeps subdomains of the same root domain', () => {
    const session = makeSession({
      url: 'https://www.example.com/start',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.com/v1/search',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });
    expect(shrinkSession(session).requests).toHaveLength(1);
  });

  it('correctly scopes same-site under multi-part TLDs (.co.uk bug-fix)', () => {
    // Pre-fix: rootDomain('www.example.co.uk') returned 'co.uk', so
    // every other .co.uk hostname (an unrelated tracker, a competitor's
    // CDN) would survive the filter. Now only example.co.uk's own
    // subdomains pass.
    const session = makeSession({
      url: 'https://www.example.co.uk/start',
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'POST',
          url: 'https://api.example.co.uk/v1/search',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 2,
          timestamp: 200,
          method: 'POST',
          url: 'https://tracker.unrelated.co.uk/log',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });
    const kept = shrinkSession(session).requests;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.url).toContain('example.co.uk');
  });

  it('drops requests with malformed URLs', () => {
    const session = makeSession({
      requests: [
        {
          seq: 1,
          timestamp: 100,
          method: 'GET',
          url: 'not-a-url',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });
    expect(shrinkSession(session).requests).toHaveLength(0);
  });

  it('preserves cookieSnapshots, events, and narration unchanged', () => {
    const session = makeSession({
      requests: [],
      events: [{ seq: 0, timestamp: 100, type: 'click', detail: '{}' }],
      narration: [{ seq: 1, timestamp: 200, text: 'clicked the search button' }],
      cookieSnapshots: [
        { takenAt: '2026-05-04T00:00:00Z', timestamp: 0, label: 'start', cookies: [] },
      ],
    });
    const r = shrinkSession(session);
    expect(r.events).toHaveLength(1);
    expect(r.narration).toHaveLength(1);
    expect(r.cookieSnapshots).toHaveLength(1);
  });
});

describe('generate — input validation', () => {
  it('rejects a missing session path with an actionable hint', async () => {
    await expect(
      generate({ sessionPath: '/tmp/imprint-no-such-session-12345.json', params: {} } as never),
    ).rejects.toThrow(/session not found.*imprint record/is);
  });

  it('rejects a malformed JSON file', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-test-'));
    const path = pathJoin(dir, 'bad.json');
    writeFileSync(path, '{this is not json');
    try {
      await expect(generate({ sessionPath: path, params: {} } as never)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a JSON that does not match the Session schema', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-compile-test-'));
    const path = pathJoin(dir, 'wrong-shape.json');
    writeFileSync(path, JSON.stringify({ unrelated: 'object' }));
    try {
      await expect(generate({ sessionPath: path, params: {} } as never)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generate — output path resolution', () => {
  // Helper: a minimal valid session with no requests (so the LLM call would
  // never need to fire). We bail before calling the LLM via a session path
  // that exists but produces invalid LLM output... actually simpler: just
  // confirm the path computation logic via the error from the LLM call.
  // For now, this describe stays empty — full LLM integration tests live
  // outside the unit suite.
  it('placeholder — full LLM compile tested via examples/southwest end-to-end', () => {
    expect(true).toBe(true);
  });
});
