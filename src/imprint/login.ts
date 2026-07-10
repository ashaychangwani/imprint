/** `imprint login` — extract cookies + per-site values from a captured
 *  session.json into the credential manager. */

import { readFileSync, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type StorageRecord,
  getCredentialBackend,
  setManifestStorageKeys,
  upsertManifestEntry,
} from './credential-store.ts';
import { localSiteDir } from './paths.ts';
import { captureHeader, captureValueMatches, jsonpath } from './request-capture.ts';
import { type RequestCapture, type Session, SessionSchema, WorkflowSchema } from './types.ts';

interface LoginOptions {
  site: string;
  /** Path to a session.json from which to extract credentials. */
  fromSession: string;
}

interface LoginResult {
  backend: 'keyring' | 'encrypted-file' | 'legacy-json';
  cookieCount: number;
  storageCount: number;
  values: Record<string, string>;
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const raw = JSON.parse(readFileSync(opts.fromSession, 'utf8'));
  const session: Session = SessionSchema.parse(raw);

  const cookies = collectCookies(session);
  const storage = collectStorage(session);
  const values = extractCredentials(opts.site, session);

  const backend = await getCredentialBackend();
  await backend.setCookies(opts.site, cookies);
  if (backend.setStorage) {
    await backend.setStorage(opts.site, storage);
    setManifestStorageKeys(
      opts.site,
      storage.map((s) => ({ origin: s.origin, kind: s.kind, key: s.key })),
    );
  }
  for (const [name, value] of Object.entries(values)) {
    await backend.setSecret(opts.site, name, value);
    upsertManifestEntry(opts.site, {
      name,
      kind: 'opaque',
      description: 'Captured from the recorded login response (authConfig.sessionCapture)',
    });
  }

  return {
    backend: backend.id,
    cookieCount: cookies.length,
    storageCount: storage.length,
    values,
  };
}

/** End snapshot captures everything set during the workflow (post-login
 *  cookies); fall back to start snapshot if absent. */
function collectCookies(session: Session) {
  const snaps = session.cookieSnapshots ?? [];
  const end = snaps.find((s) => s.label === 'end');
  const start = snaps.find((s) => s.label === 'start');
  const chosen = end ?? start;
  if (!chosen) return [];
  return chosen.cookies.map((c) => ({ ...c }));
}

function collectStorage(session: Session): StorageRecord[] {
  const snaps = session.storageSnapshots ?? [];
  const end = snaps.filter((s) => s.label === 'end');
  const chosen = end.length > 0 ? end : snaps.filter((s) => s.label === 'start');
  const byKey = new Map<string, StorageRecord>();
  for (const snap of chosen) {
    for (const [key, value] of Object.entries(snap.localStorage ?? {})) {
      byKey.set(`${snap.origin}\0localStorage\0${key}`, {
        origin: snap.origin,
        kind: 'localStorage',
        key,
        value,
      });
    }
  }
  return Array.from(byKey.values());
}

/** Gather every durable `authConfig.sessionCapture` declared by the site's
 *  compiled workflows (`~/.imprint/<site>/<tool>/workflow.json`). Deduped by
 *  name (first workflow to declare a capture wins). Returns `[]` when the site
 *  has no compiled tools or none declare captures — there is no per-site code,
 *  so a new authed site works as soon as its workflow declares what it needs. */
function collectSessionCaptures(site: string): RequestCapture[] {
  const siteDir = localSiteDir(site);
  let entries: string[];
  try {
    entries = readdirSync(siteDir);
  } catch {
    return [];
  }
  const captures: RequestCapture[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let workflow: ReturnType<typeof WorkflowSchema.parse>;
    try {
      workflow = WorkflowSchema.parse(
        JSON.parse(readFileSync(pathJoin(siteDir, entry, 'workflow.json'), 'utf8')),
      );
    } catch {
      continue; // not a tool dir, unreadable, or not a valid workflow
    }
    for (const capture of workflow.authConfig?.sessionCapture ?? []) {
      if (seen.has(capture.name)) continue;
      seen.add(capture.name);
      captures.push(capture);
    }
  }
  return captures;
}

/** Resolve one declared capture against the recorded session — taking the value
 *  from the first response in which it resolves — using the SAME capture helpers
 *  the runtime uses, so a locator behaves identically here and during replay.
 *  Cookie-source captures are skipped (cookies are persisted wholesale by
 *  `collectCookies`). */
function resolveCapture(session: Session, capture: RequestCapture): string | undefined {
  for (const req of session.requests) {
    const response = req.response;
    if (!response) continue;
    const body = response.body ?? '';
    let value: unknown;
    switch (capture.source) {
      case 'json': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          continue; // this response isn't JSON; try the next one
        }
        value = jsonpath(parsed, capture.path);
        break;
      }
      case 'response_header':
        value = captureHeader(new Headers(response.headers ?? {}), capture.header, capture.mode);
        break;
      case 'text_regex': {
        const match = body.match(new RegExp(capture.pattern));
        value = match?.[capture.group ?? 1];
        break;
      }
      case 'cookie':
        continue; // cookies are persisted by collectCookies, not as secrets here
    }
    if (captureValueMatches(value, capture.equals)) {
      return Array.isArray(value) ? value.join(',') : String(value);
    }
  }
  return undefined;
}

/** Resolve all of a site's declared `sessionCapture` credential slots from the
 *  recording. Fully generic — no per-site logic. Exported for tests. */
export function extractCredentials(site: string, session: Session): Record<string, string> {
  const values: Record<string, string> = {};
  for (const capture of collectSessionCaptures(site)) {
    const value = resolveCapture(session, capture);
    if (value !== undefined) values[capture.name] = value;
  }
  return values;
}
