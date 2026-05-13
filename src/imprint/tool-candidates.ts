/**
 * Candidate-tool detection for `imprint teach`.
 *
 * One browser recording can exercise multiple user-facing intents. This pass
 * runs after redaction and before compile so teach can fan out the shared
 * session into one generated tool per selected candidate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import type { CapturedRequest, Session } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const BODY_LIMIT = 1200;
const RESPONSE_PREVIEW_LIMIT = 2000;
const HEADER_LIMIT = 1200;
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
});
export type SharedCompileContext = z.infer<typeof SharedCompileContextSchema>;

export const ToolCandidateSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  primary: z.boolean(),
  requestSeqs: z.array(z.number().int().nonnegative()).default([]),
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
});
export type ToolCandidate = z.infer<typeof ToolCandidateSchema>;

const ToolCandidateDetectionSchema = z
  .object({
    sharedContext: SharedCompileContextSchema.default({}),
    candidates: z.array(ToolCandidateSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const primaryCount = value.candidates.filter((c) => c.primary).length;
    if (primaryCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: `expected exactly one primary candidate, got ${primaryCount}`,
      });
    }
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
  });
type ToolCandidateDetection = z.infer<typeof ToolCandidateDetectionSchema>;

interface DetectToolCandidatesResult extends ToolCandidateDetection {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export async function detectToolCandidates(
  session: Session,
  llmConfig?: LLMOptions,
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
      const payload = buildToolCandidatePayload(session);

      setSpanAttributes(span, {
        'imprint.events_considered': payload.events.length,
        'imprint.requests_considered': payload.requests.length,
      });

      log(
        `detecting candidate tools from ${payload.events.length} event(s), ${payload.requests.length} request(s)…`,
      );
      const llm = resolveProvider(llmConfig ?? {});
      const result = await llm.analyze(systemPrompt, payload);
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

      const detection = validateToolCandidateDetection(parsed);
      setSpanAttributes(span, {
        'imprint.candidate_count': detection.candidates.length,
        'imprint.primary_tool_name': detection.candidates.find((c) => c.primary)?.toolName,
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

export function primaryToolCandidate(detection: ToolCandidateDetection): ToolCandidate {
  const primary = detection.candidates.find((c) => c.primary);
  if (!primary) {
    throw new Error('candidate detection has no primary candidate');
  }
  return primary;
}

export function buildSharedCompileContext(
  detection: ToolCandidateDetection,
  _selected: ToolCandidate[],
): SharedCompileContext {
  return {
    ...detection.sharedContext,
    loginRequestSeqs: [...new Set(detection.sharedContext.loginRequestSeqs)].sort((a, b) => a - b),
  };
}

interface ToolCandidatePayload {
  site: string;
  url: string;
  narration: Array<{ seq: number; timestamp: number; text: string }>;
  events: Array<{ seq: number; timestamp: number; type: string; detail: string }>;
  requests: Array<{
    seq: number;
    timestamp: number;
    method: string;
    url: string;
    resourceType: string;
    status?: number;
    mimeType?: string;
    headers: string;
    body?: string;
    responsePreview?: string;
    credentialPlaceholders: string[];
    likelyLoginOrAuth: boolean;
  }>;
}

export function buildToolCandidatePayload(session: Session): ToolCandidatePayload {
  const startUrl = safeUrl(session.url);
  const startRoot = startUrl ? registrableDomain(startUrl.hostname) : null;
  const requests = session.requests
    .filter((request) => isCandidateRequest(request, startRoot))
    .map((request) => {
      const body = truncate(request.body, BODY_LIMIT);
      const responsePreview = truncate(request.response?.body, RESPONSE_PREVIEW_LIMIT);
      const placeholderText = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ''}`;
      return {
        seq: request.seq,
        timestamp: request.timestamp,
        method: request.method,
        url: request.url,
        resourceType: request.resourceType,
        status: request.response?.status,
        mimeType: request.response?.mimeType,
        headers: truncate(JSON.stringify(request.headers), HEADER_LIMIT) ?? '{}',
        body,
        responsePreview,
        credentialPlaceholders: credentialPlaceholders(placeholderText),
        likelyLoginOrAuth: likelyLoginOrAuth(request),
      };
    });

  return {
    site: session.site,
    url: session.url,
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

function isCandidateRequest(request: CapturedRequest, startRoot: string | null): boolean {
  if (request.resourceType !== 'XHR' && request.resourceType !== 'Fetch') return false;
  const url = safeUrl(request.url);
  if (!url) return false;
  if (startRoot && !isSameRegistrableDomain(url.hostname, startRoot)) return false;
  return true;
}

function likelyLoginOrAuth(request: CapturedRequest): boolean {
  const url = safeUrl(request.url);
  const endpointText =
    `${request.method} ${url ? `${url.pathname} ${url.search}` : request.url} ${request.body ?? ''}`.toLowerCase();
  const headerText = JSON.stringify(request.headers ?? {}).toLowerCase();
  if (/\$\{credential\.[^}]+\}/.test(`${endpointText} ${headerText}`)) return true;

  // Data requests often carry CSRF headers. Treat endpoint/body semantics as the
  // signal so normal authenticated API calls do not get mislabeled as auth setup.
  return /login|signin|sign-in|authenticate|authentication|oauth|session|password|csrf|token/.test(
    endpointText,
  );
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
