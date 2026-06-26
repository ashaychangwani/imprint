/**
 * Agentic compilation pipeline: session → workflow.json + parser.ts + parser.test.ts.
 *
 * The agent loop inspects the captured session, writes code, tests it, and
 * iterates until external verification passes. See prompts/compile-agent.md
 * for the system prompt.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type OnDeadlineReached,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import { type SharedModuleManifestEntry, resolvePlanSliceFromFile } from './build-plan.ts';
import { compileViaClaudeCli } from './claude-cli-compile.ts';
import { compileViaCodexCli } from './codex-cli-compile.ts';
import type { CompileAgentProgress, CompileAgentResult } from './compile-agent-types.ts';
import { formatCandidateContext, formatToolPlan } from './compile-agent-types.ts';
import {
  applyLiveVerification,
  applyParamVerification,
  buildCompileTools,
  externalVerification,
} from './compile-tools.ts';
import { type Replacement, extractCredentials } from './credential-extract.ts';
import {
  type LLMOptions,
  type ProviderName,
  type ToolUseProvider,
  isToolUseProvider,
  preferredAgentModel,
  resolveProvider,
} from './llm.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { localSiteDir } from './paths.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import type { ClassifiedValue } from './session-diff.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type Session, SessionSchema } from './types.ts';

export type { CompileAgentProgress } from './compile-agent-types.ts';

const log = createLog('compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

/** Re-exported for callers (cli, teach) that need to display the selected
 *  model before kicking off the agent loop. */
export function resolveCompileAgentModel(provider: ProviderName): string {
  return preferredAgentModel(provider);
}

interface CompileAgentOptions {
  /** Path to the recorded session JSON (absolute or relative). */
  sessionPath: string;
  /** Hard wall-clock budget. Default 20 minutes. */
  maxDurationMs?: number;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** For testing only — inject a pre-configured provider instead of using llmConfig.
   *  Production callers omit this and use llmConfig. */
  llmProvider?: ToolUseProvider;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
  /** Retain parser.test.ts after successful verification. By default it's
   *  deleted (the test reads the gitignored redacted session at
   *  $IMPRINT_SESSION_PATH, so it's not reproducible elsewhere — keeping it
   *  on disk just confuses `bun test`). Pass true with `--keep-test` to
   *  inspect the agent's test output locally. */
  keepTest?: boolean;
  /** Credential placeholders to inject before redaction. Provided by `imprint
   *  teach` when the credential-extract pass found a login pair; for direct
   *  `imprint generate` callers we run extraction inline (best-effort, no
   *  prompts — values flow into the credential manager only when the user
   *  goes through the teach flow). */
  replacements?: Replacement[];
  /** Directory where workflow.json/parser.ts/parser.test.ts are written. */
  outDir?: string;
  /** Candidate-specific compile scope for multi-tool teach. */
  candidate?: ToolCandidate;
  /** Shared auth/helper guidance generated once for a multi-tool teach run. */
  sharedContext?: SharedCompileContext;
  /** Dual-pass value classifications from replay-and-diff. */
  classifications?: ClassifiedValue[];
  /** Credential values extracted during teach, passed to integration tests via env var. */
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  /** Per-tool implementation plan (param→field mapping, request construction,
   *  response parsing, shared-module imports). Injected into the agent's initial
   *  message so the compile follows it. Generic — not tied to any site. */
  toolPlan?: string;
}

export async function compileAgent(opts: CompileAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();
  // Resolve the shared modules + token contracts the plan assigned this tool, so
  // the in-process verifier can assert modules are imported and require a chained
  // test for each producer-sourced token param.
  const { assignedSharedModules, tokenParams, emittedTokens, requiredInputs } =
    resolvePlanSliceFromFile(opts.buildPlanPath, opts.candidate?.toolName, opts.sharedModules);

  // 1. Load + validate the session
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

  // 2. Auto-redact if not already redacted (preserves any ${credential.X}
  //    placeholders that teach.ts already injected). When replacements are
  //    passed in via opts (the teach path), we honor them; otherwise we run
  //    extraction inline so direct `imprint generate` callers also get
  //    credential-aware redaction (values are NOT persisted to the keychain
  //    on this path — that requires going through `imprint teach` or
  //    `imprint credential set`).
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    let replacements = opts.replacements;
    if (!replacements) {
      const auto = extractCredentials(session);
      replacements = auto.replacements;
    }
    const pageMintedHeaders = detectPageMintedHeaders(session);
    const r = redactSession(session, { replacements, keepHeaders: pageMintedHeaders });
    session = r.session;
    if (r.stats.totalRedactions > 0 || r.stats.placeholdersInjected > 0) {
      const freeformNote =
        r.stats.freeformRedactions > 0
          ? ` (${r.stats.freeformRedactions} free-form finding(s))`
          : '';
      log(
        `redacted ${r.stats.totalRedactions} value(s)${freeformNote} and injected ${r.stats.placeholdersInjected} credential placeholder(s) before sending to LLM`,
      );
    }
  }

  // 3. Determine the generated tool directory.
  const absoluteToolDir = opts.outDir ?? localSiteDir(session.site);

  // 3b. Ensure type dependencies exist so the agent doesn't waste turns
  //     discovering and installing @types/bun + @types/node during the loop.
  mkdirSync(absoluteToolDir, { recursive: true });
  const harnessPkgPath = pathJoin(absoluteToolDir, 'package.json');
  if (!existsSync(harnessPkgPath)) {
    writeFileSync(
      harnessPkgPath,
      JSON.stringify(
        {
          name: `imprint-tool-${session.site}`,
          private: true,
          devDependencies: {
            '@types/bun': 'latest',
            '@types/node': 'latest',
            'bun-types': 'latest',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  const harnessNmPath = pathJoin(absoluteToolDir, 'node_modules');
  if (!existsSync(harnessNmPath)) {
    Bun.spawnSync(['bun', 'install'], { cwd: absoluteToolDir });
  }

  // 4. Load the system prompt
  const systemPromptPath = pathJoin(PROMPTS_DIR, 'compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(
      `System prompt not found at ${systemPromptPath}\n→ this is an Imprint installation problem; please file an issue at https://github.com/ashaychangwani/imprint/issues with the steps you ran.`,
    );
  }
  const systemPrompt = `${readFileSync(systemPromptPath, 'utf8')}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;

  // 5. Build the toolset (shared with the MCP server used by the claude-cli path)
  const sessionPathAbs = opts.sessionPath.startsWith('/')
    ? opts.sessionPath
    : pathJoin(REPO_ROOT, opts.sessionPath);
  const tools = [
    ...buildCompileTools(session, absoluteToolDir, sessionPathAbs, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
      classifications: opts.classifications,
      teachCredentials: opts.teachCredentials,
      buildPlanPath: opts.buildPlanPath,
      sharedModules: opts.sharedModules,
    }),
    doneTool(),
    giveUpTool(),
  ];

  // 6. Build the initial user message
  const initialUserMessage = `A new compile task is starting.

Session path: ${sessionPathAbs}
Tool directory: ${absoluteToolDir}
You will write artifacts into the tool directory.
${formatCandidateContext(opts.candidate, opts.sharedContext, assignedSharedModules)}
${formatToolPlan(opts.toolPlan)}

Begin by calling read_session_summary to orient yourself, then proceed per the system prompt.`;

  // 7. Compute deadline
  const deadlineMs = Date.now() + (opts.maxDurationMs ?? 20 * 60 * 1000);

  // 8. Instantiate provider (or use injected one for testing).
  //    CLI providers take a different path: they don't implement Anthropic
  //    messageWithTools, so we shell out with the same toolset registered as a
  //    stdio MCP server. The user's CLI auth drives the agent loop end-to-end.
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolvedProvider = resolveProvider(opts.llmConfig);
    if (resolvedProvider.name === 'claude-cli') {
      return await compileViaClaudeCli({
        session,
        absoluteToolDir,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        onProgress: opts.onProgress,
        onDeadlineReached: opts.onDeadlineReached,
        startTime,
        keepTest: opts.keepTest,
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
        buildPlanPath: opts.buildPlanPath,
        sharedModules: opts.sharedModules,
        toolPlan: opts.toolPlan,
      });
    }
    if (resolvedProvider.name === 'codex-cli') {
      return await compileViaCodexCli({
        session,
        absoluteToolDir,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        onProgress: opts.onProgress,
        startTime,
        keepTest: opts.keepTest,
        candidate: opts.candidate,
        sharedContext: opts.sharedContext,
        buildPlanPath: opts.buildPlanPath,
        sharedModules: opts.sharedModules,
        toolPlan: opts.toolPlan,
      });
    }
    if (!isToolUseProvider(resolvedProvider)) {
      throw new Error(
        [
          `provider "${resolvedProvider.name}" does not support tool use, which the compile-agent requires.`,
          '→ use one of: claude-cli, codex-cli, anthropic-api (install a supported CLI, or set ANTHROPIC_API_KEY)',
        ].join('\n'),
      );
    }
    provider = resolvedProvider;
  }

  // 9. Run the agent loop with verification sub-loop
  mkdirSync(absoluteToolDir, { recursive: true });
  const conversationLogPath = pathJoin(absoluteToolDir, '.compile-log.json');

  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let outcome: AgentResult['outcome'] = 'error';
  let message = '';
  let conversationLog: AgentResult['conversationLog'] = [];

  const MAX_VERIFICATION_CYCLES = 5;
  let verificationCycle = 0;
  let result: AgentResult | null = null;
  let currentInitialMessage = initialUserMessage;

  while (verificationCycle < MAX_VERIFICATION_CYCLES) {
    verificationCycle++;

    // Wrap the user's onProgress callback to inject verification cycle info
    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle,
            maxVerificationCycles: MAX_VERIFICATION_CYCLES,
          })
      : undefined;

    // Run the agent loop
    result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs,
      llm: provider,
      onProgress: wrappedOnProgress,
      onConversationUpdate: (currentCycleLog) => {
        const fullLog = [...conversationLog, ...currentCycleLog];
        writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
      },
      onDeadlineReached: opts.onDeadlineReached,
    });

    totalTurns += result.turns;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    conversationLog = [...conversationLog, ...result.conversationLog];

    outcome = result.outcome;

    // If not done, break out
    if (result.outcome !== 'done') {
      message = buildMessageFromOutcome(result);
      break;
    }

    // Perform external verification
    const { failures, warnings, paramVerification, liveVerification } = await externalVerification(
      absoluteToolDir,
      session,
      sessionPathAbs,
      {
        expectedToolName: opts.candidate?.toolName,
        likelyParams: opts.candidate?.likelyParams,
        candidateRequestSeqs: opts.candidate?.requestSeqs,
        // Widen Fix B's variation pool to the dependency requests (e.g. a
        // bootstrap GET) so a session token that varies only across dependency
        // seqs and is then frozen as a literal in the tool's request is caught.
        dependencyRequestSeqs: opts.candidate?.dependencySeqs,
        assignedSharedModules,
        tokenParams,
        emittedTokens,
        requiredInputs,
        credentialValues: opts.teachCredentials?.values,
      },
    );

    if (warnings.length > 0) {
      log(`verification warnings (non-blocking):\n${warnings.join('\n')}`);
    }

    if (failures.length === 0) {
      // Success (possibly with warnings). Persist per-parameter verified flags
      // and the live-verification stamp into workflow.json so downstream
      // (audit, teach summary) can see which tools shipped without a passing
      // live call.
      applyLiveVerification(absoluteToolDir, liveVerification);
      const paramWarnings = applyParamVerification(absoluteToolDir, paramVerification);
      const allWarnings = [...warnings, ...paramWarnings];
      if (paramWarnings.length > 0) {
        log(`parameter verification:\n${paramWarnings.join('\n')}`);
      }
      message = result.doneSummary ?? 'Task completed';
      if (allWarnings.length > 0) {
        message += `\n\nWarnings:\n${allWarnings.join('\n')}`;
      }
      if (!opts.keepTest) {
        for (const f of ['parser.test.ts', 'integration.test.ts']) {
          const testPath = pathJoin(absoluteToolDir, f);
          if (existsSync(testPath)) unlinkSync(testPath);
        }
      }
      break;
    }

    // Verification failed — re-enter the loop with a continuation message
    if (verificationCycle >= MAX_VERIFICATION_CYCLES) {
      outcome = 'error';
      message = `Verification failed after ${MAX_VERIFICATION_CYCLES} cycles. Final failures:\n${failures.join('\n')}`;
      break;
    }

    log(`verification failed (cycle ${verificationCycle}), resuming agent loop...`);
    currentInitialMessage = `You called done but verification failed:

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (workflow.json, parser.ts, parser.test.ts), fix the issues, re-run tests, and call done again when fixed.`;
  }

  // 10. Final flush of the complete conversation log
  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  // 11. Return the result
  const workflowPath = pathJoin(absoluteToolDir, 'workflow.json');
  const parserPath = pathJoin(absoluteToolDir, 'parser.ts');
  const parserTestPath = pathJoin(absoluteToolDir, 'parser.test.ts');

  return {
    success: outcome === 'done',
    outcome,
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    parserPath: existsSync(parserPath) ? parserPath : undefined,
    // parserTestPath only set if it survived (--keep-test); otherwise undefined.
    parserTestPath: existsSync(parserTestPath) ? parserTestPath : undefined,
    message,
    conversationLogPath,
    turns: totalTurns,
    durationMs: Date.now() - startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function buildMessageFromOutcome(result: AgentResult): string {
  switch (result.outcome) {
    case 'give_up':
      return `Agent gave up: ${result.giveUpReason ?? 'unknown reason'}\n${result.giveUpDetail ?? ''}`;
    case 'timeout':
      return 'Agent loop timed out before completion';
    case 'soft_cap':
      return 'Agent loop exceeded soft turn cap (100 turns)';
    case 'error':
      return `Agent loop error: ${result.errorMessage ?? 'unknown error'}`;
    default:
      return 'Unknown outcome';
  }
}
