/**
 * Shared compile-agent tool implementations.
 *
 * The same 8 read/write tools and the verification logic are used both by
 * the in-process agent loop (anthropic-api / vertex providers) and by the
 * stdio MCP server that claude-cli drives through `--mcp-config`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin, relative as pathRelative } from 'node:path';
import type { AgentTool } from './agent.ts';
import { inferAppApiHosts } from './app-api-hosts.ts';
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
  return [
    buildReadSessionSummaryTool(session, context),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    buildSearchResponseBodyTool(session),
    buildWriteFileTool(toolDir),
    buildReadFileTool(toolDir),
    buildRunBashTool(toolDir, credEnv),
    buildRunTestsTool(toolDir, sessionPath, credEnv),
  ];
}

interface CompileToolContext {
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  classifications?: ClassifiedValue[];
  teachCredentials?: { site: string; values: Record<string, string> };
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
      const selectedRequestSeqs = new Set(context.candidate?.requestSeqs ?? []);
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
          selectedForCandidate: selectedRequestSeqs.has(r.seq),
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
              requestSeqs: context.candidate.requestSeqs,
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
  if (req.body) result.requestBody = req.body;

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
  let overhead = fullSummarySize - arrayBefore;

  const estimateFullSize = () => JSON.stringify(reduced).length + overhead;

  // Phase 1: drop responseBody from non-candidate requests (shared dependencies)
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      if (r.sharedDependency && !r.selectedForCandidate && r.inlineData) {
        const inline = r.inlineData as Record<string, unknown>;
        delete inline.responseBody;
        delete inline.responseBodyStructure;
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
      delete inline.responseBody;
      delete inline.responseBodyStructure;
      inline.responseBodyTruncated = true;
      inline.responseBodyNote = 'omitted to fit summary budget — use read_response_body';
    }
  }

  // Phase 4: drop inline data entirely if still over budget
  if (estimateFullSize() > budget) {
    for (const r of reduced) {
      delete r.inlineData;
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

function buildCaptureFromPath(
  name: string,
  producerPath: string,
): CaptureHint['capture'] | null {
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
  const bySeq = new Map<number, CapturedRequest>();
  for (const request of identifyLoadBearingRequests(session)) bySeq.set(request.seq, request);
  for (const request of session.requests) {
    if (preserveSeqs.has(request.seq)) bySeq.set(request.seq, request);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
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

function buildRunBashTool(
  toolDir: string,
  credEnv?: Record<string, string>,
): AgentTool {
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

async function runCommand(
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

async function runGeneratedArtifactTypecheck(
  exampleDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const configPath = pathJoin(exampleDir, '.imprint-typecheck.tsconfig.json');
  const rootTsconfig = pathJoin(REPO_ROOT, 'tsconfig.json');
  const extendsPath = normalizeTsconfigPath(pathRelative(exampleDir, rootTsconfig));

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        extends: extendsPath,
        include: ['parser.ts', 'request-transform.ts'],
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
      exampleDir,
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

// ─── External Verification ──────────────────────────────────────────────────

export async function externalVerification(
  toolDir: string,
  session: Session,
  sessionPath: string,
  opts: { expectedToolName?: string } = {},
): Promise<{ failures: string[]; warnings: string[] }> {
  const failures: string[] = [];
  const warnings: string[] = [];

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
    const expectMatches = src.match(/expect\s*\(/g) ?? [];
    if (expectMatches.length < 3) {
      failures.push(`parser.test.ts has only ${expectMatches.length} expect() calls; need ≥3`);
    }

    const trivialPatterns = [
      /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/,
      /expect\s*\(\s*false\s*\)\.toBe\s*\(\s*false\s*\)/,
      /expect\s*\(\s*1\s*\)\.toBe\s*\(\s*1\s*\)/,
      /expect\s*\(\s*0\s*\)\.toBe\s*\(\s*0\s*\)/,
      /expect\s*\(\s*null\s*\)\.toBeNull/,
      /expect\s*\(\s*undefined\s*\)\.toBeUndefined/,
      /expect\s*\(\s*"[^"]*"\s*\)\.toBe\s*\(\s*"[^"]*"\s*\)/,
      /expect\s*\(\s*'[^']*'\s*\)\.toBe\s*\(\s*'[^']*'\s*\)/,
    ];
    for (const pattern of trivialPatterns) {
      if (pattern.test(src)) {
        failures.push(
          'parser.test.ts contains trivial tautological assertions like expect(true).toBe(true) — tests must reference real values',
        );
        break;
      }
    }
  }

  if (existsSync(parserTestPath)) {
    const result = await runCommand(`bun test ${parserTestPath}`, toolDir, 120000, {
      [SESSION_PATH_ENV]: sessionPath,
    });
    const output = JSON.parse(result.result) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    if (output.exitCode !== 0) {
      failures.push(
        `bun test parser.test.ts exited ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }

  const integrationTestPath = pathJoin(toolDir, 'integration.test.ts');
  if (!existsSync(integrationTestPath)) {
    failures.push(
      'integration.test.ts was not written — the tool must include a live API test that calls the workflow and verifies it returns real data',
    );
  } else {
    let integrationPassed = false;
    let lastOutput = { stdout: '', stderr: '', exitCode: 1 };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runCommand(`bun test ${integrationTestPath}`, toolDir, 60000);
      lastOutput = JSON.parse(result.result) as {
        stdout: string;
        stderr: string;
        exitCode: number;
      };
      if (lastOutput.exitCode === 0) {
        integrationPassed = true;
        break;
      }
    }
    if (!integrationPassed) {
      const combined = `${lastOutput.stdout}\n${lastOutput.stderr}`;
      const botSignatures = /PerimeterX|DataDome|Akamai|captcha|challenge|blocked|rate.?limit/i;
      const hasStatusBlock = /\b(403|429)\b/.test(combined);
      if (hasStatusBlock && botSignatures.test(combined)) {
        warnings.push(
          `integration test failed with likely bot-detection or rate-limiting (tried 3 times) — treating as non-blocking since parser verification passed.\nstdout:\n${lastOutput.stdout}\nstderr:\n${lastOutput.stderr}`,
        );
      } else {
        failures.push(
          `bun test integration.test.ts exited ${lastOutput.exitCode} — the workflow failed to produce live data (tried 3 times).\nstdout:\n${lastOutput.stdout}\nstderr:\n${lastOutput.stderr}`,
        );
      }
    }
  }

  if (existsSync(parserPath) || existsSync(parserTestPath)) {
    const output = await runGeneratedArtifactTypecheck(toolDir);
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

  return { failures, warnings };
}
