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
import { recordedRequestMatchesWorkflow } from './recording-request.ts';
import { captureHeader, captureValueMatches, jsonpath } from './request-capture.ts';
import {
  type RequestCapture,
  type Session,
  SessionSchema,
  type WorkflowRequest,
  WorkflowSchema,
  persistedCaptureName,
} from './types.ts';

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
      description: 'Captured from the recorded login response (authConfig.persist)',
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
  const byOrigin = new Map<
    string,
    { start?: (typeof snaps)[number]; end?: (typeof snaps)[number] }
  >();
  for (const snap of snaps) {
    if (snap.label === 'manual') continue;
    const candidates = byOrigin.get(snap.origin) ?? {};
    const current = candidates[snap.label];
    if (!current || snap.timestamp >= current.timestamp) candidates[snap.label] = snap;
    byOrigin.set(snap.origin, candidates);
  }
  const chosen: (typeof snaps)[number][] = [];
  for (const { start, end } of byOrigin.values()) {
    const snap = end ?? start;
    if (snap) chosen.push(snap);
  }
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
    for (const [key, value] of Object.entries(snap.sessionStorage ?? {})) {
      byKey.set(`${snap.origin}\0sessionStorage\0${key}`, {
        origin: snap.origin,
        kind: 'sessionStorage',
        key,
        value,
      });
    }
  }
  return Array.from(byKey.values());
}

/** Gather the request captures named by each auth program's `persist` list. */
interface SessionCaptureBinding {
  credentialName: string;
  capture: RequestCapture;
  recordingRequestSeq?: number;
  method: string;
  url: string;
  body?: string;
}

function collectSessionCaptures(site: string): SessionCaptureBinding[] {
  const siteDir = localSiteDir(site);
  let entries: string[];
  try {
    entries = readdirSync(siteDir);
  } catch {
    return [];
  }
  const captures: SessionCaptureBinding[] = [];
  const byName = new Map<string, SessionCaptureBinding>();
  const addCapture = (
    credentialName: string,
    capture: RequestCapture,
    request: WorkflowRequest,
  ): void => {
    const binding = {
      credentialName,
      capture,
      recordingRequestSeq: request.recordingRequestSeq,
      method: request.method,
      url: request.url,
      body: request.body,
    };
    const existing = byName.get(credentialName);
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
      throw new Error(
        `Persisted credential ${JSON.stringify(credentialName)} has conflicting producing requests. Regenerate the auth workflow with unique bindings.`,
      );
    }
    if (!existing) {
      byName.set(credentialName, binding);
      captures.push(binding);
    }
  };
  for (const entry of entries) {
    let workflow: ReturnType<typeof WorkflowSchema.parse>;
    try {
      workflow = WorkflowSchema.parse(
        JSON.parse(readFileSync(pathJoin(siteDir, entry, 'workflow.json'), 'utf8')),
      );
    } catch {
      continue; // not a tool dir, unreadable, or not a valid workflow
    }
    const config = workflow.authConfig;
    if (!config) continue;
    const persistedByCapture = new Map<string, string[]>();
    for (const credentialName of config.persist) {
      const captureName = persistedCaptureName(config, credentialName);
      const names = persistedByCapture.get(captureName) ?? [];
      names.push(credentialName);
      persistedByCapture.set(captureName, names);
    }
    for (const request of workflow.requests) {
      for (const capture of request.captures ?? []) {
        for (const credentialName of persistedByCapture.get(capture.name) ?? []) {
          addCapture(credentialName, capture, request);
        }
      }
    }
    for (const action of Object.values(workflow.authConfig?.actions ?? {})) {
      for (const step of action.steps) {
        const capture = step.repeat?.until;
        const request = workflow.requests[step.request];
        if (capture && request) {
          for (const credentialName of persistedByCapture.get(capture.name) ?? []) {
            addCapture(credentialName, capture, request);
          }
        }
      }
    }
  }
  return captures;
}

/** Resolve one declared capture against the recorded session — taking the value
 *  from the first response in which it resolves — using the SAME capture helpers
 *  the runtime uses, so a locator behaves identically here and during replay.
 *  Cookie-source captures are skipped (cookies are persisted wholesale by
 *  `collectCookies`). */
function resolveCapture(session: Session, binding: SessionCaptureBinding): string | undefined {
  const workflowRequest = { method: binding.method, url: binding.url, body: binding.body };
  const exact =
    binding.recordingRequestSeq === undefined
      ? undefined
      : session.requests.find(
          (request) =>
            request.seq === binding.recordingRequestSeq &&
            recordedRequestMatchesWorkflow(request, workflowRequest),
        );
  const fallback = session.requests
    .filter(
      (request) => request !== exact && recordedRequestMatchesWorkflow(request, workflowRequest),
    )
    .reverse();
  const requests = exact ? [exact, ...fallback] : fallback;
  for (const req of requests) {
    const response = req.response;
    if (!response) continue;
    const body = response.body ?? '';
    let value: unknown;
    const { capture } = binding;
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
        value =
          capture.header.toLowerCase() === 'x-imprint-final-url'
            ? req.url
            : captureHeader(new Headers(response.headers ?? {}), capture.header, capture.mode);
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

/** Resolve all captures selected by a site's `authConfig.persist` list from the
 *  recording. Fully generic — no per-site logic. Exported for tests. */
export function extractCredentials(site: string, session: Session): Record<string, string> {
  const values: Record<string, string> = {};
  for (const binding of collectSessionCaptures(site)) {
    const value = resolveCapture(session, binding);
    if (value !== undefined) values[binding.credentialName] = value;
  }
  return values;
}
