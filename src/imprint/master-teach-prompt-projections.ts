/** Bounded factual projections. Store/controller code owns issuance and freshness. */
import { z } from 'zod';
import {
  ContentAddressedRefSchema,
  ImplementationPlanRefSchema,
  teachingPlanContentSha256 as digest,
} from './master-teach-plan.ts';
import { type Session, SessionSchema } from './types.ts';
export const PromptShaSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PromptIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const PromptToolIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
export const PromptCheckSchema = z.enum(['contract', 'replay', 'live', 'chain']);
export const PromptCheckStatusSchema = z.enum([
  'passed',
  'failed',
  'not_applicable',
  'not_checked',
]);
export function utf8Text(minBytes: number, maxBytes: number) {
  return z.string().refine((value) => {
    const bytes = Buffer.byteLength(value, 'utf8');
    return bytes >= minBytes && bytes <= maxBytes;
  }, `expected ${minBytes}..${maxBytes} UTF-8 bytes`);
}
/**
 * Store/controller receipt issuers must call this with their complete secret set.
 * The schemas below validate structure; they cannot discover or sanitize secrets.
 */
export function sanitizeHostError(message: string, secretValues: readonly string[]): string {
  let sanitized = message;
  for (const secret of [...new Set(secretValues)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.length <= 1_000) return sanitized || '[empty host error]';
  let end = 1_000;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString() || '[truncated host error]';
}
function issue(ctx: z.RefinementCtx, path: Array<string | number>, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
export { issue as schemaIssue };
const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
const refKey = (ref: z.infer<typeof ContentAddressedRefSchema>) => `${ref.path}\u0000${ref.sha256}`;
export function contentProjection<Schema extends z.ZodTypeAny>(schema: Schema) {
  return strictObject({ ref: ContentAddressedRefSchema, payload: schema }).superRefine(
    (value, ctx) => {
      if (digest(value.payload) !== value.ref.sha256)
        issue(ctx, ['ref', 'sha256'], 'projection payload hash mismatch');
    },
  );
}
export const RunIdentitySchema = strictObject({
  runId: PromptIdSchema,
  site: utf8Text(1, 255),
  recordingSha256: PromptShaSchema,
});
export const DiscoveryBindingSchema = RunIdentitySchema.extend({
  discoverySha256: PromptShaSchema,
}).strict();
export const RecordingIndexSchema = strictObject({
  recordingSha256: PromptShaSchema,
  requestSeqs: z.array(z.number().int().nonnegative()).max(50_000),
  eventSeqs: z.array(z.number().int().nonnegative()).max(50_000),
}).superRefine((value, ctx) => {
  for (const key of ['requestSeqs', 'eventSeqs'] as const) {
    if (new Set(value[key]).size !== value[key].length) issue(ctx, [key], `${key} must be unique`);
  }
});
export type RecordingIndex = z.infer<typeof RecordingIndexSchema>;
/** The controller supplies the hash of the exact verified recording file bytes. */
export function recordingIndexFromSession(
  sessionInput: Session,
  recordingSha256: string,
): RecordingIndex {
  const session = SessionSchema.parse(sessionInput);
  return RecordingIndexSchema.parse({
    recordingSha256,
    requestSeqs: session.requests.map(({ seq }) => seq),
    eventSeqs: session.events.map(({ seq }) => seq),
  });
}
const FactCore = {
  subject: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  status: PromptCheckStatusSchema,
};
const fact = <Shape extends z.ZodRawShape>(shape: Shape) => strictObject({ ...FactCore, ...shape });
export const ReceiptFactSchema = z
  .discriminatedUnion('kind', [
    fact({
      kind: z.literal('request_comparison'),
      requestIndex: z.number().int().nonnegative(),
      recordingSeq: z.number().int().nonnegative(),
      expectedBytes: z.number().int().nonnegative().optional(),
      actualBytes: z.number().int().nonnegative().optional(),
      firstMismatchByte: z.number().int().nonnegative().optional(),
      remainingComparisons: z.number().int().nonnegative(),
    }),
    fact({
      kind: z.literal('invocation'),
      invocationIndex: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative().optional(),
    }),
    fact({ kind: z.literal('result'), resultCount: z.number().int().nonnegative() }),
    fact({
      kind: z.literal('host_error'),
      status: z.literal('failed'),
      hostError: utf8Text(1, 1_000),
    }),
  ])
  .superRefine((fact, ctx) => {
    if (fact.kind !== 'request_comparison') return;
    const compared = fact.status === 'passed' || fact.status === 'failed';
    if (compared !== (fact.expectedBytes !== undefined && fact.actualBytes !== undefined))
      issue(ctx, ['expectedBytes'], 'checked comparisons require both byte lengths');
    if ((fact.status === 'failed') !== (fact.firstMismatchByte !== undefined))
      issue(ctx, ['firstMismatchByte'], 'failed comparisons alone require a first mismatch');
    if (
      fact.status === 'passed' &&
      fact.expectedBytes !== undefined &&
      fact.actualBytes !== undefined &&
      fact.expectedBytes !== fact.actualBytes
    )
      issue(ctx, ['actualBytes'], 'passed comparison byte lengths must match');
    if (
      fact.firstMismatchByte !== undefined &&
      fact.expectedBytes !== undefined &&
      fact.actualBytes !== undefined &&
      (fact.firstMismatchByte > Math.min(fact.expectedBytes, fact.actualBytes) ||
        (fact.firstMismatchByte === Math.min(fact.expectedBytes, fact.actualBytes) &&
          fact.expectedBytes === fact.actualBytes))
    )
      issue(ctx, ['firstMismatchByte'], 'first mismatch is outside the compared bytes');
  });
export type ReceiptFact = z.infer<typeof ReceiptFactSchema>;
function summarizedStatus(facts: readonly ReceiptFact[]) {
  if (facts.some(({ status }) => status === 'failed')) return 'failed';
  if (facts.some(({ status }) => status === 'not_checked')) return 'not_checked';
  if (facts.some(({ status }) => status === 'passed')) return 'passed';
  return 'not_applicable';
}
const MechanicalEvidenceSchema = strictObject({
  kind: z.literal('mechanical_fact'),
  ref: ContentAddressedRefSchema,
  requestSeqs: z.array(z.number().int().nonnegative()).max(128),
  eventSeqs: z.array(z.number().int().nonnegative()).max(128),
  toolId: PromptToolIdSchema.optional(),
  check: PromptCheckSchema.optional(),
  status: PromptCheckStatusSchema.optional(),
  facts: z.array(ReceiptFactSchema).min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  const count = [value.check, value.status, value.facts].filter(
    (item) => item !== undefined,
  ).length;
  if (count !== 0 && count !== 3)
    issue(ctx, ['check'], 'check, status, and facts must appear together');
  if (value.facts && value.status !== summarizedStatus(value.facts))
    issue(ctx, ['status'], 'status does not summarize facts');
});
export const PromptEvidencePayloadSchema = strictObject({
  entries: z
    .array(
      z.union([
        MechanicalEvidenceSchema,
        strictObject({
          kind: z.literal('untrusted_redacted_quote'),
          ref: ContentAddressedRefSchema,
          provenance: z.enum([
            'recording_request',
            'recording_response',
            'recording_event',
            'plan_note',
            'artifact_excerpt',
            'check_history',
          ]),
          quote: utf8Text(1, 4_000),
        }),
      ]),
    )
    .max(64),
}).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 96 * 1_024,
  'evidence exceeds 96 KiB',
);
export const PromptEvidenceProjectionSchema = contentProjection(PromptEvidencePayloadSchema);
export type PromptEvidenceProjection = z.infer<typeof PromptEvidenceProjectionSchema>;
export const DependencyExecutionBindingSchema = strictObject({
  toolId: PromptToolIdSchema,
  buildRef: ContentAddressedRefSchema,
  executionBindingSha256: PromptShaSchema,
});
const DependencyListSchema = z
  .array(DependencyExecutionBindingSchema)
  .max(32)
  .superRefine((dependencies, ctx) => {
    const ids = new Set<string>();
    const refs = new Set<string>();
    dependencies.forEach((dependency, index) => {
      if (ids.has(dependency.toolId)) issue(ctx, [index, 'toolId'], 'duplicate dependency');
      if (refs.has(refKey(dependency.buildRef)))
        issue(ctx, [index, 'buildRef'], 'duplicate build ref');
      ids.add(dependency.toolId);
      refs.add(refKey(dependency.buildRef));
    });
  });
/** Store/controller issues this binding, including the exact ordered replay targets. */
export const ToolExecutionBindingSchema = strictObject({
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  compileInputsSha256: PromptShaSchema,
  implementationPlan: ImplementationPlanRefSchema,
  strategyKind: z.enum(['api', 'playbook_fallback']),
  replayRequestSeqs: z.array(z.number().int().nonnegative()).max(256),
  artifactManifestRef: ContentAddressedRefSchema,
  sharedManifestRef: ContentAddressedRefSchema,
  dependencies: DependencyListSchema,
}).superRefine((binding, ctx) => {
  if (new Set(binding.replayRequestSeqs).size !== binding.replayRequestSeqs.length)
    issue(ctx, ['replayRequestSeqs'], 'replay request targets must be unique');
  if (binding.strategyKind === 'api' && binding.replayRequestSeqs.length === 0)
    issue(ctx, ['replayRequestSeqs'], 'API execution requires replay request targets');
  if (binding.strategyKind === 'playbook_fallback' && binding.replayRequestSeqs.length > 0)
    issue(ctx, ['replayRequestSeqs'], 'playbook replay request targets must be empty');
  if (binding.dependencies.some(({ toolId }) => toolId === binding.toolId))
    issue(ctx, ['dependencies'], 'execution binding cannot depend on itself');
});
export const ExecutionReceiptSchema = strictObject({
  id: PromptIdSchema,
  ref: ContentAddressedRefSchema,
  runId: PromptIdSchema,
  recordingSha256: PromptShaSchema,
  toolId: PromptToolIdSchema,
  check: PromptCheckSchema,
  chainEdgeId: PromptIdSchema.optional(),
  status: PromptCheckStatusSchema,
  buildRef: ContentAddressedRefSchema,
  executionBindingSha256: PromptShaSchema,
  dependencyBuilds: DependencyListSchema,
  facts: z.array(ReceiptFactSchema).min(1).max(256),
}).superRefine((receipt, ctx) => {
  if ((receipt.check === 'chain') !== Boolean(receipt.chainEdgeId))
    issue(ctx, ['chainEdgeId'], 'chain receipts alone require an edge id');
  if (receipt.check !== 'chain' && receipt.dependencyBuilds.length > 0)
    issue(ctx, ['dependencyBuilds'], 'non-chain receipts cannot claim dependency builds');
  if (receipt.status !== summarizedStatus(receipt.facts))
    issue(ctx, ['status'], 'receipt status does not summarize facts');
  const positions = receipt.facts.flatMap((fact, index) =>
    fact.kind === 'request_comparison' ? [index] : [],
  );
  if (positions.length > 1 && positions.at(-1) !== (positions[0] ?? 0) + positions.length - 1)
    issue(ctx, ['facts'], 'request comparisons must form one contiguous report');
});
export const ToolVerificationPayloadSchema = strictObject({
  toolId: PromptToolIdSchema,
  currentBuildRef: ContentAddressedRefSchema,
  artifactManifestRef: ContentAddressedRefSchema,
  executionBinding: ToolExecutionBindingSchema,
  executionBindingSha256: PromptShaSchema,
  receipts: z.array(ExecutionReceiptSchema).min(1).max(64),
}).superRefine((tool, ctx) => {
  const binding = tool.executionBinding;
  if (digest(binding) !== tool.executionBindingSha256)
    issue(ctx, ['executionBindingSha256'], 'execution binding hash mismatch');
  if (
    binding.toolId !== tool.toolId ||
    !same(binding.artifactManifestRef, tool.artifactManifestRef)
  )
    issue(ctx, ['executionBinding'], 'execution binding does not match tool');
  const keys = new Set<string>();
  const ids = new Set<string>();
  const refs = new Set<string>();
  tool.receipts.forEach((receipt, index) => {
    const key = receipt.check === 'chain' ? `chain:${receipt.chainEdgeId}` : receipt.check;
    if (keys.has(key)) issue(ctx, ['receipts', index, 'check'], 'duplicate current receipt');
    if (ids.has(receipt.id)) issue(ctx, ['receipts', index, 'id'], 'duplicate receipt id');
    if (refs.has(refKey(receipt.ref)))
      issue(ctx, ['receipts', index, 'ref'], 'duplicate receipt ref');
    if (
      receipt.runId !== binding.runId ||
      receipt.recordingSha256 !== binding.recordingSha256 ||
      receipt.toolId !== tool.toolId ||
      !same(receipt.buildRef, tool.currentBuildRef) ||
      receipt.executionBindingSha256 !== tool.executionBindingSha256
    )
      issue(ctx, ['receipts', index], 'receipt does not bind this exact execution');
    keys.add(key);
    ids.add(receipt.id);
    refs.add(refKey(receipt.ref));
  });
  const replay = tool.receipts.find(({ check }) => check === 'replay');
  if (!replay) return;
  const comparisons = replay.facts.filter(
    (fact): fact is Extract<ReceiptFact, { kind: 'request_comparison' }> =>
      fact.kind === 'request_comparison',
  );
  if (binding.strategyKind === 'playbook_fallback') {
    if (replay.status !== 'not_applicable')
      issue(ctx, ['receipts'], 'playbook replay must be not applicable');
    if (replay.facts.some(({ status }) => status !== 'not_applicable'))
      issue(ctx, ['receipts'], 'playbook replay facts must all be not applicable');
    if (comparisons.length)
      issue(ctx, ['receipts'], 'playbook replay cannot contain request comparisons');
    return;
  }
  if (replay.status === 'not_applicable')
    issue(ctx, ['receipts'], 'API replay cannot be not applicable');
  if (comparisons.length !== binding.replayRequestSeqs.length) {
    issue(ctx, ['receipts'], 'API replay must report every replay request target');
    return;
  }
  let stopped = false;
  comparisons.forEach((comparison, index) => {
    if (
      comparison.requestIndex !== index ||
      comparison.recordingSeq !== binding.replayRequestSeqs[index] ||
      comparison.remainingComparisons !== binding.replayRequestSeqs.length - index - 1
    )
      issue(ctx, ['receipts'], 'API replay report does not match exact ordered targets');
    if (comparison.status === 'not_applicable')
      issue(ctx, ['receipts'], 'API request comparisons cannot be not applicable');
    if (stopped && comparison.status !== 'not_checked')
      issue(ctx, ['receipts'], 'checked comparison follows a failed or unchecked target');
    if (comparison.status === 'failed' || comparison.status === 'not_checked') stopped = true;
  });
  const hostFailure = replay.facts.some(({ kind }) => kind === 'host_error');
  const comparisonFailure = comparisons.some(({ status }) => status === 'failed');
  if (replay.status === 'failed' && !comparisonFailure && !hostFailure) {
    issue(ctx, ['receipts'], 'failed replay needs a comparison mismatch or host error');
  }
  if (replay.status === 'passed' && comparisons.some(({ status }) => status !== 'passed')) {
    issue(ctx, ['receipts'], 'passed replay requires every target to pass');
  }
  if (replay.status === 'not_checked' && comparisons.every(({ status }) => status === 'passed')) {
    issue(ctx, ['receipts'], 'unchecked replay needs an unchecked target');
  }
});
export const CurrentExecutionSnapshotPayloadSchema = strictObject({
  run: RunIdentitySchema,
  currentPlanRef: ContentAddressedRefSchema,
  sharedManifestRef: ContentAddressedRefSchema,
  tools: z.array(ToolVerificationPayloadSchema).max(32),
}).superRefine((snapshot, ctx) => {
  const tools = new Map(snapshot.tools.map((tool) => [tool.toolId, tool]));
  const toolIds = new Set<string>();
  const receiptIds = new Set<string>();
  const receiptRefs = new Set<string>();
  snapshot.tools.forEach((tool, index) => {
    if (toolIds.has(tool.toolId)) issue(ctx, ['tools', index, 'toolId'], 'duplicate current tool');
    if (
      tool.executionBinding.runId !== snapshot.run.runId ||
      tool.executionBinding.recordingSha256 !== snapshot.run.recordingSha256
    )
      issue(ctx, ['tools', index], 'tool belongs to another run');
    if (!same(tool.executionBinding.sharedManifestRef, snapshot.sharedManifestRef))
      issue(ctx, ['tools', index], 'stale shared manifest');
    tool.receipts.forEach((receipt, receiptIndex) => {
      const key = refKey(receipt.ref);
      if (receiptIds.has(receipt.id))
        issue(
          ctx,
          ['tools', index, 'receipts', receiptIndex, 'id'],
          'duplicate current receipt id',
        );
      if (receiptRefs.has(key))
        issue(ctx, ['tools', index, 'receipts', receiptIndex], 'duplicate current receipt ref');
      receiptIds.add(receipt.id);
      receiptRefs.add(key);
    });
    tool.executionBinding.dependencies.forEach((dependency, dependencyIndex) => {
      const producer = tools.get(dependency.toolId);
      if (
        !producer ||
        !same(dependency.buildRef, producer.currentBuildRef) ||
        dependency.executionBindingSha256 !== producer.executionBindingSha256
      )
        issue(ctx, ['tools', index, 'dependencies', dependencyIndex], 'stale producer build');
    });
    toolIds.add(tool.toolId);
  });
});
export const CurrentExecutionSnapshotSchema = contentProjection(
  CurrentExecutionSnapshotPayloadSchema,
);
export type CurrentExecutionSnapshot = z.infer<typeof CurrentExecutionSnapshotSchema>;
export const ReceiptHistoryPayloadSchema = strictObject({
  run: RunIdentitySchema,
  historyRoot: ContentAddressedRefSchema,
  totalCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  entries: z
    .array(
      strictObject({ ordinal: z.number().int().nonnegative(), receipt: ExecutionReceiptSchema }),
    )
    .max(512),
}).superRefine((history, ctx) => {
  const expectedIncluded = Math.min(history.totalCount, 512);
  if (
    history.includedCount !== history.entries.length ||
    history.includedCount !== expectedIncluded
  )
    issue(ctx, ['includedCount'], 'receipt-history counts are inconsistent');
  if (history.truncated !== history.includedCount < history.totalCount)
    issue(ctx, ['truncated'], 'receipt-history truncation flag is inconsistent');
  const ids = new Set<string>();
  const refs = new Set<string>();
  history.entries.forEach(({ ordinal, receipt }, index) => {
    if (ordinal !== history.totalCount - index - 1)
      issue(ctx, ['entries', index, 'ordinal'], 'receipt history must be contiguous newest-first');
    if (ordinal >= history.totalCount)
      issue(ctx, ['entries', index, 'ordinal'], 'ordinal exceeds ledger size');
    if (ids.has(receipt.id))
      issue(ctx, ['entries', index, 'receipt', 'id'], 'duplicate receipt id');
    if (refs.has(refKey(receipt.ref)))
      issue(ctx, ['entries', index, 'receipt', 'ref'], 'duplicate receipt ref');
    if (
      receipt.runId !== history.run.runId ||
      receipt.recordingSha256 !== history.run.recordingSha256
    )
      issue(ctx, ['entries', index, 'receipt'], 'historical receipt belongs to another run');
    ids.add(receipt.id);
    refs.add(refKey(receipt.ref));
  });
});
export const ReceiptHistoryProjectionSchema = contentProjection(ReceiptHistoryPayloadSchema);
