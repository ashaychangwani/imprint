/**
 * Per-tool planning pass for `imprint teach`.
 *
 * After the global shared-module plan + build (teach-plan.ts) runs once, each
 * tool gets a thin planning stage before its compile (plan THEN execute): one
 * `llm.analyze` pass that maps each parameter to its recorded field, fixes the
 * request construction + response parsing, and names the shared modules to
 * import. The Markdown plan rides the compile agent's initial prompt (via
 * formatToolPlan), so the compile follows it instead of re-deriving structure.
 *
 * Best-effort throughout: a missing prompt, a timeout, or any LLM/IO error
 * yields `undefined` and the compile proceeds exactly as before. Gated by
 * IMPRINT_NO_TOOL_PLAN. Modeled on planSharedModule in prereq-builder.ts.
 */

import {
  BuildPlanSchema,
  type SharedModuleManifestEntry,
  planSliceForTool,
  resolveAssignedModules,
} from './build-plan.ts';
import { compactUrlForLlm } from './llm-url.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import type { Session } from './types.ts';

const BODY_LIMIT = 800;
const RESPONSE_PREVIEW_LIMIT = 500;
const HEADER_LIMIT = 600;

interface ToolPlanRequestPayload {
  seq: number;
  method: string;
  url: string;
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
  timestamp: number;
}

interface ToolPlanAssignedModule {
  path: string;
  kind: string;
  importPath: string;
  exportSignatures: string[];
  purpose: string;
}

interface ToolPlanPayload {
  site: string;
  url: string;
  tool: {
    toolName: string;
    description: string;
    expectedOutput: string;
    likelyParams: ToolCandidate['likelyParams'];
    requestSeqs: number[];
    dependencySeqs: number[];
    dependsOnTools: string[];
  };
  sharedContext?: SharedCompileContext;
  /** Slice of the global build plan for this tool (when a build plan exists). */
  planGuidance?: {
    parserGuidance: string;
    paramChecklist: string[];
    authRecipe: unknown;
    loadBearingSeqs: number[];
  };
  assignedModules: ToolPlanAssignedModule[];
  requests: ToolPlanRequestPayload[];
}

/** Pure payload builder — unit-testable without an LLM. Filters requests to the
 *  tool's relevant seqs (candidate seqs ∪ dependency seqs ∪ build-plan
 *  loadBearingSeqs) and compacts them the same way build-plan.ts does. */
export function buildToolPlanPayload(opts: {
  session: Session;
  candidate: ToolCandidate;
  sharedContext?: SharedCompileContext;
  buildPlan?: unknown;
  sharedModules?: SharedModuleManifestEntry[];
}): ToolPlanPayload {
  const { session, candidate, sharedContext } = opts;

  // Project the global build plan (if any) down to this tool's slice + the
  // shared modules it was assigned.
  let planGuidance: ToolPlanPayload['planGuidance'];
  let assignedModules: ToolPlanAssignedModule[] = [];
  let loadBearingSeqs: number[] = [];
  if (opts.buildPlan) {
    const parsed = BuildPlanSchema.safeParse(opts.buildPlan);
    if (parsed.success) {
      const plan = parsed.data;
      const slice = planSliceForTool(plan, candidate.toolName);
      if (slice) {
        planGuidance = {
          parserGuidance: slice.tool.parserGuidance,
          paramChecklist: slice.tool.paramChecklist,
          authRecipe: slice.tool.authRecipe,
          loadBearingSeqs: slice.tool.loadBearingSeqs,
        };
        loadBearingSeqs = slice.tool.loadBearingSeqs;
      }
      assignedModules = resolveAssignedModules(plan, candidate.toolName, opts.sharedModules)
        .filter((m) => m.verified)
        .map((m) => ({
          path: m.path,
          kind: m.kind,
          importPath: m.importPath,
          exportSignatures: m.exportSignatures,
          purpose: m.purpose,
        }));
    }
  }

  const scope = new Set<number>();
  for (const s of candidate.requestSeqs) scope.add(s);
  for (const s of candidate.dependencySeqs) scope.add(s);
  for (const s of loadBearingSeqs) scope.add(s);

  const requests = compactRequestContexts(
    session.requests
      .filter((r) => scope.has(r.seq))
      .map((r) => ({
        seq: r.seq,
        timestamp: r.timestamp,
        method: r.method,
        url: compactUrlForLlm(r.url),
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
    toolPlanRequestGroupKey,
  );

  return {
    site: session.site,
    url: compactUrlForLlm(session.url),
    tool: {
      toolName: candidate.toolName,
      description: candidate.description,
      expectedOutput: candidate.expectedOutput,
      likelyParams: candidate.likelyParams,
      requestSeqs: candidate.requestSeqs,
      dependencySeqs: candidate.dependencySeqs,
      dependsOnTools: candidate.dependsOnTools,
    },
    sharedContext,
    planGuidance,
    assignedModules,
    requests,
  };
}

function toolPlanRequestGroupKey(request: ToolPlanRequestPayload): unknown[] {
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

export function validateToolPlan(plan: string): { valid: true } | { valid: false; reason: string } {
  const trimmed = plan.trim();
  if (trimmed.length === 0) return { valid: false, reason: 'empty plan' };
  if (/^(?:\$\{credential\.[A-Za-z0-9_]+\}|\{credential\.[A-Za-z0-9_]+\})$/.test(trimmed)) {
    return { valid: false, reason: 'looks like a credential placeholder, not a plan' };
  }
  if (/^\{[\s\S]*\}$/.test(trimmed) || /^\[[\s\S]*\]$/.test(trimmed)) {
    return { valid: false, reason: 'looks like JSON, not markdown plan' };
  }

  const requiredSections = ['### Parameters', '### Requests', '### Response parsing'];
  const missing = requiredSections.filter((section) => !trimmed.includes(section));
  if (missing.length > 0) {
    return { valid: false, reason: `missing required section(s): ${missing.join(', ')}` };
  }
  if (trimmed.length < 200)
    return { valid: false, reason: 'too short to be an implementation plan' };

  return { valid: true };
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}
