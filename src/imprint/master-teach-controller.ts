/**
 * The one fresh, foreground `imprint teach` controller.
 *
 * Semantic choices are made by the bounded master/advisor roles. This module
 * owns only sequencing, content-addressed hand-offs, focused compilation,
 * mechanical checks, terminal state, and post-completion promotion.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import {
  type BackendAttemptFact,
  type BackendResponseObservation,
  runWorkflowWithLadder,
} from './backend-ladder.ts';
import type { CompileAgentProgress } from './compile-agent-types.ts';
import type { CompileStrategyKind } from './compile-strategy.ts';
import {
  type TriageResult,
  findAuthAdjacentSeqs,
  findCredentialBearingSeqs,
  generate,
  triageRequests,
} from './compile.ts';
import { TimeoutError, abortSignalError } from './concurrency.ts';
import { type Replacement, extractCredentials } from './credential-extract.ts';
import { emit } from './emit.ts';
import { redactFreeformText } from './freeform-redact.ts';
import { type LLMOptions, type ProviderName, detectTeachProvider, resolveProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import {
  type CompletionReviewInput,
  type CompletionToolResultEvidence,
  CompletionToolResultEvidenceSchema,
  CurrentPlanProjectionSchema,
  type FocusedPlannerInput,
  FocusedPlannerProposalSchema,
  type FocusedPlannerRevisionContext,
  FocusedPlannerRevisionContextSchema,
  type MasterDecisionInput,
  MasterDecisionOutputSchema,
  type ParameterSelectionAdvisorInput,
  type ToolSelectionAdvisorInput,
  ToolSelectionAdvisorInputSchema,
  ToolSelectionAdvisorOutputSchema,
} from './master-teach-agent-contracts.ts';
import {
  type MasterTeachAgentOptions,
  mechanicalProofFailures,
  requestBaselineMvpReview,
  requestCompletionReview,
  requestFocusedPlan,
  requestMasterDecision,
  requestParameterSelectionAdvice,
  requestToolSelectionAdvice,
} from './master-teach-agents.ts';
import {
  bindProducerResultToConsumer,
  invocationOutcomeCheck,
  resultCollectionCount,
} from './master-teach-checks.ts';
import {
  type ChainEdge,
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type EditableTeachingPlan,
  EditableTeachingPlanSchema,
  type EditableTeachingTool,
  type ImplementationPlanPayload,
  bindImplementationPlanRef,
  canonicalTeachingPlanJson,
  chainInvocationForEdge,
  createEditableTeachingPlan,
  groundDetectorCandidateForMaster,
  normalizeDetectorCompileContextForMaster,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
  unresolvedCandidateCoverage,
} from './master-teach-plan.ts';
import {
  type CurrentExecutionSnapshot,
  type PromptEvidenceProjection,
  PromptEvidenceProjectionSchema,
  type ReceiptFact,
  recordingIndexFromSession,
} from './master-teach-prompt-projections.ts';
import {
  type FreshTeachBootstrapObject,
  FreshTeachJournal,
  FreshTeachJournalStateSchema,
  type FreshTeachRunStatus,
  isRepairableBuildArtifactError,
} from './master-teach-store.ts';
import { localSiteDir, localToolDir } from './paths.ts';
import { DEFAULT_PLAYBOOK_CLEANUP_TIMEOUT_MS, runPlaybook } from './playbook-runner.ts';
import { describeAgentActivity, formatElapsed } from './progress.ts';
import {
  ProviderUnavailableError,
  RunDeadline,
  type RunDeadlineRef,
  providerControlError,
} from './provider-retry.ts';
import { record } from './record.ts';
import { redactSession } from './redact.ts';
import {
  type FocusedEvidenceDocument,
  type FocusedEvidenceScope,
  type IndependentExecutionObservation,
  discoveryEvidenceDocuments,
  focusedEvidenceDocuments,
  observeIndependentExecution,
} from './replay-evidence.ts';
import { resolveTeachingRecording } from './session-merge.ts';
import { buildToolCandidatePayload, detectToolCandidates } from './tool-candidates.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type Session, SessionSchema, type ToolResult, type Workflow } from './types.ts';

const FOCUSED_COMPILE_CONCURRENCY = 2;
const DEFAULT_PLAYBOOK_CHECK_TIMEOUT_MS = 150_000;
const PLAYBOOK_INVOCATION_SETTLE_GRACE_MS = DEFAULT_PLAYBOOK_CLEANUP_TIMEOUT_MS + 500;
export const DISCOVERY_EVIDENCE_CHARACTER_BUDGET = 750_000;
export const FOCUSED_EVIDENCE_CHARACTER_BUDGET = 700_000;
const PROMOTED_FILES = [
  'workflow.json',
  'parser.ts',
  'request-transform.ts',
  'playbook.yaml',
] as const;
const JOURNALED_LOCAL_FILES = ['parser.ts', 'request-transform.ts', 'playbook.yaml'] as const;

export function revisionSeedArtifactNames(
  sourceStrategyKind: CompileStrategyKind,
  targetStrategyKind: CompileStrategyKind = sourceStrategyKind,
): readonly (typeof PROMOTED_FILES)[number][] {
  if (sourceStrategyKind !== targetStrategyKind) return [];
  return targetStrategyKind === 'playbook_fallback'
    ? ['workflow.json', 'playbook.yaml']
    : ['workflow.json', 'parser.ts', 'request-transform.ts'];
}

export interface FreshTeachOptions {
  site?: string;
  url?: string;
  persistProfile?: boolean;
  signal?: AbortSignal;
  noInteractive?: boolean;
  provider?: ProviderName;
  model?: string;
  maxDurationMs?: number;
  fromSession?: string;
  /** Reuse only the completed candidate-selection checkpoint from an earlier
   * run of this site. Planning, compilation, checks, and agent conversations
   * always start fresh. */
  fromCandidates?: string;
  keepTest?: boolean;
  /** Optional explicit spelling for the same master-led flow. When no
   * provider is supplied, this also selects the Codex provider end to end. */
  agent?: 'codex';
  /** Foreground-only human progress. It never affects orchestration. */
  onProgress?: (message: string) => void;
}

export type FreshTeachTerminalStatus = Exclude<FreshTeachRunStatus, 'active'>;

export interface FreshTeachTerminalResult {
  status: FreshTeachTerminalStatus;
  readyTools: number;
  /** Every planned or unresolved operation that did not reach a ready MVP. */
  nonReadyTools: number;
  runRoot: string;
  message: string;
}

interface BuildWaveFailure {
  toolId: string;
  toolName: string;
  waveIndex: number;
  stage: 'compile' | 'contract' | 'live' | 'chain' | 'proof';
  error: unknown;
  receiptRef?: ContentAddressedRef;
  buildRef?: ContentAddressedRef;
  chainEdgeId?: string;
  /** Exact invocation members when a shared consumer call failed as a whole. */
  chainEdgeIds?: string[];
  /** Redacted before entering a prompt. Bound to the focused build that
   * produced this failure so compiler diagnostics survive the host handoff. */
  compilerSummary?: string;
  /** Bounded observations from the live backend that produced the failure. */
  liveResponseObservations?: BackendResponseObservation[];
}

interface BuildWaveResult<Value> {
  completed: Array<{
    tool: EditableTeachingTool;
    waveIndex: number;
    value: Value;
  }>;
  failures: BuildWaveFailure[];
}

interface BuildWaveDependencies<Value> {
  compileTool: (tool: EditableTeachingTool, waveIndex: number) => Promise<Value>;
  /** Persist the smallest usable build before a dependent wave may start. */
  acceptCompiledTool?: (
    tool: EditableTeachingTool,
    waveIndex: number,
    value: Value,
  ) => Promise<void> | void;
  concurrency?: number;
}

class CompiledArtifactContractError extends Error {
  override readonly cause: unknown;
  readonly compilerSummary?: string;
  constructor(cause: unknown, compilerSummary?: string) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CompiledArtifactContractError';
    this.cause = cause;
    this.compilerSummary = compilerSummary;
  }
}

const TERMINAL_FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

function isTerminalFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return TERMINAL_FILESYSTEM_ERROR_CODES.has(String(error.code));
}

interface FocusedWaveOrchestrationResult<Value> {
  terminal: FreshTeachTerminalResult;
  builds: BuildWaveResult<Value>;
}

/**
 * Invoke every tool named by the master's waves. Dependencies are guaranteed by
 * plan validation to occur in earlier waves. A failed tool never causes an
 * early return: every later planned tool is still offered to its focused
 * compiler, leaving the terminal controller to report the complete outcome.
 */
export async function compileEveryToolInBuildWaves<Value>(
  plan: Pick<DesiredTeachingPlan, 'tools' | 'buildWaves'>,
  dependencies: BuildWaveDependencies<Value>,
): Promise<BuildWaveResult<Value>> {
  const tools = new Map(plan.tools.map((tool) => [tool.id, tool]));
  const completed: BuildWaveResult<Value>['completed'] = [];
  const failures: BuildWaveFailure[] = [];
  const concurrency = Math.max(
    1,
    Math.floor(dependencies.concurrency ?? FOCUSED_COMPILE_CONCURRENCY),
  );

  for (const [waveIndex, wave] of plan.buildWaves.entries()) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, wave.length) }, async () => {
      while (true) {
        const position = cursor++;
        const toolId = wave[position];
        if (toolId === undefined) return;
        const tool = tools.get(toolId);
        if (!tool) {
          failures.push({
            toolId,
            toolName: toolId,
            waveIndex,
            stage: 'compile',
            error: new Error(`master build wave references unknown tool "${toolId}"`),
          });
          continue;
        }
        let value: Value;
        try {
          value = await dependencies.compileTool(tool, waveIndex);
        } catch (error) {
          // A compiler can make a bad artifact, but it cannot repair the host's
          // disk or permissions. Keep those failures out of master planning.
          if (isTerminalFilesystemError(error)) throw error;
          failures.push({
            toolId: tool.id,
            toolName: tool.candidate.toolName,
            waveIndex,
            stage: 'compile',
            error,
          });
          continue;
        }
        try {
          await dependencies.acceptCompiledTool?.(tool, waveIndex, value);
        } catch (error) {
          // issueBuild also performs the artifact's schema/provenance contract.
          // Only that typed, deterministic rejection belongs in master repair;
          // journal and I/O failures remain terminal host errors.
          if (!(error instanceof CompiledArtifactContractError)) throw error;
          failures.push({
            toolId: tool.id,
            toolName: tool.candidate.toolName,
            waveIndex,
            stage: 'contract',
            error: error.cause,
            compilerSummary: error.compilerSummary,
          });
          continue;
        }
        completed.push({ tool, waveIndex, value });
      }
    });
    // A terminal host failure must not let sibling workers keep mutating the
    // journal after this function has already rejected.
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  return { completed, failures };
}

/**
 * Small dependency-injected boundary used by focused orchestration tests and
 * embedders. The terminal result is produced only after all master-owned waves
 * have settled, including every tool after an earlier focused failure.
 */
export async function runFocusedWaveOrchestration<Value>(
  plan: Pick<DesiredTeachingPlan, 'tools' | 'buildWaves'>,
  dependencies: BuildWaveDependencies<Value>,
  runRoot: string,
): Promise<FocusedWaveOrchestrationResult<Value>> {
  const builds = await compileEveryToolInBuildWaves(plan, dependencies);
  const failedIds = new Set(builds.failures.map(({ toolId }) => toolId));
  return {
    builds,
    terminal: {
      status: builds.failures.length === 0 ? 'completed' : 'failed',
      readyTools: plan.tools.length - failedIds.size,
      nonReadyTools: failedIds.size,
      runRoot,
      message:
        builds.failures.length === 0
          ? 'Every planned focused build completed.'
          : `${builds.failures.length} planned focused build(s) failed.`,
    },
  };
}

interface RecordingResolution {
  path: string;
  session: Session;
  recordingSha256: string;
}

interface RedactedRecording {
  path: string;
  session: Session;
  credentialValues: Record<string, string>;
  credentialReplacements: Replacement[];
}

interface CompiledFocusedTool {
  workflow: Workflow;
  workflowPath: string;
  toolDir: string;
  /** The strategy that authored these executable files. Older injected test
   * fixtures may omit it; accepted builds are normalized before reuse. */
  strategyKind?: CompileStrategyKind;
  /** Final summary from this retained compiler turn. */
  compilerSummary?: string;
}

interface LiveCheckResult {
  result: ToolResult<unknown>;
  durationMs: number;
  executionMechanism: string;
  /** Mechanical outcomes from every backend the runtime actually tried. */
  backendAttempts?: BackendAttemptFact[];
  responseObservations?: BackendResponseObservation[];
  parameters: Record<string, string | number | boolean>;
  buildRef: ContentAddressedRef;
  resultReceiptRef: ContentAddressedRef;
  /** Exact chain mappings bound together for this invocation. */
  chainInvocationSha256?: string;
}

type UnboundLiveCheckResult = Omit<LiveCheckResult, 'buildRef' | 'resultReceiptRef'>;

interface ChainInvocation {
  edges: ChainEdge[];
  sha256: string;
}

type ToolAdvice = Awaited<ReturnType<typeof requestToolSelectionAdvice>>;
type FocusedPlan = Awaited<ReturnType<typeof requestFocusedPlan>>;
type MasterDecision = Awaited<ReturnType<typeof requestMasterDecision>>;
type CompletionReview = Awaited<ReturnType<typeof requestCompletionReview>>;
type Detection = Awaited<ReturnType<typeof detectToolCandidates>>;

interface CandidateSelection {
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  toolAdvice: ToolAdvice;
  discoveryDecision: MasterDecision;
}

interface CandidateSelectionCheckpoint {
  version: 1;
  selection: CandidateSelection;
  bootstrap: FreshTeachBootstrapObject[];
}

/** Test seams are deliberately role-sized; production defaults use the shipped modules. */
interface FreshTeachControllerDependencies {
  now: () => Date;
  runId: () => string;
  record: typeof record;
  resolveTeachingRecording: typeof resolveTeachingRecording;
  prepareSession: (
    session: Session,
    llmConfig: LLMOptions,
    control: PrepareSessionControl,
  ) => Promise<TriageResult>;
  observeIndependentExecution: typeof observeIndependentExecution;
  detectToolCandidates: typeof detectToolCandidates;
  requestToolSelectionAdvice: typeof requestToolSelectionAdvice;
  requestFocusedPlan: typeof requestFocusedPlan;
  requestMasterDecision: typeof requestMasterDecision;
  requestBaselineMvpReview: typeof requestBaselineMvpReview;
  requestParameterSelectionAdvice: typeof requestParameterSelectionAdvice;
  requestCompletionReview: typeof requestCompletionReview;
  compileFocusedTool: (input: {
    tool: EditableTeachingTool;
    implementationPlan: ImplementationPlanPayload;
    triage: TriageResult;
    sessionPath: string;
    stagingDir: string;
    priorToolDir?: string;
    revisionGuidance?: string;
    revisionContext?: FocusedPlannerRevisionContext;
    resumeSessionId?: string;
    onSessionId?: (sessionId: string) => void;
    llmConfig: LLMOptions;
    runDeadline: RunDeadlineRef;
    signal?: AbortSignal;
    keepTest?: boolean;
    onProgress?: (progress: CompileAgentProgress) => void;
  }) => Promise<CompiledFocusedTool>;
  runApiTool: (input: {
    workflowPath: string;
    parameters: Record<string, string | number | boolean>;
    signal?: AbortSignal;
  }) => Promise<{
    result: ToolResult<unknown>;
    executionMechanism: string;
    backendAttempts?: BackendAttemptFact[];
    responseObservations?: BackendResponseObservation[];
  }>;
  runPlaybookTool: (input: {
    playbookPath: string;
    site: string;
    parameters: Record<string, string | number | boolean>;
    maxDurationMs?: number;
    signal?: AbortSignal;
  }) => Promise<{ result: ToolResult<unknown>; executionMechanism: string }>;
  playbookInvocationTimeoutMs: number;
  playbookCleanupGraceMs: number;
  promote: (input: {
    site: string;
    runId: string;
    runRoot: string;
    tools: readonly CompiledFocusedTool[];
  }) => Promise<void>;
}

const defaultDependencies: FreshTeachControllerDependencies = {
  now: () => new Date(),
  runId: () => randomUUID(),
  record,
  resolveTeachingRecording,
  prepareSession: prepareSessionForTeach,
  observeIndependentExecution,
  detectToolCandidates,
  requestToolSelectionAdvice,
  requestFocusedPlan,
  requestMasterDecision,
  requestBaselineMvpReview,
  requestParameterSelectionAdvice,
  requestCompletionReview,
  compileFocusedTool: compileFocusedToolWithShippedAgent,
  runApiTool: async ({ workflowPath, parameters, signal }) => {
    const run = await runWorkflowWithLadder({
      workflowPath,
      params: parameters,
      signal,
    });
    return {
      result: run.result,
      executionMechanism: run.usedBackend,
      backendAttempts: run.attempts,
      responseObservations: run.responseObservations,
    };
  },
  runPlaybookTool: async ({ playbookPath, site, parameters, maxDurationMs, signal }) => ({
    result: await runPlaybook({
      playbook: playbookPath,
      params: parameters,
      site,
      maxDurationMs,
      signal,
    }),
    executionMechanism: 'playbook',
  }),
  playbookInvocationTimeoutMs: DEFAULT_PLAYBOOK_CHECK_TIMEOUT_MS,
  playbookCleanupGraceMs: PLAYBOOK_INVOCATION_SETTLE_GRACE_MS,
  promote: promoteCompletedTools,
};

function sha256Id(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function jsonRef(value: unknown): {
  ref: ContentAddressedRef;
  seed: FreshTeachBootstrapObject;
} {
  const bytes = canonicalTeachingPlanJson(value);
  const sha256 = sha256Id(bytes);
  const ref = {
    path: `objects/json/${sha256.slice(7)}.json`,
    sha256,
  };
  return { ref, seed: { ref, kind: 'json', value } };
}

function uniqueRefs<Ref extends ContentAddressedRef>(refs: readonly Ref[]): Ref[] {
  return [...new Map(refs.map((ref) => [`${ref.path}\u0000${ref.sha256}`, ref] as const)).values()];
}

function addBootstrap(
  seeds: Map<string, FreshTeachBootstrapObject>,
  object: { ref: ContentAddressedRef; seed: FreshTeachBootstrapObject },
): ContentAddressedRef {
  seeds.set(`${object.ref.path}\u0000${object.ref.sha256}`, object.seed);
  return object.ref;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function terminalStatusForError(
  error: unknown,
  signal?: AbortSignal,
): FreshTeachTerminalStatus {
  if (aborted(signal) || (error instanceof DOMException && error.name === 'AbortError')) {
    return 'cancelled';
  }
  if (error instanceof ProviderUnavailableError) return 'provider_unavailable';
  if (error instanceof AggregateError) {
    const statuses = error.errors.map((nested) => terminalStatusForError(nested));
    if (statuses.includes('cancelled')) return 'cancelled';
    if (statuses.includes('provider_unavailable')) return 'provider_unavailable';
  }
  return 'failed';
}

function throwTerminalFanoutFailure(
  failures: readonly BuildWaveFailure[],
  signal?: AbortSignal,
): void {
  const terminal = failures.find(({ error }) => {
    const status = terminalStatusForError(error, signal);
    return status === 'cancelled' || status === 'provider_unavailable';
  });
  if (terminal) throw terminal.error;
}

function boundedTerminalMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return utf8Prefix(message.trim() || 'teach failed', 1_000);
}

export function focusedPlanningFailureMessage(
  failures: readonly { toolId: string; error: unknown }[],
  targetCount: number,
): string {
  const details = failures.map(({ toolId, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    return `${toolId}: ${utf8Prefix(message.trim() || 'unknown planning failure', 800)}`;
  });
  return [
    `focused planning failed for ${failures.length} of ${targetCount} tools`,
    ...details,
  ].join('\n');
}

function reportProgress(opts: FreshTeachOptions, message: string): void {
  opts.onProgress?.(message);
}

function assertSiteName(value: string | undefined): string {
  const site = value?.trim();
  if (!site) throw new Error('imprint teach requires a site name');
  if (/[\s/\\]/.test(site)) throw new Error('site name cannot contain spaces or path separators');
  return site;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeJson(temporary, value);
  renameSync(temporary, path);
}

const CANDIDATE_SELECTION_CHECKPOINT = 'candidate-selection.json';

function contentRefKey(ref: ContentAddressedRef): string {
  return `${ref.path}\u0000${ref.sha256}`;
}

function candidateSourceRunId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`invalid candidate-selection run id ${JSON.stringify(value)}`);
  }
  return value;
}

function parseCandidateSelectionCheckpoint(value: unknown): CandidateSelectionCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('candidate-selection checkpoint must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error('unsupported candidate-selection checkpoint version');
  if (!record.selection || typeof record.selection !== 'object') {
    throw new Error('candidate-selection checkpoint has no selection');
  }
  const rawSelection = record.selection as Record<string, unknown>;
  const discoveryInput = ToolSelectionAdvisorInputSchema.parse(rawSelection.discoveryInput);
  const discoveryEvidence = PromptEvidenceProjectionSchema.parse(rawSelection.discoveryEvidence);
  if (
    !sameContentRef(discoveryInput.evidence.ref, discoveryEvidence.ref) ||
    canonicalTeachingPlanJson(discoveryInput.evidence.payload) !==
      canonicalTeachingPlanJson(discoveryEvidence.payload)
  ) {
    throw new Error('candidate-selection checkpoint evidence does not match its discovery input');
  }
  const toolAdvice = ToolSelectionAdvisorOutputSchema.parse(rawSelection.toolAdvice);
  const discoveryDecision = MasterDecisionOutputSchema.parse(rawSelection.discoveryDecision);
  if (!Array.isArray(record.bootstrap)) {
    throw new Error('candidate-selection checkpoint has no bootstrap objects');
  }
  const suppliedBootstrap = record.bootstrap.map((raw, index): FreshTeachBootstrapObject => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`candidate-selection bootstrap ${index} must be an object`);
    }
    const seed = raw as Record<string, unknown>;
    if (seed.kind !== 'json') {
      throw new Error(`candidate-selection bootstrap ${index} must contain JSON`);
    }
    const expected = jsonRef(seed.value);
    const supplied = expected.ref;
    if (
      !seed.ref ||
      typeof seed.ref !== 'object' ||
      Array.isArray(seed.ref) ||
      !sameContentRef(supplied, seed.ref as ContentAddressedRef)
    ) {
      throw new Error(`candidate-selection bootstrap ${index} has a stale content reference`);
    }
    return expected.seed;
  });
  const bootstrapByRef = new Map(
    suppliedBootstrap.map((seed) => [contentRefKey(seed.ref), seed] as const),
  );
  const requiredRefs = uniqueRefs([
    discoveryEvidence.ref,
    ...discoveryEvidence.payload.entries.map(({ ref }) => ref),
  ]);
  const bootstrap = requiredRefs.map((ref) => {
    const seed = bootstrapByRef.get(contentRefKey(ref));
    if (!seed) {
      throw new Error(`candidate-selection checkpoint is missing evidence object ${ref.path}`);
    }
    return seed;
  });
  if (bootstrapByRef.size !== bootstrap.length) {
    throw new Error('candidate-selection checkpoint contains objects outside discovery evidence');
  }
  return {
    version: 1,
    selection: { discoveryInput, discoveryEvidence, toolAdvice, discoveryDecision },
    bootstrap,
  };
}

function rebindCandidateSelection(
  selection: CandidateSelection,
  run: ToolSelectionAdvisorInput['run'],
): CandidateSelection {
  const discoveryInput = ToolSelectionAdvisorInputSchema.parse({
    ...selection.discoveryInput,
    run,
  });
  const toolAdvice = ToolSelectionAdvisorOutputSchema.parse({
    ...selection.toolAdvice,
    binding: run,
  });
  const discoveryDecision = MasterDecisionOutputSchema.parse({
    ...selection.discoveryDecision,
    binding: run,
  });
  return {
    discoveryInput,
    discoveryEvidence: selection.discoveryEvidence,
    toolAdvice,
    discoveryDecision,
  };
}

function writeCandidateSelectionCheckpoint(
  runRoot: string,
  selection: CandidateSelection,
  seeds: Map<string, FreshTeachBootstrapObject>,
): void {
  const requiredRefs = uniqueRefs([
    selection.discoveryEvidence.ref,
    ...selection.discoveryEvidence.payload.entries.map(({ ref }) => ref),
  ]);
  const bootstrap = requiredRefs.map((ref) => {
    const seed = seeds.get(contentRefKey(ref));
    if (!seed) throw new Error(`candidate selection is missing evidence object ${ref.path}`);
    return seed;
  });
  const checkpoint = parseCandidateSelectionCheckpoint({
    version: 1,
    selection,
    bootstrap,
  });
  writeJsonAtomic(pathJoin(runRoot, CANDIDATE_SELECTION_CHECKPOINT), checkpoint);
}

function readJsonUnchecked(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function legacyCandidateSelectionCheckpoint(input: {
  sourceRunRoot: string;
  recordingIndex: ToolSelectionAdvisorInput['recordingIndex'];
}): CandidateSelectionCheckpoint {
  const journalRoot = pathJoin(input.sourceRunRoot, 'journal');
  const state = FreshTeachJournalStateSchema.parse(
    readJsonUnchecked(pathJoin(journalRoot, 'current.json')),
  );
  const earliestPlanRef = state.supersededPlanRefs[0] ?? state.currentPlanRef;
  const readJournalObject = (ref: ContentAddressedRef): unknown => {
    const value = readJsonUnchecked(pathJoin(journalRoot, ref.path));
    if (!sameContentRef(jsonRef(value).ref, ref)) {
      throw new Error(`source candidate object failed its content hash: ${ref.path}`);
    }
    return value;
  };
  const earliestPlan = EditableTeachingPlanSchema.parse(readJournalObject(earliestPlanRef));
  let toolAdvice: ToolAdvice | undefined;
  let discoveryDecision: MasterDecision | undefined;
  for (const ref of earliestPlan.decision.advisorRefs) {
    const value = readJournalObject(ref);
    if (!toolAdvice) {
      const parsed = ToolSelectionAdvisorOutputSchema.safeParse(value);
      if (parsed.success) toolAdvice = parsed.data;
    }
    if (!discoveryDecision) {
      const parsed = MasterDecisionOutputSchema.safeParse(value);
      if (parsed.success && !('planRevision' in parsed.data.binding)) {
        discoveryDecision = parsed.data;
      }
    }
  }
  if (!toolAdvice || !discoveryDecision) {
    throw new Error(
      'source run predates durable candidate selection and cannot be reused without rediscovery',
    );
  }
  const selectedTools = new Map(
    discoveryDecision.desiredPlan.tools.map((tool) => [tool.candidate.toolName, tool]),
  );
  const discoveryCandidates = toolAdvice.boundaries.map((boundary) => {
    const selected = selectedTools.get(boundary.toolName);
    if (!selected) {
      throw new Error(
        `legacy candidate selection cannot recover parameters for ${JSON.stringify(boundary.toolName)}`,
      );
    }
    return { ...boundary, likelyParams: selected.candidate.likelyParams };
  });
  const candidateNames = new Set(discoveryCandidates.map(({ toolName }) => toolName));
  const coveredNames = new Set(
    discoveryDecision.desiredPlan.candidateCoverage.map(
      ({ discoveryCandidateName }) => discoveryCandidateName,
    ),
  );
  if (
    candidateNames.size !== coveredNames.size ||
    [...candidateNames].some((name) => !coveredNames.has(name))
  ) {
    throw new Error(
      'legacy source merged or split detector candidates before checkpoints were available; use a newer source run',
    );
  }

  const seeds = new Map<string, FreshTeachBootstrapObject>();
  const copyJsonObject = (ref: ContentAddressedRef): unknown => {
    const value = readJournalObject(ref);
    const object = jsonRef(value);
    if (!sameContentRef(object.ref, ref)) {
      throw new Error(`source candidate evidence has a stale content reference: ${ref.path}`);
    }
    addBootstrap(seeds, object);
    return value;
  };
  let discoveryEvidence: PromptEvidenceProjection | undefined;
  for (const ref of earliestPlan.decision.evidenceRefs) {
    const payload = copyJsonObject(ref);
    const projection = PromptEvidenceProjectionSchema.safeParse({ ref, payload });
    if (!projection.success) continue;
    const isDiscoveryEvidence = projection.data.payload.entries.some(
      (entry) =>
        entry.kind === 'untrusted_redacted_quote' &&
        entry.quote.includes('"kind":"discovery_detector_'),
    );
    if (!isDiscoveryEvidence) continue;
    discoveryEvidence = projection.data;
    for (const entry of discoveryEvidence.payload.entries) copyJsonObject(entry.ref);
    break;
  }
  if (!discoveryEvidence) throw new Error('source run has no reusable discovery evidence');
  const discoveryInput = ToolSelectionAdvisorInputSchema.parse({
    run: discoveryDecision.binding,
    recordingIndex: input.recordingIndex,
    detectorSharedContext: {
      loginRequestSeqs: [],
      credentialNames: [],
      tokenExtractionNotes: '',
      sharedHelperNotes: '',
      authRequestSeqs: [],
      authNotes: '',
    },
    discoveryCandidates,
    evidence: discoveryEvidence,
  });
  return parseCandidateSelectionCheckpoint({
    version: 1,
    selection: { discoveryInput, discoveryEvidence, toolAdvice, discoveryDecision },
    bootstrap: [...seeds.values()],
  });
}

function loadCandidateSelectionCheckpoint(input: {
  site: string;
  sourceRunId: string;
  recordingSha256: string;
  recordingIndex: ToolSelectionAdvisorInput['recordingIndex'];
}): CandidateSelectionCheckpoint {
  const sourceRunId = candidateSourceRunId(input.sourceRunId);
  const sourceRunRoot = pathJoin(localSiteDir(input.site), '.teach-runs', sourceRunId);
  const checkpointPath = pathJoin(sourceRunRoot, CANDIDATE_SELECTION_CHECKPOINT);
  const checkpoint = existsSync(checkpointPath)
    ? parseCandidateSelectionCheckpoint(readJsonUnchecked(checkpointPath))
    : legacyCandidateSelectionCheckpoint({ sourceRunRoot, recordingIndex: input.recordingIndex });
  const binding = checkpoint.selection.discoveryInput.run;
  if (binding.site !== input.site) {
    throw new Error(
      `candidate selection belongs to site ${JSON.stringify(binding.site)}, not ${JSON.stringify(input.site)}`,
    );
  }
  if (binding.recordingSha256 !== input.recordingSha256) {
    throw new Error(
      'candidate selection belongs to a different recording; rerun discovery for the selected recording',
    );
  }
  return checkpoint;
}

/** Keep every master revision in a clean module namespace. */
export function revisionStagingDir(
  stagingRoot: string,
  planRevision: number,
  toolId: string,
): string {
  return pathJoin(stagingRoot, `revision-${planRevision}`, toolId);
}

/** The authoritative teaching scope. Semantic triage may advise candidate
 * detection, but it must not remove recording evidence from the master,
 * focused planners, compilation, or verification. */
export function prepareFullSessionForTeach(session: Session): TriageResult {
  const selectedSeqs = session.requests.map(({ seq }) => seq);
  return {
    session,
    selectedSeqs,
    replaySafeSeqs: selectedSeqs,
    irreversibleSeqs: [],
    coveredOutboundEventSeqs: session.events
      .filter(({ type }) => type === 'ws-sent')
      .map(({ seq }) => seq),
    irreversibleEventSeqs: [],
    consideredCount: session.requests.length,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
  };
}

interface PrepareSessionControl {
  signal?: AbortSignal;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
}

/** Reuse shipped semantic request triage only as detector advice. Auth requests
 * are preserved so the detector can keep them as shared context. */
export async function prepareSessionForTeach(
  session: Session,
  llmConfig: LLMOptions,
  control: PrepareSessionControl = {},
  runTriage: typeof triageRequests = triageRequests,
): Promise<TriageResult> {
  const credentialSeqs = findCredentialBearingSeqs(session);
  const authRequestSeqs = [
    ...new Set([...credentialSeqs, ...findAuthAdjacentSeqs(session, credentialSeqs)]),
  ];
  return await runTriage(
    session,
    llmConfig,
    {
      sharedContext: {
        loginRequestSeqs: credentialSeqs,
        credentialNames: [],
        tokenExtractionNotes: '',
        sharedHelperNotes: '',
        authRequestSeqs,
        authNotes: '',
      },
      ...control,
    },
    {
      effectClassification: 'skip',
    },
  );
}

async function resolveRecordingForFreshRun(
  opts: FreshTeachOptions,
  site: string,
  deps: FreshTeachControllerDependencies,
): Promise<RecordingResolution> {
  if (opts.fromSession) {
    const path = pathResolve(opts.fromSession);
    const bytes = readFileSync(path);
    const session = SessionSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (session.site !== site) {
      throw new Error(`recording site "${session.site}" does not match requested site "${site}"`);
    }
    return { path, session, recordingSha256: sha256Id(bytes) };
  }

  if (opts.url) {
    await deps.record({
      site,
      url: opts.url,
      persistProfile: opts.persistProfile,
      signal: opts.signal,
      noNarration: opts.noInteractive,
    });
  }

  let selected = deps.resolveTeachingRecording(site);
  if (!selected) {
    if (opts.noInteractive) {
      throw new Error(`no recording found for "${site}"; record one first or pass --from-session`);
    }
    const captured = await deps.record({
      site,
      url: opts.url,
      persistProfile: opts.persistProfile,
      signal: opts.signal,
    });
    selected = deps.resolveTeachingRecording(site) ?? {
      path: captured.sessionPath,
      recordingSha256: sha256Id(readFileSync(captured.sessionPath)),
      sourceCount: 1,
      refreshed: false,
    };
  }
  const session = loadJsonFile(
    selected.path,
    SessionSchema,
    {
      notFound: 'selected teaching recording is missing',
      badSchema: 'selected teaching recording is invalid',
    },
    'teaching recording',
  );
  return {
    path: selected.path,
    session,
    recordingSha256: selected.recordingSha256,
  };
}

/** Apply the shipped credential extractor before ordinary redaction so
 * teaching and later live verification retain named inputs. */
export function prepareRedactedTeachingSession(session: Session): Omit<RedactedRecording, 'path'> {
  const extracted = extractCredentials(session);
  const redacted = redactSession(session, { replacements: extracted.replacements }).session;
  const credentialValues = Object.fromEntries(
    extracted.replacements.flatMap(({ originalValue, placeholder }) => {
      const match = /^\$\{credential\.([^}]+)\}$/.exec(placeholder);
      return match?.[1] ? [[match[1], originalValue]] : [];
    }),
  );
  return {
    session: redacted,
    credentialValues,
    credentialReplacements: extracted.replacements,
  };
}

function redactRecording(recording: RecordingResolution, runRoot: string): RedactedRecording {
  const prepared = prepareRedactedTeachingSession(recording.session);
  const path = pathJoin(runRoot, 'recording.redacted.json');
  writeJson(path, prepared.session);
  return { path, ...prepared };
}

function toolEvidenceScope(tool: EditableTeachingTool): FocusedEvidenceScope {
  return {
    toolId: tool.id,
    toolName: tool.candidate.toolName,
    requestSeqs: tool.candidate.requestSeqs,
    representativeSeqs: tool.candidate.representativeSeqs,
    dependencySeqs: tool.candidate.dependencySeqs,
    eventSeqs: tool.candidate.eventSeqs,
  };
}

type UntrustedEvidenceEntry = Extract<
  PromptEvidenceProjection['payload']['entries'][number],
  { kind: 'untrusted_redacted_quote' }
>;

function evidenceDocumentKind(document: FocusedEvidenceDocument): string {
  return typeof document.value.kind === 'string' ? document.value.kind : 'unknown';
}

function omissionDocument(input: {
  totalDocuments: number;
  includedDocuments: number;
  omittedByKind: ReadonlyMap<string, number>;
  maximumCharacters: number;
}): FocusedEvidenceDocument {
  const omittedByKind = [...input.omittedByKind]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
  const omittedDocuments = omittedByKind.reduce((total, { count }) => total + count, 0);
  return {
    provenance: 'plan_note',
    value: {
      kind: 'prompt_evidence_omissions',
      totalDocuments: input.totalDocuments,
      includedDocuments: input.includedDocuments,
      omittedDocuments,
      omittedByKind,
      projectionCharacterBudget: input.maximumCharacters,
      truncated: omittedDocuments > 0,
    },
  };
}

function untrustedEvidenceEntry(document: FocusedEvidenceDocument): {
  entry: UntrustedEvidenceEntry;
  object: ReturnType<typeof jsonRef>;
} {
  const object = jsonRef(document.value);
  const quote = JSON.stringify(document.value);
  return {
    object,
    entry: {
      kind: 'untrusted_redacted_quote',
      ref: object.ref,
      provenance: document.provenance,
      quote,
    },
  };
}

const EMPTY_EVIDENCE_PROJECTION_CHARACTERS = JSON.stringify({
  ref: jsonRef({ entries: [] }).ref,
  payload: { entries: [] },
}).length;

function evidenceProjectionCharacters(entries: readonly UntrustedEvidenceEntry[]): number {
  return (
    EMPTY_EVIDENCE_PROJECTION_CHARACTERS +
    entries.reduce((total, entry) => total + JSON.stringify(entry).length, 0) +
    Math.max(0, entries.length - 1)
  );
}

/** Construct the exact prompt projection under a mechanical character budget.
 * Documents are considered in their supplied order; callers put complete
 * skeletons first and breadth-ordered detail afterward. */
export function buildPromptEvidenceProjection(
  documents: readonly FocusedEvidenceDocument[],
  seeds: Map<string, FreshTeachBootstrapObject>,
  maximumCharacters: number,
  requiredKinds: ReadonlySet<string> = new Set(),
): PromptEvidenceProjection {
  const candidates = documents
    .map((document) => ({
      kind: evidenceDocumentKind(document),
      ...untrustedEvidenceEntry(document),
    }))
    .map((candidate) => ({
      ...candidate,
      characters: JSON.stringify(candidate.entry).length,
    }));
  const remainingByKind = new Map<string, number>();
  for (const { kind } of candidates)
    remainingByKind.set(kind, (remainingByKind.get(kind) ?? 0) + 1);
  const selected: typeof candidates = [];
  let selectedCharacters = 0;
  for (const candidate of candidates) {
    const trialRemaining = new Map(remainingByKind);
    trialRemaining.set(candidate.kind, (trialRemaining.get(candidate.kind) ?? 1) - 1);
    const omission = untrustedEvidenceEntry(
      omissionDocument({
        totalDocuments: candidates.length,
        includedDocuments: selected.length + 1,
        omittedByKind: trialRemaining,
        maximumCharacters,
      }),
    );
    const trialEntryCount = selected.length + 2;
    const trialCharacters =
      EMPTY_EVIDENCE_PROJECTION_CHARACTERS +
      selectedCharacters +
      candidate.characters +
      JSON.stringify(omission.entry).length +
      Math.max(0, trialEntryCount - 1);
    if (trialCharacters > maximumCharacters) {
      if (requiredKinds.has(candidate.kind))
        throw new RangeError(
          `required ${candidate.kind} evidence cannot fit ${maximumCharacters} characters`,
        );
      continue;
    }
    selected.push(candidate);
    selectedCharacters += candidate.characters;
    remainingByKind.set(candidate.kind, (remainingByKind.get(candidate.kind) ?? 1) - 1);
  }
  const omission = untrustedEvidenceEntry(
    omissionDocument({
      totalDocuments: candidates.length,
      includedDocuments: selected.length,
      omittedByKind: remainingByKind,
      maximumCharacters,
    }),
  );
  const entries = [...selected.map(({ entry }) => entry), omission.entry];
  if (evidenceProjectionCharacters(entries) > maximumCharacters)
    throw new RangeError(`evidence projection cannot fit ${maximumCharacters} characters`);
  for (const { object } of selected) addBootstrap(seeds, object);
  addBootstrap(seeds, omission.object);
  const payload = { entries };
  const ref = addBootstrap(seeds, jsonRef(payload));
  return PromptEvidenceProjectionSchema.parse({ ref, payload });
}

function storedEvidenceProjection(
  journal: FreshTeachJournal,
  entries: PromptEvidenceProjection['payload']['entries'],
): PromptEvidenceProjection {
  const payload = { entries };
  const ref = journal.storeJson(payload);
  return PromptEvidenceProjectionSchema.parse({ ref, payload });
}

type PromptEvidenceEntry = PromptEvidenceProjection['payload']['entries'][number];

function rememberLatestFailureEvidence(
  plan: EditableTeachingPlan,
  projection: PromptEvidenceProjection,
  byToolName: Map<string, PromptEvidenceEntry[]>,
): void {
  const toolNameById = new Map(plan.tools.map((tool) => [tool.id, tool.candidate.toolName]));
  const grouped = new Map<string, PromptEvidenceEntry[]>();
  for (const entry of projection.payload.entries) {
    let toolId: string | undefined;
    let toolName: string | undefined;
    if (entry.kind === 'mechanical_fact') toolId = entry.toolId;
    else if (entry.kind === 'untrusted_redacted_quote') {
      try {
        const fact = JSON.parse(entry.quote) as { toolId?: unknown; toolName?: unknown };
        if (typeof fact.toolId === 'string') toolId = fact.toolId;
        if (typeof fact.toolName === 'string') toolName = fact.toolName;
      } catch {
        // Keep malformed diagnostics available to the master, but do not bind
        // them to an unresolved operation for completion review.
      }
    }
    toolName ??= toolId ? toolNameById.get(toolId) : undefined;
    if (!toolName) continue;
    const entries = grouped.get(toolName) ?? [];
    entries.push(entry);
    grouped.set(toolName, entries);
  }
  for (const [toolName, entries] of grouped) byToolName.set(toolName, entries.slice(-8));
}

function partialCompletionEvidence(input: {
  journal: FreshTeachJournal;
  discoveryEvidence: PromptEvidenceProjection;
  plan: EditableTeachingPlan;
  latestFailureEvidenceByToolName: ReadonlyMap<string, readonly PromptEvidenceEntry[]>;
}): { evidence: PromptEvidenceProjection; failureRefs: ContentAddressedRef[] } {
  const unresolvedNames = new Set(
    unresolvedCandidateCoverage(input.plan).map(
      ({ discoveryCandidateName }) => discoveryCandidateName,
    ),
  );
  const failureEntries = [...input.latestFailureEvidenceByToolName]
    .filter(([toolName]) => unresolvedNames.has(toolName))
    .flatMap(([, entries]) => entries)
    .slice(-24);
  const entries = [...input.discoveryEvidence.payload.entries, ...failureEntries].filter(
    (entry, index, all) =>
      all.findIndex((candidate) => sameContentRef(candidate.ref, entry.ref)) === index,
  );
  return {
    evidence: storedEvidenceProjection(input.journal, entries),
    failureRefs: uniqueRefs(failureEntries.map(({ ref }) => ref)).slice(-31),
  };
}

function verificationFailureProjection(
  journal: FreshTeachJournal,
  failures: readonly BuildWaveFailure[],
): PromptEvidenceProjection {
  const plan = journal.currentPlan();
  const state = journal.readState();
  const entries: PromptEvidenceProjection['payload']['entries'] = [];
  const seenReceipts = new Set<string>();
  for (const failure of failures) {
    const receipt = failure.receiptRef ? journal.readReceipt(failure.receiptRef) : undefined;
    const currentToolState = state.tools.find(({ toolId }) => toolId === failure.toolId);
    const receiptBindingError = receipt
      ? failureReceiptBindingError({ receipt, failure, currentToolState })
      : undefined;
    if (receiptBindingError) {
      console.warn(`[imprint] ignored stale check failure: ${receiptBindingError}`);
      continue;
    }
    if (receipt && !seenReceipts.has(receipt.ref.sha256)) {
      const tool = plan.tools.find(({ id }) => id === failure.toolId);
      entries.push({
        kind: 'mechanical_fact',
        ref: receipt.ref,
        requestSeqs: (tool?.candidate.requestSeqs ?? []).slice(0, 128),
        // Optional event citations belong to the agent's editable rationale, not
        // to a host-issued receipt. A bad citation must not poison a factual
        // repair package for an otherwise valid check failure.
        eventSeqs: [],
        toolId: failure.toolId,
        check: receipt.check,
        status: receipt.status,
        facts: receipt.facts.slice(0, 64),
      });
      seenReceipts.add(receipt.ref.sha256);
    }
    const fact = {
      stage: failure.stage,
      toolId: failure.toolId,
      toolName: failure.toolName,
      waveIndex: failure.waveIndex,
      planRevision: plan.revision,
      currentPlanRef: state.currentPlanRef,
      buildRef:
        failure.buildRef ??
        state.tools.find(({ toolId }) => toolId === failure.toolId)?.buildRef ??
        null,
      chainEdgeId: failure.chainEdgeId ?? null,
      chainEdgeIds: failure.chainEdgeIds ?? [],
      message: utf8Prefix(
        failure.error instanceof Error ? failure.error.message : String(failure.error),
        12_000,
      ),
      ...(failure.compilerSummary
        ? {
            compilerSummary: utf8Prefix(
              redactFreeformText(failure.compilerSummary).redacted,
              8_000,
            ),
          }
        : {}),
      ...(failure.liveResponseObservations?.length
        ? {
            liveResponseObservations: failure.liveResponseObservations.slice(-12),
          }
        : {}),
    };
    const ref = journal.storeJson(fact);
    entries.push({
      kind: 'untrusted_redacted_quote',
      ref,
      provenance: 'check_history',
      quote: JSON.stringify(fact),
    });
  }
  return storedEvidenceProjection(journal, entries);
}

function completionFailureProjection(
  journal: FreshTeachJournal,
  review: CompletionReview,
): PromptEvidenceProjection {
  const facts = [
    {
      stage: 'completion_review',
      verdict: review.verdict,
      summary: review.summary,
    },
    ...review.findings.map((finding) => ({
      stage: 'completion_review_finding',
      severity: finding.severity,
      ...(finding.toolId ? { toolId: finding.toolId } : {}),
      message: finding.message,
      evidenceRefs: finding.evidenceRefs,
    })),
    ...review.toolResultReviews.map((result) => ({
      stage: 'completion_tool_result_review',
      ...result,
    })),
  ];
  return storedEvidenceProjection(
    journal,
    facts.map((fact) => {
      const ref = journal.storeJson(fact);
      return {
        kind: 'untrusted_redacted_quote',
        ref,
        provenance: 'check_history',
        quote: JSON.stringify(fact),
      };
    }),
  );
}

function sameContentRef(
  left: ContentAddressedRef | undefined,
  right: ContentAddressedRef | undefined,
): boolean {
  return Boolean(left && right && left.path === right.path && left.sha256 === right.sha256);
}

/** Receipts are useful repair facts only while they still describe the exact
 * current build and remain one of that build's current receipts. */
export function failureReceiptBindingError(input: {
  receipt: {
    ref: ContentAddressedRef;
    toolId: string;
    check: string;
    chainEdgeId?: string;
    buildRef: ContentAddressedRef;
  };
  failure: {
    toolId: string;
    stage: BuildWaveFailure['stage'];
    chainEdgeId?: string;
    chainEdgeIds?: readonly string[];
    buildRef?: ContentAddressedRef;
  };
  currentToolState?: {
    buildRef?: ContentAddressedRef;
    currentReceiptRefs: readonly { ref: ContentAddressedRef }[];
  };
}): string | undefined {
  const { receipt, failure, currentToolState } = input;
  if (
    receipt.toolId !== failure.toolId ||
    (receipt.check !== failure.stage && failure.stage !== 'proof') ||
    (failure.chainEdgeIds
      ? !failure.chainEdgeIds.includes(receipt.chainEdgeId ?? '')
      : receipt.chainEdgeId !== failure.chainEdgeId)
  ) {
    return `failure receipt does not match ${failure.toolId}/${failure.stage}`;
  }
  if (!currentToolState?.buildRef) {
    return `failure receipt for ${failure.toolId}/${failure.stage} has no current build`;
  }
  if (failure.buildRef && !sameContentRef(failure.buildRef, currentToolState.buildRef)) {
    return `failure build does not match the current build for ${failure.toolId}/${failure.stage}`;
  }
  if (!sameContentRef(receipt.buildRef, currentToolState.buildRef)) {
    return `failure receipt belongs to an older build for ${failure.toolId}/${failure.stage}`;
  }
  if (!currentToolState.currentReceiptRefs.some(({ ref }) => sameContentRef(ref, receipt.ref))) {
    return `failure receipt is no longer current for ${failure.toolId}/${failure.stage}`;
  }
  return undefined;
}

function evidenceRefsForProjection(projection: PromptEvidenceProjection): ContentAddressedRef[] {
  return uniqueRefs([projection.ref, ...projection.payload.entries.map(({ ref }) => ref)]);
}

function currentPlanProjection(journal: FreshTeachJournal) {
  const state = journal.readState();
  const plan = journal.currentPlan();
  const projection = CurrentPlanProjectionSchema.parse({
    ref: state.currentPlanRef,
    payload: plan,
  });
  return {
    state,
    plan,
    projection,
    binding: {
      ...state.run,
      planRevision: plan.revision,
      planSha256: state.currentPlanRef.sha256,
    },
  };
}

function stableReceiptFact(fact: ReceiptFact): unknown {
  if (fact.kind === 'invocation') {
    const { durationMs: _durationMs, ...stable } = fact;
    return stable;
  }
  if (fact.kind === 'host_error') {
    const { hostError, ...stable } = fact;
    return { ...stable, hostError: utf8Prefix(hostError, 512) };
  }
  return fact;
}

/**
 * Identify executable teach state without revision bookkeeping or volatile
 * receipt identities. Every strategy choice and factual check result remains
 * in the digest; only values that change while retaining the same work are
 * removed.
 */
function mechanicalTeachStateSha256(
  plan: EditableTeachingPlan,
  snapshot: CurrentExecutionSnapshot,
): string {
  const { version: _version, revision: _revision, decision: _decision, ...desiredPlan } = plan;
  const { currentPlanRef: _currentPlanRef, tools, ...execution } = snapshot.payload;
  return teachingPlanContentSha256({
    desiredPlan,
    execution: {
      ...execution,
      tools: tools.map(({ receipts, ...tool }) => ({
        ...tool,
        receipts: receipts.map(({ id: _id, ref: _ref, facts, ...receipt }) => ({
          ...receipt,
          facts: facts.map(stableReceiptFact),
        })),
      })),
    },
  });
}

function stableFindings(findings: PromptEvidenceProjection): unknown {
  const stableQuoteCoordinates = (quote: string): unknown => {
    try {
      const parsed = JSON.parse(quote) as Record<string, unknown>;
      return Object.fromEntries(
        [
          'stage',
          'toolId',
          'waveIndex',
          'verdict',
          'severity',
          'status',
          'message',
          'evidenceRefs',
        ].flatMap((key) => (parsed[key] === undefined ? [] : [[key, parsed[key]]])),
      );
    } catch {
      return { structuredCoordinatesUnavailable: true };
    }
  };
  return findings.payload.entries.map(({ ref: _ref, ...entry }) => {
    if (entry.kind === 'mechanical_fact') {
      return entry.facts ? { ...entry, facts: entry.facts.map(stableReceiptFact) } : entry;
    }
    return {
      kind: entry.kind,
      provenance: entry.provenance,
      coordinates: stableQuoteCoordinates(entry.quote),
    };
  });
}

function failureEntryBelongsToTool(
  journal: FreshTeachJournal,
  plan: EditableTeachingPlan,
  entry: PromptEvidenceProjection['payload']['entries'][number],
  toolId: string,
): boolean {
  const connectedToolIds = new Set([toolId]);
  const connectedEdgeIds = new Set<string>();
  for (const edge of plan.chainEdges) {
    if (edge.producerToolId !== toolId && edge.consumerToolId !== toolId) continue;
    connectedToolIds.add(edge.producerToolId);
    connectedToolIds.add(edge.consumerToolId);
    connectedEdgeIds.add(edge.id);
  }
  if (entry.kind === 'mechanical_fact') {
    const chainEdgeId = entry.check === 'chain' ? journal.readReceipt(entry.ref).chainEdgeId : null;
    return (
      (entry.toolId !== undefined && connectedToolIds.has(entry.toolId)) ||
      (chainEdgeId !== null && chainEdgeId !== undefined && connectedEdgeIds.has(chainEdgeId))
    );
  }
  try {
    const coordinates = JSON.parse(entry.quote) as {
      toolId?: unknown;
      chainEdgeId?: unknown;
    };
    return (
      (typeof coordinates.toolId === 'string' && connectedToolIds.has(coordinates.toolId)) ||
      (typeof coordinates.chainEdgeId === 'string' && connectedEdgeIds.has(coordinates.chainEdgeId))
    );
  } catch {
    return false;
  }
}

/** Give the retained planner/compiler the latest failed attempt as explicitly old
 * history. This is an agent handoff only: it neither validates nor rejects the
 * replacement plan. */
function focusedRepairContexts(
  journal: FreshTeachJournal,
  findings: PromptEvidenceProjection,
): Map<string, FocusedPlannerRevisionContext> {
  const current = currentPlanProjection(journal);
  const toolState = new Map(current.state.tools.map((tool) => [tool.toolId, tool]));
  const contexts = new Map<string, FocusedPlannerRevisionContext>();
  for (const tool of current.plan.tools) {
    const relevant = findings.payload.entries.filter((entry) =>
      failureEntryBelongsToTool(journal, current.plan, entry, tool.id),
    );
    // Keep a focused agent focused. If the master recalls a different tool
    // (for example, a producer implicated by a consumer failure), its explicit
    // decision reason supplies the direction and this fallback supplies the
    // factual batch that motivated it.
    const contextualEntries = relevant.length > 0 ? relevant : findings.payload.entries;
    if (contextualEntries.length === 0) continue;
    const previousImplementationPlan = tool.implementationPlan
      ? {
          ref: tool.implementationPlan,
          payload: journal.readJson(tool.implementationPlan) as ImplementationPlanPayload,
        }
      : undefined;
    const latestFailureFacts = storedEvidenceProjection(journal, contextualEntries);
    const sourceBuildRef = toolState.get(tool.id)?.buildRef;
    contexts.set(
      tool.id,
      FocusedPlannerRevisionContextSchema.parse({
        sourcePlanRevision: current.plan.revision,
        sourcePlanRef: current.state.currentPlanRef,
        ...(sourceBuildRef ? { sourceBuildRef } : {}),
        ...(previousImplementationPlan ? { previousImplementationPlan } : {}),
        latestFailureFacts,
      }),
    );
  }
  return contexts;
}

function repairStateSha256(journal: FreshTeachJournal, findings: PromptEvidenceProjection): string {
  return teachingPlanContentSha256({
    mechanicalStateSha256: mechanicalTeachStateSha256(
      journal.currentPlan(),
      journal.currentExecutionSnapshot(),
    ),
    findings: stableFindings(findings),
  });
}

export function providerForFreshTeach(opts: FreshTeachOptions): ProviderName {
  return opts.provider ?? (opts.agent === 'codex' ? 'codex-cli' : detectTeachProvider());
}

function llmOptions(opts: FreshTeachOptions): LLMOptions {
  const provider = providerForFreshTeach(opts);
  return { provider, ...(opts.model ? { model: opts.model } : {}) };
}

function agentOptions(
  opts: FreshTeachOptions,
  deadline: RunDeadline,
  deps?: Partial<MasterTeachAgentOptions>,
): MasterTeachAgentOptions {
  const analyzer =
    deps?.analyzer ??
    (providerForFreshTeach(opts) === 'codex-cli' ? resolveProvider(llmOptions(opts)) : undefined);
  return {
    provider: providerForFreshTeach(opts),
    ...(opts.model ? { model: opts.model } : {}),
    deadlineMs: deadline.deadlineMs,
    runDeadline: deadline,
    signal: opts.signal,
    ...(analyzer ? { analyzer } : {}),
    ...deps,
  };
}

function toolCandidateForCompiler(tool: EditableTeachingTool): ToolCandidate {
  return {
    ...tool.candidate,
    likelyParams: tool.candidate.likelyParams.map(({ name, type, description }) => ({
      name,
      ...(type ? { type } : {}),
      ...(description ? { description } : {}),
    })),
  };
}

async function compileFocusedToolWithShippedAgent(input: {
  tool: EditableTeachingTool;
  implementationPlan: ImplementationPlanPayload;
  triage: TriageResult;
  sessionPath: string;
  stagingDir: string;
  priorToolDir?: string;
  revisionGuidance?: string;
  revisionContext?: FocusedPlannerRevisionContext;
  resumeSessionId?: string;
  onSessionId?: (sessionId: string) => void;
  llmConfig: LLMOptions;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  keepTest?: boolean;
  onProgress?: (progress: CompileAgentProgress) => void;
}): Promise<CompiledFocusedTool> {
  mkdirSync(input.stagingDir, { recursive: true, mode: 0o700 });
  if (input.priorToolDir) {
    for (const name of revisionSeedArtifactNames(input.tool.strategy?.kind ?? 'api')) {
      const prior = pathJoin(input.priorToolDir, name);
      if (existsSync(prior) && statSync(prior).isFile())
        copyFileSync(prior, pathJoin(input.stagingDir, name));
    }
  }
  const toolPlan = JSON.stringify(
    {
      tool: input.tool,
      implementationPlan: input.implementationPlan,
      ...(input.revisionGuidance || input.revisionContext
        ? {
            revision: {
              instruction: input.priorToolDir
                ? 'Use the compatible prior artifact as a starting point and make the smallest change required by the current master plan. Re-check it; the prior artifact may be a rejected draft or a previously working build.'
                : 'No compatible prior artifact can be seeded. Follow the current failure facts and accepted strategy without copying executable files from another strategy.',
              masterGuidance:
                input.revisionGuidance ??
                'Investigate the immediately preceding failed attempt and preserve every behavior that remains supported.',
              ...(input.revisionContext ? { priorAttempt: input.revisionContext } : {}),
            },
          }
        : {}),
    },
    null,
    2,
  );
  const result = await generate({
    sessionPath: input.sessionPath,
    outDir: input.stagingDir,
    candidate: toolCandidateForCompiler(input.tool),
    sharedContext: input.tool.compileContext as SharedCompileContext,
    preTriagedSession: input.triage,
    llmConfig: input.llmConfig,
    deadlineMs: input.runDeadline.deadlineMs,
    runDeadline: input.runDeadline,
    signal: input.signal,
    // Finesse runs against this staging directory after the MVP is published.
    // Production promotion still copies only the allowed runtime artifacts.
    keepTest: true,
    onProgress: input.onProgress,
    toolPlan,
    ...(input.resumeSessionId
      ? {
          initialResume: {
            sessionId: input.resumeSessionId,
            message: `Continue this same tool conversation. The master and verifier supplied new factual feedback. Work in the current tool directory, inspect the seeded current artifacts, make the smallest supported repair, rerun the normal checks, and finish through done() or give_up().\n\nCurrent accepted tool plan and latest feedback:\n${toolPlan}`,
          },
        }
      : {}),
    onSessionId: input.onSessionId,
    strategyKind: input.implementationPlan.strategyKind,
    revisionMode: Boolean(input.revisionGuidance || input.revisionContext || input.priorToolDir),
    verificationMode: 'master_mvp',
  });
  return {
    workflow: result.workflow,
    workflowPath: result.workflowPath,
    toolDir: dirname(result.workflowPath),
    strategyKind: input.implementationPlan.strategyKind,
    compilerSummary: result.compilerSummary,
  };
}

function liveVerificationParameters(
  implementation: ImplementationPlanPayload,
): Record<string, string | number | boolean> {
  const verification = implementation.verificationCases.find(
    (candidate) => candidate.check === 'live',
  );
  if (!verification) throw new Error('implementation plan has no live verification case');
  return Object.fromEntries(
    verification.parameterValues.map(({ parameterName, value }) => [parameterName, value]),
  );
}

function concreteParameterDeclarations(tool: EditableTeachingTool) {
  return tool.candidate.likelyParams.map(({ name, type }) => {
    if (!type) throw new Error(`tool "${tool.id}" has an unresolved parameter type`);
    return { name, type };
  });
}

function storeLocalArtifacts(journal: FreshTeachJournal, toolDir: string) {
  return JOURNALED_LOCAL_FILES.flatMap((path) => {
    const absolute = pathJoin(toolDir, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return [];
    return [{ path, artifactRef: journal.storeBytes(readFileSync(absolute)) }];
  });
}

interface FocusedPlannerBundle {
  evidence: PromptEvidenceProjection;
  output: FocusedPlan;
  authoredCompileInputsSha256: string;
}

interface HostedPlannerBundle extends FocusedPlannerBundle {
  proposal: ReturnType<typeof FocusedPlannerProposalSchema.parse>;
}

function effectiveFocusedProposalEdges(
  currentEdges: readonly ChainEdge[],
  bundles: readonly FocusedPlannerBundle[],
  indexes: readonly number[],
): ChainEdge[] {
  const proposedConsumerIds = new Set(
    indexes.flatMap((index) => {
      const bundle = bundles[index];
      return bundle ? [bundle.output.tool.id] : [];
    }),
  );
  return [
    ...currentEdges.filter(({ consumerToolId }) => !proposedConsumerIds.has(consumerToolId)),
    ...indexes.flatMap((index) => bundles[index]?.output.chainEdges ?? []),
  ];
}

function downstreamFirstFocusedPlannerIndexes(
  currentEdges: readonly ChainEdge[],
  bundles: readonly FocusedPlannerBundle[],
): number[] {
  const indexes = bundles.map((_, index) => index);
  const indexByToolId = new Map(bundles.map((bundle, index) => [bundle.output.tool.id, index]));
  const dependencies = new Map(indexes.map((index) => [index, new Set<number>()]));
  for (const edge of effectiveFocusedProposalEdges(currentEdges, bundles, indexes)) {
    const producerIndex = indexByToolId.get(edge.producerToolId);
    const consumerIndex = indexByToolId.get(edge.consumerToolId);
    if (producerIndex === undefined || consumerIndex === undefined) continue;
    dependencies.get(consumerIndex)?.add(producerIndex);
  }
  const remaining = new Set(indexes);
  const waves: number[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining].filter((index) =>
      [...(dependencies.get(index) ?? [])].every((producer) => !remaining.has(producer)),
    );
    const selected = wave.length > 0 ? wave : [...remaining];
    selected.sort((left, right) =>
      (bundles[left]?.output.tool.id ?? '').localeCompare(bundles[right]?.output.tool.id ?? ''),
    );
    waves.push(selected);
    for (const index of selected) remaining.delete(index);
  }
  return waves.reverse().flat();
}

export function compatibleFocusedPlannerIndexes(
  currentEdges: readonly ChainEdge[],
  bundles: readonly FocusedPlannerBundle[],
): number[] {
  const retained = new Set<number>();
  const downstreamFirst = downstreamFirstFocusedPlannerIndexes(currentEdges, bundles);
  let added = true;
  while (added) {
    added = false;
    // Consider consumers before producers, including dependencies newly
    // proposed by planners that originally started in the same build wave.
    for (const index of downstreamFirst) {
      if (retained.has(index)) continue;
      const candidate = [...retained, index].sort((left, right) => left - right);
      const effectiveEdges = effectiveFocusedProposalEdges(currentEdges, bundles, candidate);
      const mutuallyCompatible = candidate.every((candidateIndex) => {
        const bundle = bundles[candidateIndex];
        return (
          bundle !== undefined &&
          bundle.authoredCompileInputsSha256 ===
            teachingToolCompileInputsSha256(bundle.output.tool, effectiveEdges)
        );
      });
      if (!mutuallyCompatible) continue;
      retained.add(index);
      added = true;
    }
  }
  if (retained.size === 0 && bundles.length > 0) {
    throw new Error('a focused planner proposal does not match the compile inputs it received');
  }
  return [...retained].sort((left, right) => left - right);
}

function planDecision(
  now: Date,
  outcome: 'initial' | 'accepted' | 'rejected' | 'revised',
  reason: string,
  advisorRefs: readonly ContentAddressedRef[],
  evidenceRefs: readonly ContentAddressedRef[],
) {
  return {
    timestamp: now.toISOString(),
    outcome,
    reason: reason.trim() || 'The master returned this complete teaching plan.',
    advisorRefs: uniqueRefs(advisorRefs),
    evidenceRefs: uniqueRefs(evidenceRefs),
  };
}

function focusedEvidenceRefs(evidence: PromptEvidenceProjection): ContentAddressedRef[] {
  return uniqueRefs([evidence.ref, ...evidence.payload.entries.map(({ ref }) => ref)]);
}

async function requestFocusedPlannerBundles(input: {
  plan: EditableTeachingPlan;
  discoveryRun: ToolSelectionAdvisorInput['run'];
  recordingIndex: ToolSelectionAdvisorInput['recordingIndex'];
  triagedSession: Session;
  independent: IndependentExecutionObservation;
  seeds: Map<string, FreshTeachBootstrapObject>;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  toolIds?: ReadonlySet<string>;
  revisionContextByToolId?: ReadonlyMap<string, FocusedPlannerRevisionContext>;
}): Promise<HostedPlannerBundle[]> {
  const available = input.plan.tools.map((tool) => ({
    toolId: tool.id,
    toolName: tool.candidate.toolName,
    expectedOutput: tool.candidate.expectedOutput,
  }));
  const evidenceByTool = new Map<string, PromptEvidenceProjection>();
  const targetTools = input.toolIds
    ? input.plan.tools.filter(({ id }) => input.toolIds?.has(id))
    : input.plan.tools;
  for (const tool of targetTools) {
    evidenceByTool.set(
      tool.id,
      buildPromptEvidenceProjection(
        focusedEvidenceDocuments({
          session: input.triagedSession,
          scope: toolEvidenceScope(tool),
          independent: input.independent,
        }),
        input.seeds,
        FOCUSED_EVIDENCE_CHARACTER_BUDGET,
        new Set([
          'focused_recording_scope',
          'focused_request_summaries',
          'focused_event_summaries',
        ]),
      ),
    );
  }

  const targetIds = new Set(targetTools.map(({ id }) => id));
  const targetPlan = {
    tools: targetTools,
    buildWaves: input.plan.buildWaves
      .map((wave) => wave.filter((toolId) => targetIds.has(toolId)))
      .filter((wave) => wave.length > 0),
  };
  const planned = await compileEveryToolInBuildWaves(targetPlan, {
    concurrency: FOCUSED_COMPILE_CONCURRENCY,
    compileTool: async (sourceTool) => {
      const evidence = evidenceByTool.get(sourceTool.id);
      if (!evidence) throw new Error(`focused evidence is missing for "${sourceTool.id}"`);
      const { implementationPlan: _implementationPlan, ...unplannedTool } = sourceTool;
      const tool = {
        ...unplannedTool,
        // One projection ref binds the complete set of focused entries without
        // asking the planner to repeat every per-request document ref in each
        // verification case.
        evidenceRefs: [evidence.ref],
      };
      const revisionContext = input.revisionContextByToolId?.get(sourceTool.id);
      const plannerInput: FocusedPlannerInput = {
        run: input.discoveryRun,
        recordingIndex: input.recordingIndex,
        masterGuidance: input.plan.decision.reason,
        tool,
        availableProducers: available.filter(({ toolId }) => toolId !== sourceTool.id),
        siblingToolEvidence: input.plan.tools
          .filter(({ id }) => id !== sourceTool.id)
          .map((sibling) => ({
            toolId: sibling.id,
            toolName: sibling.candidate.toolName,
            supportRequestSeqs: sibling.candidate.dependencySeqs,
            compileContext: sibling.compileContext,
            ...(sibling.strategy ? { strategy: sibling.strategy } : {}),
          })),
        incomingChainEdges: input.plan.chainEdges.filter(
          ({ consumerToolId }) => consumerToolId === sourceTool.id,
        ),
        outgoingChainEdges: input.plan.chainEdges.filter(
          ({ producerToolId }) => producerToolId === sourceTool.id,
        ),
        evidence,
        ...(revisionContext ? { revisionContext } : {}),
      };
      const output = await input.deps.requestFocusedPlan(plannerInput, input.agent);
      const authoredEdges = [
        ...input.plan.chainEdges.filter(({ consumerToolId }) => consumerToolId !== output.tool.id),
        ...output.chainEdges,
      ];
      return {
        evidence,
        output,
        authoredCompileInputsSha256: teachingToolCompileInputsSha256(output.tool, authoredEdges),
      } satisfies FocusedPlannerBundle;
    },
  });
  if (planned.failures.length > 0) {
    throwTerminalFanoutFailure(planned.failures, input.agent.signal);
    throw new AggregateError(
      planned.failures.map(({ error }) => error),
      focusedPlanningFailureMessage(planned.failures, targetTools.length),
    );
  }

  const bundles = planned.completed.map(({ value }) => value);
  const compatibleIndexes = compatibleFocusedPlannerIndexes(input.plan.chainEdges, bundles);
  const compatibleBundles = compatibleIndexes.flatMap((index) => {
    const bundle = bundles[index];
    return bundle ? [bundle] : [];
  });
  const effectiveEdges = effectiveFocusedProposalEdges(
    input.plan.chainEdges,
    bundles,
    compatibleIndexes,
  );

  return compatibleBundles.map((bundle) => {
    const compileInputsSha256 = teachingToolCompileInputsSha256(bundle.output.tool, effectiveEdges);
    const implementationObject = jsonRef(bundle.output.implementationPlan);
    const implementationContentRef = addBootstrap(input.seeds, implementationObject);
    const implementationRef = bindImplementationPlanRef(
      implementationContentRef,
      bundle.output.implementationPlan,
      compileInputsSha256,
    );
    const proposalTool = {
      ...bundle.output.tool,
      implementationPlan: implementationRef,
    };
    const payload = {
      binding: { ...bundle.output.binding, compileInputsSha256 },
      tool: proposalTool,
      chainEdges: bundle.output.chainEdges,
      implementationPlan: {
        ref: implementationRef,
        payload: bundle.output.implementationPlan,
      },
      reason: bundle.output.reason,
    };
    const proposalRef = addBootstrap(input.seeds, jsonRef(payload));
    return {
      ...bundle,
      proposal: FocusedPlannerProposalSchema.parse({
        ref: proposalRef,
        payload,
      }),
    };
  });
}

function allEvidenceRefs(
  discoveryEvidence: PromptEvidenceProjection,
  planners: readonly HostedPlannerBundle[],
): ContentAddressedRef[] {
  return uniqueRefs([
    ...focusedEvidenceRefs(discoveryEvidence),
    ...planners.flatMap(({ evidence }) => focusedEvidenceRefs(evidence)),
  ]);
}

async function discoverAndPlan(input: {
  site: string;
  runId: string;
  recordingSha256: string;
  triage: TriageResult;
  candidatePayload?: ReturnType<typeof buildToolCandidatePayload>;
  detection?: Detection;
  selected?: CandidateSelection;
  independent: IndependentExecutionObservation;
  seeds: Map<string, FreshTeachBootstrapObject>;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  now: Date;
  onSelected?: (selection: CandidateSelection) => void;
}): Promise<{
  plan: EditableTeachingPlan;
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  focusedEvidence: Map<string, PromptEvidenceProjection>;
  advisorRefs: ContentAddressedRef[];
  toolAdvice: ToolAdvice;
}> {
  const recordingIndex = recordingIndexFromSession(input.triage.session, input.recordingSha256);
  const run = {
    runId: input.runId,
    site: input.site,
    recordingSha256: input.recordingSha256,
  };
  let discoveryInput: ToolSelectionAdvisorInput;
  let discoveryEvidence: PromptEvidenceProjection;
  let advice: ToolAdvice;
  let discoveryDecision: MasterDecision;
  if (input.selected) {
    const rebound = rebindCandidateSelection(input.selected, run);
    discoveryInput = ToolSelectionAdvisorInputSchema.parse({
      ...rebound.discoveryInput,
      recordingIndex,
    });
    discoveryEvidence = rebound.discoveryEvidence;
    advice = rebound.toolAdvice;
    discoveryDecision = rebound.discoveryDecision;
  } else {
    if (!input.detection || !input.candidatePayload) {
      throw new Error('fresh discovery requires detector output and its candidate payload');
    }
    const recordingSeqs = { eventSeqs: new Set(recordingIndex.eventSeqs) };
    const discoveryCandidates = input.detection.candidates.map((candidate) =>
      groundDetectorCandidateForMaster(candidate, recordingSeqs),
    );
    discoveryEvidence = buildPromptEvidenceProjection(
      discoveryEvidenceDocuments({ candidatePayload: input.candidatePayload }),
      input.seeds,
      DISCOVERY_EVIDENCE_CHARACTER_BUDGET,
      new Set([
        'discovery_detector_evidence',
        'discovery_detector_narration',
        'discovery_detector_events',
        'discovery_detector_requests',
      ]),
    );
    const detectorSharedContext = normalizeDetectorCompileContextForMaster(
      input.detection.sharedContext,
    );
    discoveryInput = ToolSelectionAdvisorInputSchema.parse({
      run,
      recordingIndex,
      detectorSharedContext,
      discoveryCandidates,
      evidence: discoveryEvidence,
    });
    advice = await input.deps.requestToolSelectionAdvice(discoveryInput, input.agent);
    const discoveryDecisionInput: MasterDecisionInput = {
      phase: 'discovery',
      discovery: discoveryInput,
      toolSelectionAdvice: advice,
      plannerProposals: [],
      parameterAdvice: [],
    };
    discoveryDecision = await input.deps.requestMasterDecision(discoveryDecisionInput, input.agent);
  }
  const adviceRef = addBootstrap(input.seeds, jsonRef(advice));
  const discoveryDecisionRef = addBootstrap(input.seeds, jsonRef(discoveryDecision));
  input.onSelected?.({
    discoveryInput,
    discoveryEvidence,
    toolAdvice: advice,
    discoveryDecision,
  });
  const initialPlan = createEditableTeachingPlan(
    discoveryDecision.desiredPlan,
    {
      decision: planDecision(
        input.now,
        'initial',
        discoveryDecision.reason,
        [adviceRef, discoveryDecisionRef],
        [discoveryEvidence.ref],
      ),
    },
    {
      site: input.site,
      recordingSha256: input.recordingSha256,
      requestSeqs: new Set(recordingIndex.requestSeqs),
      eventSeqs: new Set(recordingIndex.eventSeqs),
      discoveryCandidateNames: discoveryInput.discoveryCandidates.map(({ toolName }) => toolName),
    },
  );
  const initialPlanObject = jsonRef(initialPlan);
  addBootstrap(input.seeds, initialPlanObject);

  const plannerBundles = await requestFocusedPlannerBundles({
    plan: initialPlan,
    discoveryRun: run,
    recordingIndex,
    triagedSession: input.triage.session,
    independent: input.independent,
    seeds: input.seeds,
    agent: input.agent,
    deps: input.deps,
  });
  const evidenceRefs = allEvidenceRefs(discoveryEvidence, plannerBundles);
  const revisionInput: MasterDecisionInput = {
    phase: 'revision',
    discovery: discoveryInput,
    current: {
      run: {
        runId: input.runId,
        site: input.site,
        recordingSha256: input.recordingSha256,
        planRevision: initialPlan.revision,
        planSha256: initialPlanObject.ref.sha256,
      },
      plan: CurrentPlanProjectionSchema.parse({
        ref: initialPlanObject.ref,
        payload: initialPlan,
      }),
    },
    toolSelectionAdvice: advice,
    plannerProposals: plannerBundles.map(({ proposal }) => proposal),
    parameterAdvice: [],
  };
  const finalDecision = await input.deps.requestMasterDecision(
    revisionInput,
    input.agent,
    input.selected ? { selfContained: true } : undefined,
  );
  const finalDecisionRef = addBootstrap(input.seeds, jsonRef(finalDecision));
  const proposalRefs = plannerBundles.map(({ proposal }) => proposal.ref);
  const plan = createEditableTeachingPlan(
    finalDecision.desiredPlan,
    {
      decision: planDecision(
        input.now,
        'initial',
        finalDecision.reason,
        [adviceRef, discoveryDecisionRef, ...proposalRefs, finalDecisionRef],
        evidenceRefs,
      ),
    },
    {
      site: input.site,
      recordingSha256: input.recordingSha256,
      requestSeqs: new Set(recordingIndex.requestSeqs),
      eventSeqs: new Set(recordingIndex.eventSeqs),
      discoveryCandidateNames: discoveryInput.discoveryCandidates.map(({ toolName }) => toolName),
    },
  );
  return {
    plan,
    discoveryInput,
    discoveryEvidence,
    focusedEvidence: new Map(
      plannerBundles.map(({ output, evidence }) => [output.tool.id, evidence]),
    ),
    advisorRefs: [adviceRef, discoveryDecisionRef, ...proposalRefs, finalDecisionRef],
    toolAdvice: advice,
  };
}

interface CheckedBuilds {
  compiledByToolId: Map<string, CompiledFocusedTool>;
  revisionSourceByToolId: Map<string, CompiledFocusedTool>;
  draftSourceByToolStrategy: Map<string, CompiledFocusedTool>;
  liveByToolId: Map<string, LiveCheckResult>;
  chainByEdgeId: Map<string, LiveCheckResult>;
  verifiedToolIds: Set<string>;
  failures: BuildWaveFailure[];
}

interface ResultDisposition {
  status: 'credible' | 'revision_required';
  reason: string;
  evidenceRefs: ContentAddressedRef[];
}

function rejectedResultError(reason: string, evidence: CompletionToolResultEvidence): Error {
  return new Error(
    utf8Prefix(
      [
        reason,
        `Factual result from the source build being reviewed: ${canonicalTeachingPlanJson({
          expectedResult: evidence.payload.expectedResult,
          actualResult: evidence.payload.actualResult,
          resultReceiptRef: evidence.payload.resultReceiptRef,
          ...(evidence.payload.chainEdgeId ? { chainEdgeId: evidence.payload.chainEdgeId } : {}),
        })}`,
      ].join('\n'),
      12_000,
    ),
  );
}

function checkFailure(
  tool: EditableTeachingTool,
  waveIndex: number,
  stage: BuildWaveFailure['stage'],
  error: unknown,
  identity: Pick<
    BuildWaveFailure,
    | 'receiptRef'
    | 'buildRef'
    | 'chainEdgeId'
    | 'chainEdgeIds'
    | 'compilerSummary'
    | 'liveResponseObservations'
  > = {},
): BuildWaveFailure {
  return {
    toolId: tool.id,
    toolName: tool.candidate.toolName,
    waveIndex,
    stage,
    error,
    ...identity,
  };
}

function returnedToolFailure(
  label: string,
  result: Extract<ToolResult<unknown>, { ok: false }>,
  backendAttempts: readonly BackendAttemptFact[] = [],
): Error {
  const bounded = (value: string, bytes: number): string =>
    utf8Prefix(redactFreeformText(value).redacted, bytes);
  const details = [`${label} returned ${result.error}`];
  if (result.status !== undefined) details.push(`HTTP status: ${result.status}`);
  if (result.requestStageFacts?.length) {
    const shown = result.requestStageFacts.slice(-8);
    const omitted = result.requestStageFacts.length - shown.length;
    details.push(
      `Request stages${omitted > 0 ? ` (${omitted} earlier omitted)` : ''}: ${JSON.stringify(shown)}`,
    );
  }
  if (backendAttempts.length) {
    details.push(
      [
        'Backend attempts:',
        ...backendAttempts.map(
          ({ backend, outcome, durationMs, detail }) =>
            `- ${backend}: ${outcome} in ${durationMs}ms — ${bounded(detail, 350)}`,
        ),
      ].join('\n'),
    );
  }
  details.push(`Message: ${bounded(result.message, 700)}`);
  if (result.nextAction) details.push(`Next action: ${bounded(result.nextAction, 200)}`);
  if (result.missing?.length) {
    const shown = result.missing.slice(0, 8).map((item) => ({
      name: item.name,
      source: item.source,
      capability: item.capability,
      required: item.required,
      failure: item.failure,
    }));
    details.push(
      `Missing state${result.missing.length > shown.length ? ` (${result.missing.length - shown.length} more omitted)` : ''}: ${JSON.stringify(shown)}`,
    );
  }
  if (result.remediation) details.push(`Remediation: ${bounded(result.remediation, 500)}`);
  if (result.responseBodyPreview)
    details.push(`Response preview: ${bounded(result.responseBodyPreview, 500)}`);
  if (result.continuation) {
    const keys = Object.keys(result.continuation).sort();
    details.push(
      `Continuation fields (${keys.length}): ${keys.slice(0, 16).join(', ')}${keys.length > 16 ? ', …' : ''}`,
    );
  }
  return new Error(utf8Prefix(details.join('\n'), 4_000));
}

async function runLiveCheck(input: {
  tool: EditableTeachingTool;
  compiled: CompiledFocusedTool;
  implementation: ImplementationPlanPayload;
  deps: FreshTeachControllerDependencies;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  maxDurationMs?: number;
}): Promise<UnboundLiveCheckResult> {
  const parameters = liveVerificationParameters(input.implementation);
  const startedAt = Date.now();
  if (input.tool.strategy?.kind === 'playbook_fallback') {
    const playbookPath = pathJoin(input.compiled.toolDir, 'playbook.yaml');
    if (!existsSync(playbookPath)) {
      throw new Error(`playbook fallback "${input.tool.id}" did not produce playbook.yaml`);
    }
    const checked = await runPlaybookToolCheck({
      deps: input.deps,
      playbookPath,
      site: input.compiled.workflow.site,
      parameters,
      runDeadline: input.runDeadline,
      signal: input.signal,
      maxDurationMs: input.maxDurationMs,
      label: `live check for "${input.tool.id}"`,
    });
    return { ...checked, durationMs: Date.now() - startedAt, parameters };
  }
  const checked = await input.deps.runApiTool({
    workflowPath: input.compiled.workflowPath,
    parameters,
    signal: input.signal,
  });
  return { ...checked, durationMs: Date.now() - startedAt, parameters };
}

/** Bound an external playbook promise even when an injected runner ignores
 * cancellation. The normal runner receives the child signal and gets a short
 * chance to close its browser before this host-side guard gives up waiting. */
export async function runPlaybookInvocationWithDeadline<T>(
  input: {
    timeoutMs: number;
    label: string;
    signal?: AbortSignal;
    cleanupGraceMs?: number;
  },
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
  const cleanupGraceMs = Math.max(
    1,
    Math.floor(input.cleanupGraceMs ?? PLAYBOOK_INVOCATION_SETTLE_GRACE_MS),
  );
  const controller = new AbortController();
  const timeoutError = new TimeoutError(input.label, timeoutMs);
  const abortFromParent = (): void => {
    controller.abort(input.signal ? abortSignalError(input.signal) : timeoutError);
  };
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });

  let rejectAfterCleanup: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const settleAfterAbort = (): void => {
    if (rejectAfterCleanup) return;
    rejectAfterCleanup = setTimeout(
      () => rejectAbort?.(abortSignalError(controller.signal)),
      cleanupGraceMs,
    );
  };
  controller.signal.addEventListener('abort', settleAfterAbort, { once: true });
  if (controller.signal.aborted) settleAfterAbort();
  const deadlineTimer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const invocation = Promise.resolve().then(async () => await invoke(controller.signal));
  const completedBeforeAbort = new Promise<T>((resolve, reject) => {
    invocation.then(
      (value) => {
        if (!controller.signal.aborted) resolve(value);
      },
      (error) => {
        if (!controller.signal.aborted) reject(error);
      },
    );
  });

  try {
    return await Promise.race([completedBeforeAbort, aborted]);
  } finally {
    clearTimeout(deadlineTimer);
    if (rejectAfterCleanup) clearTimeout(rejectAfterCleanup);
    controller.signal.removeEventListener('abort', settleAfterAbort);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

async function runPlaybookToolCheck(input: {
  deps: FreshTeachControllerDependencies;
  playbookPath: string;
  site: string;
  parameters: Record<string, string | number | boolean>;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  maxDurationMs?: number;
  label: string;
}): Promise<{
  result: ToolResult<unknown>;
  executionMechanism: string;
  backendAttempts?: BackendAttemptFact[];
}> {
  const remainingRunMs = input.runDeadline.deadlineMs - Date.now();
  if (remainingRunMs <= 0) throw new TimeoutError(input.label, 0);
  const timeoutMs = Math.min(
    remainingRunMs,
    input.deps.playbookInvocationTimeoutMs,
    input.maxDurationMs === undefined ? Number.POSITIVE_INFINITY : input.maxDurationMs,
  );
  return await runPlaybookInvocationWithDeadline(
    {
      timeoutMs,
      label: input.label,
      signal: input.signal,
      cleanupGraceMs: input.deps.playbookCleanupGraceMs,
    },
    async (signal) =>
      await input.deps.runPlaybookTool({
        playbookPath: input.playbookPath,
        site: input.site,
        parameters: input.parameters,
        maxDurationMs: timeoutMs,
        signal,
      }),
  );
}

function receiptPassed(facts: readonly ReceiptFact[]): boolean {
  return (
    facts.every(({ status }) => status === 'passed' || status === 'not_applicable') &&
    facts.some(({ status }) => status === 'passed')
  );
}

async function compileAndCheckCurrentPlan(input: {
  journal: FreshTeachJournal;
  triage: TriageResult;
  sessionPath: string;
  stagingRoot: string;
  llmConfig: LLMOptions;
  runDeadline: RunDeadlineRef;
  deps: FreshTeachControllerDependencies;
  signal?: AbortSignal;
  keepTest?: boolean;
  maxDurationMs?: number;
  report?: (message: string) => void;
  priorCompiled?: Map<string, CompiledFocusedTool>;
  priorRevisionSources?: Map<string, CompiledFocusedTool>;
  priorDraftSources?: Map<string, CompiledFocusedTool>;
  priorLive?: Map<string, LiveCheckResult>;
  priorChain?: Map<string, LiveCheckResult>;
  revisionGuidanceByToolId?: ReadonlyMap<string, string>;
  revisionContextByToolId?: ReadonlyMap<string, FocusedPlannerRevisionContext>;
  /** Durable compiler conversations, one per public tool. */
  compileSessionsByToolId?: Map<string, string>;
  /** Install an independently usable MVP before optional breadth work. */
  publishMvp?: (tool: EditableTeachingTool, compiled: CompiledFocusedTool) => Promise<void>;
  /** Review only the default result's fitness for the core operation. */
  approveMvp?: (
    tool: EditableTeachingTool,
    resultEvidence: CompletionToolResultEvidence,
  ) => Promise<ResultDisposition>;
  /** Returns a prior disposition for an exact retained result receipt. */
  resultDisposition?: (
    toolId: string,
    resultReceiptRef: ContentAddressedRef,
  ) => ResultDisposition | undefined;
  /** True only for the exact build already installed as a usable MVP. */
  isMvpPublished?: (toolId: string, buildRef: ContentAddressedRef) => boolean;
  /** Starts advisory breadth work after the factual MVP proof is complete. */
  onMvpReady?: (toolId: string) => void;
}): Promise<CheckedBuilds> {
  const plan = input.journal.currentPlan();
  const initialState = input.journal.readState();
  const initialBuildRefs = new Map(
    initialState.tools.flatMap(({ toolId, buildRef }) => (buildRef ? [[toolId, buildRef]] : [])),
  );
  const initialToolStateById = new Map(
    initialState.tools.map((toolState) => [toolState.toolId, toolState] as const),
  );
  const needsCompile = new Set(
    plan.tools
      .filter(({ id }) => !initialState.tools.find(({ toolId }) => toolId === id)?.buildRef)
      .map(({ id }) => id),
  );
  const compileTools = plan.tools.filter(({ id }) => needsCompile.has(id));
  const compileWaves = plan.buildWaves
    .map((wave, waveIndex) => ({
      waveIndex,
      toolIds: wave.filter((toolId) => needsCompile.has(toolId)),
    }))
    .filter(({ toolIds }) => toolIds.length > 0);
  const currentToolIds = new Set(plan.tools.map(({ id }) => id));
  const compiledByToolId = new Map(
    [...(input.priorCompiled ?? [])].filter(([toolId]) => currentToolIds.has(toolId)),
  );
  const revisionSourceByToolId = new Map(input.priorRevisionSources ?? []);
  const draftSourceByToolStrategy = new Map(input.priorDraftSources ?? []);
  const draftSourceKey = (toolId: string, strategyKind: CompileStrategyKind): string =>
    `${toolId}\u0000${strategyKind}`;
  const liveByToolId = new Map(
    [...(input.priorLive ?? [])].filter(([toolId, live]) => {
      const buildRef = initialBuildRefs.get(toolId);
      const hasCurrentLiveReceipt = initialToolStateById
        .get(toolId)
        ?.currentReceiptRefs.some(({ key }) => key === 'live');
      const hasCurrentResultReceipt = initialToolStateById
        .get(toolId)
        ?.currentReceiptRefs.some(
          ({ ref }) =>
            ref.path === live.resultReceiptRef.path && ref.sha256 === live.resultReceiptRef.sha256,
        );
      return (
        hasCurrentLiveReceipt === true &&
        hasCurrentResultReceipt === true &&
        buildRef?.path === live.buildRef.path &&
        buildRef.sha256 === live.buildRef.sha256
      );
    }),
  );
  const chainByEdgeId = new Map(
    [...(input.priorChain ?? [])].filter(([edgeId, result]) => {
      const edge = plan.chainEdges.find(({ id }) => id === edgeId);
      if (!edge) return false;
      const buildRef = initialBuildRefs.get(edge.consumerToolId);
      const currentReceipt = initialToolStateById
        .get(edge.consumerToolId)
        ?.currentReceiptRefs.find(({ key }) => key === `chain:${edgeId}`)?.ref;
      return (
        currentReceipt?.path === result.resultReceiptRef.path &&
        currentReceipt.sha256 === result.resultReceiptRef.sha256 &&
        buildRef?.path === result.buildRef.path &&
        buildRef.sha256 === result.buildRef.sha256
      );
    }),
  );
  for (const toolId of needsCompile) {
    compiledByToolId.delete(toolId);
    liveByToolId.delete(toolId);
  }
  for (const edge of plan.chainEdges) {
    if (needsCompile.has(edge.producerToolId) || needsCompile.has(edge.consumerToolId)) {
      chainByEdgeId.delete(edge.id);
    }
  }
  const compileTool = async (
    tool: EditableTeachingTool,
    waveIndex: number,
  ): Promise<CompiledFocusedTool> => {
    if (!tool.implementationPlan || !tool.strategy) {
      throw new Error(`master plan tool "${tool.id}" is missing a focused implementation plan`);
    }
    const implementation = input.journal.readJson(
      tool.implementationPlan,
    ) as ImplementationPlanPayload;
    // A master revision gets new bytes at a new module path. This keeps a
    // failed parser or transform from leaking into the next compile and also
    // avoids Bun's local TypeScript module cache returning the prior build.
    const stagingDir = revisionStagingDir(input.stagingRoot, plan.revision, tool.id);
    input.report?.(
      `wave ${waveIndex + 1}/${plan.buildWaves.length}: compiling ${tool.candidate.toolName}`,
    );
    let lastActivity = '';
    return await input.deps.compileFocusedTool({
      tool,
      implementationPlan: implementation,
      triage: input.triage,
      sessionPath: input.sessionPath,
      stagingDir,
      priorToolDir:
        revisionSourceByToolId.get(tool.id)?.strategyKind === tool.strategy.kind
          ? revisionSourceByToolId.get(tool.id)?.toolDir
          : draftSourceByToolStrategy.get(draftSourceKey(tool.id, tool.strategy.kind))?.toolDir,
      revisionGuidance: input.revisionGuidanceByToolId?.get(tool.id),
      revisionContext: input.revisionContextByToolId?.get(tool.id),
      resumeSessionId: input.compileSessionsByToolId?.get(tool.id),
      onSessionId: (sessionId) => input.compileSessionsByToolId?.set(tool.id, sessionId),
      llmConfig: input.llmConfig,
      runDeadline: input.runDeadline,
      signal: input.signal,
      keepTest: input.keepTest,
      onProgress: (progress) => {
        const activity = describeAgentActivity(progress);
        if (activity === lastActivity) return;
        lastActivity = activity;
        input.report?.(
          `${tool.candidate.toolName}: ${formatElapsed(progress.elapsedMs)} ${activity}`,
        );
      },
    });
  };
  const acceptCompiledTool = (
    tool: EditableTeachingTool,
    _waveIndex: number,
    focused: CompiledFocusedTool,
  ): void => {
    if (!tool.strategy) throw new Error(`tool "${tool.id}" has no accepted strategy`);
    // Preserve the compiler's first concrete attempt for the next fresh
    // same-strategy repair. A promoted known-good artifact still takes
    // precedence and is never overwritten by this draft.
    draftSourceByToolStrategy.set(draftSourceKey(tool.id, tool.strategy.kind), {
      ...focused,
      strategyKind: tool.strategy.kind,
    });
    try {
      input.journal.issueBuild({
        toolId: tool.id,
        workflow: focused.workflow,
        artifacts: storeLocalArtifacts(input.journal, focused.toolDir),
      });
    } catch (error) {
      if (isRepairableBuildArtifactError(error))
        throw new CompiledArtifactContractError(error, focused.compilerSummary);
      throw error;
    }
    const contract = invocationOutcomeCheck({
      subject: 'contract',
      invocationIndex: 0,
      outcome: { kind: 'returned', result: { ok: true, data: null } },
      executionMechanism: 'schema',
    });
    input.journal.issueReceipt({
      toolId: tool.id,
      check: 'contract',
      facts: contract.facts,
    });
    compiledByToolId.set(tool.id, { ...focused, strategyKind: tool.strategy.kind });
  };
  const compiled: BuildWaveResult<CompiledFocusedTool> = { completed: [], failures: [] };
  const failures: BuildWaveFailure[] = [];
  const order = new Map(
    plan.buildWaves.flatMap((wave, waveIndex) =>
      wave.map(
        (toolId, position) => [toolId, waveIndex * (plan.tools.length + 1) + position] as const,
      ),
    ),
  );
  const toolIdByName = new Map(
    plan.tools.map((tool) => [tool.candidate.toolName, tool.id] as const),
  );
  const declaredProducerIdsFor = (tool: EditableTeachingTool): string[] => [
    ...tool.candidate.dependsOnTools.flatMap((name) => toolIdByName.get(name) ?? []),
    ...plan.chainEdges
      .filter(({ consumerToolId }) => consumerToolId === tool.id)
      .map(({ producerToolId }) => producerToolId),
  ];
  const verifiedToolIds = new Set<string>();
  const attemptedMvpToolIds = new Set<string>();
  const approvedMvpToolIds = new Set<string>();
  const rejectedMvpToolIds = new Set<string>();
  const finesseStartedToolIds = new Set<string>();
  const dependencyBlockedToolIds = new Set<string>();
  const currentBuildRef = (toolId: string): ContentAddressedRef | undefined =>
    input.journal.readState().tools.find(({ toolId: id }) => id === toolId)?.buildRef;
  const standaloneProofIsCurrent = (toolId: string): boolean => {
    const proof = input.journal
      .currentExecutionSnapshot()
      .payload.tools.find(({ toolId: id }) => id === toolId);
    return (
      proof?.receipts.some(({ check, status }) => check === 'contract' && status === 'passed') ===
        true && proof.receipts.some(({ check, status }) => check === 'live' && status === 'passed')
    );
  };
  const markVerified = (tool: EditableTeachingTool): void => {
    verifiedToolIds.add(tool.id);
    if (finesseStartedToolIds.has(tool.id)) return;
    finesseStartedToolIds.add(tool.id);
    input.onMvpReady?.(tool.id);
  };
  const hasUsableProducer = (toolId: string): boolean => {
    if (rejectedMvpToolIds.has(toolId)) return false;
    if (!standaloneProofIsCurrent(toolId)) return false;
    if (approvedMvpToolIds.has(toolId)) return true;
    const buildRef = input.journal
      .readState()
      .tools.find(({ toolId: currentToolId }) => currentToolId === toolId)?.buildRef;
    const live = liveByToolId.get(toolId);
    const disposition = live ? input.resultDisposition?.(toolId, live.resultReceiptRef) : undefined;
    return Boolean(
      buildRef &&
        live?.result.ok &&
        disposition?.status === 'credible' &&
        input.isMvpPublished?.(toolId, buildRef),
    );
  };

  const approveAndPublishMvp = async (
    tool: EditableTeachingTool,
    waveIndex: number,
    focused: CompiledFocusedTool,
  ): Promise<boolean> => {
    if (rejectedMvpToolIds.has(tool.id)) return false;
    if (attemptedMvpToolIds.has(tool.id)) {
      return approvedMvpToolIds.has(tool.id);
    }
    attemptedMvpToolIds.add(tool.id);
    const live = liveByToolId.get(tool.id);
    if (!live?.result.ok) throw new Error(`MVP tool "${tool.id}" has no retained live result`);
    const resultEvidence = completionToolResultEvidenceFor(input.journal, tool, live);
    const disposition = input.approveMvp
      ? await input.approveMvp(tool, resultEvidence)
      : ({
          status: 'credible',
          reason: 'semantic review is not configured',
          evidenceRefs: [],
        } as const);
    if (disposition.status !== 'credible') {
      rejectedMvpToolIds.add(tool.id);
      failures.push(
        checkFailure(
          tool,
          waveIndex,
          'proof',
          rejectedResultError(disposition.reason, resultEvidence),
          {
            receiptRef: live.resultReceiptRef,
            compilerSummary: focused.compilerSummary,
            liveResponseObservations: live.responseObservations,
          },
        ),
      );
      return false;
    }
    await input.publishMvp?.(tool, focused);
    // A repair seed is promoted only after this exact build passes contract,
    // live execution, semantic review, and publication. A merely parseable but
    // broken repair can never replace the last known-good artifact.
    revisionSourceByToolId.set(tool.id, { ...focused, strategyKind: tool.strategy?.kind });
    if (tool.strategy)
      draftSourceByToolStrategy.delete(draftSourceKey(tool.id, tool.strategy.kind));
    approvedMvpToolIds.add(tool.id);
    return true;
  };

  const ensureUsableProducer = async (toolId: string): Promise<boolean> => {
    if (hasUsableProducer(toolId)) return true;
    const tool = plan.tools.find(({ id }) => id === toolId);
    const focused = compiledByToolId.get(toolId);
    const live = liveByToolId.get(toolId);
    const buildRef = input.journal
      .readState()
      .tools.find(({ toolId: currentToolId }) => currentToolId === toolId)?.buildRef;
    if (
      !tool ||
      !focused ||
      !live?.result.ok ||
      !buildRef ||
      live.buildRef.path !== buildRef.path ||
      live.buildRef.sha256 !== buildRef.sha256 ||
      !standaloneProofIsCurrent(toolId)
    ) {
      return false;
    }
    await approveAndPublishMvp(
      tool,
      plan.buildWaves.findIndex((wave) => wave.includes(toolId)),
      focused,
    );
    return hasUsableProducer(toolId);
  };

  const unavailableProducerIdsFor = async (tool: EditableTeachingTool): Promise<string[]> => {
    const unavailable: string[] = [];
    for (const producerToolId of new Set(declaredProducerIdsFor(tool))) {
      if (!(await ensureUsableProducer(producerToolId))) unavailable.push(producerToolId);
    }
    return unavailable;
  };

  const runStandaloneLive = async (
    tool: EditableTeachingTool,
    focused: CompiledFocusedTool,
    implementation: ImplementationPlanPayload,
    waveIndex: number,
  ): Promise<LiveCheckResult | undefined> => {
    let observed: UnboundLiveCheckResult;
    try {
      observed = await runLiveCheck({
        tool,
        compiled: focused,
        implementation,
        deps: input.deps,
        runDeadline: input.runDeadline,
        signal: input.signal,
        maxDurationMs: input.maxDurationMs,
      });
    } catch (error) {
      const check = invocationOutcomeCheck({
        subject: 'live',
        invocationIndex: 0,
        outcome: { kind: 'host_error', error },
        executionMechanism: 'host',
      });
      const receipt = input.journal.issueReceipt({
        toolId: tool.id,
        check: 'live',
        facts: check.facts,
      });
      failures.push(
        checkFailure(tool, waveIndex, 'live', error, {
          receiptRef: receipt.ref,
          compilerSummary: focused.compilerSummary,
        }),
      );
      liveByToolId.delete(tool.id);
      return undefined;
    }

    const check = invocationOutcomeCheck({
      subject: 'live',
      invocationIndex: 0,
      outcome: { kind: 'returned', result: observed.result },
      durationMs: observed.durationMs,
      executionMechanism: observed.executionMechanism,
    });
    const receipt = input.journal.issueReceipt({
      toolId: tool.id,
      check: 'live',
      facts: check.facts,
    });
    if (!receiptPassed(check.facts)) {
      failures.push(
        checkFailure(
          tool,
          waveIndex,
          'live',
          observed.result.ok
            ? new Error(`live check failed for "${tool.id}"`)
            : returnedToolFailure(
                `live check for "${tool.id}"`,
                observed.result,
                observed.backendAttempts,
              ),
          {
            receiptRef: receipt.ref,
            compilerSummary: focused.compilerSummary,
            liveResponseObservations: observed.responseObservations,
          },
        ),
      );
      liveByToolId.delete(tool.id);
      return undefined;
    }
    const buildRef = currentBuildRef(tool.id);
    if (!buildRef) throw new Error(`live check lost current build for "${tool.id}"`);
    const live = { ...observed, buildRef, resultReceiptRef: receipt.ref };
    liveByToolId.set(tool.id, live);
    return live;
  };

  const incomingChainInvocationsFor = (toolId: string): ChainInvocation[] => {
    const incoming = plan.chainEdges.filter(({ consumerToolId }) => consumerToolId === toolId);
    const visited = new Set<string>();
    const invocations: ChainInvocation[] = [];
    for (const edge of incoming) {
      if (visited.has(edge.id)) continue;
      const invocation = chainInvocationForEdge(incoming, edge);
      for (const grouped of invocation.edges) visited.add(grouped.id);
      invocations.push(invocation);
    }
    return invocations;
  };

  const runChainCheck = async (
    tool: EditableTeachingTool,
    focused: CompiledFocusedTool,
    implementation: ImplementationPlanPayload,
    invocation: ChainInvocation,
    waveIndex: number,
  ): Promise<LiveCheckResult | undefined> => {
    const { edges } = invocation;
    const firstEdge = edges[0];
    if (!firstEdge) throw new Error(`chain check for "${tool.id}" has no edges`);
    if (edges.some(({ consumerToolId }) => consumerToolId !== firstEdge.consumerToolId))
      throw new Error(`chain check for "${tool.id}" mixed consumers`);
    if (new Set(edges.map(({ consumerParameter }) => consumerParameter)).size !== edges.length)
      throw new Error(`chain check for "${tool.id}" repeated a consumer parameter`);
    input.report?.(`checking chain ${edges.map(({ id }) => id).join(', ')}`);
    let outcome:
      | {
          kind: 'returned';
          result: ToolResult<unknown>;
          durationMs: number;
          mechanism: string;
          backendAttempts?: BackendAttemptFact[];
          responseObservations?: BackendResponseObservation[];
          parameters: Record<string, string | number | boolean>;
        }
      | { kind: 'artifact_error'; error: Error }
      | { kind: 'host_error'; error: unknown };
    let parameters = liveVerificationParameters(implementation);
    let bindingFailure: { edge: ChainEdge; error: Error } | undefined;
    for (const edge of edges) {
      const producer = liveByToolId.get(edge.producerToolId);
      if (!producer?.result.ok) {
        bindingFailure = {
          edge,
          error: new Error(
            `producer "${edge.producerToolId}" has no successful live result for chain "${edge.id}"`,
          ),
        };
        break;
      }
      const binding = bindProducerResultToConsumer({
        edge,
        producerResult: producer.result.data,
        consumerParameterDeclarations: concreteParameterDeclarations(tool),
        consumerParameters: parameters,
      });
      if (!binding.ok) {
        bindingFailure = {
          edge,
          error: new Error(`chain binding "${edge.id}" failed: ${binding.reason}`),
        };
        break;
      }
      parameters = binding.parameters;
    }
    if (bindingFailure) {
      outcome = {
        kind: 'artifact_error',
        error: bindingFailure.error,
      };
    } else {
      try {
        const startedAt = Date.now();
        const chained =
          tool.strategy?.kind === 'playbook_fallback'
            ? await runPlaybookToolCheck({
                deps: input.deps,
                playbookPath: pathJoin(focused.toolDir, 'playbook.yaml'),
                site: focused.workflow.site,
                parameters,
                runDeadline: input.runDeadline,
                signal: input.signal,
                maxDurationMs: input.maxDurationMs,
                label: `chain check "${edges.map(({ id }) => id).join(', ')}"`,
              })
            : await input.deps.runApiTool({
                workflowPath: focused.workflowPath,
                parameters,
                signal: input.signal,
              });
        outcome = {
          kind: 'returned',
          result: chained.result,
          durationMs: Date.now() - startedAt,
          mechanism: chained.executionMechanism,
          backendAttempts: chained.backendAttempts,
          responseObservations:
            'responseObservations' in chained && Array.isArray(chained.responseObservations)
              ? (chained.responseObservations as BackendResponseObservation[])
              : undefined,
          parameters,
        };
      } catch (error) {
        outcome = { kind: 'host_error', error };
      }
    }

    const check = invocationOutcomeCheck({
      subject: 'chain',
      invocationIndex: 0,
      outcome:
        outcome.kind === 'returned'
          ? { kind: 'returned', result: outcome.result }
          : outcome.kind === 'artifact_error'
            ? {
                kind: 'returned',
                result: {
                  ok: false,
                  error: 'STATE_MISSING',
                  message: outcome.error.message,
                },
              }
            : { kind: 'host_error', error: outcome.error },
      ...(outcome.kind === 'returned'
        ? { durationMs: outcome.durationMs, executionMechanism: outcome.mechanism }
        : { executionMechanism: outcome.kind === 'artifact_error' ? 'binding' : 'host' }),
    });
    // A binding failure proves only the exact edge that failed. Once every
    // binding succeeds, the consumer call factually exercises the whole group.
    const checkedEdges = bindingFailure ? [bindingFailure.edge] : edges;
    const receipts = checkedEdges.map((edge) => ({
      edge,
      receipt: input.journal.issueReceipt({
        toolId: tool.id,
        check: 'chain',
        chainEdgeId: edge.id,
        facts: check.facts,
      }),
    }));
    const primary = receipts[0];
    if (!primary) throw new Error(`chain check for "${tool.id}" issued no receipts`);
    const { receipt: primaryReceipt } = primary;
    if (!receiptPassed(check.facts)) {
      const error =
        outcome.kind === 'host_error' || outcome.kind === 'artifact_error'
          ? outcome.error
          : outcome.result.ok
            ? new Error(`chain check "${edges.map(({ id }) => id).join(', ')}" failed`)
            : returnedToolFailure(
                `chain check "${edges.map(({ id }) => id).join(', ')}"`,
                outcome.result,
                outcome.backendAttempts,
              );
      failures.push(
        checkFailure(tool, waveIndex, 'chain', error, {
          receiptRef: primaryReceipt.ref,
          compilerSummary: focused.compilerSummary,
          liveResponseObservations:
            outcome.kind === 'returned' ? outcome.responseObservations : undefined,
          ...(bindingFailure
            ? { chainEdgeId: bindingFailure.edge.id }
            : { chainEdgeIds: edges.map(({ id }) => id) }),
        }),
      );
      for (const edge of edges) chainByEdgeId.delete(edge.id);
      return undefined;
    }
    if (outcome.kind !== 'returned') return undefined;
    const buildRef = currentBuildRef(tool.id);
    if (!buildRef) throw new Error(`chain check lost current build for "${tool.id}"`);
    const shared = {
      result: outcome.result,
      durationMs: outcome.durationMs,
      executionMechanism: outcome.mechanism,
      responseObservations: outcome.responseObservations,
      parameters: outcome.parameters,
      buildRef,
      chainInvocationSha256: invocation.sha256,
    };
    for (const { edge, receipt } of receipts) {
      chainByEdgeId.set(edge.id, { ...shared, resultReceiptRef: receipt.ref });
    }
    return { ...shared, resultReceiptRef: primaryReceipt.ref };
  };

  const reviewChainResult = async (
    tool: EditableTeachingTool,
    invocation: ChainInvocation,
    result: LiveCheckResult,
    waveIndex: number,
  ): Promise<boolean> => {
    const edge = invocation.edges[0];
    if (!edge) throw new Error(`chain result review for "${tool.id}" has no edges`);
    const resultEvidence = completionToolResultEvidenceFor(input.journal, tool, result, edge);
    const disposition = input.approveMvp
      ? await input.approveMvp(tool, resultEvidence)
      : ({
          status: 'credible',
          reason: 'semantic review is not configured',
          evidenceRefs: [],
        } as const);
    if (disposition.status === 'credible') return true;
    failures.push(
      checkFailure(
        tool,
        waveIndex,
        'proof',
        rejectedResultError(
          `Chain invocation [${invocation.edges.map(({ id }) => id).join(', ')}] was rejected: ${disposition.reason}`,
          resultEvidence,
        ),
        {
          receiptRef: result.resultReceiptRef,
          chainEdgeIds: invocation.edges.map(({ id }) => id),
          compilerSummary: compiledByToolId.get(tool.id)?.compilerSummary,
          liveResponseObservations: result.responseObservations,
        },
      ),
    );
    return false;
  };

  const checkNewlyCompiledTool = async ({
    tool,
    waveIndex,
    value: focused,
  }: BuildWaveResult<CompiledFocusedTool>['completed'][number]): Promise<void> => {
    input.report?.(`checking ${tool.candidate.toolName}`);
    if (!tool.implementationPlan || !tool.strategy) {
      failures.push(
        checkFailure(tool, waveIndex, 'compile', new Error('focused plan is incomplete')),
      );
      return;
    }
    const implementation = input.journal.readJson(
      tool.implementationPlan,
    ) as ImplementationPlanPayload;

    const live = await runStandaloneLive(tool, focused, implementation, waveIndex);
    const standaloneApproved = live ? await approveAndPublishMvp(tool, waveIndex, focused) : false;
    let chainReviewFailed = false;
    for (const invocation of incomingChainInvocationsFor(tool.id)) {
      const chained = await runChainCheck(tool, focused, implementation, invocation, waveIndex);
      if (!chained) continue;
      if (!(await reviewChainResult(tool, invocation, chained, waveIndex))) {
        chainReviewFailed = true;
      }
    }

    const proofFailures = mechanicalProofFailures(
      plan,
      input.journal.currentExecutionSnapshot(),
      tool.id,
    );
    if (proofFailures.length === 0 && !chainReviewFailed && standaloneApproved) {
      markVerified(tool);
    } else if (!failures.some(({ toolId }) => toolId === tool.id)) {
      failures.push(checkFailure(tool, waveIndex, 'proof', new Error(proofFailures.join('; '))));
    }
  };

  // Check each wave before starting the next. Tools that reach factual MVP
  // proof start advisory finesse without being awaited while the next wave
  // compiles. Unrelated tools still proceed after a failure; a declared
  // consumer waits until its exact producer build is a published MVP.
  for (const { waveIndex, toolIds } of compileWaves) {
    const runnableToolIds: string[] = [];
    for (const toolId of toolIds) {
      const tool = plan.tools.find(({ id }) => id === toolId);
      if (!tool) continue;
      const unavailableProducers = await unavailableProducerIdsFor(tool);
      if (unavailableProducers.length === 0) {
        runnableToolIds.push(toolId);
        continue;
      }
      dependencyBlockedToolIds.add(tool.id);
      failures.push(
        checkFailure(
          tool,
          waveIndex,
          'proof',
          new Error(
            `waiting for usable producer MVP: ${[...new Set(unavailableProducers)].join(', ')}`,
          ),
        ),
      );
    }
    if (runnableToolIds.length === 0) continue;
    const waveResult = await compileEveryToolInBuildWaves(
      { tools: compileTools, buildWaves: [runnableToolIds] },
      {
        concurrency: FOCUSED_COMPILE_CONCURRENCY,
        compileTool: async (tool) => await compileTool(tool, waveIndex),
        acceptCompiledTool: (tool, _localWaveIndex, focused) =>
          acceptCompiledTool(tool, waveIndex, focused),
      },
    );
    const completed = waveResult.completed
      .map((entry) => ({ ...entry, waveIndex }))
      .sort((left, right) => (order.get(left.tool.id) ?? 0) - (order.get(right.tool.id) ?? 0));
    const waveFailures = waveResult.failures.map((failure) => ({ ...failure, waveIndex }));
    compiled.completed.push(...completed);
    compiled.failures.push(...waveFailures);
    failures.push(...waveFailures);
    for (const entry of completed) await checkNewlyCompiledTool(entry);
  }

  const waveByToolId = new Map(
    plan.buildWaves.flatMap((wave, waveIndex) =>
      wave.map((toolId) => [toolId, waveIndex] as const),
    ),
  );
  const builtThisPass = new Set(compiled.completed.map(({ tool }) => tool.id));
  const proofFor = (toolId: string) =>
    input.journal.currentExecutionSnapshot().payload.tools.find(({ toolId: id }) => id === toolId);
  const hasReceipt = (
    toolId: string,
    check: 'contract' | 'live' | 'chain',
    chainEdgeId?: string,
  ): boolean => {
    const chainEdge =
      check === 'chain' ? plan.chainEdges.find(({ id }) => id === chainEdgeId) : undefined;
    return (
      proofFor(toolId)?.receipts.some(
        (receipt) =>
          receipt.check === check &&
          receipt.status === 'passed' &&
          (check !== 'chain' ||
            (chainEdge !== undefined &&
              receipt.chainEdgeId === chainEdgeId &&
              receipt.chainEdgeSha256 === teachingPlanContentSha256(chainEdge))),
      ) === true
    );
  };
  const runExistingLive = async (
    tool: EditableTeachingTool,
    focused: CompiledFocusedTool,
    implementation: ImplementationPlanPayload,
  ): Promise<LiveCheckResult | undefined> => {
    const waveIndex = waveByToolId.get(tool.id) ?? 0;
    return await runStandaloneLive(tool, focused, implementation, waveIndex);
  };

  const ensureProducerLive = async (
    producerToolId: string,
  ): Promise<LiveCheckResult | undefined> => {
    const buildRef = currentBuildRef(producerToolId);
    const retained = liveByToolId.get(producerToolId);
    if (
      retained?.result.ok &&
      buildRef?.path === retained.buildRef.path &&
      buildRef.sha256 === retained.buildRef.sha256
    ) {
      return retained;
    }
    if (!hasReceipt(producerToolId, 'live')) return undefined;
    const producer = plan.tools.find(({ id }) => id === producerToolId);
    const focused = compiledByToolId.get(producerToolId);
    if (!producer?.implementationPlan || !producer.strategy || !focused || !buildRef)
      return undefined;
    const implementation = input.journal.readJson(
      producer.implementationPlan,
    ) as ImplementationPlanPayload;
    return await runExistingLive(producer, focused, implementation);
  };

  for (const wave of plan.buildWaves) {
    for (const toolId of wave) {
      if (builtThisPass.has(toolId)) continue;
      const tool = plan.tools.find(({ id }) => id === toolId);
      if (!tool) continue;
      if (dependencyBlockedToolIds.has(tool.id)) continue;
      const waveIndex = waveByToolId.get(tool.id) ?? 0;
      const unavailableProducers = await unavailableProducerIdsFor(tool);
      if (unavailableProducers.length > 0) {
        dependencyBlockedToolIds.add(tool.id);
        failures.push(
          checkFailure(
            tool,
            waveIndex,
            'proof',
            new Error(`waiting for usable producer MVP: ${unavailableProducers.join(', ')}`),
          ),
        );
        continue;
      }
      const currentRef = currentBuildRef(tool.id);
      const focused = compiledByToolId.get(tool.id);
      const retainedLive = liveByToolId.get(tool.id);
      const hasCurrentLiveResult =
        retainedLive?.result.ok === true &&
        currentRef?.path === retainedLive.buildRef.path &&
        currentRef.sha256 === retainedLive.buildRef.sha256;
      if (!tool.implementationPlan || !tool.strategy) {
        failures.push(
          checkFailure(tool, waveIndex, 'compile', new Error('focused plan is incomplete')),
        );
        continue;
      }
      if (!focused) {
        failures.push(
          checkFailure(tool, waveIndex, 'compile', new Error('focused artifact is unavailable')),
        );
        continue;
      }

      const buildRef = currentBuildRef(tool.id);
      if (!buildRef) {
        failures.push(
          checkFailure(tool, waveIndex, 'contract', new Error('current build is unavailable')),
        );
        continue;
      }

      const implementation = input.journal.readJson(
        tool.implementationPlan,
      ) as ImplementationPlanPayload;
      if (!hasReceipt(tool.id, 'contract')) {
        const contract = invocationOutcomeCheck({
          subject: 'contract',
          invocationIndex: 0,
          outcome: { kind: 'returned', result: { ok: true, data: null } },
          executionMechanism: 'schema',
        });
        input.journal.issueReceipt({
          toolId: tool.id,
          check: 'contract',
          facts: contract.facts,
        });
      }

      let live = liveByToolId.get(tool.id);
      if (!hasReceipt(tool.id, 'live') || !hasCurrentLiveResult) {
        live = await runExistingLive(tool, focused, implementation);
      }
      const standaloneApproved = live?.result.ok
        ? hasUsableProducer(tool.id) || (await approveAndPublishMvp(tool, waveIndex, focused))
        : false;
      let chainReviewFailed = false;
      for (const invocation of incomingChainInvocationsFor(tool.id)) {
        const retained = invocation.edges.map((edge) => chainByEdgeId.get(edge.id));
        let chained = retained[0];
        if (
          invocation.edges.some((edge, index) => {
            const result = retained[index];
            return (
              !hasReceipt(tool.id, 'chain', edge.id) ||
              !result?.result.ok ||
              result.chainInvocationSha256 !== invocation.sha256
            );
          })
        ) {
          for (const producerToolId of new Set(
            invocation.edges.map(({ producerToolId }) => producerToolId),
          )) {
            await ensureProducerLive(producerToolId);
          }
          chained = await runChainCheck(tool, focused, implementation, invocation, waveIndex);
        }
        if (!chained) continue;
        if (!(await reviewChainResult(tool, invocation, chained, waveIndex))) {
          chainReviewFailed = true;
        }
      }
      if (
        live?.result.ok &&
        standaloneApproved &&
        !chainReviewFailed &&
        mechanicalProofFailures(plan, input.journal.currentExecutionSnapshot(), tool.id).length ===
          0
      ) {
        markVerified(tool);
      }
    }
  }

  const finalSnapshot = input.journal.currentExecutionSnapshot();
  verifiedToolIds.clear();
  for (const tool of plan.tools) {
    if (dependencyBlockedToolIds.has(tool.id)) continue;
    const proofFailures = mechanicalProofFailures(plan, finalSnapshot, tool.id);
    if (proofFailures.length === 0) {
      const focused = compiledByToolId.get(tool.id);
      if (!focused) {
        failures.push(
          checkFailure(
            tool,
            waveByToolId.get(tool.id) ?? 0,
            'proof',
            new Error(`verified tool "${tool.id}" has no staged artifact to publish`),
          ),
        );
        continue;
      }
      const standaloneApproved =
        hasUsableProducer(tool.id) ||
        (await approveAndPublishMvp(tool, waveByToolId.get(tool.id) ?? 0, focused));
      if (standaloneApproved && !failures.some(({ toolId }) => toolId === tool.id)) {
        markVerified(tool);
      }
    } else if (!failures.some(({ toolId }) => toolId === tool.id)) {
      failures.push(
        checkFailure(
          tool,
          waveByToolId.get(tool.id) ?? 0,
          'proof',
          new Error(proofFailures.join('; ')),
        ),
      );
    }
  }

  return {
    compiledByToolId,
    revisionSourceByToolId,
    draftSourceByToolStrategy,
    liveByToolId,
    chainByEdgeId,
    verifiedToolIds,
    failures,
  };
}

function persistSeeds(
  journal: FreshTeachJournal,
  seeds: Map<string, FreshTeachBootstrapObject>,
): void {
  for (const seed of seeds.values()) {
    const actual =
      seed.kind === 'json' ? journal.storeJson(seed.value) : journal.storeBytes(seed.value);
    if (actual.path !== seed.ref.path || actual.sha256 !== seed.ref.sha256) {
      throw new Error('stored content-addressed object does not match its declared ref');
    }
  }
}

export function implementationPlanRepairToolIds(plan: EditableTeachingPlan): string[] {
  return plan.tools
    .filter(
      (tool) =>
        !tool.implementationPlan ||
        tool.implementationPlan.basedOnCompileInputsSha256 !==
          teachingToolCompileInputsSha256(tool, plan.chainEdges),
    )
    .map(({ id }) => id);
}

interface MasterRevisionContext {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  focusedEvidence: Map<string, PromptEvidenceProjection>;
  toolAdvice: ToolAdvice;
  triagedSession: Session;
  independent: IndependentExecutionObservation;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  runDeadline: RunDeadlineRef;
  revisionContextByToolId: ReadonlyMap<string, FocusedPlannerRevisionContext>;
}

function canonicalOrder(left: unknown, right: unknown): number {
  return canonicalTeachingPlanJson(left).localeCompare(canonicalTeachingPlanJson(right));
}

/** Receipts cannot change inside this synchronous planner/master loop; the
 * outer repair guard handles new execution facts. Keep this digest limited to
 * missing compile inputs and the executable proposal the master reviews. */
export function focusedPlanningStateSha256(
  plan: EditableTeachingPlan,
  missingToolIds: readonly string[],
  proposals: readonly ReturnType<typeof FocusedPlannerProposalSchema.parse>[],
): string {
  const toolById = new Map(plan.tools.map((tool) => [tool.id, tool]));
  const missingTools = [...new Set(missingToolIds)]
    .map((toolId) => {
      const tool = toolById.get(toolId);
      if (!tool) throw new Error(`focused planning references missing tool "${toolId}"`);
      return {
        toolId,
        compileInputsSha256: teachingToolCompileInputsSha256(tool, plan.chainEdges),
      };
    })
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
  const executableProposals = proposals
    .map((proposal) => {
      const { path: _implementationPath, ...implementationPlanRef } =
        proposal.payload.implementationPlan.ref;
      return {
        toolId: proposal.payload.tool.id,
        compileInputsSha256: proposal.payload.binding.compileInputsSha256,
        chainEdges: [...proposal.payload.chainEdges].sort(canonicalOrder),
        implementationPlanRef,
        implementationPlanContentSha256: teachingPlanContentSha256(
          proposal.payload.implementationPlan.payload,
        ),
      };
    })
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
  return teachingPlanContentSha256({
    missingTools,
    proposals: executableProposals,
  });
}

function revisionEvidenceRefs(
  context: MasterRevisionContext,
  findings?: PromptEvidenceProjection,
): ContentAddressedRef[] {
  return uniqueRefs([
    ...focusedEvidenceRefs(context.discoveryEvidence),
    ...[...context.focusedEvidence.values()].flatMap(focusedEvidenceRefs),
    ...(findings ? evidenceRefsForProjection(findings) : []),
  ]);
}

async function requestRepairRevision(
  context: MasterRevisionContext,
  findings: PromptEvidenceProjection,
) {
  const current = currentPlanProjection(context.journal);
  const evidenceRefs = revisionEvidenceRefs(context, findings);
  const decisionInput: MasterDecisionInput = {
    phase: 'revision',
    discovery: context.discoveryInput,
    current: {
      run: current.binding,
      plan: current.projection,
      snapshot: context.journal.currentExecutionSnapshot(),
    },
    toolSelectionAdvice: context.toolAdvice,
    plannerProposals: [],
    parameterAdvice: [],
    verificationFindings: findings,
  };
  const decision = await context.deps.requestMasterDecision(decisionInput, context.agent);
  const decisionRef = context.journal.storeJson(decision);
  const toolIdByName = new Map(
    current.plan.tools.map((tool) => [tool.candidate.toolName, tool.id] as const),
  );
  const forceRecompileToolIds = decision.recallToolNames.map((toolName) => {
    const toolId = toolIdByName.get(toolName);
    if (!toolId) throw new Error(`recall references missing public tool name "${toolName}"`);
    return toolId;
  });
  const revision = context.journal.revisePlan(decision.desiredPlan, {
    expectedRevision: current.plan.revision,
    forceRecompileToolIds,
    decision: planDecision(
      context.deps.now(),
      decision.outcome,
      decision.reason,
      [decisionRef],
      evidenceRefs,
    ),
  });
  return { decision, revision };
}

async function ensureCurrentImplementationPlans(context: MasterRevisionContext): Promise<void> {
  const reviewedProposalStates = new Set<string>();
  for (;;) {
    if (Date.now() >= context.runDeadline.deadlineMs) {
      throw new Error('focused implementation-plan repair reached the run deadline');
    }
    const current = currentPlanProjection(context.journal);
    const missingToolIds = implementationPlanRepairToolIds(current.plan);
    if (missingToolIds.length === 0 || current.plan.tools.length === 0) return;

    const seeds = new Map<string, FreshTeachBootstrapObject>();
    const planners = await requestFocusedPlannerBundles({
      plan: current.plan,
      discoveryRun: context.discoveryInput.run,
      recordingIndex: context.discoveryInput.recordingIndex,
      triagedSession: context.triagedSession,
      independent: context.independent,
      seeds,
      agent: context.agent,
      deps: context.deps,
      toolIds: new Set(missingToolIds),
      revisionContextByToolId: context.revisionContextByToolId,
    });
    const proposalStateSha256 = focusedPlanningStateSha256(
      current.plan,
      missingToolIds,
      planners.map(({ proposal }) => proposal),
    );
    if (reviewedProposalStates.has(proposalStateSha256)) {
      throw new Error(
        'focused planning stopped because the same executable focused proposal recurred after the master already reviewed it',
      );
    }
    reviewedProposalStates.add(proposalStateSha256);
    persistSeeds(context.journal, seeds);
    for (const planner of planners) {
      context.focusedEvidence.set(planner.output.tool.id, planner.evidence);
    }
    const evidenceRefs = uniqueRefs([
      ...revisionEvidenceRefs(context),
      ...allEvidenceRefs(context.discoveryEvidence, planners),
    ]);
    const decisionInput: MasterDecisionInput = {
      phase: 'revision',
      discovery: context.discoveryInput,
      current: {
        run: current.binding,
        plan: current.projection,
        snapshot: context.journal.currentExecutionSnapshot(),
      },
      toolSelectionAdvice: context.toolAdvice,
      plannerProposals: planners.map(({ proposal }) => proposal),
      parameterAdvice: [],
    };
    const decision = await context.deps.requestMasterDecision(decisionInput, context.agent);
    const decisionRef = context.journal.storeJson(decision);
    context.journal.revisePlan(decision.desiredPlan, {
      expectedRevision: current.plan.revision,
      decision: planDecision(
        context.deps.now(),
        decision.outcome,
        decision.reason,
        [...planners.map(({ proposal }) => proposal.ref), decisionRef],
        evidenceRefs,
      ),
    });
  }
}

type ParameterFinesseStatus = 'running' | 'suggested' | 'failed' | 'deferred' | 'stale';

interface ParameterFinesseRecord {
  version: 1;
  run: ReturnType<typeof currentPlanProjection>['binding'];
  currentPlanRef: ContentAddressedRef;
  toolId: string;
  toolName: string;
  buildRef: ContentAddressedRef;
  executionBindingSha256: string;
  status: ParameterFinesseStatus;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  advice?: Awaited<ReturnType<typeof requestParameterSelectionAdvice>>;
}

interface ParameterFinesseLane {
  start: (toolId: string) => void;
  stop: (reason: string) => Promise<Record<ParameterFinesseStatus, number>>;
}

/** Keep at most two optional parameter advisors beside the core teach work. */
export class ParameterAdvisorLane {
  private active = 0;
  private readonly waiters: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortSignalError(signal, 'Optional parameter advice cancelled'));
    }
    if (this.active < FOCUSED_COMPILE_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.abort);
          reject(abortSignalError(signal, 'Optional parameter advice cancelled'));
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortSignalError(waiter.signal, 'Optional parameter advice cancelled'));
        continue;
      }
      this.active += 1;
      waiter.resolve();
      return;
    }
  }

  async run<Value>(signal: AbortSignal, work: () => Promise<Value>): Promise<Value> {
    await this.acquire(signal);
    try {
      if (signal.aborted) throw abortSignalError(signal, 'Optional parameter advice cancelled');
      return await work();
    } finally {
      this.release();
    }
  }
}

export function sameFinesseTarget(
  record: { buildRef: ContentAddressedRef; executionBindingSha256: string },
  proof:
    | Pick<
        CurrentExecutionSnapshot['payload']['tools'][number],
        'currentBuildRef' | 'executionBindingSha256'
      >
    | undefined,
): boolean {
  return (
    proof?.currentBuildRef.path === record.buildRef.path &&
    proof.currentBuildRef.sha256 === record.buildRef.sha256 &&
    proof.executionBindingSha256 === record.executionBindingSha256
  );
}

/**
 * Parameter breadth is intentionally outside the authoritative teach state.
 * Each suggestion is bound to one exact MVP build and can be considered by a
 * later finesse pass, but it cannot revise, delay, or invalidate that MVP.
 */
function createParameterFinesseLane(input: {
  runRoot: string;
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  focusedEvidence: Map<string, PromptEvidenceProjection>;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  report?: (message: string) => void;
}): ParameterFinesseLane {
  const records = new Map<string, ParameterFinesseRecord>();
  const advisorLane = new ParameterAdvisorLane();
  const jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; detachParent: () => void }
  >();
  const recordPath = (record: ParameterFinesseRecord): string =>
    pathJoin(
      input.runRoot,
      'finesse',
      record.toolId,
      `${record.buildRef.sha256.slice('sha256:'.length)}-${record.executionBindingSha256.slice('sha256:'.length)}.json`,
    );
  const persist = (key: string, record: ParameterFinesseRecord): void => {
    records.set(key, record);
    try {
      writeJsonAtomic(recordPath(record), record);
    } catch (error) {
      input.report?.(
        `optional finesse result could not be saved: ${boundedTerminalMessage(error)}`,
      );
    }
  };
  const counts = (): Record<ParameterFinesseStatus, number> => {
    const result: Record<ParameterFinesseStatus, number> = {
      running: 0,
      suggested: 0,
      failed: 0,
      deferred: 0,
      stale: 0,
    };
    for (const record of records.values()) result[record.status] += 1;
    return result;
  };

  return {
    start: (toolId) => {
      try {
        const current = currentPlanProjection(input.journal);
        const snapshot = input.journal.currentExecutionSnapshot();
        if (mechanicalProofFailures(current.plan, snapshot, toolId).length > 0) return;
        const tool = current.plan.tools.find(({ id }) => id === toolId);
        const proof = snapshot.payload.tools.find((candidate) => candidate.toolId === toolId);
        if (!tool || !proof) return;
        const key = `${toolId}:${proof.currentBuildRef.sha256}:${proof.executionBindingSha256}`;
        if (records.has(key)) return;
        const record: ParameterFinesseRecord = {
          version: 1,
          run: current.binding,
          currentPlanRef: snapshot.payload.currentPlanRef,
          toolId,
          toolName: tool.candidate.toolName,
          buildRef: proof.currentBuildRef,
          executionBindingSha256: proof.executionBindingSha256,
          status: 'running',
          startedAt: new Date().toISOString(),
        };
        persist(key, record);
        input.report?.(`finessing parameter breadth for ${record.toolName} in the background`);

        const controller = new AbortController();
        const abortFromParent = (): void =>
          controller.abort(
            input.agent.signal
              ? abortSignalError(input.agent.signal)
              : new DOMException('Parameter finesse cancelled', 'AbortError'),
          );
        if (input.agent.signal?.aborted) abortFromParent();
        else input.agent.signal?.addEventListener('abort', abortFromParent, { once: true });
        const detachParent = (): void =>
          input.agent.signal?.removeEventListener('abort', abortFromParent);
        const evidence = input.focusedEvidence.get(toolId) ?? input.discoveryEvidence;
        const advisorInput: ParameterSelectionAdvisorInput = {
          run: current.binding,
          recordingIndex: input.discoveryInput.recordingIndex,
          currentPlan: current.projection,
          snapshot,
          toolId,
          evidence,
        };
        const promise = (async () => {
          const latest = input.journal.currentExecutionSnapshot().payload;
          const latestProof = latest.tools.find((candidate) => candidate.toolId === toolId);
          const stillCurrent = sameFinesseTarget(record, latestProof);
          if (!stillCurrent) {
            persist(key, {
              ...record,
              status: 'stale',
              finishedAt: new Date().toISOString(),
              message: 'The plan or MVP build changed before this finesse pass started.',
            });
            return;
          }

          const adviceAttempt = await advisorLane
            .run(controller.signal, async () => {
              const queuedProof = input.journal
                .currentExecutionSnapshot()
                .payload.tools.find((candidate) => candidate.toolId === toolId);
              if (!sameFinesseTarget(record, queuedProof)) {
                throw new Error(
                  'The plan, MVP build, or dependency changed before optional parameter advice started.',
                );
              }
              return await input.deps.requestParameterSelectionAdvice(advisorInput, {
                ...input.agent,
                signal: controller.signal,
              });
            })
            .then(
              (value) => {
                persist(key, { ...(records.get(key) ?? record), advice: value });
                return { ok: true as const, value };
              },
              (error: unknown) => ({ ok: false as const, error }),
            );

          const after = input.journal.currentExecutionSnapshot().payload;
          const afterProof = after.tools.find((candidate) => candidate.toolId === toolId);
          const remainsCurrent = sameFinesseTarget(record, afterProof);
          const deferred = controller.signal.aborted;
          const hasAdvice = adviceAttempt.ok;
          persist(key, {
            ...(records.get(key) ?? record),
            status: deferred
              ? 'deferred'
              : remainsCurrent
                ? hasAdvice
                  ? 'suggested'
                  : 'failed'
                : 'stale',
            finishedAt: new Date().toISOString(),
            message: deferred
              ? 'The MVP completed before this optional finesse pass; its state is saved as deferred.'
              : !remainsCurrent
                ? 'The plan or MVP build changed before this suggestion returned.'
                : hasAdvice
                  ? 'Parameter-selection advice is available. Live breadth testing is deferred to a later finesse run.'
                  : `parameter advisor: ${boundedTerminalMessage(adviceAttempt.error)}`,
            ...(adviceAttempt.ok ? { advice: adviceAttempt.value } : {}),
          });
        })()
          .catch((error) => {
            const deferred = controller.signal.aborted;
            persist(key, {
              ...(records.get(key) ?? record),
              status: deferred ? 'deferred' : 'failed',
              finishedAt: new Date().toISOString(),
              message: deferred
                ? 'The MVP completed before this optional finesse pass; its state is saved as deferred.'
                : boundedTerminalMessage(error),
            });
          })
          .finally(() => {
            detachParent();
            jobs.delete(key);
          });
        jobs.set(key, { controller, promise, detachParent });
      } catch (error) {
        input.report?.(`parameter finesse could not start: ${boundedTerminalMessage(error)}`);
      }
    },
    stop: async (reason) => {
      const pending = [...jobs.entries()];
      for (const [key, job] of pending) {
        const record = records.get(key);
        if (record?.status === 'running') {
          persist(key, {
            ...record,
            status: 'deferred',
            finishedAt: new Date().toISOString(),
            message: reason,
          });
        }
        job.controller.abort(new DOMException(reason, 'AbortError'));
        job.detachParent();
      }
      if (pending.length > 0) {
        await Promise.race([
          Promise.allSettled(pending.map(([, job]) => job.promise)),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
      }
      return counts();
    },
  };
}

function completionInput(input: {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  evidence: PromptEvidenceProjection;
  terminalIntent: 'completed' | 'partial' | 'blocked';
  unresolvedEvidenceRefs?: readonly ContentAddressedRef[];
  liveByToolId?: ReadonlyMap<string, LiveCheckResult>;
  chainByEdgeId?: ReadonlyMap<string, LiveCheckResult>;
}): CompletionReviewInput {
  const current = currentPlanProjection(input.journal);
  const exclusionClaims = current.plan.candidateCoverage.flatMap(
    ({ discoveryCandidateName, excludedReason }, index) =>
      excludedReason
        ? [
            {
              id: `candidate-exclusion-${index}`,
              kind: 'exclusion' as const,
              statement: utf8Prefix(
                `Exclude detector candidate "${discoveryCandidateName}": ${excludedReason}`,
                1_000,
              ),
              evidenceRefs: [input.evidence.ref],
            },
          ]
        : [],
  );
  const unresolvedClaims = current.plan.candidateCoverage.flatMap(
    ({ discoveryCandidateName, unresolvedReason }, index) =>
      unresolvedReason
        ? [
            {
              id: `candidate-unresolved-${index}`,
              kind: 'blocker' as const,
              statement: utf8Prefix(
                `Unresolved detector candidate "${discoveryCandidateName}": ${unresolvedReason}`,
                1_000,
              ),
              evidenceRefs: uniqueRefs([
                input.evidence.ref,
                ...(input.unresolvedEvidenceRefs ?? []),
              ]).slice(0, 32),
            },
          ]
        : [],
  );
  const claims =
    input.terminalIntent === 'blocked'
      ? [
          {
            id: 'no_supported_tool',
            kind: 'blocker' as const,
            statement: 'The authoritative master plan contains no tool that can be completed.',
            evidenceRefs: [input.evidence.ref],
          },
        ]
      : input.terminalIntent === 'partial'
        ? [...exclusionClaims, ...unresolvedClaims]
        : exclusionClaims;
  const toolResultEvidence =
    input.terminalIntent === 'completed' || input.terminalIntent === 'partial'
      ? completionToolResultEvidence(
          input.journal,
          current.plan,
          input.liveByToolId ?? new Map(),
        ).concat(
          completionChainResultEvidence(
            input.journal,
            current.plan,
            input.chainByEdgeId ?? new Map(),
          ),
        )
      : undefined;
  return {
    terminalIntent: input.terminalIntent,
    run: current.binding,
    recordingIndex: input.discoveryInput.recordingIndex,
    currentPlan: current.projection,
    snapshot: input.journal.currentExecutionSnapshot(),
    history: input.journal.receiptHistoryProjection(),
    evidence: input.evidence,
    ...(toolResultEvidence ? { toolResultEvidence } : {}),
    claims,
  };
}

function structuralResultShape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= 2 || value.length === 0) return 'array';
    return `array<${structuralResultShape(value[0], depth + 1)}>`;
  }
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 24);
  if (depth >= 2) return 'object';
  return `object{${keys
    .map(
      (key) =>
        `${key}:${structuralResultShape((value as Record<string, unknown>)[key], depth + 1)}`,
    )
    .join(',')}}`;
}

function completionToolResultEvidence(
  journal: FreshTeachJournal,
  plan: EditableTeachingPlan,
  liveByToolId: ReadonlyMap<string, LiveCheckResult>,
): CompletionToolResultEvidence[] {
  return plan.tools.map((tool) => {
    const live = liveByToolId.get(tool.id);
    if (!live?.result.ok) throw new Error(`tool "${tool.id}" has no retained live result`);
    return completionToolResultEvidenceFor(journal, tool, live);
  });
}

function completionChainResultEvidence(
  journal: FreshTeachJournal,
  plan: EditableTeachingPlan,
  chainByEdgeId: ReadonlyMap<string, LiveCheckResult>,
): CompletionToolResultEvidence[] {
  const tools = new Map(plan.tools.map((tool) => [tool.id, tool] as const));
  return plan.chainEdges.map((edge) => {
    const tool = tools.get(edge.consumerToolId);
    const live = chainByEdgeId.get(edge.id);
    if (!tool || !live?.result.ok)
      throw new Error(`chain "${edge.id}" has no retained successful result`);
    return completionToolResultEvidenceFor(journal, tool, live, edge);
  });
}

function completionToolResultEvidenceFor(
  journal: FreshTeachJournal,
  tool: EditableTeachingTool,
  live: LiveCheckResult,
  chainEdge?: ChainEdge,
): CompletionToolResultEvidence {
  if (!tool.implementationPlan) throw new Error(`tool "${tool.id}" has no implementation plan`);
  const implementation = journal.readJson(tool.implementationPlan) as ImplementationPlanPayload;
  const verification = implementation.verificationCases.find(({ check }) => check === 'live');
  if (!verification) throw new Error(`tool "${tool.id}" has no live verification case`);
  const resultReceipt = journal
    .currentExecutionSnapshot()
    .payload.tools.find(({ toolId }) => toolId === tool.id)
    ?.receipts.find(
      ({ ref, status }) =>
        status === 'passed' &&
        ref.path === live.resultReceiptRef.path &&
        ref.sha256 === live.resultReceiptRef.sha256,
    );
  if (!resultReceipt || !['live', 'chain'].includes(resultReceipt.check) || !live.result.ok) {
    throw new Error(`tool "${tool.id}" has no retained successful result`);
  }
  const serialized = JSON.stringify(live.result.data) ?? 'null';
  const preview = utf8Prefix(serialized, 2_000);
  const shape = utf8Prefix(structuralResultShape(live.result.data), 512) || 'unknown';
  const payload = {
    toolId: tool.id,
    toolName: tool.candidate.toolName,
    implementationPlanRef: tool.implementationPlan,
    verificationCaseId: verification.id,
    expectedResult: verification.expectedResult,
    resultReceiptRef: resultReceipt.ref,
    ...(chainEdge ? { chainEdgeId: chainEdge.id } : {}),
    actualResult: {
      observed: true,
      preview,
      shape,
      count: resultCollectionCount(live.result.data),
      truncated: Buffer.byteLength(serialized, 'utf8') > Buffer.byteLength(preview, 'utf8'),
    },
  };
  const ref = journal.storeJson(payload);
  return CompletionToolResultEvidenceSchema.parse({ ref, payload });
}

async function requestIndependentReview(input: {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  evidence: PromptEvidenceProjection;
  terminalIntent: 'completed' | 'partial' | 'blocked';
  unresolvedEvidenceRefs?: readonly ContentAddressedRef[];
  liveByToolId?: ReadonlyMap<string, LiveCheckResult>;
  chainByEdgeId?: ReadonlyMap<string, LiveCheckResult>;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
}): Promise<{ reviewInput: CompletionReviewInput; review: CompletionReview }> {
  const reviewInput = completionInput(input);
  const review = await input.deps.requestCompletionReview(reviewInput, input.agent);
  return { reviewInput, review };
}

async function promoteCompletedTools(input: {
  site: string;
  runId: string;
  runRoot: string;
  tools: readonly CompiledFocusedTool[];
}): Promise<void> {
  const promotionRoot = pathJoin(input.runRoot, 'promotion');
  mkdirSync(promotionRoot, { recursive: true, mode: 0o700 });
  const prepared: Array<{
    toolName: string;
    source: string;
    target: string;
    backup: string;
  }> = [];
  for (const compiled of input.tools) {
    const toolName = compiled.workflow.toolName;
    const promotionId = randomUUID();
    const source = pathJoin(promotionRoot, 'prepared', toolName, promotionId);
    mkdirSync(source, { recursive: true, mode: 0o700 });
    for (const name of PROMOTED_FILES) {
      const from = pathJoin(compiled.toolDir, name);
      if (existsSync(from) && statSync(from).isFile()) copyFileSync(from, pathJoin(source, name));
    }
    const workflowPath = pathJoin(source, 'workflow.json');
    if (!existsSync(workflowPath))
      throw new Error(`promotion is missing ${toolName}/workflow.json`);
    emit({ workflowPath, outDir: source, force: true });
    prepared.push({
      toolName,
      source,
      target: localToolDir(input.site, toolName),
      backup: pathJoin(promotionRoot, 'backups', toolName, promotionId),
    });
  }

  const promoted: typeof prepared = [];
  try {
    for (const item of prepared) {
      mkdirSync(dirname(item.backup), { recursive: true, mode: 0o700 });
      if (existsSync(item.target)) renameSync(item.target, item.backup);
      try {
        renameSync(item.source, item.target);
      } catch (error) {
        if (existsSync(item.backup) && !existsSync(item.target))
          renameSync(item.backup, item.target);
        throw error;
      }
      promoted.push(item);
    }
  } catch (error) {
    for (const item of [...promoted].reverse()) {
      const failedCopy = pathJoin(promotionRoot, 'failed', item.toolName, randomUUID());
      mkdirSync(dirname(failedCopy), { recursive: true, mode: 0o700 });
      if (existsSync(item.target)) renameSync(item.target, failedCopy);
      if (existsSync(item.backup)) renameSync(item.backup, item.target);
    }
    throw error;
  }
}

function writeTerminalResult(result: FreshTeachTerminalResult): FreshTeachTerminalResult {
  writeJson(pathJoin(result.runRoot, 'terminal.json'), result);
  return result;
}

function currentTerminalCounts(
  journal: FreshTeachJournal | undefined,
  fallback: { planned: number; ready: number },
  publishedBuilds?: ReadonlySet<string>,
): { readyTools: number; nonReadyTools: number } {
  if (!journal) {
    return {
      readyTools: fallback.ready,
      nonReadyTools: Math.max(0, fallback.planned - fallback.ready),
    };
  }
  try {
    const plan = journal.currentPlan();
    const state = journal.readState();
    const readyTools = publishedBuilds
      ? plan.tools.filter((tool) => {
          const buildRef = state.tools.find(({ toolId }) => toolId === tool.id)?.buildRef;
          return Boolean(buildRef && publishedBuilds.has(`${tool.id}:${buildRef.sha256}`));
        }).length
      : plan.tools.filter(
          (tool) =>
            mechanicalProofFailures(plan, journal.currentExecutionSnapshot(), tool.id).length === 0,
        ).length;
    return {
      readyTools,
      nonReadyTools: plan.tools.length - readyTools + unresolvedCandidateCoverage(plan).length,
    };
  } catch {
    return {
      readyTools: fallback.ready,
      nonReadyTools: Math.max(0, fallback.planned - fallback.ready),
    };
  }
}

export async function promoteReviewedCompletion(input: {
  journal: Pick<FreshTeachJournal, 'recordCompletionReview' | 'finish'>;
  reviewInput: CompletionReviewInput;
  review: CompletionReview;
  promote: () => Promise<void>;
  status?: 'completed' | 'partial';
}): Promise<void> {
  input.journal.recordCompletionReview(input.reviewInput, input.review);
  await input.promote();
  input.journal.finish(input.status ?? 'completed');
}

/** Run the complete fresh teach in the caller's foreground process. */
export async function runFreshMasterTeach(
  opts: FreshTeachOptions,
  overrides: Partial<FreshTeachControllerDependencies> = {},
): Promise<FreshTeachTerminalResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const site = assertSiteName(opts.site);
  const runId = deps.runId();
  const runRoot = pathJoin(localSiteDir(site), '.teach-runs', runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = pathJoin(runRoot, 'staging');
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const deadline = new RunDeadline(Date.now() + (opts.maxDurationMs ?? 12 * 60 * 60_000));
  const agents = agentOptions(opts, deadline);
  let journal: FreshTeachJournal | undefined;
  let finesse: ParameterFinesseLane | undefined;
  let plannedTools = 0;
  let readyTools = 0;
  const publishedMvpBuilds = new Set<string>();

  try {
    reportProgress(opts, 'resolving the latest recording');
    const recording = await resolveRecordingForFreshRun(opts, site, deps);
    const redacted = redactRecording(recording, runRoot);
    const fullScope = prepareFullSessionForTeach(redacted.session);
    const triagedPath = pathJoin(runRoot, 'recording.triaged.json');
    // The detector may use a narrowed advisory view, but the master must be
    // able to recover from both triage and telemetry-classifier mistakes.
    // Preserve every valid XHR/Fetch from the redacted recording here.
    const masterPayload = buildToolCandidatePayload(redacted.session, {
      trustSessionScope: true,
    });
    // The recording is the teaching evidence. Replaying the entire session in
    // Chrome before planning duplicated that evidence and put a multi-minute
    // browser startup on the critical path. A compiler can still choose a live
    // browser later when the recorded operation actually requires one.
    const independent: IndependentExecutionObservation = {
      status: 'not_requested',
      requests: [],
      unmatchedRecordingRequestSeqs: [],
    };
    const seeds = new Map<string, FreshTeachBootstrapObject>();
    let detection: Detection | undefined;
    let selected: CandidateSelection | undefined;
    if (opts.fromCandidates) {
      writeJson(triagedPath, fullScope.session);
      reportProgress(
        opts,
        `reusing candidate selection from run ${candidateSourceRunId(opts.fromCandidates)}`,
      );
      const checkpoint = loadCandidateSelectionCheckpoint({
        site,
        sourceRunId: opts.fromCandidates,
        recordingSha256: recording.recordingSha256,
        recordingIndex: recordingIndexFromSession(fullScope.session, recording.recordingSha256),
      });
      for (const seed of checkpoint.bootstrap) {
        seeds.set(contentRefKey(seed.ref), seed);
      }
      selected = checkpoint.selection;
      reportProgress(
        opts,
        `reused ${selected.discoveryInput.discoveryCandidates.length} selected operation(s); planning starts fresh`,
      );
    } else {
      reportProgress(opts, 'triaging the redacted recording');
      let detectorScope = fullScope;
      try {
        detectorScope = await deps.prepareSession(redacted.session, llmOptions(opts), {
          signal: opts.signal,
          deadlineMs: deadline.deadlineMs,
          runDeadline: deadline,
        });
      } catch (error) {
        if (opts.signal?.aborted) throw abortSignalError(opts.signal);
        const controlError = providerControlError(error);
        if (controlError) throw controlError;
        reportProgress(
          opts,
          `request triage was unavailable; discovering from the complete recording (${boundedTerminalMessage(error)})`,
        );
      }
      writeJson(triagedPath, detectorScope.session);
      const detectorPayload = buildToolCandidatePayload(detectorScope.session, {
        trustSessionScope: true,
      });
      reportProgress(opts, 'discovering operations');
      detection = await deps.detectToolCandidates(detectorScope.session, llmOptions(opts), {
        trustSessionScope: true,
        candidatePayload: detectorPayload,
        signal: opts.signal,
        deadlineMs: deadline.deadlineMs,
        runDeadline: deadline,
      });
      reportProgress(opts, `reviewing ${detection.candidates.length} discovered operation(s)`);
    }
    const planned = await discoverAndPlan({
      site,
      runId,
      recordingSha256: recording.recordingSha256,
      triage: fullScope,
      candidatePayload: masterPayload,
      detection,
      selected,
      independent,
      seeds,
      agent: agents,
      deps,
      now: deps.now(),
      onSelected: (selection) => writeCandidateSelectionCheckpoint(runRoot, selection, seeds),
    });
    plannedTools = planned.plan.tools.length;
    reportProgress(
      opts,
      `master planned ${plannedTools} tool(s) in ${planned.plan.buildWaves.length} wave(s)`,
    );
    const activeJournal = FreshTeachJournal.create({
      root: pathJoin(runRoot, 'journal'),
      run: { runId, site, recordingSha256: recording.recordingSha256 },
      plan: planned.plan,
      validation: {
        site,
        recordingSha256: recording.recordingSha256,
        requestSeqs: new Set(planned.discoveryInput.recordingIndex.requestSeqs),
        eventSeqs: new Set(planned.discoveryInput.recordingIndex.eventSeqs),
        discoveryCandidateNames: planned.discoveryInput.discoveryCandidates.map(
          ({ toolName }) => toolName,
        ),
      },
      sharedManifest: { files: [] },
      bootstrap: [...seeds.values()],
    });
    journal = activeJournal;
    finesse = createParameterFinesseLane({
      runRoot,
      journal: activeJournal,
      discoveryInput: planned.discoveryInput,
      discoveryEvidence: planned.discoveryEvidence,
      focusedEvidence: planned.focusedEvidence,
      agent: agents,
      deps,
      report: (message) => reportProgress(opts, message),
    });

    let compiledByToolId = new Map<string, CompiledFocusedTool>();
    let revisionSourceByToolId = new Map<string, CompiledFocusedTool>();
    let draftSourceByToolStrategy = new Map<string, CompiledFocusedTool>();
    let liveByToolId = new Map<string, LiveCheckResult>();
    let chainByEdgeId = new Map<string, LiveCheckResult>();
    const compileSessionsByToolId = new Map<string, string>();
    const revisionGuidanceByToolId = new Map<string, string>();
    const repairContextByToolId = new Map<string, FocusedPlannerRevisionContext>();
    const latestFailureEvidenceByToolName = new Map<string, PromptEvidenceEntry[]>();
    const mvpDispositionByResult = new Map<
      string,
      Pick<
        Awaited<ReturnType<typeof requestBaselineMvpReview>>,
        'status' | 'reason' | 'evidenceRefs'
      >
    >();
    const attemptedRepairStates = new Set<string>();
    const revisionContext = (): MasterRevisionContext => ({
      journal: activeJournal,
      discoveryInput: planned.discoveryInput,
      discoveryEvidence: planned.discoveryEvidence,
      focusedEvidence: planned.focusedEvidence,
      toolAdvice: planned.toolAdvice,
      triagedSession: fullScope.session,
      independent,
      agent: agents,
      deps,
      runDeadline: deadline,
      revisionContextByToolId: repairContextByToolId,
    });
    const repair = async (findings: PromptEvidenceProjection): Promise<void> => {
      const stateSha256 = repairStateSha256(activeJournal, findings);
      if (attemptedRepairStates.has(stateSha256)) {
        throw new Error(
          'teach stopped because the same unresolved tool plan, artifacts, check facts, and failure recurred after the master already reviewed them; published MVP tools remain installed',
        );
      }
      attemptedRepairStates.add(stateSha256);
      reportProgress(opts, 'master is revising the plan from factual failures');
      const latestRepairContexts = focusedRepairContexts(activeJournal, findings);
      const context = revisionContext();
      const { decision: repairDecision, revision } = await requestRepairRevision(context, findings);
      repairContextByToolId.clear();
      for (const toolId of revision.recompileToolIds) {
        const repairContext = latestRepairContexts.get(toolId);
        if (repairContext) repairContextByToolId.set(toolId, repairContext);
      }
      revisionGuidanceByToolId.clear();
      for (const toolId of revision.recompileToolIds) {
        revisionGuidanceByToolId.set(toolId, repairDecision.reason);
      }
      await ensureCurrentImplementationPlans(revisionContext());
      plannedTools = activeJournal.currentPlan().tools.length;
    };

    while (true) {
      const currentPlan = activeJournal.currentPlan();
      plannedTools = currentPlan.tools.length;
      if (plannedTools === 0) {
        const reviewed = await requestIndependentReview({
          journal: activeJournal,
          discoveryInput: planned.discoveryInput,
          evidence: planned.discoveryEvidence,
          terminalIntent: 'blocked',
          agent: agents,
          deps,
        });
        if (reviewed.review.verdict === 'passed') {
          activeJournal.finishWithReview('blocked', reviewed.reviewInput, reviewed.review);
          await finesse.stop('No MVP tool was available; optional finesse was deferred.');
          return writeTerminalResult({
            status: 'blocked',
            readyTools: 0,
            nonReadyTools: 0,
            runRoot,
            message: 'No discovered operation currently has an evidence-backed tool plan.',
          });
        }
        await repair(completionFailureProjection(activeJournal, reviewed.review));
        continue;
      }

      await ensureCurrentImplementationPlans(revisionContext());
      let checked: CheckedBuilds;
      try {
        checked = await compileAndCheckCurrentPlan({
          journal: activeJournal,
          triage: fullScope,
          sessionPath: redacted.path,
          stagingRoot,
          llmConfig: llmOptions(opts),
          runDeadline: deadline,
          deps,
          signal: opts.signal,
          keepTest: opts.keepTest,
          maxDurationMs: opts.maxDurationMs,
          report: (message) => reportProgress(opts, message),
          priorCompiled: compiledByToolId,
          priorRevisionSources: revisionSourceByToolId,
          priorDraftSources: draftSourceByToolStrategy,
          priorLive: liveByToolId,
          priorChain: chainByEdgeId,
          revisionGuidanceByToolId,
          revisionContextByToolId: repairContextByToolId,
          compileSessionsByToolId,
          isMvpPublished: (toolId, buildRef) =>
            publishedMvpBuilds.has(`${toolId}:${buildRef.sha256}`),
          resultDisposition: (toolId, resultReceiptRef) =>
            mvpDispositionByResult.get(`${toolId}:${resultReceiptRef.sha256}`),
          approveMvp: async (tool, resultEvidence) => {
            const key = `${tool.id}:${resultEvidence.payload.resultReceiptRef.sha256}`;
            // The disposition is bound to the content-addressed implementation,
            // live receipt, and result. Reuse only those semantic facts across
            // explanation-only plan revisions; never reuse the old plan binding.
            let disposition = mvpDispositionByResult.get(key);
            if (!disposition) {
              reportProgress(opts, `reviewing the core result for ${tool.candidate.toolName}`);
              const current = currentPlanProjection(activeJournal);
              const review = await deps.requestBaselineMvpReview(
                {
                  run: current.binding,
                  recordingIndex: planned.discoveryInput.recordingIndex,
                  currentPlan: current.projection,
                  snapshot: activeJournal.currentExecutionSnapshot(),
                  toolId: tool.id,
                  resultEvidence,
                },
                agents,
              );
              disposition = {
                status: review.status,
                reason: review.reason,
                evidenceRefs: review.evidenceRefs,
              };
              mvpDispositionByResult.set(key, disposition);
              const reviewRef = activeJournal.storeJson(review);
              writeJsonAtomic(
                pathJoin(
                  runRoot,
                  'mvp-reviews',
                  tool.id,
                  `${resultEvidence.payload.resultReceiptRef.sha256.slice('sha256:'.length)}.json`,
                ),
                { resultEvidence, reviewRef, review },
              );
            }
            return disposition;
          },
          publishMvp: async (tool, compiled) => {
            const buildRef = activeJournal
              .readState()
              .tools.find(({ toolId }) => toolId === tool.id)?.buildRef;
            if (!buildRef) throw new Error(`MVP tool "${tool.id}" has no current build`);
            const key = `${tool.id}:${buildRef.sha256}`;
            if (publishedMvpBuilds.has(key)) return;
            reportProgress(opts, `publishing usable MVP ${tool.candidate.toolName}`);
            await deps.promote({ site, runId, runRoot, tools: [compiled] });
            publishedMvpBuilds.add(key);
          },
          onMvpReady: (toolId) => finesse?.start(toolId),
        });
      } catch (error) {
        const status = terminalStatusForError(error, opts.signal);
        if (status === 'cancelled' || status === 'provider_unavailable') throw error;
        throw error;
      }
      compiledByToolId = checked.compiledByToolId;
      revisionSourceByToolId = checked.revisionSourceByToolId;
      draftSourceByToolStrategy = checked.draftSourceByToolStrategy;
      liveByToolId = checked.liveByToolId;
      chainByEdgeId = checked.chainByEdgeId;
      for (const toolId of checked.verifiedToolIds) {
        revisionGuidanceByToolId.delete(toolId);
        repairContextByToolId.delete(toolId);
      }
      readyTools = checked.verifiedToolIds.size;
      if (checked.failures.length > 0) {
        const terminal = checked.failures.find(({ error }) =>
          ['cancelled', 'provider_unavailable'].includes(
            terminalStatusForError(error, opts.signal),
          ),
        );
        if (terminal) throw terminal.error;
        const currentFailures = verificationFailureProjection(activeJournal, checked.failures);
        if (currentFailures.payload.entries.length > 0) {
          rememberLatestFailureEvidence(
            activeJournal.currentPlan(),
            currentFailures,
            latestFailureEvidenceByToolName,
          );
          await repair(currentFailures);
        }
        continue;
      }

      const finalPlan = activeJournal.currentPlan();
      let terminalIntent: 'completed' | 'partial' = 'completed';
      const proofFailures = mechanicalProofFailures(
        finalPlan,
        activeJournal.currentExecutionSnapshot(),
      );
      if (proofFailures.length > 0) {
        const failures = finalPlan.tools
          .filter(
            (tool) =>
              mechanicalProofFailures(finalPlan, activeJournal.currentExecutionSnapshot(), tool.id)
                .length > 0,
          )
          .map((tool) =>
            checkFailure(
              tool,
              finalPlan.buildWaves.findIndex((wave) => wave.includes(tool.id)),
              'proof',
              new Error(
                mechanicalProofFailures(
                  finalPlan,
                  activeJournal.currentExecutionSnapshot(),
                  tool.id,
                ).join('; '),
              ),
            ),
          );
        if (failures.length > 0) {
          const currentFailures = verificationFailureProjection(activeJournal, failures);
          rememberLatestFailureEvidence(
            activeJournal.currentPlan(),
            currentFailures,
            latestFailureEvidenceByToolName,
          );
          await repair(currentFailures);
          continue;
        }
        if (finalPlan.tools.length > 0 && unresolvedCandidateCoverage(finalPlan).length > 0) {
          terminalIntent = 'partial';
        } else {
          throw new Error(
            `completion proof failed without an actionable tool or unresolved candidate: ${proofFailures.join('; ')}`,
          );
        }
      }

      const partialEvidence =
        terminalIntent === 'partial'
          ? partialCompletionEvidence({
              journal: activeJournal,
              discoveryEvidence: planned.discoveryEvidence,
              plan: finalPlan,
              latestFailureEvidenceByToolName,
            })
          : undefined;
      reportProgress(opts, 'running independent completion review');
      const reviewed = await requestIndependentReview({
        journal: activeJournal,
        discoveryInput: planned.discoveryInput,
        evidence: partialEvidence?.evidence ?? planned.discoveryEvidence,
        terminalIntent,
        ...(partialEvidence ? { unresolvedEvidenceRefs: partialEvidence.failureRefs } : {}),
        liveByToolId,
        chainByEdgeId,
        agent: agents,
        deps,
      });
      if (reviewed.review.verdict !== 'passed') {
        await repair(completionFailureProjection(activeJournal, reviewed.review));
        continue;
      }
      const finalState = activeJournal.readState();
      const missingPublishedTools = finalPlan.tools.filter((tool) => {
        const buildRef = finalState.tools.find(({ toolId }) => toolId === tool.id)?.buildRef;
        if (!buildRef) throw new Error(`reviewed tool "${tool.id}" has no current build`);
        return !publishedMvpBuilds.has(`${tool.id}:${buildRef.sha256}`);
      });
      const missingCompiled = missingPublishedTools.map((tool) => {
        const compiled = compiledByToolId.get(tool.id);
        if (!compiled) throw new Error(`reviewed tool "${tool.id}" has no staged artifact`);
        return compiled;
      });
      reportProgress(
        opts,
        missingCompiled.length > 0
          ? `publishing ${missingCompiled.length} remaining MVP tool(s)`
          : 'recording completion for the already-published MVP tools',
      );
      await promoteReviewedCompletion({
        journal: activeJournal,
        reviewInput: reviewed.reviewInput,
        review: reviewed.review,
        status: terminalIntent,
        promote: async () => {
          if (missingCompiled.length === 0) return;
          await deps.promote({ site, runId, runRoot, tools: missingCompiled });
          const state = activeJournal.readState();
          for (const tool of missingPublishedTools) {
            const buildRef = state.tools.find(({ toolId }) => toolId === tool.id)?.buildRef;
            if (!buildRef) throw new Error(`published tool "${tool.id}" lost its current build`);
            publishedMvpBuilds.add(`${tool.id}:${buildRef.sha256}`);
          }
        },
      });
      readyTools = finalPlan.tools.length;
      const finesseCounts = await finesse.stop(
        'The MVP was promoted before this optional finesse pass finished; its state is saved as deferred.',
      );
      const availableFinesse = finesseCounts.suggested;
      const unresolvedTools = unresolvedCandidateCoverage(finalPlan).length;
      return writeTerminalResult({
        status: terminalIntent,
        readyTools,
        nonReadyTools: unresolvedTools,
        runRoot,
        message:
          terminalIntent === 'completed'
            ? `Every one of ${readyTools} planned tool(s) reached a usable MVP and was promoted. ${availableFinesse} optional finesse suggestion(s) are saved under ${pathJoin(runRoot, 'finesse')}; unfinished work is recorded there as deferred and did not delay the MVP.`
            : `${readyTools} usable MVP tool(s) were reviewed and promoted; ${unresolvedTools} discovered operation(s) remain explicitly unresolved. ${availableFinesse} optional finesse suggestion(s) are saved under ${pathJoin(runRoot, 'finesse')}.`,
      });
    }
  } catch (error) {
    const status = terminalStatusForError(error, opts.signal);
    await finesse?.stop('The teach run ended before this optional finesse pass finished.');
    try {
      if (journal?.readState().status === 'active') journal.finish(status, { hostError: error });
    } catch {
      // The terminal result remains authoritative for the foreground command;
      // immutable run files are retained for diagnosis if journal finalization failed.
    }
    const counts = currentTerminalCounts(
      journal,
      {
        planned: plannedTools,
        ready: readyTools,
      },
      publishedMvpBuilds,
    );
    return writeTerminalResult({
      status,
      ...counts,
      runRoot,
      message: boundedTerminalMessage(error),
    });
  }
}
