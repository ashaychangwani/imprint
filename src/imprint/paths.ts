import { homedir } from 'node:os';
import {
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
} from 'node:path';

function imprintHomeDir(): string {
  return pathResolve(process.env.IMPRINT_HOME ?? pathJoin(homedir(), '.imprint'));
}

export function localSiteDir(site: string): string {
  return pathJoin(imprintHomeDir(), site);
}

export function localSessionsDir(site: string): string {
  return pathJoin(localSiteDir(site), 'sessions');
}

export function defaultSessionJsonlPath(site: string, timestamp: string): string {
  return pathJoin(localSessionsDir(site), `${timestamp}.jsonl`);
}

export function resolveLocalSitePath(site: string, value: string): string {
  return pathIsAbsolute(value) ? value : pathResolve(localSiteDir(site), value);
}

export function relativeToLocalSite(site: string, absolutePath: string): string | null {
  const root = pathResolve(localSiteDir(site));
  const target = pathResolve(absolutePath);
  const relative = pathRelative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !pathIsAbsolute(relative))) {
    return relative;
  }
  return null;
}
