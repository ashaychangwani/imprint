/** Strict wire contracts for bounded, one-shot semantic roles. */
import { z } from 'zod';
import type { BackendAttemptFact, BackendResponseObservation } from './backend-ladder.ts';
import {
  ChainEdgeSchema,
  ConcreteTeachingParameterSchema,
  ContentAddressedRefSchema,
  DesiredTeachingPlanSchema,
  EditableTeachingPlanSchema,
  EditableTeachingToolSchema,
  ImplementationPlanPayloadSchema,
  ImplementationPlanRefSchema,
  TeachingCompileContextSchema,
  TeachingParameterSchema,
  TeachingToolCandidateSchema,
  TeachingToolStrategySchema,
  teachingPlanContentSha256 as digest,
  implementationPlanRequestProvenanceSha256,
} from './master-teach-plan.ts';
import {
  CurrentExecutionSnapshotSchema,
  PromptEvidenceProjectionSchema,
  PromptIdSchema,
  PromptShaSchema,
  PromptToolIdSchema,
  ReceiptHistoryProjectionSchema,
  RecordingIndexSchema,
  RunIdentitySchema,
  ToolVerificationPayloadSchema,
  contentProjection,
  schemaIssue,
  utf8Text,
} from './master-teach-prompt-projections.ts';
import { WorkflowSchema } from './types.ts';
const Reason = utf8Text(1, 4_000);
const Short = utf8Text(1, 1_000);
export { schemaIssue };
const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
export const SemanticToolCandidateSchema = TeachingToolCandidateSchema;
export type SemanticToolCandidate = z.infer<typeof SemanticToolCandidateSchema>;
const ToolBoundaryProposalSchema = SemanticToolCandidateSchema.omit({
  likelyParams: true,
}).strict();
export const CurrentPlanProjectionSchema = contentProjection(EditableTeachingPlanSchema);
export type CurrentPlanProjection = z.infer<typeof CurrentPlanProjectionSchema>;
export const CurrentPlanBindingSchema = RunIdentitySchema.extend({
  planRevision: z.number().int().positive(),
  planSha256: PromptShaSchema,
}).strict();
export type CurrentPlanBinding = z.infer<typeof CurrentPlanBindingSchema>;
const FocusedPlannerBindingSchema = RunIdentitySchema.extend({
  toolId: PromptToolIdSchema,
}).strict();
const PlannerProposalBindingSchema = FocusedPlannerBindingSchema.extend({
  compileInputsSha256: PromptShaSchema,
}).strict();
const PlannableTeachingToolSchema = EditableTeachingToolSchema.omit({
  implementationPlan: true,
}).strict();
const PlannedTeachingToolSchema = PlannableTeachingToolSchema.extend({
  candidate: TeachingToolCandidateSchema.extend({
    likelyParams: z.array(ConcreteTeachingParameterSchema).max(64),
  }).strict(),
  strategy: TeachingToolStrategySchema,
}).strict();
const AvailableProducerSchema = strictObject({
  toolId: PromptToolIdSchema,
  toolName: SemanticToolCandidateSchema.shape.toolName,
  expectedOutput: SemanticToolCandidateSchema.shape.expectedOutput,
});
/** Input-only context from the other tools in the master's current plan.
 * This lets a focused planner reuse already-grounded transport/bootstrap
 * evidence without turning that evidence into a runtime policy. */
const SiblingToolEvidenceSchema = strictObject({
  toolId: PromptToolIdSchema,
  toolName: SemanticToolCandidateSchema.shape.toolName,
  supportRequestSeqs: SemanticToolCandidateSchema.shape.dependencySeqs,
  compileContext: TeachingCompileContextSchema,
  strategy: TeachingToolStrategySchema.optional(),
});
export const FocusedPlannerRevisionContextSchema = strictObject({
  /** The exact older plan/build being revised. The failure facts are the
   * latest reason the master recalled this tool and may describe a direct
   * failure or a dependency failure involving it. */
  sourcePlanRevision: z.number().int().positive(),
  sourcePlanRef: ContentAddressedRefSchema,
  sourceBuildRef: ContentAddressedRefSchema.optional(),
  previousImplementationPlan: strictObject({
    ref: ImplementationPlanRefSchema,
    payload: ImplementationPlanPayloadSchema,
  })
    .superRefine((implementation, ctx) => {
      if (digest(implementation.payload) !== implementation.ref.sha256)
        schemaIssue(ctx, ['ref', 'sha256'], 'previous implementation plan hash mismatch');
    })
    .optional(),
  latestFailureFacts: PromptEvidenceProjectionSchema,
});
export type FocusedPlannerRevisionContext = z.infer<typeof FocusedPlannerRevisionContextSchema>;
export const FocusedPlannerInputSchema = strictObject({
  run: RunIdentitySchema,
  recordingIndex: RecordingIndexSchema,
  /** The master's latest accepted/rejected/revised reasoning for this plan. */
  masterGuidance: Reason,
  tool: PlannableTeachingToolSchema,
  availableProducers: z.array(AvailableProducerSchema),
  siblingToolEvidence: z.array(SiblingToolEvidenceSchema),
  incomingChainEdges: z.array(ChainEdgeSchema),
  outgoingChainEdges: z.array(ChainEdgeSchema),
  evidence: PromptEvidenceProjectionSchema,
  /** Optional input-only handoff from the immediately preceding failed
   * attempt. The planner never echoes this object. */
  revisionContext: FocusedPlannerRevisionContextSchema.optional(),
});
export type FocusedPlannerInput = z.infer<typeof FocusedPlannerInputSchema>;
export const FocusedPlannerOutputSchema = strictObject({
  binding: FocusedPlannerBindingSchema,
  tool: PlannedTeachingToolSchema,
  chainEdges: z.array(ChainEdgeSchema),
  implementationPlan: ImplementationPlanPayloadSchema,
  reason: Reason,
});

const ScalarParameterValuesSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));
export const ApiResearchCandidateSchema = strictObject({
  workflow: WorkflowSchema,
  requestTransformSource: utf8Text(1, 100_000).optional(),
  parameterValues: ScalarParameterValuesSchema,
  testBackend: z
    .enum(['auto', 'fetch', 'fetch-bootstrap', 'cdp-replay', 'stealth-fetch'])
    .optional(),
});
export type ApiResearchCandidate = z.infer<typeof ApiResearchCandidateSchema>;
export const ApiResearchObservationSchema = strictObject({
  id: PromptIdSchema,
  candidateSha256: PromptShaSchema,
  executionMechanism: utf8Text(1, 128),
  backendAttempts: z.custom<BackendAttemptFact[]>().default([]),
  responseObservations: z.custom<BackendResponseObservation[]>().default([]),
  result: strictObject({
    ok: z.boolean(),
    error: utf8Text(1, 256).optional(),
    message: utf8Text(1, 4_000).optional(),
    preview: utf8Text(0, 12_000),
  }),
});
export type ApiResearchObservation = z.infer<typeof ApiResearchObservationSchema>;
export const ApiResearchInputSchema = strictObject({
  run: CurrentPlanBindingSchema,
  recordingIndex: RecordingIndexSchema,
  tool: EditableTeachingToolSchema,
  implementationPlan: ImplementationPlanPayloadSchema,
  evidence: PromptEvidenceProjectionSchema,
  observations: z.array(ApiResearchObservationSchema).max(64),
});
export type ApiResearchInput = z.infer<typeof ApiResearchInputSchema>;
const ApiResearchBindingSchema = strictObject({
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
});
export const ApiResearchOutputSchema = strictObject({
  binding: ApiResearchBindingSchema,
  action: z.enum(['test', 'proven', 'blocked']),
  candidate: ApiResearchCandidateSchema.optional(),
  basedOnObservationId: PromptIdSchema.optional(),
  reason: Reason,
});
export type ApiResearchOutput = z.infer<typeof ApiResearchOutputSchema>;
const HostedImplementationPlanSchema = strictObject({
  ref: ImplementationPlanRefSchema,
  payload: ImplementationPlanPayloadSchema,
}).superRefine((implementation, ctx) => {
  if (digest(implementation.payload) !== implementation.ref.sha256)
    schemaIssue(ctx, ['ref', 'sha256'], 'implementation plan payload hash mismatch');
  if (
    implementationPlanRequestProvenanceSha256(implementation.payload) !==
    implementation.ref.requestProvenanceSha256
  )
    schemaIssue(ctx, ['ref', 'requestProvenanceSha256'], 'request provenance hash mismatch');
});
const FocusedPlannerProposalPayloadSchema = strictObject({
  binding: PlannerProposalBindingSchema,
  tool: EditableTeachingToolSchema,
  chainEdges: z.array(ChainEdgeSchema),
  implementationPlan: HostedImplementationPlanSchema,
  reason: Reason,
}).superRefine((proposal, ctx) => {
  if (
    proposal.binding.toolId !== proposal.tool.id ||
    proposal.binding.compileInputsSha256 !==
      proposal.implementationPlan.ref.basedOnCompileInputsSha256
  )
    schemaIssue(ctx, ['binding'], 'planner proposal compile binding is stale');
  if (
    !proposal.tool.implementationPlan ||
    digest(proposal.tool.implementationPlan) !== digest(proposal.implementationPlan.ref) ||
    proposal.implementationPlan.ref.basedOnCompileInputsSha256 !==
      proposal.binding.compileInputsSha256
  )
    schemaIssue(
      ctx,
      ['implementationPlan', 'ref'],
      'hosted implementation plan does not bind the proposed tool',
    );
  if (
    proposal.implementationPlan.payload.toolId !== proposal.tool.id ||
    proposal.implementationPlan.payload.strategyKind !== proposal.tool.strategy?.kind
  )
    schemaIssue(
      ctx,
      ['implementationPlan', 'payload'],
      'implementation plan identity or strategy does not match the proposed tool',
    );
  const proposedParameters = proposal.tool.candidate.likelyParams.map(({ name }) => name).sort();
  const mappedParameters = proposal.implementationPlan.payload.parameterMappings
    .map(({ parameterName }) => parameterName)
    .sort();
  if (digest(proposedParameters) !== digest(mappedParameters))
    schemaIssue(
      ctx,
      ['implementationPlan', 'payload', 'parameterMappings'],
      'implementation plan parameter mappings do not match the proposed tool',
    );
  proposal.chainEdges.forEach((edge, index) => {
    if (edge.consumerToolId !== proposal.tool.id)
      schemaIssue(ctx, ['chainEdges', index], 'planner proposal edge belongs to another consumer');
  });
});
export const FocusedPlannerProposalSchema = contentProjection(FocusedPlannerProposalPayloadSchema);
const DiscoveryInputFields = {
  run: RunIdentitySchema,
  recordingIndex: RecordingIndexSchema,
  detectorSharedContext: TeachingCompileContextSchema,
  discoveryCandidates: z.array(SemanticToolCandidateSchema),
  evidence: PromptEvidenceProjectionSchema,
};
export const ToolSelectionAdvisorInputSchema = strictObject(DiscoveryInputFields);
export type ToolSelectionAdvisorInput = z.infer<typeof ToolSelectionAdvisorInputSchema>;
/** Narrow analyzer view. The full detector input remains the host validation boundary. */
export const ToolSelectionAdvisorPromptInputSchema = strictObject({
  run: RunIdentitySchema,
  recordingIndex: RecordingIndexSchema,
  discoveryCandidates: z.array(ToolBoundaryProposalSchema),
  evidence: PromptEvidenceProjectionSchema,
});
export const ToolSelectionAdvisorOutputSchema = strictObject({
  binding: RunIdentitySchema,
  boundaries: z.array(ToolBoundaryProposalSchema),
  concerns: z.array(Short).max(32),
  reason: Reason,
});
const MasterCurrentSchema = strictObject({
  run: CurrentPlanBindingSchema,
  plan: CurrentPlanProjectionSchema,
  snapshot: CurrentExecutionSnapshotSchema.optional(),
});
const ParameterAdviceSubmissionSchema = strictObject({
  toolId: PromptToolIdSchema,
  evidence: PromptEvidenceProjectionSchema,
  advice: z.lazy(() => ParameterSelectionAdvisorOutputSchema),
});
export const MasterDecisionInputSchema = strictObject({
  phase: z.enum(['discovery', 'revision']),
  discovery: ToolSelectionAdvisorInputSchema,
  current: MasterCurrentSchema.optional(),
  toolSelectionAdvice: ToolSelectionAdvisorOutputSchema.optional(),
  plannerProposals: z.array(FocusedPlannerProposalSchema),
  parameterAdvice: z.array(ParameterAdviceSubmissionSchema),
  verificationFindings: PromptEvidenceProjectionSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.phase === 'revision') !== Boolean(value.current))
    schemaIssue(ctx, ['current'], 'revision alone requires current-plan state');
  if (value.phase === 'discovery' && value.parameterAdvice.length)
    schemaIssue(ctx, ['parameterAdvice'], 'pre-plan decisions cannot carry parameter advice');
});
export type MasterDecisionInput = z.infer<typeof MasterDecisionInputSchema>;
const MasterDecisionBindingSchema = z.union([RunIdentitySchema, CurrentPlanBindingSchema]);
export const MasterDecisionOutputSchema = strictObject({
  binding: MasterDecisionBindingSchema,
  outcome: z.enum(['accepted', 'rejected', 'revised']),
  reason: Reason,
  /** Public tool names whose retained planner/compiler conversations need work. */
  recallToolNames: z.array(SemanticToolCandidateSchema.shape.toolName),
  desiredPlan: DesiredTeachingPlanSchema,
});
export const ParameterSelectionAdvisorInputSchema = strictObject({
  run: CurrentPlanBindingSchema,
  recordingIndex: RecordingIndexSchema,
  currentPlan: CurrentPlanProjectionSchema,
  snapshot: CurrentExecutionSnapshotSchema,
  toolId: PromptToolIdSchema,
  evidence: PromptEvidenceProjectionSchema,
});
export type ParameterSelectionAdvisorInput = z.infer<typeof ParameterSelectionAdvisorInputSchema>;
const ParameterAdvisorProducerSchema = strictObject({
  toolId: PromptToolIdSchema,
  toolName: SemanticToolCandidateSchema.shape.toolName,
  proof: ToolVerificationPayloadSchema,
}).superRefine((producer, ctx) => {
  if (producer.proof.toolId !== producer.toolId)
    schemaIssue(ctx, ['proof', 'toolId'], 'producer proof belongs to another tool');
});
/** Focused analyzer view issued only after the full parameter input validates. */
export const ParameterSelectionAdvisorPromptInputSchema = strictObject({
  run: CurrentPlanBindingSchema,
  targetTool: EditableTeachingToolSchema,
  targetProof: ToolVerificationPayloadSchema,
  incomingChainEdges: z.array(ChainEdgeSchema),
  producers: z.array(ParameterAdvisorProducerSchema),
  evidence: PromptEvidenceProjectionSchema,
}).superRefine((value, ctx) => {
  if (value.targetProof.toolId !== value.targetTool.id)
    schemaIssue(ctx, ['targetProof', 'toolId'], 'target proof belongs to another tool');
  value.incomingChainEdges.forEach((edge, index) => {
    if (edge.consumerToolId !== value.targetTool.id)
      schemaIssue(ctx, ['incomingChainEdges', index], 'incoming edge belongs to another consumer');
  });
  const expectedProducerIds = [
    ...new Set(value.incomingChainEdges.map(({ producerToolId }) => producerToolId)),
  ].sort();
  const actualProducerIds = value.producers.map(({ toolId }) => toolId).sort();
  if (digest(expectedProducerIds) !== digest(actualProducerIds))
    schemaIssue(ctx, ['producers'], 'producer proofs do not match incoming chain edges');
});
const ParameterAdviceBindingSchema = strictObject({
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
});
export const ParameterSelectionAdvisorOutputSchema = strictObject({
  binding: ParameterAdviceBindingSchema,
  likelyParams: z.array(TeachingParameterSchema).max(64),
  evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(16),
  concerns: z.array(Short).max(32),
  reason: Reason,
}).superRefine((value, ctx) => {
  const names = value.likelyParams.map(({ name }) => name);
  if (new Set(names).size !== names.length)
    schemaIssue(ctx, ['likelyParams'], 'duplicate parameter');
});
const ClaimSchema = strictObject({
  id: PromptIdSchema,
  kind: z.enum(['blocker', 'waiver', 'exclusion']),
  statement: Short,
  toolId: PromptToolIdSchema.optional(),
  evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(32),
});
const CompletionActualResultSchema = strictObject({
  observed: z.boolean(),
  preview: utf8Text(0, 2_000),
  shape: utf8Text(1, 512),
  count: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
/**
 * Controller-issued, already-redacted live result evidence. It is deliberately
 * separate from immutable receipts so receipts can stay value-free while the
 * independent completion reviewer sees enough bounded semantics to judge the
 * promised result.
 */
const CompletionToolResultEvidencePayloadSchema = strictObject({
  toolId: PromptToolIdSchema,
  toolName: SemanticToolCandidateSchema.shape.toolName,
  implementationPlanRef: ImplementationPlanRefSchema,
  verificationCaseId: PromptIdSchema,
  expectedResult: utf8Text(1, 2_000),
  resultReceiptRef: ContentAddressedRefSchema,
  chainEdgeId: PromptIdSchema.optional(),
  actualResult: CompletionActualResultSchema,
});
export const CompletionToolResultEvidenceSchema = contentProjection(
  CompletionToolResultEvidencePayloadSchema,
);
export type CompletionToolResultEvidence = z.infer<typeof CompletionToolResultEvidenceSchema>;
/**
 * Host-current input for the small semantic gate that decides whether one
 * mechanically verified build is a credible usable MVP. The richer host view
 * is validated before the analyzer receives the focused projection below.
 */
export const BaselineMvpReviewInputSchema = strictObject({
  run: CurrentPlanBindingSchema,
  recordingIndex: RecordingIndexSchema,
  currentPlan: CurrentPlanProjectionSchema,
  snapshot: CurrentExecutionSnapshotSchema,
  toolId: PromptToolIdSchema,
  resultEvidence: CompletionToolResultEvidenceSchema,
});
export type BaselineMvpReviewInput = z.infer<typeof BaselineMvpReviewInputSchema>;
const BaselineMvpReviewBindingSchema = CurrentPlanBindingSchema.extend({
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
  currentBuildRef: ContentAddressedRefSchema,
  executionBindingSha256: PromptShaSchema,
  resultReceiptRef: ContentAddressedRefSchema,
  resultEvidenceRef: ContentAddressedRefSchema,
}).strict();
export const BaselineMvpReviewerPromptInputSchema = strictObject({
  binding: BaselineMvpReviewBindingSchema,
  intendedOperation: strictObject({
    toolName: SemanticToolCandidateSchema.shape.toolName,
    description: SemanticToolCandidateSchema.shape.description,
    expectedOutput: SemanticToolCandidateSchema.shape.expectedOutput,
  }),
  baseline: strictObject({
    verificationCaseId: PromptIdSchema,
    expectedResult: utf8Text(1, 2_000),
    actualResult: CompletionActualResultSchema,
    resultEvidenceRef: ContentAddressedRefSchema,
    resultReceiptRef: ContentAddressedRefSchema,
    chainEdgeId: PromptIdSchema.optional(),
    /** Exact members of the one agent-declared chain invocation. */
    chainInvocationEdgeIds: z.array(PromptIdSchema).min(1).optional(),
  }),
}).superRefine((input, ctx) => {
  const { chainEdgeId, chainInvocationEdgeIds } = input.baseline;
  if (Boolean(chainEdgeId) !== Boolean(chainInvocationEdgeIds))
    schemaIssue(
      ctx,
      ['baseline', 'chainInvocationEdgeIds'],
      'chain invocation members are required exactly when a chain edge is present',
    );
  if (
    chainInvocationEdgeIds &&
    (new Set(chainInvocationEdgeIds).size !== chainInvocationEdgeIds.length ||
      (chainEdgeId !== undefined && !chainInvocationEdgeIds.includes(chainEdgeId)))
  )
    schemaIssue(
      ctx,
      ['baseline', 'chainInvocationEdgeIds'],
      'chain invocation members must be unique and include the receipt edge',
    );
});
export const BaselineMvpReviewOutputSchema = strictObject({
  binding: BaselineMvpReviewBindingSchema,
  status: z.enum(['credible', 'revision_required']),
  reason: Short,
  evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(4),
});
export const CompletionReviewInputSchema = strictObject({
  terminalIntent: z.enum(['completed', 'partial', 'blocked']),
  run: CurrentPlanBindingSchema,
  recordingIndex: RecordingIndexSchema,
  currentPlan: CurrentPlanProjectionSchema,
  snapshot: CurrentExecutionSnapshotSchema,
  history: ReceiptHistoryProjectionSchema,
  evidence: PromptEvidenceProjectionSchema,
  claims: z.array(ClaimSchema),
  /** Optional until the controller has captured a bounded result projection. */
  toolResultEvidence: z.array(CompletionToolResultEvidenceSchema).optional(),
});
export type CompletionReviewInput = z.infer<typeof CompletionReviewInputSchema>;
const FindingSchema = strictObject({
  severity: z.enum(['blocking', 'warning']),
  message: Short,
  toolId: PromptToolIdSchema.optional(),
  evidenceRefs: z.array(ContentAddressedRefSchema).max(32),
}).refine((finding) => finding.severity !== 'blocking' || finding.evidenceRefs.length > 0, {
  path: ['evidenceRefs'],
  message: 'blocking findings require evidence',
});
const CompletionToolResultReviewSchema = strictObject({
  toolId: PromptToolIdSchema,
  chainEdgeId: PromptIdSchema.optional(),
  status: z.enum(['credible', 'revision_required']),
  reason: Short,
  evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(32),
});
export const CompletionReviewOutputSchema = strictObject({
  binding: CurrentPlanBindingSchema,
  verdict: z.enum(['passed', 'failed']),
  summary: Reason,
  findings: z.array(FindingSchema),
  toolResultReviews: z.array(CompletionToolResultReviewSchema),
  claimDispositions: z.array(
    strictObject({
      claimId: PromptIdSchema,
      status: z.enum(['supported', 'unsupported']),
      reason: Short,
      evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(32),
    }),
  ),
}).superRefine((value, ctx) => {
  const blocking = value.findings.some(({ severity }) => severity === 'blocking');
  if ((value.verdict === 'passed') === blocking)
    schemaIssue(ctx, ['verdict'], 'verdict conflicts with blocking findings');
});
