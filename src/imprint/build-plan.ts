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
import { detectPageMintedHeaders } from './redact.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { type ClassifiedValue, looksLikeToken } from './session-diff.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import { TwoFactorTypeSchema } from './types.ts';
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

// ─── General dependency contract (requiredInputs) ─────────────────────────────

/** Where an input ultimately comes from. The general superset of the legacy
 *  opaque-token chain: `producer_tool` is one source among several. */
const InputSourceSchema = z.enum([
  'user_param', // a value the caller supplies as an MCP tool param
  'producer_tool', // an opaque token minted by a sibling tool's response
  'auth', // a durable session token captured by the authenticate tool
  'browser_state', // a value an earlier response / the originating page mints
  'generated', // a fresh per-call value (uuid / epoch / nonce …)
  'static', // a recording-stable constant (NEVER a raw secret)
]);

/** How the input is wired into workflow.json at the recorded `location`. */
const InputWiringSchema = z.enum([
  'param', // ${param.X}
  'credential', // ${credential.X}
  'state', // ${state.X}
  'response', // ${response[N].path}
  'generated', // ${generated.KIND}
  'literal', // verbatim literal (static / generated fallback)
]);

/** Shape of a per-call generated value, inferred from the recorded value's form. */
const GeneratedKindSchema = z.enum(['uuid', 'epoch_ms', 'epoch_s', 'iso8601', 'nonce']).optional();
type GeneratedKind = z.infer<typeof GeneratedKindSchema>;

/** ONE input a tool's request needs and where it comes from — covering EVERY
 *  dependency class, not just cross-tool tokens: a user param, a producer tool's
 *  output, an auth/session token, browser/bootstrap state, a generated per-call
 *  value, or a static constant. This is the general contract the planner declares
 *  and the deriver grounds from the recording, replacing the header-blind
 *  "keep headers minimal" heuristic that dropped auth/session inputs. */
const RequiredInputSchema = z.object({
  /** "header:<name>" | "url_param:<k>" | "body:$.<path>" | "referer". */
  location: z.string().min(1),
  source: InputSourceSchema,
  wiring: InputWiringSchema,
  /** user_param / param-wired → the MCP param name. */
  param: z.string().optional(),
  /** producer_tool → sibling tool that mints this value … */
  producerTool: z.string().optional(),
  /** … and the field of its parser output to read. */
  producerField: z.string().optional(),
  /** auth → resolves to ${credential.<credentialName>} (an authTool capture). */
  credentialName: z.string().optional(),
  /** browser_state → resolves to ${state.<stateName>}. */
  stateName: z.string().optional(),
  /** generated → the per-call shape. */
  generated: GeneratedKindSchema,
  /** static / generated fallback — a verbatim literal. NEVER a raw secret. */
  literal: z.string().optional(),
  /** browser_state / referer → the originating page to bootstrap from. */
  bootstrapUrl: z.string().optional(),
  /** The recorded seq this input was observed on (grounds the deriver + the
   *  emit-time guard's value→placeholder map). */
  recordedSeq: z.number().int().nonnegative().optional(),
  note: z.string().default(''),
});
export type RequiredInput = z.infer<typeof RequiredInputSchema>;

const PerToolPlanSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/),
  usesSharedModules: z.array(z.string()).default([]),
  loadBearingSeqs: z.array(z.number().int().nonnegative()).default([]),
  parserGuidance: z.string().default(''),
  paramChecklist: z.array(z.string()).default([]),
  authRecipe: AuthRecipeSchema,
  dependsOnAuth: z.boolean().optional(),
  /** Opaque-token chain — producer side: fields this tool's parser must emit for
   *  sibling consumers. */
  emitsTokens: z.array(EmittedTokenSchema).default([]),
  /** Opaque-token chain — consumer side: params minted by a sibling producer. */
  tokenParams: z.array(TokenParamSchema).default([]),
  /** General dependency contract: EVERY input this tool's request needs and where
   *  each comes from (auth / producer / browser_state / generated / static / user
   *  param). `producer_tool` entries are kept in sync with the legacy
   *  `tokenParams`/`emitsTokens` arrays by `validateBuildPlan`. */
  requiredInputs: z.array(RequiredInputSchema).default([]),
});
type PerToolPlan = z.infer<typeof PerToolPlanSchema>;

export const AuthToolPlanSchema = z
  .object({
    toolName: z.string(),
    loginRequestSeqs: z.array(z.number().int().nonnegative()),
    twoFactorRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
    twoFactorType: TwoFactorTypeSchema,
    /** OTP only: initiate-response field names the completion request chains via
     *  ${state.X} (structural, from the recording). */
    twoFactorContext: z.array(z.string()).default([]),
    credentialNames: z.array(z.string()).default([]),
    captures: z.array(AuthCaptureSchema).default([]),
    notes: z.string().default(''),
  })
  .optional();
export type AuthToolPlan = z.infer<typeof AuthToolPlanSchema>;

export const BuildPlanSchema = z
  .object({
    sharedModules: z.array(SharedModuleSpecSchema).default([]),
    perTool: z.array(PerToolPlanSchema).min(1),
    authTool: AuthToolPlanSchema,
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
    // General dependency contract validation. `validateBuildPlan` backfills the
    // producer_tool ⇄ tokenParams/emitsTokens duals and the auth ⇄ authTool
    // captures BEFORE parse, so these cross-references hold for every plan that
    // reaches the schema (LLM-emitted or read from a written sidecar).
    const authCaptureNames = new Set((value.authTool?.captures ?? []).map((c) => c.name));
    for (const [i, t] of value.perTool.entries()) {
      for (const [j, ri] of t.requiredInputs.entries()) {
        const at = (field: string) => ['perTool', i, 'requiredInputs', j, field];
        const fail = (field: string, message: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: at(field), message });
        switch (ri.source) {
          case 'user_param':
            if (!ri.param)
              fail('param', `requiredInput at ${ri.location} (user_param) needs a param`);
            break;
          case 'producer_tool':
            if (!ri.producerTool) {
              fail(
                'producerTool',
                `requiredInput at ${ri.location} (producer_tool) needs a producerTool`,
              );
            } else if (ri.producerTool === t.toolName) {
              fail(
                'producerTool',
                `requiredInput at ${ri.location} cannot source from its own tool "${t.toolName}"`,
              );
            } else if (!toolNames.has(ri.producerTool)) {
              fail(
                'producerTool',
                `requiredInput at ${ri.location} references unknown producer tool "${ri.producerTool}"`,
              );
            } else if (
              ri.producerField &&
              !emittedByTool.get(ri.producerTool)?.has(ri.producerField)
            ) {
              fail(
                'producerField',
                `producer "${ri.producerTool}" does not declare emitted field "${ri.producerField}" (add it to that tool's emitsTokens)`,
              );
            }
            break;
          case 'auth':
            if (!ri.credentialName) {
              fail(
                'credentialName',
                `requiredInput at ${ri.location} (auth) needs a credentialName`,
              );
            } else if (!authCaptureNames.has(ri.credentialName)) {
              fail(
                'credentialName',
                `auth requiredInput at ${ri.location} references "${ri.credentialName}" which is not declared in authTool.captures[].name`,
              );
            }
            break;
          case 'browser_state':
            // The bootstrap-page (referer) case carries a bootstrapUrl instead of a
            // substitutable ${state.X}; any other browser_state slot needs a stateName.
            if (ri.location !== 'referer' && !ri.stateName) {
              fail(
                'stateName',
                `requiredInput at ${ri.location} (browser_state) needs a stateName`,
              );
            }
            break;
          case 'generated':
            if (!ri.generated)
              fail(
                'generated',
                `requiredInput at ${ri.location} (generated) needs a generated kind`,
              );
            break;
          case 'static':
            if (ri.literal === undefined)
              fail('literal', `requiredInput at ${ri.location} (static) needs a literal`);
            break;
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

/** Kahn layering shared by topoLevels (shared modules) and topoLevelsForTools.
 *  Groups items into dependency "levels": level 0 has no in-set dependency, each
 *  later level's deps are satisfied by earlier levels. Items within a level are
 *  mutually independent (safe to build/compile concurrently); no item precedes
 *  one it depends on. Cycle-safe — any residual cycle members are appended as a
 *  final level so nothing is silently dropped. Edges to ids outside `items`, and
 *  self-edges, are ignored. */
function kahnLevels<T>(
  items: T[],
  idOf: (item: T) => string,
  depsOf: (item: T) => Iterable<string>,
): T[][] {
  const ids = new Set(items.map(idOf));
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of items) {
    const id = idOf(item);
    const deps = [...depsOf(item)].filter((d) => d !== id && ids.has(d));
    indegree.set(id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep);
      if (list) list.push(id);
      else dependents.set(dep, [id]);
    }
  }

  const levels: T[][] = [];
  const placed = new Set<string>();
  let frontier = items.filter((item) => (indegree.get(idOf(item)) ?? 0) === 0);
  while (frontier.length > 0) {
    levels.push(frontier);
    for (const item of frontier) placed.add(idOf(item));
    const next: T[] = [];
    for (const item of frontier) {
      for (const depId of dependents.get(idOf(item)) ?? []) {
        const remaining = (indegree.get(depId) ?? 0) - 1;
        indegree.set(depId, remaining);
        if (remaining === 0) {
          const dependent = byId.get(depId);
          if (dependent) next.push(dependent);
        }
      }
    }
    frontier = next;
  }

  // Defensive: an unexpected cycle would leave members unplaced — append them so
  // nothing is dropped (cycles are already rejected at parse time).
  const leftover = items.filter((item) => !placed.has(idOf(item)));
  if (leftover.length > 0) levels.push(leftover);
  return levels;
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
  return kahnLevels(
    modules,
    (m) => m.path,
    (m) => m.dependsOn,
  );
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
 *  not emit a declared field. Empty when the plan declared none. Internal —
 *  reached through `resolvePlanSliceFromFile`. */
function resolveEmittedTokens(
  plan: BuildPlan,
  toolName: string,
): Array<{ field: string; shape: string }> {
  return plan.perTool.find((t) => t.toolName === toolName)?.emitsTokens ?? [];
}

/** The general dependency contract the build plan declared for a tool — EVERY
 *  input its request needs and where each comes from. Threaded into the compile
 *  agent (read_build_plan) and the verifier (`injectContractedInputs` + the
 *  contracted-input gate). Empty when the plan declared none, so a tool that
 *  needs no extra inputs behaves exactly as before. */
export function resolveRequiredInputs(plan: BuildPlan, toolName: string): RequiredInput[] {
  return plan.perTool.find((t) => t.toolName === toolName)?.requiredInputs ?? [];
}

/** Read a build-plan sidecar and project it to one tool's slice in the shape
 *  every compile driver needs: the shared modules it must import (with verified
 *  flags from `manifest`) plus the producer/consumer token-contract arrays.
 *  Returns empty values when no plan path / tool name is supplied or the sidecar
 *  is missing/invalid — so a driver with no build plan behaves exactly as before.
 *  Shared by the in-process loop, the MCP compile server, and both CLI drivers. */
export function resolvePlanSliceFromFile(
  buildPlanPath: string | undefined,
  toolName: string | undefined,
  manifest?: SharedModuleManifestEntry[],
): {
  assignedSharedModules: AssignedSharedModule[] | undefined;
  tokenParams: Array<{ param: string; sourceTool: string; sourceField: string }>;
  emittedTokens: Array<{ field: string; shape: string }>;
  requiredInputs: RequiredInput[];
} {
  const plan = buildPlanPath && toolName ? readBuildPlanFile(buildPlanPath) : null;
  if (!plan || !toolName) {
    return {
      assignedSharedModules: undefined,
      tokenParams: [],
      emittedTokens: [],
      requiredInputs: [],
    };
  }
  return {
    assignedSharedModules: resolveAssignedModules(plan, toolName, manifest),
    tokenParams: resolveTokenParams(plan, toolName),
    emittedTokens: resolveEmittedTokens(plan, toolName),
    requiredInputs: resolveRequiredInputs(plan, toolName),
  };
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
  return kahnLevels(
    tools,
    (t) => t.toolName,
    (t) => {
      if (!plan) return [];
      const deps = new Set<string>();
      for (const tp of resolveTokenParams(plan, t.toolName)) deps.add(tp.sourceTool);
      // General contract edges: a producer_tool input depends on its producer; any
      // auth input depends on the authenticate tool (filtered out by kahnLevels
      // when the auth tool isn't in `tools` — auth runs in teach's own phase, this
      // is belt-and-suspenders so a co-scheduled auth tool still orders first).
      for (const ri of resolveRequiredInputs(plan, t.toolName)) {
        if (ri.source === 'producer_tool' && ri.producerTool) deps.add(ri.producerTool);
        if (ri.source === 'auth' && plan.authTool?.toolName) deps.add(plan.authTool.toolName);
      }
      return deps;
    },
  );
}

/** Load a build plan from an explicit file path (the sidecar threaded into the
 *  compile drivers). Returns null on missing/invalid file. */
export function readBuildPlanFile(path: string): BuildPlan | null {
  if (!existsSync(path)) return null;
  try {
    // Route through normalizeRawPlan so a hand-edited / version-skewed sidecar with
    // one malformed requiredInput drops only that row instead of failing the whole
    // plan to null (the sidecar is a documented, user-inspectable artifact).
    return BuildPlanSchema.parse(normalizeRawPlan(JSON.parse(readFileSync(path, 'utf8'))));
  } catch {
    return null;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/* biome-ignore lint/suspicious/noExplicitAny: raw, pre-schema plan normalization */
type RawAny = any;

/**
 * Normalize a RAW (pre-schema) plan object so the general dependency contract is
 * internally consistent before `BuildPlanSchema.parse` runs its cross-tool
 * `superRefine`. Two jobs, both total (never throws — degrades instead):
 *  1. Backfill the producer_tool ⇄ legacy `tokenParams`/`emitsTokens` duals so a
 *     planner that declared only `requiredInputs` (or only the legacy arrays)
 *     still validates and the fan-out ordering sees the edge.
 *  2. Drop a `requiredInput` that can't be made schema-valid (e.g. a producer_tool
 *     row pointing at an unknown tool, an auth row with no matching capture, a
 *     generated row with no kind) so one malformed hint can't throw the whole plan
 *     away — the grounded ones are re-injected by `reconcileRequiredInputs`.
 * Returns a deep clone; the caller's input is never mutated.
 */
function normalizeRawPlan(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  let cloned: RawAny;
  try {
    cloned = JSON.parse(JSON.stringify(input));
  } catch {
    return input;
  }
  const perTool: RawAny[] = Array.isArray(cloned.perTool) ? cloned.perTool : [];
  const byName = new Map<string, RawAny>();
  for (const t of perTool) {
    if (t && typeof t.toolName === 'string') byName.set(t.toolName, t);
  }
  const authCaptureNames = new Set<string>(
    (Array.isArray(cloned.authTool?.captures) ? cloned.authTool.captures : [])
      .map((c: RawAny) => (c && typeof c.name === 'string' ? c.name : ''))
      .filter(Boolean),
  );
  const ensureArr = (obj: RawAny, key: string): RawAny[] => {
    if (!Array.isArray(obj[key])) obj[key] = [];
    return obj[key];
  };

  for (const t of perTool) {
    if (!t || typeof t.toolName !== 'string') continue;
    if (!Array.isArray(t.requiredInputs)) continue;
    const kept: RawAny[] = [];
    for (const ri of t.requiredInputs) {
      if (!ri || typeof ri !== 'object' || typeof ri.location !== 'string') continue;
      switch (ri.source) {
        case 'user_param':
          if (typeof ri.param !== 'string' || !ri.param) continue;
          break;
        case 'producer_tool': {
          const producerTool = ri.producerTool;
          // producerField is OPTIONAL in the schema — only the producer tool must be
          // a real sibling. Keep a producerField-less row (it still carries the
          // build-order edge in topoLevelsForTools); only the legacy-dual backfill
          // needs the field.
          if (
            typeof producerTool !== 'string' ||
            !producerTool ||
            producerTool === t.toolName ||
            !byName.has(producerTool)
          )
            continue;
          const producerField = ri.producerField;
          if (typeof producerField === 'string' && producerField) {
            // Backfill the legacy duals so the edge survives the gate too.
            const param = typeof ri.param === 'string' && ri.param ? ri.param : producerField;
            const tokenParams = ensureArr(t, 'tokenParams');
            if (
              !tokenParams.some(
                (tp: RawAny) => tp && tp.param === param && tp.sourceTool === producerTool,
              )
            ) {
              tokenParams.push({ param, sourceTool: producerTool, sourceField: producerField });
            }
            const producer = byName.get(producerTool);
            const emits = ensureArr(producer, 'emitsTokens');
            if (!emits.some((e: RawAny) => e && e.field === producerField)) {
              emits.push({
                field: producerField,
                shape: typeof ri.note === 'string' ? ri.note : '',
              });
            }
          }
          break;
        }
        case 'auth':
          if (typeof ri.credentialName !== 'string' || !authCaptureNames.has(ri.credentialName))
            continue;
          break;
        case 'browser_state':
          if (ri.location !== 'referer' && (typeof ri.stateName !== 'string' || !ri.stateName))
            continue;
          break;
        case 'generated':
          if (typeof ri.generated !== 'string') continue;
          break;
        case 'static':
          if (ri.literal === undefined) continue;
          break;
        default:
          continue; // unknown source
      }
      kept.push(ri);
    }
    t.requiredInputs = kept;
  }
  return cloned;
}

/** Stable order + dedupe for a tool's requiredInputs, so the written sidecar JSON
 *  is deterministic across runs. */
function dedupeSortRequiredInputs(inputs: RequiredInput[]): RequiredInput[] {
  const seen = new Set<string>();
  const out: RequiredInput[] = [];
  for (const ri of inputs) {
    const key = `${ri.location}|${ri.source}|${ri.wiring}|${ri.param ?? ''}|${ri.producerTool ?? ''}|${ri.producerField ?? ''}|${ri.credentialName ?? ''}|${ri.stateName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ri);
  }
  out.sort((a, b) => a.location.localeCompare(b.location) || a.source.localeCompare(b.source));
  return out;
}

/** Parse + normalize an LLM/disk plan. When `selected` is provided, drops
 *  perTool entries for tools that weren't selected and backfills a minimal
 *  entry for any selected tool the planner omitted, so the fan-out always has
 *  a slice for every tool it will compile. */
export function validateBuildPlan(
  input: unknown,
  selected?: Array<ToolCandidate | string>,
): BuildPlan {
  const plan = BuildPlanSchema.parse(normalizeRawPlan(input));
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
  // Deterministic requiredInputs ordering for stable sidecar JSON.
  for (const t of plan.perTool) {
    t.requiredInputs = dedupeSortRequiredInputs(t.requiredInputs);
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

// ─── General dependency-contract derivation (all sources) ─────────────────────

/** A grounded `requiredInput` derived DETERMINISTICALLY from the recording, plus
 *  the consumer tool it belongs to and (for auth) the authTool capture to ensure
 *  exists. The general analogue of `TokenContractHint` — covering auth / browser
 *  state / generated / static inputs, not just cross-tool tokens. */
export interface RequiredInputHint {
  consumerTool: string;
  input: RequiredInput;
  /** auth only: the authenticate-tool capture that mints this value. Ensures the
   *  superRefine auth↔capture invariant holds even if the planner drops it. */
  authCapture?: { name: string; source: string; locator: string; usedAs: string };
}

/** Snake_case identifier for a credential/state name, preferring a precomputed
 *  `suggestedStateName` from the diff, else derived from the `location`. */
function nameFromLocationOrSuggestion(location: string, suggested?: string): string {
  if (suggested?.length) return toIdentifier(suggested);
  const raw = location
    .replace(/^(url_param|header|body):?/, '')
    .replace(/^\$\.?/, '')
    .replace(/^x-/i, '');
  const ident = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return ident || 'token';
}

/** Best-effort auth capture (source + locator) from a producer response path
 *  ("$.access_token" → json; "response_header:Set-Cookie" → response_header). The
 *  auth-compile agent refines/verifies this live; the deriver only seeds it so the
 *  capture name exists for the data tool's ${credential.X} reference. */
function authCaptureFromProducerPath(
  name: string,
  producerPath: string | undefined,
  usedAs: string,
): { name: string; source: string; locator: string; usedAs: string } {
  const path = producerPath ?? '';
  if (path.startsWith('response_header:')) {
    return {
      name,
      source: 'response_header',
      locator: path.slice('response_header:'.length),
      usedAs,
    };
  }
  if (path.startsWith('$')) {
    return { name, source: 'json', locator: path, usedAs };
  }
  // "body(substring)" / unknown — seed a json capture; the auth agent verifies live.
  return { name, source: 'json', locator: path || '$', usedAs };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Infer the per-call shape of a `browser_minted` value from its form. Returns a
 *  GeneratedKind, or null when no recognizable shape (caller falls back to a
 *  captured browser_state). Site-agnostic — by VALUE shape, never a header name. */
function generatedKindOf(value: string | undefined): NonNullable<GeneratedKind> | null {
  if (!value) return null;
  if (UUID_RE.test(value)) return 'uuid';
  if (ISO8601_RE.test(value)) return 'iso8601';
  if (/^\d{13}$/.test(value)) return 'epoch_ms';
  if (/^\d{10}$/.test(value)) return 'epoch_s';
  if (looksLikeToken(value) && /^[A-Za-z0-9._-]+$/.test(value)) return 'nonce';
  return null;
}

function isCookieHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cookie' || lower === 'set-cookie';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The page a request was issued from — its `Referer` header, else the last
 *  recorded Document `navigation` before it. Structural generalization of the
 *  bootstrap-page heuristic the auth compile prompt uses (no host literals).
 *  Returns undefined when neither signal is available. */
export function findOriginatingPage(session: Session, seq: number): string | undefined {
  const req = session.requests.find((r) => r.seq === seq);
  if (!req) return undefined;
  const referer =
    req.headers.Referer ?? req.headers.referer ?? req.headers.Referrer ?? req.headers.referrer;
  if (referer && /^https?:\/\//i.test(referer)) return referer;
  let best: { ts: number; url: string } | undefined;
  for (const ev of session.events) {
    if (ev.type !== 'navigation' || ev.timestamp > req.timestamp) continue;
    if (!/^https?:\/\//i.test(ev.detail)) continue;
    if (!best || ev.timestamp > best.ts) best = { ts: ev.timestamp, url: ev.detail };
  }
  return best?.url;
}

/**
 * Deterministically derive the general dependency contract — EVERY non-param input
 * a tool needs and where each comes from — from the dual-pass classifications, the
 * login flow, and the recorded headers. The structural cure for the header-blind
 * "keep headers minimal" heuristic that silently dropped auth/session/gateway
 * inputs. Pure; mirrors `deriveTokenContractHints` but is header-AWARE and never
 * emits a user `param` for a header.
 *
 * Source rules (purely structural — classification + provenance + value shape,
 * never a header name or URL pattern):
 *  - value produced by the LOGIN flow's response (`producerSeq ∈ loginRequestSeqs`)
 *    → `auth` (wired `${credential.X}`), seeding the authenticate-tool capture;
 *  - cross-tool `server_derived` (producer owned by another selected tool)
 *    → `producer_tool` (delegated to `deriveTokenContractHints`, re-tagged);
 *  - `browser_minted` header with no network producer → `browser_state` when the
 *    value is reused across the session, else `generated` (kind from value shape),
 *    falling back to `browser_state` when no shape is recognizable. Ephemerality is
 *    aggregated per slot (most-ephemeral-wins): a sibling `browser_minted` instance
 *    overrides an alignment-artifact `constant`, and a `constant` whose value is
 *    intrinsically per-call by shape (uuid/epoch/iso8601) or is server-minted
 *    elsewhere is routed to `generated`/`browser_state`, never baked as a literal;
 *  - high-entropy `constant` header with no provenance → `static` (verbatim literal);
 *  - page-minted sensitive headers (app constants present before first interaction)
 *    → `static`, even when the blocked replay produced no classification for them.
 * Cookies are excluded throughout (the credential jar manages them automatically).
 */
export function deriveRequiredInputHints(payload: {
  selectedTools: Array<{
    toolName: string;
    requestSeqs: number[];
    likelyParams?: Array<{ name: string }>;
  }>;
  loginRequestSeqs: number[];
  ephemeralValues: Array<{
    classification: string;
    originalSeq: number;
    location: string;
    producerSeq?: number;
    producerPath?: string;
    value?: string;
    suggestedStateName?: string;
  }>;
  recordedHeaders: Array<{
    seq: number;
    /** The request's own URL (for the cross-origin bootstrap check). */
    url?: string;
    /** The page this request was issued from (Referer / last navigation). */
    originatingUrl?: string;
    headers: Record<string, string>;
  }>;
  pageMintedHeaders: string[];
}): RequiredInputHint[] {
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
  const loginSeqs = new Set(payload.loginRequestSeqs);

  const hints: RequiredInputHint[] = [];
  const seen = new Set<string>(); // consumerTool|location — one decision per slot
  const push = (h: RequiredInputHint): void => {
    const key = `${h.consumerTool}|${h.input.location}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(h);
  };

  // 1. Cross-tool opaque tokens → producer_tool params (reuse the existing
  //    detector; only nameable edges become params, matching reconcileTokenContracts).
  for (const th of deriveTokenContractHints({
    selectedTools: payload.selectedTools,
    ephemeralValues: payload.ephemeralValues,
  })) {
    if (!th.nameable) continue;
    push({
      consumerTool: th.consumerTool,
      input: {
        location: th.consumerLocation,
        source: 'producer_tool',
        wiring: 'param',
        param: th.consumerParam,
        producerTool: th.producerTool,
        producerField: th.producerField,
        note: '',
      },
    });
  }

  // Count value reuse per (header location → value) across in-scope requests so a
  // browser_minted value used in multiple requests is captured once, not regenerated.
  const headerValueCounts = new Map<string, number>();
  for (const rh of payload.recordedHeaders) {
    for (const [name, value] of Object.entries(rh.headers)) {
      const key = `header:${name}\t${value}`;
      headerValueCounts.set(key, (headerValueCounts.get(key) ?? 0) + 1);
    }
  }

  // Aggregate ephemerality per (consumerTool, location) BEFORE deciding. The
  // dual-pass diff classifies each instance independently, and request-alignment
  // artifacts can mislabel a single instance `constant` (when it happens to align
  // to a replay request carrying the same value) even though sibling instances of
  // the same header are `browser_minted`. Most-ephemeral-wins: if ANY instance of a
  // slot is browser_minted, the slot is ephemeral — so one mislabeled `constant`
  // instance can't route a per-call value into the static (baked-literal) branch.
  const browserMintedSlots = new Set<string>();
  for (const ev of payload.ephemeralValues) {
    if (ev.classification !== 'browser_minted') continue;
    const tool = soleOwner(ev.originalSeq);
    if (tool) browserMintedSlots.add(`${tool}\t${ev.location}`);
  }

  // Opaque token VALUES some response minted (a non-login producer). A value proven
  // server-derived anywhere is session/server state everywhere — never a bakeable
  // deploy constant — even at a sibling instance the diff happened to label
  // `constant` with no local producer. Gated on looksLikeToken so an incidental
  // low-entropy echo (a client-id string, a UI label) isn't swept in.
  const serverMintedTokenValues = new Set<string>();
  for (const ev of payload.ephemeralValues) {
    if (
      ev.producerSeq != null &&
      !loginSeqs.has(ev.producerSeq) &&
      ev.value &&
      looksLikeToken(ev.value)
    ) {
      serverMintedTokenValues.add(ev.value);
    }
  }

  // 2. Classification-driven rules.
  for (const ev of payload.ephemeralValues) {
    const consumerTool = soleOwner(ev.originalSeq);
    if (!consumerTool) continue;

    // auth — minted by the login flow's response (any NON-cookie location). A
    // login-minted value sent back as a Cookie persists automatically via the
    // credential jar, so it needs no ${credential.X} sessionCapture contract —
    // seeding one would wrongly fail the auth verifier and inject a Cookie header
    // on the data side.
    const evHeader = ev.location.toLowerCase().startsWith('header:')
      ? ev.location.slice('header:'.length)
      : '';
    if (ev.producerSeq != null && loginSeqs.has(ev.producerSeq) && !isCookieHeaderName(evHeader)) {
      const name = nameFromLocationOrSuggestion(ev.location, ev.suggestedStateName);
      push({
        consumerTool,
        input: {
          location: ev.location,
          source: 'auth',
          wiring: 'credential',
          credentialName: name,
          recordedSeq: ev.originalSeq,
          note: '',
        },
        authCapture: authCaptureFromProducerPath(name, ev.producerPath, ev.location),
      });
      continue;
    }

    // browser_state / generated / static apply to the commonly-dropped HEADER slots.
    if (!ev.location.toLowerCase().startsWith('header:')) continue;
    const headerName = ev.location.slice('header:'.length);
    if (isCookieHeaderName(headerName)) continue;

    // Ephemeral if THIS instance is browser_minted OR any sibling instance of the
    // same slot is (most-ephemeral-wins, see browserMintedSlots above).
    const ephemeral =
      ev.classification === 'browser_minted' ||
      browserMintedSlots.has(`${consumerTool}\t${ev.location}`);

    if (ephemeral) {
      const reused = (headerValueCounts.get(`${ev.location}\t${ev.value ?? ''}`) ?? 0) >= 2;
      const kind = generatedKindOf(ev.value);
      if (!reused && kind) {
        push({
          consumerTool,
          input: {
            location: ev.location,
            source: 'generated',
            wiring: 'generated',
            generated: kind,
            recordedSeq: ev.originalSeq,
            note: '',
          },
        });
      } else {
        const name = nameFromLocationOrSuggestion(ev.location, ev.suggestedStateName);
        push({
          consumerTool,
          input: {
            location: ev.location,
            source: 'browser_state',
            wiring: 'state',
            stateName: name,
            recordedSeq: ev.originalSeq,
            note: '',
          },
        });
      }
      continue;
    }

    if (
      ev.classification === 'constant' &&
      ev.producerSeq == null &&
      looksLikeToken(ev.value ?? '')
    ) {
      // A "constant"-classified header value reaches here only with no local
      // producer. Two structural vetoes keep a per-call or session value from being
      // baked as a verbatim literal — the bug class this contract exists to prevent.
      const kind = generatedKindOf(ev.value);
      const strongKind = kind != null && kind !== 'nonce'; // uuid / epoch_ms|s / iso8601
      if (strongKind) {
        // Intrinsically per-call by shape — a UUID/timestamp is never a deploy
        // constant, so a flat `constant` label here is an alignment artifact (the
        // replay never varied it). Generate fresh per call instead of baking.
        push({
          consumerTool,
          input: {
            location: ev.location,
            source: 'generated',
            wiring: 'generated',
            generated: kind,
            recordedSeq: ev.originalSeq,
            note: '',
          },
        });
      } else if (ev.value && serverMintedTokenValues.has(ev.value)) {
        // The same opaque value is server-minted elsewhere → session/server state
        // that expires; capture it live rather than shipping a dead literal.
        const name = nameFromLocationOrSuggestion(ev.location, ev.suggestedStateName);
        push({
          consumerTool,
          input: {
            location: ev.location,
            source: 'browser_state',
            wiring: 'state',
            stateName: name,
            recordedSeq: ev.originalSeq,
            note: '',
          },
        });
      } else {
        // Genuine high-entropy deploy constant: no per-call shape, no server
        // provenance — safe to emit verbatim.
        push({
          consumerTool,
          input: {
            location: ev.location,
            source: 'static',
            wiring: 'literal',
            literal: ev.value,
            recordedSeq: ev.originalSeq,
            note: '',
          },
        });
      }
    }
  }

  // 3. Page-minted sensitive headers (app constants) → static, even with no
  //    classification (the case the blocked replay never produces a diff for).
  const pageMinted = new Set(payload.pageMintedHeaders.map((h) => h.toLowerCase()));
  if (pageMinted.size > 0) {
    for (const rh of payload.recordedHeaders) {
      const consumerTool = soleOwner(rh.seq);
      if (!consumerTool) continue;
      for (const [name, value] of Object.entries(rh.headers)) {
        if (!pageMinted.has(name.toLowerCase()) || isCookieHeaderName(name)) continue;
        push({
          consumerTool,
          input: {
            location: `header:${name}`,
            source: 'static',
            wiring: 'literal',
            literal: value,
            recordedSeq: rh.seq,
            note: 'page-minted app constant',
          },
        });
      }
    }
  }

  // 4. Originating-page bootstrap. A tool that needs browser_state, or whose
  //    request runs CROSS-ORIGIN from the page it was issued on, must navigate
  //    that page first so its context / anti-bot token is minted for the right
  //    Origin. Emit ONE referer requiredInput per tool carrying the bootstrapUrl;
  //    the compile agent sets workflow.bootstrap.url (the injector backfills it).
  const toolsNeedingState = new Set(
    hints
      .filter((h) => h.input.source === 'browser_state' && h.input.location !== 'referer')
      .map((h) => h.consumerTool),
  );
  const bootstrapByTool = new Map<string, string>();
  for (const rh of payload.recordedHeaders) {
    const consumerTool = soleOwner(rh.seq);
    if (!consumerTool || !rh.originatingUrl || bootstrapByTool.has(consumerTool)) continue;
    const apiOrigin = rh.url ? originOf(rh.url) : null;
    const pageOrigin = originOf(rh.originatingUrl);
    const crossOrigin = apiOrigin != null && pageOrigin != null && apiOrigin !== pageOrigin;
    if (crossOrigin || toolsNeedingState.has(consumerTool)) {
      bootstrapByTool.set(consumerTool, rh.originatingUrl);
    }
  }
  for (const [consumerTool, bootstrapUrl] of bootstrapByTool) {
    push({
      consumerTool,
      input: {
        location: 'referer',
        source: 'browser_state',
        wiring: 'state',
        bootstrapUrl,
        note: 'originating page — navigate before API replay',
      },
    });
  }

  return hints;
}

/** Loose perTool shape for reconciling requiredInputs in place (mirrors
 *  `LoosePerToolPlan` but for the general contract). */
interface LooseRequiredInputPerTool {
  toolName: string;
  authRecipe?: unknown;
  requiredInputs?: Array<Record<string, unknown>>;
}

/**
 * Reconcile a parsed planner plan against the deterministically-derived
 * requiredInput hints, IN PLACE, before validation — the general analogue of
 * `reconcileTokenContracts`. One decision per (consumerTool, location) slot:
 *  - if the planner already declared an input for that slot, trust it (only seed a
 *    missing auth capture so the superRefine invariant holds);
 *  - else inject the grounded hint so a planner shortcut can't drop an input the
 *    recording proves the request needs.
 * Auth hints also ensure `authTool.captures` carries the minting capture. No-op
 * when `hints` is empty, so sites needing no extra inputs behave exactly as before.
 */
export function reconcileRequiredInputs(
  parsed: unknown,
  hints: RequiredInputHint[],
  selectedToolNames: Set<string>,
): { injected: number; repaired: number; warnings: string[] } {
  const result = { injected: 0, repaired: 0, warnings: [] as string[] };
  if (hints.length === 0 || typeof parsed !== 'object' || parsed === null) return result;
  const obj = parsed as {
    perTool?: LooseRequiredInputPerTool[];
    authTool?: { captures?: Array<Record<string, unknown>> } | null;
  };
  if (!Array.isArray(obj.perTool)) obj.perTool = [];
  const byName = new Map<string, LooseRequiredInputPerTool>();
  for (const t of obj.perTool) {
    if (t && typeof t.toolName === 'string') byName.set(t.toolName, t);
  }
  const ensure = (name: string): LooseRequiredInputPerTool => {
    let e = byName.get(name);
    if (!e) {
      e = { toolName: name, authRecipe: {} };
      obj.perTool?.push(e);
      byName.set(name, e);
    }
    return e;
  };
  const ensureAuthCapture = (cap: NonNullable<RequiredInputHint['authCapture']>): void => {
    if (!obj.authTool || typeof obj.authTool !== 'object') return; // no auth tool — can't seed
    if (!Array.isArray(obj.authTool.captures)) obj.authTool.captures = [];
    if (!obj.authTool.captures.some((c) => c && c.name === cap.name)) {
      obj.authTool.captures.push({ ...cap });
      result.repaired++;
    }
  };

  for (const h of hints) {
    if (!selectedToolNames.has(h.consumerTool)) continue;
    // An auth hint with no auth tool in the plan can't be honored — skip (degrades
    // to the legacy no-contract behavior rather than producing an invalid plan).
    if (h.input.source === 'auth' && !obj.authTool) {
      result.warnings.push(
        `${h.consumerTool} needs an auth input at ${h.input.location} but the plan declares no authenticate tool; leaving it to the compile-time gate`,
      );
      continue;
    }
    const tool = ensure(h.consumerTool);
    if (!Array.isArray(tool.requiredInputs)) tool.requiredInputs = [];
    const existing = tool.requiredInputs.find((ri) => ri && ri.location === h.input.location);
    if (existing) {
      // Slot already declared — trust the planner; only seed a missing auth capture.
      if (h.input.source === 'auth' && h.authCapture) ensureAuthCapture(h.authCapture);
      continue;
    }
    if (h.input.source === 'auth' && h.authCapture) ensureAuthCapture(h.authCapture);
    tool.requiredInputs.push({ ...h.input });
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
  /** General dependency-contract hints grounded from the recording — EVERY
   *  non-param input each tool needs (auth / producer_tool / browser_state /
   *  generated / static). Fed to the planner as authoritative; a dropped one is
   *  re-injected by `reconcileRequiredInputs` (see `deriveRequiredInputHints`). */
  requiredInputHints: RequiredInputHint[];
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

  // Recorded headers for the in-scope requests (ALL request headers + each
  // request's URL and originating page). The deriver uses these for value-reuse
  // counting (browser_state-vs-generated — must see EVERY header, not just
  // sensitive ones, or a reused non-sensitive functional header like x-request-id
  // is wrongly treated as per-call generated), the page-minted static rule, and the
  // cross-origin bootstrap check. NOT serialized into the planner payload, so the
  // raw values never reach the LLM.
  const recordedHeaders = session.requests
    .filter((r) => scope.has(r.seq))
    .map((r) => ({
      seq: r.seq,
      url: r.url,
      originatingUrl: findOriginatingPage(session, r.seq),
      headers: { ...r.headers },
    }));

  // Full classifications (incl. the recorded value) for the deterministic derivers;
  // the payload's slim `ephemeralValues` stays value-less (no raw value to the LLM).
  const fullEphemeral = (classifications ?? []).map((c) => ({
    classification: c.classification,
    originalSeq: c.originalSeq,
    location: c.location,
    producerSeq: c.producerSeq,
    producerPath: c.producerPath,
    value: c.value1,
    suggestedStateName: c.suggestedStateName,
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
      ephemeralValues: fullEphemeral.filter((c) => c.producerSeq != null),
    }),
    requiredInputHints: deriveRequiredInputHints({
      selectedTools,
      loginRequestSeqs: sharedContext?.loginRequestSeqs ?? [],
      ephemeralValues: fullEphemeral,
      recordedHeaders,
      // Page-minted = a sensitive header the site bakes into its JS (present before
      // the first interaction, not from a Set-Cookie/storage token — the
      // scheme-stripped detector excludes a persisted bearer). Safe to emit as a
      // verbatim static literal; a per-user token is never page-minted.
      pageMintedHeaders: detectPageMintedHeaders(session),
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
  /** Optional sink for progress narration. When provided (e.g. the teach
   *  spinner), planner progress flows here instead of raw stderr so it stays
   *  inside the TUI; standalone/test callers fall back to the module logger. */
  onProgress?: (msg: string) => void;
}): Promise<GenerateBuildPlanResult> {
  const narrate = (msg: string): void => {
    (opts.onProgress ?? log)(msg);
  };
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
      narrate(
        `planning ${opts.candidates.length} tool(s): ${payload.requests.length} request(s), ${payload.ephemeralValues.length} ephemeral value(s), ${payload.tokenContractHints.length} token edge(s), ${payload.requiredInputHints.length} required-input hint(s), ${payload.narration.length} narration line(s); ${Math.round(payloadJson.length / 1024)} KB payload + ${Math.round(systemPrompt.length / 1024)} KB prompt → ${opts.llmConfig?.provider ?? 'auto'}/${opts.llmConfig?.model ?? 'default'}${opts.timeoutMs ? ` (timeout ${Math.round(opts.timeoutMs / 1000)}s)` : ''}`,
      );

      const llm = resolveProvider(opts.llmConfig ?? {});
      const llmStart = Date.now();
      narrate('calling planner LLM');
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
        narrate(
          `planner LLM ${timedOut ? 'timed out' : 'failed'} after ${Math.round(elapsedMs / 1000)}s: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      narrate(
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
        narrate(
          `token contracts: ${payload.tokenContractHints.length} edge(s) detected → injected ${reconciled.injected}, repaired ${reconciled.repaired}`,
        );
      }
      for (const w of reconciled.warnings) narrate(`token contract: ${w}`);

      // Same safety net for the GENERAL dependency contract: re-inject any grounded
      // requiredInput the planner dropped (auth / producer / browser_state /
      // generated / static), and seed missing auth captures.
      const reconciledInputs = reconcileRequiredInputs(
        parsed,
        payload.requiredInputHints,
        selectedNames,
      );
      if (reconciledInputs.injected > 0 || reconciledInputs.repaired > 0) {
        narrate(
          `required inputs: ${payload.requiredInputHints.length} hint(s) → injected ${reconciledInputs.injected}, repaired ${reconciledInputs.repaired}`,
        );
      }
      for (const w of reconciledInputs.warnings) narrate(`required input: ${w}`);

      const plan = validateBuildPlan(parsed, opts.candidates);
      setSpanAttributes(span, {
        'imprint.plan.token_edge_count': payload.tokenContractHints.length,
        'imprint.plan.token_injected': reconciled.injected,
        'imprint.plan.token_repaired': reconciled.repaired,
        'imprint.plan.required_input_hint_count': payload.requiredInputHints.length,
        'imprint.plan.required_input_injected': reconciledInputs.injected,
        'imprint.plan.required_input_repaired': reconciledInputs.repaired,
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
