/**
 * Shared compile-agent tool implementations.
 *
 * The same 8 read/write tools and the verification logic are used both by
 * the in-process agent loop (anthropic-api provider) and by the
 * stdio MCP server that claude-cli drives through `--mcp-config`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join as pathJoin, relative as pathRelative } from 'node:path';
import type { AgentTool } from './agent.ts';
import { inferAppApiHosts } from './app-api-hosts.ts';
import {
  type AssignedSharedModule,
  type SharedModuleManifestEntry,
  planSliceForTool,
  readBuildPlanFile,
  resolveAssignedModules,
} from './build-plan.ts';
import { splitSetCookieHeader } from './cookie-jar.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import type { ClassifiedValue } from './session-diff.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type CapturedRequest, type Session, WorkflowSchema } from './types.ts';

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');

// Env var read by the agent-written parser.test.ts to locate the redacted
// session. The test loads it, finds the load-bearing request seq, and feeds
// response.body to extract(). Set when we spawn `bun test parser.test.ts`
// from run_tests / externalVerification — the test never reads from disk
// without it, so leftover test files won't blow up under default `bun test`.
const SESSION_PATH_ENV = 'IMPRINT_SESSION_PATH';

export function buildCompileTools(
  session: Session,
  toolDir: string,
  sessionPath: string,
  context: CompileToolContext = {},
): AgentTool[] {
  const credEnv = context.teachCredentials
    ? { IMPRINT_TEACH_CREDENTIALS: JSON.stringify(context.teachCredentials) }
    : undefined;
  const tools = [
    buildReadSessionSummaryTool(session, context),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    buildSearchResponseBodyTool(session),
    buildWriteFileTool(toolDir),
    buildReadFileTool(toolDir),
    buildRunBashTool(toolDir, credEnv),
    buildRunTestsTool(toolDir, sessionPath, credEnv),
  ];
  if (context.buildPlanPath && context.candidate?.toolName) {
    tools.push(
      buildReadBuildPlanTool(
        context.buildPlanPath,
        context.candidate.toolName,
        context.sharedModules,
      ),
    );
  }
  return tools;
}

interface CompileToolContext {
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  classifications?: ClassifiedValue[];
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). When
   *  set, a read_build_plan tool is exposed and the verifier asserts the tool
   *  imports the shared modules the plan assigned it. */
  buildPlanPath?: string;
  /** Shared-module build manifest (verified flags) for this site. */
  sharedModules?: SharedModuleManifestEntry[];
}

// ─── Tool: read_build_plan ───────────────────────────────────────────────────

function buildReadBuildPlanTool(
  buildPlanPath: string,
  toolName: string,
  manifest?: SharedModuleManifestEntry[],
): AgentTool {
  return {
    name: 'read_build_plan',
    description:
      "Read this tool's slice of the shared build plan: shared modules to import (instead of re-implementing), parser guidance, the parameter checklist, the auth recipe to replicate inline, and the opaque-token contract (fields this tool must EMIT for siblings, and params it CONSUMES from siblings).",
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const plan = readBuildPlanFile(buildPlanPath);
      if (!plan) return { result: 'No build plan available for this run.' };
      const slice = planSliceForTool(plan, toolName);
      if (!slice) return { result: `No build-plan slice for tool "${toolName}".` };
      const assigned = resolveAssignedModules(plan, toolName, manifest).filter((m) => m.verified);
      const emitsTokens = slice.tool.emitsTokens ?? [];
      const tokenParams = slice.tool.tokenParams ?? [];
      const tokenNotes: string[] = [];
      if (emitsTokens.length > 0) {
        tokenNotes.push(
          `PRODUCER CONTRACT: your parser MUST emit ${emitsTokens
            .map((e) => `\`${e.field}\``)
            .join(
              ', ',
            )} in each result item, in the exact shape described (the FULL value a sibling consumer needs — never a bare fragment). Sibling tools mint their input from these fields; the verifier fails this tool if a declared field is missing from the parser output.`,
        );
      }
      for (const tp of tokenParams) {
        tokenNotes.push(
          `CONSUMER CONTRACT: param \`${tp.param}\` is an opaque token minted by the \`${tp.sourceTool}\` tool's \`${tp.sourceField}\` output. Write a CHAINED \`param:${tp.param}\` integration test that calls \`runWorkflowWithLadder\` on \`../${tp.sourceTool}/workflow.json\`, reads \`${tp.sourceField}\` from its result, and passes THAT fresh value (not the recorded constant) into this tool — then asserts the response is non-empty. On producer bot/infra error, rethrow so the suite waives.`,
        );
      }
      return {
        result: JSON.stringify(
          {
            toolName,
            sharedModulesToImport: assigned.map((m) => ({
              importPath: m.importPath,
              kind: m.kind,
              purpose: m.purpose,
              exportSignatures: m.exportSignatures,
            })),
            parserGuidance: slice.tool.parserGuidance,
            paramChecklist: slice.tool.paramChecklist,
            authRecipe: slice.tool.authRecipe,
            emitsTokens,
            tokenParams,
            note:
              assigned.length > 0
                ? 'Import the listed shared modules via their importPath (request-transform → set workflow.json "requestTransformModule"; parser-helper/types → import from parser.ts) instead of re-implementing their logic. The verifier fails this tool if an assigned module is not imported.'
                : 'No shared modules assigned — build this tool self-contained.',
            tokenContract: tokenNotes.length > 0 ? tokenNotes : undefined,
          },
          null,
          2,
        ),
      };
    },
  };
}

// ─── Tool: read_session_summary ──────────────────────────────────────────────

function buildReadSessionSummaryTool(session: Session, context: CompileToolContext): AgentTool {
  return {
    name: 'read_session_summary',
    description:
      'Get a high-level summary of the session including narration, selected candidate scope, load-bearing requests with inline data, and capture hints.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const allCandidateSeqs = new Set(context.candidate?.requestSeqs ?? []);
      const representativeSeqs = context.candidate?.representativeSeqs ?? [];
      const selectedRequestSeqs = new Set(
        representativeSeqs.length > 0 ? representativeSeqs : (context.candidate?.requestSeqs ?? []),
      );
      const dependencySeqs = new Set([
        ...(context.candidate?.dependencySeqs ?? []),
        ...(context.sharedContext?.loginRequestSeqs ?? []),
      ]);
      const preserveSeqs = new Set([...selectedRequestSeqs, ...dependencySeqs]);
      const summaryRequests = identifySummaryRequests(session, preserveSeqs);
      const loadBearingRequests = compactRequestContexts(
        summaryRequests.map((r) => ({
          seq: r.seq,
          timestamp: r.timestamp,
          selectedForCandidate: selectedRequestSeqs.has(r.seq) || allCandidateSeqs.has(r.seq),
          sharedDependency: dependencySeqs.has(r.seq),
          method: r.method,
          url: r.url,
          status: r.response?.status,
          mimeType: r.response?.mimeType,
          bodySize: r.response?.body?.length,
          responseBodyDigest: requestContextDigest(r.response?.body),
          ...(preserveSeqs.has(r.seq) ? { inlineData: buildInlineData(r) } : {}),
        })),
        compileSummaryRequestGroupKey,
        { preserveSeqs },
      );
      const stateHints = buildStateHints(session, context.classifications);
      const captureHints = buildCaptureHints(
        context.classifications,
        context.candidate,
        context.sharedContext,
      );
      const summary = {
        site: session.site,
        url: session.url,
        selectedCandidate: context.candidate
          ? {
              toolName: context.candidate.toolName,
              description: context.candidate.description,
              expectedOutput: context.candidate.expectedOutput,
              requestSeqs:
                (context.candidate.representativeSeqs?.length ?? 0) > 0
                  ? context.candidate.representativeSeqs
                  : context.candidate.requestSeqs,
              dependencySeqs: context.candidate.dependencySeqs,
              eventSeqs: context.candidate.eventSeqs,
              likelyParams: context.candidate.likelyParams,
            }
          : undefined,
        sharedContext: context.sharedContext,
        narration: session.narration.map((n) => ({ timestamp: n.timestamp, text: n.text })),
        requestCount: session.requests.length,
        stateHints,
        captureHints: captureHints.length > 0 ? captureHints : undefined,
        loadBearingRequests,
      };

      const result = JSON.stringify(summary, null, 2);
      if (result.length <= SUMMARY_SIZE_BUDGET) return { result };

      // Over budget — rebuild with reduced inline data to fit
      const reducedRequests = reduceInlineData(
        loadBearingRequests as Array<Record<string, unknown>>,
        result.length,
      );
      // biome-ignore lint/suspicious/noExplicitAny: type-safe reduction preserves shape
      (summary as any).loadBearingRequests = reducedRequests;
      return { result: JSON.stringify(summary, null, 2) };
    },
  };
}

// ─── Inline request/response data for candidate-scoped requests ─────────────

// claude-cli truncates tool results > ~40K chars. Keep the total summary
// well under that so the agent actually receives the inline data.
const SUMMARY_SIZE_BUDGET = 30_000;

const JSON_BODY_LIMIT = 16 * 1024;
const JSON_STRUCTURE_THRESHOLD = 50 * 1024;
const HTML_BODY_LIMIT = 4 * 1024;

function buildInlineData(req: CapturedRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {
    requestHeaders: req.headers,
  };
  if (req.body) {
    result.requestBody = req.body;

    const reqCt = (req.headers['content-type'] ?? req.headers['Content-Type'] ?? '').toLowerCase();
    if (reqCt.includes('form-urlencoded')) {
      try {
        const formParams = new URLSearchParams(req.body);
        const decoded: Record<string, unknown> = {};
        for (const [k, v] of formParams) {
          const trimmed = v.trimStart();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              decoded[k] = JSON.parse(v);
            } catch {
              decoded[k] = v;
            }
          } else {
            decoded[k] = v;
          }
        }
        result.requestBodyDecoded = decoded;
      } catch {
        // Non-fatal — raw body is still available.
      }
    }
  }

  if (req.response) {
    result.responseStatus = req.response.status;
    result.responseHeaders = req.response.headers;

    const body = req.response.body;
    if (body) {
      const mime = (req.response.mimeType ?? '').toLowerCase();
      const isJson = mime.includes('json') || isJsonBody(body);
      const isHtml = mime.includes('html');

      if (isJson) {
        if (body.length <= JSON_BODY_LIMIT) {
          result.responseBody = body;
        } else if (body.length > JSON_STRUCTURE_THRESHOLD) {
          result.responseBody = body.slice(0, JSON_BODY_LIMIT / 2);
          result.responseBodyTruncated = true;
          result.responseBodyTotalLength = body.length;
          result.responseBodyStructure = summarizeJsonStructure(body);
        } else {
          result.responseBody = body.slice(0, JSON_BODY_LIMIT);
          result.responseBodyTruncated = true;
          result.responseBodyTotalLength = body.length;
        }
      } else if (isHtml) {
        if (body.length <= HTML_BODY_LIMIT) {
          result.responseBody = body;
        } else {
          result.responseBody = body.slice(0, HTML_BODY_LIMIT);
          result.responseBodyTruncated = true;
          result.responseBodyTotalLength = body.length;
        }
      } else if (body.length <= HTML_BODY_LIMIT) {
        result.responseBody = body;
      } else {
        result.responseBody = `(${mime || 'unknown'} body, ${body.length} bytes)`;
        result.responseBodyTruncated = true;
        result.responseBodyTotalLength = body.length;
      }
    }
  }
  return result;
}

function reduceInlineData(
  requests: Array<Record<string, unknown>>,
  fullSummarySize: number,
): Array<Record<string, unknown>> {
  const reduced = requests.map((r) => ({ ...r }));
  const budget = SUMMARY_SIZE_BUDGET;

  // The caller passes the full summary size. Track the delta from
  // reducing the requests array so we can estimate the full summary
  // size without re-serializing the entire object each phase.
  const arrayBefore = JSON.stringify(requests).length;
  const overhead = fullSummarySize - arrayBefore;

  const estimateFullSize = () => JSON.stringify(reduced).length + overhead;

  // Phase 1: drop responseBody from non-candidate requests (shared dependencies)
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      if (r.sharedDependency && !r.selectedForCandidate && r.inlineData) {
        const inline = r.inlineData as Record<string, unknown>;
        inline.responseBody = undefined;
        inline.responseBodyStructure = undefined;
        inline.responseBodyTruncated = true;
        inline.responseBodyNote = 'omitted to fit summary budget — use read_response_body';
      }
    }
  }

  // Phase 2: cap all remaining response bodies at 4KB
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      if (!r.inlineData) continue;
      const inline = r.inlineData as Record<string, unknown>;
      const body = inline.responseBody;
      if (typeof body === 'string' && body.length > 4096) {
        inline.responseBody = body.slice(0, 4096);
        inline.responseBodyTruncated = true;
      }
    }
  }

  // Phase 3: drop all response bodies, keep only request data + headers
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      if (!r.inlineData) continue;
      const inline = r.inlineData as Record<string, unknown>;
      inline.responseBody = undefined;
      inline.responseBodyStructure = undefined;
      inline.responseBodyTruncated = true;
      inline.responseBodyNote = 'omitted to fit summary budget — use read_response_body';
    }
  }

  // Phase 4: drop inline data entirely if still over budget
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      r.inlineData = undefined;
    }
  }

  return reduced;
}

function isJsonBody(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function summarizeJsonStructure(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return describeStructure(parsed, 0, 3);
  } catch {
    return '(could not parse JSON for structure summary)';
  }
}

function describeStructure(value: unknown, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return typeof value === 'object' ? '{...}' : String(typeof value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const first = describeStructure(value[0], depth + 1, maxDepth);
    return `Array(${value.length}) of ${first}`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const fields = entries
      .slice(0, 20)
      .map(([k, v]) => `${k}: ${describeStructure(v, depth + 1, maxDepth)}`);
    if (entries.length > 20) fields.push(`... +${entries.length - 20} more keys`);
    return `{ ${fields.join(', ')} }`;
  }
  return String(typeof value);
}

// ─── Capture hints from dual-pass classifications ───────────────────────────

interface CaptureHint {
  producerRequestIndex: number;
  capture: {
    source: 'json' | 'response_header' | 'cookie' | 'text_regex';
    name: string;
    path?: string;
    header?: string;
    cookie?: string;
    pattern?: string;
    group?: number;
  };
  usedBy: Array<{
    requestIndex: number;
    location: string;
    substitution: string;
  }>;
}

function buildCaptureHints(
  classifications: ClassifiedValue[] | undefined,
  candidate: ToolCandidate | undefined,
  sharedContext: SharedCompileContext | undefined,
): CaptureHint[] {
  if (!classifications || !candidate) return [];

  const requestChain = [
    ...(candidate.dependencySeqs ?? []),
    ...(sharedContext?.loginRequestSeqs ?? []),
    ...candidate.requestSeqs,
  ];
  const uniqueChain = [...new Set(requestChain)].sort((a, b) => a - b);
  const seqToIndex = new Map(uniqueChain.map((seq, i) => [seq, i]));

  const hints: CaptureHint[] = [];

  for (const c of classifications) {
    if (c.classification !== 'server_derived') continue;
    if (c.producerSeq == null || !c.producerPath) continue;

    const producerIndex = seqToIndex.get(c.producerSeq);
    if (producerIndex == null) continue;

    const consumerIndex = seqToIndex.get(c.originalSeq);
    if (consumerIndex == null) continue;

    const name = c.suggestedStateName ?? `state_${producerIndex}_${consumerIndex}`;
    const capture = buildCaptureFromPath(name, c.producerPath);
    if (!capture) continue;

    hints.push({
      producerRequestIndex: producerIndex,
      capture,
      usedBy: [
        {
          requestIndex: consumerIndex,
          location: c.location,
          substitution: `\${state.${name}}`,
        },
      ],
    });
  }

  return deduplicateCaptureHints(hints);
}

function buildCaptureFromPath(name: string, producerPath: string): CaptureHint['capture'] | null {
  if (producerPath.startsWith('response_header:')) {
    return {
      source: 'response_header',
      name,
      header: producerPath.slice('response_header:'.length),
    };
  }
  if (producerPath.startsWith('set-cookie:')) {
    return {
      source: 'cookie',
      name,
      cookie: producerPath.slice('set-cookie:'.length),
    };
  }
  if (producerPath.startsWith('$') || producerPath.startsWith('.')) {
    return { source: 'json', name, path: producerPath };
  }
  if (producerPath.includes('.')) {
    return { source: 'json', name, path: `$.${producerPath}` };
  }
  return null;
}

function deduplicateCaptureHints(hints: CaptureHint[]): CaptureHint[] {
  const byKey = new Map<string, CaptureHint>();
  for (const hint of hints) {
    const key = `${hint.producerRequestIndex}:${hint.capture.name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.usedBy.push(...hint.usedBy);
    } else {
      byKey.set(key, { ...hint, usedBy: [...hint.usedBy] });
    }
  }
  return [...byKey.values()];
}

function buildStateHints(
  session: Session,
  dualPassClassifications?: ClassifiedValue[],
): Array<Record<string, unknown>> {
  const hints: Array<Record<string, unknown>> = [];
  const cookieMarkers = new Map<string, Array<{ requestSeq: number; cookie: string }>>();
  const storageMarkers = new Map<string, { origin: string; kind: string; key: string }>();

  for (const snap of session.storageSnapshots ?? []) {
    for (const [key, value] of Object.entries(snap.localStorage ?? {})) {
      if (isEqualityMarker(value)) {
        storageMarkers.set(value, { origin: snap.origin, kind: 'localStorage', key });
      }
    }
    for (const [key, value] of Object.entries(snap.sessionStorage ?? {})) {
      if (isEqualityMarker(value)) {
        storageMarkers.set(value, { origin: snap.origin, kind: 'sessionStorage', key });
      }
    }
  }

  for (const req of session.requests) {
    const setCookie = Object.entries(req.response?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'set-cookie',
    )?.[1];
    if (setCookie) {
      for (const cookie of splitSetCookieHeader(setCookie)) {
        const first = cookie.split(';', 1)[0] ?? '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq);
        const marker = first.slice(eq + 1);
        if (isEqualityMarker(marker)) {
          const existing = cookieMarkers.get(marker) ?? [];
          existing.push({ requestSeq: req.seq, cookie: name });
          cookieMarkers.set(marker, existing);
        }
      }
    }

    for (const [field, value] of requestValues(req)) {
      for (const marker of equalityMarkers(value)) {
        const cookies = cookieMarkers.get(marker);
        if (cookies) {
          for (const cookie of cookies) {
            if (cookie.requestSeq < req.seq) {
              hints.push({
                type: 'request_field_equals_earlier_set_cookie',
                producerSeq: cookie.requestSeq,
                consumerSeq: req.seq,
                cookie: cookie.cookie,
                requestField: field,
              });
            }
          }
        }
        const storage = storageMarkers.get(marker);
        if (storage) {
          hints.push({
            type: 'request_field_equals_storage_key',
            consumerSeq: req.seq,
            requestField: field,
            ...storage,
          });
        }
      }
    }
  }

  // Detect per-call query params: params whose values change across repeated
  // requests to the same URL path. These are browser-minted (computed by
  // in-page JS per call) and cannot be hardcoded or derived from prior responses.
  const urlsByPath = new Map<string, Array<{ seq: number; params: URLSearchParams }>>();
  for (const req of session.requests) {
    try {
      const url = new URL(req.url);
      const pathKey = `${url.hostname}${url.pathname}`;
      const existing = urlsByPath.get(pathKey) ?? [];
      existing.push({ seq: req.seq, params: url.searchParams });
      urlsByPath.set(pathKey, existing);
    } catch {
      // skip malformed URLs
    }
  }
  for (const [pathKey, entries] of urlsByPath) {
    if (entries.length < 2) continue;
    const firstEntry = entries[0];
    if (!firstEntry) continue;
    for (const paramName of firstEntry.params.keys()) {
      const values = new Set(entries.map((e) => e.params.get(paramName) ?? ''));
      if (values.size > 1) {
        const sample = entries[0]?.params.get(paramName) ?? '';
        const looksHighEntropy = sample.length > 20 && /[+/=A-Z0-9]{10,}/i.test(sample);
        if (looksHighEntropy) {
          hints.push({
            type: 'query_param_changes_across_calls',
            urlPath: pathKey,
            paramName,
            distinctValues: values.size,
            sampleSeqs: entries.slice(0, 3).map((e) => e.seq),
            note: `Query param "${paramName}" has ${values.size} distinct high-entropy values across ${entries.length} requests to the same URL path. This is likely a URL signing token computed by client-side JavaScript. Use search_response_body to find the signing function in .js responses, then write a requestTransformModule that replicates the computation.`,
          });
        }
      }
    }
  }

  if (dualPassClassifications) {
    for (const c of dualPassClassifications) {
      if (c.classification === 'constant') continue;
      const note =
        c.classification === 'server_derived'
          ? `This value differs across independent executions and was found in response seq ${c.producerSeq} at ${c.producerPath}. Use a capture on that request and reference via \${state.${c.suggestedStateName ?? 'NAME'}}.`
          : 'This value differs across independent executions and is NOT traceable to any prior server response. It is browser-minted (computed by client-side JS). Consider: bootstrap capture (if session-scoped), requestTransformModule (if per-request), or stealth_bootstrap (if bot-defense).';
      hints.push({
        type: 'dual_pass_value_classification',
        classification: c.classification,
        originalSeq: c.originalSeq,
        location: c.location,
        value1: c.value1,
        value2: c.value2,
        producerSeq: c.producerSeq,
        producerPath: c.producerPath,
        suggestedStateName: c.suggestedStateName,
        note,
      });
    }
  }

  return hints;
}

function requestValues(req: CapturedRequest): Array<[string, string]> {
  const values: Array<[string, string]> = [['url', req.url]];
  for (const [name, value] of Object.entries(req.headers)) values.push([`header:${name}`, value]);
  if (req.body) values.push(['body', req.body]);
  return values;
}

function equalityMarkers(value: string): string[] {
  return value.match(/\[REDACTED:v3:id=\d+:len=\d+\]/g) ?? [];
}

function isEqualityMarker(value: string): boolean {
  return /^\[REDACTED:v3:id=\d+:len=\d+\]$/.test(value);
}

interface CompileSummaryRequestContext {
  seq: number;
  timestamp: number;
  selectedForCandidate: boolean;
  sharedDependency: boolean;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
  bodySize?: number;
  responseBodyDigest?: string;
  repeatCount?: number;
  repeatedSeqs?: number[];
  lastTimestamp?: number;
}

function compileSummaryRequestGroupKey(request: CompileSummaryRequestContext): unknown[] {
  return [
    request.method,
    request.url,
    request.status,
    request.mimeType,
    request.bodySize,
    request.responseBodyDigest,
  ];
}

function identifyLoadBearingRequests(session: Session): CapturedRequest[] {
  const startUrl = safeUrl(session.url);
  const startRoot = startUrl ? registrableDomain(startUrl.hostname) : null;
  const appApiHosts = inferAppApiHosts(session, startRoot);

  return session.requests.filter((r) => {
    const url = safeUrl(r.url);
    if (!url) return false;
    if (
      startRoot &&
      !isSameRegistrableDomain(url.hostname, startRoot) &&
      !appApiHosts.has(url.hostname)
    )
      return false;
    if (r.resourceType !== 'XHR' && r.resourceType !== 'Fetch') return false;
    if (!r.response || r.response.status < 200 || r.response.status >= 300) return false;
    if (!r.response.body) return false;
    return true;
  });
}

function identifySummaryRequests(session: Session, preserveSeqs: Set<number>): CapturedRequest[] {
  return session.requests.filter((r) => preserveSeqs.has(r.seq)).sort((a, b) => a.seq - b.seq);
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

// ─── Tool: read_request ──────────────────────────────────────────────────────

function buildReadRequestTool(session: Session): AgentTool {
  return {
    name: 'read_request',
    description: 'Get the full request including method, URL, headers, and body for a given seq.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
      },
      required: ['seq'],
    },
    handler: async (input: unknown) => {
      const { seq } = input as { seq: number };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req) {
        return { result: `Request seq ${seq} not found`, isError: true };
      }
      const summary = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        response: req.response
          ? {
              status: req.response.status,
              headers: req.response.headers,
              mimeType: req.response.mimeType,
              bodyLength: req.response.body?.length,
            }
          : undefined,
      };

      return { result: JSON.stringify(summary, null, 2) };
    },
  };
}

// ─── Tool: read_response_body ────────────────────────────────────────────────

function buildReadResponseBodyTool(session: Session): AgentTool {
  return {
    name: 'read_response_body',
    description:
      'Get the response body for a given seq, with optional pagination via offset/length.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
        offset: { type: 'number', description: 'Starting byte offset (default 0)' },
        length: {
          type: 'number',
          description: 'Number of bytes to read (default 50000, max 100000)',
        },
      },
      required: ['seq'],
    },
    handler: async (input: unknown) => {
      const {
        seq,
        offset = 0,
        length = 50000,
      } = input as {
        seq: number;
        offset?: number;
        length?: number;
      };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req) {
        return { result: `Request seq ${seq} not found`, isError: true };
      }
      if (!req.response?.body) {
        return { result: `no response body captured for seq ${seq}`, isError: true };
      }

      const body = req.response.body;
      const totalLength = body.length;
      const cappedLength = Math.min(length, 100000);
      const slice = body.slice(offset, offset + cappedLength);

      let isJson = false;
      try {
        JSON.parse(body);
        isJson = true;
      } catch {
        // not JSON
      }

      return {
        result: JSON.stringify(
          {
            body: slice,
            totalLength,
            isJson,
            offset,
            returnedLength: slice.length,
          },
          null,
          2,
        ),
      };
    },
  };
}

// ─── Tool: search_response_body ──────────────────────────────────────────────

function buildSearchResponseBodyTool(session: Session): AgentTool {
  return {
    name: 'search_response_body',
    description:
      'Search for a substring in a response body and return matching offsets with context.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Request sequence number' },
        query: { type: 'string', description: 'Search string (case-sensitive)' },
        contextChars: {
          type: 'number',
          description: 'Characters to include before and after match (default 80)',
        },
        maxMatches: {
          type: 'number',
          description: 'Maximum number of matches to return (default 20)',
        },
      },
      required: ['seq', 'query'],
    },
    handler: async (input: unknown) => {
      const {
        seq,
        query,
        contextChars = 80,
        maxMatches = 20,
      } = input as {
        seq: number;
        query: string;
        contextChars?: number;
        maxMatches?: number;
      };
      const req = session.requests.find((r) => r.seq === seq);
      if (!req || !req.response?.body) {
        return { result: `no response body for seq ${seq}`, isError: true };
      }

      const body = req.response.body;
      const matches: { offset: number; snippet: string }[] = [];
      let searchStart = 0;

      while (matches.length < maxMatches) {
        const idx = body.indexOf(query, searchStart);
        if (idx === -1) break;

        const start = Math.max(0, idx - contextChars);
        const end = Math.min(body.length, idx + query.length + contextChars);
        const snippet = body.slice(start, end);

        matches.push({ offset: idx, snippet });
        searchStart = idx + query.length;
      }

      return { result: JSON.stringify(matches, null, 2) };
    },
  };
}

// ─── Tool: write_file ────────────────────────────────────────────────────────

function buildWriteFileTool(toolDir: string): AgentTool {
  return {
    name: 'write_file',
    description:
      'Write a file to the generated tool directory. Allowed paths: workflow.json, parser.ts, parser.test.ts, notes/*.md',
    input_schema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: 'Relative path within the tool directory' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['relativePath', 'content'],
    },
    handler: async (input: unknown) => {
      const { relativePath, content } = input as { relativePath: string; content: string };

      if (relativePath.includes('..') || relativePath.startsWith('/')) {
        return {
          result: `invalid relativePath: "${relativePath}" — must not contain ".." or start with "/"`,
          isError: true,
        };
      }

      const allowed = [
        'workflow.json',
        'parser.ts',
        'parser.test.ts',
        'request-transform.ts',
        'integration.test.ts',
      ];
      const isNotes = relativePath.startsWith('notes/') && relativePath.endsWith('.md');
      if (!allowed.includes(relativePath) && !isNotes) {
        return {
          result: `relativePath "${relativePath}" not allowed — must be one of: ${allowed.join(', ')}, or notes/*.md`,
          isError: true,
        };
      }

      const absolutePath = pathJoin(toolDir, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, 'utf8');

      return {
        result: JSON.stringify({
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          absolutePath,
        }),
      };
    },
  };
}

// ─── Tool: read_file ─────────────────────────────────────────────────────────

function buildReadFileTool(toolDir: string): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file in the generated tool directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the tool directory (e.g. parser.ts, workflow.json)',
        },
      },
      required: ['path'],
    },
    handler: async (input: unknown) => {
      const { path } = input as { path: string };

      if (path.includes('..') || path.startsWith('/')) {
        return {
          result: `invalid path: "${path}" — must be a relative path within the tool directory, no ".." or leading "/"`,
          isError: true,
        };
      }

      const absolutePath = pathJoin(toolDir, path);
      const allowedRoots = [toolDir];

      const isAllowed = allowedRoots.some((root) => absolutePath.startsWith(root));
      if (!isAllowed) {
        return {
          result: `path "${path}" not allowed — must be a relative path within the tool directory`,
          isError: true,
        };
      }

      if (!existsSync(absolutePath)) {
        return { result: `file not found: ${absolutePath}`, isError: true };
      }

      let content = readFileSync(absolutePath, 'utf8');
      const MAX_SIZE = 100 * 1024; // 100KB
      if (content.length > MAX_SIZE) {
        content = `${content.slice(0, MAX_SIZE)}\n[…truncated…]`;
      }

      return {
        result: JSON.stringify({
          content,
          size: content.length,
        }),
      };
    },
  };
}

// ─── Tool: run_bash ──────────────────────────────────────────────────────────

function buildRunBashTool(toolDir: string, credEnv?: Record<string, string>): AgentTool {
  return {
    name: 'run_bash',
    description: 'Run a shell command in the generated tool directory with a timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds (default 60, max 300)' },
      },
      required: ['command'],
    },
    handler: async (input: unknown) => {
      const { command, timeoutSec = 60 } = input as { command: string; timeoutSec?: number };

      if (command.match(/rm\s+-rf\s+\//) || command.includes('sudo')) {
        return {
          result: 'blocked destructive command — rm -rf / and sudo are not allowed',
          isError: true,
        };
      }

      const cappedTimeout = Math.min(timeoutSec, 300) * 1000;

      return await runCommand(command, toolDir, cappedTimeout, credEnv);
    },
  };
}

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ result: string; isError?: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const TRUNCATE_LIMIT = 16 * 1024; // 16KB

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);

      if (stdout.length > TRUNCATE_LIMIT) {
        stdout = `${stdout.slice(0, TRUNCATE_LIMIT)}\n[…truncated…]`;
      }
      if (stderr.length > TRUNCATE_LIMIT) {
        stderr = `${stderr.slice(0, TRUNCATE_LIMIT)}\n[…truncated…]`;
      }

      resolve({
        result: JSON.stringify({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          timedOut,
        }),
        isError: (exitCode ?? -1) !== 0 || timedOut,
      });
    });
  });
}

/** Typecheck a set of generated `.ts` artifacts in `dir` against the repo's
 *  tsconfig (so `imprint/*` and bun globals resolve). Used by both the compile
 *  verifier (parser.ts / request-transform.ts) and the prereq-module verifier
 *  (`_shared/*.ts`). `*.test.ts` are excluded — they pull in bun:test globals
 *  the strict config rejects. Exported for prereq-builder.ts. */
export async function typecheckArtifacts(
  dir: string,
  includes: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const configPath = pathJoin(dir, '.imprint-typecheck.tsconfig.json');
  const rootTsconfig = pathJoin(REPO_ROOT, 'tsconfig.json');
  const extendsPath = normalizeTsconfigPath(pathRelative(dir, rootTsconfig));

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        extends: extendsPath,
        include: includes,
        exclude: ['*.test.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );

  try {
    const result = await runCommand(
      'bunx tsc --noEmit -p .imprint-typecheck.tsconfig.json',
      dir,
      120000,
    );
    return JSON.parse(result.result) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    };
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function normalizeTsconfigPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

// ─── Tool: run_tests ─────────────────────────────────────────────────────────

function buildRunTestsTool(
  toolDir: string,
  sessionPath: string,
  credEnv?: Record<string, string>,
): AgentTool {
  return {
    name: 'run_tests',
    description: 'Run bun test parser.test.ts and parse the output for pass/fail counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const testPath = pathJoin(toolDir, 'parser.test.ts');
      if (!existsSync(testPath)) {
        return {
          result: 'parser.test.ts does not exist — write it first',
          isError: true,
        };
      }

      const cmdResult = await runCommand('bun test parser.test.ts', toolDir, 120000, {
        [SESSION_PATH_ENV]: sessionPath,
        ...credEnv,
      });

      const output = JSON.parse(cmdResult.result) as {
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      };

      const passMatch = output.stdout.match(/(\d+)\s+pass/);
      const failMatch = output.stdout.match(/(\d+)\s+fail/);

      const passed = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0;
      const failed = failMatch?.[1] ? Number.parseInt(failMatch[1], 10) : 0;
      const total = passed + failed;

      return {
        result: JSON.stringify({
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
          passed,
          failed,
          total,
          timedOut: output.timedOut,
        }),
        isError: output.exitCode !== 0 || output.timedOut,
      };
    },
  };
}

// ─── Test-quality helpers (shared with prereq-builder verification) ─────────

/** Tautological assertions that prove nothing — rejected by every verifier so
 *  an agent can't game the ≥3-expect gate with `expect(true).toBe(true)`. */
const TRIVIAL_ASSERTION_PATTERNS: RegExp[] = [
  /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/,
  /expect\s*\(\s*false\s*\)\.toBe\s*\(\s*false\s*\)/,
  /expect\s*\(\s*1\s*\)\.toBe\s*\(\s*1\s*\)/,
  /expect\s*\(\s*0\s*\)\.toBe\s*\(\s*0\s*\)/,
  /expect\s*\(\s*null\s*\)\.toBeNull/,
  /expect\s*\(\s*undefined\s*\)\.toBeUndefined/,
  /expect\s*\(\s*"[^"]*"\s*\)\.toBe\s*\(\s*"[^"]*"\s*\)/,
  /expect\s*\(\s*'[^']*'\s*\)\.toBe\s*\(\s*'[^']*'\s*\)/,
];

export function countExpectCalls(src: string): number {
  return (src.match(/expect\s*\(/g) ?? []).length;
}

export function hasTrivialAssertion(src: string): boolean {
  return TRIVIAL_ASSERTION_PATTERNS.some((pattern) => pattern.test(src));
}

/** Assert the tool imports each verified shared module the plan assigned it.
 *  request-transform → workflow.json.requestTransformModule must point at it;
 *  parser-helper/types → parser.ts (or request-transform.ts) must import it. */
function assertSharedModuleImports(
  toolDir: string,
  workflowPath: string,
  assigned: AssignedSharedModule[],
): string[] {
  const failures: string[] = [];
  const verified = assigned.filter((m) => m.verified);
  if (verified.length === 0) return failures;

  let workflowRaw: { requestTransformModule?: unknown } = {};
  try {
    workflowRaw = JSON.parse(readFileSync(workflowPath, 'utf8'));
  } catch {
    return failures; // workflow parse already flagged elsewhere
  }
  const requestTransformModule =
    typeof workflowRaw.requestTransformModule === 'string'
      ? workflowRaw.requestTransformModule
      : '';

  let sourceBlob = '';
  for (const f of ['parser.ts', 'request-transform.ts']) {
    const p = pathJoin(toolDir, f);
    if (existsSync(p)) sourceBlob += `\n${readFileSync(p, 'utf8')}`;
  }

  for (const m of verified) {
    if (m.kind === 'request-transform') {
      if (!requestTransformModule.includes(m.importPath) && !sourceBlob.includes(m.importPath)) {
        failures.push(
          `the build plan assigns shared module ${m.path} (request-transform) to this tool, but workflow.json does not set "requestTransformModule": "${m.importPath}" and no artifact imports it. Reuse it instead of re-implementing the logic — see read_build_plan.`,
        );
      }
    } else if (!sourceBlob.includes(m.importPath)) {
      failures.push(
        `the build plan assigns shared module ${m.path} (${m.kind}) to this tool, but no artifact imports "${m.importPath}". Import it from parser.ts (or request-transform.ts) instead of re-implementing it — see read_build_plan.`,
      );
    }
  }
  return failures;
}

// ─── External Verification ──────────────────────────────────────────────────

/**
 * Decide whether a failed integration test was blocked by anti-automation /
 * bot defense (as opposed to a real workflow defect). Compile-time integration
 * tests only reach the fetch + fetch-bootstrap rungs; many sites gate their
 * APIs behind challenges (CAPTCHA interstitials, redirect-to-challenge pages,
 * rate-based blocks) that only the runtime ladder's stealth-fetch + playbook
 * rungs bypass. When the parser is already verified against the recorded
 * response, such a block should be a non-blocking warning, not a hard failure —
 * the tool works in production via the full ladder.
 *
 * Vendor-agnostic by design: matches the common defense families (Cloudflare,
 * Akamai, DataDome, PerimeterX, hCaptcha/reCAPTCHA, generic "unusual traffic"
 * interstitials) plus blocking HTTP statuses (403/429/503) and
 * redirect-to-challenge (30x to a challenge/verify/captcha location).
 * Not specialized to any single site.
 */
export function isBotDefenseFailure(output: string): boolean {
  // Unambiguous challenge/interstitial signatures — sufficient on their own,
  // regardless of HTTP status, because no legitimate API success emits them.
  // Vendor-neutral: covers the common anti-bot families, not any one site.
  const strong =
    /unusual traffic|recaptcha|hcaptcha|h-captcha|are you (a )?(human|robot)|verify (you are|you'?re) (a )?human|px-captcha|datadome|perimeterx|cf[-_]chl|attention required|just a moment\s*(\.\.\.|…)?|enable javascript and cookies to continue/i;
  if (strong.test(output)) return true;
  // Weaker terms need a corroborating blocking status or a redirect to a
  // challenge page so ordinary error text doesn't get a free pass.
  const weak =
    /captcha|challenge|access denied|forbidden|blocked|\bbot\b|rate.?limit|too many requests/i;
  const blockingStatus = /\b(403|429|503)\b/.test(output);
  const challengeRedirect =
    /\b(30[1-8])\b/.test(output) &&
    /captcha|challenge|verify|robot|denied|blocked|unusual/i.test(output);
  return (blockingStatus || challengeRedirect) && weak.test(output);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse a JUnit XML report (from `bun test --reporter=junit`) into the sets of
 * passed and failed test *names*. The default bun reporter does not print
 * per-test names in non-TTY mode, so the JUnit report is the reliable way to
 * know which individual tests actually ran green. A self-closed
 * `<testcase .../>` passed; a `<testcase>` with a `<failure>`/`<error>` child
 * failed.
 */
export function parseJUnitResults(xml: string): { passed: Set<string>; failed: Set<string> } {
  const passed = new Set<string>();
  const failed = new Set<string>();
  if (!xml) return { passed, failed };
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? '';
    const nameMatch = attrs.match(/\bname="([^"]*)"/);
    if (!nameMatch?.[1]) continue;
    const name = unescapeXml(nameMatch[1]);
    const selfClosed = m[2] === '/>';
    const didFail = !selfClosed && /<(failure|error)\b/.test(m[3] ?? '');
    if (didFail) failed.add(name);
    else passed.add(name);
  }
  return { passed, failed };
}

interface BunTestRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Per-test names recovered from the JUnit report. */
  passed: Set<string>;
  failed: Set<string>;
}

/** Per-exposed-parameter verification outcome. `verified` is true only when a
 *  `param:<name>` integration test actually ran green against live data. */
interface ParamVerification {
  name: string;
  verified: boolean;
  /** Why an exposed param is unverified. Undefined when `verified` is true.
   *  - `waived-bot` / `waived-infra`: the live suite was waived (anti-bot /
   *    infra), so the param's effect could not be confirmed at compile time;
   *    it is exercised at runtime via the stealth-fetch / playbook ladder.
   *  - `annotated`: the agent marked it `// exposed-but-not-verified`.
   *  - `waived-chain`: the param is a producer-sourced token but the producer
   *    tool could not be run at compile time (anti-bot / not compiled), so the
   *    chain could not be verified. */
  reason?: 'waived-bot' | 'waived-infra' | 'annotated' | 'waived-chain';
  /** For a producer-sourced token param, the sibling tool + output field its
   *  value comes from. Stamped into workflow.json (`param.sourcedFrom`) so the
   *  MCP description tells the orchestrating LLM where to mint it and the audit
   *  harness chains producer→consumer instead of fabricating a token. */
  sourcedFrom?: { tool: string; field: string };
}

/** A parameter the gate knows is an opaque token/id minted by a sibling tool.
 *  `sourceTool`/`sourceField` are known when the build plan declared the contract;
 *  a mechanically-detected source (its recorded value appears in a sibling tool's
 *  response) may carry only the param name. Either way the param REQUIRES a
 *  chained `param:<name>` test that mints a fresh value from the producer. */
interface TokenSource {
  param: string;
  sourceTool?: string;
  sourceField?: string;
}

/**
 * Run a single `bun test <file>` and recover both the raw output (for
 * bot-defense / infra detection and error surfacing) and the per-test pass/fail
 * names via a JUnit report written to a transient file in the tool dir.
 */
async function runBunTestWithResults(
  testPath: string,
  toolDir: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<BunTestRun> {
  const junitPath = pathJoin(toolDir, `.imprint-junit-${basename(testPath)}.xml`);
  try {
    if (existsSync(junitPath)) unlinkSync(junitPath);
  } catch {
    // best-effort
  }
  const result = await runCommand(
    `bun test ${testPath} --reporter=junit --reporter-outfile=${junitPath}`,
    toolDir,
    timeoutMs,
    env,
  );
  const output = JSON.parse(result.result) as { stdout: string; stderr: string; exitCode: number };
  let xml = '';
  try {
    if (existsSync(junitPath)) xml = readFileSync(junitPath, 'utf8');
  } catch {
    // missing/partial report → empty sets, handled by callers
  }
  try {
    if (existsSync(junitPath)) unlinkSync(junitPath);
  } catch {
    // best-effort
  }
  const { passed, failed } = parseJUnitResults(xml);
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exitCode,
    passed,
    failed,
  };
}

interface TestBlock {
  title: string;
  body: string;
}

/** Split a test file into `test(...)` / `it(...)` blocks (title + source from
 *  that test's start to the next test's start). Good enough to check whether a
 *  named per-parameter test's body actually calls the workflow. */
export function extractTestBlocks(src: string): TestBlock[] {
  const re = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  const starts: Array<{ index: number; title: string }> = [];
  for (const m of src.matchAll(re)) {
    starts.push({ index: m.index ?? 0, title: m[2] ?? '' });
  }
  const blocks: TestBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (!start) continue;
    const end = i + 1 < starts.length ? (starts[i + 1]?.index ?? src.length) : src.length;
    blocks.push({ title: start.title, body: src.slice(start.index, end) });
  }
  return blocks;
}

/** Whether a recorded value looks like an opaque token/id (vs free text, a city
 *  name, a date) — used to gate mechanical producer-source detection. */
function looksOpaque(v: string): boolean {
  if (v.length < 12) return false;
  if (/\s/.test(v)) return false; // multi-word / free text
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; // dates
  return /[:|_-]/.test(v) || /\d/.test(v) || v.length >= 16;
}

/**
 * Mechanical producer-source detector (secondary signal to the build plan's
 * declared `tokenParams`). A parameter is producer-sourced when its recorded
 * value — or a `|`/`:`-split segment of a composite — appears verbatim in a
 * SIBLING tool's recorded response. Returns the param name (and the producing
 * tool name when the sibling response carried one). Advisory: it never marks a
 * param verified; it only forces the chained-test requirement so an undeclared
 * cross-tool token can't ship with a tautological recorded-value test.
 */
export function detectTokenSources(opts: {
  likelyParams: Array<{ name: string }>;
  recordedParamValues: Map<string, string>;
  siblingResponses: Array<{ toolName?: string; body: string }>;
}): TokenSource[] {
  const out: TokenSource[] = [];
  for (const lp of opts.likelyParams) {
    const val = opts.recordedParamValues.get(lp.name);
    if (!val || !looksOpaque(val)) continue;
    const needles = [val, ...val.split(/[|:]/).filter((s) => looksOpaque(s))];
    const hit = opts.siblingResponses.find((r) => needles.some((n) => r.body.includes(n)));
    if (hit) out.push({ param: lp.name, sourceTool: hit.toolName });
  }
  return out;
}

/** Does a test block mint a fresh value by calling a SIBLING tool's workflow
 *  (`../<producer>/workflow.json`) rather than only this tool's own workflow? */
const SIBLING_WORKFLOW_RE = /\.\.\/[A-Za-z0-9_]+\/workflow\.json/;

/** The `sourcedFrom` stamp for a token param — `{tool, field}` when both the
 *  producer tool and field are known, else undefined. */
function sourcedFromOf(ts: {
  sourceTool?: string;
  sourceField?: string;
}): { tool: string; field: string } | undefined {
  return ts.sourceTool && ts.sourceField
    ? { tool: ts.sourceTool, field: ts.sourceField }
    : undefined;
}

/**
 * Pure per-parameter coverage classifier (Fix C/D + chained-token verification).
 * Decides, for each exposed parameter, whether it was behaviorally verified — a
 * `param:<name>` integration test that actually ran green (in `passedTests`) AND
 * calls the workflow — and otherwise why it is unverified. Never drops a param
 * (keep+mark policy):
 *  - covered-live → `{ verified: true }`
 *  - suite waived by anti-bot/infra and not covered → `{ verified: false, reason: 'waived-*' }`
 *  - annotated `// exposed-but-not-verified` and not covered → `{ verified: false, reason: 'annotated' }`
 *  - else (suite ran, no test, no annotation) → `uncovered` (blocking)
 *  - passed but the test never calls runWorkflowWithLadder → `tautological` (blocking)
 *
 * A **producer-sourced token param** (in `tokenSources`) is held to a stricter
 * bar: its `param:<name>` test must mint a FRESH value by calling the producer's
 * sibling workflow (`../<tool>/workflow.json`), not reuse the recorded constant.
 *  - chained pass → `{ verified: true, sourcedFrom }`
 *  - passed but not chained (the recorded-value tautology) → `unchained` (blocking)
 *  - suite waived (producer anti-bot) → `{ verified: false, reason: 'waived-chain' }`
 *  - else → `unchained` (blocking)
 */
export function classifyParamCoverage(opts: {
  likelyParams: Array<{ name: string }>;
  integrationSrc: string;
  passedTests: Set<string>;
  integrationOutcome: 'passed' | 'waived-bot' | 'waived-infra' | 'failed' | 'absent';
  tokenSources?: TokenSource[];
}): {
  paramVerification: ParamVerification[];
  uncovered: string[];
  tautological: string[];
  unchained: string[];
} {
  const paramVerification: ParamVerification[] = [];
  const uncovered: string[] = [];
  const tautological: string[] = [];
  const unchained: string[] = [];
  const tokenByName = new Map((opts.tokenSources ?? []).map((t) => [t.param, t]));
  const blocks = extractTestBlocks(opts.integrationSrc);
  const waived =
    opts.integrationOutcome === 'waived-bot' || opts.integrationOutcome === 'waived-infra';
  for (const lp of opts.likelyParams) {
    const token = `param:${lp.name}`;
    const passedLive = [...opts.passedTests].some((n) => n.includes(token));
    const block = blocks.find((b) => b.title.includes(token));

    // Producer-sourced token param: requires a chained test that mints a fresh
    // value from the producer's sibling workflow.
    const ts = tokenByName.get(lp.name);
    if (ts) {
      const sourcedFrom = sourcedFromOf(ts);
      if (passedLive) {
        const chained =
          !!block &&
          /runWorkflowWithLadder\s*\(/.test(block.body) &&
          SIBLING_WORKFLOW_RE.test(block.body);
        if (chained) {
          paramVerification.push({ name: lp.name, verified: true, sourcedFrom });
        } else {
          unchained.push(lp.name);
        }
      } else if (waived) {
        paramVerification.push({
          name: lp.name,
          verified: false,
          reason: 'waived-chain',
          sourcedFrom,
        });
      } else {
        unchained.push(lp.name);
      }
      continue;
    }

    const annotationRe = new RegExp(
      `//\\s*exposed-but-not-verified[^\\n]*\\b${lp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    );
    const isAnnotated = annotationRe.test(opts.integrationSrc);

    if (passedLive) {
      // Anti-tautology: a passing per-param test must actually exercise the live
      // workflow, not assert a constant.
      if (block && !/runWorkflowWithLadder\s*\(/.test(block.body)) {
        tautological.push(lp.name);
      } else {
        paramVerification.push({ name: lp.name, verified: true });
      }
      continue;
    }

    if (waived) {
      paramVerification.push({
        name: lp.name,
        verified: false,
        reason: opts.integrationOutcome as 'waived-bot' | 'waived-infra',
      });
      continue;
    }
    if (isAnnotated) {
      paramVerification.push({ name: lp.name, verified: false, reason: 'annotated' });
      continue;
    }
    uncovered.push(lp.name);
  }
  return { paramVerification, uncovered, tautological, unchained };
}

/**
 * Fix D: on successful verification, persist each exposed parameter's
 * `verified` / `verifyNote` into workflow.json so the audit harness and
 * operators can see which params were not behaviorally verified at compile time
 * (per the keep+mark policy — nothing is dropped). Returns a consolidated
 * warning line for any unverified params (empty when all verified). Best-effort:
 * a write failure never blocks a tool that already passed verification.
 */
export function applyParamVerification(
  toolDir: string,
  paramVerification: ParamVerification[],
): string[] {
  if (paramVerification.length === 0) return [];
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return [];
  let workflow: {
    parameters?: Array<{
      name: string;
      verified?: boolean;
      verifyNote?: string;
      sourcedFrom?: { tool: string; field: string };
    }>;
  };
  try {
    workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  } catch {
    return [];
  }
  const byName = new Map(paramVerification.map((p) => [p.name, p]));
  for (const param of workflow.parameters ?? []) {
    const pv = byName.get(param.name);
    if (!pv) continue;
    if (pv.verified) {
      param.verified = true;
      param.verifyNote = undefined;
    } else {
      param.verified = false;
      param.verifyNote = pv.reason;
    }
    // Stamp the producer-source contract so the MCP description (mcp-server.ts)
    // tells the orchestrating LLM where to mint the token and `imprint audit`
    // chains producer→consumer instead of fabricating it.
    if (pv.sourcedFrom) param.sourcedFrom = pv.sourcedFrom;
  }
  try {
    writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort — the tool is already verified; this is only metadata.
  }
  const unverified = paramVerification.filter((p) => !p.verified);
  if (unverified.length === 0) return [];
  return [
    `${unverified.length} parameter(s) live-unverified at compile time (${unverified
      .map((p) => `${p.name}: ${p.reason ?? 'unverified'}`)
      .join(', ')}) — exercised at runtime via the stealth-fetch / playbook ladder.`,
  ];
}

export async function externalVerification(
  toolDir: string,
  session: Session,
  sessionPath: string,
  opts: {
    expectedToolName?: string;
    likelyParams?: Array<{ name: string; type?: string; description?: string }>;
    candidateRequestSeqs?: number[];
    /** Shared modules the build plan assigned to this tool. The verifier asserts
     *  each verified module is actually imported (no silent re-implementation). */
    assignedSharedModules?: AssignedSharedModule[];
    /** Producer→consumer token contracts the build plan declared for this tool:
     *  each `param` is minted by `sourceTool`'s `sourceField` output. Such params
     *  require a chained `param:<name>` test (mint a fresh value from the producer)
     *  and are stamped with `sourcedFrom` on success. */
    tokenParams?: Array<{ param: string; sourceTool: string; sourceField: string }>;
    /** Fields the build plan requires THIS tool's parser to emit for sibling
     *  consumers (producer side). The verifier fails the tool if a declared field
     *  is not emitted, so the producer/consumer field name can't silently diverge
     *  (e.g. the plan says `hotel_id` but the parser emits `propertyToken`). */
    emittedTokens?: Array<{ field: string; shape: string }>;
  } = {},
): Promise<{ failures: string[]; warnings: string[]; paramVerification: ParamVerification[] }> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const paramVerification: ParamVerification[] = [];

  const workflowPath = pathJoin(toolDir, 'workflow.json');
  const parserPath = pathJoin(toolDir, 'parser.ts');
  const parserTestPath = pathJoin(toolDir, 'parser.test.ts');

  if (!existsSync(workflowPath)) {
    failures.push('workflow.json was not written');
  } else {
    try {
      const raw = JSON.parse(readFileSync(workflowPath, 'utf8'));
      const workflow = WorkflowSchema.parse(raw);
      if (opts.expectedToolName && workflow.toolName !== opts.expectedToolName) {
        failures.push(
          `workflow.toolName "${workflow.toolName}" does not match selected candidate "${opts.expectedToolName}"`,
        );
      }
      const wfStr = JSON.stringify(raw);
      const envMatches = wfStr.match(/\$\{env\.[A-Za-z0-9_.]+\}/g);
      if (envMatches && envMatches.length > 0) {
        failures.push(
          `workflow.json contains \${env.X} placeholders (${envMatches.join(', ')}). These require manual environment setup and break portability. If the value appeared in the recorded session, hardcode it as a literal string instead.`,
        );
      }

      if (opts.likelyParams && opts.likelyParams.length > 0) {
        // Build the set of query param keys from the original recorded URLs
        // so we can distinguish real API params from invented ones.
        const originalQueryParamKeys = new Set<string>();
        if (opts.candidateRequestSeqs) {
          for (const seq of opts.candidateRequestSeqs) {
            const recorded = session.requests.find((r) => r.seq === seq);
            if (recorded) {
              try {
                const url = new URL(recorded.url);
                for (const key of url.searchParams.keys()) {
                  originalQueryParamKeys.add(key);
                }
              } catch {
                /* skip malformed URLs */
              }
            }
          }
        }

        const notTemplated: string[] = [];
        const inventedOnly: string[] = [];

        for (const lp of opts.likelyParams) {
          const placeholder = `\${param.${lp.name}}`;
          let inBody = false;
          let inHeader = false;
          let inOriginalQuery = false;
          let inInventedQuery = false;

          for (const req of workflow.requests) {
            if (req.body?.includes(placeholder)) inBody = true;

            for (const hv of Object.values(req.headers)) {
              if (hv.includes(placeholder)) inHeader = true;
            }

            if (req.url.includes(placeholder)) {
              const qIdx = req.url.indexOf('?');
              if (qIdx >= 0 && req.url.indexOf(placeholder) > qIdx) {
                const queryStr = req.url.slice(qIdx + 1);
                for (const pair of queryStr.split('&')) {
                  if (pair.includes(placeholder)) {
                    const eqIdx = pair.indexOf('=');
                    const paramKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
                    if (originalQueryParamKeys.has(paramKey)) {
                      inOriginalQuery = true;
                    } else {
                      inInventedQuery = true;
                    }
                  }
                }
              } else {
                inBody = true;
              }
            }
          }

          if (!inBody && !inHeader && !inOriginalQuery && !inInventedQuery) {
            notTemplated.push(lp.name);
          } else if (!inBody && !inHeader && !inOriginalQuery && inInventedQuery) {
            inventedOnly.push(lp.name);
          }
        }

        if (notTemplated.length > 0) {
          failures.push(
            `${notTemplated.length} likelyParam(s) are not templated in any request: ${notTemplated.join(', ')}. Each must appear as \${param.NAME} in a request URL, body, or header. For parameters recorded as null or [] (filters the user toggled but didn\'t apply), find the correct position in the request body and replace the placeholder value with \${param.NAME}.`,
          );
        }
        if (inventedOnly.length > 0) {
          warnings.push(
            `${inventedOnly.length} likelyParam(s) are templated only in URL query params that do not exist in any recorded request URL: ${inventedOnly.join(', ')}. The API server likely ignores these invented params — wire them into the request body or an existing query param instead. For complex body formats, use a requestTransformModule to construct the body programmatically.`,
          );
        }
      }
    } catch (err) {
      failures.push(
        `workflow.json schema invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (existsSync(workflowPath) && existsSync(parserPath)) {
    try {
      const raw = JSON.parse(readFileSync(workflowPath, 'utf8'));
      if (!raw.parserModule) {
        failures.push(
          'parser.ts exists but workflow.json does not declare "parserModule": "./parser.ts" — the parser will be dead code at runtime',
        );
      }
    } catch {
      // workflow parse already flagged above
    }
  }

  // Shared-module reuse: when the build plan assigned this tool a verified
  // shared module, the tool's artifacts MUST import it rather than duplicating
  // the logic. This is the anti-duplication gate for multi-tool teach runs.
  if (
    opts.assignedSharedModules &&
    opts.assignedSharedModules.length > 0 &&
    existsSync(workflowPath)
  ) {
    failures.push(...assertSharedModuleImports(toolDir, workflowPath, opts.assignedSharedModules));
  }

  if (!existsSync(parserPath)) {
    failures.push('parser.ts was not written');
  } else {
    try {
      const cacheBust = `?t=${Date.now()}`;
      const fileUrl = `file://${parserPath}${cacheBust}`;
      const mod = await import(fileUrl);
      if (typeof mod.extract !== 'function') {
        failures.push('parser.ts must export `extract` function');
      }
    } catch (err) {
      failures.push(`parser.ts import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!existsSync(parserTestPath)) {
    failures.push('parser.test.ts was not written');
  } else {
    const src = readFileSync(parserTestPath, 'utf8');
    const expectCount = countExpectCalls(src);
    if (expectCount < 3) {
      failures.push(`parser.test.ts has only ${expectCount} expect() calls; need ≥3`);
    }
    if (hasTrivialAssertion(src)) {
      failures.push(
        'parser.test.ts contains trivial tautological assertions like expect(true).toBe(true) — tests must reference real values',
      );
    }
    // Fix E: the zero/empty-result contract. The recording has no no-match
    // response, so the only way to verify empty-handling is a synthetic case.
    if (!src.includes('synthetic:empty-result')) {
      failures.push(
        'parser.test.ts is missing the required `synthetic:empty-result` test — add a test titled `synthetic:empty-result …` that feeds extract() a no-match / empty-items response and asserts it returns a clean empty collection (length 0), never a single all-null placeholder record. See prompts/compile-agent.md.',
      );
    }
  }

  if (existsSync(parserTestPath)) {
    const run = await runBunTestWithResults(parserTestPath, toolDir, 120000, {
      [SESSION_PATH_ENV]: sessionPath,
    });
    if (run.exitCode !== 0) {
      failures.push(
        `bun test parser.test.ts exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    }
    // The synthetic empty-result test must actually RUN GREEN, not merely be
    // present in source — a failed/absent synthetic test leaves empty-handling
    // unverified (R1: phantom all-null record on a zero-result input).
    const ranAnyTest = run.passed.size + run.failed.size > 0;
    const syntheticPassed = [...run.passed].some((n) => n.includes('synthetic:empty-result'));
    if (ranAnyTest && !syntheticPassed) {
      failures.push(
        'the `synthetic:empty-result` parser test did not pass — extract() must return a clean empty collection for a no-match/empty response (not a phantom record). Fix the parser or the test.',
      );
    }
  }

  // Run the live integration suite and classify the outcome. The per-param
  // coverage check below trusts the test *runner* (which named tests actually
  // ran green) rather than a static source scan, so a suite that was waived by
  // anti-bot can no longer be counted as "covered".
  const integrationTestPath = pathJoin(toolDir, 'integration.test.ts');
  let integrationOutcome: 'passed' | 'waived-bot' | 'waived-infra' | 'failed' | 'absent' = 'absent';
  let integrationPassedTests = new Set<string>();
  if (!existsSync(integrationTestPath)) {
    failures.push(
      'integration.test.ts was not written — the tool must include a live API test that calls the workflow and verifies it returns real data',
    );
  } else {
    let run: BunTestRun = {
      stdout: '',
      stderr: '',
      exitCode: 1,
      passed: new Set(),
      failed: new Set(),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      run = await runBunTestWithResults(integrationTestPath, toolDir, 60000);
      if (run.exitCode === 0) break;
    }
    integrationPassedTests = run.passed;
    if (run.exitCode === 0) {
      integrationOutcome = 'passed';
    } else {
      const combined = `${run.stdout}\n${run.stderr}`;
      const hasImprintBlock =
        /\bRATE_LIMITED\b|\bFORBIDDEN\b|\bNETWORK\b/.test(combined) &&
        /non-escalatable|giving up/.test(combined);
      if (isBotDefenseFailure(combined)) {
        integrationOutcome = 'waived-bot';
        warnings.push(
          `integration test failed with likely bot-detection / anti-automation challenge (tried 3 times) — treating as non-blocking since parser verification passed. The runtime backend ladder (stealth-fetch + playbook) handles these defenses at call time even when the compile-time fetch rungs cannot.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
      } else if (hasImprintBlock) {
        integrationOutcome = 'waived-infra';
        warnings.push(
          `integration test failed with infrastructure error (${combined.match(/\b(RATE_LIMITED|FORBIDDEN|NETWORK)\b/)?.[0] ?? 'unknown'}, tried 3 times) — treating as non-blocking since parser verification passed.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
      } else {
        integrationOutcome = 'failed';
        failures.push(
          `bun test integration.test.ts exited ${run.exitCode} — the workflow failed to produce live data (tried 3 times).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
      }
    }
  }

  // Per-parameter coverage (Fix C/D). Each exposed parameter must have a
  // `param:<name>` integration test that actually RAN GREEN against live data —
  // a static source scan is not enough, because a waived suite never exercised
  // the param (R2: a filter wired to a field the server ignores looks "covered"
  // by source but does nothing). Per the keep+mark policy we never drop a param;
  // each is recorded in `paramVerification` as verified or not (with a reason),
  // and only a genuinely-uncovered param on a suite that DID run blocks compile.
  if (existsSync(integrationTestPath) && opts.likelyParams && opts.likelyParams.length > 0) {
    const integrationSrc = readFileSync(integrationTestPath, 'utf8');

    // Producer-sourced token params: union of build-plan-declared contracts and
    // mechanical detection (the recorded value appears in a SIBLING tool's
    // recorded response). Declared entries win — they carry the producer tool +
    // field used for stamping `sourcedFrom` and the MCP description.
    const recordedParamValues = new Map<string, string>();
    try {
      const wf = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
        parameters?: Array<{ name: string; default?: unknown }>;
      };
      for (const p of wf.parameters ?? []) {
        if (typeof p.default === 'string') recordedParamValues.set(p.name, p.default);
      }
    } catch {
      // best-effort — defaults are only a detection hint
    }
    const candidateSet = new Set(opts.candidateRequestSeqs ?? []);
    const siblingResponses = session.requests
      .filter((r) => !candidateSet.has(r.seq) && r.response?.body)
      .map((r) => ({ body: r.response?.body ?? '' }));
    const detected = detectTokenSources({
      likelyParams: opts.likelyParams,
      recordedParamValues,
      siblingResponses,
    });
    const tokenByName = new Map<string, TokenSource>();
    for (const d of detected) tokenByName.set(d.param, d);
    for (const d of opts.tokenParams ?? []) {
      tokenByName.set(d.param, {
        param: d.param,
        sourceTool: d.sourceTool,
        sourceField: d.sourceField,
      });
    }

    // Missing-producer guard: if a declared producer did not compile, the chain
    // cannot be exercised — waive (verified:false, keep+mark) rather than block
    // the consumer on something out of its control.
    const tokenSources: TokenSource[] = [];
    const waivedChain: ParamVerification[] = [];
    for (const ts of tokenByName.values()) {
      if (ts.sourceTool && !existsSync(pathJoin(toolDir, '..', ts.sourceTool, 'workflow.json'))) {
        waivedChain.push({
          name: ts.param,
          verified: false,
          reason: 'waived-chain',
          sourcedFrom: sourcedFromOf(ts),
        });
        warnings.push(
          `producer tool "${ts.sourceTool}" for token param "${ts.param}" is unavailable (did not compile) — the producer→consumer chain is left unverified (waived-chain).`,
        );
      } else {
        tokenSources.push(ts);
      }
    }

    const waivedNames = new Set(waivedChain.map((w) => w.name));
    const coverage = classifyParamCoverage({
      likelyParams: opts.likelyParams.filter((lp) => !waivedNames.has(lp.name)),
      integrationSrc,
      passedTests: integrationPassedTests,
      integrationOutcome,
      tokenSources,
    });
    paramVerification.push(...coverage.paramVerification, ...waivedChain);
    if (coverage.tautological.length > 0) {
      failures.push(
        `${coverage.tautological.length} parameter(s) have a passing \`param:<name>\` test that never calls runWorkflowWithLadder, so it does not exercise the live workflow: ${coverage.tautological.join(', ')}. Each per-parameter test must call the workflow with the override value and assert the response is constrained by it.`,
      );
    }
    if (coverage.uncovered.length > 0) {
      failures.push(
        `${coverage.uncovered.length} parameter(s) have no passing \`param:<name>\` integration test and no \`// exposed-but-not-verified\` annotation: ${coverage.uncovered.join(', ')}. Add a test titled \`param:<name> …\` that overrides the value, calls runWorkflowWithLadder, and asserts the response is constrained — or annotate the parameter as explicitly unverified. See prompts/compile-agent.md "Per-parameter coverage tests".`,
      );
    }
    if (coverage.unchained.length > 0) {
      const details = coverage.unchained
        .map((name) => {
          const ts = tokenSources.find((t) => t.param === name);
          return ts?.sourceTool && ts.sourceField
            ? `\`${name}\` (mint from \`../${ts.sourceTool}/workflow.json\` → read field \`${ts.sourceField}\`)`
            : `\`${name}\``;
        })
        .join(', ');
      failures.push(
        `${coverage.unchained.length} producer-sourced token param(s) lack a CHAINED \`param:<name>\` test that mints a FRESH value from the producer tool: ${details}. Each test must call runWorkflowWithLadder on the named producer's \`workflow.json\`, read the named field from its result, and pass THAT value (not the recorded constant) into this tool — then assert the response is non-empty. If the producer only emits a bare fragment, fix the PRODUCER to emit the full value this tool consumes. See prompts/compile-agent.md "Producer-sourced token parameters".`,
      );
    }
  }

  // Producer-side token contract: the build plan requires this tool to emit
  // certain fields for sibling consumers. Fail if the parser doesn't reference a
  // declared field by name — otherwise the producer/consumer field name silently
  // diverges (plan says `hotel_id`, parser emits `propertyToken`) and the
  // consumer's chained test can never extract it.
  if ((opts.emittedTokens?.length ?? 0) > 0 && existsSync(parserPath)) {
    const parserSrc = readFileSync(parserPath, 'utf8');
    const missing = (opts.emittedTokens ?? [])
      .map((e) => e.field)
      .filter(
        (field) =>
          !new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(parserSrc),
      );
    if (missing.length > 0) {
      failures.push(
        `the build plan requires this tool's parser to emit ${missing
          .map((f) => `\`${f}\``)
          .join(', ')} so sibling consumer tools can use ${
          missing.length === 1 ? 'it' : 'them'
        } as an input token, but parser.ts does not emit ${
          missing.length === 1 ? 'that field' : 'those fields'
        }. Emit ${
          missing.length === 1 ? 'it' : 'each'
        } in every result item under the EXACT field name (the full value a consumer needs, never a bare fragment) — see read_build_plan "emitsTokens".`,
      );
    }
  }

  if (existsSync(parserPath) || existsSync(parserTestPath)) {
    const output = await typecheckArtifacts(toolDir, ['parser.ts', 'request-transform.ts']);
    if (output.exitCode !== 0 || output.timedOut) {
      failures.push(
        `generated TypeScript artifacts failed typecheck (bunx tsc --noEmit -p .imprint-typecheck.tsconfig.json) exited ${output.exitCode}${output.timedOut ? ' after timing out' : ''}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }

  const loadBearing = identifyLoadBearingRequests(session);
  if (loadBearing.length > 0 && existsSync(parserPath)) {
    const firstReq = loadBearing[0];
    if (firstReq?.response?.body) {
      try {
        const cacheBust = `?t=${Date.now()}`;
        const fileUrl = `file://${parserPath}${cacheBust}`;
        const mod = await import(fileUrl);
        if (typeof mod.extract === 'function') {
          let raw: unknown;
          const responseBody = firstReq.response.body;
          try {
            raw = JSON.parse(responseBody);
          } catch {
            raw = responseBody;
          }

          const allResponses = loadBearing.map((r) => {
            try {
              return r.response?.body ? JSON.parse(r.response.body) : r.response?.body;
            } catch {
              return r.response?.body;
            }
          });
          const extracted = mod.extract(raw, {
            params: {},
            responses: allResponses,
          });
          if (
            extracted == null ||
            (typeof extracted === 'object' && Object.keys(extracted).length === 0)
          ) {
            failures.push(
              'parser.extract() returns null or empty when given the captured response body',
            );
          }
        }
      } catch {
        // already flagged above if import failed
      }
    }
  }

  return { failures, warnings, paramVerification };
}
