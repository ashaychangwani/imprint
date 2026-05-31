/**
 * Headless-claude MCP audit harness — the acceptance gate for a site's
 * generated tools.
 *
 * `runAudit` discovers every tool a site exposes via `imprint mcp-server`,
 * spawns a headless `claude` session pointed at that real MCP server, and asks
 * it to exercise each tool and classify every invocation. The model returns a
 * structured report, but it never reports a score: imprint recomputes the score
 * deterministically from the model's per-invocation verdicts
 * (`computeAuditScore`) so the gate can't be talked up by a generous auditor.
 *
 * The harness is fully site-agnostic — the auditor derives every parameter from
 * each tool's schema + description. There is no per-site special-casing here.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { z } from 'zod';
import { preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { discoverTools } from './tool-loader.ts';
import { setSpanAttributes, traced } from './tracing.ts';

const log = createLog('audit');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

/** Default wall-clock cap for an audit session. */
const DEFAULT_AUDIT_TIMEOUT_MS = 20 * 60_000;

/** One invocation the auditor performed against a tool. */
const InvocationSchema = z.object({
  params: z.record(z.unknown()).default({}),
  ok: z.boolean(),
  verdict: z.enum(['correct', 'tool_broken', 'infra', 'bad_params']),
  reason: z.string().default(''),
});

const ToolAuditSchema = z.object({
  name: z.string(),
  invocations: z.array(InvocationSchema).default([]),
});

/** The single JSON object the auditor returns. Scoring is NOT taken from the
 *  model; only the per-invocation verdicts feed `computeAuditScore`. */
export const AuditReportSchema = z.object({
  tools: z.array(ToolAuditSchema).default([]),
  notes: z.string().default(''),
});

export type AuditReport = z.infer<typeof AuditReportSchema>;

interface AuditScore {
  score: number;
  correct: number;
  broken: number;
  infra: number;
  badParams: number;
  graded: number;
  verdict: 'pass' | 'fail' | 'inconclusive';
}

/**
 * Pure, deterministic scoring over the model's verdicts.
 *
 * - `correct` / `tool_broken` are the only graded verdicts; `graded` is their
 *   sum and the score's denominator. `infra` (anti-bot / rate-limit / network /
 *   timeout) and `bad_params` (the auditor's own mistake) are excluded so a
 *   blocked or misused tool isn't counted as a code bug.
 * - `score = 100 * correct / graded` (0 when nothing was gradeable).
 * - Verdict: no gradeable invocations → `inconclusive` (re-run / site blocked
 *   us, not a code fail). Otherwise `pass` requires both `score >= minScore`
 *   AND at least `2 * toolCount` gradeable invocations (enough signal to trust
 *   the number); anything else is `fail`.
 */
export function computeAuditScore(
  report: AuditReport,
  toolCount: number,
  minScore: number,
): AuditScore {
  let correct = 0;
  let broken = 0;
  let infra = 0;
  let badParams = 0;
  for (const tool of report.tools) {
    for (const inv of tool.invocations) {
      switch (inv.verdict) {
        case 'correct':
          correct++;
          break;
        case 'tool_broken':
          broken++;
          break;
        case 'infra':
          infra++;
          break;
        case 'bad_params':
          badParams++;
          break;
      }
    }
  }
  const graded = correct + broken;
  const score = graded === 0 ? 0 : (100 * correct) / graded;
  let verdict: AuditScore['verdict'];
  if (graded === 0) {
    verdict = 'inconclusive';
  } else if (score >= minScore && graded >= 2 * toolCount) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }
  return { score, correct, broken, infra, badParams, graded, verdict };
}

interface RunAuditOptions {
  site: string;
  minScore: number;
  outPath: string;
  model?: string;
  timeoutMs?: number;
  json?: boolean;
}

export async function runAudit(opts: RunAuditOptions): Promise<AuditScore> {
  return await traced(
    'audit.session',
    'AGENT',
    {
      'imprint.site': opts.site,
      'imprint.audit.min_score': opts.minScore,
    },
    async (span) => {
      const assetRoot = imprintHomeDir();
      const tools = await discoverTools(assetRoot, opts.site, '[imprint audit]');
      const toolCount = tools.length;
      if (toolCount === 0) {
        throw new Error(
          `No generated tool found for site "${opts.site}" — run \`imprint teach ${opts.site}\` first, then audit it.`,
        );
      }

      const model = opts.model ?? preferredAgentModel('claude-cli');
      const timeoutMs = opts.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
      const systemPromptPath = pathJoin(PROMPTS_DIR, 'audit-agent.md');
      if (!existsSync(systemPromptPath)) {
        throw new Error(
          `Audit system prompt not found at ${systemPromptPath}\n→ this is an Imprint installation problem; please file an issue at https://github.com/ashaychangwani/imprint/issues with the steps you ran.`,
        );
      }

      const toolNames = tools.map((t) => t.workflow.toolName);
      log(`auditing ${toolCount} tool(s) for site "${opts.site}": ${toolNames.join(', ')}`);

      const report = await driveAudit({
        site: opts.site,
        model,
        timeoutMs,
        systemPromptPath,
        toolNames,
      });

      const score = computeAuditScore(report, toolCount, opts.minScore);
      setSpanAttributes(span, {
        'imprint.audit.score': score.score,
        'imprint.audit.correct': score.correct,
        'imprint.audit.broken': score.broken,
        'imprint.audit.infra': score.infra,
        'imprint.audit.bad_params': score.badParams,
        'imprint.audit.graded': score.graded,
        'imprint.audit.tool_count': toolCount,
        'imprint.audit.verdict': score.verdict,
      });

      // Persist the full result (deterministic score + the raw model report).
      const persisted = {
        ...score,
        report,
        site: opts.site,
        toolCount,
        minScore: opts.minScore,
      };
      try {
        mkdirSync(dirname(opts.outPath), { recursive: true });
        writeFileSync(opts.outPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      } catch (err) {
        log(`failed to persist audit report to ${opts.outPath}: ${errMsg(err)}`);
      }

      if (opts.json) {
        console.log(JSON.stringify(persisted, null, 2));
      } else {
        printSummary(opts, score, toolCount);
      }

      return score;
    },
  );
}

interface DriveAuditOptions {
  site: string;
  model: string;
  timeoutMs: number;
  systemPromptPath: string;
  toolNames: string[];
}

/**
 * Spawn a headless `claude` session against the site's real MCP server, drive
 * it to completion, and recover the structured report from the final assistant
 * message. The real `mcp-server` has no write/submit tool, so the report must
 * ride back in the model's text — we extract the last fenced ```json block (or
 * the last balanced top-level object) and validate it. Any unrecoverable report
 * degrades to an empty (→ inconclusive) report rather than crashing the gate.
 */
async function driveAudit(opts: DriveAuditOptions): Promise<AuditReport> {
  // Distinct from the persistent `imprint-<site>` server that `imprint teach`
  // registers with Claude Code: a same-named inline server collides and claude
  // marks ours "disabled" (even under --strict-mcp-config), leaving the auditor
  // with zero tools. The `imprint-audit-` prefix keeps the inline server unique.
  const serverName = `imprint-audit-${opts.site}`;
  const bunPath = process.execPath;
  const mcpConfig = {
    mcpServers: {
      [serverName]: {
        command: bunPath,
        args: ['run', CLI_PATH, 'mcp-server', opts.site],
      },
    },
  };

  const allowedToolArgs: string[] = [];
  for (const name of opts.toolNames) {
    allowedToolArgs.push('--allowedTools', `mcp__${serverName}__${name}`);
  }

  const initialPrompt = `Audit every MCP tool connected to you for the site "${opts.site}".

There are ${opts.toolNames.length} connected tool(s). For each one: read its description and input schema, invoke it with a realistic parameter set plus one or two edge cases (all derived only from the schema and description), judge each result, and classify each invocation as correct | tool_broken | infra | bad_params per your system prompt.

When you are done, end your final message with exactly one fenced \`\`\`json block containing the full report and nothing after it.`;

  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--system-prompt-file',
    opts.systemPromptPath,
    // Disable the built-in tool set so claude only uses the site's MCP tools.
    '--tools',
    '',
    ...allowedToolArgs,
    '--max-turns',
    '200',
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--effort',
    'high',
    '--model',
    opts.model,
    initialPrompt,
  ];

  log(`spawning claude (model=${opts.model}, mcp-server=${serverName})`);

  let child: ChildProcess;
  try {
    child = spawn('claude', args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log(`failed to spawn claude: ${errMsg(err)}`);
    return AuditReportSchema.parse({});
  }

  const assistantText = await collectAssistantText(child, opts.timeoutMs);
  const report = extractReport(assistantText);
  if (!report) {
    log('no valid audit report recovered from the auditor — treating as inconclusive');
    return AuditReportSchema.parse({});
  }
  return report;
}

/** Drain the stream-json events, accumulating assistant text, and resolve when
 *  the child exits. Enforces the wall-clock timeout by killing the child. */
async function collectAssistantText(child: ChildProcess, timeoutMs: number): Promise<string> {
  const chunks: string[] = [];
  let resultText = '';
  let stdoutBuf = '';
  let killed = false;

  const timer = setTimeout(() => {
    killed = true;
    log(`audit exceeded ${Math.round(timeoutMs / 60_000)} minute deadline, terminating claude`);
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    } catch {
      // already gone
    }
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    while (true) {
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;

      let evt: StreamJsonEvent;
      try {
        evt = JSON.parse(line) as StreamJsonEvent;
      } catch {
        continue;
      }

      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            chunks.push(block.text);
          }
        }
      } else if (evt.type === 'result' && typeof evt.result === 'string') {
        // The terminal result event carries the final assistant message verbatim.
        resultText = evt.result;
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    log(`[claude stderr] ${chunk.toString('utf8').trim()}`);
  });

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (err) => {
      log(`claude process error: ${errMsg(err)}`);
      resolve();
    });
  });
  clearTimeout(timer);
  if (killed) log('audit session was terminated by the deadline guard');

  // Prefer the terminal result event (the complete final message); fall back to
  // the concatenated streamed assistant text if the result event was absent.
  return resultText || chunks.join('\n');
}

interface StreamJsonEvent {
  type: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
  result?: string;
}

/**
 * Recover the structured report from the auditor's text. Prefers the LAST
 * fenced ```json block (the system prompt requires the report to be the final
 * thing in the message); falls back to the last balanced top-level {…} object.
 * Returns undefined when nothing parses + validates.
 */
export function extractReport(text: string): AuditReport | undefined {
  if (!text) return undefined;
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const result = AuditReportSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Yield JSON candidate strings best-first: every ```json fenced block (last
 *  one first), then balanced top-level {…} objects (last one first). */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fenced: string[] = [];
  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    if (match[1]) fenced.push(match[1].trim());
  }
  out.push(...fenced.reverse());
  out.push(...balancedObjects(text).reverse());
  return out;
}

/** Extract every balanced top-level {…} substring (brace-depth scan, ignoring
 *  braces inside strings). Good enough to recover an un-fenced final object. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function printSummary(opts: RunAuditOptions, score: AuditScore, toolCount: number): void {
  const pct = score.graded === 0 ? 'n/a' : `${score.score.toFixed(1)}%`;
  console.log(`[imprint] audit "${opts.site}" — ${score.verdict.toUpperCase()}`);
  console.log(
    `[imprint]   score ${pct} (${score.correct} correct / ${score.broken} broken; threshold ${opts.minScore}%)`,
  );
  console.log(
    `[imprint]   graded ${score.graded} of ${score.correct + score.broken + score.infra + score.badParams} invocation(s) across ${toolCount} tool(s) — excluded: ${score.infra} infra, ${score.badParams} bad_params`,
  );
  if (score.verdict === 'inconclusive') {
    console.log(
      '[imprint]   no gradeable invocations (likely anti-bot / network) — re-run; this is not a code failure.',
    );
  }
  console.log(`[imprint]   report → ${opts.outPath}`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
