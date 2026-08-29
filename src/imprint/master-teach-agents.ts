/** Four strict one-shot semantic roles. Store/controller state remains authoritative. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { type LLMOptions, type ProviderName, resolveProvider } from './llm.ts';
import {
  type CompletionReviewInput,
  CompletionReviewInputSchema,
  CompletionReviewOutputSchema,
  type CurrentPlanBinding,
  type CurrentPlanProjection,
  type MasterDecisionInput,
  MasterDecisionInputSchema,
  MasterDecisionOutputSchema,
  type ParameterSelectionAdvisorInput,
  ParameterSelectionAdvisorInputSchema,
  ParameterSelectionAdvisorOutputSchema,
  ParameterSelectionAdvisorPromptInputSchema,
  ROLE_OUTPUT_MAX_BYTES,
  type ToolSelectionAdvisorInput,
  ToolSelectionAdvisorInputSchema,
  ToolSelectionAdvisorOutputSchema,
  ToolSelectionAdvisorPromptInputSchema,
  discoveryContentSha256,
  schemaIssue as issue,
} from './master-teach-agent-contracts.ts';
import {
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type TeachingCandidateEvidence,
  teachingPlanContentSha256 as digest,
  teachingCandidateIssues,
  teachingToolCompileInputsSha256,
  validateDesiredTeachingPlan,
} from './master-teach-plan.ts';
import type {
  CurrentExecutionSnapshot,
  PromptEvidenceProjection,
  ReceiptFact,
  RecordingIndex,
} from './master-teach-prompt-projections.ts';
import type { ProviderRetryEvent } from './provider-retry.ts';
export * from './master-teach-agent-contracts.ts';
export * from './master-teach-prompt-projections.ts';
const PROMPTS = join(import.meta.dir, '..', '..', 'prompts');
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
const refKey = (ref: ContentAddressedRef) => `${ref.path}\u0000${ref.sha256}`;
function checkRefs(
  refs: readonly ContentAddressedRef[],
  known: ReadonlySet<string>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  message = 'unknown ref',
): void {
  refs.forEach((ref, index) => {
    if (!known.has(refKey(ref))) issue(ctx, [...path, index], message);
  });
}
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
  for (const problem of teachingCandidateIssues(
    candidates,
    new Set(index.requestSeqs),
    new Set(index.eventSeqs),
  ))
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
  const expected = discoveryContentSha256({
    recordingIndex: input.recordingIndex,
    detectorSharedContext: input.detectorSharedContext,
    discoveryCandidates: input.discoveryCandidates,
    evidence: input.evidence,
  });
  if (
    input.run.recordingSha256 !== input.recordingIndex.recordingSha256 ||
    input.run.discoverySha256 !== expected
  )
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
function validatePlan(
  plan: DesiredTeachingPlan,
  index: RecordingIndex,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  try {
    validateDesiredTeachingPlan(
      {
        site: plan.site,
        recordingSha256: plan.recordingSha256,
        tools: plan.tools,
        chainEdges: plan.chainEdges,
      },
      {
        site: plan.site,
        recordingSha256: plan.recordingSha256,
        requestSeqs: new Set(index.requestSeqs),
        eventSeqs: new Set(index.eventSeqs),
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
  const idByName = new Map(plan.tools.map((tool) => [tool.candidate.toolName, tool.id]));
  const proofs = new Map(snapshot.payload.tools.map((proof) => [proof.toolId, proof]));
  const requestSeqs = new Set(index.requestSeqs);
  snapshot.payload.tools.forEach((proof, proofIndex) => {
    const tool = planned.get(proof.toolId);
    const base = [...path, 'payload', 'tools', proofIndex];
    if (!tool) return issue(ctx, base, 'stray execution proof');
    const binding = proof.executionBinding;
    checkSeqs(binding.replayRequestSeqs, requestSeqs, ctx, [
      ...base,
      'executionBinding',
      'replayRequestSeqs',
    ]);
    if (
      !tool.strategy ||
      !tool.implementationPlan ||
      binding.compileInputsSha256 !== teachingToolCompileInputsSha256(tool, plan.chainEdges) ||
      binding.strategyKind !== tool.strategy.kind ||
      !same(binding.implementationPlan, tool.implementationPlan)
    )
      issue(ctx, base, 'execution proof does not match exact tool compile inputs');
    const expectedDependencies = new Set(
      tool.candidate.dependsOnTools.flatMap((name) => idByName.get(name) ?? []),
    );
    const actualDependencies = new Set(binding.dependencies.map(({ toolId }) => toolId));
    if (!same([...expectedDependencies].sort(), [...actualDependencies].sort()))
      issue(ctx, [...base, 'executionBinding', 'dependencies'], 'wrong dependency tools');
    proof.receipts.forEach((receipt, receiptIndex) => {
      validateFactSeqs(
        receipt.facts,
        requestSeqs,
        ctx,
        base.concat('receipts', receiptIndex, 'facts'),
      );
      if (receipt.check !== 'chain') return;
      const edge = plan.chainEdges.find(({ id }) => id === receipt.chainEdgeId);
      const producer = edge ? proofs.get(edge.producerToolId) : undefined;
      if (!edge || edge.consumerToolId !== tool.id || !producer)
        return issue(ctx, [...base, 'receipts', receiptIndex], 'unknown current chain edge');
      const expected = {
        toolId: producer.toolId,
        buildRef: producer.currentBuildRef,
        executionBindingSha256: producer.executionBindingSha256,
      };
      if (
        !same(receipt.dependencyBuilds, [expected]) ||
        !binding.dependencies.some((dependency) => same(dependency, expected))
      )
        issue(ctx, [...base, 'receipts', receiptIndex], 'chain receipt has stale producer build');
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
  for (const tool of tools) {
    const proof = proofs.get(tool.id);
    if (!tool.strategy || !proof) {
      failures.push(`${tool.id}: missing current execution proof`);
      continue;
    }
    const expected = [
      ['contract', 'passed'],
      ['live', 'passed'],
      ['replay', tool.strategy.kind === 'api' ? 'passed' : 'not_applicable'],
    ] as const;
    for (const [check, status] of expected) {
      if (!proof.receipts.some((receipt) => receipt.check === check && receipt.status === status))
        failures.push(`${tool.id}: ${check} must be ${status}`);
    }
    for (const edge of plan.chainEdges.filter(({ consumerToolId }) => consumerToolId === tool.id)) {
      if (
        !proof.receipts.some(
          (receipt) =>
            receipt.check === 'chain' &&
            receipt.chainEdgeId === edge.id &&
            receipt.status === 'passed',
        )
      )
        failures.push(`${tool.id}: chain ${edge.id} must be passed`);
    }
  }
  return failures;
}
function planRoleBinding(input: MasterDecisionInput) {
  return input.current ? { ...input.current.run, inputSha256: digest(input) } : input.discovery.run;
}
function completionBinding(input: CompletionReviewInput) {
  return { ...input.run, inputSha256: digest(input) };
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
    verificationSha256: digest(proof),
    evidenceSha256: input.evidence.ref.sha256,
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
function parameterOutputSchema(input: ParameterSelectionAdvisorInput) {
  return ParameterSelectionAdvisorOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, parameterBinding(input)))
      issue(ctx, ['binding'], 'stale parameter-advice binding');
  });
}
function evidenceRefs(evidence: PromptEvidenceProjection): ContentAddressedRef[] {
  return [evidence.ref, ...evidence.payload.entries.map(({ ref }) => ref)];
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
const MasterInputSchema = MasterDecisionInputSchema.superRefine((input, ctx) => {
  validateDiscovery(input.discovery, ctx);
  const authorizedEvidence = new Set(input.authorizedRefs.evidence.map(refKey));
  const authorizedPlans = new Set(input.authorizedRefs.implementationPlans.map(digest));
  if (
    new Set(input.authorizedRefs.evidence.map(refKey)).size !== input.authorizedRefs.evidence.length
  )
    issue(ctx, ['authorizedRefs', 'evidence'], 'duplicate authorized evidence ref');
  if (authorizedPlans.size !== input.authorizedRefs.implementationPlans.length)
    issue(ctx, ['authorizedRefs', 'implementationPlans'], 'duplicate implementation plan ref');
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
  const tools = new Map((input.current?.plan.payload.tools ?? []).map((tool) => [tool.id, tool]));
  input.plannerProposals.forEach((proposal, index) => {
    const { binding, tool, chainEdges } = proposal.payload;
    if (proposalIds.has(tool.id))
      issue(ctx, ['plannerProposals', index], 'duplicate proposal tool');
    if (
      binding.runId !== input.discovery.run.runId ||
      binding.recordingSha256 !== input.discovery.run.recordingSha256 ||
      binding.discoverySha256 !== input.discovery.run.discoverySha256 ||
      binding.toolId !== tool.id ||
      binding.compileInputsSha256 !== teachingToolCompileInputsSha256(tool, chainEdges)
    )
      issue(ctx, ['plannerProposals', index, 'payload', 'binding'], 'stale planner proposal');
    chainEdges.forEach((edge, edgeIndex) => {
      if (edge.consumerToolId !== tool.id)
        issue(
          ctx,
          ['plannerProposals', index, 'payload', 'chainEdges', edgeIndex, 'consumerToolId'],
          'proposal chain edges must target the proposed tool',
        );
    });
    checkRefs(
      tool.evidenceRefs,
      authorizedEvidence,
      ctx,
      ['plannerProposals', index, 'payload', 'tool', 'evidenceRefs'],
      'unauthorized evidence ref',
    );
    if (tool.implementationPlan && !authorizedPlans.has(digest(tool.implementationPlan)))
      issue(
        ctx,
        ['plannerProposals', index, 'payload', 'tool', 'implementationPlan'],
        'unauthorized implementation plan',
      );
    proposalIds.add(tool.id);
    tools.set(tool.id, tool);
  });
  const proposalEdges = input.plannerProposals.flatMap(({ payload }) => payload.chainEdges);
  if (input.plannerProposals.length)
    validatePlan(
      {
        site: input.discovery.run.site,
        recordingSha256: input.discovery.run.recordingSha256,
        tools: [...tools.values()],
        chainEdges: [
          ...(input.current?.plan.payload.chainEdges ?? []).filter(
            (edge) => !proposalIds.has(edge.consumerToolId),
          ),
          ...proposalEdges,
        ],
      },
      input.discovery.recordingIndex,
      ctx,
      ['plannerProposals'],
    );
  const seenAdvice = new Set<string>();
  input.parameterAdvice.forEach((submission, index) => {
    if (!input.current?.snapshot)
      return issue(ctx, ['parameterAdvice', index], 'parameter advice needs current proof');
    if (seenAdvice.has(submission.toolId))
      issue(ctx, ['parameterAdvice', index, 'toolId'], 'duplicate parameter advice');
    const parameterInput = {
      run: input.current.run,
      recordingIndex: input.discovery.recordingIndex,
      currentPlan: input.current.plan,
      snapshot: input.current.snapshot,
      toolId: submission.toolId,
      evidence: submission.evidence,
    };
    const checked = ParameterInputSchema.safeParse(parameterInput);
    if (!checked.success)
      for (const problem of checked.error.issues)
        issue(ctx, ['parameterAdvice', index, ...problem.path], problem.message);
    if (!same(submission.advice.binding, parameterBinding(parameterInput)))
      issue(ctx, ['parameterAdvice', index, 'advice', 'binding'], 'stale parameter advice');
    seenAdvice.add(submission.toolId);
  });
  if (input.verificationFindings)
    validateEvidence(input.verificationFindings, input.discovery.recordingIndex, ctx, [
      'verificationFindings',
    ]);
});
function masterOutputSchema(input: MasterDecisionInput) {
  const suppliedPlans = new Set(
    [
      ...(input.current?.plan.payload.tools ?? []),
      ...input.plannerProposals.map(({ payload }) => payload.tool),
    ].flatMap(({ implementationPlan }) => (implementationPlan ? [digest(implementationPlan)] : [])),
  );
  const authorizedPlans = new Set(input.authorizedRefs.implementationPlans.map(digest));
  const authorizedEvidence = new Set(input.authorizedRefs.evidence.map(refKey));
  return MasterDecisionOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, planRoleBinding(input)))
      issue(ctx, ['binding'], 'stale master binding');
    if (
      output.desiredPlan.site !== input.discovery.run.site ||
      output.desiredPlan.recordingSha256 !== input.discovery.run.recordingSha256
    )
      issue(ctx, ['desiredPlan'], 'desired plan belongs to another recording');
    validatePlan(output.desiredPlan, input.discovery.recordingIndex, ctx, ['desiredPlan']);
    output.desiredPlan.tools.forEach((tool, toolIndex) => {
      checkRefs(
        tool.evidenceRefs,
        authorizedEvidence,
        ctx,
        ['desiredPlan', 'tools', toolIndex, 'evidenceRefs'],
        'unauthorized evidence ref',
      );
      if (
        tool.implementationPlan &&
        (!authorizedPlans.has(digest(tool.implementationPlan)) ||
          !suppliedPlans.has(digest(tool.implementationPlan)))
      )
        issue(
          ctx,
          ['desiredPlan', 'tools', toolIndex, 'implementationPlan'],
          'implementation plan was not supplied exactly',
        );
    });
  });
}
function currentFactRefs(input: CompletionReviewInput): ContentAddressedRef[] {
  const refs = [
    input.currentPlan.ref,
    input.snapshot.ref,
    input.history.ref,
    input.history.payload.historyRoot,
    ...input.currentPlan.payload.decision.advisorRefs,
    ...input.currentPlan.payload.decision.evidenceRefs,
    ...evidenceRefs(input.evidence),
    ...input.currentPlan.payload.tools.flatMap((tool) => [
      ...tool.evidenceRefs,
      ...(tool.implementationPlan ? [tool.implementationPlan] : []),
    ]),
    ...input.snapshot.payload.tools.flatMap((tool) => [
      tool.currentBuildRef,
      tool.artifactManifestRef,
      tool.executionBinding.sharedManifestRef,
      ...tool.receipts.map(({ ref }) => ref),
      ...tool.executionBinding.dependencies.map(({ buildRef }) => buildRef),
    ]),
    ...input.history.payload.entries.map(({ receipt }) => receipt.ref),
  ];
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
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
  const refs = new Set(currentFactRefs(input).map(refKey));
  const tools = new Set(input.currentPlan.payload.tools.map(({ id }) => id));
  const claims = new Set<string>();
  input.claims.forEach((claim, index) => {
    if (claims.has(claim.id)) issue(ctx, ['claims', index, 'id'], 'duplicate claim');
    if (claim.toolId && !tools.has(claim.toolId))
      issue(ctx, ['claims', index, 'toolId'], 'unknown tool');
    checkRefs(claim.evidenceRefs, refs, ctx, ['claims', index, 'evidenceRefs']);
    claims.add(claim.id);
  });
  const blockers = input.claims.filter(({ kind }) => kind === 'blocker');
  if (input.terminalIntent === 'blocked' && blockers.length === 0)
    issue(ctx, ['claims'], 'blocked intent requires a blocker claim');
  if (input.terminalIntent === 'completed')
    for (const failure of mechanicalProofFailures(input.currentPlan.payload, input.snapshot))
      issue(ctx, ['snapshot'], failure);
});
function completionOutputSchema(input: CompletionReviewInput) {
  const refs = new Set(currentFactRefs(input).map(refKey));
  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  const tools = new Set(input.currentPlan.payload.tools.map(({ id }) => id));
  return CompletionReviewOutputSchema.superRefine((output, ctx) => {
    if (!same(output.binding, completionBinding(input)))
      issue(ctx, ['binding'], 'stale completion binding');
    const seen = new Set<string>();
    output.claimDispositions.forEach((disposition, index) => {
      if (!claims.has(disposition.claimId))
        issue(ctx, ['claimDispositions', index], 'unknown claim');
      if (seen.has(disposition.claimId))
        issue(ctx, ['claimDispositions', index], 'duplicate disposition');
      checkRefs(disposition.evidenceRefs, refs, ctx, ['claimDispositions', index, 'evidenceRefs']);
      seen.add(disposition.claimId);
    });
    for (const id of claims.keys())
      if (!seen.has(id)) issue(ctx, ['claimDispositions'], `missing disposition for "${id}"`);
    output.findings.forEach((finding, index) => {
      if (finding.toolId && !tools.has(finding.toolId))
        issue(ctx, ['findings', index, 'toolId'], 'unknown tool');
      checkRefs(finding.evidenceRefs, refs, ctx, ['findings', index, 'evidenceRefs']);
    });
    if (output.verdict !== 'passed') return;
    const dispositions = new Map(
      output.claimDispositions.map((item) => [item.claimId, item.status]),
    );
    const blockerStatuses = input.claims
      .filter(({ kind }) => kind === 'blocker')
      .map(({ id }) => dispositions.get(id));
    if (input.terminalIntent === 'completed' && blockerStatuses.includes('supported'))
      issue(ctx, ['verdict'], 'completed intent cannot pass with a supported blocker');
    if (
      input.terminalIntent === 'blocked' &&
      blockerStatuses.some((status) => status !== 'supported')
    )
      issue(ctx, ['verdict'], 'blocked intent requires every blocker claim to be supported');
  });
}
export interface MasterTeachAnalyzer {
  analyze(
    prompt: string,
    payload: unknown,
    options?: {
      timeoutMs?: number;
      deadlineMs?: number;
      timeoutLabel?: string;
      signal?: AbortSignal;
      onProviderRetry?: (event: ProviderRetryEvent) => void;
    },
  ): Promise<{ text: string }>;
}
type Role = 'tool advisor' | 'master decision' | 'parameter advisor' | 'completion reviewer';
export interface MasterTeachAgentOptions {
  provider?: ProviderName;
  model?: string;
  timeoutMs?: number;
  /** Absolute teach-run deadline shared by every semantic role and provider retry. */
  deadlineMs?: number;
  signal?: AbortSignal;
  analyzer?: MasterTeachAnalyzer;
  onRetry?: (event: {
    role: Role;
    attempt: 2;
    parseErrors: readonly string[];
    signal: AbortSignal;
  }) => void | Promise<void>;
  onProviderRetry?: (event: ProviderRetryEvent) => void;
}
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
  if (Buffer.byteLength(text, 'utf8') > ROLE_OUTPUT_MAX_BYTES)
    throw new SemanticAgentOutputError(
      role,
      [`response exceeds ${ROLE_OUTPUT_MAX_BYTES} bytes`],
      attempts,
    );
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
export function parseCompletionReviewOutput(text: string, input: CompletionReviewInput) {
  const checked = CompletionInputSchema.parse(input);
  return parse('completion reviewer', text, completionOutputSchema(checked));
}
function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString();
}
async function invoke<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  expiresAt: number | undefined,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const expired = () => signal.aborted || (expiresAt !== undefined && Date.now() >= expiresAt);
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} aborted`, { cause: signal.reason }));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (expired()) return abort();
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    if (expired()) return abort();
    promise.then(
      (value) => {
        if (settled) return;
        if (expired()) return abort();
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        if (expired()) return abort();
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
async function request<S extends z.ZodTypeAny>(options: {
  role: Role;
  prompt: string;
  input: unknown;
  validation: unknown;
  refs: ContentAddressedRef[];
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
  const expiresAt =
    options.agent.deadlineMs === undefined
      ? roleExpiresAt
      : roleExpiresAt === undefined
        ? options.agent.deadlineMs
        : Math.min(options.agent.deadlineMs, roleExpiresAt);
  const timeoutSignal =
    expiresAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, expiresAt - Date.now()));
  const signals = [options.agent.signal, timeoutSignal].filter((value): value is AbortSignal =>
    Boolean(value),
  );
  const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  const analyze = (payload: unknown) =>
    invoke(
      () =>
        analyzer.analyze(system, payload, {
          signal,
          timeoutMs: expiresAt === undefined ? undefined : Math.max(0, expiresAt - Date.now()),
          deadlineMs: options.agent.deadlineMs,
          timeoutLabel: `master teach ${options.role}`,
          onProviderRetry: options.agent.onProviderRetry,
        }),
      signal,
      expiresAt,
      options.role,
    );
  const first = await analyze({
    input: options.input,
    validationContext: options.validation,
    projectionRefs: options.refs,
  });
  try {
    return await invoke(
      () => Promise.resolve(parse(options.role, first.text, options.schema)),
      signal,
      expiresAt,
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
        expiresAt,
        `${options.role} retry callback`,
      );
    const repaired = await analyze({
      originalInput: options.input,
      validationContext: options.validation,
      projectionRefs: options.refs,
      priorResponse: utf8Prefix(first.text, 12_000),
      parseErrors: error.parseErrors,
    });
    return await invoke(
      () => Promise.resolve(parse(options.role, repaired.text, options.schema, 2)),
      signal,
      expiresAt,
      `${options.role} repaired output validation`,
    );
  }
}
export async function requestToolSelectionAdvice(
  input: ToolSelectionAdvisorInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = ToolInputSchema.parse(input);
  return request({
    role: 'tool advisor',
    prompt: 'master-teach-tool-advisor.md',
    input: toolAdvisorPromptInput(checked),
    validation: { binding: checked.run, recordingIndex: checked.recordingIndex },
    refs: evidenceRefs(checked.evidence),
    schema: toolOutputSchema(checked),
    agent,
  });
}
export async function requestMasterDecision(
  input: MasterDecisionInput,
  agent: MasterTeachAgentOptions = {},
) {
  const checked = MasterInputSchema.parse(input);
  return request({
    role: 'master decision',
    prompt: 'master-teach-decision.md',
    input: checked,
    validation: {
      binding: planRoleBinding(checked),
      recordingIndex: checked.discovery.recordingIndex,
      authorizedRefs: checked.authorizedRefs,
    },
    refs: [
      ...checked.authorizedRefs.evidence,
      ...checked.authorizedRefs.implementationPlans,
      ...checked.plannerProposals.map(({ ref }) => ref),
    ],
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
    prompt: 'master-teach-parameter-advisor.md',
    input: parameterAdvisorPromptInput(checked),
    validation: { binding: parameterBinding(checked) },
    refs: [...evidenceRefs(checked.evidence), checked.currentPlan.ref, checked.snapshot.ref],
    schema: parameterOutputSchema(checked),
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
    prompt: 'master-teach-completion-review.md',
    input: checked,
    validation: {
      binding: completionBinding(checked),
      terminalIntent: checked.terminalIntent,
      knownToolIds: checked.currentPlan.payload.tools.map(({ id }) => id),
      knownRefs: currentFactRefs(checked),
    },
    refs: [
      checked.currentPlan.ref,
      checked.snapshot.ref,
      checked.history.ref,
      ...evidenceRefs(checked.evidence),
    ],
    schema: completionOutputSchema(checked),
    agent,
  });
}
