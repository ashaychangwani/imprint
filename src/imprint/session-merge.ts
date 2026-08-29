/**
 * Multi-session merge for `imprint teach`.
 *
 * When a user records a new session, they can combine it with past recordings
 * of the same site so triage and candidate detection see the full picture.
 * The merge produces a single valid Session object that the rest of the
 * pipeline consumes unchanged.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { localSessionsDir } from './paths.ts';
import { friendlySessionTimestamp } from './teach-state.ts';
import { type Session, SessionSchema } from './types.ts';

const Sha256IdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CombinedSessionManifestSchema = z.object({
  version: z.literal(1),
  combinedSha256: Sha256IdSchema,
  sourceSetSha256: Sha256IdSchema,
  sourceSha256: z.array(Sha256IdSchema),
});

type CombinedSessionManifest = z.infer<typeof CombinedSessionManifestSchema>;

interface LoadedRawSession {
  session: Session;
  sha256: string;
}

interface ValidCombinedSession {
  absPath: string;
  sha256: string;
}

export interface TeachingRecordingResolution {
  /** Absolute path to the valid combined recording selected for a fresh teach. */
  path: string;
  /** Number of raw recording contents represented by the aggregate. */
  sourceCount: number;
  /** Digest of the source-content digest list, when provenance is available. */
  sourceSetSha256?: string;
  /** True only when this call had to write a new aggregate. */
  refreshed: boolean;
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

/**
 * Select the current aggregate recording for a fresh teach run.
 *
 * Freshness is based on hashes of the valid raw recording contents, not file
 * modification times. An aggregate is reused only when its private sidecar
 * proves that it represents the exact current source set and that the
 * aggregate itself has not changed. The sidecar contains hashes and counts,
 * never captured request, cookie, storage, or narration values.
 */
export function resolveTeachingRecording(site: string): TeachingRecordingResolution | undefined {
  const rawSessions = loadRawSessions(site);
  const latestCombined = findLatestValidCombinedSession(site);

  // A combined recording can remain useful after its source files have been
  // moved elsewhere. There is nothing to refresh in that case, so select the
  // newest valid aggregate instead of failing the teach before it starts.
  if (rawSessions.length === 0) {
    if (!latestCombined) return undefined;
    const manifest = readCombinedSessionManifest(latestCombined);
    return {
      path: latestCombined.absPath,
      sourceCount: manifest?.sourceSha256.length ?? 0,
      ...(manifest ? { sourceSetSha256: manifest.sourceSetSha256 } : {}),
      refreshed: false,
    };
  }

  const sourceSha256 = rawSessions.map((source) => source.sha256).sort();
  const sourceSetSha256 = digestSourceSet(sourceSha256);
  if (latestCombined) {
    const manifest = readCombinedSessionManifest(latestCombined);
    if (
      manifest?.combinedSha256 === latestCombined.sha256 &&
      manifest.sourceSetSha256 === sourceSetSha256 &&
      stringArraysEqual(manifest.sourceSha256, sourceSha256)
    ) {
      return {
        path: latestCombined.absPath,
        sourceCount: sourceSha256.length,
        sourceSetSha256,
        refreshed: false,
      };
    }
  }

  const combined = mergeSessions(rawSessions.map((source) => source.session));
  const combinedPath = writeCombinedSession(site, combined);
  const combinedSha256 = sha256Id(readFileSync(combinedPath));
  writeCombinedSessionManifest(combinedPath, {
    version: 1,
    combinedSha256,
    sourceSetSha256,
    sourceSha256,
  });
  return {
    path: combinedPath,
    sourceCount: sourceSha256.length,
    sourceSetSha256,
    refreshed: true,
  };
}

/** Compatibility-shaped helper for callers that only need the recording path. */
export function resolveLatestCombinedSession(site: string): string | undefined {
  return resolveTeachingRecording(site)?.path;
}

function loadRawSessions(site: string): LoadedRawSession[] {
  const loaded: LoadedRawSession[] = [];
  for (const info of listSiteSessions(site)) {
    try {
      const contents = readFileSync(info.absPath);
      loaded.push({
        session: SessionSchema.parse(JSON.parse(contents.toString('utf8'))),
        sha256: sha256Id(contents),
      });
    } catch {
      // The file may have changed since listSiteSessions validated it. Ignore
      // that unstable input; a later fresh run can include it once valid.
    }
  }
  return loaded;
}

function findLatestValidCombinedSession(site: string): ValidCombinedSession | undefined {
  const sessionDir = localSessionsDir(site);
  if (!existsSync(sessionDir)) return undefined;

  const filenames = readdirSync(sessionDir)
    .filter((filename) => filename.startsWith('combined-') && filename.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left));

  for (const filename of filenames) {
    const absPath = pathJoin(sessionDir, filename);
    try {
      const contents = readFileSync(absPath);
      SessionSchema.parse(JSON.parse(contents.toString('utf8')));
      return { absPath, sha256: sha256Id(contents) };
    } catch {
      // Malformed aggregates are diagnostic evidence, not candidates. Keep
      // looking for the latest valid recording without deleting anything.
    }
  }
  return undefined;
}

function manifestPathFor(combinedPath: string): string {
  // Do not use a .json suffix: legacy session discovery treats every JSON
  // file in this directory as a recording candidate.
  return `${combinedPath}.sources-manifest`;
}

function readCombinedSessionManifest(
  combined: ValidCombinedSession,
): CombinedSessionManifest | undefined {
  try {
    const parsed = CombinedSessionManifestSchema.parse(
      JSON.parse(readFileSync(manifestPathFor(combined.absPath), 'utf8')),
    );
    if (parsed.combinedSha256 !== combined.sha256) return undefined;
    if (parsed.sourceSetSha256 !== digestSourceSet(parsed.sourceSha256)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCombinedSessionManifest(
  combinedPath: string,
  manifest: CombinedSessionManifest,
): void {
  const manifestPath = manifestPathFor(combinedPath);
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, manifestPath);
}

function digestSourceSet(sourceSha256: string[]): string {
  const hash = createHash('sha256');
  hash.update('imprint-combined-session-sources-v1\0');
  for (const digest of sourceSha256) hash.update(`${digest}\0`);
  return `sha256:${hash.digest('hex')}`;
}

function sha256Id(contents: Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
