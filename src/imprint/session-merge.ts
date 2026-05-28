/**
 * Multi-session merge for `imprint teach`.
 *
 * When a user records a new session, they can combine it with past recordings
 * of the same site so triage and candidate detection see the full picture.
 * The merge produces a single valid Session object that the rest of the
 * pipeline consumes unchanged.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { localSessionsDir } from './paths.ts';
import { friendlySessionTimestamp } from './teach-state.ts';
import { type Session, SessionSchema } from './types.ts';

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
}

export function listSiteSessions(site: string): SessionInfo[] {
  return listSessionsInDir(localSessionsDir(site));
}

export function listSessionsInDir(dir: string): SessionInfo[] {
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
      const raw = JSON.parse(readFileSync(absPath, 'utf8'));
      const session = SessionSchema.parse(raw);
      infos.push({
        absPath,
        filename,
        friendlyTimestamp: friendlySessionTimestamp(filename),
        requestCount: session.requests.length,
        narrationCount: session.narration.length,
        url: session.url,
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
