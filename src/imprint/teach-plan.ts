/**
 * Plan-prereqs step for multi-tool `imprint teach`.
 *
 * Runs once per teach, after candidate selection + the replay/diff join and
 * before the per-tool compile fan-out, when ≥2 tools are selected. It:
 *   1. generates a BuildPlan (shared modules + per-tool guidance + auth recipe),
 *   2. builds + verifies the shared modules under `~/.imprint/<site>/_shared/`
 *      level-by-level (independent modules concurrently, dependents after their
 *      dependencies), so the files exist when the per-tool agents import them,
 *   3. persists the plan to `.build-plan.json` and returns the manifest.
 *
 * A module the builder can't verify is marked unverified and pruned from every
 * tool's `usesSharedModules`, so the per-tool import-assertion never fails on a
 * module that was never written (tools fall back to inlining — today's behavior).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type BuildPlan,
  type SharedModuleManifestEntry,
  type SharedModuleSpec,
  generateBuildPlan,
  topoLevels,
  writeBuildPlanSidecar,
} from './build-plan.ts';
import { mapLimit } from './concurrency.ts';
import type { ProviderName } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { imprintHomeDir, localSharedDir } from './paths.ts';
import { buildSharedModule } from './prereq-builder.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import type { ClassifiedValue } from './session-diff.ts';
import {
  type SharedCompileContext,
  type ToolCandidate,
  sharedContextHasAuth,
} from './tool-candidates.ts';
import { SessionSchema } from './types.ts';

const log = createLog('teach-plan');

/** Wall-clock cap on the single planner LLM call. A throttled/hung provider
 *  must not block the per-tool fan-out indefinitely; on timeout we degrade to
 *  independent per-tool compilation. */
const PLANNER_TIMEOUT_MS = 10 * 60_000;

/** Max shared modules built concurrently within one dependency level. Each build
 *  spawns an LLM child + `bun test` + `tsc`, so this is capped (matching the
 *  per-tool compile fan-out) to bound peak load and avoid provider throttling. */
const SHARED_BUILD_CONCURRENCY = 2;

interface PlanAndBuildPrereqsResult {
  /** Absolute path to the persisted plan sidecar, or '' when planning was skipped. */
  buildPlanPath: string;
  /** Build manifest (one entry per shared module, with verified flags). */
  sharedModules: SharedModuleManifestEntry[];
  /** The plan that was used (after pruning unverified modules), if any. */
  plan?: BuildPlan;
  /** Set when planning was attempted but failed/timed out, so the caller can
   *  surface the reason in the TUI (not raw stderr). Absent on success and when
   *  planning was deliberately skipped (disabled / <2 tools). */
  skippedReason?: string;
}

function buildPlanDisabled(): boolean {
  const v = process.env.IMPRINT_NO_BUILD_PLAN;
  return !!v && !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

export async function planAndBuildPrereqs(opts: {
  site: string;
  /** Redacted session path (also used as IMPRINT_SESSION_PATH when testing modules). */
  redactedSessionPath: string;
  candidates: ToolCandidate[];
  sharedContext?: SharedCompileContext;
  siteClassifications?: ClassifiedValue[];
  providerName: ProviderName;
  model?: string;
  maxCyclesPerModule?: number;
  onProgress?: (msg: string) => void;
}): Promise<PlanAndBuildPrereqsResult> {
  // Gate: shared prereqs only make sense across ≥2 tools — BUT the planner is also
  // the only producer of the build-plan `authTool`, so a single authenticated tool
  // (any detected login, with or without 2FA) must still run it, else the login is
  // detected yet never compiled into a reusable auth tool.
  const hasAuthFlow = sharedContextHasAuth(opts.sharedContext);
  if (opts.candidates.length < 2 && !hasAuthFlow) return { buildPlanPath: '', sharedModules: [] };
  if (buildPlanDisabled()) {
    log('IMPRINT_NO_BUILD_PLAN set — skipping build plan + shared prereqs');
    return { buildPlanPath: '', sharedModules: [] };
  }

  const session = loadJsonFile(
    opts.redactedSessionPath,
    SessionSchema,
    {
      notFound: 'Redacted session file not found before build planning.',
      badSchema: 'Redacted session file is malformed.',
    },
    'session',
  );

  // 1. Plan. Bounded by a wall-clock timeout AND made non-fatal: a throttled or
  //    hung LLM provider (or a malformed plan) must never wedge or abort the
  //    whole multi-tool teach. On any failure we degrade to independent per-tool
  //    compilation (the pre-feature behavior) instead of shared modules.
  opts.onProgress?.('Planning shared modules');
  let generated: Awaited<ReturnType<typeof generateBuildPlan>>;
  try {
    generated = await generateBuildPlan({
      session,
      candidates: opts.candidates,
      sharedContext: opts.sharedContext,
      classifications: opts.siteClassifications,
      llmConfig: { provider: opts.providerName, model: opts.model },
      timeoutMs: PLANNER_TIMEOUT_MS,
      onProgress: opts.onProgress,
    });
  } catch (err) {
    return {
      buildPlanPath: '',
      sharedModules: [],
      skippedReason: `Build planning failed or timed out (${err instanceof Error ? err.message : String(err)}) — compiling tools independently (no shared modules).`,
    };
  }
  const plan: BuildPlan = {
    sharedModules: generated.sharedModules,
    perTool: generated.perTool,
    authTool: generated.authTool,
  };

  // Persist immediately so a crash mid-build still leaves a readable plan.
  const buildPlanPath = writeBuildPlanSidecar(opts.site, plan);

  if (plan.sharedModules.length === 0) {
    log('build plan declared no shared modules — per-tool guidance only');
    return { buildPlanPath, sharedModules: [], plan };
  }

  // 2. Prepare a clean _shared dir + its toolchain (a stale module from a
  //    differently-shaped prior run must not be silently imported).
  const sharedDir = localSharedDir(opts.site);
  rmSync(sharedDir, { recursive: true, force: true });
  mkdirSync(sharedDir, { recursive: true });
  ensureSharedDirToolchain(sharedDir);

  // 3. Build the modules level-by-level. Modules in the same dependency level are
  //    independent, so each level builds concurrently (bounded by
  //    SHARED_BUILD_CONCURRENCY); a module that dependsOn another waits for its
  //    dependency's level. Only VERIFIED dependencies are accumulated into
  //    builtSpecs between levels, so a dependent of a pruned module degrades to
  //    inlining (today's behavior) rather than importing something never written.
  const levels = topoLevels(plan.sharedModules);
  const manifest: SharedModuleManifestEntry[] = [];
  const builtSpecs: SharedModuleSpec[] = [];
  for (const level of levels) {
    const results = await mapLimit(level, SHARED_BUILD_CONCURRENCY, (module) => {
      opts.onProgress?.(`Building ${module.path}`);
      return buildSharedModule({
        site: opts.site,
        module,
        session,
        sessionPath: opts.redactedSessionPath,
        sharedDir,
        builtModules: builtSpecs,
        llmConfig: { provider: opts.providerName, model: opts.model },
        maxCycles: opts.maxCyclesPerModule,
        onProgress: opts.onProgress,
      });
    });
    for (const result of results) {
      manifest.push({
        path: result.module.path,
        kind: result.module.kind,
        verified: result.ok,
      });
      if (result.ok) {
        builtSpecs.push(result.module);
        log(`shared module ${result.module.path} built + verified in ${result.cycles} cycle(s)`);
      } else {
        log(
          `shared module ${result.module.path} could not be verified — pruning from tools. Failures:\n${result.failures.join('\n')}`,
        );
      }
    }
  }

  // 4. Prune unverified modules from every tool, then re-persist.
  const verifiedPaths = new Set(manifest.filter((m) => m.verified).map((m) => m.path));
  const prunedPlan: BuildPlan = {
    sharedModules: plan.sharedModules.filter((m) => verifiedPaths.has(m.path)),
    perTool: plan.perTool.map((t) => ({
      ...t,
      usesSharedModules: t.usesSharedModules.filter((p) => verifiedPaths.has(p)),
      parserGuidance: correctGuidanceForPrunedModules(t.parserGuidance, verifiedPaths),
    })),
    // Carry the auth tool through pruning — it is independent of shared modules,
    // and dropping it here silently disables auth compilation for any site that
    // has shared modules (the auth gate reads authTool from this sidecar).
    authTool: plan.authTool,
  };
  writeBuildPlanSidecar(opts.site, prunedPlan);

  return { buildPlanPath, sharedModules: manifest, plan: prunedPlan };
}

/** Shared-module reference pattern, mirrors build-plan.ts SHARED_MODULE_PATH_RE. */
const SHARED_MODULE_REF_RE = /_shared\/[A-Za-z0-9._-]+\.ts/g;

/** Append a correction note to a tool's free-text `parserGuidance` for any shared
 *  module the guidance still names but that was NOT verified/built (and therefore
 *  pruned). Without this, the planner's prose (e.g. "Call decodeBatchExecute from
 *  _shared/batchexecute.ts") reaches the compile LLM via read_build_plan and tells
 *  it to import a module that was never written. Pure + unit-testable; appends
 *  rather than rewrites, so still-valid guidance is preserved. */
export function correctGuidanceForPrunedModules(
  guidance: string,
  verifiedPaths: ReadonlySet<string>,
): string {
  const referenced = new Set(guidance.match(SHARED_MODULE_REF_RE) ?? []);
  const pruned = [...referenced].filter((p) => !verifiedPaths.has(p));
  if (pruned.length === 0) return guidance;
  const notes = pruned
    .map(
      (p) =>
        `NOTE: shared module ${p} was NOT built — implement its logic inline in this tool's parser.ts; do not import it.`,
    )
    .join('\n');
  return guidance ? `${guidance}\n\n${notes}` : notes;
}

// ─── Toolchain bootstrap ────────────────────────────────────────────────────

/** Bootstrap `_shared/` with the type deps + runtime symlink so `bun test`,
 *  `tsc`, and `imprint/*` imports resolve — mirrors the compile-agent tool-dir
 *  bootstrap. */
function ensureSharedDirToolchain(sharedDir: string): void {
  ensureImprintRuntimeLink(imprintHomeDir());
  const pkgPath = pathJoin(sharedDir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name: 'imprint-shared',
          private: true,
          devDependencies: {
            '@types/bun': 'latest',
            '@types/node': 'latest',
            'bun-types': 'latest',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  if (!existsSync(pathJoin(sharedDir, 'node_modules'))) {
    Bun.spawnSync(['bun', 'install'], { cwd: sharedDir });
  }
}
