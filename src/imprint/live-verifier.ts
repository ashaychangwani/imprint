import { type ChildProcess, spawn } from 'node:child_process';
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
import { loadBackendsCacheStatus } from './backend-cache.ts';
import { resolveWorkflowTool } from './backend-ladder.ts';
import { type ParamVerification, runBunTestWithResults } from './compile-tools.ts';
import {
  LIVE_EVIDENCE_PATH_ENV,
  LIVE_PREFERRED_BACKEND_ONLY_ENV,
  type LiveIntegrationEvidence,
  readLiveIntegrationEvidence,
  runCapturedIntegrationCase,
} from './compile-verification.ts';
import { redactFreeformText } from './freeform-redact.ts';
import {
  type ProviderName,
  isToolUseProvider,
  preferredVerificationModel,
  resolveProvider,
} from './llm.ts';
import {
  canRebindBackendsCacheToWorkflow,
  type probeResolvedTool,
  rebindBackendsCacheToWorkflow,
} from './probe-backends.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { loadCredentialStore } from './runtime.ts';
import { isSensitiveKey } from './sensitive-keys.ts';
import { buildZodValidator } from './tool-loader.ts';
import { type BackendsCache, type ConcreteBackend, WorkflowSchema } from './types.ts';

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
const MAX_CREDITED_BACKEND_PREPARATIONS = 2;
const BACKEND_PROBE_SHUTDOWN_GRACE_MS = 5_000;
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
    (item) => item.kind === 'suite' && item.verifierSession === sessionLabel,
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

export async function prepareLiveVerificationBackend(opts: {
  workflowPath: string;
  params: Record<string, string | number | boolean>;
  reason: string;
  forceReprobe?: boolean;
  logPath?: string;
  attempt?: number;
  probe?: typeof probeResolvedTool;
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
    const message = error instanceof Error ? error.message : String(error);
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
        error: message,
        durationMs,
      },
    ]);
    appendLiveVerifierLog(opts.logPath, {
      type: 'backend.prepare.failed',
      attempt: opts.attempt,
      label,
      error: message,
      durationMs,
    });
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
}): Promise<Awaited<ReturnType<typeof probeResolvedTool>>> {
  const previousCacheContents = existsSync(opts.outPath)
    ? readFileSync(opts.outPath, 'utf8')
    : undefined;
  const tool = resolveWorkflowTool(opts.workflowPath);
  const assetRoot = pathJoin(tool.dir, '..', '..');
  const child = spawn(
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
  const unregisterParentCleanup = registerOwnedProcessTreeCleanup(child);
  child.stdin?.end(JSON.stringify(opts.params));

  let stderr = '';
  const logChunk = (stream: 'stdout' | 'stderr', raw: unknown): void => {
    const chunk = redactFreeformText(boundedTail(String(raw), 4_000)).redacted;
    if (stream === 'stderr') stderr = boundedTail(`${stderr}${chunk}`, 8_000);
    appendLiveVerifierLog(opts.logPath, {
      type: 'backend.probe.progress',
      attempt: opts.attempt,
      label: opts.label,
      stream,
      chunk,
    });
  };
  child.stdout?.on('data', (chunk) => logChunk('stdout', chunk));
  child.stderr?.on('data', (chunk) => logChunk('stderr', chunk));

  let outcome: Awaited<ReturnType<typeof waitForOwnedProcessTree>>;
  try {
    outcome = await waitForOwnedProcessTree(
      child,
      BACKEND_PREPARATION_BUDGET_MS,
      BACKEND_PROBE_SHUTDOWN_GRACE_MS,
    );
  } finally {
    unregisterParentCleanup();
  }
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
    throw new Error(
      `backend probe exited ${outcome.exitCode}${stderr ? `: ${stderr.slice(-2_000)}` : ''}`,
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

interface LiveSemanticVerificationResult {
  report: LiveVerificationReport;
  provider: ProviderName;
  model: string;
  attempts: number;
}

export async function runLiveSemanticVerification(opts: {
  provider: ProviderName;
  toolDir: string;
  evidence: LiveIntegrationEvidence[];
  deadlineMs?: number;
}): Promise<LiveSemanticVerificationResult> {
  const workflowPath = pathJoin(opts.toolDir, 'workflow.json');
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(workflowPath, 'utf8')));
  const model = preferredVerificationModel(opts.provider);
  const reportPath = pathJoin(opts.toolDir, '.live-verification.json');
  const evidencePath = pathJoin(opts.toolDir, LIVE_VERIFICATION_EVIDENCE_FILE);
  const logPath = pathJoin(opts.toolDir, LIVE_VERIFIER_LOG_FILE);
  const verifierSessionLabel = nextRecordLabel(evidencePath, 'verifier-session');
  const sessionStartedAtMs = Date.now();
  const sessionStartedAt = new Date(sessionStartedAtMs).toISOString();
  const preparationBudget = { creditedCount: 0, creditMs: 0, grantedMs: 0 };
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
  // Verification gets its own reasoning window. Backend preparation is added
  // separately below and both attempts share this one absolute deadline.
  const verifierDeadlineMs = opts.deadlineMs ?? Date.now() + 10 * 60_000;

  persistLiveVerificationEvidence(evidencePath, accumulated);
  appendLiveVerifierLog(logPath, {
    type: 'verifier.session.started',
    session: verifierSessionLabel,
    provider: opts.provider,
    model,
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
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
              deadlineMs: verifierDeadlineMs,
              preparationBudget,
              logPath,
              attempt,
              sessionLabel: verifierSessionLabel,
            })
          : await runCliVerifier({
              provider: opts.provider,
              workflowPath,
              reportPath,
              initialMessage: retryMessage,
              model,
              deadlineMs: verifierDeadlineMs,
              logSinceMs: sessionStartedAtMs,
              logPath,
              attempt,
              sessionLabel: verifierSessionLabel,
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
      };
    } catch (error) {
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
    attempts: 2,
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
    attempts: 2,
  });
  return { report: inconclusive, provider: opts.provider, model, attempts: 2 };
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
      baselineEvidence: evidence,
    },
    null,
    2,
  )}`;
}

function creditBackendPreparation(
  budget: { creditedCount: number; creditMs: number },
  durationMs: number,
  reusedCache: boolean,
): void {
  if (reusedCache || budget.creditedCount >= MAX_CREDITED_BACKEND_PREPARATIONS) return;
  budget.creditedCount++;
  budget.creditMs += Math.min(Math.max(0, durationMs), BACKEND_PREPARATION_BUDGET_MS);
}

async function runAnthropicVerifier(opts: {
  workflowPath: string;
  reportPath: string;
  initialMessage: string;
  model: string;
  deadlineMs?: number;
  logPath: string;
  attempt: number;
  sessionLabel: string;
  preparationBudget: { creditedCount: number; creditMs: number; grantedMs: number };
}): Promise<LiveVerificationReport> {
  const provider = resolveProvider({
    provider: 'anthropic-api',
    model: opts.model,
  });
  if (!isToolUseProvider(provider)) throw new Error('Anthropic provider lacks tool use');
  const workflow = WorkflowSchema.parse(JSON.parse(readFileSync(opts.workflowPath, 'utf8')));
  const validator = buildZodValidator(workflow.parameters);
  const credentials = (await loadCredentialStore(workflow.site)) ?? undefined;
  let submitted: LiveVerificationReport | undefined;
  let loggedConversationEntries = 0;
  const evidencePath = pathJoin(dirname(opts.reportPath), LIVE_VERIFICATION_EVIDENCE_FILE);
  const hasSuiteReceipt = (): boolean => hasSuiteReceiptForSession(evidencePath, opts.sessionLabel);

  const tools: AgentTool[] = [
    {
      name: 'prepare_live_backend',
      description:
        'Reuse the current preferred backend, probing only when no valid preference exists. Set forceReprobe only after the preferred backend fails because of a transport, network, or browser-infrastructure error; semantic output failures must go back to the compiler without reprobe.',
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
        const startedAt = Date.now();
        try {
          const result = await prepareLiveVerificationBackend({
            workflowPath: opts.workflowPath,
            params: parsed.data as Record<string, string | number | boolean>,
            reason: input.reason,
            forceReprobe: input.forceReprobe === true,
            logPath: opts.logPath,
            attempt: opts.attempt,
          });
          creditBackendPreparation(opts.preparationBudget, result.durationMs, result.reusedCache);
          return { result: JSON.stringify(result) };
        } catch (error) {
          creditBackendPreparation(opts.preparationBudget, Date.now() - startedAt, false);
          return {
            result: error instanceof Error ? error.message : String(error),
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
          });
          return { result: JSON.stringify(suite) };
        } catch (error) {
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
            credentials,
            preferredOnlyBackend: true,
          });
        } catch (error) {
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
  const result = await runAgentLoop({
    systemPrompt: readFileSync(SYSTEM_PROMPT_PATH, 'utf8'),
    initialUserMessage: opts.initialMessage,
    tools,
    deadlineMs: opts.deadlineMs ?? Date.now() + 10 * 60_000,
    softTurnCap: 12,
    llm: provider,
    onDeadlineReached: async () => {
      const extensionMs = opts.preparationBudget.creditMs - opts.preparationBudget.grantedMs;
      if (extensionMs <= 0) return null;
      opts.preparationBudget.grantedMs += extensionMs;
      return extensionMs;
    },
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
}

async function runCliVerifier(opts: {
  provider: ProviderName;
  workflowPath: string;
  reportPath: string;
  initialMessage: string;
  model: string;
  deadlineMs?: number;
  logPath: string;
  attempt: number;
  sessionLabel: string;
  logSinceMs: number;
}): Promise<LiveVerificationReport> {
  if (opts.provider !== 'codex-cli' && opts.provider !== 'claude-cli') {
    throw new Error(`CLI verifier is unsupported for ${opts.provider}`);
  }
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
  const child =
    opts.provider === 'codex-cli'
      ? spawnCodexVerifier(opts, mcpArgs)
      : spawnClaudeVerifier(opts, mcpArgs);
  const unregisterParentCleanup = registerOwnedProcessTreeCleanup(child);
  const deadlineMs = opts.deadlineMs ?? Date.now() + 10 * 60_000;
  let exitCode: number | null;
  let stderr: string;
  try {
    ({ exitCode, stderr } = await waitForChild(
      child,
      deadlineMs,
      opts.logPath,
      opts.attempt,
      opts.logSinceMs,
    ));
  } finally {
    unregisterParentCleanup();
  }
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
}

function spawnCodexVerifier(
  opts: { initialMessage: string; model: string },
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
  const child = spawn('codex', args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(
    `<system_instructions>\n${readFileSync(SYSTEM_PROMPT_PATH, 'utf8')}\n</system_instructions>\n\n${opts.initialMessage}`,
  );
  return child;
}

function spawnClaudeVerifier(
  opts: { initialMessage: string; model: string },
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
  return spawn('claude', args, {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForChild(
  child: ChildProcess,
  deadlineMs: number,
  logPath: string,
  attempt: number,
  logSinceMs: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  let stderr = '';
  // Always drain both pipes. CLI JSON streams can exceed the OS pipe buffer;
  // leaving stdout unread would deadlock an otherwise completed verifier.
  child.stdout?.on('data', (chunk) => {
    appendLiveVerifierLog(logPath, {
      type: 'provider.stdout',
      attempt,
      chunk: boundedTail(String(chunk), 8_000),
    });
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8000);
    appendLiveVerifierLog(logPath, {
      type: 'provider.stderr',
      attempt,
      chunk: boundedTail(String(chunk), 8_000),
    });
  });
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const timeOut = (): void => {
      timedOut = true;
      const preparationCreditMs = backendPreparationDeadlineCreditMs(
        logPath,
        logSinceMs,
        Date.now(),
      );
      appendLiveVerifierLog(logPath, {
        type: 'provider.timeout',
        attempt,
        deadlineMs,
        preparationCreditMs,
      });
      signalVerifierProcessTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        signalVerifierProcessTree(child, 'SIGKILL');
        reject(new Error('semantic verifier timed out'));
      }, 5_000);
      forceTimer.unref?.();
    };
    const checkDeadline = (): void => {
      const now = Date.now();
      const preparationCreditMs = backendPreparationDeadlineCreditMs(logPath, logSinceMs, now);
      const remainingMs = deadlineMs + preparationCreditMs - now;
      if (remainingMs <= 0) {
        timeOut();
        return;
      }
      // Recheck periodically because preparation activity is written by the
      // verifier MCP subprocess while this parent is waiting on the CLI.
      deadlineTimer = setTimeout(checkDeadline, Math.min(remainingMs, 500));
      deadlineTimer.unref?.();
    };
    checkDeadline();
    child.once('error', (error) => {
      clearTimers();
      signalVerifierProcessTree(child, 'SIGKILL');
      reject(error);
    });
    child.once('close', (code) => {
      clearTimers();
      // Codex/Claude can exit while an MCP tool call is still in flight. Their
      // stdio MCP child (and a Chrome it launched) remains in the detached
      // verifier process group unless we explicitly reap the group here. A
      // retry must never start a second probe beside an orphaned first probe.
      signalVerifierProcessTree(child, 'SIGKILL');
      appendLiveVerifierLog(logPath, {
        type: 'provider.closed',
        attempt,
        exitCode: code,
      });
      if (timedOut) reject(new Error('semantic verifier timed out'));
      else resolve({ exitCode: code, stderr });
    });
  });
}

export function backendPreparationDeadlineCreditMs(
  logPath: string,
  sinceMs: number,
  nowMs = Date.now(),
): number {
  if (!existsSync(logPath)) return 0;
  const preparations = new Map<
    string,
    { startedAtMs: number; durationMs?: number; reusedCache?: boolean }
  >();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // The append-only log can end in a partial line while the MCP process is writing.
      continue;
    }
    const timestampMs =
      typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
    if (!Number.isFinite(timestampMs) || timestampMs < sinceMs || typeof event.label !== 'string') {
      continue;
    }
    if (event.type === 'backend.prepare.started') {
      preparations.set(event.label, { startedAtMs: timestampMs });
      continue;
    }
    if (event.type !== 'backend.prepare.completed' && event.type !== 'backend.prepare.failed') {
      continue;
    }
    const preparation = preparations.get(event.label);
    if (!preparation) continue;
    preparation.durationMs =
      typeof event.durationMs === 'number'
        ? event.durationMs
        : Math.max(0, timestampMs - preparation.startedAtMs);
    preparation.reusedCache = event.reusedCache === true;
  }

  return [...preparations.values()]
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
    .filter((preparation) => !preparation.reusedCache)
    .slice(0, MAX_CREDITED_BACKEND_PREPARATIONS)
    .reduce(
      (total, preparation) =>
        total +
        Math.min(
          Math.max(0, preparation.durationMs ?? nowMs - preparation.startedAtMs),
          BACKEND_PREPARATION_BUDGET_MS,
        ),
      0,
    );
}

export async function waitForOwnedProcessTree(
  child: ChildProcess,
  timeoutMs: number,
  shutdownGraceMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: {
      exitCode: number | null;
      timedOut: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      signalVerifierProcessTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        signalVerifierProcessTree(child, 'SIGKILL');
        finish({ exitCode: child.exitCode, timedOut: true });
      }, shutdownGraceMs);
      forceTimer.unref?.();
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code) => {
      const timedOut = forceTimer !== undefined;
      // Reap any browser/crashpad descendants that survived the worker itself.
      signalVerifierProcessTree(child, timedOut ? 'SIGKILL' : 'SIGTERM');
      finish({ exitCode: code, timedOut });
    });
  });
}

export function registerOwnedProcessTreeCleanup(
  child: ChildProcess,
  shutdownGraceMs = BACKEND_PROBE_SHUTDOWN_GRACE_MS,
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const onExit = (): void => signalVerifierProcessTree(child, 'SIGKILL');
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const forceTimers = new Set<ReturnType<typeof setTimeout>>();
  let shutdownRequested = false;
  const hadExistingHandler = new Map(
    signals.map((signal) => [signal, process.listenerCount(signal) > 0]),
  );
  const unregisterSignals = (): void => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };
  const unregister = (): void => {
    unregisterSignals();
    // Once parent shutdown has begun, the direct worker can exit before a
    // browser or other detached descendant in its process group. Preserve the
    // scheduled escalation and exit fallback in that case. Normal completion
    // still removes every listener and timer immediately.
    if (shutdownRequested) return;
    process.removeListener('exit', onExit);
    for (const timer of forceTimers) clearTimeout(timer);
    forceTimers.clear();
  };
  process.once('exit', onExit);
  for (const signal of signals) {
    const handler = (): void => {
      shutdownRequested = true;
      unregisterSignals();
      signalVerifierProcessTree(child, signal);
      const forceTimer = setTimeout(() => {
        forceTimers.delete(forceTimer);
        signalVerifierProcessTree(child, 'SIGKILL');
        if (forceTimers.size === 0) process.removeListener('exit', onExit);
      }, shutdownGraceMs);
      forceTimers.add(forceTimer);
      forceTimer.unref?.();
      // Let an existing teach/compile signal handler perform its own graceful
      // shutdown. If this verifier is running standalone, restore the default
      // behavior so installing cleanup does not accidentally swallow SIGINT.
      if (!hadExistingHandler.get(signal)) process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  return unregister;
}

function signalVerifierProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  child.kill(signal);
}

export function semanticVerificationFailures(report: LiveVerificationReport): string[] {
  if (report.status === 'approved' || report.status === 'approved_with_gaps') return [];
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
