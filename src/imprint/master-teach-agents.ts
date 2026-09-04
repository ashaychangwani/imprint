/** Five strict one-shot semantic roles. Store/controller state remains authoritative. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { abortSignalError } from './concurrency.ts';
import { type LLMOptions, type ProviderName, resolveProvider } from './llm.ts';
import {
  type ApiResearchCandidate,
  type ApiResearchFollowUpDirective,
  type ApiResearchHandoff,
  ApiResearchHandoffSchema,
  type ApiResearchInput,
  ApiResearchInputSchema,
  ApiResearchOutputSchema,
  type ApiResearchRequiredLink,
  type BaselineMvpReviewInput,
  BaselineMvpReviewInputSchema,
  BaselineMvpReviewOutputSchema,
  BaselineMvpReviewerPromptInputSchema,
  type CompletionReviewInput,
  CompletionReviewInputSchema,
  CompletionReviewOutputSchema,
  type CurrentPlanBinding,
  type CurrentPlanProjection,
  type FocusedPlannerInput,
  FocusedPlannerInputSchema,
  FocusedPlannerOutputSchema,
  type MasterDecisionInput,
  MasterDecisionInputSchema,
  MasterDecisionOutputSchema,
  type ParameterSelectionAdvisorInput,
  ParameterSelectionAdvisorInputSchema,
  ParameterSelectionAdvisorOutputSchema,
  ParameterSelectionAdvisorPromptInputSchema,
  type ToolSelectionAdvisorInput,
  ToolSelectionAdvisorInputSchema,
  ToolSelectionAdvisorOutputSchema,
  ToolSelectionAdvisorPromptInputSchema,
  schemaIssue as issue,
} from './master-teach-agent-contracts.ts';
import {
  type ChainEdge,
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type EditableTeachingTool,
  type TeachingCandidateEvidence,
  chainInvocationForEdge,
  teachingPlanContentSha256 as digest,
  teachingCandidateIssues,
  teachingToolCompileInputsSha256,
  unresolvedCandidateCoverage,
  validateDesiredTeachingPlan,
  validateImplementationPlanForTool,
} from './master-teach-plan.ts';
import type {
  CurrentExecutionSnapshot,
  PromptEvidenceProjection,
  ReceiptFact,
  RecordingIndex,
} from './master-teach-prompt-projections.ts';
import {
  ProviderDeadlineError,
  type ProviderRetryEvent,
  type RunDeadlineRef,
  combinedDeadlineSignal,
  resolvedRunDeadline,
} from './provider-retry.ts';
export * from './master-teach-agent-contracts.ts';
export * from './master-teach-prompt-projections.ts';
const PROMPTS = join(import.meta.dir, '..', '..', 'prompts');
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
export const apiResearchCandidateSha256 = (candidate: ApiResearchCandidate): string =>
  digest(candidate);
export function apiResearchRequiredLinks(
  plan: Pick<DesiredTeachingPlan, 'tools' | 'chainEdges'>,
  tool: Pick<EditableTeachingTool, 'id'>,
): ApiResearchRequiredLink[] {
  const toolNameById = new Map(
    plan.tools.map(({ id, candidate }) => [id, candidate.toolName] as const),
  );
  const obligations = plan.chainEdges
    .filter(
      ({ producerToolId, consumerToolId }) =>
        producerToolId === tool.id || consumerToolId === tool.id,
    )
    .flatMap(({ producerToolId, producerResultPath, consumerToolId, consumerParameter }) => {
      const producerToolName = toolNameById.get(producerToolId);
      const consumerToolName = toolNameById.get(consumerToolId);
      if (!producerToolName || !consumerToolName) return [];
      return [
        ...(producerToolId === tool.id
          ? [
              {
                role: 'producer' as const,
                toolName: producerToolName,
                resultPath: producerResultPath,
              },
            ]
          : []),
        ...(consumerToolId === tool.id
          ? [
              {
                role: 'consumer' as const,
                toolName: consumerToolName,
                parameter: consumerParameter,
              },
            ]
          : []),
      ];
    });
  return [
    ...new Map(obligations.map((link) => [JSON.stringify(link), link] as const)).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const apiResearchTransportEvidence = (tool: ApiResearchInput['tool']) => ({
  loginRequestSeqs: tool.compileContext.loginRequestSeqs,
  authRequestSeqs: tool.compileContext.authRequestSeqs,
  credentialNames: [...tool.compileContext.credentialNames].sort(),
  tokenExtractionNotes: tool.compileContext.tokenExtractionNotes,
  authNotes: tool.compileContext.authNotes,
});

/** Hash transport facts that must still match even when a later plan narrows
 * the proven request scope or fixes a researched public input to a constant.
 * Tool name and remaining parameter names/types are checked directly against
 * the proven workflow by apiResearchCoversToolBoundary. */
export const apiResearchStableInputsSha256 = (tool: ApiResearchInput['tool']): string =>
  digest({
    transportEvidence: apiResearchTransportEvidence(tool),
  });

/** Hash evidence and the public operation boundary that can change request
 * viability. Human-facing descriptions and result prose do not affect whether
 * the tested request works; the master must request new research when it
 * intentionally changes their meaning. Dependency names and selected chain
 * links describe how proven calls compose; changing that wiring does not
 * invalidate the calls. */
export const apiResearchInputsSha256 = (tool: ApiResearchInput['tool']): string =>
  digest({
    toolName: tool.candidate.toolName,
    parameters: tool.candidate.likelyParams.map(({ name, type }) => ({ name, type })),
    requestSeqs: tool.candidate.requestSeqs,
    representativeSeqs: tool.candidate.representativeSeqs,
    dependencySeqs: tool.candidate.dependencySeqs,
    eventSeqs: tool.candidate.eventSeqs,
    transportEvidence: apiResearchTransportEvidence(tool),
  });

/** Bind a follow-up to exactly the current public boundary, retained partial,
 * and selected sibling research. Repeating this digest cannot reveal new
 * facts, while any relevant boundary or handoff change produces a new state. */
export function apiResearchFollowUpStateSha256(
  plan: Pick<DesiredTeachingPlan, 'tools' | 'chainEdges'>,
  handoffs: readonly ApiResearchHandoff[],
  followUp: ApiResearchFollowUpDirective,
): string {
  const handoffByName = new Map(handoffs.map((handoff) => [handoff.toolName, handoff] as const));
  const identity = (toolName: string) => {
    const tool = plan.tools.find(({ candidate }) => candidate.toolName === toolName);
    const handoff = handoffByName.get(toolName);
    return {
      toolName,
      researchInputsSha256: tool ? apiResearchInputsSha256(tool) : null,
      requiredLinks: tool ? apiResearchRequiredLinks(plan, tool) : [],
      handoffSha256: handoff ? digest(handoff) : null,
    };
  };
  return digest({
    target: identity(followUp.toolName),
    followUp,
    siblings: [...followUp.relevantToolNames].sort().map(identity),
  });
}
const refKey = (ref: ContentAddressedRef) => `${ref.path}\u0000${ref.sha256}`;
function checkSeqs(
  values: readonly number[],
  known: ReadonlySet<number>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  values.forEach((seq, index) => {
    if (!known.has(seq)) issue(ctx, [...path, index], `unknown recording seq ${seq}`);
  });
}
function validateCandidates(
  candidates: readonly TeachingCandidateEvidence[],
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  for (const problem of teachingCandidateIssues(candidates, new Set(index.requestSeqs)))
    issue(ctx, [...path, ...problem.path], problem.message);
}
function validateEvidence(
  evidence: PromptEvidenceProjection,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const requests = new Set(index.requestSeqs);
  const events = new Set(index.eventSeqs);
  evidence.payload.entries.forEach((entry, entryIndex) => {
    if (entry.kind !== 'mechanical_fact') return;
    const base = [...path, 'payload', 'entries', entryIndex];
    checkSeqs(entry.requestSeqs, requests, ctx, [...base, 'requestSeqs']);
    checkSeqs(entry.eventSeqs, events, ctx, [...base, 'eventSeqs']);
    validateFactSeqs(entry.facts, requests, ctx, [...base, 'facts']);
  });
}
function validateFactSeqs(
  facts: readonly ReceiptFact[] | undefined,
  requests: ReadonlySet<number>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  facts?.forEach((fact, index) => {
    if (fact.kind === 'request_comparison')
      checkSeqs([fact.recordingSeq], requests, ctx, [...path, index]);
  });
}
function validateDiscovery(input: ToolSelectionAdvisorInput, ctx: z.RefinementCtx): void {
  if (input.run.recordingSha256 !== input.recordingIndex.recordingSha256)
    issue(ctx, ['run'], 'discovery binding does not match the supplied discovery');
  const requests = new Set(input.recordingIndex.requestSeqs);
  checkSeqs(input.detectorSharedContext.loginRequestSeqs, requests, ctx, [
    'detectorSharedContext',
    'loginRequestSeqs',
  ]);
  checkSeqs(input.detectorSharedContext.authRequestSeqs, requests, ctx, [
    'detectorSharedContext',
    'authRequestSeqs',
  ]);
  validateCandidates(input.discoveryCandidates, input.recordingIndex, ctx, ['discoveryCandidates']);
  validateEvidence(input.evidence, input.recordingIndex, ctx, ['evidence']);
}
const ToolInputSchema = ToolSelectionAdvisorInputSchema.superRefine(validateDiscovery);
function toolOutputSchema(input: ToolSelectionAdvisorInput) {
  return ToolSelectionAdvisorOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, input.run)) issue(ctx, ['binding'], 'stale discovery binding');
    validateCandidates(output.boundaries, input.recordingIndex, ctx, ['boundaries']);
  });
}
function focusedPlannerBinding(input: FocusedPlannerInput) {
  return {
    runId: input.run.runId,
    site: input.run.site,
    recordingSha256: input.run.recordingSha256,
    toolId: input.tool.id,
  };
}

function apiResearchBinding(input: ApiResearchInput) {
  return {
    runId: input.run.runId,
    recordingSha256: input.run.recordingSha256,
    toolName: input.tool.candidate.toolName,
    compileInputsSha256: apiResearchInputsSha256(input.tool),
  };
}

function apiResearchPromptTool(input: ApiResearchInput) {
  const { id: _journalId, ...publicTool } = input.tool;
  return publicTool;
}

const ApiResearchInputValidationSchema = ApiResearchInputSchema.superRefine((input, ctx) => {
  if (input.run.recordingSha256 !== input.recordingIndex.recordingSha256)
    issue(ctx, ['run'], 'API research recording binding is stale');
  validateEvidence(input.evidence, input.recordingIndex, ctx, ['evidence']);
  if ((input.researchPhase === 'follow_up') !== Boolean(input.followUp))
    issue(ctx, ['followUp'], 'follow-up research requires exactly one master direction');
  if (Boolean(input.followUp) !== Boolean(input.previousProgress))
    issue(ctx, ['previousProgress'], 'follow-up research requires its exact preceding handoff');
  if (input.previousProgress && input.previousProgress.toolName !== input.tool.candidate.toolName)
    issue(
      ctx,
      ['previousProgress', 'toolName'],
      'previous progress belongs to another public tool',
    );
  if (input.followUp) {
    const knownRequestSeqs = new Set(input.recordingIndex.requestSeqs);
    input.followUp.relevantRequestSeqs.forEach((seq, index) => {
      if (!knownRequestSeqs.has(seq))
        issue(ctx, ['followUp', 'relevantRequestSeqs', index], 'unknown recording request');
    });
    input.followUp.siblingResearch.forEach((handoff, index) => {
      if (handoff.toolName === input.tool.candidate.toolName)
        issue(ctx, ['followUp', 'siblingResearch', index], 'target tool is not a sibling');
    });
  }
  const knownRequestSeqs = new Set(input.recordingIndex.requestSeqs);
  (input.requestCatalog ?? []).forEach((entry, index) => {
    if (!knownRequestSeqs.has(entry.recordingRequestSeq))
      issue(ctx, ['requestCatalog', index, 'recordingRequestSeq'], 'unknown recording request');
  });
  if (input.requestCatalogPage) {
    if ((input.requestCatalog?.length ?? 0) > input.requestCatalogPage.totalEntries)
      issue(ctx, ['requestCatalogPage', 'totalEntries'], 'catalog page exceeds total entries');
    if (
      input.requestCatalogPage.offset + (input.requestCatalog?.length ?? 0) >
      input.requestCatalogPage.totalEntries
    )
      issue(ctx, ['requestCatalogPage'], 'catalog page range exceeds total entries');
    if (
      input.requestCatalogPage.hasMore !==
      input.requestCatalogPage.offset + (input.requestCatalog?.length ?? 0) <
        input.requestCatalogPage.totalEntries
    )
      issue(ctx, ['requestCatalogPage', 'hasMore'], 'catalog continuation flag is inconsistent');
  }
  (input.inspectedRequestSeqs ?? []).forEach((seq, index) => {
    if (!knownRequestSeqs.has(seq))
      issue(ctx, ['inspectedRequestSeqs', index], 'unknown inspected recording request');
  });
  const requiredLinkKeys = new Set<string>();
  (input.requiredLinks ?? []).forEach((link, index) => {
    const key = JSON.stringify(link);
    if (requiredLinkKeys.has(key))
      issue(ctx, ['requiredLinks', index], 'duplicate required producer-consumer link');
    if (link.toolName !== input.tool.candidate.toolName) {
      issue(ctx, ['requiredLinks', index], 'required link does not involve this public tool');
    }
    requiredLinkKeys.add(key);
  });
});

function apiResearchOutputSchema(input: ApiResearchInput) {
  return ApiResearchOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, apiResearchBinding(input)))
      issue(ctx, ['binding'], 'stale API-research binding');
    if (output.action === 'catalog') {
      if (output.candidate) issue(ctx, ['candidate'], 'catalog paging does not test a candidate');
      if (output.basedOnObservationId)
        issue(ctx, ['basedOnObservationId'], 'catalog paging cannot claim a tested candidate');
      if (output.missingProof)
        issue(ctx, ['missingProof'], 'catalog paging does not settle a proof gap');
      if (output.requestedRequestSeqs)
        issue(ctx, ['requestedRequestSeqs'], 'catalog paging does not inspect request bodies');
      if (!input.requestCatalogPage?.hasMore)
        issue(ctx, ['action'], 'the compact request catalog has no next page');
      return;
    }
    if (output.action === 'inspect') {
      if (output.candidate) issue(ctx, ['candidate'], 'inspection does not test a candidate');
      if (output.basedOnObservationId)
        issue(ctx, ['basedOnObservationId'], 'inspection cannot claim a tested candidate');
      if (output.missingProof)
        issue(ctx, ['missingProof'], 'inspection does not settle a proof gap');
      if (!output.requestedRequestSeqs) {
        issue(ctx, ['requestedRequestSeqs'], 'inspection requires exact catalog request seqs');
        return;
      }
      // The retained conversation may refer back to an earlier catalog page.
      // Keep the wire bounded without echoing an ever-growing seen-seq list;
      // the immutable recording index is the complete authorization boundary.
      const recordingSeqs = new Set(input.recordingIndex.requestSeqs);
      output.requestedRequestSeqs.forEach((seq, index) => {
        if (!recordingSeqs.has(seq))
          issue(ctx, ['requestedRequestSeqs', index], 'request is absent from the recording');
      });
      return;
    }
    if (output.requestedRequestSeqs)
      issue(ctx, ['requestedRequestSeqs'], 'only inspection may request recording evidence');
    if (output.action === 'blocked') {
      if (output.candidate)
        issue(ctx, ['candidate'], 'blocked research cannot hand off a candidate');
      if (output.basedOnObservationId)
        issue(ctx, ['basedOnObservationId'], 'blocked research cannot claim a proven observation');
      if (output.missingProof)
        issue(ctx, ['missingProof'], 'blocked research must state its factual blocker in reason');
      return;
    }
    const candidate = output.candidate;
    if (!candidate) {
      issue(ctx, ['candidate'], `${output.action} research requires a complete candidate`);
      return;
    }
    const { workflow, requestTransformSource, parameterValues } = candidate;
    if (workflow.site !== input.run.site)
      issue(ctx, ['candidate', 'workflow', 'site'], 'wrong site');
    if (workflow.toolName !== input.tool.candidate.toolName)
      issue(ctx, ['candidate', 'workflow', 'toolName'], 'wrong public tool name');
    if (workflow.parserModule)
      issue(ctx, ['candidate', 'workflow', 'parserModule'], 'API research must stay parser-free');
    if (Boolean(workflow.requestTransformModule) !== Boolean(requestTransformSource))
      issue(
        ctx,
        ['candidate', 'requestTransformSource'],
        'request transform source and module must be supplied together',
      );
    if (
      workflow.requestTransformModule &&
      workflow.requestTransformModule !== './request-transform.ts'
    )
      issue(
        ctx,
        ['candidate', 'workflow', 'requestTransformModule'],
        'API research transform module must be ./request-transform.ts',
      );
    const expectedParameters = input.tool.candidate.likelyParams
      .map(({ name, type }) => ({ name, type }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const actualParameters = workflow.parameters
      .map(({ name, type }) => ({ name, type }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!same(actualParameters, expectedParameters))
      issue(ctx, ['candidate', 'workflow', 'parameters'], 'workflow parameters changed');
    for (const parameter of workflow.parameters) {
      if (!(parameter.name in parameterValues) && parameter.default === undefined)
        issue(ctx, ['candidate', 'parameterValues', parameter.name], 'missing required test value');
    }
    const knownRequestSeqs = new Set(input.recordingIndex.requestSeqs);
    for (const [index, request] of workflow.requests.entries()) {
      if (
        request.recordingRequestSeq === undefined ||
        !knownRequestSeqs.has(request.recordingRequestSeq)
      ) {
        issue(
          ctx,
          ['candidate', 'workflow', 'requests', index, 'recordingRequestSeq'],
          'API research request is absent from the selected recording',
        );
      }
      const recordingResponseRequestSeq =
        request.navigation?.networkResponse?.recordingResponseRequestSeq;
      if (
        recordingResponseRequestSeq !== undefined &&
        !knownRequestSeqs.has(recordingResponseRequestSeq)
      ) {
        issue(
          ctx,
          [
            'candidate',
            'workflow',
            'requests',
            index,
            'navigation',
            'networkResponse',
            'recordingResponseRequestSeq',
          ],
          'API research response request is absent from the selected recording',
        );
      }
    }
    if (output.action === 'test') {
      if (output.basedOnObservationId)
        issue(ctx, ['basedOnObservationId'], 'a new test cannot claim an older observation');
      if (output.missingProof)
        issue(ctx, ['missingProof'], 'a new test cannot claim a settled proof gap');
      return;
    }
    if (!output.basedOnObservationId) {
      issue(ctx, ['basedOnObservationId'], `${output.action} research must cite its exact test`);
      return;
    }
    const observation = input.observations.find(({ id }) => id === output.basedOnObservationId);
    if (!observation) {
      issue(ctx, ['basedOnObservationId'], 'unknown API-research observation');
      return;
    }
    if (!observation.result.ok)
      issue(
        ctx,
        ['basedOnObservationId'],
        `failed transport observation cannot support ${output.action} research`,
      );
    if (observation.candidateSha256 !== apiResearchCandidateSha256(candidate))
      issue(ctx, ['candidate'], `${output.action} candidate differs from the tested request`);
    if (output.action === 'partial' && !output.missingProof)
      issue(ctx, ['missingProof'], 'partial research requires the exact missing proof');
    if (output.action === 'proven' && output.missingProof)
      issue(ctx, ['missingProof'], 'proven research cannot have missing proof');
  });
}
function validateFocusedPlannerEdges(
  tool: EditableTeachingTool,
  edges: readonly ChainEdge[],
  producers: ReadonlyMap<string, { toolName: string }>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const ids = new Set<string>();
  const tuples = new Set<string>();
  const consumerParameters = new Set<string>();
  edges.forEach((edge, index) => {
    const base = [...path, index];
    if (ids.has(edge.id)) issue(ctx, [...base, 'id'], 'duplicate chain edge id');
    const tuple = digest([
      edge.producerToolId,
      edge.producerResultPath,
      edge.consumerToolId,
      edge.consumerParameter,
    ]);
    if (tuples.has(tuple)) issue(ctx, base, 'duplicate chain edge');
    const producer = producers.get(edge.producerToolId);
    if (!producer) issue(ctx, [...base, 'producerToolId'], 'unknown focused producer tool');
    if (edge.consumerToolId !== tool.id)
      issue(ctx, [...base, 'consumerToolId'], 'focused chain edge belongs to another consumer');
    if (!tool.candidate.likelyParams.some(({ name }) => name === edge.consumerParameter))
      issue(ctx, [...base, 'consumerParameter'], 'unknown focused consumer parameter');
    if (producer && !tool.candidate.dependsOnTools.includes(producer.toolName))
      issue(ctx, base, 'focused chain edge is absent from the proposed tool dependency');
    const consumerParameter = digest([edge.consumerToolId, edge.consumerParameter]);
    if (consumerParameters.has(consumerParameter))
      issue(
        ctx,
        [...base, 'consumerParameter'],
        'focused chain invocation binds this consumer parameter more than once',
      );
    consumerParameters.add(consumerParameter);
    ids.add(edge.id);
    tuples.add(tuple);
  });
}
function validateToolLocalFields(
  tool: EditableTeachingTool,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const knownRequests = new Set(index.requestSeqs);
  for (const field of ['requestSeqs', 'representativeSeqs', 'dependencySeqs'] as const)
    checkSeqs(tool.candidate[field], knownRequests, ctx, [...path, 'candidate', field]);
  const ownedRequests = new Set(tool.candidate.requestSeqs);
  tool.candidate.representativeSeqs.forEach((seq, index) => {
    if (!ownedRequests.has(seq))
      issue(
        ctx,
        [...path, 'candidate', 'representativeSeqs', index],
        `representative seq ${seq} is absent from this candidate's requestSeqs`,
      );
  });
  if (new Set(tool.candidate.dependsOnTools).size !== tool.candidate.dependsOnTools.length)
    issue(ctx, [...path, 'candidate', 'dependsOnTools'], 'duplicate dependency');
  tool.candidate.dependsOnTools.forEach((dependencyName, dependencyIndex) => {
    if (dependencyName === tool.candidate.toolName)
      issue(
        ctx,
        [...path, 'candidate', 'dependsOnTools', dependencyIndex],
        `tool "${tool.candidate.toolName}" cannot depend on itself`,
      );
  });
  const parameterNames = tool.candidate.likelyParams.map(({ name }) => name);
  if (new Set(parameterNames).size !== parameterNames.length)
    issue(ctx, [...path, 'candidate', 'likelyParams'], 'duplicate parameter');
  checkSeqs(tool.compileContext.loginRequestSeqs, knownRequests, ctx, [
    ...path,
    'compileContext',
    'loginRequestSeqs',
  ]);
  checkSeqs(tool.compileContext.authRequestSeqs, knownRequests, ctx, [
    ...path,
    'compileContext',
    'authRequestSeqs',
  ]);
}
function validateFocusedPlannerTool(
  tool: EditableTeachingTool,
  input: FocusedPlannerInput,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  validateToolLocalFields(tool, input.recordingIndex, ctx, path);
}
const FocusedPlannerInputValidationSchema = FocusedPlannerInputSchema.superRefine((input, ctx) => {
  if (input.run.recordingSha256 !== input.recordingIndex.recordingSha256)
    issue(ctx, ['run'], 'focused planner recording binding is stale');
  validateEvidence(input.evidence, input.recordingIndex, ctx, ['evidence']);
  if (input.revisionContext) {
    validateEvidence(input.revisionContext.latestFailureFacts, input.recordingIndex, ctx, [
      'revisionContext',
      'latestFailureFacts',
    ]);
    if (
      input.revisionContext.previousImplementationPlan?.payload.toolId !== undefined &&
      input.revisionContext.previousImplementationPlan.payload.toolId !== input.tool.id
    )
      issue(
        ctx,
        ['revisionContext', 'previousImplementationPlan', 'payload', 'toolId'],
        'previous implementation plan belongs to another tool',
      );
  }
  validateFocusedPlannerTool(input.tool as EditableTeachingTool, input, ctx, ['tool']);
  const producerIds = new Set<string>();
  const producerNames = new Set<string>();
  const producers = new Map<string, { toolName: string }>();
  input.availableProducers.forEach((producer, index) => {
    if (producer.toolId === input.tool.id)
      issue(ctx, ['availableProducers', index, 'toolId'], 'focused tool cannot produce for itself');
    if (producerIds.has(producer.toolId))
      issue(ctx, ['availableProducers', index, 'toolId'], 'duplicate focused producer id');
    if (producerNames.has(producer.toolName))
      issue(ctx, ['availableProducers', index, 'toolName'], 'duplicate focused producer name');
    producerIds.add(producer.toolId);
    producerNames.add(producer.toolName);
    producers.set(producer.toolId, producer);
  });
  input.tool.candidate.dependsOnTools.forEach((toolName, index) => {
    if (!producerNames.has(toolName))
      issue(ctx, ['tool', 'candidate', 'dependsOnTools', index], 'unknown focused dependency tool');
  });
  validateFocusedPlannerEdges(
    input.tool as EditableTeachingTool,
    input.incomingChainEdges,
    producers,
    ctx,
    ['incomingChainEdges'],
  );
  input.outgoingChainEdges.forEach((edge, index) => {
    if (edge.producerToolId !== input.tool.id)
      issue(ctx, ['outgoingChainEdges', index], 'outgoing edge belongs to another producer');
  });
});
function focusedPlannerOutputSchema(input: FocusedPlannerInput) {
  return FocusedPlannerOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, focusedPlannerBinding(input)))
      issue(ctx, ['binding'], 'stale focused-planner binding');
    if (output.tool.id !== input.tool.id)
      issue(ctx, ['tool', 'id'], 'focused planner cannot replace the stable tool id');
    if (!same(output.tool.evidenceRefs, input.tool.evidenceRefs))
      issue(ctx, ['tool', 'evidenceRefs'], 'focused planner cannot change supplied evidence refs');
    validateFocusedPlannerTool(output.tool, input, ctx, ['tool']);
    const producers = new Map(
      input.availableProducers.map((producer) => [producer.toolId, producer]),
    );
    output.tool.candidate.dependsOnTools.forEach((toolName, index) => {
      if (![...producers.values()].some((producer) => producer.toolName === toolName))
        issue(
          ctx,
          ['tool', 'candidate', 'dependsOnTools', index],
          'unknown focused dependency tool',
        );
    });
    validateFocusedPlannerEdges(output.tool, output.chainEdges, producers, ctx, ['chainEdges']);
    try {
      validateImplementationPlanForTool(
        output.implementationPlan,
        output.tool,
        new Set(input.recordingIndex.requestSeqs),
      );
    } catch (error) {
      issue(ctx, ['implementationPlan'], error instanceof Error ? error.message : String(error));
    }
  });
}
function validatePlan(
  plan: DesiredTeachingPlan,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  discoveryCandidateNames?: readonly string[],
): void {
  for (const problem of teachingCandidateIssues(
    plan.tools.map(({ candidate }) => candidate),
    new Set(index.requestSeqs),
  )) {
    const [toolIndex, ...candidatePath] = problem.path;
    issue(
      ctx,
      typeof toolIndex === 'number'
        ? [...path, 'tools', toolIndex, 'candidate', ...candidatePath]
        : [...path, 'tools', ...problem.path],
      problem.message,
    );
  }
  try {
    validateDesiredTeachingPlan(
      {
        site: plan.site,
        recordingSha256: plan.recordingSha256,
        tools: plan.tools,
        candidateCoverage: plan.candidateCoverage,
        buildWaves: plan.buildWaves,
        chainEdges: plan.chainEdges,
      },
      {
        site: plan.site,
        recordingSha256: plan.recordingSha256,
        requestSeqs: new Set(index.requestSeqs),
        eventSeqs: new Set(index.eventSeqs),
        discoveryCandidateNames,
      },
    );
  } catch (error) {
    issue(ctx, path, error instanceof Error ? error.message : String(error));
  }
}
function validateCurrent(
  run: CurrentPlanBinding,
  plan: CurrentPlanProjection,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (
    run.planRevision !== plan.payload.revision ||
    run.planSha256 !== plan.ref.sha256 ||
    run.site !== plan.payload.site ||
    run.recordingSha256 !== plan.payload.recordingSha256 ||
    run.recordingSha256 !== index.recordingSha256
  )
    issue(ctx, path, 'current plan binding is stale');
  validatePlan(plan.payload, index, ctx, [...path, 'payload']);
}
type ExecutionToolProof = CurrentExecutionSnapshot['payload']['tools'][number];
function expectedChainDependencies(
  plan: Pick<DesiredTeachingPlan, 'chainEdges'>,
  edge: ChainEdge,
  proofs: ReadonlyMap<string, ExecutionToolProof>,
): ExecutionToolProof['receipts'][number]['dependencyBuilds'] | undefined {
  const dependencies: ExecutionToolProof['receipts'][number]['dependencyBuilds'] = [];
  const producerIds = [
    ...new Set(
      chainInvocationForEdge(plan.chainEdges, edge).edges.map(
        ({ producerToolId }) => producerToolId,
      ),
    ),
  ].sort();
  for (const producerToolId of producerIds) {
    const producer = proofs.get(producerToolId);
    const producerLive = producer?.receipts.find(
      ({ check, status }) => check === 'live' && status === 'passed',
    );
    if (!producer || !producerLive) return undefined;
    dependencies.push({
      toolId: producer.toolId,
      buildRef: producer.currentBuildRef,
      executionBindingSha256: producer.executionBindingSha256,
      resultReceiptRef: producerLive.ref,
    });
  }
  return dependencies.length > 0 ? dependencies : undefined;
}
function validateSnapshot(
  snapshot: CurrentExecutionSnapshot,
  run: CurrentPlanBinding,
  planProjection: CurrentPlanProjection,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const plan = planProjection.payload;
  if (
    !same(snapshot.payload.run, {
      runId: run.runId,
      site: run.site,
      recordingSha256: run.recordingSha256,
    }) ||
    !same(snapshot.payload.currentPlanRef, planProjection.ref)
  )
    issue(ctx, path, 'current execution snapshot is stale');
  const planned = new Map(plan.tools.map((tool) => [tool.id, tool]));
  const proofs = new Map(snapshot.payload.tools.map((proof) => [proof.toolId, proof]));
  const requestSeqs = new Set(index.requestSeqs);
  snapshot.payload.tools.forEach((proof, proofIndex) => {
    const tool = planned.get(proof.toolId);
    const base = [...path, 'payload', 'tools', proofIndex];
    if (!tool) return issue(ctx, base, 'stray execution proof');
    const binding = proof.executionBinding;
    checkSeqs(
      binding.requestProvenance.flatMap(({ recordingRequestSeq, recordingResponseRequestSeq }) => [
        recordingRequestSeq,
        ...(recordingResponseRequestSeq === undefined ? [] : [recordingResponseRequestSeq]),
      ]),
      requestSeqs,
      ctx,
      [...base, 'executionBinding', 'requestProvenance'],
    );
    if (
      !tool.strategy ||
      !tool.implementationPlan ||
      binding.compileInputsSha256 !== teachingToolCompileInputsSha256(tool, plan.chainEdges) ||
      binding.strategyKind !== tool.strategy.kind ||
      !same(binding.implementationPlan, tool.implementationPlan)
    )
      issue(ctx, base, 'execution proof does not match exact tool compile inputs');
    proof.receipts.forEach((receipt, receiptIndex) => {
      validateFactSeqs(
        receipt.facts,
        requestSeqs,
        ctx,
        base.concat('receipts', receiptIndex, 'facts'),
      );
      if (receipt.check !== 'chain') return;
      const edge = plan.chainEdges.find(({ id }) => id === receipt.chainEdgeId);
      if (!edge || edge.consumerToolId !== tool.id)
        return issue(ctx, [...base, 'receipts', receiptIndex], 'unknown current chain edge');
      if (receipt.chainEdgeSha256 !== digest(edge))
        issue(ctx, [...base, 'receipts', receiptIndex], 'chain receipt has stale edge content');
      const expected = expectedChainDependencies(plan, edge, proofs);
      if (!expected)
        return issue(
          ctx,
          [...base, 'receipts', receiptIndex],
          'chain receipt has no current passed producer live result',
        );
      if (!same(receipt.dependencyBuilds, expected))
        issue(ctx, [...base, 'receipts', receiptIndex], 'chain receipt has stale producer result');
    });
  });
}
/** Mechanical proof gate: strategy selects checks; persisted chain edges select chain checks. */
export function mechanicalProofFailures(
  plan: DesiredTeachingPlan,
  snapshot: CurrentExecutionSnapshot,
  targetToolId?: string,
): string[] {
  const proofs = new Map(snapshot.payload.tools.map((proof) => [proof.toolId, proof]));
  const tools = targetToolId ? plan.tools.filter(({ id }) => id === targetToolId) : plan.tools;
  const failures: string[] = [];
  if (!targetToolId && tools.length === 0) failures.push('plan: completion requires a tool');
  if (!targetToolId) {
    for (const coverage of unresolvedCandidateCoverage(plan)) {
      failures.push(
        `candidate ${coverage.discoveryCandidateName}: unresolved discovery candidate cannot complete`,
      );
    }
  }
  for (const tool of tools) {
    const proof = proofs.get(tool.id);
    if (!tool.strategy || !proof) {
      failures.push(`${tool.id}: missing current execution proof`);
      continue;
    }
    for (const [check, status] of [
      ['contract', 'passed'],
      ['live', 'passed'],
    ] as const) {
      if (!proof.receipts.some((receipt) => receipt.check === check && receipt.status === status))
        failures.push(`${tool.id}: ${check} must be ${status}`);
    }
    for (const edge of plan.chainEdges.filter(({ consumerToolId }) => consumerToolId === tool.id)) {
      const expectedDependencies = expectedChainDependencies(plan, edge, proofs);
      if (
        !expectedDependencies ||
        !proof.receipts.some(
          (receipt) =>
            receipt.check === 'chain' &&
            receipt.chainEdgeId === edge.id &&
            receipt.chainEdgeSha256 === digest(edge) &&
            same(receipt.dependencyBuilds, expectedDependencies) &&
            receipt.status === 'passed',
        )
      )
        failures.push(`${tool.id}: chain ${edge.id} must be passed`);
    }
  }
  return failures;
}
function masterDecisionBinding(input: MasterDecisionInput) {
  return input.current?.run ?? input.discovery.run;
}
function withoutStaleImplementationPlan(
  tool: EditableTeachingTool,
  chainEdges: readonly ChainEdge[],
): EditableTeachingTool {
  if (
    !tool.implementationPlan ||
    tool.implementationPlan.basedOnCompileInputsSha256 ===
      teachingToolCompileInputsSha256(tool, chainEdges)
  ) {
    return tool;
  }
  const { implementationPlan: _stale, ...unplannedTool } = tool;
  return unplannedTool;
}
function completionBinding(input: CompletionReviewInput) {
  return input.run;
}
function baselineMvpBinding(input: BaselineMvpReviewInput) {
  const proof = input.snapshot.payload.tools.find(({ toolId }) => toolId === input.toolId);
  const resultReceipt = proof?.receipts.find(
    ({ ref }) => refKey(ref) === refKey(input.resultEvidence.payload.resultReceiptRef),
  );
  if (!proof || !resultReceipt) return undefined;
  return {
    ...input.run,
    toolId: input.toolId,
    compileInputsSha256: proof.executionBinding.compileInputsSha256,
    currentBuildRef: proof.currentBuildRef,
    executionBindingSha256: proof.executionBindingSha256,
    resultReceiptRef: resultReceipt.ref,
    resultEvidenceRef: input.resultEvidence.ref,
  };
}
function parameterBinding(input: ParameterSelectionAdvisorInput) {
  const proof = input.snapshot.payload.tools.find(({ toolId }) => toolId === input.toolId);
  const tool = input.currentPlan.payload.tools.find(({ id }) => id === input.toolId);
  if (!proof || !tool) return undefined;
  return {
    runId: input.run.runId,
    recordingSha256: input.run.recordingSha256,
    toolId: input.toolId,
    compileInputsSha256: teachingToolCompileInputsSha256(
      tool,
      input.currentPlan.payload.chainEdges,
    ),
  };
}
const ParameterInputSchema = ParameterSelectionAdvisorInputSchema.superRefine((input, ctx) => {
  validateCurrent(input.run, input.currentPlan, input.recordingIndex, ctx, ['currentPlan']);
  validateSnapshot(input.snapshot, input.run, input.currentPlan, input.recordingIndex, ctx, [
    'snapshot',
  ]);
  validateEvidence(input.evidence, input.recordingIndex, ctx, ['evidence']);
  if (!input.currentPlan.payload.tools.some(({ id }) => id === input.toolId))
    issue(ctx, ['toolId'], 'unknown current tool');
  for (const failure of mechanicalProofFailures(
    input.currentPlan.payload,
    input.snapshot,
    input.toolId,
  ))
    issue(ctx, ['snapshot'], failure);
});
const BaselineMvpInputSchema = BaselineMvpReviewInputSchema.superRefine((input, ctx) => {
  validateCurrent(input.run, input.currentPlan, input.recordingIndex, ctx, ['currentPlan']);
  validateSnapshot(input.snapshot, input.run, input.currentPlan, input.recordingIndex, ctx, [
    'snapshot',
  ]);
  const tool = input.currentPlan.payload.tools.find(({ id }) => id === input.toolId);
  const proof = input.snapshot.payload.tools.find(({ toolId }) => toolId === input.toolId);
  if (!tool) {
    issue(ctx, ['toolId'], 'unknown current tool');
    return;
  }
  if (!proof) {
    issue(ctx, ['snapshot'], 'missing current execution proof');
    return;
  }
  for (const check of ['contract', 'live'] as const) {
    if (!proof.receipts.some((receipt) => receipt.check === check && receipt.status === 'passed')) {
      issue(ctx, ['snapshot'], `${tool.id}: ${check} must be passed`);
    }
  }
  const result = input.resultEvidence.payload;
  if (result.toolId !== tool.id)
    issue(ctx, ['resultEvidence', 'payload', 'toolId'], 'result evidence belongs to another tool');
  if (result.toolName !== tool.candidate.toolName)
    issue(ctx, ['resultEvidence', 'payload', 'toolName'], 'result evidence tool name is stale');
  if (!tool.implementationPlan || !same(result.implementationPlanRef, tool.implementationPlan))
    issue(
      ctx,
      ['resultEvidence', 'payload', 'implementationPlanRef'],
      'result evidence belongs to another implementation plan',
    );
  const resultReceipt = proof.receipts.find(
    ({ ref }) => refKey(ref) === refKey(result.resultReceiptRef),
  );
  if (
    !resultReceipt ||
    !['live', 'chain'].includes(resultReceipt.check) ||
    resultReceipt.status !== 'passed'
  )
    issue(ctx, ['snapshot'], 'baseline MVP review requires a passed current result receipt');
  else if (!same(result.resultReceiptRef, resultReceipt.ref))
    issue(
      ctx,
      ['resultEvidence', 'payload', 'resultReceiptRef'],
      'result evidence cites another result receipt',
    );
  if (
    resultReceipt &&
    ((resultReceipt.check === 'chain' && result.chainEdgeId !== resultReceipt.chainEdgeId) ||
      (resultReceipt.check === 'live' && result.chainEdgeId !== undefined))
  ) {
    issue(ctx, ['resultEvidence', 'payload', 'chainEdgeId'], 'result edge context is stale');
  }
  if (!result.actualResult.observed)
    issue(
      ctx,
      ['resultEvidence', 'payload', 'actualResult', 'observed'],
      'live result was not observed',
    );
});
function baselineMvpOutputSchema(input: BaselineMvpReviewInput) {
  return BaselineMvpReviewOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, baselineMvpBinding(input)))
      issue(ctx, ['binding'], 'stale baseline-MVP binding');
    const resultReceipt = input.snapshot.payload.tools
      .find(({ toolId }) => toolId === input.toolId)
      ?.receipts.find(
        ({ ref }) => refKey(ref) === refKey(input.resultEvidence.payload.resultReceiptRef),
      );
    const authorized = new Set(
      [input.resultEvidence.ref, ...(resultReceipt ? [resultReceipt.ref] : [])].map(refKey),
    );
    const cited = new Set(output.evidenceRefs.map(refKey));
    if (!cited.has(refKey(input.resultEvidence.ref)))
      issue(ctx, ['evidenceRefs'], 'baseline MVP review must cite the supplied result evidence');
    output.evidenceRefs.forEach((ref, index) => {
      if (!authorized.has(refKey(ref)))
        issue(ctx, ['evidenceRefs', index], 'baseline MVP review cites unsupplied evidence');
    });
    if (cited.size !== output.evidenceRefs.length)
      issue(ctx, ['evidenceRefs'], 'duplicate evidence citation');
  });
}
function parameterOutputSchema(input: ParameterSelectionAdvisorInput) {
  return ParameterSelectionAdvisorOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, parameterBinding(input)))
      issue(ctx, ['binding'], 'stale parameter-advice binding');
    const supplied = new Set(input.evidence.payload.entries.map(({ ref }) => refKey(ref)));
    const cited = new Set<string>();
    output.evidenceRefs.forEach((ref, index) => {
      const key = refKey(ref);
      if (!supplied.has(key))
        issue(ctx, ['evidenceRefs', index], 'parameter advice cites unsupplied evidence');
      if (cited.has(key)) issue(ctx, ['evidenceRefs', index], 'duplicate evidence citation');
      cited.add(key);
    });
  });
}
function toolAdvisorPromptInput(input: ToolSelectionAdvisorInput) {
  return ToolSelectionAdvisorPromptInputSchema.parse({
    run: input.run,
    recordingIndex: input.recordingIndex,
    discoveryCandidates: input.discoveryCandidates.map(
      ({ likelyParams: _likelyParams, ...candidate }) => candidate,
    ),
    evidence: input.evidence,
  });
}
function parameterAdvisorPromptInput(input: ParameterSelectionAdvisorInput) {
  const targetTool = input.currentPlan.payload.tools.find(({ id }) => id === input.toolId);
  const targetProof = input.snapshot.payload.tools.find(({ toolId }) => toolId === input.toolId);
  if (!targetTool || !targetProof) throw new Error('validated parameter target is unavailable');
  const incomingChainEdges = input.currentPlan.payload.chainEdges.filter(
    ({ consumerToolId }) => consumerToolId === input.toolId,
  );
  const producerIds = [...new Set(incomingChainEdges.map(({ producerToolId }) => producerToolId))];
  const producers = producerIds.map((toolId) => {
    const tool = input.currentPlan.payload.tools.find(({ id }) => id === toolId);
    const proof = input.snapshot.payload.tools.find((value) => value.toolId === toolId);
    if (!tool || !proof) throw new Error(`validated producer "${toolId}" is unavailable`);
    return { toolId, toolName: tool.candidate.toolName, proof };
  });
  return ParameterSelectionAdvisorPromptInputSchema.parse({
    run: input.run,
    targetTool,
    targetProof,
    incomingChainEdges,
    producers,
    evidence: input.evidence,
  });
}
function baselineMvpReviewerPromptInput(input: BaselineMvpReviewInput) {
  const tool = input.currentPlan.payload.tools.find(({ id }) => id === input.toolId);
  const binding = baselineMvpBinding(input);
  if (!tool || !binding) throw new Error('validated baseline MVP target is unavailable');
  const chainEdgeId = input.resultEvidence.payload.chainEdgeId;
  const chainEdge = chainEdgeId
    ? input.currentPlan.payload.chainEdges.find(({ id }) => id === chainEdgeId)
    : undefined;
  if (chainEdgeId && !chainEdge)
    throw new Error('validated baseline MVP chain invocation is unavailable');
  return BaselineMvpReviewerPromptInputSchema.parse({
    binding,
    intendedOperation: {
      toolName: tool.candidate.toolName,
      description: tool.candidate.description,
      expectedOutput: tool.candidate.expectedOutput,
    },
    baseline: {
      verificationCaseId: input.resultEvidence.payload.verificationCaseId,
      expectedResult: input.resultEvidence.payload.expectedResult,
      actualResult: input.resultEvidence.payload.actualResult,
      resultEvidenceRef: input.resultEvidence.ref,
      resultReceiptRef: input.resultEvidence.payload.resultReceiptRef,
      ...(chainEdge
        ? {
            chainEdgeId: chainEdge.id,
            chainInvocationEdgeIds: chainInvocationForEdge(
              input.currentPlan.payload.chainEdges,
              chainEdge,
            ).edges.map(({ id }) => id),
          }
        : {}),
    },
  });
}

function evidenceCoverage(
  evidence: PromptEvidenceProjection,
  citedRefs: readonly ContentAddressedRef[],
) {
  const entryCounts = new Map<string, number>();
  const cited = new Set(citedRefs.map(refKey));
  const citedEntries: PromptEvidenceProjection['payload']['entries'] = [];
  let omissions: unknown = null;
  for (const entry of evidence.payload.entries) {
    const key =
      entry.kind === 'mechanical_fact'
        ? 'mechanical_fact'
        : `untrusted_redacted_quote:${entry.provenance}`;
    entryCounts.set(key, (entryCounts.get(key) ?? 0) + 1);
    if (cited.has(refKey(entry.ref))) citedEntries.push(entry);
    if (entry.kind !== 'untrusted_redacted_quote') continue;
    try {
      const value = JSON.parse(entry.quote) as { kind?: unknown };
      if (value.kind === 'prompt_evidence_omissions') omissions = value;
    } catch {
      // Quotes may be bounded previews. Only the host-authored omissions entry
      // is expected to be complete JSON.
    }
  }
  return {
    ref: evidence.ref,
    entryCounts: [...entryCounts].map(([kind, count]) => ({ kind, count })),
    omissions,
    citedEntries,
  };
}

const MASTER_DECISION_INPUT_CHARACTER_BUDGET = 900_000;

function masterDecisionPromptInput(input: MasterDecisionInput) {
  if (JSON.stringify(input).length > MASTER_DECISION_INPUT_CHARACTER_BUDGET)
    throw new Error('master decision core input exceeds the provider-safe character budget');
  return input;
}

/** The Codex master is one retained conversation. The first turn establishes
 * discovery; later turns carry only what changed. Host validation continues to
 * use the complete MasterDecisionInput and is intentionally not weakened. */
function masterDecisionConversationInput(input: MasterDecisionInput) {
  if (input.phase === 'discovery') {
    return {
      phase: input.phase,
      ...(input.userGuidance ? { userGuidance: input.userGuidance } : {}),
      run: input.discovery.run,
      discovery: {
        detectorSharedContext: input.discovery.detectorSharedContext,
        discoveryCandidates: input.discovery.discoveryCandidates,
        evidenceSummary: evidenceCoverage(input.discovery.evidence, []),
      },
      toolSelectionAdvice: input.toolSelectionAdvice,
    };
  }
  return {
    phase: input.phase,
    ...(input.decisionPurpose ? { decisionPurpose: input.decisionPurpose } : {}),
    ...(input.userGuidance ? { userGuidance: input.userGuidance } : {}),
    current: input.current
      ? {
          run: input.current.run,
          // The retained master must see the plan the host actually accepted.
          // A ref alone can leave its remembered plan stale after host-side
          // canonicalization or mechanical invalidation.
          plan: input.current.plan,
        }
      : undefined,
    ...(input.plannerProposals.length ? { plannerProposals: input.plannerProposals } : {}),
    ...(input.apiResearch?.length ? { apiResearch: input.apiResearch } : {}),
    ...(input.researchNoProgress?.length ? { researchNoProgress: input.researchNoProgress } : {}),
    ...(input.verificationFindings ? { verificationFindings: input.verificationFindings } : {}),
  };
}
const MasterInputSchema = MasterDecisionInputSchema.superRefine((input, ctx) => {
  validateDiscovery(input.discovery, ctx);
  if (input.decisionPurpose === 'research_review') {
    if (input.phase !== 'revision')
      issue(ctx, ['decisionPurpose'], 'research review requires the current selected plan');
    if (input.plannerProposals.length > 0)
      issue(ctx, ['plannerProposals'], 'research review happens before focused planning');
    if (input.apiResearch.length === 0 && (input.current?.plan.payload.tools.length ?? 0) > 0)
      issue(ctx, ['apiResearch'], 'research review requires the selected-operation handoffs');
  }
  if (input.researchNoProgress?.length && input.decisionPurpose !== 'research_review') {
    issue(ctx, ['researchNoProgress'], 'research no-progress facts belong to research review');
  }
  const noProgressNames = new Set<string>();
  input.researchNoProgress?.forEach((notice, index) => {
    if (noProgressNames.has(notice.toolName)) {
      issue(ctx, ['researchNoProgress', index, 'toolName'], 'duplicate no-progress target');
    }
    const handoff = input.apiResearch.find(({ toolName }) => toolName === notice.toolName);
    if (!handoff || handoff.status !== 'partial') {
      issue(
        ctx,
        ['researchNoProgress', index, 'toolName'],
        'no-progress fact requires the current partial handoff',
      );
    } else if (digest(handoff) !== notice.partialHandoffSha256) {
      issue(
        ctx,
        ['researchNoProgress', index, 'partialHandoffSha256'],
        'no-progress fact belongs to an older partial handoff',
      );
    }
    noProgressNames.add(notice.toolName);
  });
  if (input.toolSelectionAdvice) {
    if (!same(input.toolSelectionAdvice.binding, input.discovery.run))
      issue(ctx, ['toolSelectionAdvice', 'binding'], 'stale tool advice');
    validateCandidates(input.toolSelectionAdvice.boundaries, input.discovery.recordingIndex, ctx, [
      'toolSelectionAdvice',
      'boundaries',
    ]);
  }
  if (input.current) {
    if (
      input.current.run.runId !== input.discovery.run.runId ||
      input.current.run.site !== input.discovery.run.site ||
      input.current.run.recordingSha256 !== input.discovery.run.recordingSha256
    )
      issue(ctx, ['current', 'run'], 'current plan and discovery belong to different runs');
    validateCurrent(input.current.run, input.current.plan, input.discovery.recordingIndex, ctx, [
      'current',
    ]);
    if (input.current.snapshot)
      validateSnapshot(
        input.current.snapshot,
        input.current.run,
        input.current.plan,
        input.discovery.recordingIndex,
        ctx,
        ['current', 'snapshot'],
      );
  }
  const proposalIds = new Set<string>();
  // Every focused planner was shown the current plan, not its concurrently
  // running siblings' replies. Validate names against that authored view so a
  // sibling rename remains advice for the master to arbitrate.
  const authoredTools =
    input.current?.plan.payload.tools ?? input.plannerProposals.map(({ payload }) => payload.tool);
  const authoredToolsById = new Map(authoredTools.map((tool) => [tool.id, tool]));
  const authoredToolsByName = new Map(authoredTools.map((tool) => [tool.candidate.toolName, tool]));
  const proposedConsumerIds = new Set(input.plannerProposals.map(({ payload }) => payload.tool.id));
  const proposalEdges = input.plannerProposals.flatMap(({ payload }) => payload.chainEdges);
  const effectiveProposalEdges = [
    ...(input.current?.plan.payload.chainEdges ?? []).filter(
      ({ consumerToolId }) => !proposedConsumerIds.has(consumerToolId),
    ),
    ...proposalEdges,
  ];
  input.plannerProposals.forEach((proposal, index) => {
    const { binding, tool, chainEdges, implementationPlan } = proposal.payload;
    const toolPath: Array<string | number> = ['plannerProposals', index, 'payload', 'tool'];
    // The focused reply proposes only its incoming edges, so the host assembles
    // the full current edge set before validating the proposal. Edge-only
    // wiring changes retain compiled artifacts and are proved by fresh chain
    // receipts; the tool's own request and parameter contract remains hashed.
    const compileInputsSha256 = teachingToolCompileInputsSha256(tool, effectiveProposalEdges);
    if (proposalIds.has(tool.id))
      issue(ctx, ['plannerProposals', index], 'duplicate proposal tool');
    if (input.current && !authoredToolsById.has(tool.id))
      issue(ctx, toolPath, 'proposal tool is absent from the current plan');
    validateToolLocalFields(tool, input.discovery.recordingIndex, ctx, toolPath);
    if (
      binding.runId !== input.discovery.run.runId ||
      binding.site !== input.discovery.run.site ||
      binding.recordingSha256 !== input.discovery.run.recordingSha256 ||
      binding.toolId !== tool.id ||
      binding.compileInputsSha256 !== compileInputsSha256
    )
      issue(ctx, ['plannerProposals', index, 'payload', 'binding'], 'stale planner proposal');
    const edgeIds = new Set<string>();
    const edgeTuples = new Set<string>();
    const consumerParameters = new Set<string>();
    chainEdges.forEach((edge, edgeIndex) => {
      const edgePath: Array<string | number> = [
        'plannerProposals',
        index,
        'payload',
        'chainEdges',
        edgeIndex,
      ];
      if (edge.consumerToolId !== tool.id)
        issue(
          ctx,
          [...edgePath, 'consumerToolId'],
          'proposal chain edges must target the proposed tool',
        );
      if (edgeIds.has(edge.id)) issue(ctx, [...edgePath, 'id'], 'duplicate proposal chain edge id');
      const tuple = digest([
        edge.producerToolId,
        edge.producerResultPath,
        edge.consumerToolId,
        edge.consumerParameter,
      ]);
      if (edgeTuples.has(tuple)) issue(ctx, edgePath, 'duplicate proposal chain edge');
      const producer = authoredToolsById.get(edge.producerToolId);
      if (!producer) issue(ctx, [...edgePath, 'producerToolId'], 'unknown proposal producer tool');
      if (!tool.candidate.likelyParams.some(({ name }) => name === edge.consumerParameter))
        issue(ctx, [...edgePath, 'consumerParameter'], 'unknown proposal consumer parameter');
      if (producer && !tool.candidate.dependsOnTools.includes(producer.candidate.toolName))
        issue(ctx, edgePath, 'proposal edge is absent from the proposed tool dependency');
      const consumerParameter = digest([edge.consumerToolId, edge.consumerParameter]);
      if (consumerParameters.has(consumerParameter))
        issue(
          ctx,
          [...edgePath, 'consumerParameter'],
          'proposal chain invocation binds this consumer parameter more than once',
        );
      consumerParameters.add(consumerParameter);
      edgeIds.add(edge.id);
      edgeTuples.add(tuple);
    });
    for (const dependencyName of tool.candidate.dependsOnTools) {
      const dependency = authoredToolsByName.get(dependencyName);
      if (!dependency)
        issue(
          ctx,
          [...toolPath, 'candidate', 'dependsOnTools'],
          `unknown proposal dependency tool "${dependencyName}"`,
        );
      else if (dependency.id === tool.id)
        issue(
          ctx,
          [...toolPath, 'candidate', 'dependsOnTools'],
          `tool "${tool.candidate.toolName}" cannot depend on itself`,
        );
    }
    if (
      !tool.implementationPlan ||
      !same(tool.implementationPlan, implementationPlan.ref) ||
      implementationPlan.ref.basedOnCompileInputsSha256 !== compileInputsSha256
    )
      issue(
        ctx,
        ['plannerProposals', index, 'payload', 'implementationPlan'],
        'hosted implementation plan does not bind the proposed compile inputs',
      );
    try {
      validateImplementationPlanForTool(
        implementationPlan.payload,
        tool,
        new Set(input.discovery.recordingIndex.requestSeqs),
      );
    } catch (error) {
      issue(
        ctx,
        ['plannerProposals', index, 'payload', 'implementationPlan', 'payload'],
        error instanceof Error ? error.message : String(error),
      );
    }
    proposalIds.add(tool.id);
  });
  if (input.verificationFindings)
    validateEvidence(input.verificationFindings, input.discovery.recordingIndex, ctx, [
      'verificationFindings',
    ]);
});
function masterOutputSchema(input: MasterDecisionInput) {
  const currentPlanByToolId = new Map(
    (input.current?.plan.payload.tools ?? []).map((tool) => [tool.id, tool] as const),
  );
  const suppliedPlanRefs = [
    ...(input.current?.plan.payload.tools ?? []),
    ...input.plannerProposals.map(({ payload }) => payload.tool),
  ].flatMap(({ implementationPlan }) => (implementationPlan ? [implementationPlan] : []));
  const suppliedPlans = new Set(suppliedPlanRefs.map(digest));
  const selectionKey = (plan: (typeof suppliedPlanRefs)[number]): string =>
    digest({
      path: plan.path,
      sha256: plan.sha256,
      basedOnCompileInputsSha256: plan.basedOnCompileInputsSha256,
      requestProvenanceSha256: plan.requestProvenanceSha256,
    });
  const canonicalPlanBySelection = new Map(
    suppliedPlanRefs.map((plan) => [selectionKey(plan), plan] as const),
  );
  return MasterDecisionOutputSchema.transform((output) => {
    const tools = output.desiredPlan.tools.map((tool): EditableTeachingTool => {
      const selectedPlan =
        tool.implementationPlan ?? currentPlanByToolId.get(tool.id)?.implementationPlan;
      if (!selectedPlan) return tool;
      const canonicalPlan = canonicalPlanBySelection.get(selectionKey(selectedPlan));
      if (!canonicalPlan) return tool;
      // A revision may change compile inputs while accidentally echoing the
      // old hosted plan. Invalidate that mechanically unusable plan and let a
      // retained focused planner rebuild it instead of rejecting the revision.
      // Host-derived metadata is restored from the supplied reference so the
      // master only has to select the stable content-addressed identity.
      return withoutStaleImplementationPlan(
        { ...tool, implementationPlan: canonicalPlan },
        output.desiredPlan.chainEdges,
      );
    });
    return {
      ...output,
      desiredPlan: {
        ...output.desiredPlan,
        tools,
      },
    };
  }).superRefine((output, ctx) => {
    if (!same(output.binding, masterDecisionBinding(input)))
      issue(ctx, ['binding'], 'stale master binding');
    if (
      output.desiredPlan.site !== input.discovery.run.site ||
      output.desiredPlan.recordingSha256 !== input.discovery.run.recordingSha256
    )
      issue(ctx, ['desiredPlan'], 'desired plan belongs to another recording');
    if (new Set(output.recallToolNames).size !== output.recallToolNames.length)
      issue(ctx, ['recallToolNames'], 'duplicate public tool name');
    if (input.phase === 'discovery' && output.recallToolNames.length > 0)
      issue(ctx, ['recallToolNames'], 'initial discovery cannot recall an existing tool');
    const researchFollowUps = output.researchFollowUps ?? [];
    if (researchFollowUps.length > 0 && input.decisionPurpose !== 'research_review')
      issue(ctx, ['researchFollowUps'], 'research follow-ups belong to pre-planning review');
    if (input.decisionPurpose === 'research_review' && output.recallToolNames.length > 0)
      issue(ctx, ['recallToolNames'], 'research review directs researchers, not compilers');
    const currentToolNames = new Set(
      input.current?.plan.payload.tools.map(({ candidate }) => candidate.toolName) ?? [],
    );
    const desiredToolNames = new Set(
      output.desiredPlan.tools.map(({ candidate }) => candidate.toolName),
    );
    output.desiredPlan.tools.forEach((tool, index) => {
      if (tool.id !== tool.candidate.toolName) {
        issue(
          ctx,
          ['desiredPlan', 'tools', index, 'id'],
          'tool id must equal the public candidate.toolName; there is no agent-facing internal ID',
        );
      }
    });
    const suppliedResearch = input.apiResearch ?? [];
    const canonicalSuppliedResearch = suppliedResearch.map((handoff) =>
      ApiResearchHandoffSchema.parse(handoff),
    );
    const suppliedResearchNames = new Set(suppliedResearch.map(({ toolName }) => toolName));
    const noProgressNames = new Set(
      (input.researchNoProgress ?? []).map(({ toolName }) => toolName),
    );
    const knownRequestSeqs = new Set(input.discovery.recordingIndex.requestSeqs);
    const directedNames = new Set<string>();
    researchFollowUps.forEach((followUp, index) => {
      if (directedNames.has(followUp.toolName))
        issue(ctx, ['researchFollowUps', index, 'toolName'], 'duplicate research target');
      if (!desiredToolNames.has(followUp.toolName))
        issue(
          ctx,
          ['researchFollowUps', index, 'toolName'],
          'research target is absent from desired plan',
        );
      if (!suppliedResearchNames.has(followUp.toolName))
        issue(
          ctx,
          ['researchFollowUps', index, 'toolName'],
          'research target has no first-pass handoff',
        );
      followUp.relevantToolNames.forEach((toolName, toolIndex) => {
        if (toolName === followUp.toolName)
          issue(
            ctx,
            ['researchFollowUps', index, 'relevantToolNames', toolIndex],
            'target is not a sibling',
          );
        if (!suppliedResearchNames.has(toolName))
          issue(
            ctx,
            ['researchFollowUps', index, 'relevantToolNames', toolIndex],
            'unknown sibling research',
          );
        if (!desiredToolNames.has(toolName))
          issue(
            ctx,
            ['researchFollowUps', index, 'relevantToolNames', toolIndex],
            'sibling research target is absent from desired plan',
          );
      });
      followUp.relevantRequestSeqs.forEach((seq, seqIndex) => {
        if (!knownRequestSeqs.has(seq))
          issue(
            ctx,
            ['researchFollowUps', index, 'relevantRequestSeqs', seqIndex],
            'unknown recording request',
          );
      });
      directedNames.add(followUp.toolName);
    });
    for (const notice of input.researchNoProgress ?? []) {
      const followUp = researchFollowUps.find(({ toolName }) => toolName === notice.toolName);
      if (
        followUp &&
        apiResearchFollowUpStateSha256(output.desiredPlan, canonicalSuppliedResearch, followUp) ===
          notice.followUpStateSha256
      ) {
        issue(
          ctx,
          ['researchFollowUps'],
          `research follow-up for ${notice.toolName} exactly repeats a completed no-progress cycle; change the direction, relevant evidence, or boundary`,
        );
      }
    }
    if (input.decisionPurpose === 'research_review') {
      for (const handoff of suppliedResearch) {
        const desiredTool = output.desiredPlan.tools.find(
          ({ candidate }) => candidate.toolName === handoff.toolName,
        );
        const unchanged =
          desiredTool && handoff.researchInputsSha256 === apiResearchInputsSha256(desiredTool);
        const reviewedNoProgress = noProgressNames.has(handoff.toolName);
        if (
          handoff.status === 'partial' &&
          unchanged &&
          !(reviewedNoProgress && desiredTool?.strategy?.kind === 'playbook_fallback') &&
          !directedNames.has(handoff.toolName)
        ) {
          issue(
            ctx,
            ['researchFollowUps'],
            `partial research for ${handoff.toolName} must return to its retained researcher or leave the desired plan`,
          );
        }
        if (
          handoff.status === 'blocked' &&
          unchanged &&
          desiredTool?.strategy?.kind !== 'playbook_fallback' &&
          !directedNames.has(handoff.toolName)
        ) {
          issue(
            ctx,
            ['researchFollowUps'],
            `blocked research for ${handoff.toolName} must return to its retained researcher, change its evidence-backed boundary, select an explicit fallback strategy, or leave the desired plan`,
          );
        }
      }
    }
    output.recallToolNames.forEach((toolName, index) => {
      if (!currentToolNames.has(toolName))
        issue(ctx, ['recallToolNames', index], 'recall target is absent from current plan');
      if (!desiredToolNames.has(toolName))
        issue(ctx, ['recallToolNames', index], 'recall target is absent from desired plan');
    });
    validatePlan(
      output.desiredPlan,
      input.discovery.recordingIndex,
      ctx,
      ['desiredPlan'],
      input.discovery.discoveryCandidates.map(({ toolName }) => toolName),
    );
    output.desiredPlan.tools.forEach((tool, toolIndex) => {
      if (tool.implementationPlan && !suppliedPlans.has(digest(tool.implementationPlan)))
        issue(
          ctx,
          ['desiredPlan', 'tools', toolIndex, 'implementationPlan'],
          'implementation plan was not supplied exactly',
        );
    });
  });
}
const CompletionInputSchema = CompletionReviewInputSchema.superRefine((input, ctx) => {
  validateCurrent(input.run, input.currentPlan, input.recordingIndex, ctx, ['currentPlan']);
  validateSnapshot(input.snapshot, input.run, input.currentPlan, input.recordingIndex, ctx, [
    'snapshot',
  ]);
  validateEvidence(input.evidence, input.recordingIndex, ctx, ['evidence']);
  if (!same(input.history.payload.run, input.snapshot.payload.run))
    issue(ctx, ['history'], 'receipt history belongs to another run');
  const currentRefs = new Set(
    input.snapshot.payload.tools.flatMap(({ receipts }) => receipts.map(({ ref }) => refKey(ref))),
  );
  const currentIds = new Set(
    input.snapshot.payload.tools.flatMap(({ receipts }) => receipts.map(({ id }) => id)),
  );
  const requestSeqs = new Set(input.recordingIndex.requestSeqs);
  input.history.payload.entries.forEach(({ receipt }, index) => {
    if (currentIds.has(receipt.id))
      issue(
        ctx,
        ['history', 'payload', 'entries', index, 'receipt', 'id'],
        'receipt id appears in current and history',
      );
    if (currentRefs.has(refKey(receipt.ref)))
      issue(
        ctx,
        ['history', 'payload', 'entries', index, 'receipt', 'ref'],
        'receipt appears in current and history',
      );
    validateFactSeqs(receipt.facts, requestSeqs, ctx, [
      'history.payload.entries',
      index,
      'receipt.facts',
    ]);
  });
  const planTools = new Map(input.currentPlan.payload.tools.map((tool) => [tool.id, tool]));
  const tools = new Set(planTools.keys());
  if (
    (input.terminalIntent === 'completed' || input.terminalIntent === 'partial') &&
    !input.toolResultEvidence
  )
    issue(
      ctx,
      ['toolResultEvidence'],
      `${input.terminalIntent} intent requires semantic live result evidence`,
    );
  if (input.toolResultEvidence) {
    const resultKey = (toolId: string, chainEdgeId?: string) =>
      `${toolId}\u0000${chainEdgeId ?? 'standalone'}`;
    const seenResults = new Set<string>();
    const standaloneTools = new Set<string>();
    input.toolResultEvidence.forEach((result, index) => {
      const payload = result.payload;
      const tool = planTools.get(payload.toolId);
      if (!tool) {
        issue(ctx, ['toolResultEvidence', index, 'payload', 'toolId'], 'unknown current tool');
        return;
      }
      const key = resultKey(payload.toolId, payload.chainEdgeId);
      if (seenResults.has(key))
        issue(ctx, ['toolResultEvidence', index, 'payload', 'toolId'], 'duplicate tool result');
      seenResults.add(key);
      if (payload.chainEdgeId) {
        const edge = input.currentPlan.payload.chainEdges.find(
          ({ id }) => id === payload.chainEdgeId,
        );
        if (!edge || edge.consumerToolId !== payload.toolId)
          issue(
            ctx,
            ['toolResultEvidence', index, 'payload', 'chainEdgeId'],
            'result evidence belongs to another or unknown chain edge',
          );
      } else {
        standaloneTools.add(payload.toolId);
      }
      if (payload.toolName !== tool.candidate.toolName)
        issue(ctx, ['toolResultEvidence', index, 'payload', 'toolName'], 'tool name mismatch');
      if (!tool.implementationPlan || !same(payload.implementationPlanRef, tool.implementationPlan))
        issue(
          ctx,
          ['toolResultEvidence', index, 'payload', 'implementationPlanRef'],
          'result evidence belongs to another implementation plan',
        );
      const proof = input.snapshot.payload.tools.find(({ toolId }) => toolId === payload.toolId);
      const resultReceipt = proof?.receipts.find(
        (receipt) => refKey(receipt.ref) === refKey(payload.resultReceiptRef),
      );
      if (
        !resultReceipt ||
        resultReceipt.status !== 'passed' ||
        (payload.chainEdgeId
          ? resultReceipt.check !== 'chain' || resultReceipt.chainEdgeId !== payload.chainEdgeId
          : resultReceipt.check !== 'live')
      )
        issue(
          ctx,
          ['toolResultEvidence', index, 'payload', 'resultReceiptRef'],
          'result evidence does not cite a current passed result receipt',
        );
    });
    for (const toolId of tools)
      if (!standaloneTools.has(toolId))
        issue(ctx, ['toolResultEvidence'], `missing standalone result evidence for "${toolId}"`);
    for (const edge of input.currentPlan.payload.chainEdges)
      if (!seenResults.has(resultKey(edge.consumerToolId, edge.id)))
        issue(ctx, ['toolResultEvidence'], `missing result evidence for chain "${edge.id}"`);
  }
  const claims = new Set<string>();
  input.claims.forEach((claim, index) => {
    if (claims.has(claim.id)) issue(ctx, ['claims', index, 'id'], 'duplicate claim');
    if (claim.toolId && !tools.has(claim.toolId))
      issue(ctx, ['claims', index, 'toolId'], 'unknown tool');
    claims.add(claim.id);
  });
  const blockers = input.claims.filter(({ kind }) => kind === 'blocker');
  if (input.terminalIntent === 'blocked' && blockers.length === 0)
    issue(ctx, ['claims'], 'blocked intent requires a blocker claim');
  if (input.terminalIntent === 'partial' && blockers.length === 0)
    issue(ctx, ['claims'], 'partial intent requires unresolved-candidate blocker claims');
  if (input.terminalIntent === 'completed')
    for (const failure of mechanicalProofFailures(input.currentPlan.payload, input.snapshot))
      issue(ctx, ['snapshot'], failure);
  if (input.terminalIntent === 'partial') {
    if (input.currentPlan.payload.tools.length === 0)
      issue(ctx, ['currentPlan'], 'partial intent requires at least one current tool');
    if (unresolvedCandidateCoverage(input.currentPlan.payload).length === 0)
      issue(ctx, ['currentPlan'], 'partial intent requires unresolved candidate coverage');
    for (const tool of input.currentPlan.payload.tools)
      for (const failure of mechanicalProofFailures(
        input.currentPlan.payload,
        input.snapshot,
        tool.id,
      ))
        issue(ctx, ['snapshot'], failure);
  }
});
function completionOutputSchema(input: CompletionReviewInput) {
  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  const tools = new Set(input.currentPlan.payload.tools.map(({ id }) => id));
  const resultKey = (toolId: string, chainEdgeId?: string) =>
    `${toolId}\u0000${chainEdgeId ?? 'standalone'}`;
  const resultEvidence = new Map(
    (input.toolResultEvidence ?? []).map((result) => [
      resultKey(result.payload.toolId, result.payload.chainEdgeId),
      result,
    ]),
  );
  return CompletionReviewOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, completionBinding(input)))
      issue(ctx, ['binding'], 'stale completion binding');
    const seen = new Set<string>();
    output.claimDispositions.forEach((disposition, index) => {
      const claim = claims.get(disposition.claimId);
      if (!claim) issue(ctx, ['claimDispositions', index], 'unknown claim');
      if (seen.has(disposition.claimId))
        issue(ctx, ['claimDispositions', index], 'duplicate disposition');
      if (
        claim &&
        !disposition.evidenceRefs.some((ref) =>
          claim.evidenceRefs.some((claimRef) => refKey(ref) === refKey(claimRef)),
        )
      )
        issue(
          ctx,
          ['claimDispositions', index, 'evidenceRefs'],
          'claim disposition must cite supplied claim evidence',
        );
      seen.add(disposition.claimId);
    });
    for (const id of claims.keys())
      if (!seen.has(id)) issue(ctx, ['claimDispositions'], `missing disposition for "${id}"`);
    output.findings.forEach((finding, index) => {
      if (finding.toolId && !tools.has(finding.toolId))
        issue(ctx, ['findings', index, 'toolId'], 'unknown tool');
    });
    const seenResultReviews = new Set<string>();
    output.toolResultReviews.forEach((review, index) => {
      const key = resultKey(review.toolId, review.chainEdgeId);
      const evidence = resultEvidence.get(key);
      if (!tools.has(review.toolId))
        issue(ctx, ['toolResultReviews', index, 'toolId'], 'unknown tool');
      if (!evidence)
        issue(ctx, ['toolResultReviews', index, 'toolId'], 'no result evidence for tool');
      if (seenResultReviews.has(key))
        issue(ctx, ['toolResultReviews', index, 'toolId'], 'duplicate tool result review');
      seenResultReviews.add(key);
      if (evidence && !review.evidenceRefs.some((ref) => refKey(ref) === refKey(evidence.ref)))
        issue(
          ctx,
          ['toolResultReviews', index, 'evidenceRefs'],
          'tool result review must cite its result evidence',
        );
      if (review.status === 'revision_required') {
        if (output.verdict !== 'failed')
          issue(ctx, ['verdict'], 'revision-required result review must fail completion');
        const blockingFinding = output.findings.some(
          (finding) =>
            finding.severity === 'blocking' &&
            finding.toolId === review.toolId &&
            evidence &&
            finding.evidenceRefs.some((ref) => refKey(ref) === refKey(evidence.ref)),
        );
        if (!blockingFinding)
          issue(
            ctx,
            ['findings'],
            `revision-required result review for "${review.toolId}" needs a blocking finding`,
          );
      }
    });
    if (input.toolResultEvidence) {
      for (const [key, evidence] of resultEvidence)
        if (!seenResultReviews.has(key))
          issue(
            ctx,
            ['toolResultReviews'],
            `missing result review for "${evidence.payload.toolId}"${
              evidence.payload.chainEdgeId ? ` chain "${evidence.payload.chainEdgeId}"` : ''
            }`,
          );
    } else if (output.toolResultReviews.length > 0) {
      issue(ctx, ['toolResultReviews'], 'result reviews require supplied result evidence');
    }
    if (output.verdict !== 'passed') return;
    const dispositions = new Map(
      output.claimDispositions.map((item) => [item.claimId, item.status]),
    );
    const blockerStatuses = input.claims
      .filter(({ kind }) => kind === 'blocker')
      .map(({ id }) => dispositions.get(id));
    const exclusionStatuses = input.claims
      .filter(({ kind }) => kind === 'exclusion')
      .map(({ id }) => dispositions.get(id));
    if (input.terminalIntent === 'completed' && blockerStatuses.includes('supported'))
      issue(ctx, ['verdict'], 'completed intent cannot pass with a supported blocker');
    if (
      (input.terminalIntent === 'completed' || input.terminalIntent === 'partial') &&
      exclusionStatuses.some((status) => status !== 'supported')
    )
      issue(
        ctx,
        ['verdict'],
        `${input.terminalIntent} intent requires every candidate exclusion to be supported`,
      );
    if (
      (input.terminalIntent === 'blocked' || input.terminalIntent === 'partial') &&
      blockerStatuses.some((status) => status !== 'supported')
    )
      issue(
        ctx,
        ['verdict'],
        `${input.terminalIntent} intent requires every blocker claim to be supported`,
      );
  });
}
export interface MasterTeachAnalyzer {
  analyze(
    prompt: string,
    payload: unknown,
    options?: {
      timeoutMs?: number;
      deadlineMs?: number;
      runDeadline?: RunDeadlineRef;
      timeoutLabel?: string;
      signal?: AbortSignal;
      onProviderRetry?: (event: ProviderRetryEvent) => void;
      onDeadlineReached?: () => Promise<number | null | undefined>;
      conversationKey?: string;
    },
  ): Promise<{ text: string }>;
}
type Role =
  | 'tool advisor'
  | 'focused planner'
  | 'API researcher'
  | 'master decision'
  | 'baseline MVP reviewer'
  | 'parameter advisor'
  | 'completion reviewer';
export interface MasterTeachAgentOptions {
  provider?: ProviderName;
  model?: string;
  timeoutMs?: number;
  /** Absolute teach-run deadline shared by every semantic role and provider retry. */
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  signal?: AbortSignal;
  analyzer?: MasterTeachAnalyzer;
  onRetry?: (event: {
    role: Role;
    attempt: 2;
    parseErrors: readonly string[];
    signal: AbortSignal;
  }) => void | Promise<void>;
  onProviderRetry?: (event: ProviderRetryEvent) => void;
  onDeadlineReached?: () => Promise<number | null | undefined>;
}
export type ApiResearchRetainedTurnDelta =
  | {
      kind: 'observation';
      latestObservation: ApiResearchInput['observations'][number];
    }
  | {
      kind: 'catalog_page';
      requestCatalog: NonNullable<ApiResearchInput['requestCatalog']>;
      requestCatalogTruncated: boolean;
      requestCatalogPage: NonNullable<ApiResearchInput['requestCatalogPage']>;
    }
  | {
      kind: 'inspection';
      inspectedRequestSeqs: number[];
      relevantEvidence: ApiResearchInput['evidence'];
    }
  | {
      kind: 'block_review';
      blockReview: NonNullable<ApiResearchInput['blockReview']>;
    }
  | {
      kind: 'master_follow_up';
      followUp: NonNullable<ApiResearchInput['followUp']>;
      relevantEvidence: ApiResearchInput['evidence'];
      currentTool?: ApiResearchInput['tool'];
      requiredLinks?: NonNullable<ApiResearchInput['requiredLinks']>;
      requestCatalog?: NonNullable<ApiResearchInput['requestCatalog']>;
      requestCatalogTruncated?: boolean;
      requestCatalogPage?: NonNullable<ApiResearchInput['requestCatalogPage']>;
    };
export class SemanticAgentOutputError extends Error {
  constructor(
    readonly role: Role,
    readonly parseErrors: readonly string[],
    readonly attempts: 1 | 2,
  ) {
    super(
      `${role} returned invalid output${attempts === 2 ? ' after one repair' : ''}: ${parseErrors.join('; ')}`,
    );
    this.name = 'SemanticAgentOutputError';
  }
}
function parse<S extends z.ZodTypeAny>(
  role: Role,
  text: string,
  schema: S,
  attempts: 1 | 2 = 1,
): z.output<S> {
  const trimmed = text.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (trimmed.startsWith('```') && !fence)
    throw new SemanticAgentOutputError(role, ['expected one complete JSON fence'], attempts);
  let value: unknown;
  try {
    value = JSON.parse(fence?.[1] ?? trimmed);
  } catch (error) {
    throw new SemanticAgentOutputError(role, [`invalid JSON object: ${String(error)}`], attempts);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SemanticAgentOutputError(role, ['expected one JSON object'], attempts);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SemanticAgentOutputError(
    role,
    result.error.issues
      .slice(0, 24)
      .map(({ path, message }) => `${path.join('.') || '<root>'}: ${message}`.slice(0, 500)),
    attempts,
  );
}
export function parseToolSelectionAdvisorOutput(text: string, input: ToolSelectionAdvisorInput) {
  const checked = ToolInputSchema.parse(input);
  return parse('tool advisor', text, toolOutputSchema(checked));
}
export function parseFocusedPlannerOutput(text: string, input: FocusedPlannerInput) {
  const checked = FocusedPlannerInputValidationSchema.parse(input);
  return parse('focused planner', text, focusedPlannerOutputSchema(checked));
}
export function parseApiResearchOutput(text: string, input: ApiResearchInput) {
  const checked = ApiResearchInputValidationSchema.parse(input);
  return parse('API researcher', text, apiResearchOutputSchema(checked));
}
export function parseMasterDecisionOutput(text: string, input: MasterDecisionInput) {
  const checked = MasterInputSchema.parse(input);
  return parse('master decision', text, masterOutputSchema(checked));
}
export function parseParameterSelectionAdvisorOutput(
  text: string,
  input: ParameterSelectionAdvisorInput,
) {
  const checked = ParameterInputSchema.parse(input);
  return parse('parameter advisor', text, parameterOutputSchema(checked));
}
export function parseBaselineMvpReviewOutput(text: string, input: BaselineMvpReviewInput) {
  const checked = BaselineMvpInputSchema.parse(input);
  return parse('baseline MVP reviewer', text, baselineMvpOutputSchema(checked));
}
export function parseCompletionReviewOutput(text: string, input: CompletionReviewInput) {
  const checked = CompletionInputSchema.parse(input);
  return parse('completion reviewer', text, completionOutputSchema(checked));
}
function semanticRepairPrompt(system: string, role: Role): string {
  const roleRule =
    role === 'master decision'
      ? '\nFor a master decision, use the public candidate.toolName everywhere. Each wire-format tool id must equal that public name, including buildWaves and chainEdges. Propagate every rename through all affected references.'
      : '';
  return `${system}\n\n# Output repair\n\nThis is a repair of your previous output. The preceding conversation contains the authoritative task. When supplied, originalInput and validationContext restate that task and its exact allowed bindings. priorResponse is your complete previous answer, and parseErrors are factual validator diagnostics. Return one complete replacement object in the original schema, not a patch, wrapper, prose, or commentary. Preserve valid decisions and change what is needed to correct every listed issue.${roleRule}`;
}

function semanticRoleRequestPayload(input: unknown, validation: unknown) {
  return { input, validationContext: validation };
}
async function invoke<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  waitForDeadlineDecision: () => Promise<void>,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortSignalError(signal, `${label} aborted`));
    };
    const finish = async (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
      try {
        await waitForDeadlineDecision();
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
        return;
      }
      if (settled) return;
      if (signal.aborted) return abort();
      settled = true;
      cleanup();
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      void finish({ ok: false, error });
      return;
    }
    if (signal.aborted) return abort();
    promise.then(
      (value) => void finish({ ok: true, value }),
      (error) => void finish({ ok: false, error }),
    );
  });
}
async function ensureSemanticRoleDeadline(
  runDeadline: RunDeadlineRef | undefined,
  roleExpiresAt: number | undefined,
  signal: AbortSignal | undefined,
  onDeadlineReached: (() => Promise<number | null | undefined>) | undefined,
): Promise<void> {
  while (true) {
    if (signal?.aborted) throw abortSignalError(signal);
    const now = Date.now();
    const runExpiresAt = runDeadline?.deadlineMs;
    const phaseIsFirst =
      roleExpiresAt !== undefined && (runExpiresAt === undefined || roleExpiresAt <= runExpiresAt);
    if (phaseIsFirst && now >= roleExpiresAt) {
      throw new ProviderDeadlineError(roleExpiresAt, undefined, 'phase');
    }
    if (runExpiresAt !== undefined && now >= runExpiresAt) {
      const canExtend = (runDeadline?.scope ?? 'run') === 'run';
      if (canExtend && (await runDeadline?.requestExtension?.(onDeadlineReached)) === true)
        continue;
      throw new ProviderDeadlineError(runExpiresAt, undefined, runDeadline?.scope ?? 'run');
    }
    if (roleExpiresAt !== undefined && now >= roleExpiresAt) {
      throw new ProviderDeadlineError(roleExpiresAt, undefined, 'phase');
    }
    return;
  }
}
async function request<S extends z.ZodTypeAny>(options: {
  role: Role;
  conversationKey: string;
  prompt: string;
  input: unknown;
  validation: unknown;
  schema: S;
  agent: MasterTeachAgentOptions;
}): Promise<z.output<S>> {
  const analyzer =
    options.agent.analyzer ??
    resolveProvider({
      provider: options.agent.provider,
      model: options.agent.model,
    } satisfies LLMOptions);
  const system = readFileSync(join(PROMPTS, options.prompt), 'utf8');
  const startedAt = Date.now();
  const roleExpiresAt =
    options.agent.timeoutMs === undefined ? undefined : startedAt + options.agent.timeoutMs;
  const runDeadline = resolvedRunDeadline(options.agent.runDeadline, options.agent.deadlineMs);
  await ensureSemanticRoleDeadline(
    runDeadline,
    roleExpiresAt,
    options.agent.signal,
    options.agent.onDeadlineReached,
  );
  const active = combinedDeadlineSignal(
    runDeadline,
    roleExpiresAt,
    options.agent.signal,
    Date.now,
    undefined,
    options.agent.onDeadlineReached,
  );
  const signal = active.signal ?? new AbortController().signal;
  const retainedCodexConversation = options.agent.provider === 'codex-cli';
  const analyze = (payload: unknown, prompt = system) =>
    invoke(
      () =>
        analyzer.analyze(prompt, payload, {
          signal,
          timeoutMs:
            roleExpiresAt === undefined ? undefined : Math.max(0, roleExpiresAt - Date.now()),
          deadlineMs: runDeadline?.deadlineMs,
          runDeadline,
          timeoutLabel: `master teach ${options.role}`,
          onProviderRetry: options.agent.onProviderRetry,
          onDeadlineReached: options.agent.onDeadlineReached,
          conversationKey: options.conversationKey,
        }),
      signal,
      active.waitForDeadlineDecision,
      options.role,
    );
  try {
    const first = await analyze(semanticRoleRequestPayload(options.input, options.validation));
    try {
      return await invoke(
        () => Promise.resolve(parse(options.role, first.text, options.schema)),
        signal,
        active.waitForDeadlineDecision,
        `${options.role} output validation`,
      );
    } catch (error) {
      if (!(error instanceof SemanticAgentOutputError)) throw error;
      if (options.agent.onRetry)
        await invoke(
          async () =>
            options.agent.onRetry?.({
              role: options.role,
              attempt: 2,
              parseErrors: error.parseErrors,
              signal,
            }),
          signal,
          active.waitForDeadlineDecision,
          `${options.role} retry callback`,
        );
      const repaired = await analyze(
        retainedCodexConversation
          ? {
              priorResponse: first.text,
              parseErrors: error.parseErrors,
            }
          : {
              originalInput: options.input,
              validationContext: options.validation,
              priorResponse: first.text,
              parseErrors: error.parseErrors,
            },
        semanticRepairPrompt(system, options.role),
      );
      return await invoke(
        () => Promise.resolve(parse(options.role, repaired.text, options.schema, 2)),
        signal,
        active.waitForDeadlineDecision,
        `${options.role} repaired output validation`,
      );
    }
  } finally {
    active.dispose();
  }
}
export async function requestToolSelectionAdvice(
  input: ToolSelectionAdvisorInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = ToolInputSchema.parse(input);
  return request({
    role: 'tool advisor',
    conversationKey: 'tool-selection',
    prompt: 'master-teach-tool-advisor.md',
    input: toolAdvisorPromptInput(checked),
    validation: { binding: checked.run, recordingIndex: checked.recordingIndex },
    schema: toolOutputSchema(checked),
    agent,
  });
}
export async function requestFocusedPlan(
  input: FocusedPlannerInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = FocusedPlannerInputValidationSchema.parse(input);
  return request({
    role: 'focused planner',
    conversationKey: `tool:${checked.tool.candidate.toolName}:planner`,
    prompt: 'master-teach-focused-planner.md',
    input: checked,
    validation: {
      binding: focusedPlannerBinding(checked),
      recordingIndex: checked.recordingIndex,
      authorizedEvidenceRefs: checked.tool.evidenceRefs,
    },
    schema: focusedPlannerOutputSchema(checked),
    agent,
  });
}
export async function requestApiResearchStep(
  input: ApiResearchInput,
  agent: MasterTeachAgentOptions = {},
  retainedTurnDelta?: ApiResearchRetainedTurnDelta,
) {
  const checked = ApiResearchInputValidationSchema.parse(input);
  const latestObservation = checked.observations.at(-1);
  const retainedInput = retainedTurnDelta
    ? (({ kind, ...delta }) => ({
        instruction:
          kind === 'master_follow_up'
            ? 'Continue the same retained API-research conversation. Follow this new master direction and use the newly supplied evidence. Test complete candidates until the named proof gap is resolved, remains partial with a better exact handoff, or is factually blocked.'
            : kind === 'observation'
              ? 'Continue the same retained API-research conversation. Evaluate this newest factual test result. Return partial only when the selected core result or a required downstream obligation remains incomplete; defer optional breadth and further minimization.'
              : kind === 'catalog_page'
                ? 'Continue the same retained API-research conversation with this newly requested catalog page.'
                : kind === 'inspection'
                  ? 'Continue the same retained API-research conversation with only the newly requested recording evidence.'
                  : 'Review your proposed blocker once using the retained evidence. Return another evidence-backed action when one remains, otherwise return blocked with the exact factual reason.',
        turnKind: kind,
        ...delta,
      }))(retainedTurnDelta)
    : undefined;
  return request({
    role: 'API researcher',
    conversationKey: `tool:${checked.tool.candidate.toolName}:api-researcher`,
    prompt: 'master-teach-api-researcher.md',
    input:
      agent.provider === 'codex-cli' && retainedInput
        ? {
            ...retainedInput,
            ...('currentTool' in retainedInput && retainedInput.currentTool
              ? {
                  currentTool: apiResearchPromptTool({
                    ...checked,
                    tool: retainedInput.currentTool,
                  }),
                }
              : {}),
          }
        : { ...checked, tool: apiResearchPromptTool(checked) },
    validation: {
      binding: apiResearchBinding(checked),
      testedCandidateSha256: latestObservation?.candidateSha256,
    },
    schema: apiResearchOutputSchema(checked),
    agent,
  });
}
export async function requestMasterDecision(
  input: MasterDecisionInput,
  agent: MasterTeachAgentOptions = {},
  options: { selfContained?: boolean } = {},
) {
  const checked = MasterInputSchema.parse(input);
  return request({
    role: 'master decision',
    conversationKey: 'master',
    prompt: 'master-teach-decision.md',
    input:
      agent.provider === 'codex-cli' && !options.selfContained
        ? masterDecisionConversationInput(checked)
        : masterDecisionPromptInput(checked),
    validation: {
      binding: masterDecisionBinding(checked),
      recordingIndex: checked.discovery.recordingIndex,
    },
    schema: masterOutputSchema(checked),
    agent,
  });
}
export async function requestParameterSelectionAdvice(
  input: ParameterSelectionAdvisorInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = ParameterInputSchema.parse(input);
  return request({
    role: 'parameter advisor',
    conversationKey: `tool:${checked.toolId}:parameter-advisor`,
    prompt: 'master-teach-parameter-advisor.md',
    input: parameterAdvisorPromptInput(checked),
    validation: { binding: parameterBinding(checked) },
    schema: parameterOutputSchema(checked),
    agent,
  });
}
export async function requestBaselineMvpReview(
  input: BaselineMvpReviewInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = BaselineMvpInputSchema.parse(input);
  return request({
    role: 'baseline MVP reviewer',
    conversationKey: `tool:${checked.toolId}:mvp-reviewer`,
    prompt: 'master-teach-baseline-mvp-review.md',
    input: baselineMvpReviewerPromptInput(checked),
    validation: { binding: baselineMvpBinding(checked) },
    schema: baselineMvpOutputSchema(checked),
    agent,
  });
}
export async function requestCompletionReview(
  input: CompletionReviewInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = CompletionInputSchema.parse(input);
  return request({
    role: 'completion reviewer',
    conversationKey: 'completion-reviewer',
    prompt: 'master-teach-completion-review.md',
    input: checked,
    validation: {
      binding: completionBinding(checked),
      terminalIntent: checked.terminalIntent,
      knownToolIds: checked.currentPlan.payload.tools.map(({ id }) => id),
    },
    schema: completionOutputSchema(checked),
    agent,
  });
}
