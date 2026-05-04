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
import { LLM, extractJsonObject, loadConfig } from './llm.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { redactSession } from './redact.ts';
import {
  type Playbook,
  type Session,
  SessionSchema,
  type Workflow,
  WorkflowSchema,
} from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');

export interface CompileOptions {
  /** Path to session.json or session.redacted.json */
  sessionPath: string;
  /** Where to write the artifact. Defaults to <sessionDir>/../<task.defaultOutFile> */
  outPath?: string;
  /** Override LLM config (region, model, project). */
  llmConfig?: Parameters<typeof loadConfig>[0];
}

export interface CompileResult<T> {
  value: T;
  outPath: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface CompileTask<T> {
  promptFile: string;
  /** Slim the session to what the LLM actually needs. */
  slim: (session: Session) => unknown;
  /** Parse the LLM raw text into a validated value. Throws on bad output. */
  parse: (raw: string) => T;
  /** Default filename, written next to the session's parent directory. */
  defaultOutFile: string;
  /** Serialize the value (or the raw LLM text) to disk. */
  serialize: (value: T, raw: string) => string;
  /** Friendly name for log messages. */
  artifactName: string;
}

async function compile<T>(opts: CompileOptions, task: CompileTask<T>): Promise<CompileResult<T>> {
  if (!existsSync(opts.sessionPath)) {
    throw new Error(
      `Session not found: ${opts.sessionPath}\n→ run \`imprint record <site>\` to create one.`,
    );
  }

  const raw = JSON.parse(readFileSync(opts.sessionPath, 'utf8'));
  let session: Session = SessionSchema.parse(raw);

  // Auto-redact if the input wasn't already scrubbed — we never let
  // plaintext credentials leave this process.
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const r = redactSession(session);
    session = r.session;
    if (r.stats.totalRedactions > 0) {
      console.log(
        `[imprint] redacted ${r.stats.totalRedactions} value(s) before sending to LLM (use \`imprint redact\` to scrub the file on disk too)`,
      );
    }
  }

  const slimmed = task.slim(session);

  const promptPath = pathJoin(PROMPTS_DIR, task.promptFile);
  if (!existsSync(promptPath)) {
    throw new Error(`Prompt not found at ${promptPath}`);
  }
  const systemPrompt = readFileSync(promptPath, 'utf8');

  const llm = new LLM(loadConfig(opts.llmConfig));
  const result = await llm.analyze(systemPrompt, slimmed);

  let value: T;
  try {
    value = task.parse(result.text);
  } catch (err) {
    throw new Error(
      `Compiled ${task.artifactName} failed to parse: ${err instanceof Error ? err.message : String(err)}\nRaw output:\n${result.text.slice(0, 1500)}`,
    );
  }

  const outPath = opts.outPath ?? pathJoin(dirname(opts.sessionPath), '..', task.defaultOutFile);
  writeFileSync(outPath, task.serialize(value, result.text));

  return {
    value,
    outPath,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
}

// ─── generate (workflow.json) ────────────────────────────────────────────────

export interface GenerateOptions extends CompileOptions {
  /** If true, send the FULL session to the LLM (don't shrink). Useful for
   *  debugging when shrinking might be over-aggressive. Default false. */
  noShrink?: boolean;
  /** If true, write the shrunken session next to workflow.json so we can
   *  see what the LLM actually saw. Useful for prompt iteration. */
  saveShrunken?: boolean;
}

export interface GenerateResult {
  workflow: Workflow;
  workflowPath: string;
  /** Number of requests the LLM saw (after shrinking). */
  requestsSent: number;
  /** Original count before shrinking. */
  requestsOriginal: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  // Capture per-task counters from inside the slim closure so we can
  // surface them on the result without a separate slim pre-step.
  let requestsOriginal = 0;
  let requestsSent = 0;

  const r = await compile<Workflow>(opts, {
    promptFile: 'intent-detection.md',
    slim: (session) => {
      requestsOriginal = session.requests.length;
      const shrunken = opts.noShrink ? session : shrinkSession(session);
      requestsSent = shrunken.requests.length;
      if (opts.saveShrunken) {
        const path = opts.sessionPath.replace(/\.(redacted\.)?json$/, '.shrunken.json');
        writeFileSync(path, `${JSON.stringify(shrunken, null, 2)}\n`);
        console.log(`[imprint] saved shrunken view → ${path}`);
      }
      console.log(
        `[imprint] sending ${requestsSent} requests (down from ${requestsOriginal}) to LLM…`,
      );
      return shrunken;
    },
    parse: (raw) => {
      const jsonText = extractJsonObject(raw);
      if (!jsonText) {
        throw new Error(
          `LLM response did not contain a JSON object. Raw response:\n${raw.slice(0, 500)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(
          `Extracted text was not valid JSON: ${err instanceof Error ? err.message : String(err)}\nExtracted:\n${jsonText.slice(0, 500)}`,
        );
      }
      try {
        return WorkflowSchema.parse(parsed);
      } catch (err) {
        throw new Error(
          `LLM output failed schema validation: ${err instanceof Error ? err.message : String(err)}\nRaw JSON: ${jsonText.slice(0, 1000)}\n→ if this keeps happening, re-record the session or check prompts/intent-detection.md.`,
        );
      }
    },
    defaultOutFile: 'workflow.json',
    serialize: (workflow) => `${JSON.stringify(workflow, null, 2)}\n`,
    artifactName: 'workflow',
  });

  return {
    workflow: r.value,
    workflowPath: r.outPath,
    requestsSent,
    requestsOriginal,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
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
  const startRoot = startUrl ? rootDomain(startUrl.hostname) : null;

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
    if (startRoot && !url.hostname.endsWith(startRoot)) return false;
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

function rootDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

// ─── compilePlaybook (playbook.yaml) ─────────────────────────────────────────

export interface CompilePlaybookResult {
  playbook: Playbook;
  playbookPath: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

const RESPONSE_BODY_LIMIT = 4000;

export async function compilePlaybook(opts: CompileOptions): Promise<CompilePlaybookResult> {
  const r = await compile<Playbook>(opts, {
    promptFile: 'playbook-compilation.md',
    slim: (session) => {
      // Slim view: events + narration + XHR/Fetch summary. Response bodies
      // are included (truncated) so the LLM can identify the actual JSON
      // shape of the result-bearing XHR — without them it has to guess
      // the extract path and gets it wrong (verified against Southwest:
      // hallucinated nested keys that don't exist).
      const slim = {
        site: session.site,
        url: session.url,
        narration: session.narration,
        events: session.events,
        requests: session.requests
          .filter((r) => r.resourceType === 'XHR' || r.resourceType === 'Fetch')
          .map((r) => ({
            method: r.method,
            url: r.url,
            resourceType: r.resourceType,
            status: r.response?.status,
            response_body: truncate(r.response?.body, RESPONSE_BODY_LIMIT),
          })),
      };
      console.log(
        `[imprint] compiling playbook from ${session.events.length} events / ${slim.requests.length} XHRs / ${session.narration.length} narration lines…`,
      );
      return slim;
    },
    parse: (raw) => parsePlaybook(stripCodeFences(raw).trim()),
    defaultOutFile: 'playbook.yaml',
    // Preserve the LLM's exact YAML rather than round-tripping through
    // YAML.stringify (which would lose comments + reorder keys).
    serialize: (_value, raw) => `${stripCodeFences(raw).trim()}\n`,
    artifactName: 'playbook',
  });

  return {
    playbook: r.value,
    playbookPath: r.outPath,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
  };
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
