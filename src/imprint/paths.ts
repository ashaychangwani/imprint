import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';

export function imprintHomeDir(): string {
  const raw = process.env.IMPRINT_HOME ?? pathJoin(homedir(), '.imprint');
  const resolved = pathResolve(raw);
  if (!pathIsAbsolute(resolved)) {
    throw new Error(`IMPRINT_HOME must resolve to an absolute path, got: ${raw}`);
  }
  return resolved;
}

function validatePathSegment(label: string, value: string): void {
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(
      `Invalid ${label}: "${value}". Must not contain path separators or ".." sequences.`,
    );
  }
}

export function localSiteDir(site: string): string {
  validatePathSegment('site name', site);
  return pathJoin(imprintHomeDir(), site);
}

export function localToolDir(site: string, toolName: string): string {
  validatePathSegment('tool name', toolName);
  return pathJoin(localSiteDir(site), toolName);
}

export function localSessionsDir(site: string): string {
  return pathJoin(localSiteDir(site), 'sessions');
}

/** Default output path for `imprint audit <site>` — a per-site report sidecar
 *  (`~/.imprint/<site>/.audit-report.json`). */
export function localAuditReportPath(site: string): string {
  return pathJoin(localSiteDir(site), '.audit-report.json');
}

/** Site-level directory for shared modules reused across a site's tools
 *  (`~/.imprint/<site>/_shared`). Per-tool artifacts import these via the
 *  relative path `../_shared/<name>.ts`. The tool loader and completed-workflow
 *  discovery both skip `_shared` (it has no index.ts). */
export function localSharedDir(site: string): string {
  return pathJoin(localSiteDir(site), '_shared');
}

/** Resolve a shared-module relative path (e.g. "_shared/sign.ts" or "sign.ts")
 *  to an absolute path under the site's shared dir, rejecting traversal. */
export function localSharedModulePath(site: string, relPath: string): string {
  if (relPath.includes('..') || relPath.startsWith('/') || relPath.includes('\\')) {
    throw new Error(`Invalid shared module path: "${relPath}". Must not contain ".." or "/".`);
  }
  const base = relPath.startsWith('_shared/') ? relPath.slice('_shared/'.length) : relPath;
  if (base.includes('/')) {
    throw new Error(
      `Invalid shared module path: "${relPath}". Must be a flat file under _shared/.`,
    );
  }
  return pathJoin(localSharedDir(site), base);
}

export function defaultSessionJsonlPath(site: string, timestamp: string): string {
  return pathJoin(localSessionsDir(site), `${timestamp}.jsonl`);
}

export function resolveLocalSitePath(site: string, value: string): string {
  return pathIsAbsolute(value) ? value : pathResolve(localSiteDir(site), value);
}

export function relativeToLocalSite(site: string, absolutePath: string): string | null {
  let root: string;
  let target: string;
  try {
    root = realpathSync(pathResolve(localSiteDir(site)));
    target = realpathSync(pathResolve(absolutePath));
  } catch {
    root = pathResolve(localSiteDir(site));
    target = pathResolve(absolutePath);
  }
  const relative = pathRelative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !pathIsAbsolute(relative))) {
    return relative;
  }
  return null;
}
