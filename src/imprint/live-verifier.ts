import type { ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { z } from 'zod';
import { type AgentTool, doneTool, runAgentLoop } from './agent.ts';
import { AuthVerifier } from './auth-verifier.ts';
import { loadBackendsCacheStatus } from './backend-cache.ts';
import { resolveWorkflowTool } from './backend-ladder.ts';
import { readBuildPlanFile } from './build-plan.ts';
import { type ParamVerification, runBunTestWithResults } from './compile-tools.ts';
import {
  LIVE_EVIDENCE_PATH_ENV,
  LIVE_PREFERRED_BACKEND_ONLY_ENV,
  type LiveIntegrationEvidence,
  acquireSiteLiveLock,
  readLiveIntegrationEvidence,
  runCapturedIntegrationCase,
} from './compile-verification.ts';
import { collectOwnedProcess, spawnOwnedProcess } from './compiler-process.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import { redactFreeformText } from './freeform-redact.ts';
import {
  type ProviderName,
  isToolUseProvider,
  preferredVerificationModel,
  resolveProvider,
} from './llm.ts';
import {
  type BackendRequestStageFact,
  canRebindBackendsCacheToWorkflow,
  parseBackendRequestStageFacts,
  type probeResolvedTool,
  rebindBackendsCacheToWorkflow,
  sanitizeBackendRequestStageFacts,
  stripBackendRequestStageFacts,
} from './probe-backends.ts';
import {
  ProviderDeadlineError,
  type RunDeadlineRef,
  boundedRunDeadline,
  combinedDeadlineSignal,
  providerControlError,
  providerReportedError,
  resolvedRunDeadline,
  retryTransientProviderFailure,
} from './provider-retry.ts';
import { ProviderTerminalAccumulator } from './provider-terminal.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { loadCredentialStore } from './runtime.ts';
import { isSensitiveKey } from './sensitive-keys.ts';
import { buildZodValidator } from './tool-loader.ts';
import {
  type BackendsCache,
  type ConcreteBackend,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const SYSTEM_PROMPT_PATH = pathJoin(REPO_ROOT, 'prompts', 'live-verifier-agent.md');
const MCP_SERVER_NAME = 'imprint-live-verifier';
export const LIVE_VERIFICATION_EVIDENCE_FILE = '.live-verification-evidence.json';
const LIVE_VERIFIER_LOG_FILE = '.live-verifier-log.jsonl';
// Cheap probes normally finish well inside the original two-minute window and
// skip browser transports. The larger ceiling is for the fallback path: a cold
// CDP request must finish before fetch-bootstrap gets its own browser attempt.
// Comprehensive preparation is sequential on purpose: concurrent browser
// transports can trip shared anti-bot/session defenses. Reserve enough time
// for the normal fetch/stealth/playbook candidates plus CDP and fetch-bootstrap
// fallbacks; the former 240s cap could kill CDP after a 150s playbook attempt.
const BACKEND_PREPARATION_BUDGET_MS = 8 * 60_000;
const BACKEND_PROBE_SHUTDOWN_GRACE_MS = 5_000;
const MAX_PROMPT_EVIDENCE_RECORDS = 48;
const MAX_PROMPT_EVIDENCE_RECORD_CHARS = 8_000;
let evidenceTempSequence = 0;

const BaselineSchema = z
  .object({
    verdict: z.enum(['semantically_correct', 'tool_broken', 'bad_parameters', 'infrastructure']),
    reason: z.string().min(1),
  })
  .strict();

const ParameterSchema = z
  .object({
    name: z.string().min(1),
    verdict: z.enum(['works', 'no_op', 'broken', 'untestable']),
    reason: z.string().min(1),
  })
  .strict();

const IssueSchema = z
  .object({
    summary: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    suggestedFix: z.string().min(1),
  })
  .strict();

export const LiveVerificationReportSchema = z
  .object({
    status: z.enum(['approved', 'approved_with_gaps', 'changes_required', 'inconclusive']),
    summary: z.string().min(1),
    baseline: BaselineSchema,
    parameters: z.array(ParameterSchema),
    issues: z.array(IssueSchema),
    gaps: z.array(z.string().min(1)),
    evidenceArtifact: z.string().min(1).optional(),
    logArtifact: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (
      (report.status === 'approved' || report.status === 'approved_with_gaps') &&
      report.baseline.verdict !== 'semantically_correct'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an approval requires a semantically_correct baseline',
      });
    }
    if (report.status === 'approved' && report.gaps.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved cannot contain gaps',
      });
    }
    if (
      report.status === 'approved' &&
      report.parameters.some((parameter) => parameter.verdict !== 'works')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved requires every reported parameter to work',
      });
    }
    if (report.status === 'approved_with_gaps' && report.gaps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved_with_gaps must name at least one gap',
      });
    }
    if (
      report.status === 'approved_with_gaps' &&
      report.parameters.some(
        (parameter) => parameter.verdict !== 'works' && parameter.verdict !== 'untestable',
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved_with_gaps permits only works or untestable parameter verdicts',
      });
    }
    if (report.status === 'approved_with_gaps') {
      for (const parameter of report.parameters) {
        if (
          parameter.verdict === 'untestable' &&
          !report.gaps.some((gap) => gap.toLowerCase().includes(parameter.name.toLowerCase()))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `approved_with_gaps must name untestable parameter ${parameter.name} in gaps`,
          });
        }
      }
    }
    if (
      (report.status === 'approved' || report.status === 'approved_with_gaps') &&
      report.parameters.some((parameter) => parameter.verdict === 'broken')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a report with a broken parameter cannot approve the tool',
      });
    }
    if (report.status === 'changes_required' && report.issues.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changes_required must include at least one actionable issue',
      });
    }
  });

type LiveVerificationReport = z.infer<typeof LiveVerificationReportSchema>;

interface LiveIntegrationSuiteResult {
  exitCode: number;
  timedOut: boolean;
  passedTests: string[];
  failedTests: string[];
  stdout: string;
  stderr: string;
  evidence: LiveIntegrationEvidence[];
  receipt: LiveIntegrationSuiteReceipt;
}

type PersistedLiveVerificationRecord = Record<string, unknown> & {
  label: string;
};

interface LiveIntegrationSuiteReceipt extends PersistedLiveVerificationRecord {
  kind: 'suite';
  label: string;
  status: 'running' | 'passed' | 'failed' | 'timed_out' | 'aborted';
  startedAt: string;
  finishedAt?: string;
  verifierSession?: string;
  preferredBackend?: ConcreteBackend;
  backendCacheProbedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  passedTests: string[];
  failedTests: string[];
  completedCallLabels: string[];
  stdout: string;
  stderr: string;
  reason?: string;
  error?: string;
}

interface BackendPreparationResult {
  label: string;
  cache: BackendsCache;
  preferredBackend: ConcreteBackend;
  reusedCache: boolean;
  durationMs: number;
}

interface BackendPreparationFailureObservation {
  error: string;
  requestStageFacts: BackendRequestStageFact[];
}

type BackendPreparationError = Error & {
  requestStageFacts?: unknown;
};

function backendPreparationError(
  message: string,
  requestStageFacts: readonly BackendRequestStageFact[],
): BackendPreparationError {
  const error = new Error(message) as BackendPreparationError;
  error.requestStageFacts = sanitizeBackendRequestStageFacts(requestStageFacts);
  return error;
}

/** Convert any backend-preparation error into the value-free observation given
 * to the verifier. Subprocess trailers and arbitrary extra fields are removed. */
export function backendPreparationFailureObservation(
  error: unknown,
): BackendPreparationFailureObservation {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const attached =
    error instanceof Error
      ? sanitizeBackendRequestStageFacts((error as BackendPreparationError).requestStageFacts)
      : [];
  return {
    error: stripBackendRequestStageFacts(rawMessage),
    requestStageFacts: attached.length > 0 ? attached : parseBackendRequestStageFacts(rawMessage),
  };
}

export function effectiveParamsForEvidence(
  parameters: Array<{ name: string; default?: unknown }>,
  requested: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const defaults: Record<string, string | number | boolean> = {};
  for (const parameter of parameters) {
    const value = parameter.default;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      defaults[parameter.name] = value;
    }
  }
  return { ...defaults, ...requested };
}

export function namespaceLiveIntegrationEvidence(
  evidence: LiveIntegrationEvidence[],
  namespace: string,
): LiveIntegrationEvidence[] {
  return evidence.map((item) => ({
    ...item,
    label: `${namespace}/${item.label}`,
  }));
}

export function assertReportCoversWorkflowParameters(
  report: LiveVerificationReport,
  parameters: Array<{ name: string }>,
): void {
  const expected = parameters.map((parameter) => parameter.name);
  const actual = report.parameters.map((parameter) => parameter.name);
  const counts = new Map<string, number>();
  for (const name of actual) counts.set(name, (counts.get(name) ?? 0) + 1);
  const missing = expected.filter((name) => !counts.has(name));
  const unknown = actual.filter((name) => !expected.includes(name));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (missing.length > 0 || unknown.length > 0 || duplicates.length > 0) {
    throw new Error(
      `semantic report parameter verdicts must match workflow parameters exactly once (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}; duplicates: ${duplicates.join(', ') || 'none'})`,
    );
  }
}

export async function runLiveIntegrationSuite(opts: {
  toolDir: string;
  timeoutMs?: number;
  logPath?: string;
  attempt?: number;
  reason?: string;
  sessionLabel?: string;
  signal?: AbortSignal;
}): Promise<LiveIntegrationSuiteResult> {
  // The suite is launched directly from the generated tool directory, bypassing
  // normal tool discovery. Repair a stale global/worktree runtime link here so
  // imports such as `imprint/compile-verification` resolve against this running
  // Imprint installation.
  ensureImprintRuntimeLink(dirname(dirname(opts.toolDir)));
  const integrationPath = pathJoin(opts.toolDir, 'integration.test.ts');
  if (!existsSync(integrationPath)) throw new Error('integration.test.ts is missing');
  const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  if (workflowHasIrreversibleEffect(workflow)) {
    throw new Error(
      `Live semantic verification is disabled for irreversible workflow ${JSON.stringify(workflow.toolName)}.`,
    );
  }
  const durableEvidencePath = pathJoin(opts.toolDir, LIVE_VERIFICATION_EVIDENCE_FILE);
  const label = nextRecordLabel(durableEvidencePath, 'suite');
  const startedAt = new Date().toISOString();
  const cacheStatus = loadBackendsCacheStatus(
    workflow.site ?? '',
    dirname(dirname(opts.toolDir)),
    opts.toolDir,
    { warn: false, toolName: workflow.toolName },
  );
  const preferredBackend =
    cacheStatus.status === 'ok' ? cacheStatus.cache.preferredOrder[0] : undefined;
  let runningReceipt: LiveIntegrationSuiteReceipt = {
    kind: 'suite',
    label,
    status: 'running',
    startedAt,
    verifierSession: opts.sessionLabel,
    preferredBackend,
    backendCacheProbedAt: cacheStatus.status === 'ok' ? cacheStatus.cache.probedAt : undefined,
    passedTests: [],
    failedTests: [],
    completedCallLabels: [],
    stdout: '',
    stderr: '',
    reason: opts.reason,
  };
  persistLiveVerificationEvidence(durableEvidencePath, [runningReceipt]);
  appendLiveVerifierLog(opts.logPath, {
    type: 'suite.started',
    attempt: opts.attempt,
    label,
    preferredBackend,
    cacheStatus: cacheStatus.status,
  });
  const evidencePath = pathJoin(
    opts.toolDir,
    `.imprint-live-evidence-verifier-${process.pid}-${Date.now()}.jsonl`,
  );
  try {
    if (!preferredBackend) {
      throw new Error(
        `Live verifier backend is not prepared for ${workflow.toolName}; call prepare_live_backend before running the suite.`,
      );
    }
    const run = await runBunTestWithResults(
      integrationPath,
      opts.toolDir,
      opts.timeoutMs ?? 10 * 60_000,
      {
        [LIVE_EVIDENCE_PATH_ENV]: evidencePath,
        [LIVE_PREFERRED_BACKEND_ONLY_ENV]: '1',
      },
      {
        bail: true,
        signal: opts.signal,
        onOutput: (stream, chunk) => {
          runningReceipt = {
            ...runningReceipt,
            [stream]: boundedTail(`${runningReceipt[stream]}${chunk}`, 16_000),
          };
          persistLiveVerificationEvidence(durableEvidencePath, [runningReceipt]);
          appendLiveVerifierLog(opts.logPath, {
            type: `suite.${stream}`,
            attempt: opts.attempt,
            label,
            chunk: boundedTail(chunk, 4_000),
          });
        },
      },
    );
    let evidence: LiveIntegrationEvidence[] = [];
    let evidenceReadError = '';
    try {
      // A compiler revision may run this suite again. Keep every call from
      // every run instead of letting stable case labels overwrite history.
      evidence = namespaceLiveIntegrationEvidence(readLiveIntegrationEvidence(evidencePath), label);
    } catch (error) {
      evidenceReadError = error instanceof Error ? error.message : String(error);
      appendLiveVerifierLog(opts.logPath, {
        type: 'suite.evidence-read-failed',
        attempt: opts.attempt,
        label,
        error: evidenceReadError,
      });
    }
    const receipt: LiveIntegrationSuiteReceipt = {
      ...runningReceipt,
      status: run.timedOut ? 'timed_out' : run.exitCode === 0 ? 'passed' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      passedTests: [...run.passed],
      failedTests: [...run.failed],
      completedCallLabels: evidence.map((item) => item.label),
      stdout: boundedTail(run.stdout || runningReceipt.stdout, 16_000),
      stderr: boundedTail(
        `${run.stderr || runningReceipt.stderr}${evidenceReadError ? `\nEvidence read failed: ${evidenceReadError}` : ''}`,
        16_000,
      ),
    };
    persistLiveVerificationEvidence(durableEvidencePath, [...evidence, receipt]);
    appendLiveVerifierLog(opts.logPath, {
      type: 'suite.completed',
      attempt: opts.attempt,
      receipt,
    });
    return {
      exitCode: receipt.exitCode ?? -1,
      timedOut: receipt.timedOut ?? false,
      passedTests: receipt.passedTests,
      failedTests: receipt.failedTests,
      stdout: receipt.stdout,
      stderr: receipt.stderr,
      evidence,
      receipt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const receipt: LiveIntegrationSuiteReceipt = {
      ...runningReceipt,
      status: 'aborted',
      finishedAt: new Date().toISOString(),
      error: message,
    };
    persistLiveVerificationEvidence(durableEvidencePath, [receipt]);
    appendLiveVerifierLog(opts.logPath, {
      type: 'suite.aborted',
      attempt: opts.attempt,
      receipt,
    });
    throw error;
  } finally {
    try {
      if (existsSync(evidencePath)) unlinkSync(evidencePath);
    } catch {
      // Raw evidence is replaced by a durable sanitized sidecar.
    }
  }
}

function sanitizeEvidenceValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    const bounded =
      value.length > 2_000 ? `${value.slice(0, 2_000)}…[TRUNCATED:${value.length}]` : value;
    return redactFreeformText(bounded).redacted;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 50)
      .map((item) => sanitizeEvidenceValue(item, undefined, depth + 1));
    if (value.length > 50) items.push(`[TRUNCATED_ITEMS:${value.length - 50}]`);
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        sanitizeEvidenceValue(item, name, depth + 1),
      ]),
    );
  }
  return value;
}

export function persistLiveVerificationEvidence(
  path: string,
  evidence: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord>,
): void {
  const existing = readPersistedLiveVerificationEvidence(path);
  const merged = new Map(existing.map((item) => [item.label, item]));
  for (const item of evidence) {
    merged.set(item.label, sanitizeEvidenceValue(item) as PersistedLiveVerificationRecord);
  }
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${++evidenceTempSequence}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify([...merged.values()], null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write failure; temp cleanup is best effort.
    }
    throw error;
  }
}

export function readPersistedLiveVerificationEvidence(
  path: string,
): PersistedLiveVerificationRecord[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('malformed persisted live verification evidence');
  return parsed.filter(
    (item): item is PersistedLiveVerificationRecord =>
      Boolean(item) && typeof item === 'object' && typeof item.label === 'string',
  );
}

export function hasSuiteReceiptForSession(path: string, sessionLabel: string): boolean {
  return readPersistedLiveVerificationEvidence(path).some(
    (item) =>
      item.kind === 'suite' &&
      item.verifierSession === sessionLabel &&
      item.status !== 'running' &&
      typeof item.finishedAt === 'string',
  );
}

function boundedTail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

function nextRecordLabel(path: string, prefix: string): string {
  let highest = 0;
  for (const item of readPersistedLiveVerificationEvidence(path)) {
    const suffix = item.label.slice(prefix.length + 1);
    if (item.label.startsWith(`${prefix}-`) && /^\d+$/.test(suffix)) {
      highest = Math.max(highest, Number(suffix));
    }
  }
  return `${prefix}-${highest + 1}`;
}

export function appendLiveVerifierLog(
  path: string | undefined,
  event: Record<string, unknown>,
): void {
  if (!path) return;
  const sanitized = sanitizeEvidenceValue({
    timestamp: new Date().toISOString(),
    ...event,
  });
  appendFileSync(path, `${JSON.stringify(sanitized)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

interface LiveAuthActionObservation {
  authToolName: string;
  action: string;
  ok: boolean;
  error?: string;
  message?: string;
  nextAction?: string;
  requiredParameters?: string[];
  usedBackend: string;
  status?: number;
  durationMs: number;
}

export function credentialsForAuthRefresh(
  site: string,
  stored: Awaited<ReturnType<typeof loadCredentialStore>>,
  persistedNames: readonly string[],
  cleanSession: boolean,
): NonNullable<Awaited<ReturnType<typeof loadCredentialStore>>> {
  const credentials = stored ?? { site, cookies: [], values: {}, storage: [] };
  if (!cleanSession) return credentials;
  const persisted = new Set(persistedNames);
  return {
    ...credentials,
    cookies: [],
    storage: [],
    values: Object.fromEntries(
      Object.entries(credentials.values).filter(([name]) => !persisted.has(name)),
    ),
  };
}

function authRefreshStartedForSession(logPath: string | undefined, sessionLabel: string): boolean {
  if (!logPath || !existsSync(logPath)) return false;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'auth.refresh.started' && event.session === sessionLabel) {
        return true;
      }
    } catch {
      // The append-only log can end in a partial line while another process writes.
    }
  }
  return false;
}

export function authRefreshAwaitingContinuation(
  logPath: string | undefined,
  sessionLabel: string,
): boolean {
  if (!logPath || !existsSync(logPath)) return false;
  let awaiting = false;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.session !== sessionLabel) continue;
      if (event.type === 'auth.refresh.action-required') awaiting = true;
      if (event.type === 'auth.refresh.completed' || event.type === 'auth.refresh.failed') {
        awaiting = false;
      }
    } catch {
      // The append-only log can end in a partial line while another process writes.
    }
  }
  return awaiting;
}

function parseAuthActionParameters(
  value: unknown,
): Record<string, string | number | boolean> | string {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'parameters must be an object of string, number, or boolean values';
  }
  const parameters = value as Record<string, unknown>;
  for (const [name, parameter] of Object.entries(parameters)) {
    if (
      typeof parameter !== 'string' &&
      typeof parameter !== 'number' &&
      typeof parameter !== 'boolean'
    ) {
      return `authentication parameter ${JSON.stringify(name)} must be a string, number, or boolean`;
    }
  }
  return parameters as Record<string, string | number | boolean>;
}

export const LIVE_AUTH_REFRESH_TOOL_DESCRIPTION =
  "Run one action from the site's generated authentication workflow after live evidence shows that stored auth is expired or invalid. Omit action on the first call. If the result requests a nextAction, inspect it and call again with that action and any declared parameters. The verifier agent—not the runtime—decides whether to continue.";

export const LIVE_AUTH_REFRESH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    reason: { type: 'string' },
    action: { type: 'string' },
    parameters: { type: 'object', additionalProperties: true },
    cleanSession: { type: 'boolean' },
  },
  required: ['reason'],
  additionalProperties: false,
};

interface LiveVerificationAuthSessionOptions {
  workflowPath: string;
  reason: string;
  cleanSession?: boolean;
  logPath?: string;
  attempt?: number;
  sessionLabel: string;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  signal?: AbortSignal;
}

export async function runLiveAuthRefreshToolCall(
  existing: LiveVerificationAuthSession | undefined,
  raw: unknown,
  context: Omit<LiveVerificationAuthSessionOptions, 'reason' | 'cleanSession'>,
): Promise<{
  session: LiveVerificationAuthSession | undefined;
  observation?: LiveAuthActionObservation;
  error?: string;
}> {
  const input = (raw ?? {}) as {
    reason?: unknown;
    action?: unknown;
    parameters?: unknown;
    cleanSession?: unknown;
  };
  if (typeof input.reason !== 'string' || !input.reason.trim()) {
    return { session: existing, error: 'reason must explain the observed authentication failure' };
  }
  if (input.action !== undefined && typeof input.action !== 'string') {
    return { session: existing, error: 'action must be a string' };
  }
  const parameters = parseAuthActionParameters(input.parameters);
  if (typeof parameters === 'string') return { session: existing, error: parameters };
  const session =
    existing ??
    new LiveVerificationAuthSession({
      ...context,
      reason: input.reason,
      cleanSession: input.cleanSession === true,
    });
  try {
    return {
      session,
      observation: await session.run({ action: input.action, parameters }),
    };
  } catch (error) {
    const control = providerControlError(error);
    if (control) throw control;
    return {
      session,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Stateful adapter around the auth program authored by the compile agent.
 * It executes only the action requested by the verifier agent, while retaining
 * browser and continuation state between ACTION_REQUIRED observations. */
export class LiveVerificationAuthSession {
  private workflow: Workflow | undefined;
  private verifier: AuthVerifier | undefined;
  private release: (() => void) | undefined;
  private expectedAction: string | undefined;
  private startedAt = 0;
  private started = false;
  private closed = false;

  constructor(private readonly opts: LiveVerificationAuthSessionOptions) {}

  async run(
    input: {
      action?: string;
      parameters?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<LiveAuthActionObservation> {
    const runDeadline = resolvedRunDeadline(this.opts.runDeadline, this.opts.deadlineMs);
    if (this.closed) throw new Error('authentication refresh session is already closed');
    await this.initialize();
    const workflow = this.workflow;
    const verifier = this.verifier;
    const expectedAction = this.expectedAction;
    if (!workflow?.authConfig || !verifier || !expectedAction) {
      throw new Error('authentication refresh session was not initialized');
    }
    if (Date.now() >= (runDeadline?.deadlineMs ?? Number.POSITIVE_INFINITY)) {
      await this.close();
      throw new ProviderDeadlineError(runDeadline?.deadlineMs ?? Date.now());
    }

    const action = input.action ?? expectedAction;
    if (action !== expectedAction) {
      throw new Error(
        `authentication expects action ${JSON.stringify(expectedAction)}, not ${JSON.stringify(action)}`,
      );
    }
    const actionPlan = workflow.authConfig.actions[action];
    if (!actionPlan) {
      await this.close();
      throw new Error(`authentication requested unknown action ${JSON.stringify(action)}`);
    }
    const parameters = input.parameters ?? {};
    const declared = new Set(actionPlan.parameters);
    const unexpected = Object.keys(parameters).filter((name) => !declared.has(name));
    const missing = actionPlan.parameters.filter((name) => parameters[name] === undefined);
    if (unexpected.length > 0 || missing.length > 0) {
      const details = [
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        unexpected.length > 0 ? `undeclared ${unexpected.join(', ')}` : '',
      ].filter(Boolean);
      throw new Error(
        `invalid parameters for auth action ${JSON.stringify(action)}: ${details.join('; ')}`,
      );
    }

    const active = combinedDeadlineSignal(runDeadline, undefined, this.opts.signal);
    try {
      const result = await verifier.runAction(action, parameters, {
        freshSession: !this.started,
        signal: active.signal,
      });
      if (active.signal?.aborted) {
        throw verifierAbortReason(active.signal);
      }
      this.started = true;
      const observation: LiveAuthActionObservation = {
        authToolName: workflow.toolName,
        action: result.action,
        ok: result.ok,
        error: result.error,
        message: result.message,
        nextAction: result.nextAction,
        usedBackend: result.usedBackend,
        status: result.status,
        durationMs: result.durationMs,
      };

      if (result.ok) {
        appendLiveVerifierLog(this.opts.logPath, {
          type: 'auth.refresh.completed',
          session: this.opts.sessionLabel,
          attempt: this.opts.attempt,
          ...observation,
          totalDurationMs: Date.now() - this.startedAt,
        });
        await this.close();
        return observation;
      }
      if (
        result.error === 'ACTION_REQUIRED' &&
        result.nextAction &&
        workflow.authConfig.actions[result.nextAction]
      ) {
        this.expectedAction = result.nextAction;
        observation.requiredParameters =
          workflow.authConfig.actions[result.nextAction]?.parameters ?? [];
        appendLiveVerifierLog(this.opts.logPath, {
          type: 'auth.refresh.action-required',
          session: this.opts.sessionLabel,
          attempt: this.opts.attempt,
          ...observation,
        });
        return observation;
      }

      appendLiveVerifierLog(this.opts.logPath, {
        type: 'auth.refresh.failed',
        session: this.opts.sessionLabel,
        attempt: this.opts.attempt,
        ...observation,
      });
      await this.close();
      return observation;
    } catch (error) {
      appendLiveVerifierLog(this.opts.logPath, {
        type: 'auth.refresh.failed',
        session: this.opts.sessionLabel,
        attempt: this.opts.attempt,
        authToolName: workflow.toolName,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.close();
      throw error;
    } finally {
      active.dispose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.verifier?.drain();
    } finally {
      this.release?.();
      this.release = undefined;
    }
  }

  private async initialize(): Promise<void> {
    if (this.workflow) return;
    if (authRefreshStartedForSession(this.opts.logPath, this.opts.sessionLabel)) {
      throw new Error('authentication refresh is limited to once per verifier session');
    }
    const dataWorkflow = WorkflowSchema.parse(
      JSON.parse(readFileSync(this.opts.workflowPath, 'utf8')),
    );
    const siteDir = dirname(dirname(this.opts.workflowPath));
    const authToolName = readBuildPlanFile(pathJoin(siteDir, '.build-plan.json'))?.authTool
      ?.toolName;
    if (!authToolName) {
      throw new Error(`no generated authentication workflow exists for ${dataWorkflow.site}`);
    }
    const authPath = pathJoin(siteDir, authToolName, 'workflow.json');
    const authWorkflow = WorkflowSchema.parse(JSON.parse(readFileSync(authPath, 'utf8')));
    if (authWorkflow.toolKind !== 'authenticate' || authWorkflow.site !== dataWorkflow.site) {
      throw new Error(
        `${authToolName} is not the authentication workflow for ${dataWorkflow.site}`,
      );
    }

    const runDeadline = resolvedRunDeadline(this.opts.runDeadline, this.opts.deadlineMs);
    if (this.opts.signal?.aborted) throw verifierAbortReason(this.opts.signal);
    this.release = await acquireSiteLiveLock(this.opts.workflowPath, runDeadline?.deadlineMs);
    try {
      // Another verifier can pass the optimistic check above while this process
      // waits for the site lock. Re-check under the lock before starting auth.
      if (authRefreshStartedForSession(this.opts.logPath, this.opts.sessionLabel)) {
        throw new Error('authentication refresh is limited to once per verifier session');
      }
      const stored = await loadCredentialStore(dataWorkflow.site);
      const cleanSession = this.opts.cleanSession === true;
      this.verifier = new AuthVerifier(
        authPath,
        credentialsForAuthRefresh(
          dataWorkflow.site,
          stored,
          authWorkflow.authConfig?.persist ?? [],
          cleanSession,
        ),
      );
      this.workflow = authWorkflow;
      this.expectedAction = authWorkflow.authConfig?.entry;
      this.startedAt = Date.now();
      appendLiveVerifierLog(this.opts.logPath, {
        type: 'auth.refresh.started',
        session: this.opts.sessionLabel,
        attempt: this.opts.attempt,
        authToolName,
        reason: this.opts.reason,
        cleanSession,
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}

export async function prepareLiveVerificationBackend(opts: {
  workflowPath: string;
  params: Record<string, string | number | boolean>;
  reason: string;
  forceReprobe?: boolean;
  logPath?: string;
  attempt?: number;
  probe?: typeof probeResolvedTool;
  signal?: AbortSignal;
}): Promise<BackendPreparationResult> {
  const tool = resolveWorkflowTool(opts.workflowPath);
  const toolDir = tool.dir;
  const assetRoot = pathJoin(toolDir, '..', '..');
  const evidencePath = pathJoin(toolDir, LIVE_VERIFICATION_EVIDENCE_FILE);
  const startedAt = Date.now();
  const label = nextRecordLabel(evidencePath, 'backend-preparation');
  const status = loadBackendsCacheStatus(tool.site, assetRoot, toolDir, {
    warn: false,
    toolName: tool.workflow.toolName,
  });

  appendLiveVerifierLog(opts.logPath, {
    type: 'backend.prepare.started',
    attempt: opts.attempt,
    label,
    reason: opts.reason,
    forceReprobe: opts.forceReprobe ?? false,
    cacheStatus: status.status,
  });
  persistLiveVerificationEvidence(evidencePath, [
    {
      kind: 'backend-preparation',
      label,
      status: 'running',
      startedAt: new Date(startedAt).toISOString(),
      reason: opts.reason,
      forceReprobe: opts.forceReprobe ?? false,
      cacheStatus: status.status,
    },
  ]);

  try {
    const reusableStaleCache =
      status.status === 'stale' && canRebindBackendsCacheToWorkflow(tool, status.cache);
    const reusedCache = (status.status === 'ok' || reusableStaleCache) && !opts.forceReprobe;
    const cache = reusedCache
      ? reusableStaleCache
        ? rebindBackendsCacheToWorkflow(tool, status.cache)
        : status.cache
      : opts.probe
        ? (
            await opts.probe(
              { site: tool.site, paramOverrides: opts.params },
              assetRoot,
              tool,
              pathJoin(toolDir, 'backends.json'),
            )
          ).cache
        : (
            await runBackendProbeSubprocess({
              workflowPath: opts.workflowPath,
              params: opts.params,
              outPath: pathJoin(toolDir, 'backends.json'),
              logPath: opts.logPath,
              attempt: opts.attempt,
              label,
              signal: opts.signal,
            })
          ).cache;
    const preferredBackend = cache.preferredOrder[0];
    if (!preferredBackend) throw new Error('backend probe produced no preferred backend');
    const durationMs = Date.now() - startedAt;
    const result: BackendPreparationResult = {
      label,
      cache,
      preferredBackend,
      reusedCache,
      durationMs,
    };
    persistLiveVerificationEvidence(evidencePath, [
      {
        kind: 'backend-preparation',
        label,
        status: 'passed',
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        reason: opts.reason,
        forceReprobe: opts.forceReprobe ?? false,
        reusedCache,
        preferredBackend,
        probedAt: cache.probedAt,
        durationMs,
      },
    ]);
    appendLiveVerifierLog(opts.logPath, {
      type: 'backend.prepare.completed',
      attempt: opts.attempt,
      ...result,
    });
    return result;
  } catch (error) {
    const failure = backendPreparationFailureObservation(error);
    const durationMs = Date.now() - startedAt;
    persistLiveVerificationEvidence(evidencePath, [
      {
        kind: 'backend-preparation',
        label,
        status: 'failed',
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        reason: opts.reason,
        forceReprobe: opts.forceReprobe ?? false,
        error: failure.error,
        requestStageFacts: failure.requestStageFacts,
        durationMs,
      },
    ]);
    appendLiveVerifierLog(opts.logPath, {
      type: 'backend.prepare.failed',
      attempt: opts.attempt,
      label,
      error: failure.error,
      requestStageFacts: failure.requestStageFacts,
      durationMs,
    });
    if (failure.requestStageFacts.length > 0) {
      throw backendPreparationError(failure.error, failure.requestStageFacts);
    }
    throw error;
  }
}

async function runBackendProbeSubprocess(opts: {
  workflowPath: string;
  params: Record<string, string | number | boolean>;
  outPath: string;
  logPath?: string;
  attempt?: number;
  label: string;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof probeResolvedTool>>> {
  const previousCacheContents = existsSync(opts.outPath)
    ? readFileSync(opts.outPath, 'utf8')
    : undefined;
  const tool = resolveWorkflowTool(opts.workflowPath);
  const assetRoot = pathJoin(tool.dir, '..', '..');
  const child = spawnOwnedProcess(
    process.execPath,
    [
      'run',
      CLI_PATH,
      '__probe-live-verification-backends',
      '--workflow-path',
      opts.workflowPath,
      '--out-path',
      opts.outPath,
    ],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin?.end(JSON.stringify(opts.params));

  let stderr = '';
  let rawStderrTail = '';
  const logChunk = (stream: 'stdout' | 'stderr', raw: unknown): void => {
    const rawChunk = String(raw);
    const chunk = redactFreeformText(boundedTail(rawChunk, 4_000)).redacted;
    if (stream === 'stderr') {
      rawStderrTail = appendBackendProbeRawStderrTail(rawStderrTail, rawChunk);
      stderr = boundedTail(`${stderr}${chunk}`, 8_000);
    }
    appendLiveVerifierLog(opts.logPath, {
      type: 'backend.probe.progress',
      attempt: opts.attempt,
      label: opts.label,
      stream,
      chunk,
    });
  };
  const outcome = await waitForOwnedProcessTree(
    child,
    BACKEND_PREPARATION_BUDGET_MS,
    BACKEND_PROBE_SHUTDOWN_GRACE_MS,
    {
      onStdoutChunk: (chunk) => logChunk('stdout', chunk),
      onStderrChunk: (chunk) => logChunk('stderr', chunk),
    },
    opts.signal,
  );
  if (outcome.timedOut) {
    // probeResolvedTool checkpoints every successful candidate. If a later
    // optional rung consumed the aggregate deadline, use the new valid cache
    // instead of discarding an already-proven backend. Do not reuse an unchanged
    // pre-probe cache: forceReprobe may have been requested because it failed.
    const currentCacheContents = existsSync(opts.outPath)
      ? readFileSync(opts.outPath, 'utf8')
      : undefined;
    const cacheStatus = loadBackendsCacheStatus(tool.site, assetRoot, tool.dir, {
      warn: false,
      toolName: tool.workflow.toolName,
    });
    if (
      currentCacheContents !== undefined &&
      currentCacheContents !== previousCacheContents &&
      cacheStatus.status === 'ok'
    ) {
      appendLiveVerifierLog(opts.logPath, {
        type: 'backend.probe.partial-cache-recovered',
        attempt: opts.attempt,
        label: opts.label,
        preferredOrder: cacheStatus.cache.preferredOrder,
      });
      return { cache: cacheStatus.cache, outPath: opts.outPath };
    }
    throw new Error(
      `backend probe exceeded its separate ${Math.round(BACKEND_PREPARATION_BUDGET_MS / 1_000)}s budget and was terminated`,
    );
  }
  if (outcome.exitCode !== 0) {
    const requestStageFacts = parseBackendRequestStageFacts(rawStderrTail);
    const publicStderr = stripBackendRequestStageFacts(stderr);
    throw backendPreparationError(
      `backend probe exited ${outcome.exitCode}${publicStderr ? `: ${publicStderr.slice(-2_000)}` : ''}`,
      requestStageFacts,
    );
  }

  const cacheStatus = loadBackendsCacheStatus(tool.site, assetRoot, tool.dir, {
    warn: false,
    toolName: tool.workflow.toolName,
  });
  if (cacheStatus.status !== 'ok') {
    throw new Error(`backend probe completed without a valid cache (${cacheStatus.status})`);
  }
  return { cache: cacheStatus.cache, outPath: opts.outPath };
}

/** Retain the private transport marker independently of the shorter public log
 * chunk. The subprocess emits at most 32 whitelisted request-stage facts. */
export function appendBackendProbeRawStderrTail(current: string, raw: unknown): string {
  return boundedTail(`${current}${String(raw)}`, 8_000);
}

interface LiveSemanticVerificationResult {
  report: LiveVerificationReport;
  provider: ProviderName;
  model: string;
  attempts: number;
  /** True only when an independent verifier returned a schema-valid report.
   * Provider startup/input failures synthesize an inconclusive report for
   * compiler feedback but do not consume a semantic-review cycle. */
  completedReview: boolean;
}

function verifierAbortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Semantic verification cancelled', 'AbortError');
}

function throwIfVerifierCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw verifierAbortReason(signal);
}

export async function runLiveSemanticVerification(opts: {
  provider: ProviderName;
  toolDir: string;
  evidence: LiveIntegrationEvidence[];
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  onDeadlineReached?: () => Promise<number | null>;
  signal?: AbortSignal;
}): Promise<LiveSemanticVerificationResult> {
  throwIfVerifierCancelled(opts.signal);
  const runDeadline = resolvedRunDeadline(
    opts.runDeadline,
    opts.deadlineMs ?? Date.now() + 10 * 60_000,
  );
  const verifierDeadline = boundedRunDeadline(runDeadline, Date.now() + 10 * 60_000);
  if (verifierDeadline && Date.now() >= verifierDeadline.deadlineMs) {
    throw new ProviderDeadlineError(verifierDeadline.deadlineMs);
  }
  const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  const model = preferredVerificationModel(opts.provider);
  const reportPath = pathJoin(opts.toolDir, '.live-verification.json');
  const evidencePath = pathJoin(opts.toolDir, LIVE_VERIFICATION_EVIDENCE_FILE);
  const logPath = pathJoin(opts.toolDir, LIVE_VERIFIER_LOG_FILE);
  const verifierSessionLabel = nextRecordLabel(evidencePath, 'verifier-session');
  const sessionStartedAtMs = Date.now();
  const sessionStartedAt = new Date(sessionStartedAtMs).toISOString();
  let verifierSession: PersistedLiveVerificationRecord = {
    label: verifierSessionLabel,
    kind: 'verifier-session',
    status: 'running',
    startedAt: sessionStartedAt,
    provider: opts.provider,
    model,
  };
  const invocationEvidence = namespaceLiveIntegrationEvidence(opts.evidence, verifierSessionLabel);
  let accumulated: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord> =
    mergePersistedRecords(readPersistedLiveVerificationEvidence(evidencePath), [
      verifierSession,
      ...invocationEvidence,
    ]);
  const attemptErrors: string[] = [];
  let attemptsUsed = 0;
  persistLiveVerificationEvidence(evidencePath, accumulated);
  appendLiveVerifierLog(logPath, {
    type: 'verifier.session.started',
    session: verifierSessionLabel,
    provider: opts.provider,
    model,
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    throwIfVerifierCancelled(opts.signal);
    attemptsUsed = attempt;
    try {
      if (existsSync(reportPath)) unlinkSync(reportPath);
    } catch {
      // best effort
    }
    appendLiveVerifierLog(logPath, {
      type: 'verifier.attempt.started',
      attempt,
      provider: opts.provider,
      model,
    });
    try {
      const initialMessage = buildInitialMessage(workflow, accumulated, opts.toolDir);
      const retryMessage =
        attempt === 1
          ? initialMessage
          : `${initialMessage}\n\nRETRY NOTE: The prior verifier attempt ended without a usable report. Existing backend preparation, suite receipts, targeted-call outputs, and diagnostics are supplied above. Inspect them and use the live tools when useful; do not assume a successful call must be repeated.`;
      const report =
        opts.provider === 'anthropic-api'
          ? await runAnthropicVerifier({
              workflowPath,
              reportPath,
              initialMessage: retryMessage,
              model,
              deadlineMs: verifierDeadline?.deadlineMs,
              runDeadline: verifierDeadline,
              onDeadlineReached: opts.onDeadlineReached,
              logPath,
              attempt,
              sessionLabel: verifierSessionLabel,
              signal: opts.signal,
            })
          : await runCliVerifier({
              provider: opts.provider,
              workflowPath,
              reportPath,
              initialMessage: retryMessage,
              model,
              deadlineMs: verifierDeadline?.deadlineMs,
              runDeadline: verifierDeadline,
              onDeadlineReached: opts.onDeadlineReached,
              logSinceMs: sessionStartedAtMs,
              logPath,
              attempt,
              sessionLabel: verifierSessionLabel,
              signal: opts.signal,
            });
      accumulated = mergePersistedRecords(
        accumulated,
        readPersistedLiveVerificationEvidence(evidencePath),
      );
      assertReportCoversWorkflowParameters(report, workflow.parameters);
      persistLiveVerificationEvidence(evidencePath, accumulated);
      const persistedReport = {
        ...report,
        evidenceArtifact: LIVE_VERIFICATION_EVIDENCE_FILE,
        logArtifact: LIVE_VERIFIER_LOG_FILE,
      };
      writeFileSync(reportPath, `${JSON.stringify(persistedReport, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      appendLiveVerifierLog(logPath, {
        type: 'verifier.attempt.completed',
        attempt,
        status: persistedReport.status,
      });
      verifierSession = {
        ...verifierSession,
        status: persistedReport.status,
        finishedAt: new Date().toISOString(),
        attempts: attempt,
      };
      accumulated = mergePersistedRecords(accumulated, [verifierSession]);
      persistLiveVerificationEvidence(evidencePath, accumulated);
      appendLiveVerifierLog(logPath, {
        type: 'verifier.session.completed',
        session: verifierSessionLabel,
        status: persistedReport.status,
        attempts: attempt,
      });
      return {
        report: persistedReport,
        provider: opts.provider,
        model,
        attempts: attempt,
        completedReview: true,
      };
    } catch (error) {
      throwIfVerifierCancelled(opts.signal);
      const control = providerControlError(error);
      if (control) throw control;
      const reported = providerReportedError(error);
      if (reported) throw reported;
      const message = error instanceof Error ? error.message : String(error);
      attemptErrors.push(`attempt ${attempt}: ${message}`);
      accumulated = mergePersistedRecords(
        accumulated,
        readPersistedLiveVerificationEvidence(evidencePath),
      );
      appendLiveVerifierLog(logPath, {
        type: 'verifier.attempt.failed',
        attempt,
        error: message,
      });
      // An ACTION_REQUIRED result owns live browser/continuation state inside
      // the attempt that observed it. A fresh CLI/agent attempt cannot resume
      // that state, so fail closed instead of pretending a restart is a retry.
      if (authRefreshAwaitingContinuation(logPath, verifierSessionLabel)) break;
    }
  }

  const infrastructureEvidence: PersistedLiveVerificationRecord = {
    label: `${verifierSessionLabel}/infrastructure`,
    kind: 'verifier-infrastructure',
    errors: attemptErrors,
  };
  verifierSession = {
    ...verifierSession,
    status: 'inconclusive',
    finishedAt: new Date().toISOString(),
    attempts: attemptsUsed,
  };
  accumulated = mergePersistedRecords(accumulated, [infrastructureEvidence, verifierSession]);
  persistLiveVerificationEvidence(evidencePath, accumulated);
  const failureSummary = attemptErrors.join('; ') || 'verifier did not return a valid report';
  const inconclusive: LiveVerificationReport = {
    status: 'inconclusive',
    summary: `Independent semantic verifier failed closed: ${failureSummary}`,
    baseline: {
      verdict: 'infrastructure',
      reason: failureSummary,
    },
    parameters: workflow.parameters.map((parameter) => ({
      name: parameter.name,
      verdict: 'untestable',
      reason: 'the independent verifier did not return a valid report',
    })),
    issues: [],
    gaps: ['No valid independent semantic verification report was produced.'],
    evidenceArtifact: LIVE_VERIFICATION_EVIDENCE_FILE,
    logArtifact: LIVE_VERIFIER_LOG_FILE,
  };
  writeFileSync(reportPath, `${JSON.stringify(inconclusive, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  appendLiveVerifierLog(logPath, {
    type: 'verifier.completed',
    status: 'inconclusive',
    errors: attemptErrors,
  });
  appendLiveVerifierLog(logPath, {
    type: 'verifier.session.completed',
    session: verifierSessionLabel,
    status: 'inconclusive',
    attempts: attemptsUsed,
  });
  return {
    report: inconclusive,
    provider: opts.provider,
    model,
    attempts: attemptsUsed,
    completedReview: false,
  };
}

function mergePersistedRecords(
  current: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord>,
  incoming: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord>,
): Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord> {
  const merged = new Map(current.map((item) => [item.label, item]));
  for (const item of incoming) merged.set(item.label, item);
  return [...merged.values()];
}

function readVerifierArtifact(path: string, maxChars = 30_000): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return content.length <= maxChars
    ? content
    : `${content.slice(0, maxChars)}\n...[truncated ${content.length - maxChars} chars]`;
}

export function buildVerifierArtifactContext(toolDir: string, toolName: string): unknown {
  let buildPlan: unknown;
  const buildPlanPath = pathJoin(dirname(toolDir), '.build-plan.json');
  if (existsSync(buildPlanPath)) {
    try {
      const parsed = JSON.parse(readFileSync(buildPlanPath, 'utf8')) as {
        perTool?: Array<{ toolName?: string }>;
        dynamicValueFindings?: unknown;
      };
      buildPlan = {
        tool: parsed.perTool?.find((entry) => entry.toolName === toolName),
        dynamicValueFindings: parsed.dynamicValueFindings,
      };
    } catch {
      buildPlan = { error: 'build plan could not be parsed' };
    }
  }
  return {
    workflow: JSON.parse(readFileSync(pathJoin(toolDir, 'workflow.json'), 'utf8')),
    requestTransform: readVerifierArtifact(pathJoin(toolDir, 'request-transform.ts')),
    requestTests: readVerifierArtifact(pathJoin(toolDir, 'request.test.ts')),
    parser: readVerifierArtifact(pathJoin(toolDir, 'parser.ts')),
    parserTests: readVerifierArtifact(pathJoin(toolDir, 'parser.test.ts')),
    integrationTests: readVerifierArtifact(pathJoin(toolDir, 'integration.test.ts')),
    playbook: readVerifierArtifact(pathJoin(toolDir, 'playbook.yaml')),
    buildPlan,
  };
}

function buildInitialMessage(
  workflow: z.infer<typeof WorkflowSchema>,
  evidence: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord>,
  toolDir: string,
): string {
  return `Review this generated tool's real live outputs and submit a structured report.\n\n${JSON.stringify(
    {
      tool: {
        name: workflow.toolName,
        site: workflow.site,
        intent: workflow.intent,
        parameters: workflow.parameters,
      },
      reviewContext: {
        currentDate: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      artifactContext: buildVerifierArtifactContext(toolDir, workflow.toolName),
      baselineEvidence: compactVerifierEvidenceContext(evidence),
    },
    null,
    2,
  )}`;
}

/** Keep the verifier prompt bounded without weakening the durable evidence
 * artifact. Full, sanitized receipts remain on disk; the model gets recent
 * records with representative payload previews and navigation metadata. */
export function compactVerifierEvidenceContext(
  evidence: Array<LiveIntegrationEvidence | PersistedLiveVerificationRecord>,
): unknown[] {
  const omittedRecords = Math.max(0, evidence.length - MAX_PROMPT_EVIDENCE_RECORDS);
  const selected = evidence.slice(-MAX_PROMPT_EVIDENCE_RECORDS);
  const compacted = selected.map((record) => compactVerifierEvidenceRecord(record));
  return omittedRecords > 0
    ? [
        {
          kind: 'prompt-compaction',
          omittedRecords,
          note: `Full receipts remain in ${LIVE_VERIFICATION_EVIDENCE_FILE}.`,
        },
        ...compacted,
      ]
    : compacted;
}

function compactVerifierEvidenceRecord(
  record: LiveIntegrationEvidence | PersistedLiveVerificationRecord,
): unknown {
  const compacted = compactVerifierValue(record, 0);
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= MAX_PROMPT_EVIDENCE_RECORD_CHARS) return compacted;

  const navigationKeys = [
    'schemaVersion',
    'kind',
    'label',
    'caseName',
    'toolName',
    'status',
    'verifierSession',
    'startedAt',
    'finishedAt',
    'requestedParams',
    'effectiveParams',
    'preferredBackend',
    'usedBackend',
    'attempts',
    'durationMs',
    'exitCode',
    'timedOut',
    'passedTests',
    'failedTests',
    'completedCallLabels',
    'reason',
    'error',
  ] as const;
  const source = record as Record<string, unknown>;
  const navigation: Record<string, unknown> = {};
  for (const key of navigationKeys) {
    if (source[key] !== undefined) navigation[key] = compactVerifierValue(source[key], 0);
  }
  return {
    ...navigation,
    payloadPreview: clipVerifierString(serialized, MAX_PROMPT_EVIDENCE_RECORD_CHARS),
    promptCompacted: true,
    note: `Full receipt remains in ${LIVE_VERIFICATION_EVIDENCE_FILE}.`,
  };
}

function compactVerifierValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clipVerifierString(value, 2_000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return clipVerifierString(JSON.stringify(value), 2_000);
  if (Array.isArray(value)) {
    if (value.length <= 4) return value.map((item) => compactVerifierValue(item, depth + 1));
    return [
      ...value.slice(0, 3).map((item) => compactVerifierValue(item, depth + 1)),
      { promptCompactedItems: value.length - 4 },
      compactVerifierValue(value.at(-1), depth + 1),
    ];
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      compactVerifierValue(item, depth + 1),
    ]),
  );
}

function clipVerifierString(value: string, maxChars: number): string {
  const redacted = redactFreeformText(value).redacted;
  if (redacted.length <= maxChars) return redacted;
  const headChars = Math.ceil(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.4);
  return `${redacted.slice(0, headChars)}\n...[prompt preview truncated ${redacted.length - maxChars} chars]...\n${redacted.slice(-tailChars)}`;
}

async function runAnthropicVerifier(opts: {
  workflowPath: string;
  reportPath: string;
  initialMessage: string;
  model: string;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  onDeadlineReached?: () => Promise<number | null>;
  logPath: string;
  attempt: number;
  sessionLabel: string;
  signal?: AbortSignal;
}): Promise<LiveVerificationReport> {
  const active = combinedDeadlineSignal(
    opts.runDeadline,
    undefined,
    opts.signal,
    Date.now,
    undefined,
    opts.onDeadlineReached,
  );
  const provider = resolveProvider({
    provider: 'anthropic-api',
    model: opts.model,
  });
  if (!isToolUseProvider(provider)) throw new Error('Anthropic provider lacks tool use');
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowPath, 'utf8')));
  const validator = buildZodValidator(workflow.parameters);
  let authSession: LiveVerificationAuthSession | undefined;
  let submitted: LiveVerificationReport | undefined;
  let loggedConversationEntries = 0;
  const evidencePath = pathJoin(dirname(opts.reportPath), LIVE_VERIFICATION_EVIDENCE_FILE);
  const hasSuiteReceipt = (): boolean => hasSuiteReceiptForSession(evidencePath, opts.sessionLabel);

  const tools: AgentTool[] = [
    {
      name: 'refresh_auth_session',
      description: LIVE_AUTH_REFRESH_TOOL_DESCRIPTION,
      input_schema: LIVE_AUTH_REFRESH_INPUT_SCHEMA,
      handler: async (raw) => {
        const result = await runLiveAuthRefreshToolCall(authSession, raw, {
          workflowPath: opts.workflowPath,
          logPath: opts.logPath,
          attempt: opts.attempt,
          sessionLabel: opts.sessionLabel,
          deadlineMs: opts.deadlineMs,
          runDeadline: opts.runDeadline,
          signal: active.signal,
        });
        authSession = result.session;
        return result.error
          ? { result: result.error, isError: true }
          : { result: JSON.stringify(result.observation) };
      },
    },
    {
      name: 'prepare_live_backend',
      description:
        'Reuse the current preferred backend, probing only when no valid preference exists. Set forceReprobe only after the preferred backend fails because of a transport, network, or browser-infrastructure error; semantic output failures must go back to the compiler without reprobe. On failure, requestStageFacts report value-free preparation, transform, and send outcomes for each attempted request.',
      input_schema: {
        type: 'object',
        properties: {
          params: { type: 'object' },
          reason: { type: 'string' },
          forceReprobe: { type: 'boolean' },
        },
        required: ['params', 'reason'],
      },
      handler: async (raw) => {
        const input = raw as {
          params?: unknown;
          reason?: unknown;
          forceReprobe?: unknown;
        };
        if (typeof input.reason !== 'string' || !input.reason.trim()) {
          return { result: 'reason is required', isError: true };
        }
        const parsed = validator.safeParse(input.params ?? {});
        if (!parsed.success) return { result: parsed.error.message, isError: true };
        try {
          const result = await prepareLiveVerificationBackend({
            workflowPath: opts.workflowPath,
            params: parsed.data as Record<string, string | number | boolean>,
            reason: input.reason,
            forceReprobe: input.forceReprobe === true,
            logPath: opts.logPath,
            attempt: opts.attempt,
            signal: active.signal,
          });
          return { result: JSON.stringify(result) };
        } catch (error) {
          const control = providerControlError(error);
          if (control) throw control;
          return {
            result: JSON.stringify(backendPreparationFailureObservation(error)),
            isError: true,
          };
        }
      },
    },
    {
      name: 'run_live_integration_suite',
      description:
        'Run the compiler-proposed final integration suite. A justified rerun is allowed after failure, timeout, or backend reprobe.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        additionalProperties: false,
      },
      handler: async (raw) => {
        const input = raw as { reason?: unknown };
        try {
          const suite = await runLiveIntegrationSuite({
            toolDir: dirname(opts.workflowPath),
            logPath: opts.logPath,
            attempt: opts.attempt,
            reason: typeof input.reason === 'string' ? input.reason : undefined,
            sessionLabel: opts.sessionLabel,
            signal: active.signal,
          });
          return { result: JSON.stringify(suite) };
        } catch (error) {
          const control = providerControlError(error);
          if (control) throw control;
          return {
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    },
    {
      name: 'run_live_integration_test',
      description:
        'Run a targeted live call for a specific unresolved semantic question. Repeated parameters are allowed when the reason explains why.',
      input_schema: {
        type: 'object',
        properties: { params: { type: 'object' }, reason: { type: 'string' } },
        required: ['params', 'reason'],
      },
      handler: async (raw) => {
        if (!hasSuiteReceipt())
          return {
            result: 'Run the final integration suite before a targeted follow-up.',
            isError: true,
          };
        const input = raw as { params?: unknown; reason?: unknown };
        if (typeof input.reason !== 'string' || !input.reason.trim()) {
          return { result: 'reason is required', isError: true };
        }
        const parsed = validator.safeParse(input.params ?? {});
        if (!parsed.success) return { result: parsed.error.message, isError: true };
        const label = nextRecordLabel(evidencePath, 'targeted-call');
        const startedAt = Date.now();
        appendLiveVerifierLog(opts.logPath, {
          type: 'targeted-call.started',
          attempt: opts.attempt,
          label,
          reason: input.reason,
          params: parsed.data,
        });
        let run: Awaited<ReturnType<typeof runCapturedIntegrationCase>>;
        try {
          run = await runCapturedIntegrationCase({
            caseName: label,
            workflowPath: opts.workflowPath,
            params: parsed.data as Record<string, string | number | boolean>,
            preferredOnlyBackend: true,
            deadlineMs: opts.runDeadline?.deadlineMs ?? opts.deadlineMs,
            signal: active.signal,
          });
        } catch (error) {
          const control = providerControlError(error);
          if (control) throw control;
          const message = error instanceof Error ? error.message : String(error);
          appendLiveVerifierLog(opts.logPath, {
            type: 'targeted-call.failed',
            attempt: opts.attempt,
            label,
            error: message,
          });
          return { result: message, isError: true };
        }
        const supplemental: LiveIntegrationEvidence = {
          schemaVersion: 1,
          kind: 'call',
          label,
          caseName: label,
          toolName: workflow.toolName,
          requestedParams: parsed.data as Record<string, string | number | boolean>,
          effectiveParams: effectiveParamsForEvidence(
            workflow.parameters,
            parsed.data as Record<string, string | number | boolean>,
          ),
          result: run.result,
          usedBackend: run.usedBackend,
          attempts: run.attempts,
          durationMs: Date.now() - startedAt,
        };
        persistLiveVerificationEvidence(evidencePath, [supplemental]);
        appendLiveVerifierLog(opts.logPath, {
          type: 'targeted-call.completed',
          attempt: opts.attempt,
          record: supplemental,
        });
        return {
          result: JSON.stringify({
            label: supplemental.label,
            toolName: workflow.toolName,
            requestedParams: parsed.data,
            result: run.result,
            usedBackend: run.usedBackend,
            attempts: run.attempts,
          }),
        };
      },
    },
    {
      name: 'submit_verification_report',
      description: 'Submit the final structured semantic report exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          summary: { type: 'string' },
          baseline: { type: 'object' },
          parameters: { type: 'array' },
          issues: { type: 'array' },
          gaps: { type: 'array' },
        },
        required: ['status', 'summary', 'baseline', 'parameters', 'issues', 'gaps'],
      },
      handler: async (raw) => {
        const parsed = LiveVerificationReportSchema.safeParse(raw);
        if (!parsed.success) return { result: parsed.error.message, isError: true };
        if (!hasSuiteReceipt()) {
          return {
            result: 'Run the final integration suite before submitting.',
            isError: true,
          };
        }
        try {
          assertReportCoversWorkflowParameters(parsed.data, workflow.parameters);
        } catch (error) {
          return {
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        submitted = parsed.data;
        appendLiveVerifierLog(opts.logPath, {
          type: 'report.submitted',
          attempt: opts.attempt,
          report: parsed.data,
        });
        return { result: 'Report accepted. Call done now.' };
      },
    },
    doneTool(),
  ];
  try {
    const result = await runAgentLoop({
      systemPrompt: readFileSync(SYSTEM_PROMPT_PATH, 'utf8'),
      initialUserMessage: opts.initialMessage,
      tools,
      deadlineMs: opts.deadlineMs ?? Date.now() + 10 * 60_000,
      runDeadline: opts.runDeadline,
      onDeadlineReached: opts.onDeadlineReached,
      softTurnCap: 12,
      llm: provider,
      signal: active.signal,
      onConversationUpdate: (conversation) => {
        for (const entry of conversation.slice(loggedConversationEntries)) {
          appendLiveVerifierLog(opts.logPath, {
            type: 'agent.conversation-entry',
            attempt: opts.attempt,
            entry,
          });
        }
        loggedConversationEntries = conversation.length;
      },
    });
    if (!submitted) throw new Error(`semantic verifier ended without a report (${result.outcome})`);
    return submitted;
  } finally {
    active.dispose();
    await authSession?.close();
  }
}

async function runCliVerifier(opts: {
  provider: ProviderName;
  workflowPath: string;
  reportPath: string;
  initialMessage: string;
  model: string;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  onDeadlineReached?: () => Promise<number | null>;
  logPath: string;
  attempt: number;
  sessionLabel: string;
  logSinceMs: number;
  signal?: AbortSignal;
}): Promise<LiveVerificationReport> {
  if (opts.provider !== 'codex-cli' && opts.provider !== 'claude-cli') {
    throw new Error(`CLI verifier is unsupported for ${opts.provider}`);
  }
  const cliProvider = opts.provider;
  const mcpArgs = [
    'run',
    CLI_PATH,
    '__mcp-live-verifier-server',
    '--workflow-path',
    opts.workflowPath,
    '--report-path',
    opts.reportPath,
    '--log-path',
    opts.logPath,
    '--attempt',
    String(opts.attempt),
    '--session-label',
    opts.sessionLabel,
  ];
  const runDeadline = resolvedRunDeadline(
    opts.runDeadline,
    opts.deadlineMs ?? Date.now() + 10 * 60_000,
  );
  return await retryTransientProviderFailure(
    async () => {
      const child =
        opts.provider === 'codex-cli'
          ? spawnCodexVerifier({ ...opts, deadlineMs: runDeadline?.deadlineMs }, mcpArgs)
          : spawnClaudeVerifier({ ...opts, deadlineMs: runDeadline?.deadlineMs }, mcpArgs);
      const { exitCode, stderr } = await waitForVerifierChild(
        child,
        runDeadline,
        opts.logPath,
        opts.attempt,
        opts.logSinceMs,
        opts.signal,
        5_000,
        cliProvider,
      );
      if (!existsSync(opts.reportPath)) {
        throw new Error(
          `${opts.provider} semantic verifier exited ${exitCode} without a report${stderr ? `: ${stderr.slice(-1000)}` : ''}`,
        );
      }
      const parsed = LiveVerificationReportSchema.safeParse(
        JSON.parse(readFileSync(opts.reportPath, 'utf8')),
      );
      if (!parsed.success) throw new Error(`malformed semantic report: ${parsed.error.message}`);
      return parsed.data;
    },
    {
      runDeadline,
      signal: opts.signal,
      onDeadlineReached: opts.onDeadlineReached,
    },
  );
}

function spawnCodexVerifier(
  opts: { initialMessage: string; model: string; deadlineMs?: number },
  mcpArgs: string[],
): ChildProcess {
  const args = [
    '-a',
    'never',
    '-C',
    REPO_ROOT,
    '-s',
    'read-only',
    '-m',
    opts.model,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify(mcpArgs)}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode=${JSON.stringify('approve')}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=600`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.required=true`,
    '-c',
    'shell_environment_policy.inherit=all',
    'exec',
    '--json',
    '--ephemeral',
    '--disable',
    'plugins',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-',
  ];
  const child = spawnOwnedProcess('codex', args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      IMPRINT_LIVE_VERIFIER_DEADLINE_MS: String(opts.deadlineMs ?? Date.now() + 10 * 60_000),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(
    `<system_instructions>\n${readFileSync(SYSTEM_PROMPT_PATH, 'utf8')}\n</system_instructions>\n\n${opts.initialMessage}`,
  );
  return child;
}

function spawnClaudeVerifier(
  opts: { initialMessage: string; model: string; deadlineMs?: number },
  mcpArgs: string[],
): ChildProcess {
  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: mcpArgs,
        alwaysLoad: true,
      },
    },
  };
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--system-prompt-file',
    SYSTEM_PROMPT_PATH,
    '--tools',
    '',
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__refresh_auth_session`,
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__prepare_live_backend`,
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__run_live_integration_suite`,
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__run_live_integration_test`,
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__submit_verification_report`,
    '--max-turns',
    '12',
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--model',
    opts.model,
    opts.initialMessage,
  ];
  return spawnOwnedProcess('claude', args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      IMPRINT_LIVE_VERIFIER_DEADLINE_MS: String(opts.deadlineMs ?? Date.now() + 10 * 60_000),
      MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function waitForVerifierChild(
  child: ChildProcess,
  deadline: number | RunDeadlineRef | undefined,
  logPath: string,
  attempt: number,
  _logSinceMs: number,
  signal?: AbortSignal,
  shutdownGraceMs = 5_000,
  provider?: 'claude-cli' | 'codex-cli',
): Promise<{ exitCode: number | null; stderr: string }> {
  const runDeadline =
    typeof deadline === 'number' ? resolvedRunDeadline(undefined, deadline) : deadline;
  let stderr = '';
  const terminal = provider ? new ProviderTerminalAccumulator(provider) : undefined;
  const active = combinedDeadlineSignal(runDeadline, undefined, signal);

  try {
    const output = await collectOwnedProcess(child, {
      signal: active.signal,
      shutdownGraceMs,
      onStdoutLine: (line) => terminal?.ingestLine(line),
      onStdoutChunk: (chunk) =>
        appendLiveVerifierLog(logPath, {
          type: 'provider.stdout',
          attempt,
          chunk: boundedTail(chunk, 8_000),
        }),
      onStderrChunk: (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8000);
        appendLiveVerifierLog(logPath, {
          type: 'provider.stderr',
          attempt,
          chunk: boundedTail(chunk, 8_000),
        });
      },
    });
    terminal?.ingestStderr(stderr);
    const parsed = terminal?.result();
    if (parsed?.providerError) throw parsed.providerError;
    appendLiveVerifierLog(logPath, {
      type: 'provider.closed',
      attempt,
      exitCode: output.exitCode,
    });
    return { exitCode: output.exitCode, stderr };
  } finally {
    active.dispose();
  }
}

export async function waitForOwnedProcessTree(
  child: ChildProcess,
  timeoutMs: number,
  shutdownGraceMs: number,
  callbacks: {
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  } = {},
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Owned process deadline exceeded'));
  }, timeoutMs);
  const cancel = (): void =>
    controller.abort(
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Owned process cancelled', 'AbortError'),
    );
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  timer.unref?.();
  try {
    const output = await collectOwnedProcess(child, {
      signal: controller.signal,
      shutdownGraceMs,
      ...callbacks,
    });
    return { exitCode: output.exitCode, timedOut: false };
  } catch (error) {
    if (signal?.aborted) throw verifierAbortReason(signal);
    if (!timedOut) throw error;
    return { exitCode: child.exitCode, timedOut: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function semanticVerificationFailures(report: LiveVerificationReport): string[] {
  if (report.status === 'approved') return [];
  if (report.status === 'approved_with_gaps') {
    return [
      `independent live semantic verification remains unresolved: ${report.summary}\nGaps: ${report.gaps.join('; ') || 'none'}\nEvidence: ${report.evidenceArtifact ?? LIVE_VERIFICATION_EVIDENCE_FILE}\nVerifier log: ${report.logArtifact ?? LIVE_VERIFIER_LOG_FILE}`,
    ];
  }
  if (report.status === 'inconclusive') {
    return [
      `independent live semantic verification was inconclusive: ${report.summary}\nBaseline: ${report.baseline.reason}\nGaps: ${report.gaps.join('; ') || 'none'}\nEvidence: ${report.evidenceArtifact ?? LIVE_VERIFICATION_EVIDENCE_FILE}\nVerifier log: ${report.logArtifact ?? LIVE_VERIFIER_LOG_FILE}`,
    ];
  }
  return report.issues.map(
    (issue) =>
      `semantic verification: ${issue.summary}\nExpected: ${issue.expected}\nObserved: ${issue.observed}\nSuggested fix: ${issue.suggestedFix}\nEvidence: ${report.evidenceArtifact ?? LIVE_VERIFICATION_EVIDENCE_FILE}\nVerifier log: ${report.logArtifact ?? LIVE_VERIFIER_LOG_FILE}`,
  );
}

export function mergeSemanticParamVerification(
  mechanical: ParamVerification[],
  report: LiveVerificationReport,
): ParamVerification[] {
  const byName = new Map(mechanical.map((item) => [item.name, item]));
  for (const parameter of report.parameters) {
    const current = byName.get(parameter.name);
    byName.set(parameter.name, {
      ...current,
      name: parameter.name,
      verified: parameter.verdict === 'works',
      reason: parameter.verdict === 'works' ? undefined : 'semantic-gap',
    });
  }
  return [...byName.values()];
}
