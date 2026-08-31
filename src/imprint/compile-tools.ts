/**
 * Shared compile-agent tool implementations.
 *
 * The same read/write tools and verification logic are used both by
 * the in-process agent loop (anthropic-api provider) and by the
 * stdio MCP server that claude-cli drives through `--mcp-config`.
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
  sep as pathSeparator,
} from 'node:path';
import type { AgentTool } from './agent.ts';
import { renderWorkflowRequests } from './backend-ladder.ts';
import {
  bodyEncodingPathsAtPointer,
  compareBodyStructures,
  decodeBodyStructure,
  describeBodyPaths,
  parseBodyFormat,
  readBodyPointer,
} from './body-structure.ts';
import {
  type SharedModuleManifestEntry,
  planSliceForTool,
  readBuildPlanFile,
  resolveAssignedModules,
} from './build-plan.ts';
import type { CompileStrategyKind } from './compile-strategy.ts';
import {
  LIVE_EVIDENCE_PATH_ENV,
  type LiveIntegrationEvidence,
  readLiveIntegrationEvidence,
} from './compile-verification.ts';
import { isIrreversibleRequest, workflowHasIrreversibleEffect } from './effects.ts';
import { findEarlierResponseEqualities, groundEvent } from './param-grounding.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  type BootstrapCapture,
  type CapturedRequest,
  type RequestCapture,
  type Session,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const MAX_SHARED_MODULE_SOURCE_CHARS = 50_000;
const RUNTIME_BODY_PLACEHOLDER =
  /\$\{(?:(?:param|credential|generated|env)\.|response\[\d+\]\.|(?:state|cookie)(?:\.|\["))/;

export function requestsNeedingBodyEncodingDecision(workflow: Workflow): number[] {
  return workflow.requests.flatMap((request, index) =>
    request.body && RUNTIME_BODY_PLACEHOLDER.test(request.body) ? [index] : [],
  );
}

/** Compile-time contract only; legacy workflows retain runtime inference. */
export function bodyEncodingContractFailures(workflow: Workflow): string[] {
  return requestsNeedingBodyEncodingDecision(workflow)
    .filter((index) => workflow.requests[index]?.bodyPlaceholderEncoding === undefined)
    .map(
      (index) =>
        `request ${index} has runtime placeholders in its body but no bodyPlaceholderEncoding. Inspect the recorded wire format, choose raw, json-string, or form-urlencoded, then add an agent-authored offline request.test.ts with adversarial delimiter, escape, whitespace, and Unicode round trips. The host only checks that this file exists and its tests pass; an independent artifact reviewer evaluates whether those cases meaningfully prove the encoding.`,
    );
}

export function requestEncodingTestContractFailures(
  workflow: Workflow,
  source: string | undefined,
): string[] {
  if (requestsNeedingBodyEncodingDecision(workflow).length === 0) return [];
  return source === undefined
    ? [
        'request.test.ts is mechanically required for a placeholder-bearing request body; the compile agent and independent artifact reviewer remain responsible for test strength',
      ]
    : [];
}

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
  const candidateSeqs = context.candidate
    ? new Set([
        ...context.candidate.requestSeqs,
        ...context.candidate.dependencySeqs,
        ...(context.sharedContext?.loginRequestSeqs ?? []),
      ])
    : undefined;
  const hasIrreversibleCandidateRequest = session.requests.some(
    (request) =>
      isIrreversibleRequest(request) && (!candidateSeqs || candidateSeqs.has(request.seq)),
  );
  const tools = [
    buildReadSessionSummaryTool(session, context, toolDir),
    buildReadRequestTool(session),
    buildInspectBodyStructureTool(session),
    buildCompareRenderedRequestsTool(session, toolDir, context),
    buildSearchRequestsTool(session),
    buildDiffRequestForEventTool(session),
    buildReadResponseBodyTool(session),
    buildSearchResponseBodyTool(session),
    buildWriteFileTool(toolDir, [], context.strategyKind),
    buildReadFileTool(toolDir),
    buildRunBashTool(toolDir),
  ];
  tools.push(
    buildRunTestsTool(toolDir, sessionPath, {
      networkDisabled: hasIrreversibleCandidateRequest,
    }),
  );
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
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). When
   *  set, a read_build_plan tool exposes bounded proposals for agent review. */
  buildPlanPath?: string;
  /** Shared-module build manifest (verified flags) for this site. */
  sharedModules?: SharedModuleManifestEntry[];
  /** Master-accepted execution strategy for this focused compile. */
  strategyKind?: CompileStrategyKind;
  /** A bounded teach resume is revising an already-generated tool. Surface the
   *  existing artifact and durable verifier/audit feedback to the agent so it
   *  preserves proven behavior instead of re-deriving the tool from raw capture. */
  revisionMode?: boolean;
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
      "Read this tool's advisory slice of the shared build plan: shared modules, parser guidance, parameter suggestions, auth suggestions, and proposed producer-consumer fields. Inspect exact evidence before accepting a proposed relationship or wiring strategy.",
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
      return {
        result: JSON.stringify(
          {
            toolName,
            sharedModuleProposals: assigned.map((m) => ({
              importPath: m.importPath,
              kind: m.kind,
              purpose: m.purpose,
              exportSignatures: m.exportSignatures,
              ...readAssignedSharedModuleSource(buildPlanPath, m.path),
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
                ? 'These modules are reusable proposals. Inspect their exact contract and evidence, then accept or reject each one. Until the master records an accepted binding, the host does not require an import.'
                : 'No shared-module proposals are available for this tool.',
            evidenceBoundary:
              'Plan fields are bounded suggestions, not proof of origin, causality, or strategy. Inspect exact redacted request/response facts and verification results, then accept, revise, or reject each suggestion with reasoning.',
          },
          null,
          2,
        ),
      };
    },
  };
}

function readAssignedSharedModuleSource(
  buildPlanPath: string,
  modulePath: string,
): { source?: string; sourceTruncated?: boolean; sourceUnavailable?: string } {
  const siteDir = realpathSync(dirname(buildPlanPath));
  const candidate = pathJoin(siteDir, modulePath);
  if (!existsSync(candidate)) {
    return { sourceUnavailable: 'The verified shared module file is missing.' };
  }

  const resolved = realpathSync(candidate);
  const relative = pathRelative(siteDir, resolved);
  if (relative.startsWith('..') || relative === '') {
    return { sourceUnavailable: 'The shared module resolved outside the site directory.' };
  }

  const source = readFileSync(resolved, 'utf8');
  if (source.length <= MAX_SHARED_MODULE_SOURCE_CHARS) return { source };
  return {
    source: source.slice(0, MAX_SHARED_MODULE_SOURCE_CHARS),
    sourceTruncated: true,
  };
}

// ─── Tool: read_session_summary ──────────────────────────────────────────────

export function buildReadSessionSummaryTool(
  session: Session,
  context: CompileToolContext,
  toolDir?: string,
): AgentTool {
  return {
    name: 'read_session_summary',
    description:
      'Get a bounded high-level summary of the redacted session: narration, selected candidate scope, neutral recording inventory, revision paths, and load-bearing request facts. Read full bodies on demand.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => ({ result: buildBoundedSessionSummary(session, context, toolDir) }),
  };
}

const REVISION_ARTIFACT_NAMES = [
  'workflow.json',
  'parser.ts',
  'request.test.ts',
  'request-transform.ts',
  'integration.test.ts',
  'playbook.yaml',
] as const;

const REVISION_DIAGNOSTIC_NAMES = [
  '.live-verification.json',
  '.live-verification-evidence.json',
  '.live-verifier-log.jsonl',
] as const;
const MAX_REVISION_FEEDBACK_NOTES = 16;
const MAX_REVISION_NOTE_SCAN = 64;

type RevisionFileFact = { path: string; bytes: number };
type RevisionFileInspection =
  | { state: 'file'; fact: RevisionFileFact }
  | { state: 'absent' | 'not_checked' };

function missingRevisionPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function inspectRevisionFile(root: string, relativePath: string): RevisionFileInspection {
  try {
    const stats = lstatSync(pathJoin(root, relativePath));
    return stats.isFile()
      ? { state: 'file', fact: { path: relativePath, bytes: stats.size } }
      : { state: 'absent' };
  } catch (error) {
    return { state: missingRevisionPath(error) ? 'absent' : 'not_checked' };
  }
}

function revisionFileInventory(root: string, names: readonly string[]) {
  const entries: RevisionFileFact[] = [];
  const notCheckedPaths: string[] = [];
  for (const name of names) {
    const inspected = inspectRevisionFile(root, name);
    if (inspected.state === 'file') entries.push(inspected.fact);
    else if (inspected.state === 'not_checked') notCheckedPaths.push(name);
  }
  return {
    entries,
    notCheckedPaths,
    omitted: { atLeast: 0, exact: notCheckedPaths.length === 0 },
  };
}

function unavailableRevisionFeedback(state: 'none' | 'not_checked' = 'none') {
  return {
    state,
    entries: [] as RevisionFileFact[],
    scanned: 0,
    scanCap: MAX_REVISION_NOTE_SCAN,
    scanTruncated: state === 'not_checked',
    notCheckedEntries: 0,
    omitted: { atLeast: 0, exact: state === 'none' },
  };
}

function revisionFeedbackInventory(root: string) {
  const notesDir = pathJoin(root, 'notes');
  try {
    if (!lstatSync(notesDir).isDirectory()) return unavailableRevisionFeedback();
  } catch (error) {
    return unavailableRevisionFeedback(missingRevisionPath(error) ? 'none' : 'not_checked');
  }

  const entries: RevisionFileFact[] = [];
  let scanned = 0;
  let omittedAtLeast = 0;
  let notCheckedEntries = 0;
  let scanTruncated = false;
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(notesDir);
  } catch {
    return unavailableRevisionFeedback('not_checked');
  }
  try {
    while (scanned < MAX_REVISION_NOTE_SCAN) {
      const entry = directory.readSync();
      if (!entry) break;
      scanned++;
      const inspected = inspectRevisionFile(notesDir, entry.name);
      if (inspected.state === 'not_checked') {
        notCheckedEntries++;
        continue;
      }
      if (inspected.state !== 'file') continue;
      const relativeFact = { ...inspected.fact, path: `notes/${entry.name}` };
      if (entries.length < MAX_REVISION_FEEDBACK_NOTES) entries.push(relativeFact);
      else omittedAtLeast++;
    }
    if (scanned === MAX_REVISION_NOTE_SCAN && directory.readSync()) scanTruncated = true;
  } catch {
    scanTruncated = true;
  } finally {
    try {
      directory.closeSync();
    } catch {
      // readSync may already have closed an exhausted directory.
    }
  }
  return {
    state:
      entries.length > 0
        ? ('available' as const)
        : scanTruncated || notCheckedEntries > 0
          ? ('not_checked' as const)
          : ('none' as const),
    entries,
    scanned,
    scanCap: MAX_REVISION_NOTE_SCAN,
    scanTruncated,
    notCheckedEntries,
    omitted: { atLeast: omittedAtLeast, exact: !scanTruncated && notCheckedEntries === 0 },
  };
}

function buildExistingArtifactRevisionContext(toolDir: string): Record<string, unknown> {
  return {
    mode: 'revise_existing_artifact',
    instruction: [
      'This bounded resume is a revision, not a from-scratch compile.',
      'Read each regular-file path listed in existingArtifacts.entries, durableDiagnostics.entries, and feedbackNotes.entries before re-reading focused recording bodies.',
      'Preserve behavior that live evidence proves works. Repair or narrow only the behavior contradicted by evidence.',
      'When evidence contradicts the existing design, inspect the exact request, response, state, and artifact before choosing a revision; do not guess from a category label.',
    ].join(' '),
    existingArtifacts: revisionFileInventory(toolDir, REVISION_ARTIFACT_NAMES),
    durableDiagnostics: revisionFileInventory(toolDir, REVISION_DIAGNOSTIC_NAMES),
    feedbackNotes: revisionFeedbackInventory(toolDir),
  };
}

// ─── Bounded session summary ────────────────────────────────────────────────

const SUMMARY_SIZE_BUDGET = 30_000;
const MAX_SUMMARY_REQUEST_SCAN = 10_000;
const MAX_SUMMARY_REQUESTS = 16;
const summaryEncoder = new TextEncoder();

interface SummaryOmission {
  entries: { atLeast: number; exact: boolean };
  characters: { atLeast: number; exact: boolean };
  utf8Bytes: { atLeast: number; exact: boolean };
  truncatedTextFields: number;
}

function emptySummaryOmission(): SummaryOmission {
  return {
    entries: { atLeast: 0, exact: true },
    characters: { atLeast: 0, exact: true },
    utf8Bytes: { atLeast: 0, exact: true },
    truncatedTextFields: 0,
  };
}

function omitEntries(stats: SummaryOmission, count: number, exact = true): void {
  stats.entries.atLeast += Math.max(0, count);
  if (!exact) stats.entries.exact = false;
}

function boundedSummaryText(text: string, limit: number, stats: SummaryOmission): string {
  let end = 0;
  let included = 0;
  for (const character of text) {
    if (included++ >= limit) {
      stats.truncatedTextFields++;
      stats.characters.atLeast++;
      stats.characters.exact = false;
      stats.utf8Bytes.atLeast += summaryEncoder.encode(character).length;
      stats.utf8Bytes.exact = false;
      break;
    }
    end += character.length;
  }
  return text.slice(0, end);
}

function boundedSummaryEntries<T>(values: T[], limit: number, stats: SummaryOmission): T[] {
  omitEntries(stats, values.length - limit);
  return values.slice(0, limit);
}

function markOmittedText(stats: SummaryOmission, text: string | undefined): void {
  if (text) boundedSummaryText(text, 0, stats);
}

function boundedSummaryUrl(raw: string, stats: SummaryOmission): URL | undefined {
  if (raw.length > 2_048) {
    markOmittedText(stats, raw);
    return undefined;
  }
  const parsed = safeUrl(raw) ?? undefined;
  if (parsed) markOmittedText(stats, `${parsed.search}${parsed.hash}`);
  else markOmittedText(stats, raw);
  return parsed;
}

function boundedRecordCount(record: Record<string, string>, limit = 1_024) {
  let count = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (count >= limit) return { atLeast: count + 1, exact: false };
    count++;
  }
  return { atLeast: count, exact: true };
}

function buildBoundedSessionSummary(
  session: Session,
  context: CompileToolContext,
  toolDir?: string,
): string {
  const omissions = {
    site: emptySummaryOmission(),
    candidate: emptySummaryOmission(),
    sharedCompileContext: emptySummaryOmission(),
    narration: emptySummaryOmission(),
    loadBearingRequests: emptySummaryOmission(),
  };
  const start = boundedSummaryUrl(session.url, omissions.site);
  const site = {
    name: boundedSummaryText(session.site, 128, omissions.site),
    startHost: start ? boundedSummaryText(start.host, 96, omissions.site) : 'unavailable',
    startPath: start ? boundedSummaryText(start.pathname, 160, omissions.site) : 'unavailable',
  };

  const candidate = context.candidate;
  const requestSeqs = candidate
    ? boundedSummaryEntries(candidate.requestSeqs, 32, omissions.candidate)
    : [];
  const representativeSeqs = candidate
    ? boundedSummaryEntries(candidate.representativeSeqs, 16, omissions.candidate)
    : [];
  const dependencySeqs = candidate
    ? boundedSummaryEntries(candidate.dependencySeqs, 32, omissions.candidate)
    : [];
  const selectedCandidate = candidate
    ? {
        toolName: boundedSummaryText(candidate.toolName, 64, omissions.candidate),
        intent: {
          description: boundedSummaryText(candidate.description, 192, omissions.candidate),
          rationale: boundedSummaryText(candidate.rationale, 192, omissions.candidate),
          expectedOutput: boundedSummaryText(candidate.expectedOutput, 192, omissions.candidate),
        },
        likelyParams: boundedSummaryEntries(candidate.likelyParams, 8, omissions.candidate).map(
          (param) => ({
            name: boundedSummaryText(param.name, 64, omissions.candidate),
            type: param.type,
            ...(param.description
              ? { description: boundedSummaryText(param.description, 96, omissions.candidate) }
              : {}),
          }),
        ),
        eventSeqs: boundedSummaryEntries(candidate.eventSeqs, 32, omissions.candidate),
        requestSeqs,
        representativeSeqs,
        dependencySeqs,
        dependsOnTools: boundedSummaryEntries(candidate.dependsOnTools, 8, omissions.candidate).map(
          (name) => boundedSummaryText(name, 64, omissions.candidate),
        ),
      }
    : undefined;

  const shared = context.sharedContext;
  const sharedCompileContext = shared
    ? {
        loginRequestSeqs: boundedSummaryEntries(
          shared.loginRequestSeqs,
          16,
          omissions.sharedCompileContext,
        ),
        authRequestSeqs: boundedSummaryEntries(
          shared.authRequestSeqs,
          16,
          omissions.sharedCompileContext,
        ),
        credentialNames: boundedSummaryEntries(
          shared.credentialNames,
          8,
          omissions.sharedCompileContext,
        ).map((name) => boundedSummaryText(name, 64, omissions.sharedCompileContext)),
        tokenExtractionNotes: boundedSummaryText(
          shared.tokenExtractionNotes,
          256,
          omissions.sharedCompileContext,
        ),
        sharedHelperNotes: boundedSummaryText(
          shared.sharedHelperNotes,
          256,
          omissions.sharedCompileContext,
        ),
        authNotes: boundedSummaryText(shared.authNotes, 256, omissions.sharedCompileContext),
      }
    : undefined;

  const narration = boundedSummaryEntries(session.narration, 6, omissions.narration).map(
    (entry) => ({
      seq: entry.seq,
      timestamp: entry.timestamp,
      text: boundedSummaryText(entry.text, 256, omissions.narration),
    }),
  );

  const selectedSeqSet = new Set(representativeSeqs.length ? representativeSeqs : requestSeqs);
  const dependencySeqSet = new Set([
    ...dependencySeqs,
    ...boundedSummaryEntries(shared?.loginRequestSeqs ?? [], 16, omissions.loadBearingRequests),
  ]);
  const wantedSeqs = new Set([...selectedSeqSet, ...dependencySeqSet]);
  const scannedRequests = Math.min(session.requests.length, MAX_SUMMARY_REQUEST_SCAN);
  const requestFacts: Array<Record<string, unknown>> = [];
  const foundSeqs = new Set<number>();
  for (let index = 0; index < scannedRequests; index++) {
    const request = session.requests[index];
    if (!request || !wantedSeqs.has(request.seq)) continue;
    foundSeqs.add(request.seq);
    if (requestFacts.length >= MAX_SUMMARY_REQUESTS) continue;
    const url = boundedSummaryUrl(request.url, omissions.loadBearingRequests);
    markOmittedText(omissions.loadBearingRequests, request.body);
    markOmittedText(omissions.loadBearingRequests, request.response?.body);
    requestFacts.push({
      seq: request.seq,
      selectedForCandidate: selectedSeqSet.has(request.seq),
      sharedDependency: dependencySeqSet.has(request.seq),
      method: boundedSummaryText(request.method, 12, omissions.loadBearingRequests),
      host: url ? boundedSummaryText(url.host, 96, omissions.loadBearingRequests) : 'unavailable',
      path: url
        ? boundedSummaryText(url.pathname, 160, omissions.loadBearingRequests)
        : 'unavailable',
      requestHeaderCount: boundedRecordCount(request.headers),
      requestBodyCharacters: request.body?.length,
      responseStatus: request.response?.status,
      responseMimeType: request.response?.mimeType
        ? boundedSummaryText(request.response.mimeType, 64, omissions.loadBearingRequests)
        : undefined,
      responseHeaderCount: request.response
        ? boundedRecordCount(request.response.headers)
        : { atLeast: 0, exact: true },
      responseBodyCharacters: request.response?.body?.length,
      ...(isIrreversibleRequest(request) ? { irreversible: true } : {}),
    });
  }
  omitEntries(omissions.loadBearingRequests, Math.max(0, foundSeqs.size - requestFacts.length));
  const unscannedRequestCount = Math.max(0, session.requests.length - scannedRequests);
  const scanTruncated = unscannedRequestCount > 0;
  const notFoundWithinScan = [...wantedSeqs].filter((seq) => !foundSeqs.has(seq));
  const explicitMissingSeqs = notFoundWithinScan.slice(0, 16);
  const missingSeqsOmitted = notFoundWithinScan.length - explicitMissingSeqs.length;
  const requestIndex = {
    total: session.requests.length,
    scanned: scannedRequests,
    cap: MAX_SUMMARY_REQUEST_SCAN,
    truncated: scanTruncated,
    requestedSeqs: wantedSeqs.size,
    foundWithinScan: foundSeqs.size,
    notFoundWithinScannedSeqs: explicitMissingSeqs,
    notFoundWithinScannedTotal: notFoundWithinScan.length,
    requestTail: {
      state: scanTruncated ? ('not_checked' as const) : ('checked' as const),
      count: unscannedRequestCount,
    },
    ...(scanTruncated
      ? {
          state: 'not_checked' as const,
          notCheckedSeqs: explicitMissingSeqs,
          notCheckedTotal: notFoundWithinScan.length,
          notCheckedSeqsOmitted: missingSeqsOmitted,
        }
      : {
          state: 'checked' as const,
          absentSeqs: explicitMissingSeqs,
          absentTotal: notFoundWithinScan.length,
          absentSeqsOmitted: missingSeqsOmitted,
        }),
  };
  const revisionContext =
    context.revisionMode && toolDir ? buildExistingArtifactRevisionContext(toolDir) : undefined;

  const summary = {
    source: 'redacted_session_evidence',
    summaryBounded: true,
    outputBudgetBytes: SUMMARY_SIZE_BUDGET,
    instruction: 'Use candidate-scoped read tools for omitted or full evidence.',
    site,
    requestCount: session.requests.length,
    requestIndex,
    selectedCandidate,
    sharedCompileContext,
    narration,
    recordingInventory: {
      cookieSnapshotCount: session.cookieSnapshots.length,
      storageSnapshotCount: session.storageSnapshots.length,
    },
    loadBearingRequests: requestFacts,
    revisionContext,
    omissions,
  };
  const result = JSON.stringify(summary, null, 2);
  if (summaryEncoder.encode(result).length <= SUMMARY_SIZE_BUDGET) return result;

  const fallback = JSON.stringify({ ...summary, summaryEmergencyFallback: true });
  if (summaryEncoder.encode(fallback).length <= SUMMARY_SIZE_BUDGET) return fallback;

  const hardFallbackOmissions = {
    candidate: emptySummaryOmission(),
    narration: emptySummaryOmission(),
    loadBearingRequests: emptySummaryOmission(),
  };
  const takeCandidateEntry = <T>(values: T[]) =>
    boundedSummaryEntries(values, 1, hardFallbackOmissions.candidate);
  const hardCandidate = selectedCandidate
    ? {
        ...selectedCandidate,
        likelyParams: takeCandidateEntry(selectedCandidate.likelyParams),
        eventSeqs: takeCandidateEntry(selectedCandidate.eventSeqs),
        requestSeqs: takeCandidateEntry(selectedCandidate.requestSeqs),
        representativeSeqs: takeCandidateEntry(selectedCandidate.representativeSeqs),
        dependencySeqs: takeCandidateEntry(selectedCandidate.dependencySeqs),
        dependsOnTools: takeCandidateEntry(selectedCandidate.dependsOnTools),
      }
    : undefined;
  const hard = JSON.stringify({
    ...summary,
    summaryHardFallback: true,
    selectedCandidate: hardCandidate,
    narration: boundedSummaryEntries(narration, 1, hardFallbackOmissions.narration),
    loadBearingRequests: boundedSummaryEntries(
      summary.loadBearingRequests,
      1,
      hardFallbackOmissions.loadBearingRequests,
    ),
    hardFallbackOmissions,
  });
  if (summaryEncoder.encode(hard).length <= SUMMARY_SIZE_BUDGET) return hard;

  return JSON.stringify({
    source: 'redacted_session_evidence',
    summaryBounded: true,
    summaryTinyFallback: true,
    outputBudgetBytes: SUMMARY_SIZE_BUDGET,
    site: { name: site.name, host: site.startHost },
    toolName: selectedCandidate?.toolName,
    counts: {
      requests: session.requests.length,
      wantedRequestSeqs: wantedSeqs.size,
      narration: session.narration.length,
      cookieSnapshots: session.cookieSnapshots.length,
      storageSnapshots: session.storageSnapshots.length,
    },
    omissions: {
      detail: 'all_other_summary_fields_omitted',
      atLeastOneField: true,
      exact: false,
    },
  });
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

// ─── Tool: inspect_body_structure ───────────────────────────────────────────

const BODY_INSPECTION_OUTPUT_LIMIT = 16 * 1024;
const bodyInspectionEncoder = new TextEncoder();

function boundedBodyInspectionResult(value: Record<string, unknown>): {
  result: string;
  isError?: boolean;
} {
  const result = JSON.stringify(value, null, 2);
  if (bodyInspectionEncoder.encode(result).length <= BODY_INSPECTION_OUTPUT_LIMIT)
    return { result };
  return {
    result: JSON.stringify({
      source: 'redacted_session_evidence',
      error:
        'inspection output exceeded its fixed safety limit; omit compareToSeq or inspect a narrower pointer',
    }),
    isError: true,
  };
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : {};
}

function buildInspectBodyStructureTool(session: Session): AgentTool {
  return {
    name: 'inspect_body_structure',
    description:
      'Inspect one redacted request or response body with bounded, value-free facts. Scalar literals are never returned. Paths stay hidden by default, while includePaths reveals a small capped list. A supplied pointer scopes evidence and may be echoed. Auto recognizes only unambiguous JSON or form-urlencoded bodies; select decimal-framed-json explicitly.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: 'Recorded request sequence number.' },
        side: { type: 'string', enum: ['request', 'response'] },
        format: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
          description: 'Defaults to auto. Framed JSON is decoded only when explicitly selected.',
        },
        pointer: {
          type: 'string',
          description:
            'Optional exact RFC 6901 pointer. Scopes structural and comparison evidence to this subtree.',
        },
        compareToSeq: {
          type: 'number',
          description: 'Optionally compare the same request/response side with another sequence.',
        },
        compareFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
          description: 'Format for compareToSeq. Defaults independently to auto.',
        },
        includePaths: {
          type: 'boolean',
          description:
            'Defaults false. Explicitly reveal the small capped list of exact redacted paths.',
        },
        findEarlierMatches: {
          type: 'boolean',
          description:
            'For a request body, compare the scalar at pointer with bounded earlier responses only within the supplied host-redaction representation. Equality does not establish origin or causation. Requires pointer.',
        },
        earlierResponseFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
          description: 'Format for earlier response bodies checked by findEarlierMatches.',
        },
      },
      required: ['seq', 'side'],
    },
    handler: async (input: unknown) => {
      const args = inputRecord(input);
      const seq = typeof args.seq === 'number' && Number.isInteger(args.seq) ? args.seq : undefined;
      const side = args.side === 'request' || args.side === 'response' ? args.side : undefined;
      if (seq === undefined || side === undefined) {
        return {
          result: 'seq must be an integer and side must be request or response',
          isError: true,
        };
      }
      const format = parseBodyFormat(args.format);
      if (!format) return { result: 'unsupported body format', isError: true };
      const compareFormat = parseBodyFormat(args.compareFormat);
      if (!compareFormat) return { result: 'unsupported comparison body format', isError: true };
      const earlierResponseFormat = parseBodyFormat(args.earlierResponseFormat);
      if (!earlierResponseFormat)
        return { result: 'unsupported earlier response body format', isError: true };
      if (args.pointer !== undefined && typeof args.pointer !== 'string')
        return { result: 'pointer must be a string', isError: true };
      if (args.findEarlierMatches && args.pointer === undefined)
        return {
          result: 'findEarlierMatches requires an exact pointer',
          isError: true,
        };
      const pointer = typeof args.pointer === 'string' ? args.pointer : undefined;
      const request = session.requests.find((item) => item.seq === seq);
      if (!request) return { result: `Request seq ${seq} not found`, isError: true };
      const body = side === 'request' ? request.body : request.response?.body;
      const decoded = decodeBodyStructure(body, format);
      if (!decoded.ok) {
        return boundedBodyInspectionResult({
          source: 'redacted_session_evidence',
          seq,
          side,
          error: decoded.error,
          code: decoded.code,
        });
      }

      const pointerFact = readBodyPointer(decoded.structure, pointer ?? '');
      if ('error' in pointerFact) {
        return boundedBodyInspectionResult({
          source: 'redacted_session_evidence',
          seq,
          side,
          pointer: pointerFact,
        });
      }
      const scopedEncodingPaths =
        pointer === undefined
          ? decoded.structure.jsonEncodedStringPaths
          : bodyEncodingPathsAtPointer(decoded.structure, pointer);
      const encodingEvidence = describeBodyPaths(
        scopedEncodingPaths ?? [],
        args.includePaths === true,
      );
      const result: Record<string, unknown> = {
        source: 'redacted_session_evidence',
        seq,
        side,
        format: decoded.structure.format,
        ...(decoded.structure.truncated ? { decodingTruncated: decoded.structure.truncated } : {}),
        ...(decoded.structure.nestedJsonExpansion
          ? { nestedJsonExpansion: decoded.structure.nestedJsonExpansion }
          : {}),
        jsonStringBoundaries: encodingEvidence.facts,
        ...(encodingEvidence.truncated ? { jsonStringBoundariesTruncated: true } : {}),
        ...(pointer === undefined ? { root: pointerFact } : { pointer: pointerFact }),
      };

      if (args.compareToSeq !== undefined) {
        if (typeof args.compareToSeq !== 'number' || !Number.isInteger(args.compareToSeq)) {
          return { result: 'compareToSeq must be an integer', isError: true };
        }
        const compareToSeq = args.compareToSeq;
        const comparisonRequest = session.requests.find((item) => item.seq === compareToSeq);
        if (!comparisonRequest) {
          return { result: `Request seq ${compareToSeq} not found`, isError: true };
        }
        const comparisonBody =
          side === 'request' ? comparisonRequest.body : comparisonRequest.response?.body;
        const comparisonDecoded = decodeBodyStructure(comparisonBody, compareFormat);
        result.compareToSeq = compareToSeq;
        if (comparisonDecoded.ok) {
          result.compareToFormat = comparisonDecoded.structure.format;
          if (comparisonDecoded.structure.truncated)
            result.comparisonDecodingTruncated = comparisonDecoded.structure.truncated;
          result.comparison = compareBodyStructures(
            decoded.structure,
            comparisonDecoded.structure,
            {
              includePaths: args.includePaths === true,
              pointer,
            },
          );
          if (pointer !== undefined) result.comparisonPathBase = pointer;
        } else {
          result.comparison = { error: comparisonDecoded.error, code: comparisonDecoded.code };
        }
      }
      if (args.findEarlierMatches) {
        if (side !== 'request')
          return { result: 'findEarlierMatches applies only to request bodies', isError: true };
        if (pointer === undefined)
          return { result: 'findEarlierMatches requires an exact pointer', isError: true };
        result.earlierResponseEqualities = findEarlierResponseEqualities(
          session,
          seq,
          pointer,
          decoded.structure,
          {
            includePaths: args.includePaths === true,
            responseFormat: earlierResponseFormat,
          },
        );
      }
      return boundedBodyInspectionResult(result);
    },
  };
}

// ─── Tool: compare_rendered_requests ────────────────────────────────────────

type ScalarParams = Record<string, string | number | boolean>;

function scalarParams(value: unknown): ScalarParams | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([, item]) =>
        typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean',
    )
  )
    return undefined;
  return Object.fromEntries(entries) as ScalarParams;
}

function requestUrlShape(value: string): Record<string, unknown> {
  try {
    const parsed = new URL(value);
    const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
    return {
      state: 'parsed',
      protocol: parsed.protocol,
      host: parsed.host,
      pathname: parsed.pathname,
      queryFieldCount: [...parsed.searchParams].length,
      queryKeys,
    };
  } catch {
    return { state: 'invalid_url' };
  }
}

function requestUrlsEqual(recorded: string, rendered: string): boolean {
  try {
    const left = new URL(recorded);
    const right = new URL(rendered);
    return (
      left.protocol === right.protocol &&
      left.host === right.host &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  } catch {
    return recorded === rendered;
  }
}

function requestQueryValuesEqual(recorded: string, rendered: string): boolean | undefined {
  try {
    return new URL(recorded).search === new URL(rendered).search;
  } catch {
    return undefined;
  }
}

const artifactImportScanner = new Bun.Transpiler({ loader: 'ts' });

function resolveRelativeArtifactImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = pathResolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    pathJoin(base, 'index.ts'),
    pathJoin(base, 'index.js'),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** Copy only the relative module closure needed by a rendered artifact. The
 * destination keeps the original site-relative layout, so sibling-tool and
 * `_shared` imports resolve without copying unrelated tools or recordings. */
function copyArtifactDependencyClosure(
  entryPath: string,
  siteDir: string,
  freshRoot: string,
  visited = new Set<string>(),
): void {
  const absolute = pathResolve(entryPath);
  if (visited.has(absolute)) return;
  visited.add(absolute);
  const relative = pathRelative(siteDir, absolute);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${pathSeparator}`) ||
    pathResolve(siteDir, relative) !== absolute
  )
    return;
  let source: string;
  try {
    if (!statSync(absolute).isFile()) return;
    source = readFileSync(absolute, 'utf8');
  } catch {
    return;
  }
  const destination = pathJoin(freshRoot, relative);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(absolute, destination);
  if (!['.ts', '.tsx', '.js', '.mjs'].includes(extname(absolute))) return;
  let imports: ReturnType<typeof artifactImportScanner.scanImports>;
  try {
    imports = artifactImportScanner.scanImports(source);
  } catch {
    return;
  }
  for (const dependency of imports) {
    const resolved = resolveRelativeArtifactImport(absolute, dependency.path);
    if (resolved) copyArtifactDependencyClosure(resolved, siteDir, freshRoot, visited);
  }
}

function buildCompareRenderedRequestsTool(
  session: Session,
  toolDir: string,
  context: CompileToolContext,
): AgentTool {
  return {
    name: 'compare_rendered_requests',
    description:
      'Render the current workflow offline with its real substitutions and request transform, feed its accepted recorded responses through request chains, and compare each prepared request with its recordingRequestSeq. Returns factual URL/body sizes and bounded structural differences without making a semantic judgment. Run this after every request-construction edit, especially for forms, nested JSON, framed bodies, and positional arrays.',
    input_schema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description:
            'Scalar workflow parameters used for this offline render. Defaults may fill omitted parameters.',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
          },
        },
        state: {
          type: 'object',
          description:
            'Optional synthetic scalar capture state for an offline render when the workflow normally obtains it during bootstrap.',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
          },
        },
        credentialValues: {
          type: 'object',
          description:
            'Optional harmless synthetic string values for credential placeholders during offline rendering.',
          additionalProperties: { type: 'string' },
        },
        artifactRequestIndex: {
          type: 'number',
          description: 'Optional zero-based workflow request index to report.',
        },
        recordedFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
          description: 'Recorded-body format. Defaults to auto.',
        },
        renderedFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
          description: 'Rendered-body format. Defaults to auto.',
        },
        includePaths: {
          type: 'boolean',
          description: 'Include a small capped list of exact differing structural paths.',
        },
      },
      required: [],
    },
    handler: async (input: unknown) => {
      const args = inputRecord(input);
      const params = scalarParams(args.params ?? {});
      if (!params) return { result: 'params must contain only scalar values', isError: true };
      const state = scalarParams(args.state ?? {});
      if (!state) return { result: 'state must contain only scalar values', isError: true };
      const credentialValues = scalarParams(args.credentialValues ?? {});
      if (
        !credentialValues ||
        Object.values(credentialValues).some((value) => typeof value !== 'string')
      )
        return { result: 'credentialValues must contain only string values', isError: true };
      const defaultCredentialValues = Object.fromEntries(
        (context.sharedContext?.credentialNames ?? []).map((name, index) => [
          name,
          `synthetic-credential-${index + 1}`,
        ]),
      );
      const artifactRequestIndex =
        typeof args.artifactRequestIndex === 'number' && Number.isInteger(args.artifactRequestIndex)
          ? args.artifactRequestIndex
          : undefined;
      if (args.artifactRequestIndex !== undefined && artifactRequestIndex === undefined)
        return { result: 'artifactRequestIndex must be an integer', isError: true };
      const recordedFormat = parseBodyFormat(args.recordedFormat);
      if (!recordedFormat) return { result: 'unsupported recorded body format', isError: true };
      const renderedFormat = parseBodyFormat(args.renderedFormat);
      if (!renderedFormat) return { result: 'unsupported rendered body format', isError: true };

      const workflowPath = pathJoin(toolDir, 'workflow.json');
      if (!existsSync(workflowPath))
        return { result: 'workflow.json has not been written', isError: true };

      let workflow: Workflow;
      try {
        workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
      } catch (error) {
        return {
          result: `workflow.json schema invalid: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      if (
        artifactRequestIndex !== undefined &&
        (artifactRequestIndex < 0 || artifactRequestIndex >= workflow.requests.length)
      )
        return { result: 'artifactRequestIndex is outside workflow.requests', isError: true };

      const requestProvenance = workflow.requests.flatMap((request, index) =>
        request.recordingRequestSeq === undefined
          ? []
          : [{ artifactRequestIndex: index, recordingRequestSeq: request.recordingRequestSeq }],
      );
      const lookups: Array<{
        requestOrdinal: number;
        artifactRequestIndex?: number;
        recordingRequestSeq?: number;
      }> = [];
      let rendered: Awaited<ReturnType<typeof renderWorkflowRequests>>;
      const siteDir = dirname(toolDir);
      const freshRoot = mkdtempSync(pathJoin(siteDir, '.imprint-render-'));
      const freshToolDir = pathJoin(freshRoot, basename(toolDir));
      try {
        mkdirSync(freshToolDir, { recursive: true });
        copyFileSync(workflowPath, pathJoin(freshToolDir, 'workflow.json'));
        const dependencyDir = pathJoin(toolDir, 'node_modules');
        if (existsSync(dependencyDir)) {
          symlinkSync(dependencyDir, pathJoin(freshToolDir, 'node_modules'), 'dir');
          symlinkSync(dependencyDir, pathJoin(freshRoot, 'node_modules'), 'dir');
        }
        for (const modulePath of [workflow.requestTransformModule, workflow.parserModule]) {
          if (modulePath) {
            copyArtifactDependencyClosure(pathResolve(toolDir, modulePath), siteDir, freshRoot);
          }
        }
        rendered = await renderWorkflowRequests({
          workflow,
          workflowPath: pathJoin(freshToolDir, 'workflow.json'),
          params,
          initialState: state,
          credentials: {
            site: workflow.site,
            cookies: [],
            values: {
              ...defaultCredentialValues,
              ...(credentialValues as Record<string, string>),
            },
            storage: [],
          },
          requestProvenance,
          recordedResponseFor: (_method, _url, lookup) => {
            lookups.push({
              requestOrdinal: lookup.requestOrdinal,
              ...(lookup.provenance
                ? {
                    artifactRequestIndex: lookup.provenance.artifactRequestIndex,
                    recordingRequestSeq: lookup.provenance.recordingRequestSeq,
                  }
                : {}),
            });
            const recorded = lookup.provenance
              ? session.requests.find(
                  (request) => request.seq === lookup.provenance?.recordingRequestSeq,
                )
              : undefined;
            return recorded?.response
              ? {
                  status: recorded.response.status,
                  body: recorded.response.body ?? '',
                  headers: recorded.response.headers,
                }
              : undefined;
          },
        });
      } catch (error) {
        return {
          result: JSON.stringify({
            state: 'render_failed',
            error: error instanceof Error ? error.message : String(error),
          }),
          isError: true,
        };
      } finally {
        rmSync(freshRoot, { recursive: true, force: true });
      }

      const comparisons = lookups.flatMap<Record<string, unknown>>((lookup) => {
        if (
          artifactRequestIndex !== undefined &&
          lookup.artifactRequestIndex !== artifactRequestIndex
        )
          return [];
        const prepared = rendered.requests[lookup.requestOrdinal];
        const recorded =
          lookup.recordingRequestSeq === undefined
            ? undefined
            : session.requests.find((request) => request.seq === lookup.recordingRequestSeq);
        if (!prepared || !recorded)
          return [
            {
              requestOrdinal: lookup.requestOrdinal,
              artifactRequestIndex: lookup.artifactRequestIndex,
              recordingRequestSeq: lookup.recordingRequestSeq,
              state: 'not_checked',
              reason: prepared ? 'recording request was unavailable' : 'request was not prepared',
            },
          ];

        const recordedBody = recorded.body ?? null;
        const renderedBody = prepared.body;
        let bodyComparison: Record<string, unknown>;
        if (recordedBody === null && renderedBody === null) {
          bodyComparison = { state: 'not_applicable', reason: 'both requests have no body' };
        } else if (recordedBody === null || renderedBody === null) {
          bodyComparison = {
            state: 'different',
            reason: recordedBody === null ? 'recorded body is absent' : 'rendered body is absent',
          };
        } else {
          const left = decodeBodyStructure(recordedBody, recordedFormat);
          const right = decodeBodyStructure(renderedBody, renderedFormat);
          bodyComparison =
            left.ok && right.ok
              ? {
                  state: 'checked',
                  recordedFormat: left.structure.format,
                  renderedFormat: right.structure.format,
                  comparison: compareBodyStructures(left.structure, right.structure, {
                    includePaths: args.includePaths === true,
                  }),
                }
              : {
                  state: 'not_checked',
                  recordedDecode: left.ok
                    ? { state: 'decoded', format: left.structure.format }
                    : { state: 'failed', code: left.code, error: left.error },
                  renderedDecode: right.ok
                    ? { state: 'decoded', format: right.structure.format }
                    : { state: 'failed', code: right.code, error: right.error },
                };
        }

        const recordedUrl = requestUrlShape(recorded.url);
        const renderedUrl = requestUrlShape(prepared.url);
        return [
          {
            requestOrdinal: lookup.requestOrdinal,
            artifactRequestIndex: lookup.artifactRequestIndex,
            recordingRequestSeq: lookup.recordingRequestSeq,
            transformDeclared: workflow.requestTransformModule !== undefined,
            method: {
              recorded: recorded.method.toUpperCase(),
              rendered: prepared.method.toUpperCase(),
              equal: recorded.method.toUpperCase() === prepared.method.toUpperCase(),
            },
            url: {
              recorded: recordedUrl,
              rendered: renderedUrl,
              equal: requestUrlsEqual(recorded.url, prepared.url),
              queryValuesEqual: requestQueryValuesEqual(recorded.url, prepared.url),
            },
            bodyBytes: {
              recorded:
                recordedBody === null ? null : bodyInspectionEncoder.encode(recordedBody).length,
              rendered:
                renderedBody === null ? null : bodyInspectionEncoder.encode(renderedBody).length,
            },
            body: bodyComparison,
          },
        ];
      });

      const missingRequested =
        artifactRequestIndex !== undefined && comparisons.length === 0
          ? workflow.requests[artifactRequestIndex]?.mode === 'navigate'
            ? {
                artifactRequestIndex,
                state: 'not_applicable',
                reason: 'browser navigation is not an offline fetch comparison',
              }
            : {
                artifactRequestIndex,
                state: 'not_checked',
                reason: rendered.result.ok
                  ? 'workflow completed without capturing an outgoing fetch for this request'
                  : 'no outgoing fetch was captured before workflow execution failed',
              }
          : undefined;
      const execution = rendered.result.ok
        ? { ok: true }
        : {
            ok: false,
            error: rendered.result.error,
            message: rendered.result.message,
          };
      return boundedBodyInspectionResult({
        source: 'offline_real_workflow_render',
        transformDeclared: workflow.requestTransformModule !== undefined,
        execution,
        preparedRequestCount: rendered.requests.length,
        comparisons: missingRequested ? [missingRequested] : comparisons,
      });
    },
  };
}

export function buildSearchRequestsTool(session: Session): AgentTool {
  return {
    name: 'search_requests',
    description:
      'Search recorded requests by method, resource type, URL fragment, response status, and sequence range. Returns exact seq IDs for read_request/read_response_body.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        resourceType: { type: 'string' },
        urlContains: { type: 'string' },
        status: { type: 'number' },
        afterSeq: { type: 'number' },
        beforeSeq: { type: 'number' },
        limit: { type: 'number', description: 'Default 50, maximum 200' },
      },
      required: [],
    },
    handler: async (input: unknown) => {
      const filters = input as {
        method?: string;
        resourceType?: string;
        urlContains?: string;
        status?: number;
        afterSeq?: number;
        beforeSeq?: number;
        limit?: number;
      };
      const method = filters.method?.toUpperCase();
      const resourceType = filters.resourceType?.toLowerCase();
      const url = filters.urlContains?.toLowerCase();
      const requests = session.requests
        .filter((request) => {
          if (method && request.method.toUpperCase() !== method) return false;
          if (resourceType && request.resourceType?.toLowerCase() !== resourceType) return false;
          if (url && !request.url.toLowerCase().includes(url)) return false;
          if (filters.status !== undefined && request.response?.status !== filters.status)
            return false;
          if (filters.afterSeq !== undefined && request.seq <= filters.afterSeq) return false;
          if (filters.beforeSeq !== undefined && request.seq >= filters.beforeSeq) return false;
          return true;
        })
        .sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 50))))
        .map((request) => ({
          seq: request.seq,
          resourceType: request.resourceType,
          method: request.method,
          url: request.url,
          status: request.response?.status,
          mimeType: request.response?.mimeType,
        }));
      return { result: JSON.stringify({ count: requests.length, requests }, null, 2) };
    },
  };
}

// ─── Tool: diff_request_for_event ────────────────────────────────────────────

function buildDiffRequestForEventTool(session: Session): AgentTool {
  return {
    name: 'diff_request_for_event',
    description:
      'List bounded request alternatives around one recorded event without choosing an operation. To compare, explicitly provide beforeSeq and afterSeq; the runtime compares only that exact pair. Facts are value-free and paths stay hidden by default.',
    input_schema: {
      type: 'object',
      properties: {
        eventSeq: {
          type: 'number',
          description: 'Event sequence number (from selectedCandidate.eventSeqs)',
        },
        beforeSeq: {
          type: 'number',
          description: 'Exact earlier request sequence selected by the agent.',
        },
        afterSeq: {
          type: 'number',
          description: 'Exact later request sequence selected by the agent.',
        },
        beforeFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
        },
        afterFormat: {
          type: 'string',
          enum: ['auto', 'json', 'form-urlencoded', 'decimal-framed-json'],
        },
        includePaths: {
          type: 'boolean',
          description: 'Explicitly reveal the small capped list of exact redacted paths.',
        },
      },
      required: ['eventSeq'],
    },
    handler: async (input: unknown) => {
      const args = inputRecord(input);
      const eventSeq = args.eventSeq;
      if (typeof eventSeq !== 'number' || !Number.isInteger(eventSeq)) {
        return {
          result: JSON.stringify({ state: 'invalid', reasonCode: 'invalid_event_seq' }, null, 2),
          isError: true,
        };
      }
      const beforeFormat = parseBodyFormat(args.beforeFormat);
      const afterFormat = parseBodyFormat(args.afterFormat);
      if (!beforeFormat || !afterFormat) {
        return {
          result: JSON.stringify(
            {
              eventSeq,
              state: 'invalid',
              reasonCode: !beforeFormat ? 'invalid_before_format' : 'invalid_after_format',
            },
            null,
            2,
          ),
          isError: true,
        };
      }
      if ((args.beforeSeq === undefined) !== (args.afterSeq === undefined))
        return {
          result: JSON.stringify(
            { eventSeq, state: 'invalid', reasonCode: 'request_pair_incomplete' },
            null,
            2,
          ),
          isError: true,
        };
      const beforeSeq =
        typeof args.beforeSeq === 'number' && Number.isInteger(args.beforeSeq)
          ? args.beforeSeq
          : undefined;
      const afterSeq =
        typeof args.afterSeq === 'number' && Number.isInteger(args.afterSeq)
          ? args.afterSeq
          : undefined;
      if (
        (args.beforeSeq !== undefined && beforeSeq === undefined) ||
        (args.afterSeq !== undefined && afterSeq === undefined)
      ) {
        return {
          result: JSON.stringify(
            { eventSeq, state: 'invalid', reasonCode: 'invalid_request_pair' },
            null,
            2,
          ),
          isError: true,
        };
      }
      const g = groundEvent(session, eventSeq, {
        includePaths: args.includePaths === true,
        ...(beforeSeq !== undefined && afterSeq !== undefined
          ? {
              compare: {
                beforeSeq,
                afterSeq,
                beforeFormat,
                afterFormat,
              },
            }
          : {}),
      });
      return {
        result: JSON.stringify(g, null, 2),
        ...(g.state === 'invalid' || g.state === 'not_found' ? { isError: true } : {}),
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

export function buildWriteFileTool(
  toolDir: string,
  extraAllowed: string[] = [],
  strategyKind: CompileStrategyKind = 'api',
): AgentTool {
  const allowed = [
    ...(strategyKind === 'playbook_fallback'
      ? ['workflow.json', 'playbook.yaml']
      : [
          'workflow.json',
          'parser.ts',
          'parser.test.ts',
          'request.test.ts',
          'request-transform.ts',
          'integration.test.ts',
        ]),
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
      const { path } = input as { path?: string };
      if (!path || path.includes('..') || path.startsWith('/')) {
        return {
          result: 'invalid path — must be relative to the generated tool directory',
          isError: true,
        };
      }

      const absolutePath = pathJoin(toolDir, path);
      try {
        if (!statSync(absolutePath).isFile()) {
          return { result: `file not found: ${absolutePath}`, isError: true };
        }
        let content = readFileSync(absolutePath, 'utf8');
        const MAX_SIZE = 100 * 1024;
        if (content.length > MAX_SIZE) content = `${content.slice(0, MAX_SIZE)}\n[…truncated…]`;
        return {
          result: JSON.stringify({ content, size: content.length }),
        };
      } catch {
        return { result: `file not found: ${absolutePath}`, isError: true };
      }
    },
  };
}
function buildRunBashTool(toolDir: string): AgentTool {
  return {
    name: 'run_bash',
    description: 'Run a shell command in the generated tool directory with a timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds (default 120, max 300)' },
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
      return await runCommand(command, toolDir, Math.min(timeoutSec, 300) * 1000);
    },
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ result: string; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...(extraEnv ?? {}) };
    childEnv.IMPRINT_TEACH_CREDENTIALS = undefined;
    // `detached: true` makes the child its own process-group leader so a timeout
    // can SIGKILL the WHOLE tree (sh → bun → Chrome), not just `sh`.
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: childEnv,
      detached: true,
    });

    proc.once('error', reject);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;

    const killGroup = (): void => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    };
    const cancel = (): void => {
      cancelled = true;
      killGroup();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });

    const TRUNCATE_LIMIT = 16 * 1024; // 16KB

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.('stdout', text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.('stderr', text);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      // Kill the whole process GROUP, not just `sh`. A hung `bun run probe.ts`
      // spawns bun + Chrome children that survive a bare proc.kill() (SIGTERM to
      // sh only); they keep the stdout pipe open so 'close' never fires, hanging
      // this call until the outer MCP tool timeout (30m) — exactly what ate a
      // tool's compile budget. SIGKILL the group so the timeout reaps bun + any
      // leaked browser and 'close' fires promptly.
      killGroup();
    }, timeoutMs);

    proc.on('close', (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);

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

      if (cancelled) {
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Command cancelled', 'AbortError'),
        );
        return;
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
        compilerOptions: {
          // Generated tools normally live under ~/.imprint, outside the repo's
          // node_modules ancestry. Extending the repo tsconfig does not change
          // where TypeScript searches for named `types`, so point that lookup
          // at the dependencies of the runtime being compiled.
          typeRoots: [pathJoin(REPO_ROOT, 'node_modules', '@types')],
        },
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

export function buildRunTestsTool(
  toolDir: string,
  sessionPath: string,
  opts: { networkDisabled?: boolean } = {},
): AgentTool {
  return {
    name: 'run_tests',
    description:
      'Run the agent-written parser.test.ts and/or request.test.ts plus strict TypeScript checks for generated parser/request-transform artifacts, then report pass/fail counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const testNames = ['parser.test.ts', 'request.test.ts'].filter((name) =>
        existsSync(pathJoin(toolDir, name)),
      );
      if (testNames.length === 0) {
        return {
          result: 'no generated tests exist — write parser.test.ts and/or request.test.ts first',
          isError: true,
        };
      }

      // Agent tests execute from ~/.imprint/<site>/<tool>. Ensure their
      // `imprint/*` imports resolve to the runtime currently doing the compile,
      // rather than a stale global install or vanished worktree.
      ensureImprintRuntimeLink(toolDir);

      let workflowRequiresIsolation = false;
      try {
        workflowRequiresIsolation = workflowHasIrreversibleEffect(
          WorkflowSchema.parse(
            JSON.parse(readFileSync(pathJoin(toolDir, 'workflow.json'), 'utf8')),
          ),
        );
      } catch {
        // Workflow/schema failures are reported by the compile verifier.
      }
      const testCommand = networkIsolatedCommand(
        `bun test ${testNames.join(' ')}`,
        opts.networkDisabled === true || workflowRequiresIsolation,
      );
      if (!testCommand) {
        return {
          result:
            'offline tests require a supported network-isolation runner for an irreversible workflow',
          isError: true,
        };
      }
      const cmdResult = await runCommand(testCommand, toolDir, 120000, {
        [SESSION_PATH_ENV]: sessionPath,
      });

      const output = JSON.parse(cmdResult.result) as {
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      };

      const testOutput = `${output.stdout}\n${output.stderr}`;
      const passMatch = testOutput.match(/(\d+)\s+pass/);
      const failMatch = testOutput.match(/(\d+)\s+fail/);

      const passed = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0;
      const failed = failMatch?.[1] ? Number.parseInt(failMatch[1], 10) : 0;
      const total = passed + failed;
      const typecheckIncludes = ['parser.ts', 'request-transform.ts'].filter((name) =>
        existsSync(pathJoin(toolDir, name)),
      );
      const typecheck =
        typecheckIncludes.length > 0
          ? await typecheckArtifacts(toolDir, typecheckIncludes)
          : { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      const typecheckFailed = typecheck.exitCode !== 0 || typecheck.timedOut;

      return {
        result: JSON.stringify({
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
          passed,
          failed,
          total,
          timedOut: output.timedOut,
          typecheck: {
            stdout: typecheck.stdout,
            stderr: typecheck.stderr,
            exitCode: typecheck.exitCode,
            timedOut: typecheck.timedOut,
          },
        }),
        isError: output.exitCode !== 0 || output.timedOut || typecheckFailed,
      };
    },
  };
}

function networkIsolatedCommand(command: string, disabled: boolean): string | null {
  if (!disabled) return command;
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return `/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' ${command}`;
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
    return `/usr/bin/bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net -- ${command}`;
  }
  return null;
}

// ─── External Verification ──────────────────────────────────────────────────

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
  /** True when the run was killed by the wall-clock timeout rather than exiting. */
  timedOut: boolean;
  /** Per-test names recovered from the JUnit report. */
  passed: Set<string>;
  failed: Set<string>;
}

/** Per-exposed-parameter outcome supplied by the independent semantic review. */
export interface ParamVerification {
  name: string;
  verified: boolean;
  /** Why an exposed param is unverified. Undefined when `verified` is true. */
  reason?: 'waived-safety' | 'semantic-gap';
  /** For a producer-sourced token param, the sibling tool + output field its
   *  value comes from. Stamped into workflow.json (`param.sourcedFrom`) so the
   *  MCP description tells the orchestrating LLM where to mint it and the audit
   *  harness chains producer→consumer instead of fabricating a token. */
  sourcedFrom?: { tool: string; field: string };
}

/**
 * Run a single `bun test <file>` and recover its raw output and per-test
 * pass/fail names via a transient JUnit report in the tool directory.
 */
export async function runBunTestWithResults(
  testPath: string,
  toolDir: string,
  timeoutMs: number,
  env: Record<string, string> = {},
  opts: {
    bail?: boolean;
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
    networkDisabled?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<BunTestRun> {
  // Direct verifier calls do not necessarily pass through buildRunTestsTool.
  ensureImprintRuntimeLink(toolDir);
  const junitPath = pathJoin(toolDir, `.imprint-junit-${basename(testPath)}.xml`);
  try {
    if (existsSync(junitPath)) unlinkSync(junitPath);
  } catch {
    // best-effort
  }
  const command = networkIsolatedCommand(
    `bun test ${testPath} --reporter=junit --reporter-outfile=${junitPath}${opts.bail ? ' --bail=1' : ''}`,
    opts.networkDisabled === true,
  );
  if (!command) {
    return {
      stdout: '',
      stderr: 'network-isolated test runner unavailable',
      exitCode: -1,
      timedOut: false,
      passed: new Set(),
      failed: new Set(),
    };
  }
  const result = await runCommand(command, toolDir, timeoutMs, env, opts.onOutput, opts.signal);
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

/** Import the real generated parser in a disposable subprocess and verify its
 * runtime export. The irreversible path uses the same network isolation as its
 * authored offline tests, so validation never falls back to source-shape regexes. */
async function parserExportFailure(
  toolDir: string,
  networkDisabled: boolean,
): Promise<string | undefined> {
  const testPath = pathJoin(toolDir, `.imprint-parser-export-${process.pid}-${Date.now()}.test.ts`);
  writeFileSync(
    testPath,
    `import { test } from 'bun:test';
import * as parser from './parser.ts';

test('parser runtime export', () => {
  if (typeof (parser as Record<string, unknown>).extract !== 'function') {
    throw new Error('parser.ts must export an extract function');
  }
});
`,
    'utf8',
  );
  try {
    const run = await runBunTestWithResults(testPath, toolDir, 120_000, {}, { networkDisabled });
    if (run.exitCode === 0 && !run.timedOut) return undefined;
    return `parser.ts runtime export check exited ${run.exitCode}${run.timedOut ? ' after timing out' : ''}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
  } finally {
    try {
      if (existsSync(testPath)) unlinkSync(testPath);
    } catch {
      // Best-effort removal of the host-authored transient check.
    }
  }
}

function detectUncontractedCredentialPlaceholders(
  workflowJson: string,
  allowedCredentialNames: Set<string>,
): string[] {
  const placeholders = new Set(
    [...workflowJson.matchAll(/\$\{credential\.([A-Za-z0-9_]+)\}/g)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name)),
  );
  const uncontracted = [...placeholders].filter((name) => !allowedCredentialNames.has(name));
  if (uncontracted.length === 0) return [];
  return [
    `workflow.json references uncontracted credential placeholder(s): ${uncontracted
      .map((name) => `\${credential.${name}}`)
      .join(
        ', ',
      )}. Only credentials named by the declared auth contract may use \${credential.NAME}. Choose a different supported mechanism only after inspecting exact evidence; never copy a raw secret.`,
  ];
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
      .join(', ')}) — retained for agent review and later verification.`,
  ];
}

/**
 * Persist a caller-supplied live-verification outcome on workflow.json. This
 * helper records the decision; it does not classify test or provider failures.
 * Best-effort: a metadata write failure does not replace the original outcome.
 */
export function applyLiveVerification(
  toolDir: string,
  liveVerification:
    | {
        kind: 'waived-safety';
        firstError: string;
        exhaustedBackends: string[];
      }
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

/** Apply the common compile outcome for workflows that must never be exercised
 * live. Provider frontends own their transport-specific completion messages,
 * while this helper owns the shared workflow metadata. */
export function applyIrreversibleVerificationWaiver(toolDir: string, workflow: Workflow): string[] {
  applyLiveVerification(toolDir, {
    kind: 'waived-safety',
    firstError: 'live verification is disabled for irreversible workflows',
    exhaustedBackends: [],
  });
  return [
    'live verification: N/A because the workflow declares an irreversible request',
    ...applyParamVerification(
      toolDir,
      workflow.parameters.map((parameter) => ({
        name: parameter.name,
        verified: false,
        reason: 'waived-safety' as const,
        ...(parameter.sourcedFrom ? { sourcedFrom: parameter.sourcedFrom } : {}),
      })),
    ),
  ];
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

export function irreversibleProvenanceFailures(
  session: Session,
  workflow: ReturnType<typeof WorkflowSchema.parse>,
  scope: { candidateRequestSeqs?: number[]; dependencyRequestSeqs?: number[] } = {},
): string[] {
  const scopedSeqs = new Set([
    ...(scope.candidateRequestSeqs ?? []),
    ...(scope.dependencyRequestSeqs ?? []),
  ]);
  const hasScope = scopedSeqs.size > 0;
  const failures: string[] = [];

  for (const recorded of session.requests.filter(isIrreversibleRequest)) {
    if (hasScope && !scopedSeqs.has(recorded.seq)) continue;
    const generated = workflow.requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.recordingRequestSeq === recorded.seq);
    if (generated.length === 0) {
      failures.push(
        `triage classified recorded request seq ${recorded.seq} as irreversible, but workflow.json has no request with recordingRequestSeq: ${recorded.seq}`,
      );
    }
  }

  for (const [index, request] of workflow.requests.entries()) {
    const recorded =
      request.recordingRequestSeq === undefined
        ? undefined
        : session.requests.find((candidate) => candidate.seq === request.recordingRequestSeq);
    if (recorded && isIrreversibleRequest(recorded) && !isIrreversibleRequest(request)) {
      failures.push(
        `workflow request index ${index} grounded by recordingRequestSeq ${recorded.seq} must declare effect: "irreversible"`,
      );
    }
    if (!isIrreversibleRequest(request)) continue;
    if (request.recordingRequestSeq === undefined) {
      failures.push(
        `irreversible workflow request index ${index} must include recordingRequestSeq provenance`,
      );
    } else if (!session.requests.some((recorded) => recorded.seq === request.recordingRequestSeq)) {
      failures.push(
        `irreversible workflow request index ${index} references unknown recordingRequestSeq ${request.recordingRequestSeq}`,
      );
    }
  }

  return failures;
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

/** Cross-reference every capture that a request actually depends on
 *  (referenced via `${state.X}` in a header/body/url) against the recording,
 *  regardless of the capture's `required` flag. Fix A only checks `required`
 *  captures and only against the capture's own URL response; that misses the
 *  case where a `required:false` html_regex capture is scraped from a bootstrap page that isn't itself in the
 *  recording, yet a request hard-references `${state.csrf_token}` in a header.
 *  At runtime that reference STATE_MISSINGs the whole workflow. This check
 *  rejects done() so the agent must fix the pattern (or source).
 *
 *  Missing captures are also rejected: a request that contains `${state.X}` has
 *  made X required, and running the live ladder cannot synthesize an undeclared
 *  workflow producer. Scope for pattern validation remains html_regex /
 *  text_regex captures (robustly checkable by testing the pattern against every
 *  recorded same-origin HTML document body). Other declared sources
 *  referenced-but-not-required are left to Fix A / the integration test.
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

  const htmlBodies = recordedHtmlBodiesForWorkflow(workflow, session);

  // 4) For each referenced state name produced by an html_regex/text_regex
  //    capture, assert the pattern matches at least one recorded HTML body.
  for (const name of referenced) {
    const cap = capByName.get(name);
    if (!cap) {
      failures.push(
        `request references \${state.${name}}, but workflow.json declares no capture named "${name}". At runtime \${state.${name}} resolves to nothing → the request fails with STATE_MISSING. Add a bootstrap/request capture that produces "${name}", or remove the placeholder if the value is not actually needed.`,
      );
      failedCaptureNames.add(name);
      continue;
    }
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

function recordedHtmlBodiesForWorkflow(
  workflow: ReturnType<typeof WorkflowSchema.parse>,
  session: Session,
): string[] {
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
  const sameOriginBodies = session.requests
    .filter((r) => isHtmlDoc(r) && sameOrigin(r))
    .map((r) => r.response?.body ?? '');
  if (sameOriginBodies.length > 0) return sameOriginBodies;
  return session.requests.filter(isHtmlDoc).map((r) => r.response?.body ?? '');
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

export async function externalVerification(
  toolDir: string,
  session: Session,
  sessionPath: string,
  opts: {
    expectedToolName?: string;
    candidateRequestSeqs?: number[];
    /** Build-plan-declared dependency seqs included in exact effect provenance. */
    dependencyRequestSeqs?: number[];
    /** Known credential values (name → value), used only to validate declared
     * credential placeholder names. */
    credentialValues?: Record<string, string>;
    /** Credential names provisioned or declared by the site's auth contract. */
    credentialNames?: string[];
    /** Master-accepted execution strategy for this focused compile. */
    strategyKind?: CompileStrategyKind;
    /** Agentic compile path only: let the independent verifier run the live
     *  suite and judge its factual outputs. No source-shape inspection occurs. */
    deferLiveIntegrationToSemanticAgent?: boolean;
    /** Master-accepted public contract. Supplied only by the master MVP path;
     * standalone generation continues to let its compile agent choose the
     * final parameter surface. */
    expectedPublicParameters?: readonly {
      name: string;
      type?: 'string' | 'number' | 'boolean';
    }[];
  } = {},
): Promise<{
  failures: string[];
  warnings: string[];
  paramVerification: ParamVerification[];
  /** Actual tool-level inputs and parsed results captured by the single live
   * integration run. The caller hands these to the independent semantic agent. */
  integrationEvidence: LiveIntegrationEvidence[];
}> {
  const failures: string[] = [];
  const warnings: string[] = [];
  let integrationEvidence: LiveIntegrationEvidence[] = [];
  const paramVerification: ParamVerification[] = [];
  let irreversibleProvenanceMissing = false;
  let hasIrreversibleWorkflow = false;
  let parsedWorkflow: Workflow | undefined;

  const workflowPath = pathJoin(toolDir, 'workflow.json');
  const parserPath = pathJoin(toolDir, 'parser.ts');
  const parserTestPath = pathJoin(toolDir, 'parser.test.ts');
  const requestTestPath = pathJoin(toolDir, 'request.test.ts');
  if (!existsSync(workflowPath)) {
    failures.push('workflow.json was not written');
  } else {
    try {
      const raw = JSON.parse(readFileSync(workflowPath, 'utf8'));
      parsedWorkflow = WorkflowSchema.parse(raw);
      failures.push(...bodyEncodingContractFailures(parsedWorkflow));
      hasIrreversibleWorkflow = workflowHasIrreversibleEffect(parsedWorkflow);
      if (opts.expectedToolName && parsedWorkflow.toolName !== opts.expectedToolName) {
        failures.push(
          `workflow.toolName "${parsedWorkflow.toolName}" does not match selected candidate "${opts.expectedToolName}"`,
        );
      }
      if (opts.expectedPublicParameters) {
        const unresolved = opts.expectedPublicParameters
          .filter(({ type }) => type === undefined)
          .map(({ name }) => name);
        if (unresolved.length > 0) {
          failures.push(
            `master public parameter contract has unresolved type(s): ${unresolved.join(', ')}`,
          );
        } else {
          const expected = opts.expectedPublicParameters
            .map(({ name, type }) => ({ name, type }))
            .sort((left, right) => left.name.localeCompare(right.name));
          const actual = parsedWorkflow.parameters
            .map(({ name, type }) => ({ name, type }))
            .sort((left, right) => left.name.localeCompare(right.name));
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            failures.push(
              `workflow parameters do not match the master's accepted public contract (expected: ${expected.map(({ name, type }) => `${name}:${type}`).join(', ') || 'none'}; actual: ${actual.map(({ name, type }) => `${name}:${type}`).join(', ') || 'none'})`,
            );
          }
        }
      }
      const wfStr = JSON.stringify(raw);
      const allowedCredentialNames = new Set([
        ...Object.keys(opts.credentialValues ?? {}),
        ...(opts.credentialNames ?? []),
      ]);
      failures.push(...detectUncontractedCredentialPlaceholders(wfStr, allowedCredentialNames));
      const envMatches = wfStr.match(/\$\{env\.[A-Za-z0-9_.]+\}/g);
      if (envMatches && envMatches.length > 0) {
        failures.push(
          `workflow.json contains \${env.X} placeholders (${envMatches.join(', ')}). These require undeclared environment setup and break the artifact contract. Choose a declared parameter, credential, capture, response, generation step, transform, or evidence-backed literal as appropriate.`,
        );
      }
      // Cross-reference every required capture against exact recording facts.
      // A capture that declares `response_header` but reads from a recorded
      // response with no such header (or `html_regex` whose pattern doesn't
      // match the recorded body, etc.) will silently return null at runtime;
      // we reject it at compile so the agent picks a source that works.
      const crossRef = crossReferenceCaptures(parsedWorkflow, session, opts.candidateRequestSeqs);
      failures.push(...crossRef.failures);

      // A referenced capture is mechanically required regardless of its flag.
      const stateRef = crossReferenceReferencedStateCaptures(parsedWorkflow, session);
      failures.push(...stateRef.failures);
    } catch (err) {
      failures.push(
        `workflow.json schema invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.strategyKind === 'playbook_fallback') {
    if (parsedWorkflow && parsedWorkflow.requests.length !== 0) {
      failures.push(
        `playbook_fallback requires a request-free workflow.json, but found ${parsedWorkflow.requests.length} request(s)`,
      );
    }

    const playbookPath = pathJoin(toolDir, 'playbook.yaml');
    if (!existsSync(playbookPath)) {
      failures.push('playbook.yaml was not written for the accepted playbook_fallback strategy');
    } else {
      try {
        const playbook = parsePlaybook(readFileSync(playbookPath, 'utf8'));
        if (parsedWorkflow) {
          if (playbook.toolName !== parsedWorkflow.toolName) {
            failures.push(
              `playbook.toolName "${playbook.toolName}" does not match workflow.toolName "${parsedWorkflow.toolName}"`,
            );
          }
          const workflowParameters = new Map(
            parsedWorkflow.parameters.map((parameter) => [parameter.name, parameter.type]),
          );
          const playbookParameters = new Map(
            playbook.parameters.map((parameter) => [parameter.name, parameter.type]),
          );
          for (const [name, type] of workflowParameters) {
            const playbookType = playbookParameters.get(name);
            if (playbookType === undefined) {
              failures.push(`playbook.yaml is missing workflow parameter "${name}"`);
            } else if (playbookType !== type) {
              failures.push(
                `playbook parameter "${name}" has type "${playbookType}" but workflow.json declares "${type}"`,
              );
            }
          }
          for (const name of playbookParameters.keys()) {
            if (!workflowParameters.has(name)) {
              failures.push(`playbook.yaml declares unexpected parameter "${name}"`);
            }
          }
        }
      } catch (error) {
        failures.push(
          `playbook.yaml schema invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const artifact of [
      'parser.ts',
      'parser.test.ts',
      'request.test.ts',
      'request-transform.ts',
      'integration.test.ts',
    ]) {
      if (existsSync(pathJoin(toolDir, artifact))) {
        failures.push(
          `${artifact} is an API artifact and is not allowed by the accepted playbook_fallback strategy`,
        );
      }
    }

    return { failures, warnings, paramVerification, integrationEvidence };
  }

  if (opts.strategyKind === 'api' && existsSync(pathJoin(toolDir, 'playbook.yaml'))) {
    failures.push('playbook.yaml does not match the accepted api strategy');
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

  // Irreversible-effect provenance: semantic classification belongs to triage
  // and compile agents. This deterministic gate only proves that their declared
  // effect stays attached to the exact recording request sequence.
  if (existsSync(workflowPath)) {
    try {
      const wf = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
      const irreversibleFailures = irreversibleProvenanceFailures(session, wf, {
        candidateRequestSeqs: opts.candidateRequestSeqs,
        dependencyRequestSeqs: opts.dependencyRequestSeqs,
      });
      if (irreversibleFailures.length > 0) {
        irreversibleProvenanceMissing = true;
        failures.push(...irreversibleFailures);
      }
    } catch {
      /* workflow parse already checked above */
    }
  }

  const safetyBlocked = hasIrreversibleWorkflow || irreversibleProvenanceMissing;

  if (!existsSync(parserPath)) {
    failures.push('parser.ts was not written');
  } else {
    const exportFailure = await parserExportFailure(toolDir, safetyBlocked);
    if (exportFailure) failures.push(exportFailure);
  }

  if (!existsSync(parserTestPath)) {
    failures.push('parser.test.ts was not written');
  }

  if (existsSync(parserTestPath)) {
    const run = await runBunTestWithResults(
      parserTestPath,
      toolDir,
      120000,
      {
        [SESSION_PATH_ENV]: sessionPath,
      },
      {
        networkDisabled: safetyBlocked,
      },
    );
    if (run.exitCode !== 0) {
      failures.push(
        `bun test parser.test.ts exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    }
  }

  let workflowForRequestTests: ReturnType<typeof WorkflowSchema.parse> | undefined;
  try {
    workflowForRequestTests = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  } catch {
    // The workflow schema failure above is the actionable error.
  }
  if (
    workflowForRequestTests &&
    requestsNeedingBodyEncodingDecision(workflowForRequestTests).length > 0
  ) {
    const src = existsSync(requestTestPath) ? readFileSync(requestTestPath, 'utf8') : undefined;
    failures.push(...requestEncodingTestContractFailures(workflowForRequestTests, src));
    if (src !== undefined) {
      const run = await runBunTestWithResults(
        requestTestPath,
        toolDir,
        120000,
        {
          [SESSION_PATH_ENV]: sessionPath,
        },
        {
          networkDisabled: safetyBlocked,
        },
      );
      if (run.exitCode !== 0) {
        failures.push(
          `bun test request.test.ts exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        );
      }
    }
  }

  // The host observes only whether the authored suite ran and what it produced.
  // Test names and source shape are deliberately left to the compile and review agents.
  const integrationTestPath = pathJoin(toolDir, 'integration.test.ts');
  if (safetyBlocked) {
    warnings.push(
      'live integration suite omitted because the workflow declares an irreversible request',
    );
  } else if (!existsSync(integrationTestPath)) {
    failures.push('integration.test.ts was not written');
  } else if (!opts.deferLiveIntegrationToSemanticAgent) {
    const verifierTimeoutMs = 10 * 60_000;
    const evidencePath = pathJoin(
      toolDir,
      `.imprint-live-evidence-${process.pid}-${Date.now()}.jsonl`,
    );
    try {
      if (existsSync(evidencePath)) unlinkSync(evidencePath);
    } catch {
      // Best-effort cleanup before the run.
    }
    const run = await runBunTestWithResults(integrationTestPath, toolDir, verifierTimeoutMs, {
      [LIVE_EVIDENCE_PATH_ENV]: evidencePath,
    });
    try {
      integrationEvidence = readLiveIntegrationEvidence(evidencePath);
    } catch (error) {
      failures.push(
        `could not read captured live integration evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        if (existsSync(evidencePath)) unlinkSync(evidencePath);
      } catch {
        // Evidence is ephemeral and intentionally never kept with artifacts.
      }
    }
    if (run.exitCode !== 0 || run.timedOut) {
      failures.push(
        `bun test integration.test.ts exited ${run.exitCode}${run.timedOut ? ' after timing out' : ''}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
    } else if (integrationEvidence.length === 0) {
      failures.push(
        'integration.test.ts passed but captured no live evidence. Use runCapturedIntegrationCase for live workflow calls so the independent verifier can inspect the actual tool inputs and parsed outputs.',
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

  return { failures, warnings, paramVerification, integrationEvidence };
}
