import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join as pathJoin } from 'node:path';
import {
  type TeachingRecordingResolution,
  resolveLatestCombinedSession,
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
    expect(resolveLatestCombinedSession('test-site')).toBeUndefined();
  });

  it('creates a combined recording and a value-free source hash manifest', () => {
    const secret = 'do-not-copy-this-captured-secret';
    writeRaw('2026-08-29T09-00-00-000Z.json', makeSession({ secret }));

    const resolved = mustResolve();

    expect(resolved.refreshed).toBe(true);
    expect(resolved.recordingSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolved.sourceCount).toBe(1);
    expect(resolved.sourceSetSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SessionSchema.parse(JSON.parse(readFileSync(resolved.path, 'utf8')))).toBeDefined();

    const manifestPath = `${resolved.path}.sources-manifest`;
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest.version).toBe(1);
    expect(manifest.sourceSha256).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);
    expect(manifestText).not.toContain(secret);
    expect(manifestText).not.toContain('authorization');
    expect(manifestText).not.toContain('example.com');
  });

  it('reuses a current aggregate even when the raw file mtime becomes newer', () => {
    const rawPath = writeRaw('2026-08-29T09-00-00-000Z.json', makeSession());
    const first = mustResolve();
    expect(first.refreshed).toBe(true);

    const future = new Date('2100-01-01T00:00:00.000Z');
    utimesSync(rawPath, future, future);
    const second = mustResolve();

    expect(second).toEqual({ ...first, refreshed: false });
  });

  it('refreshes when raw contents change even if their mtime does not', () => {
    const rawPath = writeRaw('2026-08-29T09-00-00-000Z.json', makeSession());
    const originalTimes = statSync(rawPath);
    const first = mustResolve();

    writeFileSync(
      rawPath,
      JSON.stringify(makeSession({ requestUrl: 'https://example.com/api/changed' })),
      'utf8',
    );
    utimesSync(rawPath, originalTimes.atime, originalTimes.mtime);
    const second = mustResolve();

    expect(second.refreshed).toBe(true);
    expect(second.sourceSetSha256).not.toBe(first.sourceSetSha256);
    const combined = SessionSchema.parse(JSON.parse(readFileSync(second.path, 'utf8')));
    expect(combined.requests[0]?.url).toBe('https://example.com/api/changed');
  });

  it('refreshes after a new raw recording and keeps every raw file', () => {
    const firstRaw = writeRaw(
      '2026-08-29T09-00-00-000Z.json',
      makeSession({ requestUrl: 'https://example.com/api/first' }),
    );
    const first = mustResolve();
    const secondRaw = writeRaw(
      '2026-08-29T10-00-00-000Z.json',
      makeSession({
        startedAt: '2026-08-29T10:00:00.000Z',
        requestUrl: 'https://example.com/api/second',
      }),
    );

    const second = mustResolve();

    expect(second.refreshed).toBe(true);
    expect(second.sourceCount).toBe(2);
    expect(second.sourceSetSha256).not.toBe(first.sourceSetSha256);
    expect(statSync(firstRaw).isFile()).toBe(true);
    expect(statSync(secondRaw).isFile()).toBe(true);
    const combined = SessionSchema.parse(JSON.parse(readFileSync(second.path, 'utf8')));
    expect(combined.requests.map((request) => request.url)).toEqual([
      'https://example.com/api/first',
      'https://example.com/api/second',
    ]);
  });

  it('ignores a newer malformed aggregate and selects the latest valid one', () => {
    writeRaw('2026-08-29T09-00-00-000Z.json', makeSession());
    const first = mustResolve();
    writeFileSync(pathJoin(sessionsDir, 'combined-9999-12-31T23-59-59-999Z.json'), '{bad', 'utf8');

    const second = mustResolve();

    expect(second.path).toBe(first.path);
    expect(second.refreshed).toBe(false);
  });

  it('can select a valid combined recording when its raw sources are unavailable', () => {
    const combinedPath = writeCombinedSession('test-site', makeSession());

    const resolved = mustResolve();

    expect(resolved).toEqual({
      path: combinedPath,
      recordingSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sourceCount: 0,
      refreshed: false,
    });
    expect(basename(resolveLatestCombinedSession('test-site') ?? '')).toBe(basename(combinedPath));
  });

  function writeRaw(filename: string, session: Session): string {
    const path = pathJoin(sessionsDir, filename);
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    return path;
  }
});
