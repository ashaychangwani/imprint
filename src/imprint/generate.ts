/**
 * `imprint generate <session>` — analyze a captured session and emit workflow.json.
 *
 * Pipeline:
 *
 *   session.json (or .redacted.json)
 *     │
 *     ├─▶ shrink (drop noise: assets, telemetry, third-party)
 *     │
 *     ├─▶ Vertex Claude Sonnet 4.6 (system prompt = prompts/intent-detection.md)
 *     │
 *     ├─▶ extract JSON object from response
 *     │
 *     ├─▶ validate against WorkflowSchema (zod)
 *     │
 *     └─▶ write workflow.json next to the session file
 *
 * Always operates on the redacted session if one exists. Refuses to send a
 * non-redacted session that contains obvious secrets — protect the user.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { LLM, extractJsonObject, loadConfig } from './llm.ts';
import { redactSession } from './redact.ts';
import { type Session, SessionSchema, type Workflow, WorkflowSchema } from './types.ts';

export interface GenerateOptions {
  /** Path to session.json or session.redacted.json */
  sessionPath: string;
  /** Where to write workflow.json. Defaults to <sessionDir>/workflow.json */
  outPath?: string;
  /** Override LLM config (region, model, project). */
  llmConfig?: Parameters<typeof loadConfig>[0];
  /**
   * If true, send the FULL session to the LLM (don't shrink). Useful for
   * debugging when shrinking might be over-aggressive. Default false.
   */
  noShrink?: boolean;
  /**
   * If true, write the shrunken session next to workflow.json so we can see
   * what the LLM actually saw. Useful for prompt iteration.
   */
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

const PROMPT_PATH = pathJoin(import.meta.dir, '..', '..', 'prompts', 'intent-detection.md');

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!existsSync(opts.sessionPath)) {
    throw new Error(`Session not found: ${opts.sessionPath}`);
  }

  const raw = JSON.parse(readFileSync(opts.sessionPath, 'utf8'));
  let session: Session = SessionSchema.parse(raw);

  // If the input wasn't already redacted, redact in-memory before sending.
  // We never let plaintext credentials leave this process.
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

  const requestsOriginal = session.requests.length;
  const shrunken = opts.noShrink ? session : shrinkSession(session);

  if (!existsSync(PROMPT_PATH)) {
    throw new Error(`Intent-detection prompt not found at ${PROMPT_PATH}`);
  }
  const systemPrompt = readFileSync(PROMPT_PATH, 'utf8');

  if (opts.saveShrunken) {
    const shrunkenPath = opts.sessionPath.replace(/\.(redacted\.)?json$/, '.shrunken.json');
    writeFileSync(shrunkenPath, `${JSON.stringify(shrunken, null, 2)}\n`);
    console.log(`[imprint] saved shrunken view → ${shrunkenPath}`);
  }

  console.log(
    `[imprint] sending ${shrunken.requests.length} requests (down from ${requestsOriginal}) to LLM…`,
  );

  const llm = new LLM(loadConfig(opts.llmConfig));
  const result = await llm.analyze(systemPrompt, shrunken);

  const jsonText = extractJsonObject(result.text);
  if (!jsonText) {
    throw new Error(
      `LLM response did not contain a JSON object. Raw response:\n${result.text.slice(0, 500)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Extracted text was not valid JSON: ${err instanceof Error ? err.message : String(err)}\n` +
        `Extracted:\n${jsonText.slice(0, 500)}`,
    );
  }

  let workflow: Workflow;
  try {
    workflow = WorkflowSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `LLM output failed schema validation: ${err instanceof Error ? err.message : String(err)}\n` +
        `Raw JSON: ${jsonText.slice(0, 1000)}`,
    );
  }

  const workflowPath = opts.outPath ?? pathJoin(dirname(opts.sessionPath), '..', 'workflow.json');
  writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);

  return {
    workflow,
    workflowPath,
    requestsSent: shrunken.requests.length,
    requestsOriginal,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
}

/**
 * Drop request noise before sending to the LLM. Keeps the prompt cheap and
 * helps the LLM focus on the load-bearing requests.
 *
 * Conservative rules — when in doubt, keep the request. Better to have the
 * LLM filter than to silently drop something load-bearing.
 */
export function shrinkSession(session: Session): Session {
  const startUrl = safeUrl(session.url);
  const sameOrigin = (u: string): boolean => {
    const p = safeUrl(u);
    return !!startUrl && !!p && p.hostname.endsWith(rootDomain(startUrl.hostname));
  };

  const NOISE_HOSTS = [
    'googletagmanager.com',
    'google-analytics.com',
    'googleapis.com', // includes translate.googleapis.com on D&G
    'gstatic.com',
    'doubleclick.net',
    'facebook.com',
    'fbcdn.net',
    'segment.io',
    'segment.com',
    'amplitude.com',
    'mixpanel.com',
    'datadoghq.com',
    'sentry.io',
    'newrelic.com',
    'cloudflareinsights.com',
    'rum.cloudflare.com',
  ];

  const NOISE_RESOURCE_TYPES = new Set([
    'Image',
    'Font',
    'Stylesheet',
    'Media',
    'Manifest',
    'Other',
  ]);

  const shrunkRequests = session.requests.filter((r) => {
    const url = safeUrl(r.url);
    if (!url) return false;
    if (NOISE_HOSTS.some((h) => url.hostname.endsWith(h)) && !sameOrigin(r.url)) return false;
    if (NOISE_RESOURCE_TYPES.has(r.resourceType)) return false;
    return true;
  });

  return {
    ...session,
    requests: shrunkRequests,
    // Cookie snapshots and events stay — they're small and the LLM can use
    // them for context.
  };
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
