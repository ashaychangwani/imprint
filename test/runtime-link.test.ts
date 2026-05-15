/**
 * Tests for `ensureImprintRuntimeLink` — the self-healer that maintains
 * the `<imprintHome>/node_modules/imprint` symlink generated tools rely
 * on for `import 'imprint/runtime'` resolution.
 *
 * Regression coverage for the dangling-symlink case (Conductor /
 * worktree workspaces vanish out from under the link, and the previous
 * existsSync-based replacer silently failed to repair it).
 */

import { describe, expect, it } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { ensureImprintRuntimeLink } from '../src/imprint/runtime-link.ts';

const REPO_ROOT = pathResolve(import.meta.dir, '..');

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-runtime-link-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ensureImprintRuntimeLink', () => {
  it('creates the symlink when node_modules does not exist', () => {
    withTempDir((home) => {
      ensureImprintRuntimeLink(home);
      const linkPath = pathJoin(home, 'node_modules', 'imprint');
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(REPO_ROOT);
    });
  });

  it('repairs a dangling symlink', () => {
    withTempDir((home) => {
      const nm = pathJoin(home, 'node_modules');
      mkdirSync(nm, { recursive: true });
      const linkPath = pathJoin(nm, 'imprint');
      const ghost = pathJoin(home, 'workspace-that-was-deleted');
      symlinkSync(ghost, linkPath, 'dir');

      ensureImprintRuntimeLink(home);

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(REPO_ROOT);
    });
  });

  it('repoints a symlink that targets a different valid directory', () => {
    withTempDir((home) => {
      const nm = pathJoin(home, 'node_modules');
      mkdirSync(nm, { recursive: true });
      const linkPath = pathJoin(nm, 'imprint');
      const otherRepo = pathJoin(home, 'other-imprint-repo');
      mkdirSync(otherRepo, { recursive: true });
      symlinkSync(otherRepo, linkPath, 'dir');

      ensureImprintRuntimeLink(home);

      expect(readlinkSync(linkPath)).toBe(REPO_ROOT);
    });
  });

  it('is a no-op when the link already points at the running repo', () => {
    withTempDir((home) => {
      ensureImprintRuntimeLink(home);
      const linkPath = pathJoin(home, 'node_modules', 'imprint');
      const before = lstatSync(linkPath);
      ensureImprintRuntimeLink(home);
      const after = lstatSync(linkPath);
      // ctime changes if the link was recreated; verify it stayed put.
      expect(after.ctimeMs).toBe(before.ctimeMs);
    });
  });

  it('refuses to overwrite a real directory at node_modules/imprint', () => {
    withTempDir((home) => {
      // Simulate a user who actually `npm i imprint` into their home.
      const realPkg = pathJoin(home, 'node_modules', 'imprint');
      mkdirSync(realPkg, { recursive: true });
      writeFileSync(pathJoin(realPkg, 'package.json'), '{}', 'utf8');

      ensureImprintRuntimeLink(home);

      expect(lstatSync(realPkg).isDirectory()).toBe(true);
      expect(lstatSync(realPkg).isSymbolicLink()).toBe(false);
    });
  });
});
