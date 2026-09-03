import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  type TeachingRecordingResolution,
  resolveExplicitTeachingRecordings,
  resolveTeachingRecording,
  writeCombinedSession,
} from '../src/imprint/session-merge.ts';
import { type Session, SessionSchema } from '../src/imprint/types.ts';

function makeSession(
  input: {
    startedAt?: string;
    requestUrl?: string;
    secret?: string;
  } = {},
): Session {
  const requestUrl = input.requestUrl ?? 'https://example.com/api/first';
  return {
    site: 'test-site',
    startedAt: input.startedAt ?? '2026-08-29T09:00:00.000Z',
    url: 'https://example.com',
    imprintVersion: '0.6.6',
    requests: [
      {
        seq: 0,
        timestamp: 100,
        method: 'POST',
        url: requestUrl,
        headers: input.secret ? { authorization: `Bearer ${input.secret}` } : {},
        body: input.secret ? JSON.stringify({ token: input.secret }) : undefined,
        resourceType: 'Fetch',
      },
    ],
    events: [],
    narration: [],
    cookieSnapshots: [],
    storageSnapshots: [],
  };
}

function mustResolve(site = 'test-site'): TeachingRecordingResolution {
  const resolved = resolveTeachingRecording(site);
  if (!resolved) throw new Error(`Expected a teaching recording for ${site}`);
  return resolved;
}

describe('resolveTeachingRecording', () => {
  let testHome: string;
  let sessionsDir: string;

  beforeEach(() => {
    testHome = pathJoin(
      tmpdir(),
      `imprint-teaching-recording-${process.pid}-${Date.now()}-${Math.random()}`,
    );
    process.env.IMPRINT_HOME = testHome;
    sessionsDir = pathJoin(testHome, 'test-site', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    process.env.IMPRINT_HOME = undefined;
  });

  it('returns undefined when no recording exists', () => {
    expect(resolveTeachingRecording('test-site')).toBeUndefined();
  });

  it('selects the newest raw recording without writing an aggregate', () => {
    writeRaw(
      '2026-08-29T09-00-00-000Z.json',
      makeSession({ requestUrl: 'https://example.com/api/first' }),
    );
    const latestPath = writeRaw(
      '2026-08-29T10-00-00-000Z.json',
      makeSession({
        startedAt: '2026-08-29T10:00:00.000Z',
        requestUrl: 'https://example.com/api/latest',
      }),
    );

    const resolved = mustResolve();

    expect(resolved.path).toBe(latestPath);
    expect(resolved.refreshed).toBe(false);
    expect(resolved.recordingSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolved.sourceCount).toBe(1);
    const selected = SessionSchema.parse(JSON.parse(readFileSync(resolved.path, 'utf8')));
    expect(selected.requests[0]?.url).toBe('https://example.com/api/latest');
    expect(readdirSync(sessionsDir).filter((name) => name.startsWith('combined-'))).toEqual([]);
  });

  it('hashes the exact newest recording contents', () => {
    const rawPath = writeRaw('2026-08-29T09-00-00-000Z.json', makeSession());
    const first = mustResolve();

    writeFileSync(
      rawPath,
      JSON.stringify(makeSession({ requestUrl: 'https://example.com/api/changed' })),
      'utf8',
    );
    const second = mustResolve();

    expect(second.recordingSha256).not.toBe(first.recordingSha256);
    expect(second.path).toBe(rawPath);
  });

  it('skips malformed raw recordings and selects the newest valid raw recording', () => {
    const validPath = writeRaw('2026-08-29T09-00-00-000Z.json', makeSession());
    writeFileSync(pathJoin(sessionsDir, '2026-08-29T10-00-00-000Z.json'), '{bad', 'utf8');

    expect(mustResolve().path).toBe(validPath);
  });

  it('does not select an old combined recording when no raw recording exists', () => {
    writeCombinedSession('test-site', makeSession());
    expect(resolveTeachingRecording('test-site')).toBeUndefined();
  });

  it('uses one explicitly selected recording without combining it', () => {
    const path = writeRaw('first.json', makeSession());

    expect(resolveExplicitTeachingRecordings('test-site', [path])).toEqual({
      path,
      recordingSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sourceCount: 1,
      refreshed: false,
    });
    expect(readdirSync(sessionsDir).filter((name) => name.startsWith('combined-'))).toEqual([]);
  });

  it('combines only the recordings explicitly selected by the user', () => {
    const first = writeRaw(
      'first.json',
      makeSession({ requestUrl: 'https://example.com/api/first' }),
    );
    const second = writeRaw(
      'second.json',
      makeSession({
        startedAt: '2026-08-29T10:00:00.000Z',
        requestUrl: 'https://example.com/api/second',
      }),
    );
    writeRaw(
      'not-selected.json',
      makeSession({
        startedAt: '2026-08-29T11:00:00.000Z',
        requestUrl: 'https://example.com/api/not-selected',
      }),
    );

    const resolved = resolveExplicitTeachingRecordings('test-site', [first, second]);
    const combined = SessionSchema.parse(JSON.parse(readFileSync(resolved.path, 'utf8')));

    expect(resolved.sourceCount).toBe(2);
    expect(resolved.refreshed).toBe(true);
    expect(combined.requests.map(({ url }) => url)).toEqual([
      'https://example.com/api/first',
      'https://example.com/api/second',
    ]);
  });

  it('rejects selecting the same recording twice', () => {
    const path = writeRaw('first.json', makeSession());
    expect(() => resolveExplicitTeachingRecordings('test-site', [path, path])).toThrow(
      'same recording was selected more than once',
    );
  });

  function writeRaw(filename: string, session: Session): string {
    const path = pathJoin(sessionsDir, filename);
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    return path;
  }
});
