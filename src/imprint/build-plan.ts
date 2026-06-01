/**
 * Build-plan generation for multi-tool `imprint teach`.
 *
 * After candidate detection + user selection, this single-shot LLM pass
 * produces a BuildPlan: the shared utility modules to create once under
 * `~/.imprint/<site>/_shared/` (so per-tool compile agents import vetted code
 * instead of independently re-deriving signing/parsing logic), plus per-tool
 * guidance and an auth recipe each agent replicates inline. The prereq builder
 * (prereq-builder.ts) writes + verifies the shared modules before the per-tool
 * compile fan-out. See prompts/build-planning.md for the system prompt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { TimeoutError, withTimeout } from './concurrency.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import { localSiteDir } from './paths.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { type ClassifiedValue, looksLikeToken } from './session-diff.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import type { Session } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const BODY_LIMIT = 800;
const RESPONSE_PREVIEW_LIMIT = 500;
const HEADER_LIMIT = 600;
const log = createLog('build-plan');

// ─── Schema ─────────────────────────────────────────────────────────────────

const SharedModuleKindSchema = z.enum(['request-transform', 'parser-helper', 'types']);
export type SharedModuleKind = z.infer<typeof SharedModuleKindSchema>;

/** Shared modules live under `_shared/` and are imported by per-tool artifacts
 *  via the relative path `../_shared/<name>.ts` (the runtime resolves
 *  parserModule/requestTransformModule relative to each tool's workflow.json). */
const SHARED_MODULE_PATH_RE = /^_shared\/[A-Za-z0-9._-]+\.ts$/;

export const SharedModuleSpecSchema = z.object({
  path: z
    .string()
    .regex(SHARED_MODULE_PATH_RE, 'shared module path must look like "_shared/<name>.ts"'),
  kind: SharedModuleKindSchema,
  purpose: z.string().min(1),
  exportSignatures: z.array(z.string().min(1)).min(1),
  spec: z.string().min(1),
  sourceSeqs: z.array(z.number().int().nonnegative()).default([]),
  dependsOn: z.array(z.string()).default([]),
});
export type SharedModuleSpec = z.infer<typeof SharedModuleSpecSchema>;

const AuthCaptureSchema = z.object({
  name: z.string().min(1),
  /** Capture source: json | response_header | cookie | text_regex. */
  source: z.string().min(1),
  /** Path / header name / cookie name / regex that locates the value. */
  locator: z.string().min(1),
  /** Where the captured value is injected downstream, e.g. "header:Authorization". */
  usedAs: z.string().default(''),
});

const AuthRecipeSchema = z
  .object({
    required: z.boolean().default(false),
    loginRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
    credentialNames: z.array(z.string()).default([]),
    captures: z.array(AuthCaptureSchema).default([]),
    notes: z.string().default(''),
  })
  .default({});

/** A field this tool's parser MUST emit so a sibling consumer tool can use it as
 *  an input param (producer side of an opaque-token chain). `shape` describes the
 *  exact form the consumer needs (e.g. a pipe-joined composite), so the producer
 *  emits the full value rather than a bare fragment. */
const EmittedTokenSchema = z.object({
  field: z.string().min(1),
  shape: z.string().default(''),
});

/** An input param whose value is an opaque token/id minted by a sibling tool
 *  (consumer side). The consumer takes `sourceTool`'s `sourceField` output as-is;
 *  the gate requires a chained verification test and the MCP description tells the
 *  orchestrating LLM to call `sourceTool` first and reuse the value. */
const TokenParamSchema = z.object({
  param: z.string().min(1),
  sourceTool: z.string().min(1),
  sourceField: z.string().min(1),
});

const PerToolPlanSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/),
  usesSharedModules: z.array(z.string()).default([]),
  loadBearingSeqs: z.array(z.number().int().nonnegative()).default([]),
  parserGuidance: z.string().default(''),
  paramChecklist: z.array(z.string()).default([]),
  authRecipe: AuthRecipeSchema,
  /** Opaque-token chain — producer side: fields this tool's parser must emit for
   *  sibling consumers. */
  emitsTokens: z.array(EmittedTokenSchema).default([]),
  /** Opaque-token chain — consumer side: params minted by a sibling producer. */
  tokenParams: z.array(TokenParamSchema).default([]),
});
type PerToolPlan = z.infer<typeof PerToolPlanSchema>;

export const BuildPlanSchema = z
  .object({
    sharedModules: z.array(SharedModuleSpecSchema).default([]),
    perTool: z.array(PerToolPlanSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const modulePaths = new Set<string>();
    for (const [i, m] of value.sharedModules.entries()) {
      if (modulePaths.has(m.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sharedModules', i, 'path'],
          message: `duplicate shared module path "${m.path}"`,
        });
      }
      modulePaths.add(m.path);
    }
    for (const [i, m] of value.sharedModules.entries()) {
      for (const [j, dep] of m.dependsOn.entries()) {
        if (!modulePaths.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sharedModules', i, 'dependsOn', j],
            message: `dependsOn references unknown module "${dep}"`,
          });
        }
      }
    }
    if (moduleGraphHasCycle(value.sharedModules)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sharedModules'],
        message: 'sharedModules dependsOn graph has a cycle',
      });
    }
    const toolNames = new Set<string>();
    for (const [i, t] of value.perTool.entries()) {
      if (toolNames.has(t.toolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['perTool', i, 'toolName'],
          message: `duplicate toolName "${t.toolName}"`,
        });
      }
      toolNames.add(t.toolName);
      for (const [j, used] of t.usesSharedModules.entries()) {
        if (!modulePaths.has(used)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['perTool', i, 'usesSharedModules', j],
            message: `tool "${t.toolName}" references unknown shared module "${used}"`,
          });
        }
      }
    }
    // Opaque-token chain validation: each consumer's tokenParam must point at a
    // real sibling producer that declares the consumed field in `emitsTokens`.
    const emittedByTool = new Map(
      value.perTool.map((t) => [t.toolName, new Set(t.emitsTokens.map((e) => e.field))]),
    );
    for (const [i, t] of value.perTool.entries()) {
      for (const [j, tp] of t.tokenParams.entries()) {
        if (tp.sourceTool === t.toolName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['perTool', i, 'tokenParams', j, 'sourceTool'],
            message: `tokenParam "${tp.param}" cannot source from its own tool "${t.toolName}"`,
          });
        } else if (!toolNames.has(tp.sourceTool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['perTool', i, 'tokenParams', j, 'sourceTool'],
            message: `tokenParam "${tp.param}" references unknown producer tool "${tp.sourceTool}"`,
          });
        } else if (!emittedByTool.get(tp.sourceTool)?.has(tp.sourceField)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['perTool', i, 'tokenParams', j, 'sourceField'],
            message: `producer "${tp.sourceTool}" does not declare emitted field "${tp.sourceField}" (add it to that tool's emitsTokens)`,
          });
        }
      }
    }
  });
export type BuildPlan = z.infer<typeof BuildPlanSchema>;

/** Manifest entry persisted on WorkflowState after the prereq builder runs.
 *  `verified` is false when the builder could not produce a passing module
 *  (the orchestrator then prunes it from each tool's usesSharedModules). */
export const SharedModuleManifestEntrySchema = z.object({
  path: z.string(),
  kind: SharedModuleKindSchema,
  verified: z.boolean(),
});
export type SharedModuleManifestEntry = z.infer<typeof SharedModuleManifestEntrySchema>;
export const SharedModuleManifestSchema = z.array(SharedModuleManifestEntrySchema);

// ─── Graph helpers ──────────────────────────────────────────────────────────

function moduleGraphHasCycle(modules: SharedModuleSpec[]): boolean {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const state = new Map<string, 1 | 2>();
  const visit = (path: string): boolean => {
    const st = state.get(path);
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(path, 1);
    for (const dep of byPath.get(path)?.dependsOn ?? []) {
      if (byPath.has(dep) && visit(dep)) return true;
    }
    state.set(path, 2);
    return false;
  };
  for (const m of modules) {
    if (visit(m.path)) return true;
  }
  return false;
}

/** Return the shared modules ordered so every module comes after its
 *  dependsOn targets. Throws on cycle (already rejected at parse time, but
 *  callers that build a plan by hand get a clear error). */
export function topoSortSharedModules(modules: SharedModuleSpec[]): SharedModuleSpec[] {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const state = new Map<string, 1 | 2>();
  const result: SharedModuleSpec[] = [];
  const visit = (path: string): void => {
    const st = state.get(path);
    if (st === 2) return;
    if (st === 1) throw new Error(`shared module dependency cycle at "${path}"`);
    state.set(path, 1);
    const mod = byPath.get(path);
    if (mod) {
      for (const dep of mod.dependsOn) {
        if (byPath.has(dep)) visit(dep);
      }
      result.push(mod);
    }
    state.set(path, 2);
  };
  for (const m of modules) visit(m.path);
  return result;
}

/** Group the shared modules into dependency "levels" via Kahn layering: level 0
 *  is every module with no in-set dependency, level 1 is modules whose deps are
 *  all satisfied by level 0, and so on. Modules within a level are mutually
 *  independent and may be built concurrently; no module appears before one it
 *  dependsOn. Cycle-safe — cycles are rejected at parse time, but any residual
 *  cycle members are appended as a final level so no module is silently dropped.
 *  Flattening the result yields a valid topological order (cf. topoSortSharedModules). */
export function topoLevels(modules: SharedModuleSpec[]): SharedModuleSpec[][] {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const m of modules) {
    const deps = m.dependsOn.filter((d) => byPath.has(d));
    indegree.set(m.path, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep);
      if (list) list.push(m.path);
      else dependents.set(dep, [m.path]);
    }
  }

  const levels: SharedModuleSpec[][] = [];
  const placed = new Set<string>();
  let frontier = modules.filter((m) => (indegree.get(m.path) ?? 0) === 0);
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const m of frontier) placed.add(m.path);
    const next: SharedModuleSpec[] = [];
    for (const m of frontier) {
      for (const depPath of dependents.get(m.path) ?? []) {
        const remaining = (indegree.get(depPath) ?? 0) - 1;
        indegree.set(depPath, remaining);
        if (remaining === 0) {
          const mod = byPath.get(depPath);
          if (mod) next.push(mod);
        }
      }
    }
    frontier = next;
  }

  // Defensive: an unexpected cycle would leave members unplaced — append them so
  // the build still attempts every module (matches topoSortSharedModules' intent).
  const leftover = modules.filter((m) => !placed.has(m.path));
  if (leftover.length > 0) levels.push(leftover);
  return levels;
}

interface BuildPlanSlice {
  tool: PerToolPlan;
  /** The shared modules this tool is assigned, resolved from usesSharedModules. */
  sharedModules: SharedModuleSpec[];
}

/** Project the plan down to a single tool's slice — what the per-tool compile
 *  agent reads via the read_build_plan tool. */
export function planSliceForTool(plan: BuildPlan, toolName: string): BuildPlanSlice | undefined {
  const tool = plan.perTool.find((t) => t.toolName === toolName);
  if (!tool) return undefined;
  const byPath = new Map(plan.sharedModules.map((m) => [m.path, m]));
  const sharedModules = tool.usesSharedModules
    .map((p) => byPath.get(p))
    .filter((m): m is SharedModuleSpec => m != null);
  return { tool, sharedModules };
}

/** A shared module a tool must import, with the relative import path the tool
 *  uses (`../_shared/<name>.ts`) and whether the prereq builder verified it. */
export interface AssignedSharedModule {
  path: string;
  kind: SharedModuleKind;
  verified: boolean;
  importPath: string;
  exportSignatures: string[];
  purpose: string;
}

/** Relative path a tool under `~/.imprint/<site>/<toolName>/` uses to import a
 *  shared module at `~/.imprint/<site>/_shared/<name>.ts`. */
export function sharedModuleImportPath(modulePath: string): string {
  return `../_shared/${modulePath.replace(/^_shared\//, '')}`;
}

/** Resolve the shared modules assigned to `toolName`, annotating each with its
 *  verified status from the build manifest. When `manifest` is omitted every
 *  module is treated as verified (best-effort). */
export function resolveAssignedModules(
  plan: BuildPlan,
  toolName: string,
  manifest?: SharedModuleManifestEntry[],
): AssignedSharedModule[] {
  const slice = planSliceForTool(plan, toolName);
  if (!slice) return [];
  const verifiedByPath = new Map((manifest ?? []).map((m) => [m.path, m.verified]));
  return slice.sharedModules.map((m) => ({
    path: m.path,
    kind: m.kind,
    verified: manifest ? (verifiedByPath.get(m.path) ?? false) : true,
    importPath: sharedModuleImportPath(m.path),
    exportSignatures: m.exportSignatures,
    purpose: m.purpose,
  }));
}

/** Human-readable block injected into each per-tool compile agent's initial
 *  prompt, listing the verified shared modules it must import. Shared by all
 *  three compile drivers. Returns '' when nothing is assigned. */
export function describeAssignedModules(assigned: AssignedSharedModule[]): string {
  const verified = assigned.filter((m) => m.verified);
  if (verified.length === 0) return '';
  const lines = verified.map(
    (m) =>
      `- ${m.importPath} (${m.kind}): ${m.purpose}\n  exports: ${m.exportSignatures.join('; ')}`,
  );
  return `

Assigned shared modules — import these instead of re-implementing their logic (call read_build_plan for the full slice):
${lines.join('\n')}

For a request-transform module, set "requestTransformModule": "<importPath>" in workflow.json. For a parser-helper/types module, import it in parser.ts. The verifier fails this tool if an assigned module is not imported.`;
}

/** The producer→consumer token contracts the build plan declared for a tool
 *  (consumer side). Threaded into `externalVerification` so the gate requires a
 *  chained test and stamps `sourcedFrom`. Empty when the plan declared none. */
export function resolveTokenParams(
  plan: BuildPlan,
  toolName: string,
): Array<{ param: string; sourceTool: string; sourceField: string }> {
  return plan.perTool.find((t) => t.toolName === toolName)?.tokenParams ?? [];
}

/** The fields a tool's parser MUST emit for sibling consumers (producer side).
 *  Threaded into `externalVerification` so the gate fails a producer that does
 *  not emit a declared field. Empty when the plan declared none. */
export function resolveEmittedTokens(
  plan: BuildPlan,
  toolName: string,
): Array<{ field: string; shape: string }> {
  return plan.perTool.find((t) => t.toolName === toolName)?.emitsTokens ?? [];
}

/** Order tools producer-before-consumer for the compile fan-out: edge
 *  consumer → its tokenParams' sourceTool. Returns Kahn levels (tools within a
 *  level are independent and may compile concurrently). Cycle-safe — any residual
 *  cycle members are appended as a final level (matches `topoLevels`). A consumer
 *  whose producer compiles first can run its chained verification test live. */
export function topoLevelsForTools<T extends { toolName: string }>(
  tools: T[],
  plan: BuildPlan | null,
): T[][] {
  const names = new Set(tools.map((t) => t.toolName));
  const deps = new Map<string, Set<string>>();
  for (const t of tools) {
    const producers = new Set<string>();
    for (const tp of plan ? resolveTokenParams(plan, t.toolName) : []) {
      if (tp.sourceTool !== t.toolName && names.has(tp.sourceTool)) producers.add(tp.sourceTool);
    }
    deps.set(t.toolName, producers);
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tools) {
    indegree.set(t.toolName, deps.get(t.toolName)?.size ?? 0);
    for (const producer of deps.get(t.toolName) ?? []) {
      const list = dependents.get(producer);
      if (list) list.push(t.toolName);
      else dependents.set(producer, [t.toolName]);
    }
  }
  const byName = new Map(tools.map((t) => [t.toolName, t]));
  const levels: T[][] = [];
  const placed = new Set<string>();
  let frontier = tools.filter((t) => (indegree.get(t.toolName) ?? 0) === 0);
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const t of frontier) placed.add(t.toolName);
    const next: T[] = [];
    for (const t of frontier) {
      for (const dependent of dependents.get(t.toolName) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) {
          const tool = byName.get(dependent);
          if (tool) next.push(tool);
        }
      }
    }
    frontier = next;
  }
  const leftover = tools.filter((t) => !placed.has(t.toolName));
  if (leftover.length > 0) levels.push(leftover);
  return levels;
}

/** Load a build plan from an explicit file path (the sidecar threaded into the
 *  compile drivers). Returns null on missing/invalid file. */
export function readBuildPlanFile(path: string): BuildPlan | null {
  if (!existsSync(path)) return null;
  try {
    return BuildPlanSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Parse + normalize an LLM/disk plan. When `selected` is provided, drops
 *  perTool entries for tools that weren't selected and backfills a minimal
 *  entry for any selected tool the planner omitted, so the fan-out always has
 *  a slice for every tool it will compile. */
export function validateBuildPlan(
  input: unknown,
  selected?: Array<ToolCandidate | string>,
): BuildPlan {
  const plan = BuildPlanSchema.parse(input);
  if (selected && selected.length > 0) {
    const names = new Set(selected.map((t) => (typeof t === 'string' ? t : t.toolName)));
    plan.perTool = plan.perTool.filter((t) => names.has(t.toolName));
    for (const name of names) {
      if (!plan.perTool.some((t) => t.toolName === name)) {
        plan.perTool.push(
          PerToolPlanSchema.parse({ toolName: name, authRecipe: {} }) as PerToolPlan,
        );
      }
    }
    if (plan.perTool.length === 0) {
      throw new Error('Build plan has no perTool entries for the selected tools.');
    }
  }
  return plan;
}

// ─── Deterministic cross-tool token detection ────────────────────────────────

/** A grounded producer→consumer opaque-token edge derived DETERMINISTICALLY from
 *  the dual-pass classifications — not LLM inference. The consumer sends, at
 *  `consumerLocation`, a value the diff classified `server_derived` from
 *  `producerPath` in a response owned by a DIFFERENT selected tool. Fed to the
 *  planner as a grounded hint and used to reconcile the returned plan so a
 *  planner shortcut cannot silently drop (or half-declare) the contract. */
export interface TokenContractHint {
  consumerTool: string;
  /** Param name derived from `consumerLocation` (reconciled to a `likelyParams`
   *  name when one matches case-insensitively). */
  consumerParam: string;
  consumerLocation: string;
  producerTool: string;
  /** Output field name derived from `producerPath`. */
  producerField: string;
  producerPath: string;
  /** Whether the consumer slot maps to a clean, nameable param (a real query/body
   *  key or a known `likelyParams` name) rather than an opaque JSPB index path.
   *  Only nameable edges are auto-injected when the planner misses them; unnamed
   *  ones are left to the compile-time chained-test gate to enforce. */
  nameable: boolean;
}

/** Sanitize a raw path/param segment into a safe identifier. General — no
 *  site-specific shapes. */
function toIdentifier(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'token';
}

/** Derive a consumer param name from a classification `location`
 *  ("url_param:hotel_id" → "hotel_id", "body:$.hotel.id" → "id"). Returns '' for
 *  `header:` locations — header tokens are session/anti-bot state handled by the
 *  bootstrap ladder, NOT cross-tool entity params (out of scope here). */
function paramNameFromLocation(location: string): string {
  const idx = location.indexOf(':');
  const kind = (idx >= 0 ? location.slice(0, idx) : '').toLowerCase();
  if (kind === 'header') return '';
  const rest = (idx >= 0 ? location.slice(idx + 1) : location).replace(/^\$\.?/, '');
  const seg =
    rest
      .split(/[.[\]]/)
      .filter(Boolean)
      .pop() ?? rest;
  return toIdentifier(seg);
}

/** Derive a producer output field name from a `producerPath`
 *  ("$.results[0].detailToken" → "detailToken"); skips pure-numeric indices. */
function fieldNameFromPath(path: string): string {
  const seg = path
    .replace(/^\$\.?/, '')
    .split(/[.[\]]/)
    .filter((s) => s && !/^\d+$/.test(s))
    .pop();
  return toIdentifier(seg ?? 'token');
}

/**
 * Deterministically detect cross-tool opaque-token edges from the dual-pass
 * classifications. A `server_derived` value SENT by one tool (the sole owner of
 * `originalSeq`) but PRODUCED in a response owned by a DIFFERENT tool (the sole
 * owner of `producerSeq`) is a producer→consumer token. Pure; grounds the
 * contract in the recording instead of leaving detection to the planner LLM
 * (whose shortcut on exactly this is the defect this feature fixes). Conservative
 * by design: a seq owned by >1 tool (a shared request) is ambiguous and skipped;
 * `header:` locations (session/anti-bot tokens) are out of scope and skipped.
 */
export function deriveTokenContractHints(payload: {
  selectedTools: Array<{
    toolName: string;
    requestSeqs: number[];
    likelyParams?: Array<{ name: string }>;
  }>;
  ephemeralValues: Array<{
    classification: string;
    originalSeq: number;
    location: string;
    producerSeq?: number;
    producerPath?: string;
    value?: string;
  }>;
}): TokenContractHint[] {
  const ownersBySeq = new Map<number, Set<string>>();
  for (const t of payload.selectedTools) {
    for (const s of t.requestSeqs) {
      const set = ownersBySeq.get(s);
      if (set) set.add(t.toolName);
      else ownersBySeq.set(s, new Set([t.toolName]));
    }
  }
  const soleOwner = (seq: number): string | undefined => {
    const set = ownersBySeq.get(seq);
    return set && set.size === 1 ? [...set][0] : undefined;
  };
  const paramsByTool = new Map(
    payload.selectedTools.map((t) => [t.toolName, (t.likelyParams ?? []).map((p) => p.name)]),
  );
  const seen = new Set<string>();
  const out: TokenContractHint[] = [];
  for (const ev of payload.ephemeralValues) {
    // Any value with recovered producer provenance — `server_derived` (varied
    // across runs) OR a stable `constant` whose opaque value was found in a
    // sibling response — is a cross-tool token candidate.
    if (ev.producerSeq == null || !ev.producerPath) continue;
    if (!ev.value || !looksLikeToken(ev.value)) continue; // skip echoed query text, etc.
    const consumerTool = soleOwner(ev.originalSeq);
    const producerTool = soleOwner(ev.producerSeq);
    if (!consumerTool || !producerTool || consumerTool === producerTool) continue;
    let param = paramNameFromLocation(ev.location);
    if (!param) continue;
    // Reconcile to an actual exposed param name when one matches case-insensitively.
    const known = paramsByTool.get(consumerTool) ?? [];
    if (!known.includes(param)) {
      const ci = known.find((n) => n.toLowerCase() === param.toLowerCase());
      if (ci) param = ci;
    }
    // Nameable = a real param the consumer exposes, or a clean identifier-shaped
    // key — NOT an opaque JSPB index path (e.g. "body[0][10]" -> "0").
    const nameable = known.includes(param) || /^[A-Za-z][A-Za-z0-9_]*$/.test(param);
    const producerField = fieldNameFromPath(ev.producerPath);
    const key = `${consumerTool} ${param} ${producerTool} ${producerField}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      consumerTool,
      consumerParam: param,
      consumerLocation: ev.location,
      producerTool,
      producerField,
      producerPath: ev.producerPath,
      nameable,
    });
  }
  return out;
}

/** Loose perTool shape for reconciling a freshly-parsed planner plan in place,
 *  before zod applies defaults + the cross-tool superRefine. */
interface LoosePerToolPlan {
  toolName: string;
  authRecipe?: unknown;
  emitsTokens?: Array<{ field: string; shape?: string }>;
  tokenParams?: Array<{ param: string; sourceTool: string; sourceField: string }>;
}

/**
 * Reconcile a parsed planner plan against the deterministically-detected token
 * edges, IN PLACE, before validation. Edge-centric (one decision per
 * consumer→producer pair) so the planner's own naming/shape always wins:
 *  - if the consumer already declares ANY `tokenParam` sourced from that producer,
 *    the edge is covered — only ensure the producer emits each referenced
 *    `sourceField` (repairs a half-declared contract `superRefine` would reject);
 *  - else if the consumer already binds that param name to a different producer,
 *    trust the planner and warn;
 *  - else if the edge is confidently nameable, inject the full contract (consumer
 *    `tokenParam` + producer `emitsTokens`) so a planner shortcut can't drop it;
 *  - else (an opaque JSPB slot we can't safely name) warn and leave enforcement to
 *    the compile-time chained-test gate.
 * Returns counts + warnings for logging. No-op when `hints` is empty (so
 * single-tool / non-chained sites behave exactly as before).
 */
export function reconcileTokenContracts(
  parsed: unknown,
  hints: TokenContractHint[],
  selectedToolNames: Set<string>,
): { injected: number; repaired: number; warnings: string[] } {
  const result = { injected: 0, repaired: 0, warnings: [] as string[] };
  if (hints.length === 0 || typeof parsed !== 'object' || parsed === null) return result;
  const obj = parsed as { perTool?: LoosePerToolPlan[] };
  if (!Array.isArray(obj.perTool)) obj.perTool = [];
  const byName = new Map<string, LoosePerToolPlan>();
  for (const t of obj.perTool) {
    if (t && typeof t.toolName === 'string') byName.set(t.toolName, t);
  }
  const ensure = (name: string): LoosePerToolPlan => {
    let e = byName.get(name);
    if (!e) {
      e = { toolName: name, authRecipe: {} };
      obj.perTool?.push(e);
      byName.set(name, e);
    }
    return e;
  };
  const shapeNote = (h: TokenContractHint) =>
    `value consumed by ${h.consumerTool}.${h.consumerParam} (recorded at ${h.producerPath})`;
  // One decision per consumer→producer edge; prefer a nameable hint for naming.
  const edges = new Map<string, TokenContractHint>();
  for (const h of hints) {
    if (!selectedToolNames.has(h.consumerTool) || !selectedToolNames.has(h.producerTool)) continue;
    const key = `${h.consumerTool}|${h.producerTool}`;
    const prev = edges.get(key);
    if (!prev || (h.nameable && !prev.nameable)) edges.set(key, h);
  }
  for (const h of edges.values()) {
    const consumer = ensure(h.consumerTool);
    const producer = ensure(h.producerTool);
    if (!Array.isArray(consumer.tokenParams)) consumer.tokenParams = [];
    if (!Array.isArray(producer.emitsTokens)) producer.emitsTokens = [];
    const fromProducer = consumer.tokenParams.filter(
      (tp) => tp && tp.sourceTool === h.producerTool,
    );
    if (fromProducer.length > 0) {
      // Edge covered by the planner — repair any field the producer forgot to emit
      // (a half-declared contract `superRefine` would otherwise reject).
      for (const tp of fromProducer) {
        if (tp.sourceField && !producer.emitsTokens.some((e) => e && e.field === tp.sourceField)) {
          producer.emitsTokens.push({ field: tp.sourceField, shape: shapeNote(h) });
          result.repaired++;
        }
      }
      continue;
    }
    if (consumer.tokenParams.some((tp) => tp && tp.param === h.consumerParam)) {
      // The planner already binds this param to a different producer — trust it.
      result.warnings.push(
        `${h.consumerTool}.${h.consumerParam} also looks sourced from ${h.producerTool}; keeping the planner's binding`,
      );
      continue;
    }
    if (!h.nameable) {
      // An opaque JSPB slot we can't safely name — let the compile-time
      // chained-test gate enforce it (block) instead of injecting a junk contract.
      result.warnings.push(
        `detected ${h.consumerTool} <- ${h.producerTool} (recorded at ${h.producerPath}) but the consumer slot is an opaque path; leaving enforcement to the compile-time chained-test gate`,
      );
      continue;
    }
    // Inject a best-effort contract for a confidently-nameable missed edge. Name
    // the producer field after the clean consumer param (same logical value).
    const field = h.consumerParam;
    if (!producer.emitsTokens.some((e) => e && e.field === field)) {
      producer.emitsTokens.push({ field, shape: shapeNote(h) });
    }
    consumer.tokenParams.push({
      param: h.consumerParam,
      sourceTool: h.producerTool,
      sourceField: field,
    });
    result.injected++;
  }
  return result;
}

// ─── Planner payload ────────────────────────────────────────────────────────

interface BuildPlanRequestPayload {
  seq: number;
  timestamp: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  mimeType?: string;
  headers: string;
  body?: string;
  bodyDigest?: string;
  bodyLength?: number;
  responsePreview?: string;
  responseBodyDigest?: string;
  responseBodyLength?: number;
  repeatCount?: number;
  repeatedSeqs?: number[];
  lastTimestamp?: number;
}

interface BuildPlanPayload {
  site: string;
  url: string;
  narration: Array<{ timestamp: number; text: string }>;
  sharedContext?: SharedCompileContext;
  selectedTools: Array<{
    toolName: string;
    description: string;
    expectedOutput: string;
    requestSeqs: number[];
    dependencySeqs: number[];
    likelyParams: ToolCandidate['likelyParams'];
  }>;
  ephemeralValues: Array<{
    classification: string;
    originalSeq: number;
    location: string;
    producerSeq?: number;
    producerPath?: string;
    suggestedStateName?: string;
  }>;
  /** Producer→consumer opaque-token edges detected deterministically from the
   *  dual-pass diff (see `deriveTokenContractHints`). Fed to the planner as
   *  grounded contracts to declare. */
  tokenContractHints: TokenContractHint[];
  requests: BuildPlanRequestPayload[];
}

export function buildBuildPlanPayload(opts: {
  session: Session;
  candidates: ToolCandidate[];
  sharedContext?: SharedCompileContext;
  classifications?: ClassifiedValue[];
}): BuildPlanPayload {
  const { session, candidates, sharedContext, classifications } = opts;

  const scope = new Set<number>();
  for (const c of candidates) {
    for (const s of c.requestSeqs) scope.add(s);
    for (const s of c.dependencySeqs) scope.add(s);
  }
  for (const s of sharedContext?.loginRequestSeqs ?? []) scope.add(s);

  // Compact WITHOUT preserveSeqs so identical requests shared across tools
  // collapse into one row — a strong signal for a shared module candidate.
  const requests = compactRequestContexts(
    session.requests
      .filter((r) => scope.has(r.seq))
      .map((r) => ({
        seq: r.seq,
        timestamp: r.timestamp,
        method: r.method,
        url: r.url,
        resourceType: r.resourceType,
        status: r.response?.status,
        mimeType: r.response?.mimeType,
        headers: truncate(JSON.stringify(r.headers), HEADER_LIMIT) ?? '{}',
        body: truncate(r.body, BODY_LIMIT),
        bodyDigest: requestContextDigest(r.body),
        bodyLength: r.body?.length,
        responsePreview: truncate(r.response?.body, RESPONSE_PREVIEW_LIMIT),
        responseBodyDigest: requestContextDigest(r.response?.body),
        responseBodyLength: r.response?.body?.length,
      })),
    buildPlanRequestGroupKey,
  );

  const ephemeralValues = (classifications ?? [])
    // Non-constant values, plus stable constants that carry recovered producer
    // provenance (server-provided per-entity tokens) — both are signals for the planner.
    .filter((c) => c.classification !== 'constant' || c.producerSeq != null)
    .map((c) => ({
      classification: c.classification,
      originalSeq: c.originalSeq,
      location: c.location,
      producerSeq: c.producerSeq,
      producerPath: c.producerPath,
      suggestedStateName: c.suggestedStateName,
    }));

  const selectedTools = candidates.map((c) => ({
    toolName: c.toolName,
    description: c.description,
    expectedOutput: c.expectedOutput,
    requestSeqs: c.requestSeqs,
    dependencySeqs: c.dependencySeqs,
    likelyParams: c.likelyParams,
  }));

  return {
    site: session.site,
    url: session.url,
    narration: session.narration.map((n) => ({ timestamp: n.timestamp, text: n.text })),
    sharedContext,
    selectedTools,
    ephemeralValues,
    // Detect from the FULL classifications (incl. the value, for the opacity gate);
    // the payload's `ephemeralValues` stays slim (no raw value sent to the planner).
    tokenContractHints: deriveTokenContractHints({
      selectedTools,
      // Any classification carrying producer provenance — server_derived OR a
      // stable constant whose opaque value was found in a sibling response.
      ephemeralValues: (classifications ?? [])
        .filter((c) => c.producerSeq != null)
        .map((c) => ({
          classification: c.classification,
          originalSeq: c.originalSeq,
          location: c.location,
          producerSeq: c.producerSeq,
          producerPath: c.producerPath,
          value: c.value1,
        })),
    }),
    requests,
  };
}

function buildPlanRequestGroupKey(request: BuildPlanRequestPayload): unknown[] {
  return [
    request.method,
    request.url,
    request.bodyDigest,
    request.bodyLength,
    request.status,
    request.mimeType,
    request.responseBodyDigest,
    request.responseBodyLength,
  ];
}

// ─── Generation ─────────────────────────────────────────────────────────────

interface GenerateBuildPlanResult extends BuildPlan {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export async function generateBuildPlan(opts: {
  session: Session;
  candidates: ToolCandidate[];
  sharedContext?: SharedCompileContext;
  classifications?: ClassifiedValue[];
  llmConfig?: LLMOptions;
  /** Wall-clock cap on the planner LLM call. On timeout the span is closed with
   *  `imprint.plan.timed_out` + ERROR and a TimeoutError is thrown for the caller
   *  to degrade. Omit/0 to wait indefinitely. */
  timeoutMs?: number;
}): Promise<GenerateBuildPlanResult> {
  return await traced(
    'teach.plan_prereqs',
    'AGENT',
    {
      'imprint.site': opts.session.site,
      'imprint.provider': opts.llmConfig?.provider ?? 'auto',
      'imprint.tool_count': opts.candidates.length,
    },
    async (span) => {
      const promptPath = pathJoin(PROMPTS_DIR, 'build-planning.md');
      if (!existsSync(promptPath)) {
        throw new Error(
          `Build-planning prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
        );
      }
      const systemPrompt = readFileSync(promptPath, 'utf8');
      const payload = buildBuildPlanPayload(opts);
      const payloadJson = JSON.stringify(payload);

      // Record input size on the span BEFORE the call, so a timed-out or slow
      // planning session is still debuggable on Phoenix (the success block below
      // never runs on timeout). A large ephemeral_count is the usual bloat cause.
      setSpanAttributes(span, {
        'imprint.plan.request_count': payload.requests.length,
        'imprint.plan.ephemeral_count': payload.ephemeralValues.length,
        'imprint.plan.narration_count': payload.narration.length,
        'imprint.plan.payload_chars': payloadJson.length,
        'imprint.plan.prompt_chars': systemPrompt.length,
        'imprint.plan.timeout_ms': opts.timeoutMs ?? 0,
      });
      log(
        `planning ${opts.candidates.length} tool(s): ${payload.requests.length} request(s), ${payload.ephemeralValues.length} ephemeral value(s), ${payload.tokenContractHints.length} token edge(s), ${payload.narration.length} narration line(s); ${Math.round(payloadJson.length / 1024)} KB payload + ${Math.round(systemPrompt.length / 1024)} KB prompt → ${opts.llmConfig?.provider ?? 'auto'}/${opts.llmConfig?.model ?? 'default'}${opts.timeoutMs ? ` (timeout ${Math.round(opts.timeoutMs / 1000)}s)` : ''}`,
      );

      const llm = resolveProvider(opts.llmConfig ?? {});
      const llmStart = Date.now();
      log('calling planner LLM…');
      let result: Awaited<ReturnType<typeof llm.analyze>>;
      try {
        const call = llm.analyze(systemPrompt, payload);
        result = opts.timeoutMs
          ? await withTimeout(call, opts.timeoutMs, 'build planner')
          : await call;
      } catch (err) {
        const elapsedMs = Date.now() - llmStart;
        const timedOut = err instanceof TimeoutError;
        setSpanAttributes(span, {
          'imprint.plan.timed_out': timedOut,
          'imprint.plan.llm_elapsed_ms': elapsedMs,
        });
        log(
          `planner LLM ${timedOut ? 'timed out' : 'failed'} after ${Math.round(elapsedMs / 1000)}s: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      log(
        `planner LLM returned in ${Math.round((Date.now() - llmStart) / 1000)}s (in=${result.inputTokens ?? '?'}, out=${result.outputTokens ?? '?'} tokens, ${result.text.length} chars)`,
      );
      const objectText = extractJsonObject(result.text);
      if (!objectText) {
        throw new Error(
          `Build planner did not return a JSON object.\nRaw response:\n${result.text.slice(0, 1000)}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(objectText);
      } catch (err) {
        throw new Error(
          `Build planner response was not valid JSON: ${err instanceof Error ? err.message : String(err)}\nExtracted:\n${objectText.slice(0, 1000)}`,
        );
      }

      // Deterministic safety net: reconcile the planner's plan against the
      // grounded token edges before validation, so a planner shortcut can't drop
      // or half-declare a cross-tool contract (the original defect this fixes).
      const selectedNames = new Set(opts.candidates.map((c) => c.toolName));
      const reconciled = reconcileTokenContracts(parsed, payload.tokenContractHints, selectedNames);
      if (reconciled.injected > 0 || reconciled.repaired > 0) {
        log(
          `token contracts: ${payload.tokenContractHints.length} edge(s) detected → injected ${reconciled.injected}, repaired ${reconciled.repaired}`,
        );
      }
      for (const w of reconciled.warnings) log(`token contract: ${w}`);

      const plan = validateBuildPlan(parsed, opts.candidates);
      setSpanAttributes(span, {
        'imprint.plan.token_edge_count': payload.tokenContractHints.length,
        'imprint.plan.token_injected': reconciled.injected,
        'imprint.plan.token_repaired': reconciled.repaired,
        'imprint.plan.shared_module_count': plan.sharedModules.length,
        'imprint.plan.tool_count': plan.perTool.length,
        'imprint.plan.duration_ms': result.durationMs,
        'imprint.plan.input_tokens': result.inputTokens,
        'imprint.plan.output_tokens': result.outputTokens,
      });
      return {
        ...plan,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
      };
    },
  );
}

// ─── Sidecar persistence ────────────────────────────────────────────────────

/** Site-level sidecar holding the full plan. Each compile driver loads it by
 *  path and reads only its tool's slice — far cheaper than threading a large
 *  plan through CLI spawn args. Modeled on the `.classifications.json` sidecar. */
export function buildPlanSidecarPath(site: string): string {
  return pathJoin(localSiteDir(site), '.build-plan.json');
}

export function writeBuildPlanSidecar(site: string, plan: BuildPlan): string {
  const path = buildPlanSidecarPath(site);
  mkdirSync(localSiteDir(site), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return path;
}

// ─── Local helpers ──────────────────────────────────────────────────────────

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}
