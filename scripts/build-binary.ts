#!/usr/bin/env bun
/**
 * Build standalone Imprint binaries via `bun build --compile`.
 *
 * Usage:
 *   bun run scripts/build-binary.ts                 # current platform only
 *   bun run scripts/build-binary.ts --all-targets   # all supported platforms
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const ROOT = pathResolve(import.meta.dir, '..');
const ENTRY = pathResolve(ROOT, 'src', 'cli.ts');
const OUT_DIR = pathResolve(ROOT, 'dist');

const pkg = JSON.parse(readFileSync(pathResolve(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
] as const;

const EXTERNALS = [
  'playwright',
  'playwright-extra',
  'playwright-core',
  'puppeteer-extra-plugin-stealth',
];

function outName(target: string): string {
  const short = target.replace('bun-', '');
  return pathResolve(OUT_DIR, `imprint-${short}`);
}

async function build(target: string): Promise<void> {
  const out = outName(target);
  const args = [
    'bun',
    'build',
    '--compile',
    `--target=${target}`,
    ...EXTERNALS.flatMap((e) => ['--external', e]),
    `--define=globalThis.__IMPRINT_COMPILED__=true`,
    `--define=globalThis.__IMPRINT_VERSION__=${JSON.stringify(pkg.version)}`,
    `--outfile=${out}`,
    ENTRY,
  ];

  console.log(`  building ${target}…`);
  const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Build failed for ${target} (exit ${code})`);
  console.log(`  → ${out}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const allTargets = process.argv.includes('--all-targets');
  const targets = allTargets ? [...TARGETS] : [detectCurrentTarget()];

  console.log(`Building Imprint v${pkg.version} for ${targets.length} target(s):\n`);

  for (const target of targets) {
    await build(target);
  }

  console.log('\nDone.');
}

function detectCurrentTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Unsupported platform: ${process.platform} (supported: darwin, linux)`);
  }
  return `bun-${process.platform}-${arch}`;
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
