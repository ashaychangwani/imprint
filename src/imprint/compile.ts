/**
 * One recording compiles to two artifacts: workflow.json (API-replay)
 * and playbook.yaml (DOM-replay). Both share the same skeleton —
 * read session, redact-if-needed, slim, call LLM, parse, validate,
 * write next to the session — so they live in one file with the
 * differences (slim strategy, prompt, parser, schema, output filename)
 * factored into a CompileTask config.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { type CompileAgentProgress, compileAgent } from './compile-agent.ts';
import { isSameRegistrableDomain, registrableDomain } from './etld.ts';
import { type LLMOptions, extractJsonArray, resolveProvider } from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { redactSession } from './redact.ts';
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
  /** Where to write the artifact. Defaults to <sessionDir>/../<task.defaultOutFile> */
  outPath?: string;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** If true, send the FULL session to the LLM (don't shrink). Useful for
   *  debugging when shrinking might be over-aggressive. Default false. */
  noShrink?: boolean;
}

// ─── generate (workflow.json) ────────────────────────────────────────────────

interface GenerateOptions extends CompileOptions {
  /** Hard wall-clock budget for the agent. Default 30 minutes. */
  maxDurationMs?: number;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
  /** Legacy debug flag — kept for backward compat but ignored by the agentic compiler. */
  noShrink?: boolean;
  /** Legacy debug flag — kept for backward compat but ignored. */
  saveShrunken?: boolean;
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
  const result = await compileAgent({
    sessionPath: opts.sessionPath,
    maxDurationMs: opts.maxDurationMs,
    llmConfig: opts.llmConfig,
    onProgress: opts.onProgress,
  });

  if (!result.success) {
    throw new Error(
      [
        'compile agent did not produce a verified workflow.',
        `outcome: ${result.outcome}`,
        `message: ${result.message}`,
        `turns: ${result.turns}, duration: ${(result.durationMs / 1000).toFixed(1)}s`,
        `conversation log: ${result.conversationLogPath}`,
      ].join('\n'),
    );
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

  return {
    workflow,
    workflowPath: result.workflowPath,
    requestsSent: 0, // legacy field — no longer meaningful for agentic compile
    requestsOriginal: 0, // legacy field
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
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
    if (startRoot && !isSameRegistrableDomain(url.hostname, startRoot)) return false;
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

// ─── triageRequests (LLM-based request filtering) ───────────────────────────

const TRIAGE_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'Document']);
const HEADER_TRUNCATE_LIMIT = 200;

interface TriageResult {
  session: Session;
  selectedSeqs: number[];
  consideredCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

async function triageRequests(session: Session, llmConfig?: LLMOptions): Promise<TriageResult> {
  const candidates = session.requests.filter((r) => TRIAGE_RESOURCE_TYPES.has(r.resourceType));

  const metadata = candidates.map((r) => ({
    seq: r.seq,
    timestamp: r.timestamp,
    method: r.method,
    url: r.url,
    resourceType: r.resourceType,
    status: r.response?.status,
    headers: truncateHeaders(r.headers),
    body: r.body,
  }));

  const triagePayload = {
    site: session.site,
    url: session.url,
    narration: session.narration,
    requests: metadata,
  };

  const promptPath = pathJoin(PROMPTS_DIR, 'request-triage.md');
  if (!existsSync(promptPath)) {
    throw new Error(
      `Triage prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
    );
  }
  const systemPrompt = readFileSync(promptPath, 'utf8');

  log(`triaging ${candidates.length} requests (from ${session.requests.length} total)…`);
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

  const selectedSet = new Set(seqs as number[]);
  const triaged: Session = {
    ...session,
    requests: session.requests.filter((r) => selectedSet.has(r.seq)),
  };

  log(`triage selected ${selectedSet.size} requests out of ${candidates.length} candidates`);

  return {
    session: triaged,
    selectedSeqs: seqs as number[],
    consideredCount: candidates.length,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
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

export async function compilePlaybook(opts: CompileOptions): Promise<CompilePlaybookResult> {
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
      log(`redacted ${r.stats.totalRedactions} value(s) before sending to LLM`);
    }
  }

  // 3. Triage: LLM selects which requests matter.
  let triageTokens: { input: number | null; output: number | null; durationMs: number } = {
    input: null,
    output: null,
    durationMs: 0,
  };
  if (!opts.noShrink) {
    const triage = await triageRequests(session, opts.llmConfig);
    session = triage.session;
    triageTokens = {
      input: triage.inputTokens,
      output: triage.outputTokens,
      durationMs: triage.durationMs,
    };
  }

  // 4. Build slim payload from triaged requests (with response bodies).
  const xhrs = session.requests
    .filter((r) => r.resourceType === 'XHR' || r.resourceType === 'Fetch')
    .map((r) => ({
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
  const systemPrompt = readFileSync(promptPath, 'utf8');

  const llm = resolveProvider(opts.llmConfig ?? {});
  const result = await llm.analyze(systemPrompt, slimmed);

  let playbook: Playbook;
  try {
    playbook = parsePlaybook(stripCodeFences(result.text).trim());
  } catch (err) {
    throw new Error(
      `Compiled playbook failed to parse: ${err instanceof Error ? err.message : String(err)}\nRaw output:\n${result.text.slice(0, 1500)}`,
    );
  }

  const outPath = opts.outPath ?? pathJoin(dirname(opts.sessionPath), '..', 'playbook.yaml');
  // Preserve the LLM's exact YAML rather than round-tripping through
  // YAML.stringify (which would lose comments + reorder keys).
  writeFileSync(outPath, `${stripCodeFences(result.text).trim()}\n`);

  return {
    playbook,
    playbookPath: outPath,
    inputTokens: addNullable(triageTokens.input, result.inputTokens),
    outputTokens: addNullable(triageTokens.output, result.outputTokens),
    durationMs: triageTokens.durationMs + result.durationMs,
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
