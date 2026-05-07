/** `imprint login` — extract cookies + per-site values from a captured
 *  session.json into the credential manager. */

import { readFileSync } from 'node:fs';
import { getCredentialBackend, upsertManifestEntry } from './credential-store.ts';
import { type Session, SessionSchema } from './types.ts';

interface LoginOptions {
  site: string;
  /** Path to a session.json from which to extract credentials. */
  fromSession: string;
}

interface LoginResult {
  backend: 'keyring' | 'encrypted-file' | 'legacy-json';
  cookieCount: number;
  values: Record<string, string>;
  /** Pattern names that matched and contributed values. */
  matchedExtractors: string[];
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const raw = JSON.parse(readFileSync(opts.fromSession, 'utf8'));
  const session: Session = SessionSchema.parse(raw);

  const cookies = collectCookies(session);
  const { values, matched } = extractKnownValues(session);

  const backend = await getCredentialBackend();
  await backend.setCookies(opts.site, cookies);
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
    values,
    matchedExtractors: matched,
  };
}

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/** End snapshot captures everything set during the workflow (post-login
 *  cookies); fall back to start snapshot if absent. */
function collectCookies(session: Session): RawCookie[] {
  const snaps = session.cookieSnapshots ?? [];
  const end = snaps.find((s) => s.label === 'end');
  const start = snaps.find((s) => s.label === 'start');
  const chosen = end ?? start;
  if (!chosen) return [];
  return chosen.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));
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
