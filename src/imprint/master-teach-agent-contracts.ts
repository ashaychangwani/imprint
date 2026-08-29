/** Strict wire contracts for four bounded, one-shot semantic roles. */
import { z } from 'zod';
import {
  ChainEdgeSchema,
  ContentAddressedRefSchema,
  DesiredTeachingPlanSchema,
  EditableTeachingPlanSchema,
  EditableTeachingToolSchema,
  ImplementationPlanRefSchema,
  TeachingCompileContextSchema,
  TeachingParameterSchema,
  TeachingToolCandidateSchema,
  teachingPlanContentSha256 as digest,
} from './master-teach-plan.ts';
import {
  CurrentExecutionSnapshotSchema,
  DiscoveryBindingSchema,
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
export const ROLE_OUTPUT_MAX_BYTES = 128 * 1_024;
const Reason = utf8Text(1, 4_000);
const Short = utf8Text(1, 1_000);
export { schemaIssue };
export function boundBytes(value: unknown, bytes: number, ctx: z.RefinementCtx): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes)
    schemaIssue(ctx, [], `payload exceeds ${bytes} UTF-8 bytes`);
}
const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const boundedObject = <Shape extends z.ZodRawShape>(shape: Shape, bytes: number) =>
  strictObject(shape).superRefine((value, ctx) => boundBytes(value, bytes, ctx));
export const SemanticToolCandidateSchema = TeachingToolCandidateSchema;
export type SemanticToolCandidate = z.infer<typeof SemanticToolCandidateSchema>;
export const ToolBoundaryProposalSchema = SemanticToolCandidateSchema.omit({
  likelyParams: true,
}).strict();
export const CurrentPlanProjectionSchema = contentProjection(EditableTeachingPlanSchema);
export type CurrentPlanProjection = z.infer<typeof CurrentPlanProjectionSchema>;
export const CurrentPlanBindingSchema = RunIdentitySchema.extend({
  planRevision: z.number().int().positive(),
  planSha256: PromptShaSchema,
}).strict();
export type CurrentPlanBinding = z.infer<typeof CurrentPlanBindingSchema>;
export const PlanRoleBindingSchema = CurrentPlanBindingSchema.extend({
  inputSha256: PromptShaSchema,
}).strict();
export const PlannerProposalBindingSchema = strictObject({
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  discoverySha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
});
export const FocusedPlannerProposalPayloadSchema = strictObject({
  binding: PlannerProposalBindingSchema,
  tool: EditableTeachingToolSchema,
  chainEdges: z.array(ChainEdgeSchema).max(32),
  reason: Reason,
});
export const FocusedPlannerProposalSchema = contentProjection(FocusedPlannerProposalPayloadSchema);
const DiscoveryInputFields = {
  run: DiscoveryBindingSchema,
  recordingIndex: RecordingIndexSchema,
  detectorSharedContext: TeachingCompileContextSchema,
  discoveryCandidates: z.array(SemanticToolCandidateSchema).max(32),
  evidence: PromptEvidenceProjectionSchema,
};
export const ToolSelectionAdvisorInputSchema = boundedObject(DiscoveryInputFields, 256 * 1_024);
export type ToolSelectionAdvisorInput = z.infer<typeof ToolSelectionAdvisorInputSchema>;
/** Narrow analyzer view. The full detector input remains the host validation boundary. */
export const ToolSelectionAdvisorPromptInputSchema = boundedObject(
  {
    run: DiscoveryBindingSchema,
    recordingIndex: RecordingIndexSchema,
    discoveryCandidates: z.array(ToolBoundaryProposalSchema).max(32),
    evidence: PromptEvidenceProjectionSchema,
  },
  256 * 1_024,
);
export type ToolSelectionAdvisorPromptInput = z.infer<typeof ToolSelectionAdvisorPromptInputSchema>;
export const ToolSelectionAdvisorOutputSchema = boundedObject(
  {
    binding: DiscoveryBindingSchema,
    boundaries: z.array(ToolBoundaryProposalSchema).max(32),
    concerns: z.array(Short).max(32),
    reason: Reason,
  },
  ROLE_OUTPUT_MAX_BYTES,
);
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
  plannerProposals: z.array(FocusedPlannerProposalSchema).max(32),
  authorizedRefs: strictObject({
    evidence: z.array(ContentAddressedRefSchema).max(256),
    implementationPlans: z.array(ImplementationPlanRefSchema).max(64),
  }),
  parameterAdvice: z.array(ParameterAdviceSubmissionSchema).max(32),
  verificationFindings: PromptEvidenceProjectionSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.phase === 'revision') !== Boolean(value.current))
    schemaIssue(ctx, ['current'], 'revision alone requires current-plan state');
  if (value.phase === 'discovery' && value.parameterAdvice.length)
    schemaIssue(ctx, ['parameterAdvice'], 'pre-plan decisions cannot carry parameter advice');
  boundBytes(value, 512 * 1_024, ctx);
});
export type MasterDecisionInput = z.infer<typeof MasterDecisionInputSchema>;
export const MasterDecisionOutputSchema = boundedObject(
  {
    binding: z.union([DiscoveryBindingSchema, PlanRoleBindingSchema]),
    outcome: z.enum(['accepted', 'rejected', 'revised']),
    reason: Reason,
    desiredPlan: DesiredTeachingPlanSchema,
  },
  ROLE_OUTPUT_MAX_BYTES,
);
export const ParameterSelectionAdvisorInputSchema = boundedObject(
  {
    run: CurrentPlanBindingSchema,
    recordingIndex: RecordingIndexSchema,
    currentPlan: CurrentPlanProjectionSchema,
    snapshot: CurrentExecutionSnapshotSchema,
    toolId: PromptToolIdSchema,
    evidence: PromptEvidenceProjectionSchema,
  },
  384 * 1_024,
);
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
export const ParameterSelectionAdvisorPromptInputSchema = boundedObject(
  {
    run: CurrentPlanBindingSchema,
    targetTool: EditableTeachingToolSchema,
    targetProof: ToolVerificationPayloadSchema,
    incomingChainEdges: z.array(ChainEdgeSchema).max(32),
    producers: z.array(ParameterAdvisorProducerSchema).max(32),
    evidence: PromptEvidenceProjectionSchema,
  },
  384 * 1_024,
).superRefine((value, ctx) => {
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
export type ParameterSelectionAdvisorPromptInput = z.infer<
  typeof ParameterSelectionAdvisorPromptInputSchema
>;
export const ParameterAdviceBindingSchema = strictObject({
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
  verificationSha256: PromptShaSchema,
  evidenceSha256: PromptShaSchema,
});
export const ParameterSelectionAdvisorOutputSchema = boundedObject(
  {
    binding: ParameterAdviceBindingSchema,
    likelyParams: z.array(TeachingParameterSchema).max(64),
    concerns: z.array(Short).max(32),
    reason: Reason,
  },
  ROLE_OUTPUT_MAX_BYTES,
).superRefine((value, ctx) => {
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
export const CompletionReviewInputSchema = boundedObject(
  {
    terminalIntent: z.enum(['completed', 'blocked']),
    run: CurrentPlanBindingSchema,
    recordingIndex: RecordingIndexSchema,
    currentPlan: CurrentPlanProjectionSchema,
    snapshot: CurrentExecutionSnapshotSchema,
    history: ReceiptHistoryProjectionSchema,
    evidence: PromptEvidenceProjectionSchema,
    claims: z.array(ClaimSchema).max(64),
  },
  768 * 1_024,
);
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
export const CompletionReviewOutputSchema = boundedObject(
  {
    binding: PlanRoleBindingSchema,
    verdict: z.enum(['passed', 'failed']),
    summary: Reason,
    findings: z.array(FindingSchema).max(64),
    claimDispositions: z
      .array(
        strictObject({
          claimId: PromptIdSchema,
          status: z.enum(['supported', 'unsupported']),
          reason: Short,
          evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(32),
        }),
      )
      .max(64),
  },
  ROLE_OUTPUT_MAX_BYTES,
).superRefine((value, ctx) => {
  const blocking = value.findings.some(({ severity }) => severity === 'blocking');
  if ((value.verdict === 'passed') === blocking)
    schemaIssue(ctx, ['verdict'], 'verdict conflicts with blocking findings');
});
export function discoveryContentSha256(input: Omit<ToolSelectionAdvisorInput, 'run'>): string {
  return digest({
    recordingIndex: input.recordingIndex,
    detectorSharedContext: input.detectorSharedContext,
    discoveryCandidates: input.discoveryCandidates,
    evidenceRef: input.evidence.ref,
  });
}
