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
import { type RenderedRequestLookup, runWorkflowWithLadder } from './backend-ladder.ts';
import type { CompileAgentProgress } from './compile-agent-types.ts';
import { type TriageResult, generate } from './compile.ts';
import { type Replacement, extractCredentials } from './credential-extract.ts';
import { emit } from './emit.ts';
import { type LLMOptions, type ProviderName, detectTeachProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import {
  type CompletionReviewInput,
  type CompletionToolResultEvidence,
  CompletionToolResultEvidenceSchema,
  CurrentPlanProjectionSchema,
  type FocusedPlannerInput,
  FocusedPlannerProposalSchema,
  type MasterDecisionInput,
  type ParameterSelectionAdvisorInput,
  type ToolSelectionAdvisorInput,
} from './master-teach-agent-contracts.ts';
import {
  type MasterTeachAgentOptions,
  mechanicalProofFailures,
  requestCompletionReview,
  requestFocusedPlan,
  requestMasterDecision,
  requestParameterSelectionAdvice,
  requestToolSelectionAdvice,
} from './master-teach-agents.ts';
import {
  acceptedRequestComparisonCheck,
  acceptedRequestNotCheckedCheck,
  bindProducerResultToConsumer,
  invocationOutcomeCheck,
} from './master-teach-checks.ts';
import {
  type ChainEdge,
  type ContentAddressedRef,
  type DesiredTeachingPlan,
  type EditableTeachingPlan,
  type EditableTeachingTool,
  type ImplementationPlanPayload,
  bindImplementationPlanRef,
  canonicalTeachingPlanJson,
  createEditableTeachingPlan,
  normalizeDetectorCandidateForMaster,
  normalizeDetectorCompileContextForMaster,
  teachingPlanContentSha256,
  teachingToolCompileInputsSha256,
  unresolvedCandidateCoverage,
} from './master-teach-plan.ts';
import {
  type PromptEvidenceProjection,
  PromptEvidenceProjectionSchema,
  type ReceiptFact,
  recordingIndexFromSession,
} from './master-teach-prompt-projections.ts';
import {
  type FreshTeachBootstrapObject,
  FreshTeachJournal,
  type FreshTeachRunStatus,
} from './master-teach-store.ts';
import { localSiteDir, localToolDir } from './paths.ts';
import { runPlaybook } from './playbook-runner.ts';
import { describeAgentActivity, formatElapsed } from './progress.ts';
import { ProviderUnavailableError, RunDeadline, type RunDeadlineRef } from './provider-retry.ts';
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
export const DISCOVERY_EVIDENCE_CHARACTER_BUDGET = 750_000;
export const FOCUSED_EVIDENCE_CHARACTER_BUDGET = 700_000;
const PROMOTED_FILES = [
  'workflow.json',
  'parser.ts',
  'request-transform.ts',
  'playbook.yaml',
] as const;
const JOURNALED_LOCAL_FILES = ['parser.ts', 'request-transform.ts', 'playbook.yaml'] as const;

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
  keepTest?: boolean;
  /** Optional explicit spelling for the same master-led flow. */
  agent?: 'codex';
  /** Foreground-only human progress. It never affects orchestration. */
  onProgress?: (message: string) => void;
}

export type FreshTeachTerminalStatus = Exclude<FreshTeachRunStatus, 'active'>;

export interface FreshTeachTerminalResult {
  status: FreshTeachTerminalStatus;
  readyTools: number;
  failedTools: number;
  runRoot: string;
  message: string;
}

interface BuildWaveFailure {
  toolId: string;
  toolName: string;
  waveIndex: number;
  stage: 'compile' | 'contract' | 'replay' | 'live' | 'chain' | 'proof';
  error: unknown;
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
  concurrency?: number;
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
        try {
          const value = await dependencies.compileTool(tool, waveIndex);
          completed.push({ tool, waveIndex, value });
        } catch (error) {
          failures.push({
            toolId: tool.id,
            toolName: tool.candidate.toolName,
            waveIndex,
            stage: 'compile',
            error,
          });
        }
      }
    });
    await Promise.all(workers);
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
      failedTools: failedIds.size,
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
}

interface LiveCheckResult {
  result: ToolResult<unknown>;
  durationMs: number;
  executionMechanism: string;
  parameters: Record<string, string | number | boolean>;
  buildRef: ContentAddressedRef;
}

type UnboundLiveCheckResult = Omit<LiveCheckResult, 'buildRef'>;

type ToolAdvice = Awaited<ReturnType<typeof requestToolSelectionAdvice>>;
type FocusedPlan = Awaited<ReturnType<typeof requestFocusedPlan>>;
type CompletionReview = Awaited<ReturnType<typeof requestCompletionReview>>;
type Detection = Awaited<ReturnType<typeof detectToolCandidates>>;

/** Test seams are deliberately role-sized; production defaults use the shipped modules. */
interface FreshTeachControllerDependencies {
  now: () => Date;
  runId: () => string;
  record: typeof record;
  resolveTeachingRecording: typeof resolveTeachingRecording;
  prepareSession: (session: Session) => TriageResult;
  observeIndependentExecution: typeof observeIndependentExecution;
  detectToolCandidates: typeof detectToolCandidates;
  requestToolSelectionAdvice: typeof requestToolSelectionAdvice;
  requestFocusedPlan: typeof requestFocusedPlan;
  requestMasterDecision: typeof requestMasterDecision;
  requestParameterSelectionAdvice: typeof requestParameterSelectionAdvice;
  requestCompletionReview: typeof requestCompletionReview;
  compileFocusedTool: (input: {
    tool: EditableTeachingTool;
    implementationPlan: ImplementationPlanPayload;
    incidentChainEdges: readonly ChainEdge[];
    triage: TriageResult;
    sessionPath: string;
    stagingDir: string;
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
  }) => Promise<{ result: ToolResult<unknown>; executionMechanism: string }>;
  runPlaybookTool: (input: {
    playbookPath: string;
    site: string;
    parameters: Record<string, string | number | boolean>;
    maxDurationMs?: number;
  }) => Promise<{ result: ToolResult<unknown>; executionMechanism: string }>;
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
  prepareSession: prepareFullSessionForTeach,
  observeIndependentExecution,
  detectToolCandidates,
  requestToolSelectionAdvice,
  requestFocusedPlan,
  requestMasterDecision,
  requestParameterSelectionAdvice,
  requestCompletionReview,
  compileFocusedTool: compileFocusedToolWithShippedAgent,
  runApiTool: async ({ workflowPath, parameters, signal }) => {
    const run = await runWorkflowWithLadder({
      workflowPath,
      params: parameters,
      signal,
    });
    return { result: run.result, executionMechanism: run.usedBackend };
  },
  runPlaybookTool: async ({ playbookPath, site, parameters, maxDurationMs }) => ({
    result: await runPlaybook({
      playbook: playbookPath,
      params: parameters,
      site,
      maxDurationMs,
    }),
    executionMechanism: 'playbook',
  }),
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

/** Keep every master revision in a clean module namespace. */
export function revisionStagingDir(
  stagingRoot: string,
  planRevision: number,
  toolId: string,
): string {
  return pathJoin(stagingRoot, `revision-${planRevision}`, toolId);
}

/**
 * Teaching discovery needs the complete redacted recording. This mechanically
 * marks every request as selected and performs no semantic or effect analysis;
 * focused agents decide what the operations mean later.
 */
export function prepareFullSessionForTeach(session: Session): TriageResult {
  const selectedSeqs = session.requests.map(({ seq }) => seq);
  const coveredOutboundEventSeqs = session.events
    .filter(({ type }) => type === 'ws-sent')
    .map(({ seq }) => seq);
  return {
    session,
    selectedSeqs,
    replaySafeSeqs: selectedSeqs,
    irreversibleSeqs: [],
    coveredOutboundEventSeqs,
    irreversibleEventSeqs: [],
    consideredCount: session.requests.length,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
  };
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

/** Apply the shipped credential extractor before ordinary redaction so both
 * teaching agents and the optional independent execution retain named inputs. */
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
  return {
    object,
    entry: {
      kind: 'untrusted_redacted_quote',
      ref: object.ref,
      provenance: document.provenance,
      quote: utf8Prefix(JSON.stringify(document.value), 4_000) || '{}',
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

function verificationFailureProjection(
  journal: FreshTeachJournal,
  failures: readonly BuildWaveFailure[],
): PromptEvidenceProjection {
  const plan = journal.currentPlan();
  const snapshot = journal.currentExecutionSnapshot();
  const entries: PromptEvidenceProjection['payload']['entries'] = [];
  const seenReceipts = new Set<string>();
  for (const failure of failures) {
    const proof = snapshot.payload.tools.find(({ toolId }) => toolId === failure.toolId);
    const receipt = proof?.receipts.find(
      ({ check, status }) => check === failure.stage && status !== 'passed',
    );
    if (receipt && !seenReceipts.has(receipt.ref.sha256)) {
      const tool = plan.tools.find(({ id }) => id === failure.toolId);
      entries.push({
        kind: 'mechanical_fact',
        ref: receipt.ref,
        requestSeqs: (tool?.candidate.requestSeqs ?? []).slice(0, 128),
        eventSeqs: (tool?.candidate.eventSeqs ?? []).slice(0, 128),
        toolId: failure.toolId,
        check: receipt.check,
        status: receipt.status,
        facts: receipt.facts.slice(0, 64),
      });
      seenReceipts.add(receipt.ref.sha256);
      continue;
    }
    const fact = {
      stage: failure.stage,
      toolId: failure.toolId,
      toolName: failure.toolName,
      waveIndex: failure.waveIndex,
      message: utf8Prefix(
        failure.error instanceof Error ? failure.error.message : String(failure.error),
        1_000,
      ),
    };
    const ref = journal.storeJson(fact);
    entries.push({
      kind: 'untrusted_redacted_quote',
      ref,
      provenance: 'check_history',
      quote: utf8Prefix(JSON.stringify(fact), 4_000),
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
        quote: utf8Prefix(JSON.stringify(fact), 4_000),
      };
    }),
  );
}

function orchestrationFailureProjection(
  journal: FreshTeachJournal,
  stage: 'verification' | 'completion_review',
  error: unknown,
): PromptEvidenceProjection {
  const fact = {
    stage,
    message: utf8Prefix(error instanceof Error ? error.message : String(error), 1_000),
  };
  const ref = journal.storeJson(fact);
  return storedEvidenceProjection(journal, [
    {
      kind: 'untrusted_redacted_quote',
      ref,
      provenance: 'check_history',
      quote: utf8Prefix(JSON.stringify(fact), 4_000),
    },
  ]);
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

function llmOptions(opts: FreshTeachOptions): LLMOptions {
  const provider = opts.provider ?? detectTeachProvider();
  return { provider, ...(opts.model ? { model: opts.model } : {}) };
}

function agentOptions(
  opts: FreshTeachOptions,
  deadline: RunDeadline,
  deps?: Partial<MasterTeachAgentOptions>,
): MasterTeachAgentOptions {
  return {
    provider: opts.provider ?? detectTeachProvider(),
    ...(opts.model ? { model: opts.model } : {}),
    deadlineMs: deadline.deadlineMs,
    runDeadline: deadline,
    signal: opts.signal,
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
  incidentChainEdges: readonly ChainEdge[];
  triage: TriageResult;
  sessionPath: string;
  stagingDir: string;
  llmConfig: LLMOptions;
  runDeadline: RunDeadlineRef;
  signal?: AbortSignal;
  keepTest?: boolean;
  onProgress?: (progress: CompileAgentProgress) => void;
}): Promise<CompiledFocusedTool> {
  mkdirSync(input.stagingDir, { recursive: true, mode: 0o700 });
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
    keepTest: input.keepTest,
    onProgress: input.onProgress,
    toolPlan: JSON.stringify(
      {
        tool: input.tool,
        incidentChainEdges: input.incidentChainEdges,
        implementationPlan: input.implementationPlan,
      },
      null,
      2,
    ),
    strategyKind: input.implementationPlan.strategyKind,
  });
  return {
    workflow: result.workflow,
    workflowPath: result.workflowPath,
    toolDir: dirname(result.workflowPath),
  };
}

function verificationParameters(
  implementation: ImplementationPlanPayload,
  check: 'replay' | 'live',
): Record<string, string | number | boolean> {
  const verification = implementation.verificationCases.find(
    (candidate) => candidate.check === check,
  );
  if (!verification) throw new Error(`implementation plan has no ${check} verification case`);
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

function recordedResponseFor(session: Session) {
  return (method: string, url: string, lookup: RenderedRequestLookup) => {
    const acceptedSeq = lookup.provenance?.recordingRequestSeq;
    const request =
      acceptedSeq === undefined
        ? session.requests.find(
            (candidate) =>
              candidate.method.toUpperCase() === method.toUpperCase() && candidate.url === url,
          )
        : session.requests.find((candidate) => candidate.seq === acceptedSeq);
    return request?.response
      ? {
          status: request.response.status,
          body: request.response.body ?? '{}',
          headers: request.response.headers,
        }
      : undefined;
  };
}

export async function apiReplayFacts(input: {
  compiled: CompiledFocusedTool;
  implementation: ImplementationPlanPayload;
  session: Session;
  credentialNames?: readonly string[];
}): Promise<ReceiptFact[]> {
  const replayCase = input.implementation.verificationCases.find(
    (candidate) => candidate.check === 'replay',
  );
  if (!replayCase) throw new Error('implementation plan has no replay verification case');
  const hasNoPublicParameters = input.compiled.workflow.parameters.length === 0;
  if (
    replayCase.parameterValueOrigin !== 'recorded_baseline' &&
    !(replayCase.parameterValueOrigin === undefined && hasNoPublicParameters)
  ) {
    return acceptedRequestNotCheckedCheck({
      provenance: input.implementation.requestProvenance,
    }).facts;
  }
  const { renderWorkflowRequests } = await import('./backend-ladder.ts');
  const rendered = await renderWorkflowRequests({
    workflow: input.compiled.workflow,
    workflowPath: input.compiled.workflowPath,
    params: verificationParameters(input.implementation, 'replay'),
    credentials: {
      site: input.compiled.workflow.site,
      cookies: [],
      values: Object.fromEntries(
        (input.credentialNames ?? []).map((name) => [name, `\${credential.${name}}`]),
      ),
      storage: [],
    },
    requestProvenance: input.implementation.requestProvenance,
    recordedResponseFor: recordedResponseFor(input.session),
  });
  if (!rendered.result.ok) {
    return acceptedRequestNotCheckedCheck({
      provenance: input.implementation.requestProvenance,
      hostError: new Error(`offline replay render failed: ${rendered.result.error}`),
    }).facts;
  }
  return acceptedRequestComparisonCheck({
    provenance: input.implementation.requestProvenance,
    recordedRequests: input.session.requests,
    artifactRequests: rendered.requests.map((request, index) => ({
      ...request,
      body: request.body ?? undefined,
      recordingRequestSeq: input.implementation.requestProvenance[index]?.recordingRequestSeq,
    })),
  }).facts;
}

interface FocusedPlannerBundle {
  evidence: PromptEvidenceProjection;
  output: FocusedPlan;
}

interface HostedPlannerBundle extends FocusedPlannerBundle {
  proposal: ReturnType<typeof FocusedPlannerProposalSchema.parse>;
}

function desiredPart(plan: EditableTeachingPlan): DesiredTeachingPlan {
  return {
    site: plan.site,
    recordingSha256: plan.recordingSha256,
    tools: plan.tools,
    candidateCoverage: plan.candidateCoverage,
    buildWaves: plan.buildWaves,
    chainEdges: plan.chainEdges,
  };
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
      const plannerInput: FocusedPlannerInput = {
        run: input.discoveryRun,
        recordingIndex: input.recordingIndex,
        masterGuidance: input.plan.decision.reason,
        tool,
        availableProducers: available.filter(({ toolId }) => toolId !== sourceTool.id),
        incomingChainEdges: input.plan.chainEdges.filter(
          ({ consumerToolId }) => consumerToolId === sourceTool.id,
        ),
        outgoingChainEdges: input.plan.chainEdges.filter(
          ({ producerToolId }) => producerToolId === sourceTool.id,
        ),
        evidence,
      };
      return {
        evidence,
        output: await input.deps.requestFocusedPlan(plannerInput, input.agent),
      } satisfies FocusedPlannerBundle;
    },
  });
  if (planned.failures.length > 0) {
    throwTerminalFanoutFailure(planned.failures, input.agent.signal);
    throw new AggregateError(
      planned.failures.map(({ error }) => error),
      `focused planning failed for ${planned.failures.length} of ${targetTools.length} tools`,
    );
  }

  const bundles = planned.completed.map(({ value }) => value);
  const proposedConsumerIds = new Set(bundles.map(({ output }) => output.tool.id));
  const effectiveEdges = [
    ...input.plan.chainEdges.filter(
      ({ consumerToolId }) => !proposedConsumerIds.has(consumerToolId),
    ),
    ...bundles.flatMap(({ output }) => output.chainEdges),
  ];

  return bundles.map((bundle) => {
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
  candidatePayload: ReturnType<typeof buildToolCandidatePayload>;
  detection: Detection;
  independent: IndependentExecutionObservation;
  seeds: Map<string, FreshTeachBootstrapObject>;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  now: Date;
}): Promise<{
  plan: EditableTeachingPlan;
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  focusedEvidence: Map<string, PromptEvidenceProjection>;
  advisorRefs: ContentAddressedRef[];
  toolAdvice: ToolAdvice;
}> {
  const recordingIndex = recordingIndexFromSession(input.triage.session, input.recordingSha256);
  const discoveryCandidates = input.detection.candidates.map((candidate) =>
    normalizeDetectorCandidateForMaster(candidate),
  );
  const discoveryEvidence = buildPromptEvidenceProjection(
    discoveryEvidenceDocuments({
      candidatePayload: input.candidatePayload,
    }),
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
  const run = {
    runId: input.runId,
    site: input.site,
    recordingSha256: input.recordingSha256,
  };
  const discoveryInput: ToolSelectionAdvisorInput = {
    run,
    recordingIndex,
    detectorSharedContext,
    discoveryCandidates,
    evidence: discoveryEvidence,
  };
  const advice = await input.deps.requestToolSelectionAdvice(discoveryInput, input.agent);
  const adviceRef = addBootstrap(input.seeds, jsonRef(advice));
  const discoveryDecisionInput: MasterDecisionInput = {
    phase: 'discovery',
    discovery: discoveryInput,
    toolSelectionAdvice: advice,
    plannerProposals: [],
    parameterAdvice: [],
  };
  const discoveryDecision = await input.deps.requestMasterDecision(
    discoveryDecisionInput,
    input.agent,
  );
  const discoveryDecisionRef = addBootstrap(input.seeds, jsonRef(discoveryDecision));
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
      discoveryCandidateNames: discoveryCandidates.map(({ toolName }) => toolName),
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
  const finalDecision = await input.deps.requestMasterDecision(revisionInput, input.agent);
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
      discoveryCandidateNames: discoveryCandidates.map(({ toolName }) => toolName),
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
  liveByToolId: Map<string, LiveCheckResult>;
  verifiedToolIds: Set<string>;
  failures: BuildWaveFailure[];
}

function checkFailure(
  tool: EditableTeachingTool,
  waveIndex: number,
  stage: BuildWaveFailure['stage'],
  error: unknown,
): BuildWaveFailure {
  return {
    toolId: tool.id,
    toolName: tool.candidate.toolName,
    waveIndex,
    stage,
    error,
  };
}

async function runLiveCheck(input: {
  tool: EditableTeachingTool;
  compiled: CompiledFocusedTool;
  implementation: ImplementationPlanPayload;
  deps: FreshTeachControllerDependencies;
  signal?: AbortSignal;
  maxDurationMs?: number;
}): Promise<UnboundLiveCheckResult> {
  const parameters = verificationParameters(input.implementation, 'live');
  const startedAt = Date.now();
  if (input.tool.strategy?.kind === 'playbook_fallback') {
    const playbookPath = pathJoin(input.compiled.toolDir, 'playbook.yaml');
    if (!existsSync(playbookPath)) {
      throw new Error(`playbook fallback "${input.tool.id}" did not produce playbook.yaml`);
    }
    const checked = await input.deps.runPlaybookTool({
      playbookPath,
      site: input.compiled.workflow.site,
      parameters,
      maxDurationMs: input.maxDurationMs,
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
  priorLive?: Map<string, LiveCheckResult>;
}): Promise<CheckedBuilds> {
  const plan = input.journal.currentPlan();
  const initialState = input.journal.readState();
  const initialBuildRefs = new Map(
    initialState.tools.flatMap(({ toolId, buildRef }) => (buildRef ? [[toolId, buildRef]] : [])),
  );
  const needsCompile = new Set(
    plan.tools
      .filter(({ id }) => !initialState.tools.find(({ toolId }) => toolId === id)?.buildRef)
      .map(({ id }) => id),
  );
  const compilePlan = {
    tools: plan.tools.filter(({ id }) => needsCompile.has(id)),
    buildWaves: plan.buildWaves
      .map((wave) => wave.filter((toolId) => needsCompile.has(toolId)))
      .filter((wave) => wave.length > 0),
  };
  const currentToolIds = new Set(plan.tools.map(({ id }) => id));
  const compiledByToolId = new Map(
    [...(input.priorCompiled ?? [])].filter(([toolId]) => currentToolIds.has(toolId)),
  );
  const liveByToolId = new Map(
    [...(input.priorLive ?? [])].filter(([toolId, live]) => {
      const buildRef = initialBuildRefs.get(toolId);
      return buildRef?.path === live.buildRef.path && buildRef.sha256 === live.buildRef.sha256;
    }),
  );
  for (const toolId of needsCompile) {
    compiledByToolId.delete(toolId);
    liveByToolId.delete(toolId);
  }
  const compiled = await compileEveryToolInBuildWaves(compilePlan, {
    concurrency: FOCUSED_COMPILE_CONCURRENCY,
    compileTool: async (tool, waveIndex) => {
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
        incidentChainEdges: plan.chainEdges.filter(
          (edge) => edge.producerToolId === tool.id || edge.consumerToolId === tool.id,
        ),
        triage: input.triage,
        sessionPath: input.sessionPath,
        stagingDir,
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
    },
  });
  const failures = [...compiled.failures];
  const order = new Map(
    plan.buildWaves.flatMap((wave, waveIndex) =>
      wave.map(
        (toolId, position) => [toolId, waveIndex * (plan.tools.length + 1) + position] as const,
      ),
    ),
  );
  compiled.completed.sort(
    (left, right) => (order.get(left.tool.id) ?? 0) - (order.get(right.tool.id) ?? 0),
  );
  const verifiedToolIds = new Set<string>();

  for (const { tool, waveIndex, value: focused } of compiled.completed) {
    input.report?.(`checking ${tool.candidate.toolName}`);
    compiledByToolId.set(tool.id, focused);
    if (!tool.implementationPlan || !tool.strategy) {
      failures.push(
        checkFailure(tool, waveIndex, 'compile', new Error('focused plan is incomplete')),
      );
      continue;
    }
    const implementation = input.journal.readJson(
      tool.implementationPlan,
    ) as ImplementationPlanPayload;
    try {
      input.journal.issueBuild({
        toolId: tool.id,
        workflow: focused.workflow,
        artifacts: storeLocalArtifacts(input.journal, focused.toolDir),
      });
    } catch (error) {
      failures.push(checkFailure(tool, waveIndex, 'contract', error));
      continue;
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

    try {
      if (tool.strategy.kind === 'playbook_fallback') {
        input.journal.issueReceipt({ toolId: tool.id, check: 'replay' });
      } else {
        const facts = await apiReplayFacts({
          compiled: focused,
          implementation,
          session: input.triage.session,
          credentialNames: tool.compileContext.credentialNames,
        });
        input.journal.issueReceipt({ toolId: tool.id, check: 'replay', facts });
        if (!receiptPassed(facts)) {
          failures.push(
            checkFailure(
              tool,
              waveIndex,
              'replay',
              new Error(`replay check failed for "${tool.id}"`),
            ),
          );
        }
      }
    } catch (error) {
      input.journal.issueReceipt({
        toolId: tool.id,
        check: 'replay',
        facts: acceptedRequestNotCheckedCheck({
          provenance: implementation.requestProvenance,
          hostError: error,
        }).facts,
      });
      failures.push(checkFailure(tool, waveIndex, 'replay', error));
    }

    let live: UnboundLiveCheckResult | undefined;
    try {
      live = await runLiveCheck({
        tool,
        compiled: focused,
        implementation,
        deps: input.deps,
        signal: input.signal,
        maxDurationMs: input.maxDurationMs,
      });
      const check = invocationOutcomeCheck({
        subject: 'live',
        invocationIndex: 0,
        outcome: { kind: 'returned', result: live.result },
        durationMs: live.durationMs,
        executionMechanism: live.executionMechanism,
      });
      input.journal.issueReceipt({
        toolId: tool.id,
        check: 'live',
        facts: check.facts,
      });
      if (!receiptPassed(check.facts)) {
        failures.push(
          checkFailure(tool, waveIndex, 'live', new Error(`live check failed for "${tool.id}"`)),
        );
      } else {
        const buildRef = input.journal
          .readState()
          .tools.find(({ toolId }) => toolId === tool.id)?.buildRef;
        if (!buildRef) throw new Error(`live check lost current build for "${tool.id}"`);
        liveByToolId.set(tool.id, { ...live, buildRef });
      }
    } catch (error) {
      const check = invocationOutcomeCheck({
        subject: 'live',
        invocationIndex: 0,
        outcome: { kind: 'host_error', error },
        executionMechanism: 'host',
      });
      input.journal.issueReceipt({
        toolId: tool.id,
        check: 'live',
        facts: check.facts,
      });
      failures.push(checkFailure(tool, waveIndex, 'live', error));
    }

    for (const edge of plan.chainEdges.filter(({ consumerToolId }) => consumerToolId === tool.id)) {
      try {
        const producer = liveByToolId.get(edge.producerToolId);
        if (!producer?.result.ok) {
          throw new Error(`producer "${edge.producerToolId}" has no successful live result`);
        }
        const binding = bindProducerResultToConsumer({
          edge,
          producerResult: producer.result.data,
          consumerParameterDeclarations: concreteParameterDeclarations(tool),
          consumerParameters: live?.parameters ?? verificationParameters(implementation, 'live'),
        });
        if (!binding.ok) throw new Error(`chain binding failed: ${binding.reason}`);
        const startedAt = Date.now();
        const chained =
          tool.strategy.kind === 'playbook_fallback'
            ? await input.deps.runPlaybookTool({
                playbookPath: pathJoin(focused.toolDir, 'playbook.yaml'),
                site: focused.workflow.site,
                parameters: binding.parameters,
                maxDurationMs: input.maxDurationMs,
              })
            : await input.deps.runApiTool({
                workflowPath: focused.workflowPath,
                parameters: binding.parameters,
                signal: input.signal,
              });
        const check = invocationOutcomeCheck({
          subject: 'chain',
          invocationIndex: 0,
          outcome: { kind: 'returned', result: chained.result },
          durationMs: Date.now() - startedAt,
          executionMechanism: chained.executionMechanism,
        });
        input.journal.issueReceipt({
          toolId: tool.id,
          check: 'chain',
          chainEdgeId: edge.id,
          facts: check.facts,
        });
        if (!receiptPassed(check.facts)) {
          failures.push(
            checkFailure(tool, waveIndex, 'chain', new Error(`chain check "${edge.id}" failed`)),
          );
        }
      } catch (error) {
        const check = invocationOutcomeCheck({
          subject: 'chain',
          invocationIndex: 0,
          outcome: { kind: 'host_error', error },
          executionMechanism: 'host',
        });
        input.journal.issueReceipt({
          toolId: tool.id,
          check: 'chain',
          chainEdgeId: edge.id,
          facts: check.facts,
        });
        failures.push(checkFailure(tool, waveIndex, 'chain', error));
      }
    }

    const proofFailures = mechanicalProofFailures(
      plan,
      input.journal.currentExecutionSnapshot(),
      tool.id,
    );
    if (proofFailures.length === 0) verifiedToolIds.add(tool.id);
    else {
      failures.push(checkFailure(tool, waveIndex, 'proof', new Error(proofFailures.join('; '))));
    }
  }

  const waveByToolId = new Map(
    plan.buildWaves.flatMap((wave, waveIndex) =>
      wave.map((toolId) => [toolId, waveIndex] as const),
    ),
  );
  const builtThisPass = new Set(compiled.completed.map(({ tool }) => tool.id));
  const currentBuildRef = (toolId: string): ContentAddressedRef | undefined =>
    input.journal.readState().tools.find(({ toolId: id }) => id === toolId)?.buildRef;
  const proofFor = (toolId: string) =>
    input.journal.currentExecutionSnapshot().payload.tools.find(({ toolId: id }) => id === toolId);
  const hasReceipt = (
    toolId: string,
    check: 'contract' | 'replay' | 'live' | 'chain',
    status: 'passed' | 'not_applicable',
    chainEdgeId?: string,
  ): boolean =>
    proofFor(toolId)?.receipts.some(
      (receipt) =>
        receipt.check === check &&
        receipt.status === status &&
        (check !== 'chain' || receipt.chainEdgeId === chainEdgeId),
    ) === true;

  const runExistingLive = async (
    tool: EditableTeachingTool,
    focused: CompiledFocusedTool,
    implementation: ImplementationPlanPayload,
  ): Promise<LiveCheckResult | undefined> => {
    const waveIndex = waveByToolId.get(tool.id) ?? 0;
    try {
      const observed = await runLiveCheck({
        tool,
        compiled: focused,
        implementation,
        deps: input.deps,
        signal: input.signal,
        maxDurationMs: input.maxDurationMs,
      });
      const check = invocationOutcomeCheck({
        subject: 'live',
        invocationIndex: 0,
        outcome: { kind: 'returned', result: observed.result },
        durationMs: observed.durationMs,
        executionMechanism: observed.executionMechanism,
      });
      input.journal.issueReceipt({
        toolId: tool.id,
        check: 'live',
        facts: check.facts,
      });
      if (!receiptPassed(check.facts)) {
        failures.push(
          checkFailure(tool, waveIndex, 'live', new Error(`live check failed for "${tool.id}"`)),
        );
        return undefined;
      }
      const buildRef = currentBuildRef(tool.id);
      if (!buildRef) throw new Error(`live check lost current build for "${tool.id}"`);
      const live = { ...observed, buildRef };
      liveByToolId.set(tool.id, live);
      return live;
    } catch (error) {
      const check = invocationOutcomeCheck({
        subject: 'live',
        invocationIndex: 0,
        outcome: { kind: 'host_error', error },
        executionMechanism: 'host',
      });
      try {
        input.journal.issueReceipt({
          toolId: tool.id,
          check: 'live',
          facts: check.facts,
        });
      } catch {}
      failures.push(checkFailure(tool, waveIndex, 'live', error));
      liveByToolId.delete(tool.id);
      return undefined;
    }
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
    if (!hasReceipt(producerToolId, 'live', 'passed')) return undefined;
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
      const waveIndex = waveByToolId.get(tool.id) ?? 0;
      const currentRef = currentBuildRef(tool.id);
      const retainedLive = liveByToolId.get(tool.id);
      const hasCurrentLiveResult =
        retainedLive?.result.ok === true &&
        currentRef?.path === retainedLive.buildRef.path &&
        currentRef.sha256 === retainedLive.buildRef.sha256;
      if (
        hasCurrentLiveResult &&
        mechanicalProofFailures(plan, input.journal.currentExecutionSnapshot(), tool.id).length ===
          0
      ) {
        verifiedToolIds.add(tool.id);
        continue;
      }
      if (!tool.implementationPlan || !tool.strategy) {
        failures.push(
          checkFailure(tool, waveIndex, 'compile', new Error('focused plan is incomplete')),
        );
        continue;
      }
      const focused = compiledByToolId.get(tool.id);
      if (!focused) {
        failures.push(
          checkFailure(tool, waveIndex, 'compile', new Error('focused artifact is unavailable')),
        );
        continue;
      }

      let buildRef = currentBuildRef(tool.id);
      try {
        if (!buildRef) {
          const priorBuildRef = initialBuildRefs.get(tool.id);
          if (!priorBuildRef) throw new Error('prior build is unavailable for verification');
          input.journal.rebindBuild({ toolId: tool.id, priorBuildRef });
          buildRef = currentBuildRef(tool.id);
          liveByToolId.delete(tool.id);
        } else {
          const build = input.journal.readBuild(buildRef);
          const current = input.journal.readState();
          const dependenciesCurrent = build.executionBinding.dependencies.every((dependency) => {
            const dependencyRef = current.tools.find(
              ({ toolId: id }) => id === dependency.toolId,
            )?.buildRef;
            return (
              dependencyRef?.path === dependency.buildRef.path &&
              dependencyRef.sha256 === dependency.buildRef.sha256
            );
          });
          if (!dependenciesCurrent) {
            input.journal.rebindBuild({
              toolId: tool.id,
              priorBuildRef: buildRef,
            });
            buildRef = currentBuildRef(tool.id);
            liveByToolId.delete(tool.id);
          }
        }
      } catch (error) {
        failures.push(checkFailure(tool, waveIndex, 'contract', error));
        continue;
      }
      if (!buildRef) continue;

      const implementation = input.journal.readJson(
        tool.implementationPlan,
      ) as ImplementationPlanPayload;
      if (!hasReceipt(tool.id, 'contract', 'passed')) {
        try {
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
        } catch (error) {
          failures.push(checkFailure(tool, waveIndex, 'contract', error));
        }
      }

      const replayStatus = tool.strategy.kind === 'playbook_fallback' ? 'not_applicable' : 'passed';
      if (!hasReceipt(tool.id, 'replay', replayStatus)) {
        try {
          if (tool.strategy.kind === 'playbook_fallback') {
            input.journal.issueReceipt({ toolId: tool.id, check: 'replay' });
          } else {
            const facts = await apiReplayFacts({
              compiled: focused,
              implementation,
              session: input.triage.session,
              credentialNames: tool.compileContext.credentialNames,
            });
            input.journal.issueReceipt({
              toolId: tool.id,
              check: 'replay',
              facts,
            });
            if (!receiptPassed(facts)) {
              failures.push(
                checkFailure(
                  tool,
                  waveIndex,
                  'replay',
                  new Error(`replay check failed for "${tool.id}"`),
                ),
              );
            }
          }
        } catch (error) {
          try {
            input.journal.issueReceipt({
              toolId: tool.id,
              check: 'replay',
              facts: acceptedRequestNotCheckedCheck({
                provenance: implementation.requestProvenance,
                hostError: error,
              }).facts,
            });
          } catch {}
          failures.push(checkFailure(tool, waveIndex, 'replay', error));
        }
      }

      let live = liveByToolId.get(tool.id);
      if (!hasReceipt(tool.id, 'live', 'passed') || !hasCurrentLiveResult) {
        live = await runExistingLive(tool, focused, implementation);
      }

      for (const edge of plan.chainEdges.filter(
        ({ consumerToolId }) => consumerToolId === tool.id,
      )) {
        if (hasReceipt(tool.id, 'chain', 'passed', edge.id)) continue;
        try {
          const producer = await ensureProducerLive(edge.producerToolId);
          if (!producer?.result.ok) {
            throw new Error(`producer "${edge.producerToolId}" has no successful live result`);
          }
          const binding = bindProducerResultToConsumer({
            edge,
            producerResult: producer.result.data,
            consumerParameterDeclarations: concreteParameterDeclarations(tool),
            consumerParameters: live?.parameters ?? verificationParameters(implementation, 'live'),
          });
          if (!binding.ok) throw new Error(`chain binding failed: ${binding.reason}`);
          const startedAt = Date.now();
          const chained =
            tool.strategy.kind === 'playbook_fallback'
              ? await input.deps.runPlaybookTool({
                  playbookPath: pathJoin(focused.toolDir, 'playbook.yaml'),
                  site: focused.workflow.site,
                  parameters: binding.parameters,
                  maxDurationMs: input.maxDurationMs,
                })
              : await input.deps.runApiTool({
                  workflowPath: focused.workflowPath,
                  parameters: binding.parameters,
                  signal: input.signal,
                });
          const check = invocationOutcomeCheck({
            subject: 'chain',
            invocationIndex: 0,
            outcome: { kind: 'returned', result: chained.result },
            durationMs: Date.now() - startedAt,
            executionMechanism: chained.executionMechanism,
          });
          input.journal.issueReceipt({
            toolId: tool.id,
            check: 'chain',
            chainEdgeId: edge.id,
            facts: check.facts,
          });
          if (!receiptPassed(check.facts)) {
            failures.push(
              checkFailure(tool, waveIndex, 'chain', new Error(`chain check "${edge.id}" failed`)),
            );
          }
        } catch (error) {
          const check = invocationOutcomeCheck({
            subject: 'chain',
            invocationIndex: 0,
            outcome: { kind: 'host_error', error },
            executionMechanism: 'host',
          });
          try {
            input.journal.issueReceipt({
              toolId: tool.id,
              check: 'chain',
              chainEdgeId: edge.id,
              facts: check.facts,
            });
          } catch {}
          failures.push(checkFailure(tool, waveIndex, 'chain', error));
        }
      }
    }
  }

  const finalSnapshot = input.journal.currentExecutionSnapshot();
  verifiedToolIds.clear();
  for (const tool of plan.tools) {
    const proofFailures = mechanicalProofFailures(plan, finalSnapshot, tool.id);
    if (proofFailures.length === 0) verifiedToolIds.add(tool.id);
    else if (!failures.some(({ toolId }) => toolId === tool.id)) {
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

  return { compiledByToolId, liveByToolId, verifiedToolIds, failures };
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
  now: Date;
  runDeadline: RunDeadlineRef;
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
): Promise<void> {
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
  context.journal.revisePlan(decision.desiredPlan, {
    expectedRevision: current.plan.revision,
    decision: planDecision(
      context.now,
      decision.outcome,
      decision.reason,
      [decisionRef],
      evidenceRefs,
    ),
  });
}

async function ensureCurrentImplementationPlans(
  context: MasterRevisionContext,
  findings?: PromptEvidenceProjection,
): Promise<void> {
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
    });
    persistSeeds(context.journal, seeds);
    for (const planner of planners) {
      context.focusedEvidence.set(planner.output.tool.id, planner.evidence);
    }
    const evidenceRefs = uniqueRefs([
      ...revisionEvidenceRefs(context, findings),
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
      ...(findings ? { verificationFindings: findings } : {}),
    };
    const decision = await context.deps.requestMasterDecision(decisionInput, context.agent);
    const decisionRef = context.journal.storeJson(decision);
    context.journal.revisePlan(decision.desiredPlan, {
      expectedRevision: current.plan.revision,
      decision: planDecision(
        context.now,
        decision.outcome,
        decision.reason,
        [...planners.map(({ proposal }) => proposal.ref), decisionRef],
        evidenceRefs,
      ),
    });
  }
}

async function adviseParametersAndRevise(input: {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  discoveryEvidence: PromptEvidenceProjection;
  focusedEvidence: Map<string, PromptEvidenceProjection>;
  toolAdvice: ToolAdvice;
  triagedSession: Session;
  independent: IndependentExecutionObservation;
  agent: MasterTeachAgentOptions;
  deps: FreshTeachControllerDependencies;
  now: Date;
}): Promise<{ needsWork: boolean }> {
  const current = currentPlanProjection(input.journal);
  const snapshot = input.journal.currentExecutionSnapshot();
  const adviceRun = await compileEveryToolInBuildWaves(current.plan, {
    concurrency: FOCUSED_COMPILE_CONCURRENCY,
    compileTool: async (tool) => {
      const evidence = input.focusedEvidence.get(tool.id) ?? input.discoveryEvidence;
      const advisorInput: ParameterSelectionAdvisorInput = {
        run: current.binding,
        recordingIndex: input.discoveryInput.recordingIndex,
        currentPlan: current.projection,
        snapshot,
        toolId: tool.id,
        evidence,
      };
      return {
        toolId: tool.id,
        evidence,
        advice: await input.deps.requestParameterSelectionAdvice(advisorInput, input.agent),
      };
    },
  });
  if (adviceRun.failures.length > 0) {
    // Parameter reviewers only suggest public parameter choices. Provider
    // cancellation/unavailability remains terminal, but an invalid individual
    // suggestion is simply absent and cannot discard already verified tools.
    throwTerminalFanoutFailure(adviceRun.failures, input.agent.signal);
  }
  const submissions = adviceRun.completed.map(({ value }) => value);
  if (submissions.length === 0) return { needsWork: false };
  const adviceRefs = submissions.map(({ advice }) => input.journal.storeJson(advice));
  const evidenceRefs = uniqueRefs([
    ...focusedEvidenceRefs(input.discoveryEvidence),
    ...submissions.flatMap(({ evidence }) => focusedEvidenceRefs(evidence)),
  ]);
  const decisionInput: MasterDecisionInput = {
    phase: 'revision',
    discovery: input.discoveryInput,
    current: { run: current.binding, plan: current.projection, snapshot },
    toolSelectionAdvice: input.toolAdvice,
    plannerProposals: [],
    parameterAdvice: submissions,
  };
  const decision = await input.deps.requestMasterDecision(decisionInput, input.agent);
  const decisionRef = input.journal.storeJson(decision);
  const revision = input.journal.revisePlan(decision.desiredPlan, {
    expectedRevision: current.plan.revision,
    decision: planDecision(
      input.now,
      decision.outcome,
      decision.reason,
      [...adviceRefs, decisionRef],
      evidenceRefs,
    ),
  });
  if (revision.replanToolIds.length === 0) {
    return {
      needsWork: revision.recompileToolIds.length > 0 || revision.reverifyToolIds.length > 0,
    };
  }

  const replanningCurrent = currentPlanProjection(input.journal);
  const seeds = new Map<string, FreshTeachBootstrapObject>();
  const planners = await requestFocusedPlannerBundles({
    plan: replanningCurrent.plan,
    discoveryRun: input.discoveryInput.run,
    recordingIndex: input.discoveryInput.recordingIndex,
    triagedSession: input.triagedSession,
    independent: input.independent,
    seeds,
    agent: input.agent,
    deps: input.deps,
    toolIds: new Set(revision.replanToolIds),
  });
  persistSeeds(input.journal, seeds);
  for (const planner of planners)
    input.focusedEvidence.set(planner.output.tool.id, planner.evidence);
  const replanningSnapshot = input.journal.currentExecutionSnapshot();
  const replanningEvidence = allEvidenceRefs(input.discoveryEvidence, planners);
  const replanDecisionEvidenceRefs = uniqueRefs([...evidenceRefs, ...replanningEvidence]);
  const replanInput: MasterDecisionInput = {
    phase: 'revision',
    discovery: input.discoveryInput,
    current: {
      run: replanningCurrent.binding,
      plan: replanningCurrent.projection,
      snapshot: replanningSnapshot,
    },
    toolSelectionAdvice: input.toolAdvice,
    plannerProposals: planners.map(({ proposal }) => proposal),
    parameterAdvice: [],
  };
  const replannedDecision = await input.deps.requestMasterDecision(replanInput, input.agent);
  const replannedDecisionRef = input.journal.storeJson(replannedDecision);
  const replanned = input.journal.revisePlan(replannedDecision.desiredPlan, {
    expectedRevision: replanningCurrent.plan.revision,
    decision: planDecision(
      input.now,
      replannedDecision.outcome,
      replannedDecision.reason,
      [...planners.map(({ proposal }) => proposal.ref), replannedDecisionRef],
      replanDecisionEvidenceRefs,
    ),
  });
  return {
    needsWork: replanned.recompileToolIds.length > 0 || replanned.reverifyToolIds.length > 0,
  };
}

function completionInput(input: {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  evidence: PromptEvidenceProjection;
  terminalIntent: 'completed' | 'blocked';
  liveByToolId?: ReadonlyMap<string, LiveCheckResult>;
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
      : exclusionClaims;
  const toolResultEvidence =
    input.terminalIntent === 'completed'
      ? completionToolResultEvidence(input.journal, current.plan, input.liveByToolId ?? new Map())
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
  const snapshot = journal.currentExecutionSnapshot();
  return plan.tools.map((tool) => {
    if (!tool.implementationPlan) throw new Error(`tool "${tool.id}" has no implementation plan`);
    const implementation = journal.readJson(tool.implementationPlan) as ImplementationPlanPayload;
    const verification = implementation.verificationCases.find(({ check }) => check === 'live');
    if (!verification) throw new Error(`tool "${tool.id}" has no live verification case`);
    const liveReceipt = snapshot.payload.tools
      .find(({ toolId }) => toolId === tool.id)
      ?.receipts.find(({ check, status }) => check === 'live' && status === 'passed');
    const live = liveByToolId.get(tool.id);
    if (!liveReceipt || !live?.result.ok) {
      throw new Error(`tool "${tool.id}" has no retained successful live result`);
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
      liveReceiptRef: liveReceipt.ref,
      actualResult: {
        observed: true,
        preview,
        shape,
        count: Array.isArray(live.result.data) ? live.result.data.length : 1,
        truncated: Buffer.byteLength(serialized, 'utf8') > Buffer.byteLength(preview, 'utf8'),
      },
    };
    const ref = journal.storeJson(payload);
    return CompletionToolResultEvidenceSchema.parse({ ref, payload });
  });
}

async function requestIndependentReview(input: {
  journal: FreshTeachJournal;
  discoveryInput: ToolSelectionAdvisorInput;
  evidence: PromptEvidenceProjection;
  terminalIntent: 'completed' | 'blocked';
  liveByToolId?: ReadonlyMap<string, LiveCheckResult>;
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
    const source = pathJoin(promotionRoot, toolName);
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
      backup: pathJoin(localSiteDir(input.site), `.${toolName}.before-${input.runId}`),
    });
  }

  const promoted: typeof prepared = [];
  try {
    for (const item of prepared) {
      if (existsSync(item.backup)) {
        throw new Error(`promotion backup already exists: ${item.backup}`);
      }
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
      const failedCopy = `${item.target}.failed-${input.runId}`;
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
): { readyTools: number; failedTools: number } {
  if (!journal) {
    return {
      readyTools: fallback.ready,
      failedTools: Math.max(0, fallback.planned - fallback.ready),
    };
  }
  try {
    const plan = journal.currentPlan();
    const snapshot = journal.currentExecutionSnapshot();
    const readyTools = plan.tools.filter(
      (tool) => mechanicalProofFailures(plan, snapshot, tool.id).length === 0,
    ).length;
    return {
      readyTools,
      failedTools: plan.tools.length - readyTools + unresolvedCandidateCoverage(plan).length,
    };
  } catch {
    return {
      readyTools: fallback.ready,
      failedTools: Math.max(0, fallback.planned - fallback.ready),
    };
  }
}

export async function promoteReviewedCompletion(input: {
  journal: Pick<FreshTeachJournal, 'recordCompletionReview' | 'finish'>;
  reviewInput: CompletionReviewInput;
  review: CompletionReview;
  promote: () => Promise<void>;
}): Promise<void> {
  input.journal.recordCompletionReview(input.reviewInput, input.review);
  await input.promote();
  input.journal.finish('completed');
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
  let plannedTools = 0;
  let readyTools = 0;

  try {
    reportProgress(opts, 'resolving the latest recording');
    const recording = await resolveRecordingForFreshRun(opts, site, deps);
    const redacted = redactRecording(recording, runRoot);
    reportProgress(opts, 'preparing the complete redacted recording');
    const triage = deps.prepareSession(redacted.session);
    const triagedPath = pathJoin(runRoot, 'recording.triaged.json');
    writeJson(triagedPath, triage.session);
    const candidatePayload = buildToolCandidatePayload(triage.session);
    reportProgress(opts, 'discovering operations while observing an independent execution');
    const [detection, independent] = await Promise.all([
      deps.detectToolCandidates(triage.session, llmOptions(opts), {
        candidatePayload,
        signal: opts.signal,
        deadlineMs: deadline.deadlineMs,
        runDeadline: deadline,
      }),
      deps
        .observeIndependentExecution({
          session: triage.session,
          site,
          credentials: redacted.credentialValues,
          replacements: redacted.credentialReplacements,
        })
        .catch(
          (error): IndependentExecutionObservation => ({
            status: 'unavailable',
            requests: [],
            unmatchedRecordingRequestSeqs: [],
            message: utf8Prefix(error instanceof Error ? error.message : String(error), 1_000),
          }),
        ),
    ]);
    const seeds = new Map<string, FreshTeachBootstrapObject>();
    reportProgress(opts, `reviewing ${detection.candidates.length} discovered operation(s)`);
    const planned = await discoverAndPlan({
      site,
      runId,
      recordingSha256: recording.recordingSha256,
      triage,
      candidatePayload,
      detection,
      independent,
      seeds,
      agent: agents,
      deps,
      now: deps.now(),
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

    let compiledByToolId = new Map<string, CompiledFocusedTool>();
    let liveByToolId = new Map<string, LiveCheckResult>();
    const parameterAdvisedPlans = new Set<string>();
    const revisionContext = (): MasterRevisionContext => ({
      journal: activeJournal,
      discoveryInput: planned.discoveryInput,
      discoveryEvidence: planned.discoveryEvidence,
      focusedEvidence: planned.focusedEvidence,
      toolAdvice: planned.toolAdvice,
      triagedSession: triage.session,
      independent,
      agent: agents,
      deps,
      now: deps.now(),
      runDeadline: deadline,
    });
    const repair = async (findings: PromptEvidenceProjection): Promise<void> => {
      reportProgress(opts, 'master is revising the plan from factual failures');
      const context = revisionContext();
      await requestRepairRevision(context, findings);
      await ensureCurrentImplementationPlans(revisionContext(), findings);
      plannedTools = activeJournal.currentPlan().tools.length;
    };

    while (true) {
      const currentPlan = activeJournal.currentPlan();
      plannedTools = currentPlan.tools.length;
      if (plannedTools === 0) {
        let reviewed: Awaited<ReturnType<typeof requestIndependentReview>>;
        try {
          reviewed = await requestIndependentReview({
            journal: activeJournal,
            discoveryInput: planned.discoveryInput,
            evidence: planned.discoveryEvidence,
            terminalIntent: 'blocked',
            agent: agents,
            deps,
          });
        } catch (error) {
          const status = terminalStatusForError(error, opts.signal);
          if (status === 'cancelled' || status === 'provider_unavailable') throw error;
          await repair(orchestrationFailureProjection(activeJournal, 'completion_review', error));
          continue;
        }
        if (reviewed.review.verdict === 'passed') {
          activeJournal.finishWithReview('blocked', reviewed.reviewInput, reviewed.review);
          return writeTerminalResult({
            status: 'blocked',
            readyTools: 0,
            failedTools: 0,
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
          triage,
          sessionPath: triagedPath,
          stagingRoot,
          llmConfig: llmOptions(opts),
          runDeadline: deadline,
          deps,
          signal: opts.signal,
          keepTest: opts.keepTest,
          maxDurationMs: opts.maxDurationMs,
          report: (message) => reportProgress(opts, message),
          priorCompiled: compiledByToolId,
          priorLive: liveByToolId,
        });
      } catch (error) {
        const status = terminalStatusForError(error, opts.signal);
        if (status === 'cancelled' || status === 'provider_unavailable') throw error;
        await repair(orchestrationFailureProjection(activeJournal, 'verification', error));
        continue;
      }
      compiledByToolId = checked.compiledByToolId;
      liveByToolId = checked.liveByToolId;
      readyTools = checked.verifiedToolIds.size;
      if (checked.failures.length > 0) {
        const terminal = checked.failures.find(({ error }) =>
          ['cancelled', 'provider_unavailable'].includes(
            terminalStatusForError(error, opts.signal),
          ),
        );
        if (terminal) throw terminal.error;
        await repair(verificationFailureProjection(activeJournal, checked.failures));
        continue;
      }

      const advisedPlanHash = teachingPlanContentSha256(desiredPart(activeJournal.currentPlan()));
      if (!parameterAdvisedPlans.has(advisedPlanHash)) {
        reportProgress(opts, 'reviewing public parameter choices');
        try {
          await adviseParametersAndRevise({
            journal: activeJournal,
            discoveryInput: planned.discoveryInput,
            discoveryEvidence: planned.discoveryEvidence,
            focusedEvidence: planned.focusedEvidence,
            toolAdvice: planned.toolAdvice,
            triagedSession: triage.session,
            independent,
            agent: agents,
            deps,
            now: deps.now(),
          });
          await ensureCurrentImplementationPlans(revisionContext());
        } catch (error) {
          const status = terminalStatusForError(error, opts.signal);
          if (status === 'cancelled' || status === 'provider_unavailable') throw error;
          reportProgress(opts, 'parameter advice was unavailable; keeping the verified plan');
        }
        parameterAdvisedPlans.add(advisedPlanHash);
        continue;
      }

      const finalPlan = activeJournal.currentPlan();
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
        await repair(verificationFailureProjection(activeJournal, failures));
        continue;
      }

      let reviewed: Awaited<ReturnType<typeof requestIndependentReview>>;
      try {
        reportProgress(opts, 'running independent completion review');
        reviewed = await requestIndependentReview({
          journal: activeJournal,
          discoveryInput: planned.discoveryInput,
          evidence: planned.discoveryEvidence,
          terminalIntent: 'completed',
          liveByToolId,
          agent: agents,
          deps,
        });
      } catch (error) {
        const status = terminalStatusForError(error, opts.signal);
        if (status === 'cancelled' || status === 'provider_unavailable') throw error;
        await repair(orchestrationFailureProjection(activeJournal, 'completion_review', error));
        continue;
      }
      if (reviewed.review.verdict !== 'passed') {
        await repair(completionFailureProjection(activeJournal, reviewed.review));
        continue;
      }
      const finalCompiled = finalPlan.tools.map((tool) => {
        const compiled = compiledByToolId.get(tool.id);
        if (!compiled) throw new Error(`completed tool "${tool.id}" has no staged artifact`);
        return compiled;
      });
      reportProgress(opts, `promoting ${finalCompiled.length} verified tool(s)`);
      await promoteReviewedCompletion({
        journal: activeJournal,
        reviewInput: reviewed.reviewInput,
        review: reviewed.review,
        promote: async () => await deps.promote({ site, runId, runRoot, tools: finalCompiled }),
      });
      readyTools = finalPlan.tools.length;
      return writeTerminalResult({
        status: 'completed',
        readyTools,
        failedTools: 0,
        runRoot,
        message: `Every one of ${readyTools} planned tool(s) passed verification and was promoted.`,
      });
    }
  } catch (error) {
    const status = terminalStatusForError(error, opts.signal);
    try {
      if (journal?.readState().status === 'active') journal.finish(status, { hostError: error });
    } catch {
      // The terminal result remains authoritative for the foreground command;
      // immutable run files are retained for diagnosis if journal finalization failed.
    }
    const counts = currentTerminalCounts(journal, {
      planned: plannedTools,
      ready: readyTools,
    });
    return writeTerminalResult({
      status,
      ...counts,
      runRoot,
      message: boundedTerminalMessage(error),
    });
  }
}
