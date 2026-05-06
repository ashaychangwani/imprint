/**
 * Agentic compilation pipeline: session → workflow.json + parser.ts + parser.test.ts.
 *
 * The agent loop inspects the captured session, writes code, tests it, and
 * iterates until external verification passes. See prompts/compile-agent.md
 * for the system prompt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import { compileViaClaudeCli } from './claude-cli-compile.ts';
import type { CompileAgentProgress, CompileAgentResult } from './compile-agent-types.ts';
import { buildCompileTools, externalVerification } from './compile-tools.ts';
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
import { redactSession } from './redact.ts';
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
  /** Hard wall-clock budget. Default 30 minutes. */
  maxDurationMs?: number;
  /** Override LLM config (region, model, project). */
  llmConfig?: LLMOptions;
  /** For testing only — inject a pre-configured provider instead of using llmConfig.
   *  Production callers omit this and use llmConfig. */
  llmProvider?: ToolUseProvider;
  /** Progress callback with verification cycle information. */
  onProgress?: (p: CompileAgentProgress) => void;
}

export async function compileAgent(opts: CompileAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();

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

  // 2. Auto-redact if not already redacted
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    const r = redactSession(session);
    session = r.session;
    if (r.stats.totalRedactions > 0) {
      log(
        `redacted ${r.stats.totalRedactions} value(s) before sending to LLM (use \`imprint redact\` to scrub the file on disk too)`,
      );
    }
  }

  // 3. Determine the example dir
  const absoluteExampleDir = pathJoin(REPO_ROOT, 'examples', session.site);

  // 4. Load the system prompt
  const systemPromptPath = pathJoin(PROMPTS_DIR, 'compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(
      `System prompt not found at ${systemPromptPath}\n→ this is an Imprint installation problem; please file an issue at https://github.com/ashaychangwani/imprint/issues with the steps you ran.`,
    );
  }
  const systemPrompt = readFileSync(systemPromptPath, 'utf8');

  // 5. Build the toolset (shared with the MCP server used by the claude-cli path)
  const tools = [...buildCompileTools(session, absoluteExampleDir), doneTool(), giveUpTool()];

  // 6. Build the initial user message
  const initialUserMessage = `A new compile task is starting.

Session path: ${pathJoin(REPO_ROOT, opts.sessionPath)}
Example directory: ${absoluteExampleDir}
You will write artifacts into the example directory.

Begin by calling read_session_summary to orient yourself, then proceed per the system prompt.`;

  // 7. Compute deadline
  const deadlineMs = Date.now() + (opts.maxDurationMs ?? 30 * 60 * 1000);

  // 8. Instantiate provider (or use injected one for testing).
  //    claude-cli takes a different path: it doesn't implement messageWithTools,
  //    so we shell out to `claude -p` with the same toolset registered as a
  //    stdio MCP server. The user's subscription auth (OAuth in keychain)
  //    drives the agent loop end-to-end.
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolvedProvider = resolveProvider(opts.llmConfig);
    if (resolvedProvider.name === 'claude-cli') {
      return await compileViaClaudeCli({
        session,
        absoluteExampleDir,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        onProgress: opts.onProgress,
        startTime,
      });
    }
    if (!isToolUseProvider(resolvedProvider)) {
      throw new Error(
        [
          `provider "${resolvedProvider.name}" does not support tool use, which the compile-agent requires.`,
          '→ use one of: claude-cli, anthropic-api, vertex (install Claude Code CLI, or set ANTHROPIC_API_KEY / ANTHROPIC_VERTEX_PROJECT_ID)',
        ].join('\n'),
      );
    }
    provider = resolvedProvider;
  }

  // 9. Run the agent loop with verification sub-loop
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
    const failures = await externalVerification(absoluteExampleDir, session);

    if (failures.length === 0) {
      // Success
      message = result.doneSummary ?? 'Task completed';
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

  // 10. Persist conversation log
  mkdirSync(absoluteExampleDir, { recursive: true });
  const conversationLogPath = pathJoin(absoluteExampleDir, '.compile-log.json');
  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  // 11. Return the result
  const workflowPath = pathJoin(absoluteExampleDir, 'workflow.json');
  const parserPath = pathJoin(absoluteExampleDir, 'parser.ts');
  const parserTestPath = pathJoin(absoluteExampleDir, 'parser.test.ts');

  return {
    success: outcome === 'done',
    outcome,
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
    parserPath: existsSync(parserPath) ? parserPath : undefined,
    parserTestPath: existsSync(parserTestPath) ? parserTestPath : undefined,
    message,
    conversationLogPath,
    turns: totalTurns,
    durationMs: Date.now() - startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
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
