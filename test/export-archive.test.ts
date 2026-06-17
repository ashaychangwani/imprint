import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { exportArchive, importArchive } from '../src/imprint/export-archive.ts';

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(pathJoin(tmpdir(), 'imprint-export-test-'));
  originalHome = process.env.IMPRINT_HOME;
  process.env.IMPRINT_HOME = tempHome;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.IMPRINT_HOME = originalHome;
  } else {
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not set to undefined
    delete process.env.IMPRINT_HOME;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

function seedSite(site: string, tools: string[], opts?: { shared?: boolean }): void {
  const siteDir = pathJoin(tempHome, site);
  for (const tool of tools) {
    const toolDir = pathJoin(siteDir, tool);
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(pathJoin(toolDir, 'index.ts'), 'export const WORKFLOW = {};');
    writeFileSync(pathJoin(toolDir, 'workflow.json'), JSON.stringify({ toolName: tool, site }));
    writeFileSync(pathJoin(toolDir, 'playbook.yaml'), 'steps: []');
    writeFileSync(pathJoin(toolDir, 'package.json'), `{"name":"${tool}"}`);
  }
  if (opts?.shared) {
    const sharedDir = pathJoin(siteDir, '_shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(pathJoin(sharedDir, 'helpers.ts'), 'export function help() {}');
    writeFileSync(pathJoin(sharedDir, 'package.json'), '{"name":"_shared"}');
    writeFileSync(pathJoin(sharedDir, 'bun.lock'), 'lockfile');
    mkdirSync(pathJoin(sharedDir, 'node_modules', 'dep'), { recursive: true });
  }
  // ephemeral files that should be excluded
  mkdirSync(pathJoin(siteDir, 'sessions'), { recursive: true });
  writeFileSync(pathJoin(siteDir, 'sessions', 'recording.json'), '{}');
  writeFileSync(pathJoin(siteDir, '.teach-state.json'), '{}');
  writeFileSync(pathJoin(siteDir, '.audit-report.json'), '{}');
}

describe('exportArchive', () => {
  it('exports a single site', async () => {
    seedSite('testsite', ['tool_a', 'tool_b']);
    const archivePath = pathJoin(tempHome, 'out.tar.gz');
    const result = await exportArchive({ sites: ['testsite'], out: archivePath });

    expect(result.archivePath).toBe(archivePath);
    expect(result.sites).toEqual([{ name: 'testsite', tools: ['tool_a', 'tool_b'] }]);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(existsSync(archivePath)).toBe(true);
  });

  it('exports multiple sites', async () => {
    seedSite('alpha', ['search']);
    seedSite('beta', ['find', 'list']);
    const archivePath = pathJoin(tempHome, 'multi.tar.gz');
    const result = await exportArchive({ sites: ['alpha', 'beta'], out: archivePath });

    expect(result.sites).toHaveLength(2);
    expect(result.sites[0]?.tools).toEqual(['search']);
    expect(result.sites[1]?.tools).toEqual(['find', 'list']);
  });

  it('throws on unknown site', async () => {
    await expect(
      exportArchive({ sites: ['nonexistent'], out: pathJoin(tempHome, 'x.tar.gz') }),
    ).rejects.toThrow(/not found/i);
  });

  it('throws on site with no tools', async () => {
    const siteDir = pathJoin(tempHome, 'empty');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(pathJoin(siteDir, '.teach-state.json'), '{}');

    await expect(
      exportArchive({ sites: ['empty'], out: pathJoin(tempHome, 'x.tar.gz') }),
    ).rejects.toThrow(/no tools/i);
  });
});

describe('importArchive', () => {
  it('round-trips a single site', async () => {
    seedSite('roundtrip', ['my_tool'], { shared: true });
    const archivePath = pathJoin(tempHome, 'rt.tar.gz');
    await exportArchive({ sites: ['roundtrip'], out: archivePath });

    // wipe the original
    rmSync(pathJoin(tempHome, 'roundtrip'), { recursive: true });
    expect(existsSync(pathJoin(tempHome, 'roundtrip'))).toBe(false);

    const result = await importArchive({ archivePath });

    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.name).toBe('roundtrip');
    expect(result.sites[0]?.skipped).toBe(false);
    expect(existsSync(pathJoin(tempHome, 'roundtrip', 'my_tool', 'index.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'roundtrip', 'my_tool', 'workflow.json'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'roundtrip', 'my_tool', 'playbook.yaml'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'roundtrip', '_shared', 'helpers.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'roundtrip', '_shared', 'package.json'))).toBe(true);
  });

  it('excludes ephemeral files from archive', async () => {
    seedSite('cleansite', ['searcher']);
    const archivePath = pathJoin(tempHome, 'clean.tar.gz');
    await exportArchive({ sites: ['cleansite'], out: archivePath });

    rmSync(pathJoin(tempHome, 'cleansite'), { recursive: true });
    await importArchive({ archivePath });

    expect(existsSync(pathJoin(tempHome, 'cleansite', 'sessions'))).toBe(false);
    expect(existsSync(pathJoin(tempHome, 'cleansite', '.teach-state.json'))).toBe(false);
    expect(existsSync(pathJoin(tempHome, 'cleansite', '.audit-report.json'))).toBe(false);
  });

  it('excludes shared bun.lock and node_modules', async () => {
    seedSite('sharedsite', ['tool1'], { shared: true });
    const archivePath = pathJoin(tempHome, 'shared.tar.gz');
    await exportArchive({ sites: ['sharedsite'], out: archivePath });

    rmSync(pathJoin(tempHome, 'sharedsite'), { recursive: true });
    await importArchive({ archivePath });

    expect(existsSync(pathJoin(tempHome, 'sharedsite', '_shared', 'helpers.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'sharedsite', '_shared', 'bun.lock'))).toBe(false);
    expect(existsSync(pathJoin(tempHome, 'sharedsite', '_shared', 'node_modules'))).toBe(false);
  });

  it('skips existing site without --force', async () => {
    seedSite('existing', ['tool1']);
    const archivePath = pathJoin(tempHome, 'existing.tar.gz');
    await exportArchive({ sites: ['existing'], out: archivePath });

    const result = await importArchive({ archivePath });
    expect(result.sites[0]?.skipped).toBe(true);
  });

  it('overwrites with --force', async () => {
    seedSite('overwrite', ['tool1']);
    const archivePath = pathJoin(tempHome, 'overwrite.tar.gz');
    await exportArchive({ sites: ['overwrite'], out: archivePath });

    // modify the original to verify overwrite works
    writeFileSync(pathJoin(tempHome, 'overwrite', 'tool1', 'index.ts'), 'MODIFIED');

    const result = await importArchive({ archivePath, force: true });
    expect(result.sites[0]?.skipped).toBe(false);

    const content = readFileSync(pathJoin(tempHome, 'overwrite', 'tool1', 'index.ts'), 'utf8');
    expect(content).toBe('export const WORKFLOW = {};');
  });

  it('removes stale tools on --force overwrite', async () => {
    seedSite('stale', ['new_tool']);
    const archivePath = pathJoin(tempHome, 'stale.tar.gz');
    await exportArchive({ sites: ['stale'], out: archivePath });

    // add a stale tool that the archive doesn't include
    const staleDir = pathJoin(tempHome, 'stale', 'old_tool');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(pathJoin(staleDir, 'index.ts'), 'stale');

    await importArchive({ archivePath, force: true });

    expect(existsSync(pathJoin(tempHome, 'stale', 'new_tool', 'index.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'stale', 'old_tool'))).toBe(false);
  });

  it('throws on missing archive', async () => {
    await expect(
      importArchive({ archivePath: '/tmp/does-not-exist-12345.tar.gz' }),
    ).rejects.toThrow(/not found/i);
  });

  it('throws on archive without manifest', async () => {
    const bogus = pathJoin(tempHome, 'bogus.tar.gz');
    const bogusDir = mkdtempSync(pathJoin(tmpdir(), 'bogus-'));
    writeFileSync(pathJoin(bogusDir, 'junk.txt'), 'hi');
    const { execSync } = await import('node:child_process');
    execSync(`tar czf '${bogus}' -C '${bogusDir}' .`, { stdio: 'pipe' });
    rmSync(bogusDir, { recursive: true });

    await expect(importArchive({ archivePath: bogus })).rejects.toThrow(/manifest\.json/i);
  });

  it('rejects path-traversal tool names in manifest', async () => {
    const staging = mkdtempSync(pathJoin(tmpdir(), 'traversal-'));
    const siteDir = pathJoin(staging, 'evil');
    const toolDir = pathJoin(siteDir, 'legit_tool');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(pathJoin(toolDir, 'index.ts'), 'x');
    writeFileSync(
      pathJoin(staging, 'manifest.json'),
      JSON.stringify({
        version: 1,
        imprintVersion: '0.0.0',
        createdAt: new Date().toISOString(),
        sites: [
          { name: 'evil', tools: ['../../etc/passwd'], hasCredentials: false, hasShared: false },
        ],
      }),
    );
    const archivePath = pathJoin(tempHome, 'traversal.tar.gz');
    const { execSync } = await import('node:child_process');
    execSync(`tar czf '${archivePath}' -C '${staging}' .`, { stdio: 'pipe' });
    rmSync(staging, { recursive: true });

    await expect(importArchive({ archivePath, force: true })).rejects.toThrow(
      /must not contain path separators/i,
    );
  });

  it('round-trips multiple sites', async () => {
    seedSite('site_a', ['search_a']);
    seedSite('site_b', ['search_b', 'list_b']);
    const archivePath = pathJoin(tempHome, 'multi.tar.gz');
    await exportArchive({ sites: ['site_a', 'site_b'], out: archivePath });

    rmSync(pathJoin(tempHome, 'site_a'), { recursive: true });
    rmSync(pathJoin(tempHome, 'site_b'), { recursive: true });

    const result = await importArchive({ archivePath });
    expect(result.sites).toHaveLength(2);
    expect(existsSync(pathJoin(tempHome, 'site_a', 'search_a', 'index.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'site_b', 'search_b', 'index.ts'))).toBe(true);
    expect(existsSync(pathJoin(tempHome, 'site_b', 'list_b', 'index.ts'))).toBe(true);
  });
});
