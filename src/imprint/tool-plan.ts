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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  BuildPlanSchema,
  type SharedModuleManifestEntry,
  planSliceForTool,
  resolveAssignedModules,
} from './build-plan.ts';
import { withTimeout } from './concurrency.ts';
import { type ProviderName, resolveProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { localToolDir } from './paths.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import { type Session, SessionSchema } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const log = createLog('tool-plan');

/** Wall-clock cap on the per-tool planner LLM call. A throttled/hung provider
 *  must not block the tool's compile; on timeout we degrade to compiling without
 *  a plan (today's behavior). The shared-module plan is the 10-min one. */
const TOOL_PLAN_TIMEOUT_MS = 5 * 60_000;

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
        url: r.url,
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
    url: session.url,
    tool: {
      toolName: candidate.toolName,
      description: candidate.description,
      expectedOutput: candidate.expectedOutput,
      likelyParams: candidate.likelyParams,
      requestSeqs: candidate.requestSeqs,
      dependencySeqs: candidate.dependencySeqs,
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

/** Derive a per-tool implementation plan from the recording. Best-effort: any
 *  error/timeout (or the IMPRINT_NO_TOOL_PLAN gate / a missing prompt) returns
 *  undefined so the caller compiles without a plan (today's behavior). Persists
 *  the plan to `~/.imprint/<site>/<toolName>/.tool-plan.md`. */
export async function planToolCompile(opts: {
  site: string;
  toolName: string;
  candidate: ToolCandidate;
  sharedContext?: SharedCompileContext;
  sessionPath: string;
  buildPlanPath?: string;
  sharedModules?: SharedModuleManifestEntry[];
  providerName: ProviderName;
  model?: string;
}): Promise<string | undefined> {
  if (toolPlanDisabled()) return undefined;
  const promptPath = pathJoin(PROMPTS_DIR, 'tool-planning.md');
  if (!existsSync(promptPath)) return undefined;

  return await traced(
    'teach.plan_tool',
    'AGENT',
    {
      'imprint.site': opts.site,
      'imprint.tool_name': opts.toolName,
      'imprint.provider': opts.providerName,
    },
    async (span) => {
      try {
        const systemPrompt = readFileSync(promptPath, 'utf8');

        const session = loadJsonFile(
          opts.sessionPath,
          SessionSchema,
          {
            notFound: 'session not found before tool planning',
            badSchema: 'session file is malformed',
          },
          'session',
        );

        // Load the global build plan slice (if one exists) so the per-tool plan
        // can carry the tool's parserGuidance/paramChecklist/authRecipe and the
        // shared modules it was assigned.
        let buildPlan: unknown;
        if (opts.buildPlanPath && existsSync(opts.buildPlanPath)) {
          try {
            buildPlan = loadJsonFile(
              opts.buildPlanPath,
              BuildPlanSchema,
              { notFound: 'build plan not found' },
              'build plan',
            );
          } catch {
            buildPlan = undefined;
          }
        }

        const payload = buildToolPlanPayload({
          session,
          candidate: opts.candidate,
          sharedContext: opts.sharedContext,
          buildPlan,
          sharedModules: opts.sharedModules,
        });

        const llm = resolveProvider({ provider: opts.providerName, model: opts.model });
        const result = await withTimeout(
          llm.analyze(systemPrompt, payload),
          TOOL_PLAN_TIMEOUT_MS,
          'tool planner',
        );
        const plan = stripCodeFences(result.text).trim();
        if (plan.length === 0) {
          setSpanAttributes(span, { 'imprint.tool_plan.skipped': true });
          return undefined;
        }

        const toolDir = localToolDir(opts.site, opts.toolName);
        mkdirSync(toolDir, { recursive: true });
        writeFileSync(pathJoin(toolDir, '.tool-plan.md'), plan, 'utf8');

        setSpanAttributes(span, {
          'imprint.tool_plan.chars': plan.length,
          'imprint.tool_plan.skipped': false,
        });
        log(`planned ${opts.toolName} (${plan.length} chars)`);
        return plan;
      } catch (err) {
        setSpanAttributes(span, { 'imprint.tool_plan.skipped': true });
        log(
          `tool planning failed for ${opts.toolName} (${err instanceof Error ? err.message : String(err)}) — compiling without a plan`,
        );
        return undefined;
      }
    },
  );
}

function toolPlanDisabled(): boolean {
  const v = process.env.IMPRINT_NO_TOOL_PLAN;
  return !!v && !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

/** Unwrap a response whose entire body is a single Markdown code fence; leave
 *  inline fences (snippets within the plan) untouched. Mirrors the helper in
 *  prereq-builder.ts (not exported there). */
function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return m?.[1] ?? t;
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}
