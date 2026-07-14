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
import { type ProviderName, preferredAgentModel } from './llm.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { discoverTools } from './tool-loader.ts';
import { llmSpanAttributes, setSpanAttributes, totalPromptTokens, traced } from './tracing.ts';

const log = createLog('audit');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const CLI_PATH = pathJoin(REPO_ROOT, 'src', 'cli.ts');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

/** Default wall-clock cap for an audit session. This is a CAP, not a fixed
 *  duration: fast sites finish their full differential param sweep and exit
 *  early. The cap only bites on genuinely blocked or high-latency sites. Cold
 *  cdp-replay startup can be expensive, but warm calls usually reuse the live
 *  browser pool and should not be treated as equally expensive. */
const DEFAULT_AUDIT_TIMEOUT_MS = 45 * 60_000;

/** One invocation the auditor performed against a tool. */
const InvocationSchema = z.object({
  params: z.record(z.unknown()).default({}),
  ok: z.boolean(),
  verdict: z.enum(['correct', 'tool_broken', 'infra', 'bad_params']),
  reason: z.string().default(''),
});

/** Per-parameter differential verdict. The auditor calls the tool once at a
 *  baseline, then once with ONLY this parameter changed to a value expected to
 *  alter the result, and compares:
 *   - `works`       — the result changed as the description promises.
 *   - `no_op`       — the result was unchanged → the parameter is inert.
 *   - `broken`      — the result changed wrongly (corrupted/emptied/nonsense).
 *   - `untestable`  — no distinct valid value could be constructed, the tool is
 *                     state-changing, or repeated paced probes stayed blocked.
 *  `works` grades correct; `no_op`/`broken` grade as defects ("no-op is not a
 *  free pass"); `untestable` is surfaced but not scored. */
const ParameterAuditSchema = z.object({
  name: z.string(),
  verdict: z.enum(['works', 'no_op', 'broken', 'untestable']),
  reason: z.string().default(''),
});

const ToolAuditSchema = z.object({
  name: z.string(),
  invocations: z.array(InvocationSchema).default([]),
  parameters: z.array(ParameterAuditSchema).default([]),
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
  /** Per-parameter differential tallies (folded into correct/broken/graded
   *  above; broken out here for the report). `untestable` is surfaced only. */
  paramsWorking: number;
  paramsNoOp: number;
  paramsBroken: number;
  paramsUntestable: number;
  /** `timeout` is set by `runAudit` (not `computeAuditScore`) when the session
   *  was killed by the deadline guard — a cut-off run is never a trustworthy
   *  pass, even if the partial verdicts would have scored one. */
  verdict: 'pass' | 'fail' | 'inconclusive' | 'timeout';
}

/**
 * Pure, deterministic scoring over the model's verdicts.
 *
 * - `correct` / `tool_broken` invocation verdicts grade core tool behavior; the
 *   per-parameter differential verdicts grade each advertised parameter and fold
 *   into the SAME accumulator: `works` → correct, `no_op`/`broken` → broken
 *   ("no-op is not a free pass"), `untestable` → surfaced but not scored.
 *   `graded` is correct + broken (invocations + params). `infra` (anti-bot /
 *   rate-limit / network / timeout) and `bad_params` (the auditor's own mistake)
 *   are excluded so a blocked or misused tool isn't counted as a code bug.
 * - `score = 100 * correct / graded` (0 when nothing was gradeable).
 * - Verdict: no gradeable invocations → `inconclusive` (re-run / site blocked
 *   us, not a code fail). Otherwise `pass` requires both `score >= minScore`
 *   AND at least one gradeable unit per gradeable tool, where
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
  let paramsWorking = 0;
  let paramsNoOp = 0;
  let paramsBroken = 0;
  let paramsUntestable = 0;
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
    for (const param of tool.parameters) {
      switch (param.verdict) {
        case 'works':
          paramsWorking++;
          correct++;
          toolGradeable++;
          break;
        case 'no_op':
          paramsNoOp++;
          broken++;
          toolGradeable++;
          break;
        case 'broken':
          paramsBroken++;
          broken++;
          toolGradeable++;
          break;
        case 'untestable':
          paramsUntestable++;
          break;
      }
    }
    if (toolGradeable > 0) gradeableTools++;
  }
  const graded = correct + broken;
  const score = graded === 0 ? 0 : (100 * correct) / graded;
  const minGraded = Math.max(1, gradeableTools);
  let verdict: AuditScore['verdict'];
  if (graded === 0) {
    verdict = 'inconclusive';
  } else if (score >= minScore && graded >= minGraded) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }
  return {
    score,
    correct,
    broken,
    infra,
    badParams,
    graded,
    paramsWorking,
    paramsNoOp,
    paramsBroken,
    paramsUntestable,
    verdict,
  };
}

function toolHasGradeableAuditSignal(tool: AuditReport['tools'][number]): boolean {
  return (
    tool.invocations.some((i) => i.verdict === 'correct' || i.verdict === 'tool_broken') ||
    tool.parameters.some(
      (p) => p.verdict === 'works' || p.verdict === 'no_op' || p.verdict === 'broken',
    )
  );
}

export function auditHasCorrectSignal(report: AuditReport): boolean {
  return report.tools.some(
    (t) =>
      t.invocations.some((i) => i.verdict === 'correct') ||
      t.parameters.some((p) => p.verdict === 'works'),
  );
}

/** Tools the auditor could never grade (every invocation was infra/bad_params
 *  and every parameter was untestable/absent). Surfaced in the report so an
 *  un-exercisable tool is visible rather than silently excluded from the score. */
export function ungradeableToolNames(report: AuditReport): string[] {
  return report.tools.filter((t) => !toolHasGradeableAuditSignal(t)).map((t) => t.name);
}

/** Advertised parameters the auditor could not differentially test (opaque enum
 *  with no constructible value, or a state-changing/bot-defended tool). Surfaced
 *  so an unverifiable parameter is visible rather than silently passing. */
export function untestableParams(
  report: AuditReport,
): Array<{ tool: string; name: string; reason: string }> {
  const out: Array<{ tool: string; name: string; reason: string }> = [];
  for (const tool of report.tools) {
    for (const param of tool.parameters) {
      if (param.verdict === 'untestable') {
        out.push({ tool: tool.name, name: param.name, reason: param.reason });
      }
    }
  }
  return out;
}

interface RunAuditOptions {
  site: string;
  minScore: number;
  outPath: string;
  provider?: ProviderName;
  model?: string;
  timeoutMs?: number;
  json?: boolean;
}

export function buildAuditMcpEnvironment(assetRoot = imprintHomeDir()): Record<string, string> {
  return {
    // Codex MCP server `env` entries are an explicit environment, so relying on
    // the audit driver's inherited IMPRINT_HOME can make an isolated audit
    // silently fall back to ~/.imprint and expose stale tools.
    IMPRINT_HOME: assetRoot,
    IMPRINT_AUDIT_PACING_MS: '5000',
    IMPRINT_AUDIT_TOOL_DEADLINE_MS: '120000',
  };
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

      const provider = opts.provider ?? 'claude-cli';
      const model = opts.model ?? preferredAgentModel(provider);
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

      const drive = await driveAudit({
        site: opts.site,
        provider,
        model,
        timeoutMs,
        systemPromptPath,
        toolNames,
        unverifiedParams,
        tokenDeps,
      });

      const rawScore = computeAuditScore(drive.report, opts.minScore);

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
      const ungradeableNames = ungradeableToolNames(drive.report);
      const untestableParamList = untestableParams(drive.report);
      const unverifiedAndUngradeable = tools
        .filter((t) => t.workflow.liveVerified === false)
        .map((t) => t.workflow.toolName)
        .filter((name) => ungradeableNames.includes(name));
      const anyCorrectAcrossAudit = auditHasCorrectSignal(drive.report);
      let verdict = rawScore.verdict;
      // Timeout takes precedence over inconclusive downgrade.
      if (drive.timedOut) {
        verdict = 'timeout';
      } else if (rawScore.verdict === 'pass' && !anyCorrectAcrossAudit) {
        verdict = 'inconclusive';
      }
      const score: AuditScore = { ...rawScore, verdict };

      // Persist the auditor transcript next to the report so a stuck/killed run
      // can be inspected after the fact.
      let transcriptPath: string | undefined;
      if (drive.transcript) {
        transcriptPath = pathJoin(dirname(opts.outPath), '.audit-transcript.txt');
        try {
          mkdirSync(dirname(transcriptPath), { recursive: true });
          writeFileSync(transcriptPath, `${drive.transcript}\n`, 'utf8');
        } catch (err) {
          log(`failed to persist audit transcript to ${transcriptPath}: ${errMsg(err)}`);
          transcriptPath = undefined;
        }
      }

      // TOTAL prompt (uncached + cache) for the cost calc; the cache split is
      // passed to llmSpanAttributes separately. Always a number here
      // (drive.inputTokens is non-null), so the cost-suppression happens via the
      // `|| undefined` at the call site below.
      const totalInputTokens = totalPromptTokens(
        drive.inputTokens,
        drive.cacheReadInputTokens,
        drive.cacheCreationInputTokens,
      );
      setSpanAttributes(span, {
        'imprint.audit.score': score.score,
        'imprint.audit.correct': score.correct,
        'imprint.audit.broken': score.broken,
        'imprint.audit.infra': score.infra,
        'imprint.audit.bad_params': score.badParams,
        'imprint.audit.graded': score.graded,
        'imprint.audit.params_working': score.paramsWorking,
        'imprint.audit.params_no_op': score.paramsNoOp,
        'imprint.audit.params_broken': score.paramsBroken,
        'imprint.audit.params_untestable': score.paramsUntestable,
        'imprint.audit.tool_count': toolCount,
        'imprint.audit.verdict': score.verdict,
        'imprint.audit.unverified_and_ungradeable_count': unverifiedAndUngradeable.length,
        'imprint.audit.timed_out': drive.timedOut,
        'imprint.audit.turns': drive.turns,
        ...(drive.totalCostUsd != null ? { 'imprint.audit.cost_usd': drive.totalCostUsd } : {}),
        ...llmSpanAttributes({
          provider,
          model,
          // `|| undefined`: when no usage was captured (e.g. spawn failure → 0
          // tokens), suppress a bogus $0 cost instead of emitting it.
          inputTokens: totalInputTokens || undefined,
          outputTokens: drive.outputTokens || undefined,
          cacheReadTokens: drive.cacheReadInputTokens || undefined,
          cacheWriteTokens: drive.cacheCreationInputTokens || undefined,
        }),
      });

      // Persist the full result (deterministic score + the raw model report).
      const persisted = {
        ...score,
        report: drive.report,
        site: opts.site,
        toolCount,
        ungradeableTools: ungradeableNames,
        /** Advertised parameters the auditor could not differentially test. */
        untestableParams: untestableParamList,
        /** Tools that shipped without live verification at compile time AND
         *  could not be graded at audit time — zero live signal anywhere. */
        unverifiedAndUngradeable,
        minScore: opts.minScore,
        timedOut: drive.timedOut,
        turns: drive.turns,
        costUsd: drive.totalCostUsd,
        inputTokens: drive.inputTokens,
        outputTokens: drive.outputTokens,
        cacheReadInputTokens: drive.cacheReadInputTokens,
        cacheCreationInputTokens: drive.cacheCreationInputTokens,
        transcriptPath,
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
        printSummary(opts, score, toolCount, {
          timedOut: drive.timedOut,
          timeoutMs,
          transcriptPath,
          costUsd: drive.totalCostUsd,
          unverifiedAndUngradeable,
          report: drive.report,
        });
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

/** Build the auditor instruction for producer-sourced params: chain the
 *  producer first, read its field, feed the consumer — never fabricate. Pure so
 *  it can be unit-tested without spawning the audit session. */
export function buildTokenDepNote(tokenDeps: TokenDep[]): string {
  if (tokenDeps.length === 0) return '';
  const lines = tokenDeps.map(
    (d) =>
      `- ${d.tool}(${d.param}) ← first call ${d.sourceTool}, then pass its \`${d.sourceField}\` output value`,
  );
  return `\n\nSome parameters are values minted or derived by ANOTHER tool — you cannot fabricate them. For each below, call the producer tool first, read the named output field from its result, and pass that exact value to the consumer (reuse it across calls; no need to re-fetch each time):\n${lines.join(
    '\n',
  )}\nIf you cannot obtain such a value because the producer is blocked, classify the consumer call \`bad_params\`, never \`tool_broken\`.`;
}

interface DriveAuditOptions {
  site: string;
  provider: ProviderName;
  model: string;
  timeoutMs: number;
  systemPromptPath: string;
  toolNames: string[];
  /** Per-tool params that shipped live-unverified at compile time. */
  unverifiedParams: Array<{ tool: string; params: string[] }>;
  /** Producer→consumer token contracts (param.sourcedFrom) so the auditor chains. */
  tokenDeps: TokenDep[];
}

interface DriveAuditResult {
  report: AuditReport;
  /** False when no report parsed (empty report substituted). */
  reportRecovered: boolean;
  timedOut: boolean;
  turns: number;
  /** Full assistant transcript for diagnosis (empty if the session never spoke). */
  transcript: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Authoritative cost from the claude CLI's `result` event, when reported. */
  totalCostUsd: number | null;
}

/** A DriveAuditResult with no session data — spawn failure or an empty run. */
function emptyDriveAuditResult(): DriveAuditResult {
  return {
    report: AuditReportSchema.parse({}),
    reportRecovered: false,
    timedOut: false,
    turns: 0,
    transcript: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: null,
  };
}

/**
 * Spawn a headless audit session against the site's real MCP server, drive
 * it to completion, and recover the structured report from the final assistant
 * message. The real `mcp-server` has no write/submit tool, so the report must
 * ride back in the model's text — we extract the last fenced ```json block (or
 * the last balanced top-level object) and validate it. Any unrecoverable report
 * degrades to an empty (→ inconclusive) report rather than crashing the gate.
 */
async function driveAudit(opts: DriveAuditOptions): Promise<DriveAuditResult> {
  if (opts.provider === 'codex-cli') return driveAuditWithCodex(opts);
  if (opts.provider !== 'claude-cli') {
    log(`audit provider "${opts.provider}" is not supported — use claude-cli or codex-cli`);
    return emptyDriveAuditResult();
  }
  return driveAuditWithClaude(opts);
}

async function driveAuditWithClaude(opts: DriveAuditOptions): Promise<DriveAuditResult> {
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
        // Pace every audit tool call: the auditor now differentially probes
        // bot-defended idempotent reads (search/calendar) instead of bailing
        // after one call, so a deliberate inter-call delay keeps the probing
        // steady enough that the per-IP anti-bot defense isn't tripped. Only
        // the audit sets this; production mcp-server runs unpaced.
        env: { IMPRINT_AUDIT_PACING_MS: '5000', IMPRINT_AUDIT_TOOL_DEADLINE_MS: '120000' },
      },
    },
  };

  const allowedToolArgs: string[] = [];
  for (const name of opts.toolNames) {
    allowedToolArgs.push('--allowedTools', `mcp__${serverName}__${name}`);
  }

  const unverifiedNote = buildUnverifiedParamNote(opts.unverifiedParams);

  const initialPrompt = buildAuditInitialPrompt(opts, unverifiedNote);

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
    return emptyDriveAuditResult();
  }

  const session = await collectAssistantText(child, opts.timeoutMs);
  const report = extractReport(session.text);
  if (!report) {
    log(
      session.timedOut
        ? 'audit hit the deadline before producing a report — treating as timeout'
        : 'no valid audit report recovered from the auditor — treating as inconclusive',
    );
  }
  return {
    report: report ?? AuditReportSchema.parse({}),
    reportRecovered: report !== undefined,
    timedOut: session.timedOut,
    turns: session.turns,
    transcript: session.transcript,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheReadInputTokens: session.cacheReadInputTokens,
    cacheCreationInputTokens: session.cacheCreationInputTokens,
    totalCostUsd: session.totalCostUsd,
  };
}

async function driveAuditWithCodex(opts: DriveAuditOptions): Promise<DriveAuditResult> {
  const serverName = `imprint-audit-${opts.site}`;
  const bunPath = process.execPath;
  const mcpArgs = ['run', CLI_PATH, 'mcp-server', opts.site];
  const mcpEnv = buildAuditMcpEnvironment();

  const unverifiedNote = buildUnverifiedParamNote(opts.unverifiedParams);
  const initialPrompt = `<system_instructions>
${await Bun.file(opts.systemPromptPath).text()}
</system_instructions>

${buildAuditInitialPrompt(opts, unverifiedNote)}`;

  const args = [
    '-a',
    'never',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C',
    REPO_ROOT,
    '-s',
    'workspace-write',
    '-m',
    opts.model,
    '-c',
    `mcp_servers.${serverName}.command=${JSON.stringify(bunPath)}`,
    '-c',
    `mcp_servers.${serverName}.args=${JSON.stringify(mcpArgs)}`,
    '-c',
    `mcp_servers.${serverName}.default_tools_approval_mode=${JSON.stringify('approve')}`,
    '-c',
    `mcp_servers.${serverName}.tool_timeout_sec=300`,
    '-c',
    `mcp_servers.${serverName}.env.IMPRINT_HOME=${JSON.stringify(mcpEnv.IMPRINT_HOME)}`,
    '-c',
    `mcp_servers.${serverName}.env.IMPRINT_AUDIT_PACING_MS=${JSON.stringify(mcpEnv.IMPRINT_AUDIT_PACING_MS)}`,
    '-c',
    `mcp_servers.${serverName}.env.IMPRINT_AUDIT_TOOL_DEADLINE_MS=${JSON.stringify(mcpEnv.IMPRINT_AUDIT_TOOL_DEADLINE_MS)}`,
    '-c',
    'shell_environment_policy.inherit=all',
    '-',
  ];

  log(`spawning codex (model=${opts.model}, mcp-server=${serverName})`);

  let child: ChildProcess;
  try {
    child = spawn('codex', args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...mcpEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    log(`failed to spawn codex-cli: ${errMsg(err)}`);
    return emptyDriveAuditResult();
  }

  try {
    child.stdin?.end(initialPrompt);
  } catch (err) {
    log(`failed to send prompt to codex-cli: ${errMsg(err)}`);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    return emptyDriveAuditResult();
  }

  const session = await collectCodexAssistantText(child, opts.timeoutMs);
  const report = extractReport(session.text);
  if (!report) {
    log(
      session.timedOut
        ? 'audit hit the deadline before producing a report — treating as timeout'
        : 'no valid audit report recovered from the auditor — treating as inconclusive',
    );
  }
  return {
    report: report ?? AuditReportSchema.parse({}),
    reportRecovered: report !== undefined,
    timedOut: session.timedOut,
    turns: session.turns,
    transcript: session.transcript,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: null,
  };
}

export function buildUnverifiedParamNote(
  unverifiedParams: Array<{ tool: string; params: string[] }>,
): string {
  if (unverifiedParams.length === 0) return '';
  return `\n\nThese parameters shipped WITHOUT a passing compile-time verification, so they are the HIGHEST priority for your per-parameter differential pass: ${unverifiedParams
    .map((u) => `${u.tool}(${u.params.join(', ')})`)
    .join(
      '; ',
    )}. Give each one a \`parameters\` verdict (works / no_op / broken / untestable) like any other — do not let an unverified parameter pass without a differential test. Only skip probing when the tool is genuinely state-changing / irreversible, or when repeated paced attempts for that parameter stay blocked by infrastructure. A bot-defended idempotent read is still testable after the warm browser session is established.`;
}

export function buildAuditInitialPrompt(opts: DriveAuditOptions, unverifiedNote: string): string {
  return `Audit every MCP tool connected to you for the site "${opts.site}".

There are ${opts.toolNames.length} connected tool(s). For each one: read its description and input schema, invoke it with a realistic parameter set, judge the result, and classify each invocation as correct | tool_broken | infra | bad_params per your system prompt.

Parameter coverage is mandatory for idempotent read tools. A cold cdp-replay/browser-backed first call may be slow because it launches or warms a trusted browser session, but later calls usually reuse that warm session and are much cheaper. Do NOT use the first call's cold-start latency as a reason to skip parameter probes. For search/list/calendar/lookup/quote/read tools, keep making paced sequential differential calls until each advertised parameter has a verdict, unless the same parameter remains blocked by infrastructure after repeated paced retries. For genuinely state-changing or irreversible tools (book/pay/send/cancel/delete/order), make only the safe baseline call and mark parameters untestable with that state-changing reason.

Promo/coupon/voucher/discount-code parameters require a known valid code to prove a visible effect. If neither the schema nor another tool output gives you a valid code, classify that parameter as untestable; do not invent a random code and call an unchanged response no_op.

IMPORTANT: Call tools strictly sequentially — issue exactly one tool call, wait for its result, then issue the next. Never issue tool calls in parallel or batch them in one turn. Many target sites share an anti-bot defense across endpoints, so a parallel burst trips a site-wide rate-limit (HTTP 429) that then poisons every later call. If a call returns a 429 / rate-limit / anti-bot result, classify it \`infra\` and pause before the next call.${unverifiedNote}${buildTokenDepNote(opts.tokenDeps)}

When you are done, end your final message with exactly one fenced \`\`\`json block containing the full report and nothing after it.`;
}

/** Everything recovered from one audit session: the text to extract the report
 *  from, a full transcript for diagnosis, token/cost usage, and whether the
 *  deadline guard had to kill the child. */
interface AuditSessionResult {
  /** Report-extraction source: the terminal result event, or the concatenated
   *  assistant text if the run was cut off before producing one. */
  text: string;
  /** Full assistant reasoning across every turn, persisted for diagnosis. */
  transcript: string;
  timedOut: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number | null;
}

/** Drain the stream-json events, accumulating assistant text + token/cost usage,
 *  and resolve when the child exits. Enforces the wall-clock timeout by killing
 *  the child; reports `timedOut` so a cut-off run is a loud, distinct outcome
 *  rather than a silent empty (→ inconclusive) report.
 *  Emits a one-line-per-event progress log to stderr so operators can `tail -f`
 *  the audit log file and see live what the auditor is doing — without this
 *  the audit is a 30-minute black box. */
async function collectAssistantText(
  child: ChildProcess,
  timeoutMs: number,
): Promise<AuditSessionResult> {
  const chunks: string[] = [];
  let resultText = '';
  let stdoutBuf = '';
  let killed = false;
  let turns = 0;
  // Accumulated per-event so a killed run still reports partial usage; the
  // terminal `result` event (when present) overwrites with the authoritative
  // cumulative totals. Mirrors the compile path (claude-cli-compile.ts).
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let totalCostUsd: number | null = null;
  const t0 = Date.now();
  const elapsedStr = (): string => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const timer = setTimeout(() => {
    killed = true;
    log(`audit exceeded ${formatDeadline(timeoutMs)} deadline, terminating claude`);
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

      // Token accounting from any event that carries usage (event-level or on
      // the nested assistant message).
      const eu = evt.usage;
      const mu = evt.message?.usage;
      inputTokens += (eu?.input_tokens ?? 0) + (mu?.input_tokens ?? 0);
      outputTokens += (eu?.output_tokens ?? 0) + (mu?.output_tokens ?? 0);
      cacheReadInputTokens +=
        (eu?.cache_read_input_tokens ?? 0) + (mu?.cache_read_input_tokens ?? 0);
      cacheCreationInputTokens +=
        (eu?.cache_creation_input_tokens ?? 0) + (mu?.cache_creation_input_tokens ?? 0);

      // Live progress signal: one log line per tool_use / tool_result /
      // text-snippet event with [elapsed]. Lets `tail -f` show what the
      // auditor is doing in real time instead of waiting 30-60 min for
      // the final report.
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        turns++;
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
      } else if (evt.type === 'result') {
        // The terminal result event carries the final assistant message verbatim
        // plus the authoritative cumulative usage + cost.
        if (typeof evt.result === 'string') {
          resultText = evt.result;
          log(`[${elapsedStr()}] result event received (${evt.result.length} chars)`);
        }
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens ?? inputTokens;
          outputTokens = evt.usage.output_tokens ?? outputTokens;
          cacheReadInputTokens = evt.usage.cache_read_input_tokens ?? cacheReadInputTokens;
          cacheCreationInputTokens =
            evt.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
        }
        if (typeof evt.total_cost_usd === 'number') totalCostUsd = evt.total_cost_usd;
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

  return {
    // Prefer the terminal result event (the complete final message); fall back to
    // the concatenated streamed assistant text if the result event was absent.
    text: resultText || chunks.join('\n'),
    transcript: chunks.join('\n\n'),
    timedOut: killed,
    turns,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
  };
}

async function collectCodexAssistantText(
  child: ChildProcess,
  timeoutMs: number,
): Promise<AuditSessionResult> {
  const chunks: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  let killed = false;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const t0 = Date.now();
  const elapsedStr = (): string => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const timer = setTimeout(() => {
    killed = true;
    log(`audit exceeded ${formatDeadline(timeoutMs)} deadline, terminating codex`);
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

      let evt: CodexStreamJsonEvent;
      try {
        evt = JSON.parse(line) as CodexStreamJsonEvent;
      } catch {
        continue;
      }

      if (evt.type === 'thread.started') {
        log(`thread_id=${evt.thread_id ?? '(none)'}`);
        continue;
      }

      if (evt.type === 'turn.started') {
        turns++;
        log(`[${elapsedStr()}] turn ${turns} started`);
        continue;
      }

      if (evt.type === 'turn.completed') {
        inputTokens += evt.usage?.input_tokens ?? 0;
        outputTokens += evt.usage?.output_tokens ?? 0;
        log(`[${elapsedStr()}] turn ${turns} completed`);
        continue;
      }

      if ((evt.type === 'item.started' || evt.type === 'item.completed') && evt.item) {
        const text = codexAuditAgentText(evt.item);
        if (text && evt.type === 'item.completed') {
          chunks.push(text);
          const preview = text.replace(/\s+/g, ' ').slice(0, 120);
          log(`[${elapsedStr()}] assistant: ${preview}`);
          continue;
        }
        const toolName = codexAuditToolName(evt.item);
        if (toolName) {
          const label = evt.type === 'item.started' ? 'tool_use' : 'tool_result';
          log(`[${elapsedStr()}] ${label}: ${toolName}`);
        }
        continue;
      }

      if (evt.type === 'error' || evt.type === 'turn.failed') {
        log(`[${elapsedStr()}] codex error: ${evt.message ?? evt.error?.message ?? line}`);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderrBuf += s;
    log(`[codex stderr] ${s.trim()}`);
  });

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (err) => {
      log(`codex process error: ${errMsg(err)}`);
      resolve();
    });
  });
  clearTimeout(timer);
  if (killed) log('audit session was terminated by the deadline guard');
  if (stdoutBuf.trim()) log(`unflushed codex stdout tail (${stdoutBuf.length} bytes) discarded`);
  if (stderrBuf.trim() && chunks.length === 0) {
    chunks.push(stderrBuf);
  }

  const transcript = chunks.join('\n\n');
  return {
    text: transcript,
    transcript,
    timedOut: killed,
    turns,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: null,
  };
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
    usage?: StreamUsage;
  };
  /** Final cumulative usage + cost ride on the terminal `result` event. */
  usage?: StreamUsage;
  total_cost_usd?: number;
  result?: string;
}

interface CodexStreamJsonEvent {
  type: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    content?: unknown;
    name?: string;
    tool_name?: string;
    tool?: string;
    server?: string;
    command?: string[];
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
}

function codexAuditAgentText(item: NonNullable<CodexStreamJsonEvent['item']>): string | undefined {
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  if (item.type === 'message' && typeof item.text === 'string') return item.text;
  if (item.type === 'assistant_message' && typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string' && item.type?.includes('message')) return item.content;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function codexAuditToolName(item: NonNullable<CodexStreamJsonEvent['item']>): string | undefined {
  return item.name ?? item.tool_name ?? item.tool ?? item.command?.[0];
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
  extra: {
    timedOut: boolean;
    timeoutMs: number;
    transcriptPath?: string;
    costUsd?: number | null;
    unverifiedAndUngradeable: string[];
    report: AuditReport;
  },
): void {
  const pct = score.graded === 0 ? 'n/a' : `${score.score.toFixed(1)}%`;
  console.log(`[imprint] audit "${opts.site}" — ${score.verdict.toUpperCase()}`);
  console.log(
    `[imprint]   score ${pct} (${score.correct} correct / ${score.broken} broken; threshold ${opts.minScore}%)`,
  );
  // `score.correct`/`score.broken` now blend invocation and parameter verdicts;
  // split them back out so this line counts only actual tool calls.
  const paramsTested = score.paramsWorking + score.paramsNoOp + score.paramsBroken;
  const invGraded = score.graded - paramsTested;
  const invTotal = invGraded + score.infra + score.badParams;
  console.log(
    `[imprint]   graded ${score.graded} unit(s) = ${invGraded}/${invTotal} invocation(s) + ${paramsTested} parameter(s) across ${toolCount} tool(s) — excluded: ${score.infra} infra, ${score.badParams} bad_params, ${score.paramsUntestable} untestable param(s)`,
  );
  if (paramsTested + score.paramsUntestable > 0) {
    console.log(
      `[imprint]   parameters: ${score.paramsWorking}/${paramsTested} working — ${score.paramsNoOp} no-op, ${score.paramsBroken} broken, ${score.paramsUntestable} untestable`,
    );
    // Per the "no-op/untested isn't a free pass" rule: list every parameter that
    // did not cleanly work, with the auditor's evidence, so the operator sees
    // exactly which advertised parameters don't function.
    for (const tool of extra.report.tools) {
      const flagged = tool.parameters.filter((p) => p.verdict !== 'works');
      if (flagged.length === 0) continue;
      const working = tool.parameters.filter((p) => p.verdict === 'works').length;
      // Denominator excludes untestable params, matching the top-level line.
      const tested = tool.parameters.filter((p) => p.verdict !== 'untestable').length;
      console.log(`[imprint]     ${tool.name} (${working}/${tested} working):`);
      for (const p of flagged) {
        const mark = p.verdict === 'untestable' ? '⚪' : '✗';
        console.log(
          `[imprint]       ${mark} ${p.name} — ${p.verdict}: ${p.reason || '(no reason)'}`,
        );
      }
    }
  }
  if (extra.costUsd != null) {
    console.log(`[imprint]   cost ≈ $${extra.costUsd.toFixed(2)}`);
  }
  if (extra.unverifiedAndUngradeable.length > 0) {
    console.log(
      `[imprint]   ${extra.unverifiedAndUngradeable.length} tool(s) flying blind (no live verification at compile, no graded calls at audit): ${extra.unverifiedAndUngradeable.join(', ')}`,
    );
  }
  if (score.verdict === 'timeout') {
    console.log(
      `[imprint]   audit was killed at the ${formatDeadline(extra.timeoutMs)} deadline before finishing — partial results only. Re-run with a longer --timeout, or inspect the transcript to see where it stalled.`,
    );
  } else if (score.verdict === 'inconclusive') {
    if (extra.unverifiedAndUngradeable.length > 0) {
      console.log(
        '[imprint]   verdict downgraded to inconclusive because at least one tool has zero live signal anywhere.',
      );
    } else {
      console.log(
        '[imprint]   no gradeable invocations (likely anti-bot / network) — re-run; this is not a code failure.',
      );
    }
  }
  if (extra.transcriptPath) {
    console.log(`[imprint]   transcript → ${extra.transcriptPath}`);
  }
  console.log(`[imprint]   report → ${opts.outPath}`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human-readable deadline, e.g. "20-minute" or "25-second" (sub-minute timeouts
 *  shouldn't round to "0-minute"). */
function formatDeadline(timeoutMs: number): string {
  return timeoutMs < 60_000
    ? `${Math.round(timeoutMs / 1000)}-second`
    : `${Math.round(timeoutMs / 60_000)}-minute`;
}
