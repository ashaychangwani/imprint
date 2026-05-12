/**
 * `availableSitesHint` is the shared "did you mean?" hint used when
 * cron / probe-backends / mcp-server can't find the requested site.
 * The empty/missing-dir branches are easy to regress and the user-
 * visible string format is depended on by error messages.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { availableSitesHint } from '../src/imprint/sites.ts';

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'imprint-sites-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('availableSitesHint', () => {
  it("says the generated asset root doesn't exist when the dir is missing", () => {
    const result = availableSitesHint('/nope/missing-dir', 'whatever');
    expect(result).toMatch(/generated asset root doesn't exist/);
    expect(result).toMatch(/imprint teach/);
  });

  it('says the generated asset root is empty when the dir has no children', () => {
    withTemp((dir) => {
      const result = availableSitesHint(dir, 'whatever');
      expect(result).toMatch(/generated asset root is empty/);
      expect(result).toMatch(/imprint teach/);
    });
  });

  it('lists the directory names when sites exist', () => {
    withTemp((dir) => {
      mkdirSync(pathJoin(dir, 'southwest'));
      mkdirSync(pathJoin(dir, 'discoverandgo'));
      const result = availableSitesHint(dir, 'westsout');
      expect(result).toMatch(/available sites/);
      expect(result).toContain('southwest');
      expect(result).toContain('discoverandgo');
      expect(result).toContain('westsout'); // echoed back so user sees the typo
    });
  });

  it('skips files (only lists directories)', () => {
    withTemp((dir) => {
      mkdirSync(pathJoin(dir, 'real-site'));
      writeFileSync(pathJoin(dir, 'README.md'), '# notes');
      const result = availableSitesHint(dir, 'whatever');
      expect(result).toContain('real-site');
      expect(result).not.toContain('README.md');
    });
  });

  it('always returns a string starting with "→" so callers can concat unconditionally', () => {
    expect(availableSitesHint('/nope/none', 'x').startsWith('→')).toBe(true);
    withTemp((dir) => {
      expect(availableSitesHint(dir, 'x').startsWith('→')).toBe(true);
      mkdirSync(pathJoin(dir, 'site'));
      expect(availableSitesHint(dir, 'x').startsWith('→')).toBe(true);
    });
  });
});
