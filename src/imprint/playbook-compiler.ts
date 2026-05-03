/**
 * `imprint compile-playbook <session>` — turn a recorded session into a
 * markdown playbook the runner (or any LLM agent with a browser tool)
 * can execute step-by-step.
 *
 * Mirrors generate.ts: feed the session to Vertex Claude with a system
 * prompt, validate the output, write it next to the session.
 *
 * The compiler shrinks the session to events + narration + a slim view
 * of the network requests (just enough for the LLM to know which XHR
 * carries the result). Full request bodies aren't needed — events
 * already encode user intent at the DOM level.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { LLM, loadConfig } from './llm.ts';
import { parsePlaybook } from './playbook-parser.ts';
import type { Playbook } from './playbook-types.ts';
import { redactSession } from './redact.ts';
import { type Session, SessionSchema } from './types.ts';

export interface CompilePlaybookOptions {
  sessionPath: string;
  outPath?: string;
  llmConfig?: Parameters<typeof loadConfig>[0];
}

export interface CompilePlaybookResult {
  playbook: Playbook;
  playbookPath: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

const PROMPT_PATH = pathJoin(import.meta.dir, '..', '..', 'prompts', 'playbook-compilation.md');

export async function compilePlaybook(
  opts: CompilePlaybookOptions,
): Promise<CompilePlaybookResult> {
  if (!existsSync(opts.sessionPath)) {
    throw new Error(`Session not found: ${opts.sessionPath}`);
  }
  const raw = JSON.parse(readFileSync(opts.sessionPath, 'utf8'));
  let session: Session = SessionSchema.parse(raw);

  // Same in-memory redaction guard as generate.ts — we never let
  // plaintext credentials reach the LLM.
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const r = redactSession(session);
    session = r.session;
    if (r.stats.totalRedactions > 0) {
      console.log(`[imprint] redacted ${r.stats.totalRedactions} value(s) before sending to LLM`);
    }
  }

  // Slim view: events + narration + XHR/Fetch summary. Response bodies are
  // included (truncated) so the LLM can identify the actual JSON shape of
  // the result-bearing XHR — without them it has to guess the extract path,
  // and gets it wrong (verified against Southwest: hallucinated nested keys
  // that don't exist).
  const RESPONSE_BODY_LIMIT = 4000;
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

  if (!existsSync(PROMPT_PATH)) {
    throw new Error(`Playbook compilation prompt not found at ${PROMPT_PATH}`);
  }
  const systemPrompt = readFileSync(PROMPT_PATH, 'utf8');

  console.log(
    `[imprint] compiling playbook from ${session.events.length} events / ${slim.requests.length} XHRs / ${session.narration.length} narration lines…`,
  );

  const llm = new LLM(loadConfig(opts.llmConfig));
  const result = await llm.analyze(systemPrompt, slim);

  // Strip code fences if the LLM wrapped the markdown in ```markdown ... ```
  const markdown = stripCodeFences(result.text).trim();

  let playbook: Playbook;
  try {
    playbook = parsePlaybook(markdown);
  } catch (err) {
    throw new Error(
      `Compiled playbook failed to parse: ${err instanceof Error ? err.message : String(err)}\n` +
        `Raw output:\n${markdown.slice(0, 1500)}`,
    );
  }

  const playbookPath = opts.outPath ?? pathJoin(dirname(opts.sessionPath), '..', 'playbook.md');
  writeFileSync(playbookPath, `${markdown}\n`);

  return {
    playbook,
    playbookPath,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  // ```markdown\n...\n```
  const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenced?.[1]) return fenced[1];
  return trimmed;
}
