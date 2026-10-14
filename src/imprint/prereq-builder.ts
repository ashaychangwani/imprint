/**
 * Prereq builder for multi-tool `imprint teach`.
 *
 * `verifySharedModule` checks a shared module's declared exports, runs its
 * authored test, and typechecks it with its declared dependencies.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join as pathJoin } from 'node:path';
import type { SharedModuleSpec } from './build-plan.ts';
import { runBunTestWithResults, typecheckArtifacts } from './compile-tools.ts';
import type { Session } from './types.ts';

const SESSION_PATH_ENV = 'IMPRINT_SESSION_PATH';

export { importModuleFresh } from './import-module-fresh.ts';

/** Compress the verifier's (possibly multi-KB) failure list into a short,
 *  human-scannable summary of WHICH gate(s) failed — used in the per-cycle
 *  progress line and the "verify failed" log so a slow build reveals its blocker
 *  (typecheck vs test vs anchor) instead of a bare "verify failed". The full
 *  failure text still flows to `previousFailures` (the builder's retry feedback)
 *  and the prune log. Kept in sync with the failure strings produced by
 *  verifySharedModule + the build loop. */
export function summarizeFailures(failures: string[]): string {
  const gates = new Set<string>();
  for (const f of failures) gates.add(classifyFailure(f));
  return [...gates].join(', ') || 'unknown';
}

function classifyFailure(f: string): string {
  if (f.includes('failed typecheck')) return 'typecheck';
  if (f.includes('does not export')) return 'missing export';
  if (f.includes('import failed')) return 'import error';
  if (/\bbun test\b.*exited/.test(f) || f.includes('needs a test proving')) {
    return 'test';
  }
  if (f.includes('JSON object') || f.includes('invalid JSON') || f.includes('"module" string')) {
    return 'malformed builder output';
  }
  return 'verification';
}

// ─── Verification ───────────────────────────────────────────────────────────

interface VerifySharedModuleResult {
  failures: string[];
  warnings: string[];
}

export async function verifySharedModule(
  sharedDir: string,
  module: SharedModuleSpec,
  _session: Session,
  sessionPath: string,
): Promise<VerifySharedModuleResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  const base = basename(module.path);
  const name = base.replace(/\.ts$/, '');
  const modulePath = pathJoin(sharedDir, base);
  const testBase = `${name}.test.ts`;
  const testPath = pathJoin(sharedDir, testBase);

  if (!existsSync(modulePath)) {
    failures.push(`${module.path} was not written`);
    return { failures, warnings };
  }

  const typesOnly = module.kind === 'types';
  // 1. Runtime import + exported-symbol checks (skipped for type-only modules).
  if (!typesOnly) {
    const runtimeExports = module.exportSignatures
      .filter((signature) => !isTypeSignature(signature))
      .map(exportedSymbolName)
      .filter((name): name is string => name !== undefined);
    const exportTestBase = `.imprint-export-${process.pid}-${Date.now()}.test.ts`;
    const exportTestPath = pathJoin(sharedDir, exportTestBase);
    try {
      writeFileSync(
        exportTestPath,
        `import { test } from 'bun:test';
import * as authoredModule from './${base}';
test('declared runtime exports exist', () => {
  const missing = ${JSON.stringify(runtimeExports)}.filter((name) => !(name in authoredModule));
  if (missing.length > 0) throw new Error('missing exports: ' + missing.join(', '));
});
`,
        'utf8',
      );
      const run = await runBunTestWithResults(
        exportTestPath,
        sharedDir,
        120_000,
        { [SESSION_PATH_ENV]: sessionPath },
        { networkDisabled: true },
      );
      if (run.exitCode !== 0 || run.timedOut) {
        failures.push(
          `${module.path} import/export check failed (exit ${run.exitCode}${run.timedOut ? ', timed out' : ''})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
        for (const name of runtimeExports) {
          if (`${run.stdout}\n${run.stderr}`.includes(name)) {
            failures.push(
              `${module.path} does not export "${name}" (declared in exportSignatures)`,
            );
          }
        }
      }
    } catch (err) {
      failures.push(
        `${module.path} import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      rmSync(exportTestPath, { force: true });
    }
  }

  // 2. Require and run the authored test (skipped for type-only modules).
  if (!typesOnly && !existsSync(testPath)) {
    failures.push(
      `${testBase} was not written — a shared module needs a test proving its behavior against recorded data`,
    );
  } else if (!typesOnly) {
    const output = await runBunTestWithResults(
      testPath,
      sharedDir,
      120_000,
      { [SESSION_PATH_ENV]: sessionPath },
      { networkDisabled: true },
    );
    if (output.exitCode !== 0) {
      failures.push(
        `bun test ${testBase} exited ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }

  // 3. Typecheck the module (+ its declared dependency files).
  const includes = [base, ...module.dependsOn.map((d) => basename(d))];
  const tc = await typecheckArtifacts(sharedDir, includes);
  if (tc.exitCode !== 0 || tc.timedOut) {
    failures.push(
      `${module.path} failed typecheck (exit ${tc.exitCode}${tc.timedOut ? ', timed out' : ''})\nstdout:\n${tc.stdout}\nstderr:\n${tc.stderr}`,
    );
  }

  return { failures, warnings };
}

// ─── Source-analysis helpers ────────────────────────────────────────────────

function exportedSymbolName(sig: string): string | null {
  const m = sig.match(
    /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/,
  );
  return m?.[1] ?? null;
}

function isTypeSignature(sig: string): boolean {
  return /export\s+(?:type|interface)\b/.test(sig);
}
