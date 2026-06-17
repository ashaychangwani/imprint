/**
 * `imprint export` / `imprint import` — portable .tar.gz archives of
 * generated MCP tools, optionally including encrypted credential bundles.
 *
 * Archive layout:
 *   manifest.json
 *   <site>/<tool>/{ workflow.json, playbook.yaml, index.ts, ... }
 *   <site>/_shared/{ *.ts, package.json }
 *   <site>/credentials.imprintbundle   (when --include-credentials)
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import * as p from '@clack/prompts';
import { type BundleEnvelope, exportBundle, importBundle } from './credential-bundle.ts';
import { getCredentialBackend } from './credential-store.ts';
import { imprintHomeDir, localSharedDir, localSiteDir } from './paths.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { availableSitesHint } from './sites.ts';
import { VERSION } from './version.ts';

const TOOL_FILES = [
  'workflow.json',
  'playbook.yaml',
  'index.ts',
  'parser.ts',
  'request-transform.ts',
  'package.json',
  'backends.json',
  'cron.json',
];

const SHARED_SKIP = new Set(['node_modules', 'bun.lock']);

interface ExportManifest {
  version: 1;
  imprintVersion: string;
  createdAt: string;
  sites: Array<{
    name: string;
    tools: string[];
    hasCredentials: boolean;
    hasShared: boolean;
  }>;
}

interface ExportResult {
  archivePath: string;
  sites: Array<{ name: string; tools: string[] }>;
  byteSize: number;
}

interface ImportResult {
  sites: Array<{
    name: string;
    tools: string[];
    credentialsImported: boolean;
    skipped: boolean;
  }>;
}

function isToolDir(dir: string): boolean {
  return existsSync(pathJoin(dir, 'index.ts'));
}

function discoverToolNames(siteDir: string): string[] {
  if (!existsSync(siteDir)) return [];
  return readdirSync(siteDir)
    .filter((entry) => {
      if (
        entry.startsWith('.') ||
        entry.startsWith('_') ||
        entry === 'sessions' ||
        entry === 'node_modules'
      )
        return false;
      const full = pathJoin(siteDir, entry);
      try {
        return statSync(full).isDirectory() && isToolDir(full);
      } catch {
        return false;
      }
    })
    .sort();
}

function collectToolFiles(toolDir: string): string[] {
  return TOOL_FILES.filter((f) => existsSync(pathJoin(toolDir, f)));
}

function collectSharedFiles(sharedDir: string): string[] {
  if (!existsSync(sharedDir)) return [];
  return readdirSync(sharedDir).filter((f) => {
    if (SHARED_SKIP.has(f)) return false;
    if (f.endsWith('.test.ts') || f.endsWith('.plan.md')) return false;
    const full = pathJoin(sharedDir, f);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });
}

export async function exportArchive(opts: {
  sites: string[];
  out: string;
  includeCredentials?: boolean;
}): Promise<ExportResult> {
  for (const site of opts.sites) {
    const dir = localSiteDir(site);
    if (!existsSync(dir)) {
      throw new Error(
        `Site "${site}" not found at ${dir}.\n${availableSitesHint(imprintHomeDir(), site)}`,
      );
    }
  }

  const staging = mkdtempSync(pathJoin(tmpdir(), 'imprint-export-'));

  try {
    const manifest: ExportManifest = {
      version: 1,
      imprintVersion: VERSION,
      createdAt: new Date().toISOString(),
      sites: [],
    };

    for (const site of opts.sites) {
      const siteDir = localSiteDir(site);
      const tools = discoverToolNames(siteDir);
      if (tools.length === 0) {
        throw new Error(
          `Site "${site}" has no tools (no subdirectories with index.ts). Nothing to export.`,
        );
      }

      const stagingSite = pathJoin(staging, site);
      mkdirSync(stagingSite, { recursive: true });

      for (const tool of tools) {
        const toolDir = pathJoin(siteDir, tool);
        const stagingTool = pathJoin(stagingSite, tool);
        mkdirSync(stagingTool, { recursive: true });

        for (const file of collectToolFiles(toolDir)) {
          copyFileSync(pathJoin(toolDir, file), pathJoin(stagingTool, file));
        }
      }

      const sharedDir = localSharedDir(site);
      const sharedFiles = collectSharedFiles(sharedDir);
      let hasShared = false;
      if (sharedFiles.length > 0) {
        const stagingShared = pathJoin(stagingSite, '_shared');
        mkdirSync(stagingShared, { recursive: true });
        for (const file of sharedFiles) {
          copyFileSync(pathJoin(sharedDir, file), pathJoin(stagingShared, file));
        }
        hasShared = true;
      }

      let hasCredentials = false;
      if (opts.includeCredentials) {
        const backend = await getCredentialBackend();
        const secrets = await backend.listSecrets(site);
        const cookies = await backend.getCookies(site);
        if (secrets.length > 0 || cookies.length > 0) {
          const passphrase = await p.password({
            message: `Passphrase to encrypt credentials for "${site}" (min 8 chars):`,
            validate: (v) =>
              (v ?? '').length < 8 ? 'Passphrase must be at least 8 characters.' : undefined,
          });
          if (p.isCancel(passphrase)) {
            throw new Error('Export cancelled.');
          }
          const envelope = await exportBundle({
            backend,
            site,
            passphrase,
          });
          writeFileSync(
            pathJoin(stagingSite, 'credentials.imprintbundle'),
            JSON.stringify(envelope, null, 2),
            'utf8',
          );
          hasCredentials = true;
        }
      }

      manifest.sites.push({ name: site, tools, hasCredentials, hasShared });
    }

    writeFileSync(pathJoin(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const archivePath = pathResolve(opts.out);
    execSync(`tar czf ${shellEscape(archivePath)} -C ${shellEscape(staging)} .`, {
      stdio: 'pipe',
    });

    const byteSize = statSync(archivePath).size;
    return {
      archivePath,
      sites: manifest.sites.map((s) => ({ name: s.name, tools: s.tools })),
      byteSize,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function importArchive(opts: {
  archivePath: string;
  force?: boolean;
}): Promise<ImportResult> {
  const archivePath = pathResolve(opts.archivePath);
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  const staging = mkdtempSync(pathJoin(tmpdir(), 'imprint-import-'));

  try {
    execSync(`tar xzf ${shellEscape(archivePath)} -C ${shellEscape(staging)}`, {
      stdio: 'pipe',
    });

    const manifestPath = pathJoin(staging, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(
        'Invalid archive: missing manifest.json. This does not appear to be an imprint export.',
      );
    }

    const manifest: ExportManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1) {
      throw new Error(
        `Unsupported archive version ${manifest.version}. Update imprint and try again.`,
      );
    }

    const home = imprintHomeDir();
    const result: ImportResult = { sites: [] };

    for (const entry of manifest.sites) {
      const targetDir = localSiteDir(entry.name);
      const skipped = false;

      if (existsSync(targetDir) && !opts.force) {
        console.error(
          `warning: site "${entry.name}" already exists at ${targetDir} — skipping (use --force to overwrite).`,
        );
        result.sites.push({
          name: entry.name,
          tools: entry.tools,
          credentialsImported: false,
          skipped: true,
        });
        continue;
      }

      const stagedSite = pathJoin(staging, entry.name);

      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }

      for (const tool of entry.tools) {
        assertSafeSegment('tool name', tool);
        const src = pathJoin(stagedSite, tool);
        const dest = pathJoin(targetDir, tool);
        mkdirSync(dest, { recursive: true });
        for (const file of readdirSync(src)) {
          const srcFile = pathJoin(src, file);
          if (statSync(srcFile).isFile()) {
            copyFileSync(srcFile, pathJoin(dest, file));
          }
        }
      }

      if (entry.hasShared) {
        const sharedSrc = pathJoin(stagedSite, '_shared');
        const sharedDest = pathJoin(targetDir, '_shared');
        if (existsSync(sharedSrc)) {
          mkdirSync(sharedDest, { recursive: true });
          for (const file of readdirSync(sharedSrc)) {
            const srcFile = pathJoin(sharedSrc, file);
            if (statSync(srcFile).isFile()) {
              copyFileSync(srcFile, pathJoin(sharedDest, file));
            }
          }
        }
      }

      let credentialsImported = false;
      const bundlePath = pathJoin(stagedSite, 'credentials.imprintbundle');
      if (entry.hasCredentials && existsSync(bundlePath)) {
        const envelope: BundleEnvelope = JSON.parse(readFileSync(bundlePath, 'utf8'));
        const passphrase = await p.password({
          message: `Passphrase to decrypt credentials for "${entry.name}":`,
        });
        if (p.isCancel(passphrase)) {
          console.error(`Skipping credential import for "${entry.name}".`);
        } else {
          try {
            const backend = await getCredentialBackend();
            await importBundle({ backend, envelope, passphrase });
            credentialsImported = true;
          } catch (err) {
            console.error(
              `warning: credential import failed for "${entry.name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      ensureImprintRuntimeLink(home);

      result.sites.push({
        name: entry.name,
        tools: entry.tools,
        credentialsImported,
        skipped,
      });
    }

    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertSafeSegment(label: string, value: string): void {
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(
      `Invalid ${label} in archive: "${value}". Must not contain path separators or ".." sequences.`,
    );
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
