/**
 * File-backed stealth-fetch TokenCache, shared across compile-time `bun test`
 * processes.
 *
 * Each integration / per-parameter test the compile agent writes runs in its own
 * `bun test` process, and `runWorkflowWithLadder` otherwise mints a fresh stealth
 * token (~12s headless Chromium bootstrap, see stealth-fetch.ts) every time. A
 * multi-test gate run therefore fires a burst of bootstraps against one origin in
 * seconds — exactly the pattern Akamai/PerimeterX flag, which forces the
 * integration test to be waived. Persisting one token per site (keyed by the site
 * asset dir) lets sibling processes reuse a single bootstrap, cutting both waivers
 * and compile time.
 *
 * The file holds a live session token. It lives under ~/.imprint/<site>/ (never
 * the repo) and is transient: stale entries are ignored on read, a malformed file
 * is treated as absent, and a token that has gone bad self-heals via the
 * 403 → re-bootstrap path in stealth-fetch.ts. `clearCachedToken` removes it when
 * a site's teach run ends.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createLog } from './log.ts';
import type { TokenCache } from './stealth-fetch.ts';

const log = createLog('stealth-cache');

const TOKEN_FILE = '.stealth-token.json';

function tokenPath(siteDir: string): string {
  return pathJoin(siteDir, TOKEN_FILE);
}

/** Load a cached token for a site dir, or null if absent / malformed / stale. */
export function loadCachedToken(siteDir: string, maxAgeSeconds: number): TokenCache | null {
  const p = tokenPath(siteDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<TokenCache>;
    if (
      !raw ||
      !Array.isArray(raw.cookies) ||
      typeof raw.sensorHeaders !== 'object' ||
      raw.sensorHeaders === null ||
      typeof raw.bootstrappedAt !== 'number'
    ) {
      return null;
    }
    const ageSeconds = (Date.now() - raw.bootstrappedAt) / 1000;
    if (ageSeconds >= maxAgeSeconds) {
      log(
        `cached token in ${siteDir} is ${Math.round(ageSeconds)}s old (>= ${maxAgeSeconds}s) — ignoring`,
      );
      return null;
    }
    return {
      cookies: raw.cookies,
      sensorHeaders: raw.sensorHeaders,
      bootstrappedAt: raw.bootstrappedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a token for a site dir (atomic temp + rename). Best-effort. */
export function saveCachedToken(siteDir: string, token: TokenCache): void {
  try {
    mkdirSync(siteDir, { recursive: true });
    const p = tokenPath(siteDir);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(token)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    log(
      `failed to persist stealth token to ${siteDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove a cached token (best-effort) — call when a site's teach run ends. */
export function clearCachedToken(siteDir: string): void {
  try {
    rmSync(tokenPath(siteDir), { force: true });
  } catch {
    // best-effort
  }
}
