/** `imprint login` — extract cookies + per-site values from a captured
 *  session.json into the credential manager. */

import { readFileSync } from 'node:fs';
import {
  type StorageRecord,
  getCredentialBackend,
  setManifestStorageKeys,
  upsertManifestEntry,
} from './credential-store.ts';
import { type Session, SessionSchema } from './types.ts';

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
  /** Pattern names that matched and contributed values. */
  matchedExtractors: string[];
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const raw = JSON.parse(readFileSync(opts.fromSession, 'utf8'));
  const session: Session = SessionSchema.parse(raw);

  const cookies = collectCookies(session);
  const storage = collectStorage(session);
  const { values, matched } = extractKnownValues(session);

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
      description: `Extracted via ${matched.join('+') || 'login'}`,
    });
  }

  return {
    backend: backend.id,
    cookieCount: cookies.length,
    storageCount: storage.length,
    values,
    matchedExtractors: matched,
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

/** Per-site extractors pull named values out of recognized auth shapes;
 *  ordered list, first match wins. */
const EXTRACTORS: Array<{
  name: string;
  match: (session: Session) => Record<string, string> | null;
}> = [
  {
    name: 'discoverandgo:Login',
    // D&G's Login POST returns a JSON object with patronID.
    match: (session) => {
      const loginReq = session.requests.find(
        (r) =>
          r.method === 'POST' &&
          r.url.includes('epass_server.php') &&
          (r.body?.includes('method=Login') ?? false),
      );
      if (!loginReq?.response?.body) return null;
      try {
        const body = JSON.parse(loginReq.response.body) as {
          patronID?: string;
          session?: string;
          patronEmail?: string;
        };
        const out: Record<string, string> = {};
        if (body.patronID) out.patron_id = body.patronID;
        if (body.session) out.session_id = body.session;
        if (body.patronEmail) out.patron_email = body.patronEmail;
        return Object.keys(out).length ? out : null;
      } catch {
        return null;
      }
    },
  },
  {
    name: 'southwest:security_token',
    // Southwest's POST /api/security/v4/security/token returns auth tokens
    // and account info we want available to follow-up requests.
    match: (session) => {
      const loginReq = session.requests.find(
        (r) =>
          r.method === 'POST' &&
          r.url.includes('/api/security/v4/security/token') &&
          (r.body?.includes('username=') ?? false),
      );
      if (!loginReq?.response?.body) return null;
      try {
        const body = JSON.parse(loginReq.response.body) as Record<string, unknown>;
        const out: Record<string, string> = {};
        const accountNumber = body['customers.userInformation.accountNumber'];
        const primaryEmail = body['customers.userInformation.primaryEmail'];
        if (typeof accountNumber === 'string') out.account_number = accountNumber;
        if (typeof primaryEmail === 'string') out.primary_email = primaryEmail;
        return Object.keys(out).length ? out : null;
      } catch {
        return null;
      }
    },
  },
];

function extractKnownValues(session: Session): {
  values: Record<string, string>;
  matched: string[];
} {
  const values: Record<string, string> = {};
  const matched: string[] = [];
  for (const ext of EXTRACTORS) {
    const v = ext.match(session);
    if (v) {
      Object.assign(values, v);
      matched.push(ext.name);
    }
  }
  return { values, matched };
}
