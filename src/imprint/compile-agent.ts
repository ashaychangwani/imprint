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
import {
  type CompileAgentProgress,
  type CompileAgentResult,
  type CompileVerificationMode,
  advanceIncompleteSemanticVerificationRuns,
  advanceSemanticVerificationCycle,
  formatCandidateContext,
  formatCompileVerificationMode,
  formatToolPlan,
} from './compile-agent-types.ts';
import { runCompileWithProviderRecovery } from './compile-provider-recovery.ts';
import type { CompileStrategyKind } from './compile-strategy.ts';
import {
  applyIrreversibleVerificationWaiver,
  applyLiveVerification,
  applyParamVerification,
  buildCompileTools,
  externalVerification,
} from './compile-tools.ts';
import { extractCredentials } from './credential-extract.ts';
import { workflowHasIrreversibleEffect } from './effects.ts';
import {
  mergeSemanticParamVerification,
  runLiveSemanticVerification,
  semanticVerificationFailures,
} from './live-verifier.ts';
import {
  DEFAULT_VERIFICATION_PROVIDER,
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
import { rebindExistingBackendsCacheToWorkflow } from './probe-backends.ts';
import { type RunDeadlineRef, resolvedRunDeadline } from './provider-retry.ts';
import { detectPageMintedHeaders, redactSession } from './redact.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import {
  type SharedTriageSelection,
  applySharedTriageSelection,
  minimalSharedTriageSelection,
} from './triage-selection.ts';
import { type Session, SessionSchema, WorkflowSchema } from './types.ts';

export type { CompileAgentProgress } from './compile-agent-types.ts';

const log = createLog('compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

let claudeCliCompiler = compileViaClaudeCli;
let codexCliCompiler = compileViaCodexCli;

export function __setCompileAgentCliCompilersForTest(
  compilers: {
    claude?: typeof compileViaClaudeCli;
    codex?: typeof compileViaCodexCli;
  } | null,
): void {
  claudeCliCompiler = compilers?.claude ?? compileViaClaudeCli;
  codexCliCompiler = compilers?.codex ?? compileViaCodexCli;
}

/** Re-exported for callers (cli, teach) that need to display the selected
 *  model before kicking off the agent loop. */
export function resolveCompileAgentModel(provider: ProviderName): string {
  return preferredAgentModel(provider);
}

function removeEphemeralTests(toolDir: string): void {
  for (const name of ['parser.test.ts', 'request.test.ts', 'integration.test.ts']) {
    const path = pathJoin(toolDir, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

interface CompileAgentOptions {
  /** Path to the recorded session JSON (absolute or relative). */
  sessionPath: string;
  /** Hard wall-clock budget. Default 20 minutes. */
  maxDurationMs?: number;
  /** Absolute teach-run deadline shared by planning, compile, and verification. */
  deadlineMs?: number;
  runDeadline?: RunDeadlineRef;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** For testing only — inject a pre-configured provider instead of using llmConfig.
   *  Production callers omit this and use llmConfig. */
  llmProvider?: ToolUseProvider;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
  /** Retain generated tests after successful verification. By default they are
   *  deleted (parser tests read the gitignored redacted session at
   *  $IMPRINT_SESSION_PATH, so it's not reproducible elsewhere — keeping it
   *  on disk just confuses `bun test`). Pass true with `--keep-test` to
   *  inspect the agent's test output locally. */
  keepTest?: boolean;
  /** Directory where workflow.json/parser.ts/parser.test.ts are written. */
  outDir?: string;
  /** Candidate-specific compile scope for multi-tool teach. */
  candidate?: ToolCandidate;
  /** Shared auth/helper guidance generated once for a multi-tool teach run. */
  sharedContext?: SharedCompileContext;
  /** Credential values extracted during teach, passed to integration tests via env var. */
  teachCredentials?: { site: string; values: Record<string, string> };
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Called when wall-clock deadline is reached; return ms to extend or null to time out. */
  onDeadlineReached?: OnDeadlineReached;
  /** Cancels the active provider call, any backoff wait, and its compiler child process. */
  signal?: AbortSignal;
  /** Per-tool implementation plan. Its strategy is master-accepted; focused
   * construction details remain open to evidence-backed repair or rejection. */
  toolPlan?: string;
  /** Master-accepted execution strategy for this focused compile. */
  strategyKind?: CompileStrategyKind;
  /** Revise an existing generated artifact, using durable verification feedback
   *  as the starting point instead of rebuilding it from raw capture. */
  revisionMode?: boolean;
  /** Shared triage decision propagated into all compile transports. */
  preTriagedSession?: SharedTriageSelection;
  /** Master-led teaches use a deterministic MVP boundary so dependent tools
   * are not held behind live semantic breadth work. Standalone generation
   * keeps the full verifier by default. */
  verificationMode?: CompileVerificationMode;
}

function formatRevisionMode(enabled: boolean | undefined): string {
  return enabled
    ? [
        'REVISION MODE: this is a bounded resume of an existing generated tool, not a from-scratch compile.',
        'Use read_session_summary.revisionContext, then read the listed current artifacts and durable verification feedback before inspecting raw response bodies.',
        'Preserve proven behavior and make the smallest evidence-backed repair or contract reduction.',
      ].join(' ')
    : '';
}

export async function compileAgent(opts: CompileAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();
  // Build-plan fields are bounded proposals for the compile/master agents.
  const { assignedSharedModules } = resolvePlanSliceFromFile(
    opts.buildPlanPath,
    opts.candidate?.toolName,
    opts.sharedModules,
  );

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

  // 2. Auto-redact raw direct-generate inputs. Teach normally supplies an
  // already-redacted focused recording.
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const replacements = extractCredentials(session).replacements;
    const pageMintedHeaders = detectPageMintedHeaders(session);
    const redaction = redactSession(session, { replacements, keepHeaders: pageMintedHeaders });
    session = redaction.session;
    if (redaction.stats.totalRedactions > 0 || redaction.stats.placeholdersInjected > 0) {
      log(
        `redacted ${redaction.stats.totalRedactions} value(s) and injected ${redaction.stats.placeholdersInjected} credential placeholder(s) before sending to LLM`,
      );
    }
  }
  if (opts.preTriagedSession) {
    session = applySharedTriageSelection(session, opts.preTriagedSession, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
    });
  }

  // 3. Determine the generated tool directory.
  const absoluteToolDir = opts.outDir ?? localSiteDir(session.site);
  mkdirSync(absoluteToolDir, { recursive: true });

  // 3b. Ensure type dependencies exist so the agent doesn't waste turns
  //     discovering and installing @types/bun + @types/node during the loop.
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
      teachCredentials: opts.teachCredentials,
      buildPlanPath: opts.buildPlanPath,
      sharedModules: opts.sharedModules,
      strategyKind: opts.strategyKind,
      revisionMode: opts.revisionMode,
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
${formatRevisionMode(opts.revisionMode)}
${formatCompileVerificationMode(opts.verificationMode)}

Begin by calling read_session_summary to orient yourself, then proceed per the system prompt.`;

  // 7. Compute deadline
  const runDeadline = resolvedRunDeadline(
    opts.runDeadline,
    opts.deadlineMs ?? Date.now() + (opts.maxDurationMs ?? 20 * 60 * 1000),
  );

  // 8. Instantiate provider (or use injected one for testing).
  //    CLI providers take a different path: they don't implement Anthropic
  //    messageWithTools, so we shell out with the same toolset registered as a
  //    stdio MCP server. The user's CLI auth drives the agent loop end-to-end.
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolvedProvider = resolveProvider(opts.llmConfig);
    if (resolvedProvider.name === 'claude-cli' || resolvedProvider.name === 'codex-cli') {
      const providerName = resolvedProvider.name;
      const compiler = providerName === 'claude-cli' ? claudeCliCompiler : codexCliCompiler;
      const result = await runCompileWithProviderRecovery({
        runDeadline,
        signal: opts.signal,
        onDeadlineReached: opts.onDeadlineReached,
        onRetry: ({ attempt, delayMs, sessionId }) =>
          log(
            `${providerName} provider interruption after segment ${attempt}; ` +
              `${sessionId ? `will resume session ${sessionId.slice(0, 8)}` : 'no session started yet'} ` +
              `in ${Math.round(delayMs / 1000)}s`,
          ),
        run: (resume, segmentDeadline) =>
          compiler({
            session,
            absoluteToolDir,
            sessionPath: opts.sessionPath,
            systemPromptPath,
            deadlineMs: segmentDeadline?.deadlineMs ?? runDeadline?.deadlineMs ?? Date.now(),
            runDeadline: segmentDeadline,
            onProgress: opts.onProgress,
            onDeadlineReached: opts.onDeadlineReached,
            signal: opts.signal,
            startTime,
            keepTest: opts.keepTest,
            candidate: opts.candidate,
            sharedContext: opts.sharedContext,
            buildPlanPath: opts.buildPlanPath,
            sharedModules: opts.sharedModules,
            toolPlan: opts.toolPlan,
            strategyKind: opts.strategyKind,
            revisionMode: opts.revisionMode,
            verificationMode: opts.verificationMode,
            resume,
            model: opts.llmConfig?.model,
            sharedTriageSelection: opts.preTriagedSession
              ? minimalSharedTriageSelection(opts.preTriagedSession)
              : undefined,
          }),
      });
      if (!result.success) return result;
      if (!opts.keepTest && opts.verificationMode !== 'master_mvp') {
        removeEphemeralTests(absoluteToolDir);
      }
      return result;
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
  const MAX_INCOMPLETE_VERIFIER_RUNS = 2;
  let semanticVerificationCycles = 0;
  let incompleteVerifierRuns = 0;
  let result: AgentResult | null = null;
  let currentInitialMessage = initialUserMessage;
  let verificationSemantic: 'approved' | 'not_run' | 'not_applicable' | undefined;

  while (true) {
    const currentSemanticCycle = Math.min(semanticVerificationCycles + 1, MAX_VERIFICATION_CYCLES);

    // Wrap the user's onProgress callback to inject verification cycle info
    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle: currentSemanticCycle,
            maxVerificationCycles: MAX_VERIFICATION_CYCLES,
          })
      : undefined;

    // Run the agent loop
    result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs: runDeadline?.deadlineMs ?? Date.now(),
      runDeadline,
      llm: provider,
      onProgress: wrappedOnProgress,
      onConversationUpdate: (currentCycleLog) => {
        const fullLog = [...conversationLog, ...currentCycleLog];
        writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
      },
      onDeadlineReached: opts.onDeadlineReached,
      signal: opts.signal,
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
    const { failures, warnings, paramVerification, integrationEvidence } =
      await externalVerification(absoluteToolDir, session, sessionPathAbs, {
        expectedToolName: opts.candidate?.toolName,
        candidateRequestSeqs: opts.candidate?.requestSeqs,
        // Widen checks to requests this tool depends on (bootstrap/login/etc.).
        dependencyRequestSeqs: [
          ...(opts.candidate?.dependencySeqs ?? []),
          ...(opts.sharedContext?.loginRequestSeqs ?? []),
        ],
        credentialValues: opts.teachCredentials?.values,
        credentialNames: opts.sharedContext?.credentialNames,
        strategyKind: opts.strategyKind,
        deferLiveIntegrationToSemanticAgent: true,
        expectedPublicParameters:
          opts.verificationMode === 'master_mvp' ? opts.candidate?.likelyParams : undefined,
      });

    if (warnings.length > 0) {
      log(`verification warnings (non-blocking):\n${warnings.join('\n')}`);
    }

    let workflow: ReturnType<typeof WorkflowSchema.parse> | undefined;
    if (failures.length === 0) {
      workflow = WorkflowSchema.parse(
        JSON.parse(readFileSync(pathJoin(absoluteToolDir, 'workflow.json'), 'utf8')),
      );
    }
    if (
      failures.length === 0 &&
      workflow &&
      opts.strategyKind === 'playbook_fallback' &&
      opts.verificationMode === 'master_mvp'
    ) {
      verificationSemantic = 'not_run';
      message = result.doneSummary ?? 'Browser artifact contract passed';
      message += '\n\nLive playbook verification is owned by the master.';
      if (warnings.length > 0) message += `\n\nWarnings:\n${warnings.join('\n')}`;
      if (!opts.keepTest) removeEphemeralTests(absoluteToolDir);
      break;
    }
    if (failures.length === 0 && workflow && workflowHasIrreversibleEffect(workflow)) {
      warnings.push(...applyIrreversibleVerificationWaiver(absoluteToolDir, workflow));
      message = `${result.doneSummary ?? 'Task completed'}\n\nLive verification: N/A (irreversible workflow).`;
      if (warnings.length > 0) message += `\n\nWarnings:\n${warnings.join('\n')}`;
      if (!opts.keepTest) removeEphemeralTests(absoluteToolDir);
      verificationSemantic = 'not_applicable';
      break;
    }

    if (failures.length === 0 && opts.verificationMode === 'master_mvp') {
      verificationSemantic = 'not_run';
      message = result.doneSummary ?? 'Minimum viable artifact completed';
      message += '\n\nIndependent live semantic verification: deferred to the master.';
      if (warnings.length > 0) message += `\n\nWarnings:\n${warnings.join('\n')}`;
      break;
    }

    let semanticReviewCompleted = false;
    let semanticReviewAttempted = false;
    let paramWarnings: string[] = [];
    if (failures.length === 0) {
      semanticReviewAttempted = true;
      const semantic = await runLiveSemanticVerification({
        provider: DEFAULT_VERIFICATION_PROVIDER,
        toolDir: absoluteToolDir,
        evidence: integrationEvidence,
        signal: opts.signal,
        deadlineMs: runDeadline?.deadlineMs,
        runDeadline,
        onDeadlineReached: opts.onDeadlineReached,
      });
      semanticReviewCompleted = semantic.completedReview;
      failures.push(...semanticVerificationFailures(semantic.report));
      if (semantic.report.status === 'approved_with_gaps') {
        warnings.push(
          `independent semantic verification approved with gaps: ${semantic.report.gaps.join('; ')}`,
        );
      }
      if (failures.length === 0) {
        applyLiveVerification(absoluteToolDir, undefined);
        paramWarnings = applyParamVerification(
          absoluteToolDir,
          mergeSemanticParamVerification(paramVerification, semantic.report),
        );
        rebindExistingBackendsCacheToWorkflow(absoluteToolDir);
      }
      if (failures.length === 0 && workflow) {
        const allWarnings = [...warnings, ...paramWarnings];
        if (paramWarnings.length > 0) {
          log(`parameter verification:\n${paramWarnings.join('\n')}`);
        }
        message = result.doneSummary ?? 'Task completed';
        if (allWarnings.length > 0) {
          message += `\n\nWarnings:\n${allWarnings.join('\n')}`;
        }
        if (!opts.keepTest) removeEphemeralTests(absoluteToolDir);
        verificationSemantic = 'approved';
        if (failures.length === 0) break;
      }
    }

    // Verification failed — re-enter the loop with a continuation message
    semanticVerificationCycles = advanceSemanticVerificationCycle(
      semanticVerificationCycles,
      semanticReviewCompleted,
    );
    incompleteVerifierRuns = advanceIncompleteSemanticVerificationRuns(
      incompleteVerifierRuns,
      semanticReviewAttempted,
      semanticReviewCompleted,
    );
    if (incompleteVerifierRuns >= MAX_INCOMPLETE_VERIFIER_RUNS) {
      outcome = 'error';
      message = `Independent semantic verifier failed to complete after ${MAX_INCOMPLETE_VERIFIER_RUNS} bounded runs. Final failures:\n${failures.join('\n')}`;
      break;
    }
    if (semanticVerificationCycles >= MAX_VERIFICATION_CYCLES) {
      outcome = 'error';
      message = `Semantic verification failed after ${MAX_VERIFICATION_CYCLES} cycles. Final failures:\n${failures.join('\n')}`;
      break;
    }

    const failurePhase = semanticReviewCompleted
      ? `semantic verification failed (cycle ${semanticVerificationCycles}/${MAX_VERIFICATION_CYCLES})`
      : semanticReviewAttempted
        ? 'semantic verifier did not complete a review (semantic cycle limit unchanged)'
        : 'deterministic verification failed (semantic cycle limit unchanged)';
    log(`${failurePhase}, resuming agent loop...`);
    const repairFiles =
      opts.strategyKind === 'playbook_fallback'
        ? 'workflow.json and playbook.yaml'
        : 'workflow.json, parser.ts, and parser.test.ts';
    currentInitialMessage = `You called done but ${failurePhase}:

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (${repairFiles}), fix the issues, re-run the applicable checks, and call done again when fixed.`;
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
    ...(outcome === 'done'
      ? {
          verification: {
            mode: opts.verificationMode ?? 'full',
            deterministic: 'passed' as const,
            semantic: verificationSemantic ?? 'approved',
            ...(verificationSemantic === 'approved' &&
            existsSync(pathJoin(absoluteToolDir, '.live-verification.json'))
              ? { reportPath: pathJoin(absoluteToolDir, '.live-verification.json') }
              : {}),
          },
        }
      : {}),
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
