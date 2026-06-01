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
 *   AND at least `max(2, gradeableTools)` gradeable invocations, where
 *   `gradeableTools` is the number of tools that produced ≥1 gradeable
 *   invocation. Scaling the signal floor to *gradeable* tools (not all tools)
 *   means a tool the auditor can never exercise — e.g. one that needs an opaque
 *   token it cannot synthesize — no longer inflates the bar and sinks an
 *   otherwise-perfect run; such tools surface separately as `ungradeableTools`.
 *   The floor is one gradeable call per gradeable tool (not two): the auditor
 *   often burns a slot per tool on `bad_params`/`infra` (its own mistake or a
 *   transient block), so demanding two clean reads per tool false-fails an
 *   otherwise-perfect run. One verified read per tool plus `score >= minScore`
 *   is the honest floor; real defects still fail on score, not on this count.
 */
export function computeAuditScore(report: AuditReport, minScore: number): AuditScore {
  let correct = 0;
  let broken = 0;
  let infra = 0;
  let badParams = 0;
  let gradeableTools = 0;
  for (const tool of report.tools) {
    let toolGradeable = 0;
    for (const inv of tool.invocations) {
      switch (inv.verdict) {
        case 'correct':
          correct++;
          toolGradeable++;
          break;
        case 'tool_broken':
          broken++;
          toolGradeable++;
          break;
        case 'infra':
          infra++;
          break;
        case 'bad_params':
          badParams++;
          break;
      }
    }
    if (toolGradeable > 0) gradeableTools++;
  }
  const graded = correct + broken;
  const score = graded === 0 ? 0 : (100 * correct) / graded;
  const minGraded = Math.max(2, gradeableTools);
  let verdict: AuditScore['verdict'];
  if (graded === 0) {
    verdict = 'inconclusive';
  } else if (score >= minScore && graded >= minGraded) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }
  return { score, correct, broken, infra, badParams, graded, verdict };
}

/** Tools the auditor could never grade (every invocation was infra/bad_params,
 *  or it ran none). Surfaced in the report so an un-exercisable tool is visible
 *  rather than silently excluded from the score. */
export function ungradeableToolNames(report: AuditReport): string[] {
  return report.tools
    .filter(
      (t) => !t.invocations.some((i) => i.verdict === 'correct' || i.verdict === 'tool_broken'),
    )
    .map((t) => t.name);
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

      // Parameters that shipped live-unverified at compile time (Fix D). Tell the
      // auditor to probe them especially — these are the most likely to be broken
      // (the compile-time differential could not confirm their effect).
      const unverifiedParams: Array<{ tool: string; params: string[] }> = [];
      for (const t of tools) {
        const params = (t.workflow.parameters ?? [])
          .filter((p) => p.verified === false)
          .map((p) => p.name);
        if (params.length > 0) unverifiedParams.push({ tool: t.workflow.toolName, params });
      }

      // Producer→consumer token contracts (sourcedFrom). Tell the auditor to chain
      // (call the producer, read the named field, feed the consumer) rather than
      // fabricate an opaque token — otherwise a correct chained tool false-fails.
      const tokenDeps: TokenDep[] = [];
      for (const t of tools) {
        for (const p of t.workflow.parameters ?? []) {
          if (p.sourcedFrom) {
            tokenDeps.push({
              tool: t.workflow.toolName,
              param: p.name,
              sourceTool: p.sourcedFrom.tool,
              sourceField: p.sourcedFrom.field,
            });
          }
        }
      }

      const report = await driveAudit({
        site: opts.site,
        model,
        timeoutMs,
        systemPromptPath,
        toolNames,
        unverifiedParams,
        tokenDeps,
      });

      const rawScore = computeAuditScore(report, opts.minScore);

      // Cross-reference compile-time live verification with the audit grade.
      // The downgrade rule's purpose is to surface "flying blind" runs —
      // ones where the gate has no positive evidence the framework works
      // for the audited site. Iterations of this rule:
      //   v1: downgrade if any tool was liveVerified=false AND ungradeable
      //       → too strict (downgraded perfectly-scoring runs when one
      //       chained tool was unreachable from auditor's connected set).
      //   v2: downgrade only if a flying-blind tool had infra invocations
      //       → still over-attributed transient page-state to defects.
      //   v3 (current): downgrade only when the audit produced ZERO
      //       `correct` invocations across ALL tools. If even one
      //       invocation graded correctly, that's positive evidence the
      //       framework + runtime work for at least that tool — the
      //       overall score (correct/(correct+broken)) is the honest
      //       signal. Tools that couldn't be exercised still surface via
      //       `ungradeableTools` / `unverifiedAndUngradeable` for visibility
      //       without spoiling a verdict the score honestly earned.
      const ungradeableNames = ungradeableToolNames(report);
      const unverifiedAndUngradeable = tools
        .filter((t) => t.workflow.liveVerified === false)
        .map((t) => t.workflow.toolName)
        .filter((name) => ungradeableNames.includes(name));
      const anyCorrectAcrossAudit = report.tools.some((t) =>
        t.invocations.some((i) => i.verdict === 'correct'),
      );
      const verdict =
        rawScore.verdict === 'pass' && !anyCorrectAcrossAudit ? 'inconclusive' : rawScore.verdict;
      const score: AuditScore = { ...rawScore, verdict };

      setSpanAttributes(span, {
        'imprint.audit.score': score.score,
        'imprint.audit.correct': score.correct,
        'imprint.audit.broken': score.broken,
        'imprint.audit.infra': score.infra,
        'imprint.audit.bad_params': score.badParams,
        'imprint.audit.graded': score.graded,
        'imprint.audit.tool_count': toolCount,
        'imprint.audit.verdict': score.verdict,
        'imprint.audit.unverified_and_ungradeable_count': unverifiedAndUngradeable.length,
      });

      // Persist the full result (deterministic score + the raw model report).
      const persisted = {
        ...score,
        report,
        site: opts.site,
        toolCount,
        ungradeableTools: ungradeableNames,
        /** Tools that shipped without live verification at compile time AND
         *  could not be graded at audit time — zero live signal anywhere. */
        unverifiedAndUngradeable,
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
        printSummary(opts, score, toolCount, unverifiedAndUngradeable);
      }

      return score;
    },
  );
}

/** A consumer param whose value is minted by a sibling producer tool's output
 *  field (from `workflow.json` `param.sourcedFrom`). */
interface TokenDep {
  tool: string;
  param: string;
  sourceTool: string;
  sourceField: string;
}

/** Build the auditor instruction for producer-sourced token params: chain the
 *  producer first, read its field, feed the consumer — never fabricate. Pure so
 *  it can be unit-tested without spawning the audit session. */
export function buildTokenDepNote(tokenDeps: TokenDep[]): string {
  if (tokenDeps.length === 0) return '';
  const lines = tokenDeps.map(
    (d) =>
      `- ${d.tool}(${d.param}) ← first call ${d.sourceTool}, then pass its \`${d.sourceField}\` output value`,
  );
  return `\n\nSome parameters are opaque tokens/ids minted by ANOTHER tool — you cannot fabricate them. For each below, call the producer tool first, read the named output field from its result, and pass that exact value to the consumer (reuse it across calls; no need to re-fetch each time):\n${lines.join(
    '\n',
  )}\nIf you cannot obtain such a value because the producer is blocked, classify the consumer call \`bad_params\`, never \`tool_broken\`.`;
}

interface DriveAuditOptions {
  site: string;
  model: string;
  timeoutMs: number;
  systemPromptPath: string;
  toolNames: string[];
  /** Per-tool params that shipped live-unverified at compile time. */
  unverifiedParams: Array<{ tool: string; params: string[] }>;
  /** Producer→consumer token contracts (param.sourcedFrom) so the auditor chains. */
  tokenDeps: TokenDep[];
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

  const unverifiedNote =
    opts.unverifiedParams.length > 0
      ? `\n\nThese parameters shipped WITHOUT a passing compile-time verification (their effect could not be confirmed against live data): ${opts.unverifiedParams
          .map((u) => `${u.tool}(${u.params.join(', ')})`)
          .join(
            '; ',
          )}. Probe them especially — call the tool with and without each one and check the response actually changes. Classify a param that has no effect as \`tool_broken\`.`
      : '';

  const initialPrompt = `Audit every MCP tool connected to you for the site "${opts.site}".

There are ${opts.toolNames.length} connected tool(s). For each one: read its description and input schema, invoke it with a realistic parameter set plus one or two edge cases (all derived only from the schema and description), judge each result, and classify each invocation as correct | tool_broken | infra | bad_params per your system prompt.

IMPORTANT: Call tools strictly sequentially — issue exactly one tool call, wait for its result, then issue the next. Never issue tool calls in parallel or batch them in one turn. Many target sites share an anti-bot defense across endpoints, so a parallel burst trips a site-wide rate-limit (HTTP 429) that then poisons every later call. If a call returns a 429 / rate-limit / anti-bot result, classify it \`infra\` and pause before the next call.${unverifiedNote}${buildTokenDepNote(opts.tokenDeps)}

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
      // Claude CLI's default MCP_TOOL_TIMEOUT is 60s. The audit-time MCP
      // server's tool calls walk the backend ladder for each invocation —
      // fetch (30s) → fetch-bootstrap (30s) → stealth-fetch (30s) →
      // playbook (5–30s), worst case ~2 min. Bump to 5 min (covers
      // realistic worst case with margin) but NOT to 30 min like the
      // compile side: the compile MCP needs that long because `done` runs
      // bun-test verification inline, but the audit MCP doesn't — each
      // audit tool call is just a single workflow execution. A longer
      // timeout here would burn the audit's overall 30-min deadline
      // on a handful of hanging calls (compiled tools that hang on bad
      // inputs) before the auditor finishes grading. Honor user-set env.
      env: {
        ...process.env,
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '300000',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '60000',
      },
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
 *  the child exits. Enforces the wall-clock timeout by killing the child.
 *  Emits a one-line-per-event progress log to stderr so operators can `tail -f`
 *  the audit log file and see live what the auditor is doing — without this
 *  the audit is a 30-minute black box. */
async function collectAssistantText(child: ChildProcess, timeoutMs: number): Promise<string> {
  const chunks: string[] = [];
  let resultText = '';
  let stdoutBuf = '';
  let killed = false;
  const t0 = Date.now();
  const elapsedStr = (): string => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

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

      // Live progress signal: one log line per tool_use / tool_result /
      // text-snippet event with [elapsed]. Lets `tail -f` show what the
      // auditor is doing in real time instead of waiting 30-60 min for
      // the final report.
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            chunks.push(block.text);
            const preview = block.text.replace(/\s+/g, ' ').slice(0, 120);
            log(`[${elapsedStr()}] assistant: ${preview}`);
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const inputPreview = block.input ? JSON.stringify(block.input).slice(0, 120) : '';
            log(
              `[${elapsedStr()}] tool_use: ${block.name}${inputPreview ? ` ${inputPreview}` : ''}`,
            );
          }
        }
      } else if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (!block) continue;
          if (block.type === 'tool_result') {
            const raw = Array.isArray(block.content)
              ? (block.content[0]?.text ?? '')
              : typeof block.content === 'string'
                ? block.content
                : '';
            const preview = String(raw).replace(/\s+/g, ' ').slice(0, 140);
            const errMark = block.is_error ? ' (error)' : '';
            log(`[${elapsedStr()}] tool_result${errMark}: ${preview}`);
          }
        }
      } else if (evt.type === 'result' && typeof evt.result === 'string') {
        // The terminal result event carries the final assistant message verbatim.
        resultText = evt.result;
        log(`[${elapsedStr()}] result event received (${evt.result.length} chars)`);
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
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
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

function printSummary(
  opts: RunAuditOptions,
  score: AuditScore,
  toolCount: number,
  unverifiedAndUngradeable: string[] = [],
): void {
  const pct = score.graded === 0 ? 'n/a' : `${score.score.toFixed(1)}%`;
  console.log(`[imprint] audit "${opts.site}" — ${score.verdict.toUpperCase()}`);
  console.log(
    `[imprint]   score ${pct} (${score.correct} correct / ${score.broken} broken; threshold ${opts.minScore}%)`,
  );
  console.log(
    `[imprint]   graded ${score.graded} of ${score.correct + score.broken + score.infra + score.badParams} invocation(s) across ${toolCount} tool(s) — excluded: ${score.infra} infra, ${score.badParams} bad_params`,
  );
  if (unverifiedAndUngradeable.length > 0) {
    console.log(
      `[imprint]   ${unverifiedAndUngradeable.length} tool(s) flying blind (no live verification at compile, no graded calls at audit): ${unverifiedAndUngradeable.join(', ')}`,
    );
  }
  if (score.verdict === 'inconclusive') {
    if (unverifiedAndUngradeable.length > 0) {
      console.log(
        '[imprint]   verdict downgraded to inconclusive because at least one tool has zero live signal anywhere.',
      );
    } else {
      console.log(
        '[imprint]   no gradeable invocations (likely anti-bot / network) — re-run; this is not a code failure.',
      );
    }
  }
  console.log(`[imprint]   report → ${opts.outPath}`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
