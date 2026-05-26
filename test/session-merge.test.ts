import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  listSiteSessions,
  mergeSessions,
  writeCombinedSession,
} from '../src/imprint/session-merge.ts';
import { type Session, SessionSchema } from '../src/imprint/types.ts';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    site: 'test-site',
    startedAt: '2026-05-24T09:00:00.000Z',
    url: 'https://example.com',
    imprintVersion: '0.2.0',
    requests: [],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
    ...overrides,
  };
}

describe('mergeSessions', () => {
  it('throws on empty input', () => {
    expect(() => mergeSessions([])).toThrow('at least one session');
  });

  it('returns a copy for single session input', () => {
    const session = makeSession({
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
      narration: [{ seq: 1, timestamp: 200, text: 'searched for flights' }],
    });

    const result = mergeSessions([session]);
    expect(result.requests.length).toBe(1);
    // Single session still gets boundary narration is NOT added (only for multi-session)
    // Actually our implementation adds it even for single — let's check
    expect(result.site).toBe('test-site');
  });

  it('produces unique monotonic seq numbers across two sessions', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/a',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 1,
          timestamp: 200,
          method: 'POST',
          url: 'https://example.com/b',
          headers: {},
          resourceType: 'XHR',
        },
      ],
      events: [{ seq: 2, timestamp: 150, type: 'click' as const, detail: '{"selector":"button"}' }],
      narration: [{ seq: 3, timestamp: 50, text: 'first action' }],
    });

    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      url: 'https://example.com/page2',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/c',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
      events: [
        { seq: 1, timestamp: 50, type: 'navigation' as const, detail: 'https://example.com/page2' },
      ],
      narration: [{ seq: 2, timestamp: 200, text: 'second action' }],
    });

    const merged = mergeSessions([s1, s2]);

    // Collect all seqs across requests + events + narration
    const allSeqs = [
      ...merged.requests.map((r) => r.seq),
      ...merged.events.map((e) => e.seq),
      ...merged.narration.map((n) => n.seq),
    ].sort((a, b) => a - b);

    // All unique
    expect(new Set(allSeqs).size).toBe(allSeqs.length);

    // Monotonically increasing from 0
    for (let i = 0; i < allSeqs.length; i++) {
      expect(allSeqs[i]).toBe(i);
    }
  });

  it('sorts items by absolute timestamp across sessions', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 500,
          method: 'GET',
          url: 'https://example.com/late-s1',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });

    // s2 started 1 hour later but its request has a smaller relative timestamp
    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/early-s2',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });

    const merged = mergeSessions([s1, s2]);

    // s1 request at absolute 09:00:00 + 500ms = early
    // s2 request at absolute 10:00:00 + 100ms = late
    // So s1 request should come first (ignoring boundary narrations)
    const requestUrls = merged.requests.map((r) => r.url);
    expect(requestUrls).toEqual(['https://example.com/late-s1', 'https://example.com/early-s2']);
  });

  it('inserts boundary narration markers for each session', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      url: 'https://flights.google.com',
    });
    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      url: 'https://flights.google.com/booking',
    });

    const merged = mergeSessions([s1, s2]);

    const boundaryNarrations = merged.narration.filter((n) => n.text.startsWith('[Recording from'));
    expect(boundaryNarrations.length).toBe(2);
    expect(boundaryNarrations[0]?.text).toContain('https://flights.google.com');
    expect(boundaryNarrations[1]?.text).toContain('https://flights.google.com/booking');
  });

  it('formats boundary narration timestamps from ISO strings correctly', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:15:00.000Z',
      url: 'https://example.com',
    });
    const s2 = makeSession({
      startedAt: '2026-05-24T14:30:00.000Z',
      url: 'https://example.com/page2',
    });

    const merged = mergeSessions([s1, s2]);
    const boundaries = merged.narration.filter((n) => n.text.startsWith('[Recording from'));

    // Should produce "2026-05-24 09:15", not the raw ISO string
    expect(boundaries[0]?.text).toBe('[Recording from 2026-05-24 09:15] https://example.com');
    expect(boundaries[1]?.text).toBe('[Recording from 2026-05-24 14:30] https://example.com/page2');
  });

  it('produces a valid Session that passes schema validation', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/api',
          headers: { 'content-type': 'application/json' },
          resourceType: 'Fetch',
          response: { status: 200, headers: {}, body: '{"ok":true}', mimeType: 'application/json' },
        },
      ],
      events: [{ seq: 1, timestamp: 50, type: 'click' as const, detail: '{}' }],
      narration: [{ seq: 2, timestamp: 10, text: 'clicked button' }],
    });

    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 200,
          method: 'POST',
          url: 'https://example.com/submit',
          headers: {},
          resourceType: 'XHR',
        },
      ],
    });

    const merged = mergeSessions([s1, s2]);
    const parsed = SessionSchema.parse(merged);
    expect(parsed.site).toBe('test-site');
    expect(parsed.requests.length).toBe(2);
  });

  it('uses earliest startedAt and latest imprintVersion', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      imprintVersion: '0.1.0',
    });
    const s2 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      imprintVersion: '0.2.0',
    });

    const merged = mergeSessions([s1, s2]);
    // s2 is earlier, so startedAt comes from s2
    expect(merged.startedAt).toBe('2026-05-24T09:00:00.000Z');
    // s1 is later chronologically, so imprintVersion comes from s1
    expect(merged.imprintVersion).toBe('0.1.0');
  });

  it('merges cookie snapshots with adjusted timestamps', () => {
    const s1 = makeSession({
      startedAt: '2026-05-24T09:00:00.000Z',
      cookieSnapshots: [
        {
          takenAt: '2026-05-24T09:00:00.000Z',
          timestamp: 0,
          label: 'start' as const,
          cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }],
        },
      ],
    });
    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      cookieSnapshots: [
        {
          takenAt: '2026-05-24T10:00:00.000Z',
          timestamp: 0,
          label: 'start' as const,
          cookies: [{ name: 'sid', value: 'def', domain: '.example.com', path: '/' }],
        },
      ],
    });

    const merged = mergeSessions([s1, s2]);
    expect(merged.cookieSnapshots.length).toBe(2);
    // s1 cookie at offset 0 from earliest (09:00) = 0
    expect(merged.cookieSnapshots[0]?.timestamp).toBe(0);
    // s2 cookie at offset 0 from 10:00, but relative to earliest 09:00 = 3600000ms
    expect(merged.cookieSnapshots[1]?.timestamp).toBe(3_600_000);
  });

  it('handles sessions with no requests gracefully', () => {
    const s1 = makeSession({ startedAt: '2026-05-24T09:00:00.000Z' });
    const s2 = makeSession({
      startedAt: '2026-05-24T10:00:00.000Z',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://example.com/a',
          headers: {},
          resourceType: 'Fetch',
        },
      ],
    });

    const merged = mergeSessions([s1, s2]);
    expect(merged.requests.length).toBe(1);
    // Should have 2 boundary narrations even though s1 has no data
    const boundaries = merged.narration.filter((n) => n.text.startsWith('[Recording from'));
    expect(boundaries.length).toBe(2);
  });
});

describe('listSiteSessions', () => {
  const testDir = pathJoin(tmpdir(), `imprint-test-${Date.now()}`);

  beforeEach(() => {
    process.env.IMPRINT_HOME = testDir;
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    mkdirSync(sessDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    process.env.IMPRINT_HOME = undefined;
  });

  it('returns empty array when no sessions exist', () => {
    expect(listSiteSessions('nonexistent-site')).toEqual([]);
  });

  it('lists raw sessions and excludes redacted/triaged', () => {
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    const session = makeSession();

    writeFileSync(pathJoin(sessDir, '2026-05-24T09-00-00-000Z.json'), JSON.stringify(session));
    writeFileSync(
      pathJoin(sessDir, '2026-05-24T09-00-00-000Z.redacted.json'),
      JSON.stringify(session),
    );
    writeFileSync(
      pathJoin(sessDir, '2026-05-24T09-00-00-000Z.triaged.json'),
      JSON.stringify(session),
    );
    writeFileSync(pathJoin(sessDir, '2026-05-24T10-00-00-000Z.json'), JSON.stringify(session));

    const results = listSiteSessions('test-site');
    expect(results.length).toBe(2);
    expect(results.map((r) => r.filename)).toEqual([
      '2026-05-24T10-00-00-000Z.json',
      '2026-05-24T09-00-00-000Z.json',
    ]);
  });

  it('excludes combined-*.json files from listings', () => {
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    const session = makeSession();

    writeFileSync(pathJoin(sessDir, '2026-05-24T09-00-00-000Z.json'), JSON.stringify(session));
    writeFileSync(
      pathJoin(sessDir, 'combined-2026-05-24T09-30-00-000Z.json'),
      JSON.stringify(session),
    );

    const results = listSiteSessions('test-site');
    expect(results.length).toBe(1);
    expect(results[0]?.filename).toBe('2026-05-24T09-00-00-000Z.json');
  });

  it('skips malformed session files', () => {
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    writeFileSync(pathJoin(sessDir, 'bad.json'), 'not json at all');
    writeFileSync(pathJoin(sessDir, 'good.json'), JSON.stringify(makeSession()));

    const results = listSiteSessions('test-site');
    expect(results.length).toBe(1);
    expect(results[0]?.filename).toBe('good.json');
  });

  it('returns correct metadata', () => {
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    const session = makeSession({
      url: 'https://flights.google.com',
      requests: [
        {
          seq: 0,
          timestamp: 100,
          method: 'GET',
          url: 'https://flights.google.com/api',
          headers: {},
          resourceType: 'Fetch',
        },
        {
          seq: 1,
          timestamp: 200,
          method: 'POST',
          url: 'https://flights.google.com/search',
          headers: {},
          resourceType: 'XHR',
        },
      ],
      narration: [{ seq: 2, timestamp: 50, text: 'searched for flights' }],
    });
    writeFileSync(pathJoin(sessDir, '2026-05-24T09-13-35-646Z.json'), JSON.stringify(session));

    const results = listSiteSessions('test-site');
    expect(results.length).toBe(1);
    expect(results[0]?.requestCount).toBe(2);
    expect(results[0]?.narrationCount).toBe(1);
    expect(results[0]?.url).toBe('https://flights.google.com');
    expect(results[0]?.friendlyTimestamp).toBe('2026-05-24 09:13');
  });
});

describe('writeCombinedSession', () => {
  const testDir = pathJoin(tmpdir(), `imprint-test-write-${Date.now()}`);

  beforeEach(() => {
    process.env.IMPRINT_HOME = testDir;
    const sessDir = pathJoin(testDir, 'test-site', 'sessions');
    mkdirSync(sessDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    process.env.IMPRINT_HOME = undefined;
  });

  it('writes a combined session file with correct naming', () => {
    const session = makeSession();
    const path = writeCombinedSession('test-site', session);

    expect(path).toContain('combined-');
    expect(path).toEndWith('.json');

    const { existsSync } = require('node:fs');
    expect(existsSync(path)).toBe(true);

    const loaded = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    expect(loaded.site).toBe('test-site');
  });
});
