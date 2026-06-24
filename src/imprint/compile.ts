/**
 * One recording compiles to two artifacts: workflow.json (API-replay)
 * and playbook.yaml (DOM-replay). Both share the same skeleton —
 * read session, redact-if-needed, slim, call LLM, parse, validate,
 * write next to the session — so they live in one file with the
 * differences (slim strategy, prompt, parser, schema, output filename)
 * factored into a CompileTask config.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import type { OnDeadlineReached } from './agent.ts';
import { inferAppApiHosts } from './app-api-hosts.ts';
import type { SharedModuleManifestEntry } from './build-plan.ts';
import { type CompileAgentProgress, compileAgent } from './compile-agent.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { type LLMOptions, extractJsonArray, resolveProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { imprintHomeDir, localSiteDir, localToolDir } from './paths.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { redactSession } from './redact.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import type { ClassifiedValue } from './session-diff.ts';
import { isTelemetryRequest } from './telemetry.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import {
  type Playbook,
  type Session,
  SessionSchema,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

export type { CompileAgentProgress } from './compile-agent.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const log = createLog('compile');

interface CompileOptions {
  /** Path to session.json or session.redacted.json */
  sessionPath: string;
  /** Where to write the artifact. Defaults to the generated tool directory. */
  outPath?: string;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** If true, send the FULL session to the LLM (don't shrink). Useful for
   *  debugging when shrinking might be over-aggressive. Default false. */
  noShrink?: boolean;
  /** Candidate-specific compile scope for multi-tool teach. */
  candidate?: ToolCandidate;
  /** Shared auth/helper guidance generated once for a multi-tool teach run. */
  sharedContext?: SharedCompileContext;
  /** Pre-computed triage result from a shared pass. When set, compilePlaybook
   *  skips its own triageRequests() LLM call and merges the shared selectedSeqs
   *  with any per-tool preserveSeqs locally. */
  preTriagedSession?: TriageResult;
}

// ─── generate (workflow.json) ────────────────────────────────────────────────

interface GenerateOptions extends CompileOptions {
  /** Hard wall-clock budget for the agent. Default 30 minutes. */
  maxDurationMs?: number;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  /** Retain parser.test.ts after successful verification. */
  keepTest?: boolean;
  /** Directory where workflow.json/parser.ts/parser.test.ts are written. */
  outDir?: string;
  /** Dual-pass value classifications from replay-and-diff. */
  classifications?: ClassifiedValue[];
  /** Credential values extracted during teach, passed to integration tests via env var. */
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Per-tool implementation plan (param→field mapping, request construction,
   *  response parsing, shared-module imports). Injected into the agent's initial
   *  message so the compile follows it. */
  toolPlan?: string;
}

interface GenerateResult {
  workflow: Workflow;
  workflowPath: string;
  /** Number of requests the LLM saw (after shrinking). */
  requestsSent: number;
  /** Original count before shrinking. */
  requestsOriginal: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  return await traced(
    'compile.generate',
    'AGENT',
    {
      'imprint.session_path': opts.sessionPath,
      'imprint.provider': opts.llmConfig?.provider ?? 'auto',
      'imprint.tool_name': opts.candidate?.toolName,
      'imprint.out_path': opts.outPath,
      'imprint.out_dir': opts.outDir,
    },
    async (span) => {
      ensureImprintRuntimeLink(imprintHomeDir());
      const outDir = opts.outDir ?? (opts.outPath ? dirname(opts.outPath) : undefined);
      const result = await compileAgent({
        sessionPath: opts.sessionPath,
        maxDurationMs: opts.maxDurationMs,
        llmConfig: opts.llmConfig,
        onProgress: opts.onProgress,
        onDeadlineReached: opts.onDeadlineReached,
        keepTest: opts.keepTest,
        outDir,
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
        classifications: opts.classifications,
        teachCredentials: opts.teachCredentials,
        buildPlanPath: opts.buildPlanPath,
        sharedModules: opts.sharedModules,
        toolPlan: opts.toolPlan,
      });

      setSpanAttributes(span, {
        'imprint.compile.outcome': result.outcome,
        'imprint.compile.turns': result.turns,
        'imprint.compile.duration_ms': result.durationMs,
        'imprint.compile.input_tokens': result.inputTokens,
        'imprint.compile.output_tokens': result.outputTokens,
        'imprint.compile.cache_read_input_tokens': result.cacheReadInputTokens,
        'imprint.compile.cache_creation_input_tokens': result.cacheCreationInputTokens,
        'imprint.compile.conversation_log': result.conversationLogPath,
      });

      if (!result.success) {
        const lines = [
          'compile agent did not produce a verified workflow.',
          `outcome: ${result.outcome}`,
          `message: ${result.message}`,
          `turns: ${result.turns}, duration: ${(result.durationMs / 1000).toFixed(1)}s`,
          `conversation log: ${result.conversationLogPath}`,
        ];
        if (result.outcome === 'timeout') {
          lines.push(
            'hint: most complex tools take 10-15 minutes. increase the timeout with --timeout (teach) or --max-duration (generate)',
          );
        }
        throw new Error(lines.join('\n'));
      }

      // Load the agent-written workflow.json from disk and validate.
      if (!result.workflowPath) {
        throw new Error('compile agent reported success but no workflowPath');
      }
      const workflow = loadJsonFile(
        result.workflowPath,
        WorkflowSchema,
        {
          notFound: 'compile agent reported success but workflow.json missing',
          badSchema: 'compile agent wrote an invalid workflow.json',
        },
        'workflow',
      );
      let workflowPath = opts.outPath ?? result.workflowPath;
      if (!opts.outDir && !opts.outPath) {
        workflowPath = relocateGeneratedWorkflow(result.workflowPath, workflow);
      }
      if (opts.outPath && opts.outPath !== result.workflowPath) {
        writeFileSync(opts.outPath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
      }

      setSpanAttributes(span, {
        'imprint.workflow_path': workflowPath,
        'imprint.workflow_tool_name': workflow.toolName,
      });

      return {
        workflow,
        workflowPath,
        requestsSent: 0, // legacy field — no longer meaningful for agentic compile
        requestsOriginal: 0, // legacy field
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
      };
    },
  );
}

function relocateGeneratedWorkflow(workflowPath: string, workflow: Workflow): string {
  const sourceDir = dirname(workflowPath);
  const finalDir = localToolDir(workflow.site, workflow.toolName);
  if (sourceDir === finalDir) return workflowPath;
  mkdirSync(finalDir, { recursive: true });
  for (const artifact of [
    'workflow.json',
    'parser.ts',
    'parser.test.ts',
    '.compile-log.json',
    '.compile-done.json',
    '.compile-give-up.json',
  ]) {
    const source = pathJoin(sourceDir, artifact);
    if (!existsSync(source)) continue;
    renameSync(source, pathJoin(finalDir, artifact));
  }
  return pathJoin(finalDir, 'workflow.json');
}

/**
 * Drop request noise before sending to the LLM. Modern SPAs load 500-1000
 * requests per page, 80% of which are JS bundles, ad pixels, third-party
 * trackers, and font/image assets. Without aggressive shrinking the
 * redacted session easily blows past 10M tokens.
 *
 * Two rules:
 *   1. Same-origin only. Anything not under the start URL's root domain
 *      is presumed third-party noise. Workflows that legitimately call
 *      out to a different domain (e.g., a login redirect to an SSO
 *      provider) should pass `--no-shrink`.
 *   2. Drop NOISE_RESOURCE_TYPES. Scripts and assets balloon the prompt
 *      without informing codegen — what matters is the API surface
 *      (XHR/Fetch/Document), not the JS that drove it.
 *
 * Net effect on Southwest: 813 → 34 requests, 6.5M → 0.3M tokens.
 */
export function shrinkSession(session: Session): Session {
  const startUrl = safeUrl(session.url);
  const startRoot = startUrl ? registrableDomain(startUrl.hostname) : null;
  const appApiHosts = inferAppApiHosts(session, startRoot);

  const NOISE_RESOURCE_TYPES = new Set([
    'Image',
    'Font',
    'Stylesheet',
    'Media',
    'Manifest',
    'Other',
    'Script', // JS bundles — huge and never load-bearing for codegen
    'Ping', // beacons — by definition fire-and-forget telemetry
    'Preflight', // CORS preflights — runtime replays them automatically
  ]);

  const shrunkRequests = session.requests.filter((r) => {
    const url = safeUrl(r.url);
    if (!url) return false;
    if (NOISE_RESOURCE_TYPES.has(r.resourceType)) return false;
    if (
      startRoot &&
      !isSameRegistrableDomain(url.hostname, startRoot) &&
      !appApiHosts.has(url.hostname)
    )
      return false;
    return true;
  });

  return { ...session, requests: shrunkRequests };
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

// ─── Credential-bearing request detection ───────────────────────────────────

const CREDENTIAL_PLACEHOLDER_RE = /\$\{credential\.[^}]+\}/;

export function findCredentialBearingSeqs(session: Session): number[] {
  const seqs: number[] = [];
  for (const r of session.requests) {
    const text = `${r.url}\n${JSON.stringify(r.headers)}\n${r.body ?? ''}`;
    if (CREDENTIAL_PLACEHOLDER_RE.test(text)) seqs.push(r.seq);
  }
  return seqs;
}

// ─── Auth-adjacent request detection (2FA/MFA/OTP) ──────────────────────────

const AUTH_ADJACENT_WINDOW_MS = 120_000;
const MFA_PATTERN =
  /mfa|2fa|two.?factor|otp|verify|verification|challenge|push.?notification|authenticate|oauth|token|trusted.?device|security.?code/i;

/** Find requests that are temporally and semantically adjacent to credential-
 *  bearing login POSTs — 2FA triggers, status polls, OTP submits, OAuth
 *  exchanges, trusted-device registrations. These must survive triage so
 *  detect-candidates can classify the 2FA type. */
export function findAuthAdjacentSeqs(session: Session, credentialSeqs: number[]): number[] {
  if (credentialSeqs.length === 0) return [];
  const credSet = new Set(credentialSeqs);
  const lastCredTs = Math.max(
    ...credentialSeqs.map((s) => session.requests.find((r) => r.seq === s)?.timestamp ?? 0),
  );
  if (lastCredTs === 0) return [];

  const seqs: number[] = [];
  for (const r of session.requests) {
    if (credSet.has(r.seq)) continue;
    if (r.timestamp < lastCredTs) continue;
    if (r.timestamp > lastCredTs + AUTH_ADJACENT_WINDOW_MS) break;
    const text = `${r.url}\n${r.body ?? ''}`;
    if (MFA_PATTERN.test(text)) seqs.push(r.seq);
  }
  return seqs;
}

// ─── triageRequests (LLM-based request filtering) ───────────────────────────

const TRIAGE_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'Document']);
const HEADER_TRUNCATE_LIMIT = 200;
// Per-request body cap for triage. Triage only needs enough body to distinguish
// data-bearing POSTs (search/booking) from telemetry; full bodies on a busy
// site can total >1MB and blow the 200K-token cap on `claude-opus-4-8`.
const TRIAGE_BODY_LIMIT = 500;
const TRIAGE_ACTION_ALIGNMENT_BEFORE_MS = 1000;
const TRIAGE_ACTION_ALIGNMENT_AFTER_MS = 5000;
const TRIAGE_CONTEXT_EVENT_TYPES = new Set<Session['events'][number]['type']>([
  'navigation',
  'click',
  'input',
  'change',
  'submit',
]);
const TRIAGE_ACTION_EVENT_TYPES = new Set<Session['events'][number]['type']>([
  'input',
  'change',
  'submit',
]);

export interface TriageResult {
  session: Session;
  selectedSeqs: number[];
  consideredCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

interface TriageRequestContext {
  seq: number;
  timestamp: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  mimeType?: string;
  headers: string;
  body?: string;
  bodyDigest?: string;
  bodyLength?: number;
  responseBodyDigest?: string;
  responseBodyLength?: number;
  repeatCount?: number;
  repeatedSeqs?: number[];
  lastTimestamp?: number;
}

interface TriageEventContext {
  seq: number;
  timestamp: number;
  type: Session['events'][number]['type'];
  detail: string;
}

export async function triageRequests(
  session: Session,
  llmConfig?: LLMOptions,
  context: Pick<CompileOptions, 'candidate' | 'sharedContext'> = {},
): Promise<TriageResult> {
  const preserveSeqs = new Set([
    ...(context.candidate?.requestSeqs ?? []),
    ...(context.candidate?.dependencySeqs ?? []),
    ...(context.sharedContext?.loginRequestSeqs ?? []),
  ]);
  const candidates = session.requests.filter(
    (r) => TRIAGE_RESOURCE_TYPES.has(r.resourceType) || preserveSeqs.has(r.seq),
  );

  return await traced(
    'compile.triage_requests',
    'RETRIEVER',
    {
      'imprint.site': session.site,
      'imprint.requests_total': session.requests.length,
      'imprint.requests_considered': candidates.length,
      'imprint.provider': llmConfig?.provider ?? 'auto',
    },
    async (span) => {
      const compacted = compactRequestContexts(
        candidates.map((r) => ({
          seq: r.seq,
          timestamp: r.timestamp,
          method: r.method,
          url: r.url,
          resourceType: r.resourceType,
          status: r.response?.status,
          mimeType: r.response?.mimeType,
          headers: truncateHeaders(r.headers),
          body: truncate(r.body, TRIAGE_BODY_LIMIT),
          bodyDigest: requestContextDigest(r.body),
          bodyLength: r.body?.length,
          responseBodyDigest: requestContextDigest(r.response?.body),
          responseBodyLength: r.response?.body?.length,
        })),
        triageRequestGroupKey,
        { preserveSeqs },
      );
      // Strip digest/length fields the LLM doesn't use — they served compaction only
      const metadata = compacted.map(
        ({ bodyDigest, responseBodyDigest, bodyLength, responseBodyLength, ...rest }) => rest,
      );

      const triagePayload = {
        site: session.site,
        url: session.url,
        narration: session.narration,
        events: buildTriageEventContexts(session),
        requests: metadata,
      };

      const promptPath = pathJoin(PROMPTS_DIR, 'request-triage.md');
      if (!existsSync(promptPath)) {
        throw new Error(
          `Triage prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
        );
      }
      const systemPrompt = readFileSync(promptPath, 'utf8');

      log(
        `triaging ${metadata.length} compacted requests (from ${candidates.length} candidates / ${session.requests.length} total)…`,
      );
      const llm = resolveProvider(llmConfig ?? {});
      const result = await llm.analyze(systemPrompt, triagePayload);

      const arrayText = extractJsonArray(result.text);
      if (!arrayText) {
        throw new Error(
          `Triage LLM did not return a JSON array.\nRaw response:\n${result.text.slice(0, 1000)}`,
        );
      }

      let seqs: unknown;
      try {
        seqs = JSON.parse(arrayText);
      } catch (err) {
        throw new Error(
          `Triage response was not valid JSON: ${err instanceof Error ? err.message : String(err)}\nExtracted:\n${arrayText.slice(0, 500)}`,
        );
      }

      if (!Array.isArray(seqs) || !seqs.every((s) => typeof s === 'number')) {
        throw new Error(
          `Triage response is not an array of numbers.\nParsed: ${JSON.stringify(seqs).slice(0, 500)}`,
        );
      }

      const rescuedSeqs = rescueActionAlignedRepeatedSeqs(session, seqs as number[], compacted);
      const selectedSet = new Set([...(seqs as number[]), ...rescuedSeqs, ...preserveSeqs]);
      const triaged: Session = {
        ...session,
        requests: session.requests.filter((r) => selectedSet.has(r.seq)),
      };

      log(`triage selected ${selectedSet.size} requests out of ${candidates.length} candidates`);

      setSpanAttributes(span, {
        'imprint.requests_compacted': metadata.length,
        'imprint.requests_selected': selectedSet.size,
        'imprint.triage.duration_ms': result.durationMs,
        'imprint.triage.input_tokens': result.inputTokens,
        'imprint.triage.output_tokens': result.outputTokens,
      });

      return {
        session: triaged,
        selectedSeqs: [...selectedSet],
        consideredCount: candidates.length,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
      };
    },
  );
}

export function buildTriageEventContexts(session: Session): TriageEventContext[] {
  return session.events
    .filter((event) => TRIAGE_CONTEXT_EVENT_TYPES.has(event.type))
    .map((event) => ({
      seq: event.seq,
      timestamp: event.timestamp,
      type: event.type,
      detail: truncate(event.detail, TRIAGE_BODY_LIMIT) ?? '',
    }));
}

export function rescueActionAlignedRepeatedSeqs(
  session: Session,
  selectedSeqs: Iterable<number>,
  compactedRequests: TriageRequestContext[],
): number[] {
  const selectedSet = new Set(selectedSeqs);
  const requestBySeq = new Map(session.requests.map((request) => [request.seq, request]));
  const actionTimestamps = session.events
    .filter((event) => TRIAGE_ACTION_EVENT_TYPES.has(event.type))
    .map((event) => event.timestamp);
  if (actionTimestamps.length === 0) return [];

  const rescued = new Set<number>();
  for (const request of compactedRequests) {
    const repeatedSeqs = request.repeatedSeqs ?? [];
    if (repeatedSeqs.length === 0) continue;
    if (!selectedSet.has(request.seq) && !repeatedSeqs.some((seq) => selectedSet.has(seq))) {
      continue;
    }

    for (const seq of repeatedSeqs) {
      if (selectedSet.has(seq)) continue;
      const original = requestBySeq.get(seq);
      if (!original) continue;
      if (!isTriageRescueCandidate(original)) continue;
      if (!isNearActionEvent(original.timestamp, actionTimestamps)) continue;
      rescued.add(seq);
    }
  }

  return [...rescued].sort((a, b) => a - b);
}

function isTriageRescueCandidate(request: Session['requests'][number]): boolean {
  if (request.resourceType !== 'XHR' && request.resourceType !== 'Fetch') return false;
  return !isTelemetryRequest(request);
}

function isNearActionEvent(timestamp: number, actionTimestamps: number[]): boolean {
  return actionTimestamps.some(
    (eventTimestamp) =>
      timestamp >= eventTimestamp - TRIAGE_ACTION_ALIGNMENT_BEFORE_MS &&
      timestamp <= eventTimestamp + TRIAGE_ACTION_ALIGNMENT_AFTER_MS,
  );
}

function triageRequestGroupKey(request: TriageRequestContext): unknown[] {
  let urlKey: string = request.url;
  let paramSignature = '';
  try {
    const parsed = new URL(request.url);
    urlKey = `${parsed.hostname}${parsed.pathname}`;
    // Include sorted query parameter names so requests with different
    // parameter signatures are grouped separately (e.g., a config fetch
    // vs a lookup endpoint that shares the same pathname but adds a
    // filter/query param). Cap at 10 params — URLs with more are
    // typically analytics/telemetry where slight param-set variation
    // should not prevent compaction.
    const paramNames = [...new Set(parsed.searchParams.keys())].sort();
    if (paramNames.length > 0 && paramNames.length <= 10) {
      paramSignature = paramNames.join(',');
    }
  } catch {
    // keep full url as fallback
  }
  return [
    request.method,
    urlKey,
    paramSignature,
    request.resourceType,
    request.status,
    request.mimeType,
    request.bodyDigest,
  ];
}

function truncateHeaders(headers: Record<string, string>): string {
  const serialized = JSON.stringify(headers);
  if (serialized.length <= HEADER_TRUNCATE_LIMIT) return serialized;
  return `${serialized.slice(0, HEADER_TRUNCATE_LIMIT)}…`;
}

// ─── compilePlaybook (playbook.yaml) ─────────────────────────────────────────

interface CompilePlaybookResult {
  playbook: Playbook;
  playbookPath: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

const RESPONSE_BODY_LIMIT = 4000;

export function defaultCompilePlaybookPath(site: string, toolName: string): string {
  return pathJoin(localToolDir(site, toolName), 'playbook.yaml');
}

export function resolveDefaultCompilePlaybookPath(site: string, playbookToolName: string): string {
  const toolNames = existingWorkflowToolNames(site);
  if (toolNames.length === 0 || toolNames.includes(playbookToolName)) {
    return defaultCompilePlaybookPath(site, playbookToolName);
  }
  if (toolNames.length === 1) {
    const toolName = toolNames[0] ?? playbookToolName;
    throw new Error(
      [
        `compiled playbook toolName "${playbookToolName}" does not match the generated workflow "${toolName}" for site "${site}".`,
        `→ rerun compile-playbook with --out ${defaultCompilePlaybookPath(site, toolName)}`,
      ].join('\n'),
    );
  }
  throw new Error(
    [
      `compiled playbook toolName "${playbookToolName}" does not match any generated workflow for site "${site}".`,
      `Generated workflows: ${toolNames.join(', ')}`,
      `→ rerun compile-playbook with --out ~/.imprint/${site}/<toolName>/playbook.yaml`,
    ].join('\n'),
  );
}

function existingWorkflowToolNames(site: string): string[] {
  const siteDir = localSiteDir(site);
  if (!existsSync(siteDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(siteDir)) {
    const dir = pathJoin(siteDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(pathJoin(dir, 'workflow.json'))) out.push(entry);
  }
  return out.sort();
}

export async function compilePlaybook(opts: CompileOptions): Promise<CompilePlaybookResult> {
  return await traced(
    'compile.playbook',
    'CHAIN',
    {
      'imprint.session_path': opts.sessionPath,
      'imprint.provider': opts.llmConfig?.provider ?? 'auto',
      'imprint.tool_name': opts.candidate?.toolName,
      'imprint.out_path': opts.outPath,
      'imprint.no_shrink': opts.noShrink ?? false,
    },
    async (span) => {
      const result = await compilePlaybookImpl(opts);
      setSpanAttributes(span, {
        'imprint.playbook_path': result.playbookPath,
        'imprint.playbook_tool_name': result.playbook.toolName,
        'imprint.playbook.duration_ms': result.durationMs,
        'imprint.playbook.input_tokens': result.inputTokens,
        'imprint.playbook.output_tokens': result.outputTokens,
      });
      return result;
    },
  );
}

async function compilePlaybookImpl(opts: CompileOptions): Promise<CompilePlaybookResult> {
  // 1. Load session.
  let session: Session = loadJsonFile(
    opts.sessionPath,
    SessionSchema,
    {
      notFound: '→ run `imprint record <site>` to create one.',
      notJson: `→ if it's a partial .jsonl, run \`imprint assemble ${opts.sessionPath}\` first.`,
      badSchema: '→ check the file came from `imprint record`.',
    },
    'session',
  );

  // 2. Auto-redact if needed.
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const r = redactSession(session);
    session = r.session;
    if (r.stats.totalRedactions > 0) {
      const freeformNote =
        r.stats.freeformRedactions > 0
          ? ` (${r.stats.freeformRedactions} free-form finding(s))`
          : '';
      log(`redacted ${r.stats.totalRedactions} value(s)${freeformNote} before sending to LLM`);
    }
  }

  // 3. Triage: LLM selects which requests matter.
  let triageTokens: { input: number | null; output: number | null; durationMs: number } = {
    input: null,
    output: null,
    durationMs: 0,
  };
  if (opts.preTriagedSession && !opts.noShrink) {
    // Shared triage path: merge pre-computed seqs with candidate-specific preserveSeqs
    const preserveSeqs = new Set([
      ...(opts.candidate?.requestSeqs ?? []),
      ...(opts.candidate?.dependencySeqs ?? []),
      ...(opts.sharedContext?.loginRequestSeqs ?? []),
    ]);
    const finalSeqs = new Set([...opts.preTriagedSession.selectedSeqs, ...preserveSeqs]);
    session = {
      ...session,
      requests: session.requests.filter((r) => finalSeqs.has(r.seq)),
    };
    log('using shared triage result (skipping per-tool triage LLM call)');
    triageTokens = {
      input: opts.preTriagedSession.inputTokens,
      output: opts.preTriagedSession.outputTokens,
      durationMs: opts.preTriagedSession.durationMs,
    };
  } else if (!opts.noShrink) {
    const triage = await triageRequests(session, opts.llmConfig, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
    });
    session = triage.session;
    triageTokens = {
      input: triage.inputTokens,
      output: triage.outputTokens,
      durationMs: triage.durationMs,
    };
  }

  // 4. Build slim payload from triaged requests (with response bodies).
  const xhrs = session.requests
    .filter(
      (r) =>
        r.resourceType === 'XHR' || r.resourceType === 'Fetch' || r.resourceType === 'Document',
    )
    .map((r) => ({
      seq: r.seq,
      timestamp: r.timestamp,
      method: r.method,
      url: r.url,
      resourceType: r.resourceType,
      status: r.response?.status,
      response_body: truncate(r.response?.body, RESPONSE_BODY_LIMIT),
    }));

  log(
    `compiling playbook from ${session.events.length} events / ${xhrs.length} XHRs / ${session.narration.length} narration lines…`,
  );

  const slimmed = {
    site: session.site,
    url: session.url,
    candidate: opts.candidate,
    sharedContext: opts.sharedContext,
    narration: session.narration,
    events: session.events,
    requests: xhrs,
  };

  // 5. Main compilation LLM call.
  const promptPath = pathJoin(PROMPTS_DIR, 'playbook-compilation.md');
  if (!existsSync(promptPath)) {
    throw new Error(
      `Prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
    );
  }
  const systemPrompt = `${readFileSync(promptPath, 'utf8')}${
    opts.candidate
      ? `\n\nCandidate scope:\nCompile only this candidate: ${JSON.stringify(opts.candidate, null, 2)}\nShared context: ${JSON.stringify(opts.sharedContext ?? {}, null, 2)}\nThe playbook toolName and parameters must match the selected candidate/workflow, not any other action in the recording.\n`
      : ''
  }`;

  const llm = resolveProvider(opts.llmConfig ?? {});

  let playbook: Playbook | undefined;
  let lastResult = await llm.analyze(systemPrompt, slimmed);
  let llmInputTokens = lastResult.inputTokens;
  let llmOutputTokens = lastResult.outputTokens;
  let llmDurationMs = lastResult.durationMs;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      playbook = parsePlaybook(stripCodeFences(lastResult.text).trim());
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        log('playbook YAML failed to parse, retrying with error feedback…');
        const fixPrompt = `Your previous output was invalid YAML. The parser error was:\n\n${err instanceof Error ? err.message : String(err)}\n\nFix the YAML and return the corrected playbook. Output ONLY valid YAML, no prose.`;
        lastResult = await llm.analyze(systemPrompt, `${JSON.stringify(slimmed)}\n\n${fixPrompt}`);
        llmInputTokens = addNullable(llmInputTokens, lastResult.inputTokens);
        llmOutputTokens = addNullable(llmOutputTokens, lastResult.outputTokens);
        llmDurationMs += lastResult.durationMs;
      }
    }
  }
  if (lastErr) {
    throw new Error(
      `Compiled playbook failed to parse: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}\nRaw output:\n${lastResult.text.slice(0, 1500)}`,
    );
  }
  if (!playbook) {
    throw new Error('Playbook was not assigned after compile loop — this should not happen.');
  }

  if (opts.candidate && playbook.toolName !== opts.candidate.toolName) {
    throw new Error(
      `Compiled playbook toolName "${playbook.toolName}" does not match selected candidate "${opts.candidate.toolName}".`,
    );
  }

  const outPath =
    opts.outPath ?? resolveDefaultCompilePlaybookPath(session.site, playbook.toolName);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${stripCodeFences(lastResult.text).trim()}\n`);

  return {
    playbook,
    playbookPath: outPath,
    inputTokens: addNullable(triageTokens.input, llmInputTokens),
    outputTokens: addNullable(triageTokens.output, llmOutputTokens),
    durationMs: triageTokens.durationMs + llmDurationMs,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenced?.[1]) return fenced[1];
  return trimmed;
}
