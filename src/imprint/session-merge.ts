/**
 * Multi-session merge for `imprint teach`.
 *
 * Users may explicitly combine selected recordings. A normal teach chooses
 * only the newest raw recording; it never expands its scope automatically.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { localSessionsDir } from './paths.ts';
import { friendlySessionTimestamp } from './teach-state.ts';
import { type Session, SessionSchema } from './types.ts';

export interface TeachingRecordingResolution {
  /** Absolute path to the selected raw recording or explicitly requested aggregate. */
  path: string;
  /** Digest of the exact recording bytes selected for this run. */
  recordingSha256: string;
  /** Number of user-selected raw recordings represented by this file. */
  sourceCount: number;
  /** True only when an explicit multi-recording selection wrote an aggregate. */
  refreshed: boolean;
  /** Session parsed from the exact bytes represented by recordingSha256. */
  session: Session;
}

/**
 * Format an ISO timestamp string (e.g. "2026-05-24T09:00:00.000Z") into
 * a human-readable form like "2026-05-24 09:00". Unlike friendlySessionTimestamp
 * which expects the dashed filename format, this handles standard ISO colons.
 */
function friendlyIsoTimestamp(iso: string): string {
  const m = iso.match(/(\d{4}-\d{2}-\d{2})T(\d{2})[:-](\d{2})/);
  if (!m) return iso;
  return `${m[1]} ${m[2]}:${m[3]}`;
}

interface SessionInfo {
  absPath: string;
  filename: string;
  friendlyTimestamp: string;
  requestCount: number;
  narrationCount: number;
  url: string;
  recordingSha256: string;
  session: Session;
}

const SESSION_READ_ATTEMPTS = 3;

/** Read one session consistently, retrying only an incomplete JSON read. */
export function readSessionFile(
  path: string,
  read: (path: string) => Buffer = (target) => readFileSync(target),
): { contents: Buffer; session: Session } {
  let lastParseError: unknown;
  for (let attempt = 0; attempt < SESSION_READ_ATTEMPTS; attempt++) {
    const contents = read(path);
    let raw: unknown;
    try {
      raw = JSON.parse(contents.toString('utf8'));
    } catch (error) {
      lastParseError = error;
      continue;
    }
    return { contents, session: SessionSchema.parse(raw) };
  }
  throw lastParseError;
}

export function listSiteSessions(site: string): SessionInfo[] {
  return listSessionsInDir(localSessionsDir(site));
}

function listSessionsInDir(dir: string): SessionInfo[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (f) =>
      f.endsWith('.json') &&
      !f.includes('.redacted') &&
      !f.includes('.triaged') &&
      !f.startsWith('combined-'),
  );

  const infos: SessionInfo[] = [];
  for (const filename of files) {
    const absPath = pathJoin(dir, filename);
    try {
      const { contents, session } = readSessionFile(absPath);
      infos.push({
        absPath,
        filename,
        friendlyTimestamp: friendlySessionTimestamp(filename),
        requestCount: session.requests.length,
        narrationCount: session.narration.length,
        url: session.url,
        recordingSha256: sha256Id(contents),
        session,
      });
    } catch {
      // Skip malformed sessions
    }
  }

  infos.sort((a, b) => b.filename.localeCompare(a.filename));
  return infos;
}

interface TaggedItem {
  kind: 'request' | 'event' | 'narration';
  absoluteTimestamp: number;
  // biome-ignore lint/suspicious/noExplicitAny: union of different shapes
  item: any;
}

export function mergeSessions(sessions: Session[]): Session {
  if (sessions.length === 0) {
    throw new Error('mergeSessions requires at least one session');
  }
  if (sessions.length === 1) {
    const only = sessions[0] as Session;
    return { ...only };
  }

  // Sort sessions chronologically by startedAt
  const sorted = [...sessions].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  const earliest = sorted[0] as Session;
  const latest = sorted[sorted.length - 1] as Session;

  const allItems: TaggedItem[] = [];

  for (const session of sorted) {
    const baseMs = new Date(session.startedAt).getTime();

    // Synthetic boundary narration
    allItems.push({
      kind: 'narration',
      absoluteTimestamp: baseMs,
      item: {
        seq: -1, // placeholder, will be reassigned
        timestamp: 0,
        text: `[Recording from ${friendlyIsoTimestamp(session.startedAt)}] ${session.url}`,
      },
    });

    for (const request of session.requests) {
      allItems.push({
        kind: 'request',
        absoluteTimestamp: baseMs + request.timestamp,
        item: { ...request },
      });
    }

    for (const event of session.events) {
      allItems.push({
        kind: 'event',
        absoluteTimestamp: baseMs + event.timestamp,
        item: { ...event },
      });
    }

    for (const narration of session.narration) {
      allItems.push({
        kind: 'narration',
        absoluteTimestamp: baseMs + narration.timestamp,
        item: { ...narration },
      });
    }
  }

  // Sort by absolute timestamp, then by kind for stable ordering
  const kindOrder = { narration: 0, event: 1, request: 2 };
  allItems.sort(
    (a, b) => a.absoluteTimestamp - b.absoluteTimestamp || kindOrder[a.kind] - kindOrder[b.kind],
  );

  // Reassign seq numbers monotonically
  const earliestMs = new Date(earliest.startedAt).getTime();
  const requests: Session['requests'] = [];
  const events: Session['events'] = [];
  const narration: Session['narration'] = [];

  for (let seq = 0; seq < allItems.length; seq++) {
    const tagged = allItems[seq] as TaggedItem;
    const relativeTimestamp = tagged.absoluteTimestamp - earliestMs;

    if (tagged.kind === 'request') {
      requests.push({ ...tagged.item, seq, timestamp: relativeTimestamp });
    } else if (tagged.kind === 'event') {
      events.push({ ...tagged.item, seq, timestamp: relativeTimestamp });
    } else {
      narration.push({ ...tagged.item, seq, timestamp: relativeTimestamp });
    }
  }

  // Merge cookie and storage snapshots
  const cookieSnapshots = sorted.flatMap((s) => {
    const baseMs = new Date(s.startedAt).getTime();
    return s.cookieSnapshots.map((cs) => ({
      ...cs,
      timestamp: cs.timestamp + (baseMs - earliestMs),
    }));
  });

  const storageSnapshots = sorted.flatMap((s) => {
    const baseMs = new Date(s.startedAt).getTime();
    return s.storageSnapshots.map((ss) => ({
      ...ss,
      timestamp: ss.timestamp + (baseMs - earliestMs),
    }));
  });

  return {
    site: earliest.site,
    startedAt: earliest.startedAt,
    url: latest.url,
    imprintVersion: latest.imprintVersion,
    requests,
    events,
    narration,
    cookieSnapshots,
    storageSnapshots,
  };
}

export function writeCombinedSession(site: string, combined: Session): string {
  const sessDir = localSessionsDir(site);
  mkdirSync(sessDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `combined-${timestamp}.json`;
  const absPath = pathJoin(sessDir, filename);
  writeFileSync(absPath, `${JSON.stringify(combined, null, 2)}\n`, 'utf8');
  return absPath;
}

/** Use exactly the recordings the user named, combining them only when there are several. */
export function resolveExplicitTeachingRecordings(
  site: string,
  selectedPaths: readonly string[],
): TeachingRecordingResolution {
  if (selectedPaths.length === 0) {
    throw new Error('at least one recording must be selected');
  }
  if (new Set(selectedPaths).size !== selectedPaths.length) {
    throw new Error('the same recording was selected more than once');
  }

  const selected = selectedPaths.map((path) => {
    const { contents, session } = readSessionFile(path);
    if (session.site !== site) {
      throw new Error(`recording site "${session.site}" does not match requested site "${site}"`);
    }
    return { path, contents, session };
  });

  if (selected.length === 1) {
    const only = selected[0] as (typeof selected)[number];
    return {
      path: only.path,
      recordingSha256: sha256Id(only.contents),
      sourceCount: 1,
      refreshed: false,
      session: only.session,
    };
  }

  const combined = mergeSessions(selected.map(({ session }) => session));
  const path = writeCombinedSession(site, combined);
  return {
    path,
    recordingSha256: sha256Id(readFileSync(path)),
    sourceCount: selected.length,
    refreshed: true,
    session: combined,
  };
}

/** Select only the newest valid raw recording for a fresh teach run. */
export function resolveTeachingRecording(site: string): TeachingRecordingResolution | undefined {
  const latest = listSiteSessions(site)[0];
  if (!latest) return undefined;
  return {
    path: latest.absPath,
    recordingSha256: latest.recordingSha256,
    sourceCount: 1,
    refreshed: false,
    session: latest.session,
  };
}

function sha256Id(contents: Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}
