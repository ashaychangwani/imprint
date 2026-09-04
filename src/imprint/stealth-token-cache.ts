/**
 * File-backed stealth-fetch TokenCache, shared across repeated compile-time
 * calls for one tool and rung.
 *
 * Each integration / per-parameter test the compile agent writes runs in its own
 * `bun test` process, and `runWorkflowWithLadder` otherwise mints a fresh stealth
 * token (~12s headless Chromium bootstrap, see stealth-fetch.ts) every time. A
 * multi-test gate run therefore fires a burst of bootstraps against one origin in
 * seconds — exactly the pattern Akamai/PerimeterX flag, which forces the
 * integration test to be waived. Persisting one token in the caller-selected
 * cache directory lets repeated calls reuse a single bootstrap without sharing
 * live browser state with another tool or backend rung.
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
import { type TokenCache, sanitizeSensorHeaders } from './stealth-fetch.ts';

const log = createLog('stealth-cache');

const TOKEN_FILE = '.stealth-token.json';

function tokenPath(siteDir: string): string {
  return pathJoin(siteDir, TOKEN_FILE);
}

/** Load a cached token, or null if absent / malformed / stale. */
export function loadCachedToken(cacheDir: string, maxAgeSeconds: number): TokenCache | null {
  const p = tokenPath(cacheDir);
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
        `cached token in ${cacheDir} is ${Math.round(ageSeconds)}s old (>= ${maxAgeSeconds}s) — ignoring`,
      );
      return null;
    }
    return {
      cookies: raw.cookies,
      sensorHeaders: sanitizeSensorHeaders(raw.sensorHeaders as Record<string, string>),
      bootstrappedAt: raw.bootstrappedAt,
    };
  } catch {
    return null;
  }
}

/** Persist a token to a caller-scoped cache directory. Best-effort. */
export function saveCachedToken(cacheDir: string, token: TokenCache): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const p = tokenPath(cacheDir);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(token)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    log(
      `failed to persist stealth token to ${cacheDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove a cached token (best-effort) — call when a site's teach run ends. */
export function clearCachedToken(cacheDir: string): void {
  try {
    rmSync(tokenPath(cacheDir), { force: true });
  } catch {
    // best-effort
  }
}
