/**
 * Agentic auth tool compilation — the agent examines the session, writes
 * workflow.json, tests it against the live site, iterates until login works.
 *
 * Mirrors compile-agent.ts for data tools but with the auth-specific live-test
 * tool (test_auth_workflow) and lighter verification. Auth tools ride the same
 * backend ladder as data tools (including the playbook rung for browser-minted
 * logins); there is no bespoke login backend.
 *
 * Provider paths mirror compile-agent.ts exactly:
 *   - claude-cli / codex-cli: shell out with the auth toolset registered as a
 *     stdio MCP server (mcp-compile-server.ts in auth mode). The user's CLI
 *     auth drives the loop; subscription tokens, not API credit.
 *   - anthropic-api (or any ToolUseProvider): drive in-process via runAgentLoop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  type AgentProgress,
  type AgentResult,
  type AgentTool,
  doneTool,
  giveUpTool,
  runAgentLoop,
} from './agent.ts';
import {
  AUTH_COMPILE_TOOL_NAMES,
  authExternalVerification,
  buildAuthCompileTools,
} from './auth-compile-tools.ts';
import type { AuthToolPlan } from './build-plan.ts';
import { compileAuthViaClaudeCli } from './claude-cli-compile.ts';
import { compileAuthViaCodexCli } from './codex-cli-compile.ts';
import type { CompileAgentProgress, CompileAgentResult } from './compile-agent-types.ts';
import {
  type LLMOptions,
  type ToolUseProvider,
  isToolUseProvider,
  resolveProvider,
} from './llm.ts';
import { createLog } from './log.ts';
import { localToolDir } from './paths.ts';
import type { Session } from './types.ts';

const log = createLog('auth-compile-agent');

const REPO_ROOT = pathJoin(import.meta.dir, '..', '..');
const PROMPTS_DIR = pathJoin(REPO_ROOT, 'prompts');

interface CompileAuthAgentOptions {
  site: string;
  session: Session;
  sessionPath: string;
  authToolPlan: NonNullable<AuthToolPlan>;
  teachCredentials: { site: string; values: Record<string, string> };
  llmConfig?: LLMOptions;
  llmProvider?: ToolUseProvider;
  maxDurationMs?: number;
  onProgress?: (p: CompileAgentProgress) => void;
}

/** Build the initial user message handed to the agent on its first turn.
 *  Shared verbatim by every provider path so the agent's framing is identical. */
function buildAuthInitialMessage(opts: {
  site: string;
  toolName: string;
  toolDir: string;
  authToolPlan: NonNullable<AuthToolPlan>;
}): string {
  const { site, toolName, toolDir, authToolPlan } = opts;
  return `A new auth compile task is starting.

Site: ${site}
Tool name: ${toolName}
Tool directory: ${toolDir}

Auth tool plan:
- loginRequestSeqs: ${JSON.stringify(authToolPlan.loginRequestSeqs)}
- twoFactorRequestSeqs: ${JSON.stringify(authToolPlan.twoFactorRequestSeqs)}
- twoFactorType: ${authToolPlan.twoFactorType}
- credentialNames: ${JSON.stringify(authToolPlan.credentialNames)}
- notes: ${authToolPlan.notes || '(none)'}

Begin by calling read_session_summary to orient yourself, then examine the login requests and write workflow.json per the system prompt.`;
}

export async function compileAuthAgent(opts: CompileAuthAgentOptions): Promise<CompileAgentResult> {
  const startTime = Date.now();
  const { site, session, authToolPlan } = opts;
  const toolName = authToolPlan.toolName;
  const toolDir = localToolDir(site, toolName);
  mkdirSync(toolDir, { recursive: true });

  const systemPromptPath = pathJoin(PROMPTS_DIR, 'auth-compile-agent.md');
  if (!existsSync(systemPromptPath)) {
    throw new Error(`Auth compile agent prompt not found at ${systemPromptPath}`);
  }

  const deadlineMs = Date.now() + (opts.maxDurationMs ?? 10 * 60 * 1000);
  const initialUserMessage = buildAuthInitialMessage({ site, toolName, toolDir, authToolPlan });

  // Provider dispatch mirrors compile-agent.ts. CLI providers don't implement
  // messageWithTools — shell out with the auth toolset as a stdio MCP server.
  let provider: ToolUseProvider;
  if (opts.llmProvider) {
    provider = opts.llmProvider;
  } else {
    const resolved = resolveProvider(opts.llmConfig);
    if (resolved.name === 'claude-cli') {
      return await compileAuthViaClaudeCli({
        session,
        absoluteToolDir: toolDir,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        startTime,
        onProgress: opts.onProgress,
        authMode: {
          site,
          authPlanJson: JSON.stringify(authToolPlan),
          allowedTools: AUTH_COMPILE_TOOL_NAMES,
          initialPrompt: initialUserMessage,
        },
      });
    }
    if (resolved.name === 'codex-cli') {
      return await compileAuthViaCodexCli({
        session,
        absoluteToolDir: toolDir,
        sessionPath: opts.sessionPath,
        systemPromptPath,
        deadlineMs,
        startTime,
        onProgress: opts.onProgress,
        authMode: {
          site,
          authPlanJson: JSON.stringify(authToolPlan),
          allowedTools: AUTH_COMPILE_TOOL_NAMES,
          initialPrompt: initialUserMessage,
        },
      });
    }
    if (!isToolUseProvider(resolved)) {
      throw new Error(
        [
          `provider "${resolved.name}" does not support tool use, which the auth compile agent requires.`,
          '→ use one of: claude-cli, codex-cli, anthropic-api (install a supported CLI, or set ANTHROPIC_API_KEY)',
        ].join('\n'),
      );
    }
    provider = resolved;
  }

  // ─── In-process runAgentLoop path (anthropic-api / injected provider) ───────
  const systemPrompt = `${readFileSync(systemPromptPath, 'utf8')}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
  const tools: AgentTool[] = [
    ...buildAuthCompileTools(session, toolDir, opts.sessionPath, opts.teachCredentials),
    doneTool(),
    giveUpTool(),
  ];

  const conversationLogPath = pathJoin(toolDir, '.compile-log.json');

  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let outcome: AgentResult['outcome'] = 'error';
  let message = '';
  let conversationLog: AgentResult['conversationLog'] = [];

  const MAX_VERIFICATION_CYCLES = 3;
  let verificationCycle = 0;
  let currentInitialMessage = initialUserMessage;

  while (verificationCycle < MAX_VERIFICATION_CYCLES) {
    verificationCycle++;

    const userOnProgress = opts.onProgress;
    const wrappedOnProgress = userOnProgress
      ? (p: AgentProgress) =>
          userOnProgress({
            ...p,
            verificationCycle,
            maxVerificationCycles: MAX_VERIFICATION_CYCLES,
          })
      : undefined;

    const result = await runAgentLoop({
      systemPrompt,
      initialUserMessage: currentInitialMessage,
      tools,
      deadlineMs,
      softTurnCap: 30,
      llm: provider,
      onProgress: wrappedOnProgress,
      onConversationUpdate: (currentCycleLog) => {
        const fullLog = [...conversationLog, ...currentCycleLog];
        writeFileSync(conversationLogPath, JSON.stringify(fullLog, null, 2), 'utf8');
      },
    });

    totalTurns += result.turns;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    conversationLog = [...conversationLog, ...result.conversationLog];

    outcome = result.outcome;

    if (result.outcome !== 'done') {
      message = buildMessageFromOutcome(result);
      break;
    }

    const failures = authExternalVerification(toolDir);

    if (failures.length === 0) {
      message = result.doneSummary ?? 'Auth tool compiled';
      break;
    }

    if (verificationCycle >= MAX_VERIFICATION_CYCLES) {
      outcome = 'error';
      message = `Auth verification failed after ${MAX_VERIFICATION_CYCLES} cycles. Failures:\n${failures.join('\n')}`;
      break;
    }

    log(`auth verification failed (cycle ${verificationCycle}), resuming agent loop...`);
    currentInitialMessage = `You called done but verification failed:

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with test_auth_workflow, and call done again.`;
  }

  writeFileSync(conversationLogPath, JSON.stringify(conversationLog, null, 2), 'utf8');

  const workflowPath = pathJoin(toolDir, 'workflow.json');

  return {
    success: outcome === 'done',
    outcome,
    workflowPath: existsSync(workflowPath) ? workflowPath : undefined,
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
      return `Auth agent gave up: ${result.giveUpReason ?? 'unknown reason'}\n${result.giveUpDetail ?? ''}`;
    case 'timeout':
      return 'Auth agent timed out before completion';
    case 'soft_cap':
      return 'Auth agent exceeded soft turn cap (30 turns)';
    case 'error':
      return `Auth agent error: ${result.errorMessage ?? 'unknown error'}`;
    default:
      return 'Unknown outcome';
  }
}
