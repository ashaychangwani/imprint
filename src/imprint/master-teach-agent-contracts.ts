/** Strict wire contracts for five bounded, one-shot semantic roles. */
import { z } from 'zod';
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
export const FocusedPlannerInputSchema = strictObject({
  run: RunIdentitySchema,
  recordingIndex: RecordingIndexSchema,
  tool: PlannableTeachingToolSchema,
  availableProducers: z.array(AvailableProducerSchema),
  incomingChainEdges: z.array(ChainEdgeSchema),
  outgoingChainEdges: z.array(ChainEdgeSchema),
  evidence: PromptEvidenceProjectionSchema,
});
export type FocusedPlannerInput = z.infer<typeof FocusedPlannerInputSchema>;
export const FocusedPlannerOutputSchema = strictObject({
  binding: FocusedPlannerBindingSchema,
  tool: PlannedTeachingToolSchema,
  chainEdges: z.array(ChainEdgeSchema),
  implementationPlan: ImplementationPlanPayloadSchema,
  reason: Reason,
});
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
  concerns: z.array(Short).max(32),
  reason: Reason,
}).superRefine((value, ctx) => {
  const names = value.likelyParams.map(({ name }) => name);
  if (new Set(names).size !== names.length)
    schemaIssue(ctx, ['likelyParams'], 'duplicate parameter');
});
const ClaimSchema = strictObject({
  id: PromptIdSchema,
  kind: z.enum(['blocker', 'waiver']),
  statement: Short,
  toolId: PromptToolIdSchema.optional(),
  evidenceRefs: z.array(ContentAddressedRefSchema).max(32),
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
  liveReceiptRef: ContentAddressedRefSchema,
  actualResult: CompletionActualResultSchema,
});
export const CompletionToolResultEvidenceSchema = contentProjection(
  CompletionToolResultEvidencePayloadSchema,
);
export type CompletionToolResultEvidence = z.infer<typeof CompletionToolResultEvidenceSchema>;
export const CompletionReviewInputSchema = strictObject({
  terminalIntent: z.enum(['completed', 'blocked']),
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
