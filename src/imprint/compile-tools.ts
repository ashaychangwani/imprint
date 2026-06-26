/**
 * Shared compile-agent tool implementations.
 *
 * The same 8 read/write tools and the verification logic are used both by
 * the in-process agent loop (anthropic-api provider) and by the
 * stdio MCP server that claude-cli drives through `--mcp-config`.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join as pathJoin, relative as pathRelative } from 'node:path';
import type { AgentTool } from './agent.ts';
import { inferAppApiHosts } from './app-api-hosts.ts';
import {
  type AssignedSharedModule,
  type RequiredInput,
  type SharedModuleManifestEntry,
  planSliceForTool,
  readBuildPlanFile,
  resolveAssignedModules,
} from './build-plan.ts';
import { splitSetCookieHeader } from './cookie-jar.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import {
  endpointsForSeqs,
  groundEvent,
  groundingForEvents,
  inputProvenance,
} from './param-grounding.ts';
import { detectPageMintedHeaders } from './redact.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { isSensitiveHeader } from './sensitive-keys.ts';
import { type ClassifiedValue, looksLikeToken } from './session-diff.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  type BootstrapCapture,
  type CapturedRequest,
  type RequestCapture,
  type Session,
  SessionSchema,
  WorkflowSchema,
} from './types.ts';

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
    buildRevealRequestTool(sessionPath),
    buildDiffRequestForEventTool(session, context),
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

export interface CompileToolContext {
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
      "Read this tool's slice of the shared build plan: shared modules to import (instead of re-implementing), parser guidance, the parameter checklist, the auth recipe (when dependsOnAuth is true, a standalone authenticate tool handles login — skip request[0] login), and the opaque-token contract (fields this tool must EMIT for siblings, and params it CONSUMES from siblings).",
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const plan = readBuildPlanFile(buildPlanPath);
      if (!plan) return { result: 'No build plan available for this run.' };
      const slice = planSliceForTool(plan, toolName);
      if (!slice) return { result: `No build-plan slice for tool "${toolName}".` };
      const assigned = resolveAssignedModules(plan, toolName, manifest).filter((m) => m.verified);
      const emitsTokens = slice.tool.emitsTokens ?? [];
      const tokenParams = slice.tool.tokenParams ?? [];
      const requiredInputs = slice.tool.requiredInputs ?? [];
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
      // Per-source wiring guidance for the general dependency contract. These are
      // the inputs the request NEEDS — emit each with the stated wiring; use
      // reveal_request to read the recorded value before deciding. The verifier
      // injects a dropped one and BLOCKS if a non-producer input stays unwired.
      const inputNotes = requiredInputs.map((ri) => {
        switch (ri.source) {
          case 'auth':
            return `CONTRACTED INPUT @ ${ri.location}: a durable session token from login — wire it as \`\${credential.${ri.credentialName}}\` (the authenticate tool persists it). Do NOT hardcode the recorded token.`;
          case 'producer_tool': {
            const fieldNote = ri.producerField ? `'s \`${ri.producerField}\` output` : '';
            const paramName = ri.param ?? ri.producerField ?? 'the value';
            return `CONTRACTED INPUT @ ${ri.location}: an opaque token minted by the \`${ri.producerTool}\` tool${fieldNote} — expose it as param \`${paramName}\` and chain it (see CONSUMER CONTRACT above).`;
          }
          case 'browser_state':
            return ri.location === 'referer'
              ? `CONTRACTED INPUT: this request originates from ${ri.bootstrapUrl} — set workflow.bootstrap.url to that page so its context/anti-bot token is minted before API replay.`
              : `CONTRACTED INPUT @ ${ri.location}: a value an earlier response / the page mints — capture it and wire it as \`\${state.${ri.stateName}}\` (add the capture/bootstrap that produces it).`;
          case 'generated':
            return `CONTRACTED INPUT @ ${ri.location}: a fresh per-call value — wire it as \`\${generated.${ri.generated}}\` (minted anew each call). Do NOT freeze the recorded value.`;
          case 'static':
            return `CONTRACTED INPUT @ ${ri.location}: a page-minted app constant — emit it verbatim as the recorded literal. It is functional, not boilerplate; do not drop it.`;
          default:
            return `CONTRACTED INPUT @ ${ri.location}: wire it as \`\${param.${ri.param}}\`.`;
        }
      });
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
            dependsOnAuth: slice.tool.dependsOnAuth ?? false,
            emitsTokens,
            tokenParams,
            requiredInputs,
            note:
              assigned.length > 0
                ? 'Import the listed shared modules via their importPath (request-transform → set workflow.json "requestTransformModule"; parser-helper/types → import from parser.ts) instead of re-implementing their logic. The verifier fails this tool if an assigned module is not imported.'
                : 'No shared modules assigned — build this tool self-contained.',
            tokenContract: tokenNotes.length > 0 ? tokenNotes : undefined,
            contractedInputs: inputNotes.length > 0 ? inputNotes : undefined,
          },
          null,
          2,
        ),
      };
    },
  };
}

// ─── Tool: read_session_summary ──────────────────────────────────────────────

export function buildReadSessionSummaryTool(
  session: Session,
  context: CompileToolContext,
): AgentTool {
  return {
    name: 'read_session_summary',
    description:
      'Get a high-level summary of the session including narration, selected candidate scope, load-bearing requests with inline data, capture hints, and parameter-grounding hints (for each recorded UI toggle, the exact request positions that changed — use these to ground each likelyParam instead of eyeballing one request).',
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

      // Event-correlated differential grounding hints: for each UI event the
      // candidate detector flagged, diff the request it triggered against the
      // prior equivalent request and report what changed. This is where a
      // filter/sort/option param's encoding actually lives — the agent maps
      // each diff to its likelyParam instead of eyeballing one request and
      // giving up (which previously shipped groundable params verified:false).
      const paramGroundingHints =
        (context.candidate?.eventSeqs?.length ?? 0)
          ? groundingForEvents(
              session,
              context.candidate?.eventSeqs ?? [],
              endpointsForSeqs(session, [...preserveSeqs]),
            ).map((g) => ({
              event: g.label || `event seq ${g.eventSeq}`,
              eventSeq: g.eventSeq,
              changedRequestSeq: g.triggeredSeq,
              vsRequestSeq: g.priorSeq,
              changes: g.changes.map((c) => `${c.path}: ${c.before} -> ${c.after}`),
            }))
          : [];

      // Input-value provenance: positions in a load-bearing request whose value
      // is an opaque id minted by an earlier response (not the user's text). The
      // agent must CHAIN+CAPTURE these, not freeze them or substitute raw param
      // text — substituting raw text where a resolved id belongs makes the
      // backend ignore the input and fall back to a default scope.
      // Scan the candidate's full seq set (capped), not just the representative
      // one: the representative may be a first text-only request whose response
      // mints the id, with the id only appearing in a later sibling request.
      const provenanceSeqs = [...new Set([...selectedRequestSeqs, ...allCandidateSeqs])]
        .sort((a, b) => a - b)
        .slice(0, 30);
      const inputProvenanceHints = inputProvenance(session, provenanceSeqs).map((p) => ({
        path: p.path,
        example: p.valueSample,
        inRequestSeq: p.requestSeq,
        mintedByResponseSeq: p.sourceSeq,
        mintedByEndpoint: p.sourceEndpoint,
        selfChain: p.selfChain,
      }));

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
        paramGroundingHints: paramGroundingHints.length > 0 ? paramGroundingHints : undefined,
        inputProvenanceHints: inputProvenanceHints.length > 0 ? inputProvenanceHints : undefined,
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

export function buildReadRequestTool(session: Session): AgentTool {
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

// ─── Tool: reveal_request ─────────────────────────────────────────────────────

/** Read the raw recording from disk, bypassing the in-memory (possibly-redacted)
 *  session. Cached per path so repeated reveals don't re-parse a large file. */
let revealCachePath = '';
let revealCacheSession: Session | null = null;
function loadRawRecording(sessionPath: string): Session | null {
  if (revealCachePath === sessionPath && revealCacheSession) return revealCacheSession;
  try {
    const parsed = SessionSchema.parse(JSON.parse(readFileSync(sessionPath, 'utf8')));
    revealCachePath = sessionPath;
    revealCacheSession = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/** Expose the unredacted request + response for one or more recorded seqs,
 *  read straight from the recording on disk. The session summary / read_request
 *  may hide sensitive-header values when the redaction gate is enabled; this tool
 *  lets the agent read the REAL value of an auth/session/gateway header (or a body
 *  field) on demand, so it can decide whether to wire it as a credential
 *  reference, a captured state value, or a generated value. The agent must still
 *  emit the placeholder the contract specifies — never a raw secret. */
function buildRevealRequestTool(sessionPath: string): AgentTool {
  return {
    name: 'reveal_request',
    description:
      'Reveal the FULL UNREDACTED request + response (URL, all headers incl. Authorization/Cookie/X-CSRF/app keys, body, response headers + body) for one or more recorded seq(s), read straight from the recording on disk — bypassing any redaction the session summary applies. Use this BEFORE deciding how to wire an auth/session/gateway header or an opaque body field: read the real value, judge whether it is a credential (→ ${credential.X}), a value another recorded response mints (→ capture/${state.X} or a producer token), a per-call generated value (→ ${generated.X}), or a true constant. NEVER copy a raw secret into workflow.json/parser.ts — emit the placeholder; the emit-time guard blocks raw secrets.',
    input_schema: {
      type: 'object',
      properties: {
        seqs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Request sequence number(s) to reveal.',
        },
      },
      required: ['seqs'],
    },
    handler: async (input: unknown) => {
      const { seqs } = input as { seqs: number[] };
      const raw = loadRawRecording(sessionPath);
      if (!raw) {
        return { result: `could not read the recording at ${sessionPath}`, isError: true };
      }
      const out = (Array.isArray(seqs) ? seqs : [seqs]).map((seq) => {
        const req = raw.requests.find((r) => r.seq === seq);
        if (!req) return { seq, error: 'not found' };
        return {
          seq,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: req.body,
          response: req.response
            ? {
                status: req.response.status,
                headers: req.response.headers,
                mimeType: req.response.mimeType,
                body: req.response.body,
              }
            : undefined,
        };
      });
      return { result: JSON.stringify(out, null, 2) };
    },
  };
}

// ─── Tool: diff_request_for_event ────────────────────────────────────────────

function buildDiffRequestForEventTool(session: Session, context: CompileToolContext): AgentTool {
  return {
    name: 'diff_request_for_event',
    description:
      "For a recorded UI event seq (a filter/sort/option toggle from selectedCandidate.eventSeqs), return the request it triggered diffed against the prior equivalent request. The changed positions are exactly where that interaction's parameter is encoded — use this to ground a param's encoding when paramGroundingHints does not already cover it. Returns the changed JSON paths (path: before -> after).",
    input_schema: {
      type: 'object',
      properties: {
        eventSeq: {
          type: 'number',
          description: 'Event sequence number (from selectedCandidate.eventSeqs)',
        },
      },
      required: ['eventSeq'],
    },
    handler: async (input: unknown) => {
      const { eventSeq } = input as { eventSeq: number };
      const reqSeqs = [
        ...((context.candidate?.representativeSeqs?.length ?? 0) > 0
          ? (context.candidate?.representativeSeqs ?? [])
          : (context.candidate?.requestSeqs ?? [])),
        ...(context.candidate?.dependencySeqs ?? []),
      ];
      const endpoints = endpointsForSeqs(session, reqSeqs);
      const g = groundEvent(session, eventSeq, endpoints.size > 0 ? endpoints : undefined);
      if (!g.triggeredSeq) {
        return {
          result: `Event ${eventSeq} triggered no comparable request within the window — it may be a client-side-only interaction (no server param), or its request was telemetry. If a filter/sort visibly changed results with no new request, it is applied client-side and cannot be reproduced via request replay.`,
        };
      }
      return {
        result: JSON.stringify(
          {
            event: g.label,
            eventSeq: g.eventSeq,
            changedRequestSeq: g.triggeredSeq,
            vsRequestSeq: g.priorSeq,
            endpoint: g.endpoint,
            changes: g.changes.map((c) => `${c.path}: ${c.before} -> ${c.after}`),
          },
          null,
          2,
        ),
      };
    },
  };
}

// ─── Tool: read_response_body ────────────────────────────────────────────────

export function buildReadResponseBodyTool(session: Session): AgentTool {
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

export function buildWriteFileTool(toolDir: string, extraAllowed: string[] = []): AgentTool {
  const allowed = [
    'workflow.json',
    'parser.ts',
    'parser.test.ts',
    'request-transform.ts',
    'integration.test.ts',
    ...extraAllowed,
  ];
  return {
    name: 'write_file',
    description: `Write a file to the generated tool directory. Allowed paths: ${allowed.join(', ')}, notes/*.md`,
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

export function buildReadFileTool(toolDir: string): AgentTool {
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

export function buildRunBashTool(toolDir: string, credEnv?: Record<string, string>): AgentTool {
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
      const { command, timeoutSec = 120 } = input as { command: string; timeoutSec?: number };

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
    // `detached: true` makes the child its own process-group leader so a timeout
    // can SIGKILL the WHOLE tree (sh → bun → Chrome), not just `sh`.
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      detached: true,
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
      // Kill the whole process GROUP, not just `sh`. A hung `bun run probe.ts`
      // spawns bun + Chrome children that survive a bare proc.kill() (SIGTERM to
      // sh only); they keep the stdout pipe open so 'close' never fires, hanging
      // this call until the outer MCP tool timeout (30m) — exactly what ate a
      // tool's compile budget. SIGKILL the group so the timeout reaps bun + any
      // leaked browser and 'close' fires promptly.
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);

      // Reap the whole process GROUP on EVERY exit, not just on timeout. The
      // compile verifier runs `bun test`, whose runner calls process.exit() the
      // instant the suite passes — and bun does NOT run process 'exit' /
      // 'beforeExit' handlers (only afterAll), so the compile cdp pool's
      // idle-close timer never fires and its launchChromium child is orphaned
      // (reparented to PID 1), accumulating across a multi-tool/multi-site teach
      // until the box OOMs. That child is still in THIS process group, though:
      // the group's id (= proc.pid) outlives the dead `sh` leader, so SIGKILLing
      // the group here reaps the orphaned Chrome regardless of how `bun test`
      // chose to exit. Harmless when the group is already empty (ESRCH). Skipped
      // on timeout (the group was already SIGKILLed above).
      if (!timedOut && proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // group already empty — nothing left to reap
        }
      }

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
  const rootTsconfig = realpathSync(pathJoin(REPO_ROOT, 'tsconfig.json'));
  const configDir = realpathSync(dir);
  const extendsPath = normalizeTsconfigPath(pathRelative(configDir, rootTsconfig));

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
  // Akamai Bot Manager runtime signal: `_abck` is the sensor cookie and a value
  // ending in `~-1~` means the session is UNVALIDATED (bot-flagged); `~0~` means
  // validated. The cdp bootstrap logs `_abck status after interaction: ~-1~` when
  // it ran the human-like interaction (mouse/scroll) and STILL could not validate
  // the sensor — i.e. it actively tried to beat the defense and failed. On such a
  // session Akamai serves a 200 "soft block" with empty/placeholder data instead
  // of a 403, so the live integration fails to produce data even though every
  // backend reports OK. Treat that as a bot-defense waiver (the tool falls through
  // to the runtime ladder / playbook and the audit validates it live) rather than
  // a hard compile failure. Scoped to the post-interaction confirmation so the
  // ordinary "cached jar not validated … — re-mint" log (which precedes a retry
  // that often succeeds) does NOT trip it.
  if (/_abck status after interaction:\s*~-1~/i.test(output)) return true;
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
  /** True when the run was killed by the wall-clock timeout (not a clean exit).
   *  Lets the classifier treat a truncated paced anti-bot suite as infra, never
   *  as a bot block (the partial output's fetch-403 must not look like a block). */
  timedOut: boolean;
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
  const output = JSON.parse(result.result) as {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
  };
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
    timedOut: output.timedOut ?? false,
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

interface IntegrationVerdict {
  /** Drives PARAM coverage: a waived suite lets per-param tests waive (non-blocking);
   *  `failed` blocks; `passed` grades params strictly. */
  outcome: 'passed' | 'waived-bot' | 'waived-infra' | 'failed';
  /** Drives `liveVerified` — INDEPENDENT of `outcome`. True when a backend returned
   *  real data this run (the workflow IS live-verifiable), even if the per-param
   *  suite was truncated/blocked. Decoupling these is the fix for tools whose
   *  stealth/cdp baseline succeeded shipping `liveVerified:false` just because the
   *  param suite hit the verifier timeout. */
  baselineLiveVerified: boolean;
  firstError: string;
  exhaustedBackends: string[];
  /** Non-null when a declared `${state.X}` capture returned null at runtime (a
   *  workflow-correctness error, not infra) — the caller crafts the actionable msg. */
  captureFailName: string | null;
  captureFailFromKnown: boolean;
}

/**
 * Pure classifier for the live integration run. Decides the suite `outcome` AND,
 * separately, whether the BASELINE was live-verified.
 *
 * Why two outputs: an anti-bot suite can have its baseline return real data
 * (liveVerified) while its per-param tests time out / get blocked (params waive,
 * non-blocking). The old code coupled `liveVerified` to the WHOLE suite passing,
 * so a tool whose stealth/cdp baseline succeeded shipped `liveVerified:false`
 * merely because the param suite was truncated by the 60s verifier timeout, and a
 * lone `fetch`-rung 403 in the partial output read as a total bot block.
 *
 * `baselineLiveVerified` = a backend returned real data this run, detected by the
 * ladder's `parallel probe: winner=<backend>` log (logged ONLY on an ok result —
 * robust when JUnit is absent because a timeout SIGKILLed the suite) OR a
 * non-`param:` baseline test passing in JUnit (robust when a memoized call skipped
 * the probe log).
 *
 * `exhaustedBackends` lists only backends whose probe digest line reported an
 * ERROR — NOT every backend that was "trying…" (cdp-replay/stealth-fetch usually
 * succeed and must not be reported as exhausted).
 */
export function classifyIntegrationOutcome(input: {
  exitCode: number;
  timedOut: boolean;
  combined: string;
  passedTests: ReadonlySet<string>;
  referencedStateBroken: boolean;
  failedCaptureNames: ReadonlySet<string>;
  /** A contracted input the plan declared is still missing/unresolved in the
   *  workflow. A live failure then is a CONTRACT GAP — a workflow-correctness
   *  error to fix — not a bot block to waive. Checked with the same pre-bot-defense
   *  precedence as the capture-fail branch. */
  contractGap?: boolean;
}): IntegrationVerdict {
  const { combined } = input;
  const baselineLiveVerified =
    /parallel probe: winner=/.test(combined) ||
    [...input.passedTests].some((t) => !t.startsWith('param:'));
  const exhaustedBackends = Array.from(
    new Set(
      Array.from(
        combined.matchAll(
          /^\s*([a-z-]+): (?:NETWORK|FORBIDDEN|RATE_LIMITED|BAD_RESPONSE|STATE_MISSING|AUTH_EXPIRED|UNKNOWN)\b/gm,
        ),
      ).map((m) => m[1] as string),
    ),
  );
  const firstErrorMatch = combined.match(/\b(NETWORK|FORBIDDEN|RATE_LIMITED)\b[^\n]{0,200}/);
  const firstError = firstErrorMatch?.[0]?.trim() ?? 'unknown';
  const base = { baselineLiveVerified, firstError, exhaustedBackends };

  if (input.exitCode === 0) {
    return {
      ...base,
      outcome: 'passed',
      baselineLiveVerified: true,
      firstError: '',
      exhaustedBackends: [],
      captureFailName: null,
      captureFailFromKnown: false,
    };
  }
  if (input.referencedStateBroken) {
    return { ...base, outcome: 'failed', captureFailName: null, captureFailFromKnown: false };
  }
  // Fix C — a STATE_MISSING traced to a declared capture is a workflow-correctness
  // error, not infra; waiving it would silently ship a broken workflow. Match the
  // EXACT runtime message (runtime.ts: `Required capture "<name>" (<source>) did
  // not produce a value.`) — the error code prefix is separated by an em-dash, not
  // a colon, so the old `STATE_MISSING:` regex never matched and these failures
  // wrongly fell through to the anti-bot branch (shipped waived-bot instead of
  // failed). Checked BEFORE the bot-defense branch so a capture-fail that also has
  // an `_abck` line in the log is still classified `failed`, not waived.
  const captureFailMatch = combined.match(
    /Required capture\s+"([^"]+)"\s*\([^)]*\)\s*did not produce a value/i,
  );
  if (captureFailMatch) {
    const name = captureFailMatch[1] ?? '';
    return {
      ...base,
      outcome: 'failed',
      captureFailName: name,
      captureFailFromKnown: input.failedCaptureNames.has(name),
    };
  }
  // Contract gap — a declared contracted input is still unwired/unresolved, so the
  // live failure is a capture/lowering gap to FIX, not anti-bot to waive. Same
  // pre-bot-defense precedence as the capture-fail branch: a bot-block line in the
  // log doesn't reclassify a contract gap as waived-bot.
  if (input.contractGap) {
    return {
      ...base,
      outcome: 'failed',
      firstError:
        firstError === 'unknown' ? 'contract-gap (a contracted input is unwired)' : firstError,
      captureFailName: null,
      captureFailFromKnown: false,
    };
  }
  // A verifier TIMEOUT truncated a paced suite — that's infra, NEVER a bot block.
  // (Don't let the partial output's fetch-403 masquerade as a total block.)
  if (input.timedOut) {
    return {
      ...base,
      outcome: 'waived-infra',
      firstError: firstError === 'unknown' ? 'verifier timeout (suite truncated)' : firstError,
      captureFailName: null,
      captureFailFromKnown: false,
    };
  }
  if (isBotDefenseFailure(combined)) {
    return { ...base, outcome: 'waived-bot', captureFailName: null, captureFailFromKnown: false };
  }
  // Every ladder rung exhausted with an infra error. Matches the runWorkflowWithLadder
  // probe summary (`all backends failed`) + the runWithLadder memo-path summary
  // (`ladder exhausted`) + stealth's `giving up` / non-escalatable markers.
  const hasImprintBlock =
    /\bRATE_LIMITED\b|\bFORBIDDEN\b|\bNETWORK\b/.test(combined) &&
    /non-escalatable|giving up|ladder exhausted|all backends failed/.test(combined);
  if (hasImprintBlock) {
    return { ...base, outcome: 'waived-infra', captureFailName: null, captureFailFromKnown: false };
  }
  return { ...base, outcome: 'failed', captureFailName: null, captureFailFromKnown: false };
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

/**
 * Stamp the integration-test waiver outcome onto workflow.json. When a tool's
 * integration test couldn't produce live data (anti-bot block or every-rung
 * NETWORK exhaustion), we ship anyway — but the workflow records
 * `liveVerified: false` plus the structured waiver reason so the audit gate
 * and the teach summary can flag it instead of silently treating it as
 * verified. Best-effort: a write failure never blocks a tool that already
 * passed parser + schema verification.
 */
export function applyLiveVerification(
  toolDir: string,
  liveVerification:
    | { kind: 'waived-bot' | 'waived-infra'; firstError: string; exhaustedBackends: string[] }
    | undefined,
): void {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return;
  let workflow: Record<string, unknown>;
  try {
    workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  } catch {
    return;
  }
  if (liveVerification) {
    workflow.liveVerified = false;
    workflow.liveVerifiedWaiver = liveVerification;
  } else {
    workflow.liveVerified = true;
    workflow.liveVerifiedWaiver = undefined;
  }
  try {
    writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort — non-fatal
  }
}

/** Strip `${...}` placeholders and query string from a workflow URL so it can
 *  be compared against a recorded request URL by (origin + path). Returns null
 *  when the URL is unparseable even after stripping. */
function normalizeUrlForMatch(rawUrl: string): { origin: string; path: string } | null {
  // Replace placeholders with a stable token, then try to parse. If the URL
  // still has a placeholder in the host/scheme it will fail — fine, caller
  // falls back to substring matching.
  const stripped = rawUrl.replace(/\$\{[^}]+\}/g, 'X');
  try {
    const u = new URL(stripped);
    return { origin: u.origin, path: u.pathname };
  } catch {
    return null;
  }
}

/** Find recorded requests whose (method, origin+path) matches the workflow
 *  request. Used by capture-cross-reference and hardcoded-body checks. */
function findRecordedMatches(
  session: Session,
  method: string,
  url: string,
  restrictToSeqs?: Set<number>,
): CapturedRequest[] {
  const norm = normalizeUrlForMatch(url);
  if (!norm) return [];
  const upperMethod = method.toUpperCase();
  return session.requests.filter((r) => {
    if (restrictToSeqs && !restrictToSeqs.has(r.seq)) return false;
    if (r.method.toUpperCase() !== upperMethod) return false;
    const rNorm = normalizeUrlForMatch(r.url);
    if (!rNorm) return false;
    return rNorm.origin === norm.origin && rNorm.path === norm.path;
  });
}

/** Case-insensitive header lookup against a `Record<string, string>` (which
 *  records preserve as they were captured — Chrome's DevTools protocol does not
 *  normalize). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Set-Cookie can appear multiple times; the captured shape is best-effort.
 *  Returns true if any Set-Cookie header in `headers` defines a cookie named
 *  `cookieName`. */
function setCookieDefines(headers: Record<string, string>, cookieName: string): boolean {
  const raw = headerValue(headers, 'set-cookie');
  if (!raw) return false;
  // Multiple cookies may be joined with newlines or commas; split conservatively.
  const cookies = raw.split(/\n|,(?=\s*[A-Za-z_])/);
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === cookieName) return true;
  }
  return false;
}

/** Fix A — cross-reference each declared `required` capture against the
 *  recording. The verifier rejects done() if the declared source doesn't
 *  actually carry the value, so the agent can no longer ship a workflow whose
 *  capture recipe will silently fail at runtime. General — not specific to
 *  any one capture source or site. */
function crossReferenceCaptures(
  workflow: ReturnType<typeof WorkflowSchema.parse>,
  session: Session,
  candidateRequestSeqs?: number[],
): { failures: string[]; failedCaptureNames: Set<string> } {
  const failures: string[] = [];
  const failedCaptureNames = new Set<string>();
  const restrictSet = candidateRequestSeqs ? new Set(candidateRequestSeqs) : undefined;

  // Bootstrap captures
  if (workflow.bootstrap?.captures) {
    for (const cap of workflow.bootstrap.captures) {
      if (cap.required === false) continue;
      const matches = findRecordedMatches(session, 'GET', workflow.bootstrap.url, restrictSet);
      // Bootstrap URL might not be in candidateRequestSeqs (dependency); retry
      // without the restriction so we can still cross-reference.
      const recorded = matches[0] ?? findRecordedMatches(session, 'GET', workflow.bootstrap.url)[0];
      if (!recorded) {
        // Out of scope; do not fail — we can't prove anything.
        continue;
      }
      const fail = validateCaptureAgainstRecording(cap, recorded, 'bootstrap GET');
      if (fail) {
        failures.push(fail);
        failedCaptureNames.add(cap.name);
      }
    }
  }

  // Per-request captures
  for (const [i, req] of workflow.requests.entries()) {
    if (!req.captures) continue;
    for (const cap of req.captures) {
      if (cap.required === false) continue;
      const matches = findRecordedMatches(session, req.method, req.url, restrictSet);
      const recorded = matches[0] ?? findRecordedMatches(session, req.method, req.url)[0];
      if (!recorded) continue;
      const fail = validateCaptureAgainstRecording(
        cap,
        recorded,
        `request[${i}] ${req.method} ${req.url}`,
      );
      if (fail) {
        failures.push(fail);
        failedCaptureNames.add(cap.name);
      }
    }
  }

  return { failures, failedCaptureNames };
}

/** Fix 2 — cross-reference every capture that a request actually DEPENDS ON
 *  (referenced via `${state.X}` in a header/body/url) against the recording,
 *  regardless of the capture's `required` flag. Fix A only checks `required`
 *  captures and only against the capture's own URL response; that misses the
 *  common anti-bot shape where a `required:false` html_regex capture (csrf /
 *  csp-nonce) is scraped from a bootstrap page that isn't itself in the
 *  recording, yet a request hard-references `${state.csrf_token}` in a header.
 *  At runtime that reference STATE_MISSINGs the whole workflow. This check
 *  rejects done() so the agent must fix the pattern (or source).
 *
 *  Scope: html_regex / text_regex captures (robustly checkable by testing the
 *  pattern against every recorded same-origin HTML document body). Other
 *  sources referenced-but-not-required are left to Fix A / the integration test.
 *  General — not specific to any site or token. */
export function crossReferenceReferencedStateCaptures(
  workflow: ReturnType<typeof WorkflowSchema.parse>,
  session: Session,
): { failures: string[]; failedCaptureNames: Set<string> } {
  const failures: string[] = [];
  const failedCaptureNames = new Set<string>();

  // 1) Collect every ${state.X} name referenced across request url/headers/body.
  const referenced = new Set<string>();
  const stateRefRe = /\$\{state\.([A-Za-z0-9_]+)\}/g;
  const scan = (s: string | undefined): void => {
    if (!s) return;
    for (const m of s.matchAll(stateRefRe)) {
      const name = m[1];
      if (name) referenced.add(name);
    }
  };
  for (const req of workflow.requests) {
    scan(req.url);
    scan(req.body);
    for (const hv of Object.values(req.headers ?? {})) scan(hv);
  }
  if (referenced.size === 0) return { failures, failedCaptureNames };

  // 2) Index captures by name (bootstrap + per-request).
  const capByName = new Map<string, BootstrapCapture | RequestCapture>();
  for (const cap of workflow.bootstrap?.captures ?? []) capByName.set(cap.name, cap);
  for (const req of workflow.requests) {
    for (const cap of req.captures ?? []) capByName.set(cap.name, cap);
  }

  // 3) Gather recorded HTML document bodies, preferring the bootstrap origin but
  //    falling back to all HTML bodies (the bootstrap page itself may be absent
  //    from the recording — e.g. costco's /Rental-Cars).
  let targetOrigin: string | undefined;
  try {
    if (workflow.bootstrap?.url) targetOrigin = new URL(workflow.bootstrap.url).origin;
  } catch {
    /* leave undefined */
  }
  const isHtmlDoc = (r: CapturedRequest): boolean => {
    const mime = r.response?.mimeType ?? '';
    return (
      (mime.includes('text/html') || r.resourceType === 'Document') &&
      typeof r.response?.body === 'string' &&
      r.response.body.length > 0
    );
  };
  const sameOrigin = (r: CapturedRequest): boolean => {
    if (!targetOrigin) return true;
    try {
      return new URL(r.url).origin === targetOrigin;
    } catch {
      return false;
    }
  };
  let htmlBodies = session.requests
    .filter((r) => isHtmlDoc(r) && sameOrigin(r))
    .map((r) => r.response?.body ?? '');
  if (htmlBodies.length === 0) {
    htmlBodies = session.requests.filter(isHtmlDoc).map((r) => r.response?.body ?? '');
  }

  // 4) For each referenced state name produced by an html_regex/text_regex
  //    capture, assert the pattern matches at least one recorded HTML body.
  for (const name of referenced) {
    const cap = capByName.get(name);
    if (!cap) continue; // may be seeded by the fetch-bootstrap jar — not statically known
    if (cap.source !== 'html_regex' && cap.source !== 'text_regex') continue;
    if (failedCaptureNames.has(name)) continue;
    let re: RegExp;
    try {
      re = new RegExp(cap.pattern);
    } catch (err) {
      failures.push(
        `capture "${name}" (referenced via \${state.${name}} in a request) has an invalid regex /${cap.pattern}/: ${err instanceof Error ? err.message : String(err)}.`,
      );
      failedCaptureNames.add(name);
      continue;
    }
    if (htmlBodies.length === 0) continue; // no recorded HTML to check against
    const matches = htmlBodies.some((body) => re.test(body));
    if (!matches) {
      failures.push(
        `capture "${name}" (source "${cap.source}") is referenced via \${state.${name}} in a request, but its pattern /${cap.pattern}/ does not match ANY recorded HTML page body for this site. At runtime \${state.${name}} resolves to nothing → the request fails with STATE_MISSING. Fix the pattern to match the token as it actually appears in the recorded page (inspect the recorded HTML), or change the capture source. (required:${cap.required === false ? 'false' : 'true'} does not exempt this — the request hard-references the value.)`,
      );
      failedCaptureNames.add(name);
    }
  }

  return { failures, failedCaptureNames };
}

/** Check one capture against the recorded request it should be reading from.
 *  Returns a failure message or null. */
function validateCaptureAgainstRecording(
  cap: BootstrapCapture | RequestCapture,
  recorded: CapturedRequest,
  context: string,
): string | null {
  const respHeaders = recorded.response?.headers ?? {};
  const respBody = recorded.response?.body ?? '';
  const fix = (suggestion: string) =>
    `capture "${cap.name}" on ${context}: declared source "${cap.source}" did not produce a value in the recording (seq=${recorded.seq}). ${suggestion}`;

  switch (cap.source) {
    case 'response_header': {
      const v = headerValue(respHeaders, cap.header);
      if (v && v.length > 0) return null;
      return fix(
        `The recorded response has no "${cap.header}" header. Inspect the recorded response headers for a header that actually carries this value, or switch to source: 'html_regex' / 'cookie' / 'dom_*' if the value lives elsewhere.`,
      );
    }
    case 'cookie': {
      if (setCookieDefines(respHeaders, cap.cookie)) return null;
      return fix(
        `The recorded response Set-Cookie does not define cookie "${cap.cookie}". Check the recorded response headers and pick the correct cookie name, or switch source if the value isn't in a cookie.`,
      );
    }
    case 'html_regex':
    case 'text_regex': {
      try {
        const re = new RegExp(cap.pattern);
        if (re.test(respBody)) return null;
      } catch (err) {
        return fix(
          `Pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      return fix(
        `Pattern /${cap.pattern}/ does not match the recorded response body. The token may live in a different location — check response headers (use source: 'response_header'), Set-Cookie (use source: 'cookie'), or revise the pattern.`,
      );
    }
    case 'json': {
      // 'json' captures use a path expression; static validation is fragile.
      // Skip — the integration test surfaces failures.
      return null;
    }
    default:
      // dom_attribute, dom_text, local_storage, session_storage — not statically
      // verifiable from a HAR-style recording.
      return null;
  }
}

/** Fix B — detect request body fields hardcoded to the recording's first
 *  invocation value when the recording proves the field is user input (varies
 *  across multiple recorded invocations of the same endpoint). The verifier
 *  rejects done() so the agent must expose the field as `${param.X}` (or use a
 *  requestTransformModule). General — not specific to any one site. */
function detectHardcodedSessionValues(
  workflow: ReturnType<typeof WorkflowSchema.parse>,
  session: Session,
  candidateRequestSeqs?: number[],
  dependencyRequestSeqs?: number[],
): string[] {
  // Skip the whole check when the workflow uses a requestTransformModule:
  // that module is the agent's declared escape hatch for programmatic body
  // construction (e.g. _uid generators, position-dependent encoding), and
  // any literal we see in workflow.json's body field may be overridden at
  // runtime by the transform. Trying to second-guess transform behavior
  // statically is the wrong layer.
  if (workflow.requestTransformModule) return [];

  const failures: string[] = [];
  const allowedSeqs = new Set<number>([
    ...(candidateRequestSeqs ?? []),
    ...(dependencyRequestSeqs ?? []),
  ]);
  const restrictSet = allowedSeqs.size > 0 ? allowedSeqs : undefined;

  for (const [i, req] of workflow.requests.entries()) {
    if (!req.body || req.body.length === 0) continue;

    const matches = findRecordedMatches(session, req.method, req.url, restrictSet);
    if (matches.length < 2) continue;
    const firstMatch = matches[0];
    if (!firstMatch) continue;

    // Determine body parser based on the recorded Content-Type (workflow may
    // have stripped headers).
    const recordedCt =
      headerValue(firstMatch.headers, 'content-type') ?? req.headers['Content-Type'] ?? '';

    const parsed = matches
      .map((m) => parseBodyForFieldExtraction(m.body ?? '', recordedCt))
      .filter((p): p is Record<string, string> => p !== null);
    if (parsed.length < 2) continue;

    // Collect distinct values per field
    const valuesByField = new Map<string, Set<string>>();
    for (const map of parsed) {
      for (const [k, v] of Object.entries(map)) {
        if (!valuesByField.has(k)) valuesByField.set(k, new Set());
        valuesByField.get(k)?.add(v);
      }
    }

    const varying: Array<{ field: string; values: string[] }> = [];
    for (const [field, set] of valuesByField) {
      if (set.size < 2) continue;
      varying.push({ field, values: [...set].slice(0, 4) });
    }
    if (varying.length === 0) continue;

    // For each varying field, check whether the workflow body has the first
    // recorded value as a literal substring AND no template placeholder for it.
    const workflowParsed = parseBodyForFieldExtraction(req.body, recordedCt);
    if (!workflowParsed) continue;

    const offenders: Array<{ field: string; literal: string; distinctValues: string[] }> = [];
    for (const { field, values } of varying) {
      const wfValue = workflowParsed[field];
      if (wfValue === undefined) continue;
      // If the workflow value contains ANY placeholder, it's templated → OK.
      if (/\$\{(param|state|credential|response)\.[A-Za-z0-9_[\]]+\}/.test(wfValue)) continue;
      // The workflow value is a literal. Compare against the first recorded
      // value — if equal, this is a frozen-session-value bug. (Equality vs
      // just-non-templated avoids false positives where the agent picked a
      // sensible default different from any recorded seq.)
      if (values.includes(wfValue)) {
        offenders.push({ field, literal: wfValue, distinctValues: values });
      }
    }

    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) =>
          `    ${o.field}=${JSON.stringify(o.literal)} — recorded values across seqs: [${o.distinctValues
            .map((v) => JSON.stringify(v))
            .join(', ')}]`,
      );
      failures.push(
        `request[${i}] ${req.method} ${req.url} body has ${offenders.length} field(s) frozen to one recorded user's session — the recording proves these are user input:\n${lines.join('\n')}\nReplace each with \${param.NAME} and add the parameter to workflow.parameters, OR move body construction into a requestTransformModule.`,
      );
    }
  }

  return failures;
}

/** Parse a request body into a flat field→value map for variation analysis.
 *  Supports form-urlencoded and (top-level) JSON. Returns null for shapes the
 *  check can't reason about. */
function parseBodyForFieldExtraction(
  body: string,
  contentType: string,
): Record<string, string> | null {
  const ct = contentType.toLowerCase();
  if (
    ct.includes('application/x-www-form-urlencoded') ||
    (!ct && body.includes('=') && body.includes('&'))
  ) {
    const out: Record<string, string> = {};
    for (const pair of body.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      out[k] = v;
    }
    return out;
  }
  if (ct.includes('application/json') || (ct === '' && body.trim().startsWith('{'))) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[k] = String(v);
          }
        }
        return out;
      }
    } catch {
      // not parseable
    }
  }
  return null;
}

// ─── Emit-time secret guard (Thread C) ────────────────────────────────────────

/** Collect the raw secret values present in a recording: every sensitive-header
 *  value (Authorization / X-CSRF / …), each individual cookie value from Cookie /
 *  Set-Cookie, on both requests and responses. Filtered to token-shaped values so
 *  an incidental `lang=en` cookie isn't treated as a secret. PAGE-MINTED sensitive
 *  headers (app keys/gateway constants the site bakes into its JS) are EXCLUDED:
 *  they are public app config the compile agent is told to hardcode verbatim, NOT
 *  per-user secrets, so blocking them would break legitimate tools. `imprint record`
 *  uses a fresh browser profile, so a per-user token only appears AFTER the recorded
 *  login (post-interaction) and is never page-minted; the one already-authenticated
 *  (`--persist-profile`) case — a persisted bearer in storage sent as `Bearer
 *  <token>` — is caught because detectPageMintedHeaders scheme-strips the stored
 *  token. Cookies are never page-minted, so a hardcoded cookie value is always
 *  caught regardless. Structural — keyed on the recording's own values + the
 *  existing page-minted detector, never a header-name literal. */
function collectSensitiveHeaderValues(session: Session): Set<string> {
  const out = new Set<string>();
  const pageMinted = new Set(detectPageMintedHeaders(session));
  const add = (v: string | undefined) => {
    if (!v) return;
    if (looksLikeToken(v)) out.add(v);
    // A scheme-prefixed value ("Bearer <jwt>" / "Basic <b64>") has whitespace, so
    // looksLikeToken rejects the whole string — also capture the token segment(s).
    if (/\s/.test(v)) {
      for (const seg of v.split(/\s+/)) if (looksLikeToken(seg)) out.add(seg);
    }
  };
  const scan = (headers: Record<string, string> | undefined) => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!isSensitiveHeader(name)) continue;
      const lower = name.toLowerCase();
      if (pageMinted.has(lower)) continue; // public app constant — not a secret
      if (lower === 'cookie') {
        for (const part of value.split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) add(part.slice(eq + 1).trim());
        }
      } else if (lower === 'set-cookie') {
        for (const cookie of splitSetCookieHeader(value)) {
          const first = cookie.split(';', 1)[0] ?? '';
          const eq = first.indexOf('=');
          if (eq > 0) add(first.slice(eq + 1).trim());
        }
      } else {
        add(value);
      }
    }
  };
  for (const req of session.requests) {
    scan(req.headers);
    scan(req.response?.headers);
  }
  return out;
}

/**
 * Emit-time secret guard. Because the compile agent now SEES raw sensitive-header
 * values (the redaction gate is off by default), enforce that the emitted
 * artifacts contain ONLY placeholders — never a raw secret. Structural: the set
 * of "secrets" is keyed on the recording's own sensitive-header values plus any
 * known credential values the caller supplies — no hard-coded literals.
 *
 * For each known secret value that appears verbatim in workflow.json:
 *   - if `placeholderByValue` maps it to a placeholder, auto-rewrite it (the
 *     intended wiring the agent should have used), counted in `rewrites`;
 *   - otherwise it is a leak with no safe rewrite → blocking failure.
 * parser.ts is never rewritten (it is code, not a template) — any secret there
 * always blocks. Returns the (possibly-rewritten) workflow JSON text.
 */
export function assertNoRawSecrets(opts: {
  workflowJson: string;
  parserSrc?: string;
  session: Session;
  /** Raw secret value → intended placeholder, built by the caller from credential
   *  replacements and resolved contracted inputs. Keys are also treated as secrets
   *  to block (so a short credential value with no rewrite still fails). */
  placeholderByValue?: Map<string, string>;
  /** Values a `static` contracted input declares as intentionally-verbatim app
   *  constants (page-minted keys). Excluded from the block set — emitting them is
   *  the contract, not a leak. */
  allowedLiterals?: Set<string>;
}): { workflowJson: string; failures: string[]; rewrites: number } {
  const failures: string[] = [];
  let workflowJson = opts.workflowJson;
  let rewrites = 0;

  const placeholderByValue = opts.placeholderByValue ?? new Map<string, string>();
  // Auto-rewrite known values to their placeholder. Longest-first so a value that
  // is a prefix of another doesn't get partially clobbered.
  const rewriteEntries = [...placeholderByValue.entries()]
    .filter(([value, placeholder]) => value.length >= 4 && value !== placeholder)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [value, placeholder] of rewriteEntries) {
    if (workflowJson.includes(value)) {
      workflowJson = workflowJson.split(value).join(placeholder);
      rewrites++;
    }
  }

  // The block set: recording-derived sensitive-header values + every known
  // secret (placeholder keys). After rewriting, any survivor is an unguarded leak.
  // Static literals (page-minted app constants the contract emits verbatim) are
  // excluded — they are not per-user secrets.
  const allowedLiterals = opts.allowedLiterals ?? new Set<string>();
  const secrets = collectSensitiveHeaderValues(opts.session);
  for (const value of placeholderByValue.keys()) {
    if (value.length >= 4) secrets.add(value);
  }
  for (const lit of allowedLiterals) secrets.delete(lit);
  const seen = new Set<string>();
  const checkText = (text: string | undefined, where: string) => {
    if (!text) return;
    for (const secret of secrets) {
      if (seen.has(secret)) continue;
      if (text.includes(secret)) {
        seen.add(secret);
        failures.push(
          `${where} contains a raw secret value from the recording (a sensitive-header or credential value). Never hardcode a secret — wire it as the contracted placeholder instead: ${'${credential.NAME}'} for a durable auth token, ${'${state.NAME}'} for a value an earlier response/bootstrap produces, ${'${response[N].path}'} for a sibling-tool token, or ${'${generated.KIND}'} for a per-call value. Use reveal_request to read the value, then read_build_plan for its contracted wiring.`,
        );
      }
    }
  };
  checkText(workflowJson, 'workflow.json');
  checkText(opts.parserSrc, 'parser.ts');

  return { workflowJson, failures, rewrites };
}

// ─── Contracted-input injection + gate (Threads B/C) ──────────────────────────

interface RawWorkflowRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  captures?: Array<{ name?: string }>;
}
interface RawWorkflow {
  requests?: RawWorkflowRequest[];
  bootstrap?: { url?: string; captures?: Array<{ name?: string }> };
}

/** The placeholder (or verbatim literal) a contracted input wires in at its
 *  recorded location. Returns null for `referer` (a bootstrap, not a substitution)
 *  and for `response` (the response index isn't known at plan time). */
function wiringToken(ri: RequiredInput): string | null {
  switch (ri.wiring) {
    case 'credential':
      return ri.credentialName ? `\${credential.${ri.credentialName}}` : null;
    case 'state':
      return ri.stateName ? `\${state.${ri.stateName}}` : null;
    case 'generated':
      return ri.generated ? `\${generated.${ri.generated}}` : null;
    case 'param':
      return ri.param ? `\${param.${ri.param}}` : null;
    case 'literal':
      return ri.literal ?? null;
    default:
      return null;
  }
}

function headerNameOf(location: string): string | null {
  return location.toLowerCase().startsWith('header:') ? location.slice('header:'.length) : null;
}

function looseUrlPath(url: string): string {
  const q = url.indexOf('?');
  const noQuery = q >= 0 ? url.slice(0, q) : url;
  const m = noQuery.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  return m ? (m[1] ?? '/') : noQuery;
}

/** All ${state.X} capture names already declared in the workflow (request + bootstrap
 *  captures) — gates browser_state header injection so we never add a `${state.X}`
 *  that has no producer. */
function declaredCaptureNames(workflow: RawWorkflow): Set<string> {
  const names = new Set<string>();
  for (const r of workflow.requests ?? []) {
    for (const c of r.captures ?? []) if (c?.name) names.add(c.name);
  }
  for (const c of workflow.bootstrap?.captures ?? []) if (c?.name) names.add(c.name);
  return names;
}

/**
 * Deterministically inject a DROPPED contracted input into the workflow before the
 * live test — the safety net behind the prompt-guided CONTRACTED-HEADERS rule.
 * Conservative: only fills always-resolvable header wirings (credential / static
 * literal / generated, plus browser_state when a matching capture already exists)
 * and sets `workflow.bootstrap.url` from a referer hint. Param-wired inputs
 * (producer_tool / user_param) are left to the existing param machinery. A header
 * is injected only when ABSENT from every request, into the request(s) matching the
 * input's recorded method + path (or all requests when no anchor matches). Mutates
 * `workflow`; returns what it changed.
 */
export function injectContractedInputs(
  workflow: RawWorkflow,
  requiredInputs: RequiredInput[],
  session: Session,
): { injected: number; bootstrapSet: boolean } {
  let injected = 0;
  let bootstrapSet = false;
  const requests = Array.isArray(workflow.requests) ? workflow.requests : [];
  const captureNames = declaredCaptureNames(workflow);

  for (const ri of requiredInputs) {
    // Bootstrap (originating page) — set workflow.bootstrap.url if absent.
    if (ri.location === 'referer') {
      if (ri.bootstrapUrl && !workflow.bootstrap?.url) {
        workflow.bootstrap = { ...(workflow.bootstrap ?? {}), url: ri.bootstrapUrl };
        bootstrapSet = true;
      }
      continue;
    }
    const header = headerNameOf(ri.location);
    if (!header || requests.length === 0) continue; // only header inputs are injected here
    if (ri.source === 'producer_tool' || ri.source === 'user_param') continue; // params: handled elsewhere
    // browser_state needs a producer — only inject the header when its capture exists.
    if (ri.source === 'browser_state' && !(ri.stateName && captureNames.has(ri.stateName)))
      continue;
    const token = wiringToken(ri);
    if (token == null) continue;
    // Skip if any request already carries this header (the agent wired it; a wrong
    // raw value is handled by the emit-time guard's rewrite, not here).
    const already = requests.some((r) =>
      Object.keys(r.headers ?? {}).some((h) => h.toLowerCase() === header.toLowerCase()),
    );
    if (already) continue;
    // Target the request(s) matching the input's recorded method + path; fall back
    // to every request when there's no usable anchor.
    const rec =
      ri.recordedSeq != null ? session.requests.find((r) => r.seq === ri.recordedSeq) : undefined;
    const targets = rec
      ? requests.filter(
          (r) =>
            (r.method ?? 'GET').toUpperCase() === rec.method.toUpperCase() &&
            looseUrlPath(r.url ?? '') === looseUrlPath(rec.url),
        )
      : [];
    const dest = targets.length > 0 ? targets : requests;
    for (const r of dest) {
      if (!r.headers || typeof r.headers !== 'object') r.headers = {};
      r.headers[header] = token;
    }
    injected++;
  }
  return { injected, bootstrapSet };
}

/** Build the value→placeholder map the emit-time guard uses to auto-rewrite a
 *  stray raw secret, from the recording's values at each contracted header
 *  location plus known credential values. Static literals are returned separately
 *  as `allowedLiterals` (intentionally-verbatim app constants, never a "leak"). */
function buildSecretPlaceholderMap(
  requiredInputs: RequiredInput[],
  session: Session,
  credentialValues: Record<string, string>,
): { placeholderByValue: Map<string, string>; allowedLiterals: Set<string> } {
  const placeholderByValue = new Map<string, string>();
  const allowedLiterals = new Set<string>();
  for (const ri of requiredInputs) {
    const header = headerNameOf(ri.location);
    if (ri.source === 'static') {
      if (ri.literal) allowedLiterals.add(ri.literal);
      continue;
    }
    if (!header || ri.recordedSeq == null) continue;
    const token = wiringToken(ri);
    if (token == null || ri.wiring === 'literal') continue;
    const rec = session.requests.find((r) => r.seq === ri.recordedSeq);
    const recordedValue = Object.entries(rec?.headers ?? {}).find(
      ([h]) => h.toLowerCase() === header.toLowerCase(),
    )?.[1];
    if (recordedValue) placeholderByValue.set(recordedValue, token);
  }
  for (const [name, value] of Object.entries(credentialValues)) {
    if (value) placeholderByValue.set(value, `\${credential.${name}}`);
  }
  return { placeholderByValue, allowedLiterals };
}

/** The contracted-input gate (Thread B). After injection, every NON-producer,
 *  non-referer requiredInput must have its wiring present in the workflow text;
 *  a referer input wants `bootstrap.url` set (non-blocking — the ladder still has
 *  the cdp/stealth rungs). Returns blocking failures + the count still unresolved
 *  (fed to `classifyIntegrationOutcome` so a doomed live call is `contract-gap`,
 *  not `waived-bot`). */
export function contractedInputGate(
  workflowJson: string,
  requiredInputs: RequiredInput[],
): { failures: string[]; warnings: string[]; unresolved: number } {
  const failures: string[] = [];
  const warnings: string[] = [];
  let unresolved = 0;
  let bootstrapSet: boolean | null = null;
  for (const ri of requiredInputs) {
    if (ri.location === 'referer') {
      if (bootstrapSet === null) {
        try {
          bootstrapSet = Boolean((JSON.parse(workflowJson) as RawWorkflow).bootstrap?.url);
        } catch {
          bootstrapSet = false;
        }
      }
      if (!bootstrapSet) {
        warnings.push(
          `the recording shows this tool's request originates from ${ri.bootstrapUrl ?? 'a different page'} — set workflow.bootstrap.url to that page so its context/anti-bot token is minted before API replay (the runtime falls through to cdp-replay otherwise).`,
        );
      }
      continue;
    }
    if (ri.source === 'producer_tool' || ri.source === 'user_param') continue;
    const token = wiringToken(ri);
    if (token == null) continue;
    if (!workflowJson.includes(token)) {
      unresolved++;
      const how =
        ri.source === 'auth'
          ? `wire it as \`${token}\` (the authenticate tool persists it via sessionCapture)`
          : ri.source === 'browser_state'
            ? `wire it as \`${token}\` and add the capture/bootstrap that produces it`
            : ri.source === 'generated'
              ? `wire it as \`${token}\` (a fresh value is minted per call)`
              : 'emit it verbatim as the recorded constant';
      failures.push(
        `the build plan contracts an input at ${ri.location} (${ri.source}) that the request needs, but workflow.json does not wire it — ${how}. Use reveal_request to read the recorded value and read_build_plan for the contract.`,
      );
    }
  }
  return { failures, warnings, unresolved };
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
    /** Build-plan-declared dependency seqs (e.g. bootstrap GET seq, producer
     *  search seq) used by the hardcoded-body check to widen its variation
     *  pool beyond the tool's own load-bearing seqs. */
    dependencyRequestSeqs?: number[];
    /** The general dependency contract for this tool: every non-param input its
     *  request needs (auth / browser_state / generated / static / referer) and how
     *  to wire each. The verifier deterministically injects a dropped contracted
     *  input, then BLOCKS if a non-producer input's wiring is still absent. */
    requiredInputs?: RequiredInput[];
    /** Known credential values (name → value) for the emit-time secret guard, so a
     *  hardcoded credential is auto-rewritten to its ${credential.X} placeholder or
     *  blocked. Best-effort: provided on the teach path, empty otherwise. */
    credentialValues?: Record<string, string>;
  } = {},
): Promise<{
  failures: string[];
  warnings: string[];
  paramVerification: ParamVerification[];
  /** Set when the integration test was waived rather than passing live — the
   *  caller should stamp this onto workflow.json so audit/teach can surface
   *  the unverified state instead of silently treating the tool as live. */
  liveVerification?: {
    kind: 'waived-bot' | 'waived-infra';
    firstError: string;
    exhaustedBackends: string[];
  };
}> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const paramVerification: ParamVerification[] = [];
  let liveVerification:
    | { kind: 'waived-bot' | 'waived-infra'; firstError: string; exhaustedBackends: string[] }
    | undefined;
  // Captures Fix A flagged as having a wrong source. Surfaced into the
  // waiver classification (Fix C) so a STATE_MISSING traced to one of these
  // captures cannot silently become `waived-infra`.
  let failedCaptureNames = new Set<string>();
  // Fix 3 — when a request-referenced ${state.X} capture provably can't resolve
  // (Fix 2 below), the live integration call is GUARANTEED to STATE_MISSING, so
  // firing it is pure waste that also burns the per-IP anti-bot rate budget.
  // Skip the live test in that case and make the agent fix the capture first.
  let referencedStateBroken = false;

  const workflowPath = pathJoin(toolDir, 'workflow.json');
  const parserPath = pathJoin(toolDir, 'parser.ts');
  const parserTestPath = pathJoin(toolDir, 'parser.test.ts');

  // Contracted-input injection + emit-time secret guard + the contracted-input
  // gate. Runs FIRST so every downstream check and the live test see the final,
  // contracted, placeholder-only workflow. Injection is the deterministic safety
  // net behind the prompt-guided CONTRACTED-HEADERS rule; the guard enforces no
  // raw secret survives (Phase 0 makes the agent SEE them); the gate blocks a
  // still-missing contracted input. `unresolvedContractInputs` makes a doomed
  // live call classify as `contract-gap` rather than `waived-bot`.
  let unresolvedContractInputs = 0;
  if (existsSync(workflowPath)) {
    try {
      const rawWorkflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as RawWorkflow;
      const requiredInputs = opts.requiredInputs ?? [];
      const inj = injectContractedInputs(rawWorkflow, requiredInputs, session);
      let workflowJson = JSON.stringify(rawWorkflow, null, 2);

      const parserSrcForGuard = existsSync(parserPath)
        ? readFileSync(parserPath, 'utf8')
        : undefined;
      const { placeholderByValue, allowedLiterals } = buildSecretPlaceholderMap(
        requiredInputs,
        session,
        opts.credentialValues ?? {},
      );
      const guard = assertNoRawSecrets({
        workflowJson,
        parserSrc: parserSrcForGuard,
        session,
        placeholderByValue,
        allowedLiterals,
      });
      workflowJson = guard.workflowJson;
      failures.push(...guard.failures);

      if (inj.injected > 0 || inj.bootstrapSet || guard.rewrites > 0) {
        writeFileSync(workflowPath, workflowJson, 'utf8');
        if (inj.injected > 0)
          warnings.push(
            `injected ${inj.injected} contracted input(s) the plan declared but the workflow had dropped.`,
          );
        if (inj.bootstrapSet)
          warnings.push('set workflow.bootstrap.url from the recording originating page.');
        if (guard.rewrites > 0)
          warnings.push(
            `emit-time guard rewrote ${guard.rewrites} raw secret value(s) to their contracted placeholder.`,
          );
      }

      const gate = contractedInputGate(workflowJson, requiredInputs);
      failures.push(...gate.failures);
      warnings.push(...gate.warnings);
      unresolvedContractInputs = gate.unresolved;
    } catch {
      // Malformed workflow.json — the schema check below surfaces it.
    }
  }

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

      // Fix A — cross-reference every required capture against the recording.
      // A capture that declares `response_header` but reads from a recorded
      // response with no such header (or `html_regex` whose pattern doesn't
      // match the recorded body, etc.) will silently return null at runtime;
      // we reject it at compile so the agent picks a source that works.
      const crossRef = crossReferenceCaptures(workflow, session, opts.candidateRequestSeqs);
      failures.push(...crossRef.failures);
      failedCaptureNames = crossRef.failedCaptureNames;

      // Fix 2 — cross-reference captures that a request DEPENDS ON via
      // `${state.X}` (e.g. an anti-bot csrf/csp-nonce html_regex capture whose
      // bootstrap page isn't in the recording) against every recorded HTML body,
      // regardless of `required`. Catches the silent STATE_MISSING that ships a
      // .act tool which can never resolve its csrf header at runtime.
      const stateRef = crossReferenceReferencedStateCaptures(workflow, session);
      failures.push(...stateRef.failures);
      for (const n of stateRef.failedCaptureNames) failedCaptureNames.add(n);
      if (stateRef.failedCaptureNames.size > 0) referencedStateBroken = true;

      // Fix B — flag request body fields hardcoded to one recorded user's
      // session when the recording proves those fields are user input
      // (varying values across multiple recorded invocations of the same
      // endpoint). Skipped when the tool uses a requestTransformModule.
      failures.push(
        ...detectHardcodedSessionValues(
          workflow,
          session,
          opts.candidateRequestSeqs,
          opts.dependencyRequestSeqs,
        ),
      );

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
  } else if (referencedStateBroken) {
    // A request hard-references a ${state.X} whose html_regex capture provably
    // does not match the recorded page (Fix 2 already pushed the actionable
    // failure). The live call WOULD STATE_MISSING — running it can't pass and
    // would only spend a live anti-bot .act and deepen the per-IP rate flag.
    // Skip it; the agent must fix the capture, then the next cycle verifies live.
    integrationOutcome = 'failed';
    warnings.push(
      'skipped the live integration test: a request references a ${state.X} capture (e.g. csrf/csp-nonce) whose pattern does not match the recorded page, so the live call is guaranteed to fail with STATE_MISSING. Fix the capture pattern/source (see the failure above) — the next verification cycle will run the live test once it can succeed. This avoids burning a doomed anti-bot .act call.',
    );
  } else {
    // Scale the verifier's live-test timeout to the suite size: the baseline plus
    // one live `runWorkflowWithLadder` per param, each gated by the ~25s compile
    // pacing and a possible cdp cold start. A flat 60s truncated paced anti-bot
    // suites mid-run, and the partial output then misclassified as a bot block.
    // Cap it so a genuinely wedged suite can't run away.
    const paramCount = opts.likelyParams?.length ?? 0;
    const pacingMs = Number(process.env.IMPRINT_COMPILE_ACT_SPACING_MS ?? 25_000) || 0;
    const verifierTimeoutMs = Math.min(120_000 + paramCount * (pacingMs + 20_000), 10 * 60_000);
    let run: BunTestRun = {
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      passed: new Set(),
      failed: new Set(),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      run = await runBunTestWithResults(integrationTestPath, toolDir, verifierTimeoutMs);
      if (run.exitCode === 0) break;
      // A timeout, bot-defense, or ladder-exhaustion failure will NOT clear on a
      // retry — re-running only fires more state-changing calls and deepens the
      // per-IP rate flag. One attempt is enough to classify it; stop early.
      if (run.timedOut) break;
      const out = `${run.stdout}\n${run.stderr}`;
      const ladderExhausted =
        /\bRATE_LIMITED\b|\bFORBIDDEN\b|\bNETWORK\b/.test(out) &&
        /non-escalatable|giving up|ladder exhausted|all backends failed/.test(out);
      if (isBotDefenseFailure(out) || ladderExhausted) break;
    }
    integrationPassedTests = run.passed;

    const verdict = classifyIntegrationOutcome({
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      combined: `${run.stdout}\n${run.stderr}`,
      passedTests: run.passed,
      referencedStateBroken: false, // the broken-capture case is handled above
      failedCaptureNames,
      contractGap: unresolvedContractInputs > 0,
    });
    integrationOutcome = verdict.outcome;

    if (verdict.outcome === 'passed') {
      // exitCode 0 — nothing to surface.
    } else if (verdict.captureFailName !== null) {
      const capName = verdict.captureFailName;
      // If the failing capture is a `response_header` on a REPLAYED workflow
      // request, the cause is almost always the replay asymmetry: programmatic
      // fetch reliably receives the response BODY and Set-Cookie, but anti-bot
      // edges withhold browser-only response headers from non-browser requests.
      let sourceHint = '';
      try {
        const wf = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
          requests?: Array<{ captures?: Array<{ name: string; source: string }> }>;
          bootstrap?: { captures?: Array<{ name: string; source: string }> };
        };
        const reqCap = (wf.requests ?? [])
          .flatMap((r) => r.captures ?? [])
          .find((c) => c.name === capName);
        if (reqCap?.source === 'response_header') {
          sourceHint = ` The capture uses source: 'response_header' on a replayed request. Programmatic replay does NOT receive browser-only response headers that anti-bot edges withhold — but it DOES receive the response body and Set-Cookie. If this token also appears in the HTML body, switch to source: 'text_regex' (read it from the body); if it is set as a cookie, switch to source: 'cookie'. Reserve 'response_header' for a workflow.bootstrap capture (a real Chrome navigation), not a replayed request.`;
        }
      } catch {
        // best-effort hint only
      }
      failures.push(
        `integration test failed because a declared capture did not produce a value at runtime: capture "${capName}" returned null${
          verdict.captureFailFromKnown
            ? ' (matches a capture flagged by the compile-time cross-reference check)'
            : ''
        }. This is a workflow-correctness error, not infra — fix the capture source/path in workflow.json so it actually reads from the recorded location.${sourceHint}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    } else if (verdict.outcome === 'waived-bot' || verdict.outcome === 'waived-infra') {
      // `liveVerified` is driven by whether the BASELINE produced real data, NOT by
      // whether every param test passed. Only stamp liveVerified=false when the
      // baseline ALSO failed — if a backend returned real data this run the tool IS
      // live-verified; only its per-parameter tests waive (non-blocking).
      liveVerification = verdict.baselineLiveVerified
        ? undefined
        : {
            kind: verdict.outcome,
            firstError: verdict.firstError,
            exhaustedBackends: verdict.exhaustedBackends,
          };
      const liveNote = verdict.baselineLiveVerified
        ? 'The baseline returned real data this run, so liveVerified stays TRUE — only the per-parameter tests are waived.'
        : 'Stamping liveVerified=false on workflow.json — the runtime falls through to the cdp-replay / playbook rung. Audit and teach surface this tool as unverified.';
      warnings.push(
        verdict.outcome === 'waived-bot'
          ? `integration test hit a likely bot-detection / anti-automation challenge. ${liveNote}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
          : `integration test hit an infrastructure error (${verdict.firstError}); rungs exhausted: ${verdict.exhaustedBackends.join(', ') || 'unknown'}. ${liveNote}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    } else {
      failures.push(
        `bun test integration.test.ts exited ${run.exitCode} — the workflow failed to produce live data (tried 3 times).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    }
  }

  // Per-parameter coverage (Fix C/D). Each exposed parameter must have a
  // `param:<name>` integration test that actually RAN GREEN against live data —
  // a static source scan is not enough, because a waived suite never exercised
  // the param (R2: a filter wired to a field the server ignores looks "covered"
  // by source but does nothing). Per the keep+mark policy we never drop a param;
  // each is recorded in `paramVerification` as verified or not (with a reason),
  // and only a genuinely-uncovered param on a suite that DID run blocks compile.
  if (
    !referencedStateBroken &&
    existsSync(integrationTestPath) &&
    opts.likelyParams &&
    opts.likelyParams.length > 0
  ) {
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

  return { failures, warnings, paramVerification, liveVerification };
}
