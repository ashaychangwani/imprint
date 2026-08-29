/**
 * Candidate-tool detection for `imprint teach`.
 *
 * One browser recording can exercise multiple user-facing intents. This pass
 * runs after redaction and before the master plan so teach can account for the
 * complete set of user-facing operations in the shared session.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { inferAppApiHosts } from './app-api-hosts.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { compactUrlForLlm } from './llm-url.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import type { RunDeadlineRef } from './provider-retry.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { isTelemetryRequest } from './telemetry.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import type { CapturedRequest, Session } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const BODY_LIMIT = 800;
const RESPONSE_PREVIEW_LIMIT = 500;
const HEADER_LIMIT = 600;
const log = createLog('candidates');

function normalizeCandidateParamType(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (normalized.length === 0) {
    return undefined;
  }

  if (
    normalized === 'string' ||
    normalized === 'str' ||
    normalized === 'text' ||
    normalized === 'array' ||
    normalized === 'list' ||
    normalized === 'string[]' ||
    normalized === 'array<string>' ||
    normalized === 'stringarray' ||
    normalized === 'stringlist'
  ) {
    return 'string';
  }

  if (
    normalized === 'number' ||
    normalized === 'integer' ||
    normalized === 'int' ||
    normalized === 'float' ||
    normalized === 'numeric' ||
    normalized === 'number[]' ||
    normalized === 'array<number>' ||
    normalized === 'numberarray' ||
    normalized === 'numberlist'
  ) {
    return 'number';
  }

  if (
    normalized === 'boolean' ||
    normalized === 'bool' ||
    normalized === 'boolean[]' ||
    normalized === 'bool[]' ||
    normalized === 'array<boolean>' ||
    normalized === 'booleanarray' ||
    normalized === 'booleanlist'
  ) {
    return 'boolean';
  }

  return undefined;
}

const CandidateParamSchema = z.object({
  name: z.string(),
  type: z.preprocess(
    normalizeCandidateParamType,
    z.enum(['string', 'number', 'boolean']).optional(),
  ),
  description: z.string().optional(),
});

export const SharedCompileContextSchema = z.object({
  loginRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
  credentialNames: z.array(z.string()).default([]),
  tokenExtractionNotes: z.string().default(''),
  sharedHelperNotes: z.string().default(''),
  authRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
  authNotes: z.string().default(''),
});
export type SharedCompileContext = z.infer<typeof SharedCompileContextSchema>;

/** True when the recording carries an auth flow worth compiling into a standalone
 *  `authenticate_<site>` tool — credentials were submitted, with OR without 2FA.
 *  Drives the build planner to emit `authTool` so the login runs ONCE and the
 *  site's data tools reuse one stored session, instead of every data tool
 *  replaying the login inline (which hammers the site at compile time). */
export function sharedContextHasAuth(ctx: SharedCompileContext | undefined): boolean {
  if (!ctx) return false;
  return (
    ctx.authRequestSeqs.length > 0 ||
    ctx.loginRequestSeqs.length > 0 ||
    ctx.credentialNames.length > 0
  );
}

export const ToolCandidateSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  requestSeqs: z.array(z.number().int().nonnegative()).default([]),
  representativeSeqs: z.array(z.number().int().nonnegative()).default([]),
  eventSeqs: z.array(z.number().int().nonnegative()).default([]),
  eventTimeRange: z
    .object({
      startTimestamp: z.number(),
      endTimestamp: z.number(),
    })
    .optional(),
  expectedOutput: z.string().default(''),
  likelyParams: z.array(CandidateParamSchema).default([]),
  dependencySeqs: z.array(z.number().int().nonnegative()).default([]),
  /** Direct user-visible tool prerequisites used by the master when it chooses
   *  dependency-aware build waves. */
  dependsOnTools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
});
export type ToolCandidate = z.infer<typeof ToolCandidateSchema>;

const ToolCandidateDetectionSchema = z
  .object({
    sharedContext: SharedCompileContextSchema.default({}),
    candidates: z.array(ToolCandidateSchema),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const [i, candidate] of value.candidates.entries()) {
      if (names.has(candidate.toolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', i, 'toolName'],
          message: `duplicate toolName "${candidate.toolName}"`,
        });
      }
      names.add(candidate.toolName);
    }
    for (const [i, candidate] of value.candidates.entries()) {
      for (const [j, dependency] of candidate.dependsOnTools.entries()) {
        if (dependency === candidate.toolName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['candidates', i, 'dependsOnTools', j],
            message: `tool "${candidate.toolName}" cannot depend on itself`,
          });
        } else if (!names.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['candidates', i, 'dependsOnTools', j],
            message: `tool "${candidate.toolName}" references unknown dependency "${dependency}"`,
          });
        }
      }
    }
  });
type ToolCandidateDetection = z.infer<typeof ToolCandidateDetectionSchema>;

interface DetectToolCandidatesResult extends ToolCandidateDetection {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

interface DetectToolCandidatesOptions {
  /**
   * The input session has already been reduced by request triage. Trust that
   * selected XHR/Fetch scope instead of re-applying the raw-session origin
   * heuristic, which would drop public cross-origin APIs such as api.remitly.io.
   */
  trustSessionScope?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
}

export async function detectToolCandidates(
  session: Session,
  llmConfig?: LLMOptions,
  opts: DetectToolCandidatesOptions = {},
): Promise<DetectToolCandidatesResult> {
  return await traced(
    'teach.detect_tool_candidates',
    'AGENT',
    {
      'imprint.site': session.site,
      'imprint.session_url': session.url,
      'imprint.provider': llmConfig?.provider ?? 'auto',
    },
    async (span) => {
      const promptPath = pathJoin(PROMPTS_DIR, 'tool-candidate-detection.md');
      if (!existsSync(promptPath)) {
        throw new Error(
          `Candidate detection prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
        );
      }
      const systemPrompt = readFileSync(promptPath, 'utf8');
      const payload = buildToolCandidatePayload(session, {
        trustSessionScope: opts.trustSessionScope,
      });
      const payloadChars = JSON.stringify(payload).length;

      setSpanAttributes(span, {
        'imprint.events_considered': payload.events.length,
        'imprint.requests_considered': payload.requests.length,
        'imprint.detect.payload_chars': payloadChars,
      });

      log(
        `detecting candidate tools from ${payload.events.length} event(s), ${payload.requests.length} request(s); ${Math.round(payloadChars / 1024)} KB payload…`,
      );
      const llm = resolveProvider(llmConfig ?? {});
      const runOnce = async (): Promise<{
        detection: ToolCandidateDetection;
        result: Awaited<ReturnType<typeof llm.analyze>>;
      }> => {
        const result = await llm.analyze(systemPrompt, payload, {
          signal: opts.signal,
          deadlineMs: opts.deadlineMs,
          runDeadline: opts.runDeadline,
        });
        const objectText = extractJsonObject(result.text);
        if (!objectText) {
          throw new Error(
            `Candidate detector did not return a JSON object.\nRaw response:\n${result.text.slice(0, 1000)}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(objectText);
        } catch (err) {
          throw new Error(
            `Candidate detector response was not valid JSON: ${err instanceof Error ? err.message : String(err)}\nExtracted:\n${objectText.slice(0, 1000)}`,
          );
        }
        return { detection: validateToolCandidateDetection(parsed), result };
      };

      const { detection, result } = await runOnce();

      setSpanAttributes(span, {
        'imprint.candidate_count': detection.candidates.length,
        'imprint.detect.duration_ms': result.durationMs,
        'imprint.detect.input_tokens': result.inputTokens,
        'imprint.detect.output_tokens': result.outputTokens,
      });
      return {
        ...detection,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
      };
    },
  );
}

export function validateToolCandidateDetection(input: unknown): ToolCandidateDetection {
  return ToolCandidateDetectionSchema.parse(input);
}

/** Add deterministic candidate-level dependencies from request evidence.
 * A dependency request creates an edge only when exactly one candidate owns
 * that request seq. Shared/ambiguous ownership, unowned auth/bootstrap seqs,
 * and self-owned seqs deliberately create no edge. */
export function deriveStructuralCandidateDependencies(
  candidates: ToolCandidate[],
): ToolCandidate[] {
  const ownersBySeq = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    for (const seq of candidate.requestSeqs) {
      const owners = ownersBySeq.get(seq) ?? new Set<string>();
      owners.add(candidate.toolName);
      ownersBySeq.set(seq, owners);
    }
  }

  const edges: Array<{ consumerTool: string; producerTool: string }> = [];
  for (const candidate of candidates) {
    for (const seq of candidate.dependencySeqs) {
      const owners = ownersBySeq.get(seq);
      if (!owners || owners.size !== 1) continue;
      const producerTool = owners.values().next().value as string | undefined;
      if (!producerTool || producerTool === candidate.toolName) continue;
      edges.push({ consumerTool: candidate.toolName, producerTool });
    }
  }
  return mergeCandidateDependencies(candidates, edges);
}

/** Merge grounded producer edges into candidate metadata. Unknown tools and
 * self-edges are ignored; dependency names are de-duplicated and normalized to
 * candidate detection order for stable persistence and display. */
export function mergeCandidateDependencies(
  candidates: ToolCandidate[],
  edges: ReadonlyArray<{ consumerTool: string; producerTool: string }>,
): ToolCandidate[] {
  const names = new Set(candidates.map((candidate) => candidate.toolName));
  const dependencySets = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    dependencySets.set(
      candidate.toolName,
      new Set(
        candidate.dependsOnTools.filter((name) => names.has(name) && name !== candidate.toolName),
      ),
    );
  }
  for (const edge of edges) {
    if (
      edge.consumerTool === edge.producerTool ||
      !names.has(edge.consumerTool) ||
      !names.has(edge.producerTool)
    ) {
      continue;
    }
    dependencySets.get(edge.consumerTool)?.add(edge.producerTool);
  }

  const order = new Map(candidates.map((candidate, index) => [candidate.toolName, index]));
  return candidates.map((candidate) => ({
    ...candidate,
    dependsOnTools: [...(dependencySets.get(candidate.toolName) ?? [])].sort(
      (a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    ),
  }));
}

export function buildSharedCompileContext(detection: ToolCandidateDetection): SharedCompileContext {
  return {
    ...detection.sharedContext,
    loginRequestSeqs: [...new Set(detection.sharedContext.loginRequestSeqs)].sort((a, b) => a - b),
    authRequestSeqs: [...new Set(detection.sharedContext.authRequestSeqs)].sort((a, b) => a - b),
  };
}

interface CandidateRequestPayload {
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
  credentialPlaceholders: string[];
  repeatCount?: number;
  repeatedSeqs?: number[];
  lastTimestamp?: number;
}

interface ToolCandidatePayload {
  site: string;
  url: string;
  narration: Array<{ seq: number; timestamp: number; text: string }>;
  events: Array<{ seq: number; timestamp: number; type: string; detail: string }>;
  requests: CandidateRequestPayload[];
}

export function buildToolCandidatePayload(
  session: Session,
  opts: DetectToolCandidatesOptions = {},
): ToolCandidatePayload {
  const startRoot = candidateStartRoot(session);
  const appApiHosts = inferAppApiHosts(session, startRoot);
  const requests = compactRequestContexts(
    session.requests
      .filter((request) =>
        isCandidateRequest(request, startRoot, appApiHosts, {
          trustSessionScope: opts.trustSessionScope,
        }),
      )
      .map((request) => {
        const body = truncate(request.body, BODY_LIMIT);
        const responsePreview = truncate(request.response?.body, RESPONSE_PREVIEW_LIMIT);
        const placeholderText = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ''}`;
        return {
          seq: request.seq,
          timestamp: request.timestamp,
          method: request.method,
          url: compactUrlForLlm(request.url),
          resourceType: request.resourceType,
          status: request.response?.status,
          mimeType: request.response?.mimeType,
          headers: truncate(JSON.stringify(request.headers), HEADER_LIMIT) ?? '{}',
          body,
          bodyDigest: requestContextDigest(request.body),
          bodyLength: request.body?.length,
          responsePreview,
          responseBodyDigest: requestContextDigest(request.response?.body),
          responseBodyLength: request.response?.body?.length,
          credentialPlaceholders: credentialPlaceholders(placeholderText),
        };
      }),
    candidateRequestGroupKey,
  );

  return {
    site: session.site,
    url: compactUrlForLlm(session.url),
    narration: session.narration.map((n) => ({
      seq: n.seq,
      timestamp: n.timestamp,
      text: n.text,
    })),
    events: session.events.map((e) => ({
      seq: e.seq,
      timestamp: e.timestamp,
      type: e.type,
      detail: truncate(e.detail, 1000) ?? '',
    })),
    requests,
  };
}

function candidateStartRoot(session: Session): string | null {
  for (const value of [
    session.url,
    ...session.events.filter((event) => event.type === 'navigation').map((event) => event.detail),
    ...session.requests
      .filter((request) => request.resourceType === 'Document')
      .map((request) => request.url),
  ]) {
    const root = rootFromHttpUrl(value);
    if (root) return root;
  }
  return null;
}

function rootFromHttpUrl(value: string): string | null {
  const url = safeUrl(value);
  if (!url || !url.hostname) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return registrableDomain(url.hostname) || null;
}

function candidateRequestGroupKey(request: CandidateRequestPayload): unknown[] {
  return [
    request.method,
    request.url,
    request.bodyDigest,
    request.bodyLength,
    request.status,
    request.mimeType,
    request.responseBodyDigest,
    request.responseBodyLength,
    request.credentialPlaceholders,
  ];
}

/** Telemetry / beacon endpoints. These fire constantly during any real session
 *  and are never the load-bearing request behind a user intent. Left in the
 *  candidate payload they add noise that pushes the detector to under-segment,
 *  and — worse — the detector can anchor a candidate's `requestSeqs` on one,
 *  sending compile to reverse-engineer a beacon. Excluded only for the legacy
 *  untriaged input path; trusted focused evidence is preserved exactly. */
function isCandidateRequest(
  request: CapturedRequest,
  startRoot: string | null,
  appApiHosts: Set<string>,
  opts: DetectToolCandidatesOptions = {},
): boolean {
  if (request.resourceType !== 'XHR' && request.resourceType !== 'Fetch') return false;
  const url = safeUrl(request.url);
  if (!url) return false;
  // A caller that supplies a triaged evidence package has already selected its
  // request scope. Preserve it exactly; reclassifying it here can silently hide
  // evidence the discovery agent needs.
  if (opts.trustSessionScope) return true;
  if (isTelemetryRequest(request)) return false;
  if (startRoot && !isSameRegistrableDomain(url.hostname, startRoot)) {
    return appApiHosts.has(url.hostname);
  }
  return true;
}

function credentialPlaceholders(s: string): string[] {
  const names = new Set<string>();
  for (const match of s.matchAll(/\$\{credential\.([^}]+)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
