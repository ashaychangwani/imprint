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
import type { CompileStrategyKind } from './compile-strategy.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { compactUrlForLlm } from './llm-url.ts';
import { type LLMOptions, extractJsonArray, extractJsonObject, resolveProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { imprintHomeDir, localSiteDir, localToolDir } from './paths.ts';
import { parsePlaybook } from './playbook-parser.ts';
import type { RunDeadlineRef } from './provider-retry.ts';
import { redactSession } from './redact.ts';
import { compactRequestContexts, requestContextDigest } from './request-context.ts';
import { ensureImprintRuntimeLink } from './runtime-link.ts';
import { isTelemetryRequest } from './telemetry.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import { applySharedTriageSelection } from './triage-selection.ts';
import {
  type Playbook,
  type Session,
  SessionSchema,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const log = createLog('compile');

interface CompileOptions {
  /** Path to session.json or session.redacted.json. */
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
  /** Authoritative, post-verification workflow contract. Playbook compilation
   *  uses this instead of re-inferring the public parameter surface from the
   *  recording candidate. */
  workflow?: Workflow;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
}

// ─── generate (workflow.json) ────────────────────────────────────────────────

interface GenerateOptions extends CompileOptions {
  /** Hard wall-clock budget for the agent. Default 30 minutes. */
  maxDurationMs?: number;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  /** Retain agent-generated tests after successful verification. */
  keepTest?: boolean;
  /** Directory where workflow.json/parser.ts/parser.test.ts are written. */
  outDir?: string;
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
  /** Master-accepted execution strategy for this focused compile. */
  strategyKind?: CompileStrategyKind;
  /** Bounded teach resume: revise the current artifact from durable feedback. */
  revisionMode?: boolean;
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
        deadlineMs: opts.deadlineMs,
        runDeadline: opts.runDeadline,
        llmConfig: opts.llmConfig,
        onProgress: opts.onProgress,
        signal: opts.signal,
        onDeadlineReached: opts.onDeadlineReached,
        keepTest: opts.keepTest,
        outDir,
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
        teachCredentials: opts.teachCredentials,
        buildPlanPath: opts.buildPlanPath,
        sharedModules: opts.sharedModules,
        toolPlan: opts.toolPlan,
        strategyKind: opts.strategyKind,
        revisionMode: opts.revisionMode,
        preTriagedSession: opts.preTriagedSession,
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
    'playbook.yaml',
    'parser.ts',
    'parser.test.ts',
    '.compile-log.json',
    '.compile-done.json',
    '.compile-give-up.json',
    '.live-verifier-log.jsonl',
    '.live-verification-evidence.json',
    '.live-verification.json',
    'backends.json',
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
  /mfa|2fa|two.?factor|otp|verify|verification|challenge|push.?notification|authenticate|oauth|trusted.?device|security.?code/i;

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
const EFFECT_TRIAGE_BODY_LIMIT = 800;
// Leave headroom for narration and browser-action context in every effect pass.
const EFFECT_TRIAGE_BATCH_CHARS = 300_000;
const TRIAGE_ACTION_ALIGNMENT_BEFORE_MS = 1000;
const TRIAGE_ACTION_ALIGNMENT_AFTER_MS = 5000;
const TRIAGE_CONTEXT_EVENT_TYPES = new Set<Session['events'][number]['type']>([
  'navigation',
  'click',
  'input',
  'change',
  'submit',
  'ws-sent',
]);
const TRIAGE_ACTION_EVENT_TYPES = new Set<Session['events'][number]['type']>([
  'input',
  'change',
  'submit',
]);

export interface TriageResult {
  session: Session;
  selectedSeqs: number[];
  /** Every full-inventory request covered by v2 triage except those classified
   * irreversible. Independent of compile relevance. */
  replaySafeSeqs: number[];
  /** Full-inventory requests that are irreversible if
   *  re-issued (place order, charge, send, delete). Used to block them during
   *  replay and to flag the compiled tool so compile-verify + audit don't
   *  trigger the real action. */
  irreversibleSeqs: number[];
  /** Outbound WebSocket events shown to the effect classifier. */
  coveredOutboundEventSeqs: number[];
  /** Outbound WebSocket events whose replay can cause an irreversible effect. */
  irreversibleEventSeqs: number[];
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
  urlDigest?: string;
  bodyDigest?: string;
  bodyLength?: number;
  responseBodyDigest?: string;
  responseBodyLength?: number;
  responsePreview?: string;
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

export function parseTriageSelectionResponse(text: string): {
  keepSeqs: number[];
  irreversibleSeqs: number[];
  irreversibleEventSeqs: number[];
} {
  const isNumArray = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'number');

  const objText = extractJsonObject(text);
  if (objText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(objText);
    } catch (err) {
      throw new Error(
        `Triage response object was not valid JSON: ${err instanceof Error ? err.message : String(err)}\nExtracted:\n${objText.slice(0, 500)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Triage response object is not an object.\nParsed: ${JSON.stringify(parsed)}`,
      );
    }

    const record = parsed as {
      keep?: unknown;
      irreversible?: unknown;
      irreversibleEvents?: unknown;
    };
    if (!isNumArray(record.keep)) {
      throw new Error(
        `Triage response field "keep" must be an array of numbers.\nParsed: ${(JSON.stringify(record.keep) ?? String(record.keep)).slice(0, 500)}`,
      );
    }
    if (!isNumArray(record.irreversible)) {
      throw new Error(
        `Triage response field "irreversible" must be an array of numbers.\nParsed: ${(JSON.stringify(record.irreversible) ?? String(record.irreversible)).slice(0, 500)}`,
      );
    }
    if (!isNumArray(record.irreversibleEvents)) {
      throw new Error(
        `Triage response field "irreversibleEvents" must be an array of numbers.\nParsed: ${(JSON.stringify(record.irreversibleEvents) ?? String(record.irreversibleEvents)).slice(0, 500)}`,
      );
    }
    return {
      keepSeqs: record.keep,
      irreversibleSeqs: record.irreversible,
      irreversibleEventSeqs: record.irreversibleEvents,
    };
  }

  if (!extractJsonArray(text)) {
    throw new Error(
      `Triage LLM did not return the required effect-aware object {"keep": [...], "irreversible": [...]}.\nRaw response:\n${text.slice(0, 1000)}`,
    );
  }
  throw new Error(
    `Triage LLM must return the effect-aware object {"keep": [...], "irreversible": [...]}; legacy arrays are unsafe because they cannot prove irreversible classification.\nRaw response:\n${text.slice(0, 1000)}`,
  );
}

export interface TriageRequestsOptions {
  /** Compiler callers classify effects by default. Master candidate discovery
   * skips those LLM batches because their effect result is not authoritative. */
  effectClassification?: 'classify' | 'skip';
  /** Focused test seam; production resolves the configured provider. */
  analyzer?: Pick<ReturnType<typeof resolveProvider>, 'analyze'>;
}

export async function triageRequests(
  session: Session,
  llmConfig?: LLMOptions,
  context: Pick<
    CompileOptions,
    'candidate' | 'sharedContext' | 'signal' | 'timeoutMs' | 'deadlineMs' | 'runDeadline'
  > = {},
  options: TriageRequestsOptions = {},
): Promise<TriageResult> {
  const classifyEffects = options.effectClassification !== 'skip';
  const preserveSeqs = new Set([
    ...(context.candidate?.requestSeqs ?? []),
    ...(context.candidate?.dependencySeqs ?? []),
    ...(context.sharedContext?.loginRequestSeqs ?? []),
    ...(context.sharedContext?.authRequestSeqs ?? []),
  ]);
  const candidates = selectTriageCandidateRequests(session, preserveSeqs);
  const keepEligibleSeqs = new Set(candidates.map((request) => request.seq));

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
      const requestContext = (
        r: Session['requests'][number],
        bodyLimit: number,
        includeResponse = true,
      ): TriageRequestContext => ({
        seq: r.seq,
        timestamp: r.timestamp,
        method: r.method,
        url: compactUrlForLlm(r.url),
        resourceType: r.resourceType,
        status: r.response?.status,
        mimeType: r.response?.mimeType,
        headers: truncateHeaders(r.headers),
        body: triageBodySnippet(r.body, bodyLimit),
        urlDigest: requestContextDigest(r.url),
        bodyDigest: requestContextDigest(r.body),
        bodyLength: r.body?.length,
        ...(includeResponse
          ? {
              responseBodyDigest: requestContextDigest(r.response?.body),
              responseBodyLength: r.response?.body?.length,
              responsePreview: triageBodySnippet(r.response?.body, bodyLimit),
            }
          : {}),
      });
      const compacted = compactRequestContexts(
        session.requests.map((request) => requestContext(request, EFFECT_TRIAGE_BODY_LIMIT)),
        triageRequestGroupKey,
        { preserveSeqs },
      );
      const requestMetadata = (
        request: TriageRequestContext,
      ): Omit<TriageRequestContext, 'urlDigest' | 'bodyDigest' | 'responseBodyDigest'> & {
        keepEligible: boolean;
      } => {
        const { urlDigest, bodyDigest, responseBodyDigest, ...rest } = request;
        return {
          ...rest,
          keepEligible: compactedRequestSeqs(rest).some((seq) => keepEligibleSeqs.has(seq)),
        };
      };
      const metadata = compacted.map(requestMetadata);
      const coveredSeqs = expandCompactedTriageSeqs(
        compacted.map((request) => request.seq),
        compacted,
      );
      const outboundEvents = buildTriageEventContexts(session).filter(
        (event) => event.type === 'ws-sent',
      );
      const coveredOutboundEventSeqs = outboundEvents.map((event) => event.seq);

      const promptPath = pathJoin(PROMPTS_DIR, 'request-triage.md');
      if (!existsSync(promptPath)) {
        throw new Error(
          `Triage prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
        );
      }
      const systemPrompt = readFileSync(promptPath, 'utf8');
      const llm = options.analyzer ?? resolveProvider(llmConfig ?? {});
      const contextEvents = buildTriageEventContexts(session).filter(
        (event) => event.type !== 'ws-sent',
      );
      const relevanceCompacted = compactRequestContexts(
        candidates.map((request) => requestContext(request, TRIAGE_BODY_LIMIT, false)),
        triageRequestGroupKey,
        { preserveSeqs },
      );
      const relevancePayload = {
        mode: 'relevance',
        site: session.site,
        url: compactUrlForLlm(session.url),
        narration: session.narration,
        events: contextEvents,
        requests: relevanceCompacted.map(requestMetadata),
        outboundWebSockets: [],
      };
      log(
        `triaging ${relevanceCompacted.length} relevance candidates; ${Math.round(JSON.stringify(relevancePayload).length / 1024)} KB payload…`,
      );
      const relevanceResult = await llm.analyze(systemPrompt, relevancePayload, {
        signal: context.signal,
        deadlineMs: context.deadlineMs,
        runDeadline: context.runDeadline,
        timeoutMs: context.timeoutMs,
        timeoutLabel: 'request triage',
      });
      const { keepSeqs } = parseTriageSelectionResponse(relevanceResult.text);
      const candidateSet = new Set(
        expandCompactedTriageSeqs(
          relevanceCompacted.map((request) => request.seq),
          relevanceCompacted,
        ),
      );
      const unknownKeepSeqs = keepSeqs.filter((seq) => !candidateSet.has(seq));
      if (unknownKeepSeqs.length > 0) {
        throw new Error(
          `Triage response referenced request seq(s) absent from its relevance inventory: ${[...new Set(unknownKeepSeqs)].join(', ')}.`,
        );
      }

      const safetyItems = [
        ...metadata.map((request) => ({ kind: 'request' as const, value: request })),
        ...outboundEvents.map((event) => ({ kind: 'websocket' as const, value: event })),
      ];
      const safetyBatches = classifyEffects
        ? chunkTriageItems(safetyItems, EFFECT_TRIAGE_BATCH_CHARS)
        : [];
      const irreversibleSeqs: number[] = [];
      const irreversibleEventSeqs: number[] = [];
      let inputTokens = relevanceResult.inputTokens;
      let outputTokens = relevanceResult.outputTokens;
      let durationMs = relevanceResult.durationMs;
      let safetyPayloadChars = 0;
      for (const [batchIndex, batch] of safetyBatches.entries()) {
        const batchRequests = batch
          .filter((item) => item.kind === 'request')
          .map((item) => item.value);
        const batchWebSockets = batch
          .filter((item) => item.kind === 'websocket')
          .map((item) => item.value);
        const safetyPayload = {
          mode: 'effect',
          batch: { index: batchIndex + 1, total: safetyBatches.length },
          site: session.site,
          url: compactUrlForLlm(session.url),
          narration: session.narration,
          events: contextEvents,
          requests: batchRequests,
          outboundWebSockets: batchWebSockets,
        };
        safetyPayloadChars += JSON.stringify(safetyPayload).length;
        const result = await llm.analyze(systemPrompt, safetyPayload, {
          signal: context.signal,
          deadlineMs: context.deadlineMs,
          runDeadline: context.runDeadline,
          timeoutMs: context.timeoutMs,
          timeoutLabel: 'request safety triage',
        });
        const parsed = parseTriageSelectionResponse(result.text);
        const batchRequestSeqs = new Set(
          batchRequests.flatMap((request) => compactedRequestSeqs(request)),
        );
        const batchEventSeqs = new Set(batchWebSockets.map((event) => event.seq));
        const unknownRequests = parsed.irreversibleSeqs.filter((seq) => !batchRequestSeqs.has(seq));
        const unknownEvents = parsed.irreversibleEventSeqs.filter(
          (seq) => !batchEventSeqs.has(seq),
        );
        if (unknownRequests.length > 0 || unknownEvents.length > 0) {
          throw new Error(
            `Effect triage batch ${batchIndex + 1} referenced item(s) absent from its inventory: ${[...new Set([...unknownRequests, ...unknownEvents])].join(', ')}.`,
          );
        }
        irreversibleSeqs.push(...parsed.irreversibleSeqs);
        irreversibleEventSeqs.push(...parsed.irreversibleEventSeqs);
        inputTokens = sumOptionalTokens(inputTokens, result.inputTokens);
        outputTokens = sumOptionalTokens(outputTokens, result.outputTokens);
        durationMs += result.durationMs;
      }

      const coveredSet = new Set(coveredSeqs);
      const unknownOutputSeqs = irreversibleSeqs.filter((seq) => !coveredSet.has(seq));
      if (unknownOutputSeqs.length > 0) {
        throw new Error(
          `Triage response referenced request seq(s) absent from its complete inventory: ${[...new Set(unknownOutputSeqs)].join(', ')}.`,
        );
      }

      const rescuedSeqs = rescueActionAlignedRepeatedSeqs(session, keepSeqs as number[], compacted);
      const selectedSet = new Set([...keepSeqs, ...rescuedSeqs, ...preserveSeqs]);
      const irreversibleSet = new Set(expandCompactedTriageSeqs(irreversibleSeqs, compacted));
      const irreversibleEventSet = new Set(irreversibleEventSeqs);
      const replaySafeSeqs = classifyEffects
        ? coveredSeqs.filter((seq) => !irreversibleSet.has(seq))
        : [];
      const triaged: Session = {
        ...session,
        ...(classifyEffects
          ? {
              triage: {
                effectSchemaVersion: 2 as const,
                coveredSeqs,
                irreversibleSeqs: [...irreversibleSet].sort((a, b) => a - b),
                coveredOutboundEventSeqs,
                irreversibleEventSeqs: [...irreversibleEventSet].sort((a, b) => a - b),
              },
            }
          : {}),
        requests: session.requests
          .filter((r) => selectedSet.has(r.seq))
          .map((r) => (irreversibleSet.has(r.seq) ? { ...r, effect: 'irreversible' as const } : r)),
      };

      log(
        classifyEffects
          ? `triage selected ${selectedSet.size} requests out of ${candidates.length} relevance candidates (${irreversibleSet.size} irreversible requests and ${irreversibleEventSet.size} irreversible outbound WebSocket events across ${safetyBatches.length} bounded safety batch(es))`
          : `triage selected ${selectedSet.size} requests out of ${candidates.length} relevance candidates; effect classification skipped`,
      );

      setSpanAttributes(span, {
        'imprint.requests_compacted': metadata.length,
        'imprint.requests_selected': selectedSet.size,
        'imprint.triage.effect_classification': classifyEffects,
        'imprint.triage.payload_chars':
          JSON.stringify(relevancePayload).length + safetyPayloadChars,
        'imprint.requests_irreversible': irreversibleSet.size,
        'imprint.events_irreversible': irreversibleEventSet.size,
        'imprint.triage.duration_ms': durationMs,
        'imprint.triage.input_tokens': inputTokens,
        'imprint.triage.output_tokens': outputTokens,
      });

      return {
        session: triaged,
        selectedSeqs: [...selectedSet],
        replaySafeSeqs,
        irreversibleSeqs: [...irreversibleSet],
        coveredOutboundEventSeqs: classifyEffects ? coveredOutboundEventSeqs : [],
        irreversibleEventSeqs: [...irreversibleEventSet],
        consideredCount: candidates.length,
        inputTokens,
        outputTokens,
        durationMs,
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

export function chunkTriageItems<T>(items: T[], maxChars: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 2;
  for (const item of items) {
    const itemChars = JSON.stringify(item).length + 1;
    if (current.length > 0 && currentChars + itemChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 2;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0 || batches.length === 0) batches.push(current);
  return batches;
}

function sumOptionalTokens(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

export function selectTriageCandidateRequests(
  session: Session,
  preserveSeqs: Iterable<number> = [],
): Session['requests'] {
  const preserve = new Set(preserveSeqs);
  return session.requests.filter((request) => {
    if (preserve.has(request.seq)) return true;
    if (!TRIAGE_RESOURCE_TYPES.has(request.resourceType)) return false;
    return !isTelemetryRequest(request);
  });
}

function compactedRequestSeqs(
  request: Pick<TriageRequestContext, 'seq' | 'repeatedSeqs'>,
): number[] {
  return [...new Set([request.seq, ...(request.repeatedSeqs ?? [])])];
}

/** Expand a classification on any representative/member of a compacted row to
 * every original request represented by that row. Effect decisions must apply
 * uniformly because the LLM saw only one compacted request description. */
export function expandCompactedTriageSeqs(
  seqs: Iterable<number>,
  compactedRequests: Pick<TriageRequestContext, 'seq' | 'repeatedSeqs'>[],
): number[] {
  const requested = new Set(seqs);
  const expanded = new Set(requested);
  for (const request of compactedRequests) {
    const group = compactedRequestSeqs(request);
    if (!group.some((seq) => requested.has(seq))) continue;
    for (const seq of group) expanded.add(seq);
  }
  return [...expanded].sort((a, b) => a - b);
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
    request.urlDigest,
    request.bodyDigest,
  ];
}

function truncateHeaders(headers: Record<string, string>): string {
  const serialized = JSON.stringify(headers);
  if (serialized.length <= HEADER_TRUNCATE_LIMIT) return serialized;
  return `${serialized.slice(0, HEADER_TRUNCATE_LIMIT)}…`;
}

export function triageBodySnippet(
  body: string | undefined,
  maxChars = TRIAGE_BODY_LIMIT,
): string | undefined {
  if (body === undefined) return undefined;
  if (isLikelyText(body)) return truncate(body, maxChars);
  return `[non-text request body omitted; original length ${body.length}]`;
}

function isLikelyText(value: string): boolean {
  if (value.length === 0) return true;
  const sample = value.slice(0, Math.min(value.length, TRIAGE_BODY_LIMIT));
  let suspicious = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (ch === '\uFFFD' || (code < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t')) {
      suspicious++;
    }
  }
  return suspicious <= 4 && suspicious / sample.length <= 0.02;
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
    session = applySharedTriageSelection(session, opts.preTriagedSession, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
    });
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
      signal: opts.signal,
      deadlineMs: opts.deadlineMs,
      runDeadline: opts.runDeadline,
      timeoutMs: opts.timeoutMs,
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
      url: compactUrlForLlm(r.url),
      resourceType: r.resourceType,
      status: r.response?.status,
      response_body: truncate(r.response?.body, RESPONSE_BODY_LIMIT),
    }));

  log(
    `compiling playbook from ${session.events.length} events / ${xhrs.length} XHRs / ${session.narration.length} narration lines…`,
  );

  const workflowContract = opts.workflow
    ? {
        toolName: opts.workflow.toolName,
        parameters: opts.workflow.parameters,
        limitations: opts.workflow.limitations ?? [],
      }
    : undefined;
  const slimmed = {
    site: session.site,
    url: compactUrlForLlm(session.url),
    candidate: opts.candidate,
    workflowContract,
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
  }${
    workflowContract
      ? `\n\nAuthoritative verified workflow contract:\n${JSON.stringify(workflowContract, null, 2)}\nThis contract supersedes candidate likelyParams and raw recording branches. Use exactly these public parameters. Never resurrect an omitted parameter or reference it in a step. When a limitation omits a recorded branch, leave that branch out of the playbook and retain the limitation in notes if useful.\n`
      : ''
  }`;

  const llm = resolveProvider(opts.llmConfig ?? {});

  let playbook: Playbook | undefined;
  let lastResult = await llm.analyze(systemPrompt, slimmed, {
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    runDeadline: opts.runDeadline,
    timeoutMs: opts.timeoutMs,
    timeoutLabel: 'playbook compiler',
  });
  let llmInputTokens = lastResult.inputTokens;
  let llmOutputTokens = lastResult.outputTokens;
  let llmDurationMs = lastResult.durationMs;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      playbook = parsePlaybook(stripCodeFences(lastResult.text).trim());
      if (opts.workflow) {
        const contractFailures = playbookWorkflowContractFailures(playbook, opts.workflow);
        if (contractFailures.length > 0) {
          throw new Error(
            `playbook conflicts with the authoritative verified workflow contract:\n- ${contractFailures.join('\n- ')}`,
          );
        }
      }
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        log('playbook failed validation, retrying with error feedback…');
        const fixPrompt = `Your previous playbook was invalid. The validation error was:\n\n${err instanceof Error ? err.message : String(err)}\n\nReason about the verified workflow contract, fix the YAML, and return the corrected playbook. Output ONLY valid YAML, no prose.`;
        lastResult = await llm.analyze(systemPrompt, `${JSON.stringify(slimmed)}\n\n${fixPrompt}`, {
          signal: opts.signal,
          deadlineMs: opts.deadlineMs,
          runDeadline: opts.runDeadline,
          timeoutMs: opts.timeoutMs,
          timeoutLabel: 'playbook compiler repair',
        });
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
  const playbookText = `${stripCodeFences(lastResult.text).trim()}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, playbookText);

  return {
    playbook,
    playbookPath: outPath,
    inputTokens: addNullable(triageTokens.input, llmInputTokens),
    outputTokens: addNullable(triageTokens.output, llmOutputTokens),
    durationMs: triageTokens.durationMs + llmDurationMs,
  };
}

/**
 * Check only the compatibility boundary required for API→playbook fallback.
 * The playbook agent remains free to choose DOM actions and locators, but it
 * cannot change the verified public tool surface or depend on hidden inputs.
 */
export function playbookWorkflowContractFailures(playbook: Playbook, workflow: Workflow): string[] {
  const failures: string[] = [];
  if (playbook.toolName !== workflow.toolName) {
    failures.push(
      `toolName ${JSON.stringify(playbook.toolName)} must equal ${JSON.stringify(workflow.toolName)}`,
    );
  }

  const workflowNames = new Set(workflow.parameters.map((parameter) => parameter.name));
  const playbookNames = new Set(playbook.parameters.map((parameter) => parameter.name));
  const missing = [...workflowNames].filter((name) => !playbookNames.has(name)).sort();
  const unexpected = [...playbookNames].filter((name) => !workflowNames.has(name)).sort();
  if (missing.length > 0) {
    failures.push(`missing public parameter(s): ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    failures.push(`unexpected parameter(s): ${unexpected.join(', ')}`);
  }

  const hiddenReferences = new Set<string>();
  const executableText = JSON.stringify({ steps: playbook.steps, result: playbook.result });
  for (const match of executableText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1];
    if (name && !workflowNames.has(name)) hiddenReferences.add(name);
  }
  if (hiddenReferences.size > 0) {
    failures.push(
      `step/result references hidden parameter(s): ${[...hiddenReferences].sort().join(', ')}`,
    );
  }
  return failures;
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
