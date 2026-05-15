/**
 * Maintains the `<imprintHome>/node_modules/imprint` symlink that lets
 * generated tool files (`~/.imprint/<site>/<tool>/index.ts`) resolve
 * `import { ... } from 'imprint/runtime'` via standard Bun module
 * resolution.
 *
 * Self-heals dangling links — a Conductor or git-worktree workspace can
 * vanish out from under the symlink, and re-running `imprint emit` from
 * the new repo location wouldn't fix it (existsSync follows the link, so
 * dangling links report as "not present" and the replace branch was
 * silently skipped). We call this from `discoverTools` so every entry
 * point — mcp-server, cron, probe-backends — repairs the link before
 * trying to import any tool module.
 */

import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path';

/** Repo root for the currently-running imprint install. */
function imprintRepoRoot(): string {
  return pathResolve(import.meta.dir, '..', '..');
}

/**
 * Ensure `<imprintHome>/node_modules/imprint` is a symlink pointing at
 * the running imprint repo. Idempotent: no-op when the link is already
 * correct. Repairs dangling links and links pointing to a different
 * repo path.
 *
 * Refuses to overwrite anything that is not a symlink (so a user who
 * actually `npm i imprint` into their home is left alone).
 *
 * Failures are non-fatal — if we can't write the link, the caller's
 * import will fail with the original ResolveMessage and the user gets
 * the standard error path.
 */
export function ensureImprintRuntimeLink(imprintHome: string): void {
  const repoRoot = imprintRepoRoot();
  const nodeModulesDir = pathJoin(imprintHome, 'node_modules');
  const linkPath = pathJoin(nodeModulesDir, 'imprint');

  try {
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(linkPath);
    } catch {
      // ENOENT — fall through to create.
    }

    if (existing) {
      if (!existing.isSymbolicLink()) {
        // Real file or directory at this path — likely an actual install.
        // Don't touch it.
        return;
      }
      let currentTarget: string;
      try {
        currentTarget = readlinkSync(linkPath);
      } catch {
        currentTarget = '';
      }
      // readlink may return a relative path; resolve it the same way Bun would.
      const resolvedTarget = pathResolve(dirname(linkPath), currentTarget);
      if (resolvedTarget === repoRoot) return; // already correct
      unlinkSync(linkPath);
    }

    mkdirSync(nodeModulesDir, { recursive: true });
    symlinkSync(repoRoot, linkPath, 'dir');
  } catch {
    // Non-fatal — see docstring.
  }
}
