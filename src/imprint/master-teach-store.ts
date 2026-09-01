/** Fresh-run, single-writer journal for master-driven teaching. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  type CompletionReviewInput,
  CompletionReviewInputSchema,
} from './master-teach-agent-contracts.ts';
import { mechanicalProofFailures, parseCompletionReviewOutput } from './master-teach-agents.ts';
// biome-ignore format: these are the complete plan mechanics owned by this journal
import { type ContentAddressedRef, ContentAddressedRefSchema, type DesiredTeachingPlan, type EditableTeachingPlan, type ImplementationPlanPayload, ImplementationPlanPayloadSchema, type TeachingPlanDecision, type TeachingPlanRevisionResult, type TeachingPlanValidation, TeachingPlanValidationError, bindImplementationPlanRef, canonicalTeachingPlanJson, chainInvocationForEdge, reviseEditableTeachingPlan, teachingPlanContentSha256, teachingToolCompileInputsSha256, validateBuildWorkflowProvenance, validateEditableTeachingPlan, validateImplementationPlanForTool } from './master-teach-plan.ts';
// biome-ignore format: these are the complete factual receipt/projection mechanics
import { type CurrentExecutionSnapshot, CurrentExecutionSnapshotSchema, ExecutionReceiptSchema, type ReceiptFact, ReceiptHistoryProjectionSchema, RunIdentitySchema, ToolExecutionBindingSchema, ToolVerificationPayloadSchema } from './master-teach-prompt-projections.ts';
import { WorkflowSchema } from './types.ts';

const FRESH_TEACH_JOURNAL_VERSION = 1 as const;
const ShaSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
const strict = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const issue = (ctx: z.RefinementCtx, path: Array<string | number>, message: string) =>
  ctx.addIssue({ code: 'custom', path, message });
const sameRef = (left: ContentAddressedRef, right: ContentAddressedRef) =>
  left.path === right.path && left.sha256 === right.sha256;
const refKey = (ref: ContentAddressedRef) => `${ref.path}\u0000${ref.sha256}`;
const safePath = (value: string) =>
  value === value.trim() &&
  !value.includes('\0') &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !/^[a-zA-Z]:/.test(part));
const LocalArtifactPathSchema = z.enum([
  'workflow.json',
  'playbook.yaml',
  'parser.ts',
  'request-transform.ts',
]);
const SharedArtifactPathSchema = z
  .string()
  .min(9)
  .max(1_024)
  .refine((path) => path.startsWith('_shared/') && safePath(path), 'invalid shared artifact path');
const CasFileSchema = strict({
  path: z.string().min(1).max(1_024),
  artifactRef: ContentAddressedRefSchema,
});
const uniqueFiles = (manifest: { files: readonly { path: string }[] }, ctx: z.RefinementCtx) => {
  const paths = new Set<string>();
  manifest.files.forEach((file, index) => {
    if (paths.has(file.path)) issue(ctx, ['files', index], 'duplicate artifact path');
    paths.add(file.path);
  });
};
export const ArtifactManifestRecordSchema = strict({
  files: z
    .array(CasFileSchema.extend({ path: LocalArtifactPathSchema }).strict())
    .min(1)
    .max(4),
}).superRefine((manifest, ctx) => {
  uniqueFiles(manifest, ctx);
  if (!manifest.files.some(({ path }) => path === 'workflow.json'))
    issue(ctx, ['files'], 'workflow.json is required');
});
export const SharedArtifactManifestRecordSchema = strict({
  files: z.array(CasFileSchema.extend({ path: SharedArtifactPathSchema }).strict()).max(1_024),
}).superRefine(uniqueFiles);
const PublicParameterSchema = strict({
  name: z.string().min(1).max(128),
  type: z.enum(['string', 'number', 'boolean']),
});
const StoredBuildRecordSchema = strict({
  toolId: ToolIdSchema,
  site: z.string().min(1).max(255),
  publicParameters: z.array(PublicParameterSchema).max(64),
  workflowRef: ContentAddressedRefSchema,
  artifactManifestRef: ContentAddressedRefSchema,
  executionBinding: ToolExecutionBindingSchema,
  executionBindingSha256: ShaSchema,
}).refine(
  (build) =>
    teachingPlanContentSha256(build.executionBinding) === build.executionBindingSha256 &&
    build.executionBinding.toolId === build.toolId &&
    sameRef(build.executionBinding.artifactManifestRef, build.artifactManifestRef) &&
    new Set(build.publicParameters.map(({ name }) => name)).size === build.publicParameters.length,
  'build binding mismatch',
);
type StoredBuildRecord = z.infer<typeof StoredBuildRecordSchema>;
const ReceiptPointerSchema = strict({
  key: z.string().regex(/^(contract|replay|live|chain:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/),
  ref: ContentAddressedRefSchema,
});
const JournalToolStateSchema = strict({
  toolId: ToolIdSchema,
  buildRef: ContentAddressedRefSchema.optional(),
  currentReceiptRefs: z.array(ReceiptPointerSchema),
});
// biome-ignore format: this is the complete, closed terminal status set
export const FreshTeachRunStatusSchema = z.enum(['active', 'completed', 'blocked', 'failed', 'cancelled', 'provider_unavailable']);
export type FreshTeachRunStatus = z.infer<typeof FreshTeachRunStatusSchema>;
export const FreshTeachJournalStateSchema = strict({
  version: z.literal(FRESH_TEACH_JOURNAL_VERSION),
  run: RunIdentitySchema,
  status: FreshTeachRunStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentPlanRef: ContentAddressedRefSchema,
  supersededPlanRefs: z.array(ContentAddressedRefSchema).max(10_000),
  sharedManifestRef: ContentAddressedRefSchema,
  tools: z.array(JournalToolStateSchema),
  supersededReceiptRefs: z.array(ContentAddressedRefSchema).max(1_000_000),
  nextReceiptOrdinal: z.number().int().nonnegative(),
  completionReviewRef: ContentAddressedRefSchema.optional(),
  terminalHostError: z.string().min(1).max(1_000).optional(),
}).superRefine((state, ctx) => {
  const toolIds = new Set<string>();
  const currentReceipts = new Set<string>();
  state.tools.forEach((tool, toolIndex) => {
    if (toolIds.has(tool.toolId)) issue(ctx, ['tools', toolIndex], 'duplicate tool id');
    if (!tool.buildRef && tool.currentReceiptRefs.length)
      issue(ctx, ['tools', toolIndex], 'receipts require a build');
    const checks = new Set<string>();
    tool.currentReceiptRefs.forEach((pointer, receiptIndex) => {
      const key = refKey(pointer.ref);
      if (checks.has(pointer.key) || currentReceipts.has(key))
        issue(ctx, ['tools', toolIndex, 'currentReceiptRefs', receiptIndex], 'duplicate receipt');
      checks.add(pointer.key);
      currentReceipts.add(key);
    });
    toolIds.add(tool.toolId);
  });
  const history = new Set<string>();
  state.supersededReceiptRefs.forEach((ref, index) => {
    const key = refKey(ref);
    if (history.has(key) || currentReceipts.has(key))
      issue(ctx, ['supersededReceiptRefs', index], 'duplicate or current history receipt');
    history.add(key);
  });
  const planHistory = new Set<string>();
  state.supersededPlanRefs.forEach((ref, index) => {
    const key = refKey(ref);
    if (planHistory.has(key) || sameRef(ref, state.currentPlanRef))
      issue(ctx, ['supersededPlanRefs', index], 'duplicate or current plan history ref');
    planHistory.add(key);
  });
  if (state.status === 'active' && state.terminalHostError)
    issue(ctx, ['terminalHostError'], 'active run has a terminal error');
  if (['completed', 'blocked'].includes(state.status) && !state.completionReviewRef)
    issue(ctx, ['completionReviewRef'], 'reviewed terminal status requires a completion review');
});
type FreshTeachJournalState = z.infer<typeof FreshTeachJournalStateSchema>;
const CompletionReviewRecordSchema = strict({
  terminalIntent: z.enum(['completed', 'blocked']),
  inputRef: ContentAddressedRefSchema,
  outputRef: ContentAddressedRefSchema,
  currentPlanRef: ContentAddressedRefSchema,
  snapshotRef: ContentAddressedRefSchema,
  historyRef: ContentAddressedRefSchema,
});
type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
type ReceiptHistoryProjection = z.infer<typeof ReceiptHistoryProjectionSchema>;
type ReceiptBody = Omit<ExecutionReceipt, 'ref'>;
export type FreshTeachBootstrapObject =
  | { ref: ContentAddressedRef; kind: 'json'; value: unknown }
  | { ref: ContentAddressedRef; kind: 'bytes'; value: string | Uint8Array };
const JournalErrorMessages = {
  bootstrap_ref_mismatch: 'bootstrap object ref mismatch',
  chain_edge_mismatch: 'chain receipt does not match a current edge',
  chain_producer_missing: 'chain producer has no current build with a passed live result',
  completion_input_stale: 'completion review input is not current',
  completion_intent_mismatch: 'completion review intent does not match terminal status',
  completion_proof_incomplete: 'completion proof is incomplete',
  completion_review_failed: 'completion review did not pass',
  completion_review_missing: 'current passed completion review is required',
  completion_review_stale: 'completion review is stale',
  content_hash_mismatch: 'content object hash mismatch',
  content_invalid_json: 'content object is not valid JSON',
  content_path_mismatch: 'content reference path does not match its hash',
  module_missing: 'referenced module is absent from its manifest',
  module_path_invalid: 'module path must be a valid local or shared module path',
  parameter_type_missing: 'an accepted public parameter needs a concrete type',
  receipt_facts_missing: 'receipt requires factual evidence',
  receipt_invalid: 'receipt facts do not match the current build and check',
  root_exists: 'fresh run root already exists',
  run_identity_mismatch: 'run identity does not match recording validation',
  state_unreadable: 'current state is unreadable',
  terminal_run: 'fresh teach run is terminal',
  tool_plan_missing: 'tool has no accepted implementation plan',
  workflow_parameters_mismatch: 'workflow parameters do not match accepted public parameters',
  workflow_provenance_mismatch: 'workflow request provenance does not match the accepted plan',
  workflow_schema_invalid: 'workflow schema is invalid',
  workflow_site_mismatch: 'workflow site mismatch',
  workflow_tool_mismatch: 'workflow tool name does not match accepted tool',
} as const;
type JournalErrorCode = keyof typeof JournalErrorMessages;
class FreshTeachJournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, detail?: string) {
    super(detail ? `${JournalErrorMessages[code]}: ${detail}` : JournalErrorMessages[code]);
    this.name = 'FreshTeachJournalError';
    this.code = code;
  }
}
const journalFailure = (code: JournalErrorCode, detail?: string) =>
  new FreshTeachJournalError(code, detail);
const RepairableBuildErrorCodes = new Set<JournalErrorCode>([
  'module_missing',
  'module_path_invalid',
  'parameter_type_missing',
  'workflow_parameters_mismatch',
  'workflow_provenance_mismatch',
  'workflow_schema_invalid',
  'workflow_site_mismatch',
  'workflow_tool_mismatch',
]);

/** True only for deterministic generated-artifact defects that the compiler or
 * master can repair. Journal state, content-store, and I/O failures stay host
 * errors and must never be blamed on agent output. */
export function isRepairableBuildArtifactError(error: unknown): boolean {
  return error instanceof FreshTeachJournalError && RepairableBuildErrorCodes.has(error.code);
}
const bytesSha256 = (value: Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const asBytes = (value: string | Uint8Array) =>
  typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
const hostErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};
const receiptStatus = (facts: readonly ReceiptFact[]): ExecutionReceipt['status'] => {
  if (facts.some(({ status }) => status === 'failed')) return 'failed';
  if (facts.some(({ status }) => status === 'not_checked')) return 'not_checked';
  if (facts.some(({ status }) => status === 'passed')) return 'passed';
  return 'not_applicable';
};
const receiptKey = (check: ExecutionReceipt['check'], edge?: string) =>
  check === 'chain' ? `chain:${edge}` : check;

export class FreshTeachJournal {
  readonly root: string;
  readonly #validation: TeachingPlanValidation;
  readonly #now: () => string;
  #temporaryOrdinal = 0;
  private constructor(root: string, validation: TeachingPlanValidation, now: () => string) {
    this.root = root;
    this.#validation = validation;
    this.#now = now;
  }
  static create(input: {
    root: string;
    run: z.input<typeof RunIdentitySchema>;
    plan: EditableTeachingPlan;
    validation: TeachingPlanValidation;
    sharedManifest: unknown;
    bootstrap?: readonly FreshTeachBootstrapObject[];
    now?: () => string;
  }): FreshTeachJournal {
    const validation = input.validation;
    const root = resolve(input.root);
    if (existsSync(root)) throw journalFailure('root_exists');
    const run = RunIdentitySchema.parse(input.run);
    if (run.site !== validation.site || run.recordingSha256 !== validation.recordingSha256)
      throw journalFailure('run_identity_mismatch');
    const plan = validateEditableTeachingPlan(input.plan, validation);
    const shared = SharedArtifactManifestRecordSchema.parse(input.sharedManifest);
    mkdirSync(root, { mode: 0o700 });
    const journal = new FreshTeachJournal(
      root,
      validation,
      input.now ?? (() => new Date().toISOString()),
    );
    for (const seed of input.bootstrap ?? []) journal.#seed(seed);
    journal.#verifyManifest(shared);
    const currentPlanRef = journal.#putJson(plan);
    const sharedManifestRef = journal.#putJson(shared);
    const timestamp = journal.#now();
    journal.#writeState({
      version: FRESH_TEACH_JOURNAL_VERSION,
      run,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      currentPlanRef,
      supersededPlanRefs: [],
      sharedManifestRef,
      tools: plan.tools.map(({ id }) => ({ toolId: id, currentReceiptRefs: [] })),
      supersededReceiptRefs: [],
      nextReceiptOrdinal: 0,
    });
    return journal;
  }
  #objectRef(kind: 'json' | 'bytes', value: Uint8Array): ContentAddressedRef {
    const sha256 = bytesSha256(value);
    const hex = sha256.slice(7);
    return ContentAddressedRefSchema.parse({
      path: `objects/${kind}/${hex}.${kind === 'json' ? 'json' : 'bin'}`,
      sha256,
    });
  }
  #objectPath(ref: ContentAddressedRef, expectedKind?: 'json' | 'bytes'): string {
    const parsed = ContentAddressedRefSchema.parse({ path: ref.path, sha256: ref.sha256 });
    const hex = parsed.sha256.slice(7);
    const jsonPath = `objects/json/${hex}.json`;
    const bytesPath = `objects/bytes/${hex}.bin`;
    if (
      (expectedKind === 'json' && parsed.path !== jsonPath) ||
      (expectedKind === 'bytes' && parsed.path !== bytesPath) ||
      (parsed.path !== jsonPath && parsed.path !== bytesPath)
    )
      throw journalFailure('content_path_mismatch');
    return resolve(this.root, parsed.path);
  }
  #ensureDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  #atomicWrite(target: string, value: string | Uint8Array): void {
    const directory = dirname(target);
    this.#ensureDirectory(directory);
    const temporary = `${target}.tmp-${process.pid}-${this.#temporaryOrdinal++}`;
    try {
      writeFileSync(temporary, value, { mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }
  #readObject(ref: ContentAddressedRef, kind?: 'json' | 'bytes'): Uint8Array {
    const value = readFileSync(this.#objectPath(ref, kind));
    if (bytesSha256(value) !== ref.sha256) throw journalFailure('content_hash_mismatch');
    return value;
  }
  #putObject(kind: 'json' | 'bytes', value: Uint8Array): ContentAddressedRef {
    const ref = this.#objectRef(kind, value);
    const path = this.#objectPath(ref, kind);
    if (!existsSync(path)) this.#atomicWrite(path, value);
    return ref;
  }
  #putJson(value: unknown): ContentAddressedRef {
    return this.#putObject('json', Buffer.from(canonicalTeachingPlanJson(value), 'utf8'));
  }
  #seed(seed: FreshTeachBootstrapObject): void {
    const actual =
      seed.kind === 'json'
        ? this.#putJson(seed.value)
        : this.#putObject('bytes', asBytes(seed.value));
    if (!sameRef(actual, seed.ref)) throw journalFailure('bootstrap_ref_mismatch');
  }
  storeJson(value: unknown): ContentAddressedRef {
    this.#assertActive(this.readState());
    return this.#putJson(value);
  }
  storeBytes(value: string | Uint8Array): ContentAddressedRef {
    this.#assertActive(this.readState());
    return this.#putObject('bytes', asBytes(value));
  }
  readJson(ref: ContentAddressedRef): unknown {
    try {
      return JSON.parse(Buffer.from(this.#readObject(ref, 'json')).toString('utf8'));
    } catch (error) {
      if (error instanceof FreshTeachJournalError) throw error;
      throw journalFailure('content_invalid_json');
    }
  }
  readBytes(ref: ContentAddressedRef): Uint8Array {
    return this.#readObject(ref, 'bytes');
  }
  #writeState(value: FreshTeachJournalState): void {
    const state = FreshTeachJournalStateSchema.parse(value);
    this.#atomicWrite(join(this.root, 'current.json'), canonicalTeachingPlanJson(state));
  }
  readState(): FreshTeachJournalState {
    try {
      return FreshTeachJournalStateSchema.parse(
        JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')),
      );
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw journalFailure('state_unreadable');
    }
  }
  #assertActive(state: FreshTeachJournalState): void {
    if (state.status !== 'active') throw journalFailure('terminal_run');
  }
  #commit(state: FreshTeachJournalState): FreshTeachJournalState {
    state.updatedAt = this.#now();
    this.#writeState(state);
    return FreshTeachJournalStateSchema.parse(state);
  }
  #verifyManifest(manifest: { files: readonly { artifactRef: ContentAddressedRef }[] }): void {
    for (const { artifactRef } of manifest.files) this.#readObject(artifactRef);
  }
  readSharedManifest(ref: ContentAddressedRef) {
    return SharedArtifactManifestRecordSchema.parse(this.readJson(ref));
  }
  #plan(state: FreshTeachJournalState): EditableTeachingPlan {
    return validateEditableTeachingPlan(this.readJson(state.currentPlanRef), this.#validation);
  }
  currentPlan(): EditableTeachingPlan {
    const state = this.readState();
    return this.#plan(state);
  }
  storeImplementationPlan(payloadValue: ImplementationPlanPayload, compileSha256: string) {
    this.#assertActive(this.readState());
    const payload = ImplementationPlanPayloadSchema.parse(payloadValue);
    const ref = this.#putJson(payload);
    return bindImplementationPlanRef(ref, payload, compileSha256);
  }
  #archive(
    state: FreshTeachJournalState,
    pointers: readonly z.infer<typeof ReceiptPointerSchema>[],
  ) {
    state.supersededReceiptRefs.push(...pointers.map(({ ref }) => ref));
  }
  #invalidateChainsUsingProducer(state: FreshTeachJournalState, producerToolId: string): void {
    for (const current of state.tools) {
      if (current.toolId === producerToolId) continue;
      const stale = current.currentReceiptRefs.filter((pointer) => {
        if (!pointer.key.startsWith('chain:')) return false;
        return this.readReceipt(pointer.ref).dependencyBuilds.some(
          (dependency) => dependency.toolId === producerToolId,
        );
      });
      this.#archive(state, stale);
      current.currentReceiptRefs = current.currentReceiptRefs.filter(
        ({ ref }) => !stale.some((pointer) => sameRef(pointer.ref, ref)),
      );
    }
  }
  #clearReview(state: FreshTeachJournalState): void {
    state.completionReviewRef = undefined;
  }
  revisePlan(
    desiredPlan: DesiredTeachingPlan,
    options: { expectedRevision: number; decision: TeachingPlanDecision },
  ): TeachingPlanRevisionResult {
    const state = this.readState();
    this.#assertActive(state);
    const priorPlan = this.#plan(state);
    const result = reviseEditableTeachingPlan(priorPlan, desiredPlan, options, this.#validation);
    const nextPlanRef = this.#putJson(result.plan);
    const prior = new Map(state.tools.map((tool) => [tool.toolId, tool]));
    const recompile = new Set(result.recompileToolIds);
    const invalidatedProducerIds = new Set([...result.recompileToolIds, ...result.removedToolIds]);
    const priorEdges = new Map(priorPlan.chainEdges.map((edge) => [edge.id, edge] as const));
    const nextEdges = new Map(result.plan.chainEdges.map((edge) => [edge.id, edge] as const));
    const invocationKey = (edge: (typeof priorPlan.chainEdges)[number]) =>
      canonicalTeachingPlanJson([
        edge.consumerToolId,
        edge.invocationGroup === undefined ? { edgeId: edge.id } : { group: edge.invocationGroup },
      ]);
    const invalidatedInvocationKeys = new Set<string>();
    for (const edgeId of result.changedChainEdgeIds) {
      const priorEdge = priorEdges.get(edgeId);
      const nextEdge = nextEdges.get(edgeId);
      if (priorEdge) invalidatedInvocationKeys.add(invocationKey(priorEdge));
      if (nextEdge) invalidatedInvocationKeys.add(invocationKey(nextEdge));
    }
    for (const id of result.removedToolIds)
      this.#archive(state, prior.get(id)?.currentReceiptRefs ?? []);
    state.tools = result.plan.tools.map(({ id }) => {
      const old = prior.get(id) ?? { toolId: id, currentReceiptRefs: [] };
      const rebuild = recompile.has(id);
      const obsoleteReceipts = rebuild
        ? old.currentReceiptRefs
        : old.currentReceiptRefs.filter((pointer) => {
            if (!pointer.key.startsWith('chain:')) return false;
            const receipt = this.readReceipt(pointer.ref);
            const edge = receipt.chainEdgeId ? priorEdges.get(receipt.chainEdgeId) : undefined;
            return (
              !edge ||
              invalidatedInvocationKeys.has(invocationKey(edge)) ||
              receipt.dependencyBuilds.some(({ toolId }) => invalidatedProducerIds.has(toolId))
            );
          });
      this.#archive(state, obsoleteReceipts);
      return {
        toolId: id,
        ...(!rebuild && old.buildRef ? { buildRef: old.buildRef } : {}),
        currentReceiptRefs: rebuild
          ? []
          : old.currentReceiptRefs.filter(
              ({ ref }) => !obsoleteReceipts.some((obsolete) => sameRef(obsolete.ref, ref)),
            ),
      };
    });
    state.supersededPlanRefs.push(state.currentPlanRef);
    state.currentPlanRef = nextPlanRef;
    this.#clearReview(state);
    this.#commit(state);
    return result;
  }
  updateSharedManifest(value: unknown): FreshTeachJournalState {
    const state = this.readState();
    this.#assertActive(state);
    const manifest = SharedArtifactManifestRecordSchema.parse(value);
    this.#verifyManifest(manifest);
    const nextRef = this.#putJson(manifest);
    if (sameRef(nextRef, state.sharedManifestRef)) return state;
    for (const tool of state.tools) {
      this.#archive(state, tool.currentReceiptRefs);
      tool.buildRef = undefined;
      tool.currentReceiptRefs = [];
    }
    state.sharedManifestRef = nextRef;
    this.#clearReview(state);
    return this.#commit(state);
  }
  #moduleEntry(
    moduleRef: string,
    local: z.infer<typeof ArtifactManifestRecordSchema>,
    shared: z.infer<typeof SharedArtifactManifestRecordSchema>,
  ) {
    let path: string;
    let files: readonly { path: string; artifactRef: ContentAddressedRef }[];
    if (moduleRef.startsWith('./')) {
      path = moduleRef.slice(2);
      if (!LocalArtifactPathSchema.safeParse(path).success)
        throw journalFailure('module_path_invalid');
      files = local.files;
    } else if (moduleRef.startsWith('../_shared/')) {
      path = moduleRef.slice(3);
      if (!SharedArtifactPathSchema.safeParse(path).success)
        throw journalFailure('module_path_invalid');
      files = shared.files;
    } else {
      throw journalFailure('module_path_invalid');
    }
    const entry = files.find((file) => file.path === path);
    if (!entry) throw journalFailure('module_missing');
    return entry;
  }
  #assertWorkflow(
    workflow: z.infer<typeof WorkflowSchema>,
    build: Pick<StoredBuildRecord, 'site' | 'publicParameters'>,
    local: z.infer<typeof ArtifactManifestRecordSchema>,
    shared: z.infer<typeof SharedArtifactManifestRecordSchema>,
  ): void {
    if (workflow.site !== build.site) throw journalFailure('workflow_site_mismatch');
    const actual = workflow.parameters
      .map(({ name, type }) => ({ name, type }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const expected = [...build.publicParameters].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    if (canonicalTeachingPlanJson(actual) !== canonicalTeachingPlanJson(expected))
      throw journalFailure('workflow_parameters_mismatch');
    if (workflow.parserModule) this.#moduleEntry(workflow.parserModule, local, shared);
    if (workflow.requestTransformModule)
      this.#moduleEntry(workflow.requestTransformModule, local, shared);
  }
  #assertWorkflowProvenance(
    workflow: z.infer<typeof WorkflowSchema>,
    implementation: ImplementationPlanPayload,
  ): void {
    try {
      validateBuildWorkflowProvenance(workflow, implementation);
    } catch (error) {
      if (error instanceof TeachingPlanValidationError)
        throw journalFailure('workflow_provenance_mismatch');
      throw error;
    }
  }
  issueBuild(input: {
    toolId: string;
    workflow: unknown;
    artifacts?: readonly { path: string; artifactRef: ContentAddressedRef }[];
  }): { ref: ContentAddressedRef; record: StoredBuildRecord } {
    const state = this.readState();
    this.#assertActive(state);
    const plan = this.#plan(state);
    const tool = plan.tools.find(({ id }) => id === input.toolId);
    const toolState = state.tools.find(({ toolId }) => toolId === input.toolId);
    if (!tool || !toolState || !tool.implementationPlan || !tool.strategy)
      throw journalFailure('tool_plan_missing');
    const implementation = validateImplementationPlanForTool(
      this.readJson(tool.implementationPlan),
      tool,
      this.#validation.requestSeqs,
    );
    const parsedWorkflow = WorkflowSchema.safeParse(input.workflow);
    if (!parsedWorkflow.success) {
      const detail = parsedWorkflow.error.issues
        .slice(0, 12)
        .map(({ path, message }) => `${path.join('.') || '<root>'}: ${message}`)
        .join('; ');
      throw journalFailure('workflow_schema_invalid', detail);
    }
    const workflow = parsedWorkflow.data;
    this.#assertWorkflowProvenance(workflow, implementation);
    if (workflow.toolName !== tool.candidate.toolName)
      throw journalFailure('workflow_tool_mismatch');
    const publicParameters = tool.candidate.likelyParams.map(({ name, type }) => {
      if (!type) throw journalFailure('parameter_type_missing');
      return { name, type };
    });
    const workflowRef = this.#putJson(workflow);
    const manifest = ArtifactManifestRecordSchema.parse({
      files: [{ path: 'workflow.json', artifactRef: workflowRef }, ...(input.artifacts ?? [])],
    });
    this.#verifyManifest(manifest);
    const shared = this.readSharedManifest(state.sharedManifestRef);
    this.#assertWorkflow(workflow, { site: state.run.site, publicParameters }, manifest, shared);
    const artifactManifestRef = this.#putJson(manifest);
    const executionBinding = ToolExecutionBindingSchema.parse({
      runId: state.run.runId,
      recordingSha256: state.run.recordingSha256,
      toolId: tool.id,
      compileInputsSha256: teachingToolCompileInputsSha256(tool, plan.chainEdges),
      implementationPlan: tool.implementationPlan,
      strategyKind: tool.strategy.kind,
      requestProvenance: implementation.requestProvenance,
      artifactManifestRef,
      sharedManifestRef: state.sharedManifestRef,
    });
    const record = StoredBuildRecordSchema.parse({
      toolId: tool.id,
      site: state.run.site,
      publicParameters,
      workflowRef,
      artifactManifestRef,
      executionBinding,
      executionBindingSha256: teachingPlanContentSha256(executionBinding),
    });
    const ref = this.#putJson(record);
    if (toolState.buildRef && sameRef(toolState.buildRef, ref)) return { ref, record };
    const priorBuildRef = toolState.buildRef;
    this.#archive(state, toolState.currentReceiptRefs);
    toolState.currentReceiptRefs = [];
    if (priorBuildRef) this.#invalidateChainsUsingProducer(state, tool.id);
    toolState.buildRef = ref;
    this.#clearReview(state);
    this.#commit(state);
    return { ref, record };
  }
  readBuild(ref: ContentAddressedRef): StoredBuildRecord {
    return StoredBuildRecordSchema.parse(this.readJson(ref));
  }
  readReceipt(ref: ContentAddressedRef): ExecutionReceipt {
    const body = this.readJson(ref) as ReceiptBody;
    return ExecutionReceiptSchema.parse({ ...body, ref });
  }
  issueReceipt(input: {
    toolId: string;
    check: ExecutionReceipt['check'];
    chainEdgeId?: string;
    facts?: readonly ReceiptFact[];
    hostError?: unknown;
  }): ExecutionReceipt {
    const state = this.readState();
    this.#assertActive(state);
    const plan = this.#plan(state);
    const toolState = state.tools.find(({ toolId }) => toolId === input.toolId);
    if (!toolState?.buildRef) throw journalFailure('tool_plan_missing');
    const build = this.readBuild(toolState.buildRef);
    const chainDependencies: ExecutionReceipt['dependencyBuilds'] = [];
    let chainEdgeSha256: string | undefined;
    if (input.check === 'chain') {
      const edge = plan.chainEdges.find(({ id }) => id === input.chainEdgeId);
      if (!edge || edge.consumerToolId !== input.toolId)
        throw journalFailure('chain_edge_mismatch');
      chainEdgeSha256 = teachingPlanContentSha256(edge);
      const producerIds = [
        ...new Set(
          chainInvocationForEdge(plan.chainEdges, edge).edges.map(
            ({ producerToolId }) => producerToolId,
          ),
        ),
      ].sort();
      for (const producerToolId of producerIds) {
        const producerState = state.tools.find(({ toolId }) => toolId === producerToolId);
        if (!producerState?.buildRef) throw journalFailure('chain_producer_missing');
        const producerBuild = this.readBuild(producerState.buildRef);
        const producerLivePointer = producerState.currentReceiptRefs.find(
          ({ key }) => key === 'live',
        );
        const producerLive = producerLivePointer
          ? this.readReceipt(producerLivePointer.ref)
          : undefined;
        if (
          producerLive?.check !== 'live' ||
          producerLive.status !== 'passed' ||
          !sameRef(producerLive.buildRef, producerState.buildRef) ||
          producerLive.executionBindingSha256 !== producerBuild.executionBindingSha256
        ) {
          throw journalFailure('chain_producer_missing');
        }
        chainDependencies.push({
          toolId: producerToolId,
          buildRef: producerState.buildRef,
          executionBindingSha256: producerBuild.executionBindingSha256,
          resultReceiptRef: producerLive.ref,
        });
      }
    }
    const facts: ReceiptFact[] = [...(input.facts ?? [])];
    if (input.hostError !== undefined)
      facts.push({
        kind: 'host_error',
        subject: `host.${input.check}`,
        status: 'failed',
        hostError: hostErrorMessage(input.hostError).slice(0, 1_000),
      });
    if (!facts.length) throw journalFailure('receipt_facts_missing');
    const body: ReceiptBody = {
      id: `receipt-${state.nextReceiptOrdinal}`,
      runId: state.run.runId,
      recordingSha256: state.run.recordingSha256,
      toolId: input.toolId,
      check: input.check,
      ...(input.check === 'chain' ? { chainEdgeId: input.chainEdgeId, chainEdgeSha256 } : {}),
      status: receiptStatus(facts),
      buildRef: toolState.buildRef,
      executionBindingSha256: build.executionBindingSha256,
      dependencyBuilds: chainDependencies,
      facts,
    };
    const ref = this.#objectRef('json', Buffer.from(canonicalTeachingPlanJson(body), 'utf8'));
    let receipt: ExecutionReceipt;
    try {
      receipt = ExecutionReceiptSchema.parse({ ...body, ref });
    } catch (error) {
      if (error instanceof z.ZodError) throw journalFailure('receipt_invalid');
      throw error;
    }
    const key = receiptKey(receipt.check, receipt.chainEdgeId);
    const previous = toolState.currentReceiptRefs.find((pointer) => pointer.key === key);
    const retained = toolState.currentReceiptRefs.filter((pointer) => pointer.key !== key);
    try {
      ToolVerificationPayloadSchema.parse({
        toolId: input.toolId,
        currentBuildRef: toolState.buildRef,
        artifactManifestRef: build.artifactManifestRef,
        executionBinding: build.executionBinding,
        executionBindingSha256: build.executionBindingSha256,
        receipts: [...retained.map(({ ref: current }) => this.readReceipt(current)), receipt],
      });
    } catch (error) {
      if (error instanceof z.ZodError) throw journalFailure('receipt_invalid');
      throw error;
    }
    this.#putJson(body);
    if (previous) this.#archive(state, [previous]);
    if (input.check === 'live' && previous)
      this.#invalidateChainsUsingProducer(state, input.toolId);
    toolState.currentReceiptRefs = [...retained, { key, ref }];
    state.nextReceiptOrdinal += 1;
    this.#clearReview(state);
    this.#commit(state);
    return receipt;
  }
  currentExecutionSnapshot(): CurrentExecutionSnapshot {
    const state = this.readState();
    const tools = state.tools.flatMap((tool) => {
      if (!tool.buildRef || !tool.currentReceiptRefs.length) return [];
      const build = this.readBuild(tool.buildRef);
      return [
        ToolVerificationPayloadSchema.parse({
          toolId: tool.toolId,
          currentBuildRef: tool.buildRef,
          artifactManifestRef: build.artifactManifestRef,
          executionBinding: build.executionBinding,
          executionBindingSha256: build.executionBindingSha256,
          receipts: tool.currentReceiptRefs.map(({ ref }) => this.readReceipt(ref)),
        }),
      ];
    });
    const payload = {
      run: state.run,
      currentPlanRef: state.currentPlanRef,
      sharedManifestRef: state.sharedManifestRef,
      tools,
    };
    const ref = this.#putJson(payload);
    return CurrentExecutionSnapshotSchema.parse({ ref, payload });
  }
  receiptHistoryProjection(): ReceiptHistoryProjection {
    const state = this.readState();
    const totalCount = state.supersededReceiptRefs.length;
    const refs = [...state.supersededReceiptRefs].reverse();
    const historyRoot = this.#putJson(state.supersededReceiptRefs);
    const payload = {
      run: state.run,
      historyRoot,
      totalCount,
      includedCount: refs.length,
      truncated: false,
      entries: refs.map((ref, index) => ({
        ordinal: totalCount - index - 1,
        receipt: this.readReceipt(ref),
      })),
    };
    const ref = this.#putJson(payload);
    return ReceiptHistoryProjectionSchema.parse({ ref, payload });
  }
  #readCompletionReview(ref: ContentAddressedRef) {
    const record = CompletionReviewRecordSchema.parse(this.readJson(ref));
    const input = CompletionReviewInputSchema.parse(this.readJson(record.inputRef));
    const review = parseCompletionReviewOutput(
      canonicalTeachingPlanJson(this.readJson(record.outputRef)),
      input,
    );
    if (review.verdict !== 'passed') throw journalFailure('completion_review_failed');
    return { record, input, review };
  }
  recordCompletionReview(inputValue: CompletionReviewInput, outputValue: unknown) {
    const state = this.readState();
    this.#assertActive(state);
    const input = CompletionReviewInputSchema.parse(inputValue);
    const plan = this.#plan(state);
    const snapshot = this.currentExecutionSnapshot();
    const history = this.receiptHistoryProjection();
    if (
      input.run.runId !== state.run.runId ||
      input.run.site !== state.run.site ||
      input.run.recordingSha256 !== state.run.recordingSha256 ||
      input.run.planRevision !== plan.revision ||
      input.run.planSha256 !== state.currentPlanRef.sha256 ||
      !sameRef(input.currentPlan.ref, state.currentPlanRef) ||
      !sameRef(input.snapshot.ref, snapshot.ref) ||
      !sameRef(input.history.ref, history.ref)
    )
      throw journalFailure('completion_input_stale');
    const review = parseCompletionReviewOutput(canonicalTeachingPlanJson(outputValue), input);
    if (review.verdict !== 'passed') throw journalFailure('completion_review_failed');
    const inputRef = this.#putJson(input);
    const outputRef = this.#putJson(review);
    const record = CompletionReviewRecordSchema.parse({
      terminalIntent: input.terminalIntent,
      inputRef,
      outputRef,
      currentPlanRef: state.currentPlanRef,
      snapshotRef: snapshot.ref,
      historyRef: history.ref,
    });
    const ref = this.#putJson(record);
    state.completionReviewRef = ref;
    this.#commit(state);
    return { ref, record, review };
  }
  #assertCompletionReview(
    state: FreshTeachJournalState,
    terminalIntent: 'completed' | 'blocked',
  ): void {
    if (!state.completionReviewRef) throw journalFailure('completion_review_missing');
    const { record } = this.#readCompletionReview(state.completionReviewRef);
    const snapshot = this.currentExecutionSnapshot();
    const history = this.receiptHistoryProjection();
    if (
      record.terminalIntent !== terminalIntent ||
      !sameRef(record.currentPlanRef, state.currentPlanRef) ||
      !sameRef(record.snapshotRef, snapshot.ref) ||
      !sameRef(record.historyRef, history.ref)
    )
      throw journalFailure('completion_review_stale');
  }
  finish(
    status: Exclude<FreshTeachRunStatus, 'active'>,
    options: { hostError?: unknown } = {},
  ): FreshTeachJournalState {
    const state = this.readState();
    this.#assertActive(state);
    if (status === 'completed') {
      const failures = mechanicalProofFailures(this.#plan(state), this.currentExecutionSnapshot());
      if (failures.length) throw journalFailure('completion_proof_incomplete');
      this.#assertCompletionReview(state, 'completed');
    } else if (status === 'blocked') {
      this.#assertCompletionReview(state, 'blocked');
    } else {
      this.#clearReview(state);
    }
    state.status = FreshTeachRunStatusSchema.exclude(['active']).parse(status);
    if (options.hostError !== undefined)
      state.terminalHostError = hostErrorMessage(options.hostError).slice(0, 1_000);
    return this.#commit(state);
  }
  finishWithReview(
    status: 'completed' | 'blocked',
    reviewInput: CompletionReviewInput,
    reviewOutput: unknown,
    options: { hostError?: unknown } = {},
  ): FreshTeachJournalState {
    if (reviewInput.terminalIntent !== status) throw journalFailure('completion_intent_mismatch');
    this.recordCompletionReview(reviewInput, reviewOutput);
    return this.finish(status, options);
  }
}
