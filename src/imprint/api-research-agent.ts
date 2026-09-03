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
  ApiResearchInput,
  ApiResearchObservation,
  PlannableTeachingTool,
} from './master-teach-agent-contracts.ts';
import {
  type MasterTeachAgentOptions,
  apiResearchCandidateSha256,
  apiResearchInputsSha256,
  type requestApiResearchStep,
} from './master-teach-agents.ts';
import type {
  PromptEvidenceProjection,
  RecordingIndex,
  RunIdentity,
} from './master-teach-prompt-projections.ts';
import type { RunDeadlineRef } from './provider-retry.ts';
import type { ToolResult, Workflow } from './types.ts';
import type { ConcreteBackend } from './types.ts';

const RESULT_PREVIEW_BYTES = 12_000;

export interface ApiResearchResult {
  researchInputsSha256: string;
  candidate: ApiResearchCandidate;
  workflow: Workflow;
  toolDir: string;
  summary: string;
  observation: ApiResearchObservation;
  parameters: Record<string, string | number | boolean>;
  /** The exact rung that produced the agent-approved semantic result. */
  backend?: ConcreteBackend;
}

export class ApiResearchBlockedError extends Error {
  constructor(
    message: string,
    readonly observations: readonly ApiResearchObservation[],
  ) {
    super(message);
    this.name = 'ApiResearchBlockedError';
  }
}

export interface ApiResearchDependencies {
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

function preview(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  const redacted = redactFreeformText(serialized ?? '').redacted;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.length <= RESULT_PREVIEW_BYTES) return redacted;
  return `${bytes.subarray(0, RESULT_PREVIEW_BYTES).toString('utf8')}\n[preview truncated]`;
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
  toolDir: string;
  agent: MasterTeachAgentOptions;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  report?: (message: string) => void;
  dependencies: ApiResearchDependencies;
}): Promise<ApiResearchResult> {
  const observations: ApiResearchObservation[] = [];
  let proposedBlockReason: string | undefined;
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
      evidence: input.evidence,
      observations,
      ...(proposedBlockReason ? { blockReview: { proposedReason: proposedBlockReason } } : {}),
    };
    const decision = await input.dependencies.requestStep(researchInput, input.agent);
    if (decision.action === 'blocked') {
      if (!proposedBlockReason) {
        proposedBlockReason = decision.reason;
        continue;
      }
      throw new ApiResearchBlockedError(decision.reason, observations);
    }
    proposedBlockReason = undefined;
    const candidate = decision.candidate;
    if (!candidate) throw new Error('API researcher returned no candidate');
    if (decision.action === 'proven') {
      const observation = observations.find(({ id }) => id === decision.basedOnObservationId);
      if (!observation) throw new Error('API researcher cited an unavailable observation');
      const workflowPath = writeCandidate(input.toolDir, candidate);
      const backend = concreteBackend(observation.executionMechanism);
      if (backend) rememberProvenCompileBackend(workflowPath, backend);
      writeFileSync(
        pathJoin(input.toolDir, 'api-research.json'),
        `${JSON.stringify({ decision, observation }, null, 2)}\n`,
        'utf8',
      );
      return {
        researchInputsSha256: apiResearchInputsSha256(input.tool),
        candidate,
        workflow: candidate.workflow,
        toolDir: input.toolDir,
        summary: decision.reason,
        observation,
        parameters: candidate.parameterValues,
        ...(backend ? { backend } : {}),
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
      observations.push({
        id: randomUUID(),
        candidateSha256: apiResearchCandidateSha256(candidate),
        executionMechanism: observed.executionMechanism,
        backendAttempts: observed.backendAttempts ?? [],
        responseObservations: observed.responseObservations ?? [],
        result: resultFact(observed.result),
      });
    } finally {
      release();
    }
  }
}
