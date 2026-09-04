import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type BackendAttemptFact,
  type BackendResponseObservation,
  rememberProvenCompileBackend,
} from './backend-ladder.ts';
import { acquireSiteLiveLock } from './compile-verification.ts';
import { abortSignalError } from './concurrency.ts';
import { redactFreeformText } from './freeform-redact.ts';
import type {
  ApiResearchCandidate,
  ApiResearchHandoff,
  ApiResearchInput,
  ApiResearchObservation,
  ApiResearchRequestCatalogEntry,
  PlannableTeachingTool,
} from './master-teach-agent-contracts.ts';
import {
  type ApiResearchRetainedTurnDelta,
  type MasterTeachAgentOptions,
  apiResearchCandidateSha256,
  apiResearchInputsSha256,
  apiResearchStableInputsSha256,
  type requestApiResearchStep,
} from './master-teach-agents.ts';
import { teachingPlanContentSha256 } from './master-teach-plan.ts';
import type {
  PromptEvidenceProjection,
  RecordingIndex,
  RunIdentity,
} from './master-teach-prompt-projections.ts';
import type { RunDeadlineRef } from './provider-retry.ts';
import type { ToolResult, Workflow } from './types.ts';
import type { ConcreteBackend } from './types.ts';

const RESULT_PREVIEW_BYTES = 12_000;
const TRUNCATED_PREVIEW_SUFFIX = '\n[preview truncated]';

export interface ApiResearchResult {
  researchInputsSha256: string;
  researchedBoundary: {
    requestSeqs: number[];
    dependencySeqs: number[];
    stableInputsSha256: string;
    dependencyToolNames?: string[];
    requiredLinks?: NonNullable<ApiResearchInput['requiredLinks']>;
  };
  candidate: ApiResearchCandidate;
  workflow: Workflow;
  toolDir: string;
  summary: string;
  observation: ApiResearchObservation;
  parameters: Record<string, string | number | boolean>;
  /** The exact rung that produced the agent-approved semantic result. */
  backend?: ConcreteBackend;
}

export interface ApiResearchPartialResult extends ApiResearchResult {
  status: 'partial';
  missingProof: string[];
}

export type ApiResearchOutcome = ApiResearchResult | ApiResearchPartialResult;

export class ApiResearchBlockedError extends Error {
  constructor(
    message: string,
    readonly observations: readonly ApiResearchObservation[],
  ) {
    super(message);
    this.name = 'ApiResearchBlockedError';
  }
}

interface ApiResearchDependencies {
  requestStep: typeof requestApiResearchStep;
  runApiTool(input: {
    workflowPath: string;
    parameters: Record<string, string | number | boolean>;
    backend?: 'auto' | 'fetch' | 'fetch-bootstrap' | 'cdp-replay' | 'stealth-fetch';
    signal?: AbortSignal;
  }): Promise<{
    result: ToolResult<unknown>;
    executionMechanism: string;
    backendAttempts?: BackendAttemptFact[];
    responseObservations?: BackendResponseObservation[];
  }>;
}

interface ApiResearchInspectionEvidence {
  /** Only evidence for request sequences newly inspected on this turn. */
  delta: PromptEvidenceProjection;
  /** Complete bounded evidence for providers without retained conversations and later planning. */
  accumulated: PromptEvidenceProjection;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function boundedPreview(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= RESULT_PREVIEW_BYTES) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATED_PREVIEW_SUFFIX, 'utf8');
  return `${utf8Prefix(value, RESULT_PREVIEW_BYTES - suffixBytes)}${TRUNCATED_PREVIEW_SUFFIX}`;
}

function renderedHtmlText(value: string): string | undefined {
  if (!/^\s*(?:<!doctype\s+html|<html\b)/i.test(value)) return undefined;
  const withoutNonVisibleContent = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)>/gi,
      ' ',
    );
  const text = withoutNonVisibleContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text ? `[rendered HTML text]\n${text}` : undefined;
}

function preview(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  const factualPreview = renderedHtmlText(serialized ?? '') ?? serialized ?? '';
  return boundedPreview(redactFreeformText(factualPreview).redacted);
}

function resultFact(result: ToolResult<unknown>): ApiResearchObservation['result'] {
  return result.ok
    ? { ok: true, preview: preview(result.data) }
    : {
        ok: false,
        error: result.error,
        message: result.message.slice(0, 4_000),
        preview: '',
      };
}

function writeCandidate(toolDir: string, candidate: ApiResearchCandidate): string {
  mkdirSync(toolDir, { recursive: true, mode: 0o700 });
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  writeFileSync(workflowPath, `${JSON.stringify(candidate.workflow, null, 2)}\n`, 'utf8');
  const transformPath = pathJoin(toolDir, 'request-transform.ts');
  if (candidate.requestTransformSource) {
    writeFileSync(transformPath, candidate.requestTransformSource, 'utf8');
  } else if (existsSync(transformPath)) {
    unlinkSync(transformPath);
  }
  return workflowPath;
}

function concreteBackend(value: string): ConcreteBackend | undefined {
  return ['fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch'].includes(value)
    ? (value as ConcreteBackend)
    : undefined;
}

export async function researchApiMvpCall(input: {
  run: RunIdentity;
  recordingIndex: RecordingIndex;
  tool: PlannableTeachingTool;
  evidence: PromptEvidenceProjection;
  /** Omitted for the deliberately narrow first pass. A follow-up reuses the
   * same provider conversation and carries only master-selected extra facts. */
  followUp?: ApiResearchInput['followUp'];
  previousProgress?: ApiResearchHandoff;
  requestCatalog?: readonly ApiResearchRequestCatalogEntry[];
  requestCatalogTruncated?: boolean;
  requestCatalogPage?: ApiResearchInput['requestCatalogPage'];
  loadNextRequestCatalogPage?: (offset: number) => {
    entries: ApiResearchRequestCatalogEntry[];
    page: NonNullable<ApiResearchInput['requestCatalogPage']>;
  };
  requiredLinks?: ApiResearchInput['requiredLinks'];
  inspectRequests?: (requestSeqs: readonly number[]) => ApiResearchInspectionEvidence;
  toolDir: string;
  agent: MasterTeachAgentOptions;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  report?: (message: string) => void;
  dependencies: ApiResearchDependencies;
}): Promise<ApiResearchOutcome> {
  let evidence = input.evidence;
  let requestCatalog = [...(input.requestCatalog ?? [])];
  let requestCatalogPage = input.requestCatalogPage;
  const inspectedRequestSeqs = new Set<number>();
  const completedInspectionStates = new Set<string>();
  const observations: ApiResearchObservation[] = [
    ...(input.previousProgress?.observations ?? []),
    ...(input.previousProgress?.observation ? [input.previousProgress.observation] : []),
  ].filter((observation, index, all) => all.findIndex(({ id }) => id === observation.id) === index);
  let proposedBlockReason: string | undefined;
  const researchInputsChanged =
    input.previousProgress?.researchInputsSha256 !== apiResearchInputsSha256(input.tool);
  let retainedTurnDelta: ApiResearchRetainedTurnDelta | undefined = input.followUp
    ? {
        kind: 'master_follow_up',
        followUp: input.followUp,
        relevantEvidence: input.evidence,
        requiredLinks: [...(input.requiredLinks ?? [])],
        ...(researchInputsChanged
          ? {
              currentTool: input.tool,
              requestCatalog: [...(input.requestCatalog ?? [])],
              requestCatalogTruncated:
                input.requestCatalogPage?.hasMore ?? input.requestCatalogTruncated ?? false,
              ...(input.requestCatalogPage ? { requestCatalogPage: input.requestCatalogPage } : {}),
            }
          : {}),
      }
    : undefined;
  while (true) {
    if (input.signal?.aborted) throw abortSignalError(input.signal);
    if (Date.now() >= input.runDeadline.deadlineMs) {
      throw new ApiResearchBlockedError(
        'API research reached the shared teach deadline',
        observations,
      );
    }
    const researchInput: ApiResearchInput = {
      run: input.run,
      recordingIndex: input.recordingIndex,
      tool: input.tool,
      evidence,
      observations,
      requestCatalog,
      requestCatalogTruncated:
        requestCatalogPage?.hasMore ?? input.requestCatalogTruncated ?? false,
      ...(requestCatalogPage ? { requestCatalogPage } : {}),
      requiredLinks: [...(input.requiredLinks ?? [])],
      ...(inspectedRequestSeqs.size > 0 ? { inspectedRequestSeqs: [...inspectedRequestSeqs] } : {}),
      researchPhase: input.followUp ? 'follow_up' : 'mvp',
      ...(input.followUp ? { followUp: input.followUp } : {}),
      ...(input.previousProgress ? { previousProgress: input.previousProgress } : {}),
      ...(proposedBlockReason ? { blockReview: { proposedReason: proposedBlockReason } } : {}),
    };
    const decision = await input.dependencies.requestStep(
      researchInput,
      input.agent,
      retainedTurnDelta,
    );
    retainedTurnDelta = undefined;
    if (decision.action === 'catalog') {
      if (!requestCatalogPage?.hasMore || !input.loadNextRequestCatalogPage) {
        throw new Error('API researcher requested another catalog page when none is available');
      }
      const nextOffset = requestCatalogPage.offset + requestCatalog.length;
      const next = input.loadNextRequestCatalogPage(nextOffset);
      if (next.page.offset !== nextOffset || next.entries.length === 0) {
        throw new Error('API research catalog pagination did not advance');
      }
      requestCatalog = [...next.entries];
      requestCatalogPage = next.page;
      retainedTurnDelta = {
        kind: 'catalog_page',
        requestCatalog,
        requestCatalogTruncated: requestCatalogPage.hasMore,
        requestCatalogPage,
      };
      input.report?.(`${input.tool.candidate.toolName}: reading the next request catalog page`);
      continue;
    }
    if (decision.action === 'inspect') {
      if (!input.inspectRequests || !decision.requestedRequestSeqs) {
        throw new Error('API researcher requested evidence inspection without exact request seqs');
      }
      const requestedRequestSeqs = [...decision.requestedRequestSeqs].sort(
        (left, right) => left - right,
      );
      const inspectionStateSha256 = teachingPlanContentSha256({
        evidenceSha256: evidence.ref.sha256,
        requestedRequestSeqs,
      });
      const newRequestSeqs = requestedRequestSeqs.filter((seq) => !inspectedRequestSeqs.has(seq));
      if (newRequestSeqs.length === 0 || completedInspectionStates.has(inspectionStateSha256)) {
        throw new ApiResearchBlockedError(
          'API research requested the exact recording evidence it had already inspected; return this no-progress fact to the master for a different direction or boundary',
          observations,
        );
      }
      completedInspectionStates.add(inspectionStateSha256);
      input.report?.(`${input.tool.candidate.toolName}: inspecting selected recorded requests`);
      for (const seq of newRequestSeqs) inspectedRequestSeqs.add(seq);
      const inspectedEvidence = input.inspectRequests(newRequestSeqs);
      evidence = inspectedEvidence.accumulated;
      retainedTurnDelta = {
        kind: 'inspection',
        inspectedRequestSeqs: newRequestSeqs,
        relevantEvidence: inspectedEvidence.delta,
      };
      proposedBlockReason = undefined;
      continue;
    }
    if (decision.action === 'blocked') {
      if (!proposedBlockReason) {
        proposedBlockReason = decision.reason;
        retainedTurnDelta = {
          kind: 'block_review',
          blockReview: { proposedReason: proposedBlockReason },
        };
        continue;
      }
      throw new ApiResearchBlockedError(decision.reason, observations);
    }
    proposedBlockReason = undefined;
    const candidate = decision.candidate;
    if (!candidate) throw new Error('API researcher returned no candidate');
    if (decision.action === 'proven' || decision.action === 'partial') {
      const observation = observations.find(({ id }) => id === decision.basedOnObservationId);
      if (!observation) throw new Error('API researcher cited an unavailable observation');
      const workflowPath = writeCandidate(input.toolDir, candidate);
      const backend = concreteBackend(observation.executionMechanism);
      if (backend && observation.result.ok) rememberProvenCompileBackend(workflowPath, backend);
      writeFileSync(
        pathJoin(input.toolDir, 'api-research.json'),
        `${JSON.stringify({ decision, observation }, null, 2)}\n`,
        'utf8',
      );
      return {
        researchInputsSha256: apiResearchInputsSha256(input.tool),
        researchedBoundary: {
          requestSeqs: [...input.tool.candidate.requestSeqs],
          dependencySeqs: [...input.tool.candidate.dependencySeqs],
          stableInputsSha256: apiResearchStableInputsSha256(input.tool),
          dependencyToolNames: [...input.tool.candidate.dependsOnTools],
          requiredLinks: [...(input.requiredLinks ?? [])],
        },
        candidate,
        workflow: candidate.workflow,
        toolDir: input.toolDir,
        summary: decision.reason,
        observation,
        parameters: candidate.parameterValues,
        ...(backend ? { backend } : {}),
        ...(decision.action === 'partial'
          ? {
              status: 'partial' as const,
              missingProof: decision.missingProof ?? [
                'The researcher did not state the remaining proof gap.',
              ],
            }
          : {}),
      };
    }

    input.report?.(`${input.tool.candidate.toolName}: testing API request`);
    const workflowPath = writeCandidate(input.toolDir, candidate);
    const release = await acquireSiteLiveLock(workflowPath, input.runDeadline.deadlineMs);
    try {
      const observed = await input.dependencies.runApiTool({
        workflowPath,
        parameters: candidate.parameterValues,
        backend: candidate.testBackend,
        signal: input.signal,
      });
      const observation: ApiResearchObservation = {
        id: randomUUID(),
        candidateSha256: apiResearchCandidateSha256(candidate),
        executionMechanism: observed.executionMechanism,
        backendAttempts: observed.backendAttempts ?? [],
        responseObservations: observed.responseObservations ?? [],
        result: resultFact(observed.result),
      };
      observations.push(observation);
      retainedTurnDelta = { kind: 'observation', latestObservation: observation };
    } finally {
      release();
    }
  }
}
