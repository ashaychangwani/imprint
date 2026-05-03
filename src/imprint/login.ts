/**
 * `imprint login <site>` — populate the per-site credential store.
 *
 * v0.1 supports the simplest possible mode: extract cookies + values from
 * an already-captured session.json. The user has just done the workflow
 * inside the recorder; we mine the resulting capture for everything the
 * runtime needs.
 *
 * What gets extracted:
 *   - All cookies present in the END-of-session snapshot, scoped to the
 *     workflow's primary domain
 *   - Per-site values from a small set of well-known patterns (currently:
 *     Discover & Go's patronID returned in the Login POST response)
 *
 * A future v0.2 will offer `--interactive` mode that opens Playwright,
 * waits for the user to log in, and intercepts the auth response live.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import envPaths from 'env-paths';
import type { CredentialStore } from './runtime.ts';
import { type Session, SessionSchema } from './types.ts';

const PATHS = envPaths('imprint', { suffix: '' });

export interface LoginOptions {
  site: string;
  /** Path to a session.json from which to extract credentials. */
  fromSession: string;
  /** Override the persisted credential file location (tests). */
  outPath?: string;
}

export interface LoginResult {
  outPath: string;
  cookieCount: number;
  values: Record<string, string>;
  /** Pattern names that matched and contributed values. */
  matchedExtractors: string[];
}

export function login(opts: LoginOptions): LoginResult {
  const raw = JSON.parse(readFileSync(opts.fromSession, 'utf8'));
  const session: Session = SessionSchema.parse(raw);

  const cookies = collectCookies(session);
  const { values, matched } = extractKnownValues(session);

  const outPath = opts.outPath ?? pathJoin(PATHS.config, 'credentials', `${opts.site}.json`);
  mkdirSync(dirname(outPath), { recursive: true });

  const store: CredentialStore = {
    site: opts.site,
    cookies,
    values,
  };
  writeFileSync(outPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

  return {
    outPath,
    cookieCount: cookies.length,
    values,
    matchedExtractors: matched,
  };
}

/**
 * Pull cookies from the END snapshot (most authoritative — captures everything
 * set during the workflow, including post-login session cookies). Falls back
 * to start snapshot if no end is present.
 */
function collectCookies(session: Session): CredentialStore['cookies'] {
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

/**
 * Apply per-site extractors to the captured requests. Each extractor knows
 * how to recognize a particular auth pattern (URL shape + response body
 * shape) and pull a named value out.
 *
 * Ordered list — first match wins.
 */
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
