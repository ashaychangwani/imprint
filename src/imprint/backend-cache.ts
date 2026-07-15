import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve as pathResolve } from 'node:path';
import { type BackendsCache, BackendsCacheSchema, WorkflowSchema } from './types.ts';

export type BackendsCacheStatus =
  | {
      status: 'missing';
      path: string | null;
      remediation: string;
    }
  | {
      status: 'ok';
      path: string;
      cache: BackendsCache;
    }
  | {
      status: 'stale';
      path: string;
      cache: BackendsCache;
      reason: string;
      remediation: string;
    }
  | {
      status: 'invalid';
      path: string;
      reason: string;
      remediation: string;
    };

function invalidPreferredOrderReason(cache: BackendsCache): string | null {
  for (const backend of cache.preferredOrder) {
    const result = cache.results[backend];
    if (backend === 'playbook' && result?.outcome !== 'ok') {
      return 'preferredOrder includes playbook without a successful playbook result';
    }
    if (result && result.outcome !== 'ok') {
      return `preferredOrder includes ${backend} with ${result.outcome} result`;
    }
  }
  return null;
}

function workflowHashSync(workflowJson: string): string {
  return createHash('sha256')
    .update(JSON.stringify(WorkflowSchema.parse(JSON.parse(workflowJson))))
    .digest('hex');
}

function backendsCacheRemediation(site: string, toolName?: string): string {
  return toolName
    ? `imprint probe-backends ${site} --tool ${toolName}`
    : `imprint probe-backends ${site}`;
}

function toolDirName(toolDir?: string): string | undefined {
  return toolDir ? basename(toolDir) : undefined;
}

/** Read backends.json with status information. Runtime can still fall back to
 *  the default ladder, while status commands can explain why a cache was not
 *  usable. */
export function loadBackendsCacheStatus(
  site: string,
  _assetRoot: string,
  toolDir?: string,
  opts: { warn?: boolean; toolName?: string } = {},
): BackendsCacheStatus {
  const remediation = backendsCacheRemediation(site, opts.toolName ?? toolDirName(toolDir));
  if (!toolDir) return { status: 'missing', path: null, remediation };
  const path = pathResolve(toolDir, 'backends.json');
  if (!existsSync(path)) return { status: 'missing', path, remediation };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = BackendsCacheSchema.parse(raw);
    const invalidPreferredReason = invalidPreferredOrderReason(parsed);
    if (invalidPreferredReason) {
      if (opts.warn !== false) {
        process.stderr.write(
          `[imprint] backends.json at ${path} has unsafe preferred backends — ignoring (run \`${remediation}\` to regenerate): ${invalidPreferredReason}\n`,
        );
      }
      return { status: 'invalid', path, reason: invalidPreferredReason, remediation };
    }
    if (parsed.schemaVersion && parsed.schemaVersion >= 2 && parsed.workflowHash) {
      const workflowPath = pathResolve(toolDir, 'workflow.json');
      if (existsSync(workflowPath)) {
        const currentHash = workflowHashSync(readFileSync(workflowPath, 'utf8'));
        if (currentHash !== parsed.workflowHash) {
          const reason = 'workflow hash changed';
          if (opts.warn !== false) {
            process.stderr.write(
              `[imprint] backends.json at ${path} is stale for current workflow — ignoring (run \`${remediation}\` to regenerate)\n`,
            );
          }
          return { status: 'stale', path, cache: parsed, reason, remediation };
        }
      }
    }
    return { status: 'ok', path, cache: parsed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.warn !== false) {
      process.stderr.write(
        `[imprint] backends.json at ${path} failed to parse — ignoring (run \`${remediation}\` to regenerate): ${reason}\n`,
      );
    }
    return { status: 'invalid', path, reason, remediation };
  }
}

/** Read backends.json. Returns null on missing/malformed — runtime
 *  falls back to the default ladder; a stale cache must never break cron. */
export function loadBackendsCache(
  site: string,
  _assetRoot: string,
  toolDir?: string,
): BackendsCache | null {
  const status = loadBackendsCacheStatus(site, _assetRoot, toolDir);
  return status.status === 'ok' ? status.cache : null;
}
