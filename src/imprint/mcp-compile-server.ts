/**
 * Stdio MCP server that exposes the compile-agent's tools to claude-cli.
 *
 * Spawned by `claude-cli-compile.ts` via `--mcp-config`. The server registers
 * the same 8 read/write tools the in-process loop uses, plus a custom `done`
 * tool that runs external verification inline and writes a sentinel file when
 * complete. claude-cli polls the sentinel and SIGTERMs us when it appears.
 *
 * Why in-tool verification: the in-process loop (agent.ts) restarts after a
 * verification failure with a continuation message. Doing the same here would
 * require killing claude-cli and re-spawning, losing context. Instead, we
 * return the failure list as the tool_result content so claude continues
 * iterating in the same conversation — same up-to-5-cycle bound, no context
 * loss.
 */

import { writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { authExternalVerification, buildAuthCompileTools } from './auth-compile-tools.ts';
import {
  type AuthToolPlan,
  type SharedModuleManifestEntry,
  resolvePlanSliceFromFile,
} from './build-plan.ts';
import {
  applyLiveVerification,
  applyParamVerification,
  buildCompileTools,
  externalVerification,
} from './compile-tools.ts';
import { loadJsonFile } from './load-json.ts';
import { createLog } from './log.ts';
import { redactSession } from './redact.ts';
import { loadCredentialStore } from './runtime.ts';
import type { SharedCompileContext, ToolCandidate } from './tool-candidates.ts';
import { type Session, SessionSchema } from './types.ts';

const log = createLog('mcp-compile');

interface RunCompileMcpServerOptions {
  /** Path to the recorded session JSON. */
  sessionPath: string;
  /** Absolute path to the generated tool directory where artifacts go. */
  toolDir: string;
  /** Hard cap on done() verification failures before we permanently fail.
   *  Mirrors compile-agent.ts MAX_VERIFICATION_CYCLES. */
  maxVerificationCycles?: number;
  candidate?: ToolCandidate;
  sharedContext?: SharedCompileContext;
  /** Absolute path to the multi-tool build plan sidecar (.build-plan.json). */
  buildPlanPath?: string;
  /** Shared-module build manifest for this site (verified flags). */
  sharedModules?: SharedModuleManifestEntry[];
  /** Present → run in AUTH mode: register the auth toolset (run_verification)
   *  and run authExternalVerification in done() instead of the data-tool
   *  verification. */
  authToolPlan?: NonNullable<AuthToolPlan>;
  /** Site slug (required in auth mode) — used to load credentials for the live
   *  auth-test tools. */
  site?: string;
}

const DONE_SENTINEL = '.compile-done.json';
const GIVE_UP_SENTINEL = '.compile-give-up.json';
/** Auth mode only: a mid-loop checkpoint the agent reaches (run_verification /
 *  prompt_user / wait_for_cooldown). The tool records the request here and the
 *  agent STOPS; the orchestrator (teach) performs the action and resumes the
 *  agent (`claude --resume`) with the result. One pending checkpoint per segment. */
const CHECKPOINT_SENTINEL = '.compile-checkpoint.json';

export async function runCompileMcpServer(opts: RunCompileMcpServerOptions): Promise<void> {
  const isAuthMode = !!opts.authToolPlan;
  const maxVerificationCycles = opts.maxVerificationCycles ?? (isAuthMode ? 3 : 5);

  // Load + auto-redact the session, exactly as compile-agent.ts does.
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
  const looksRedacted = JSON.stringify(session).includes('[REDACTED:');
  if (!looksRedacted) {
    session = redactSession(session).session;
  }

  // Build the toolset. Auth mode swaps the data tools (parser/test-oriented)
  // for the auth toolset, which lives in auth-compile-tools.ts so the in-process
  // loop and this MCP path stay byte-for-byte identical.
  type PlanSlice = ReturnType<typeof resolvePlanSliceFromFile>;
  let compileTools: ReturnType<typeof buildCompileTools>;
  let assignedSharedModules: PlanSlice['assignedSharedModules'] = [];
  let tokenParams: PlanSlice['tokenParams'] = [];
  let emittedTokens: PlanSlice['emittedTokens'] = [];
  let requiredInputs: PlanSlice['requiredInputs'] = [];
  let credentialValues: Record<string, string> = {};

  if (isAuthMode) {
    const site = opts.site ?? session.site;
    // Credentials power the live run_verification tool (and any login playbook
    // it drives). Loaded here (not passed on the command line) to keep secrets
    // out of argv.
    const creds = await loadCredentialStore(site);
    const teachCredentials = { site, values: creds?.values ?? {} };
    compileTools = buildAuthCompileTools(session, opts.toolDir, opts.sessionPath, teachCredentials);
  } else {
    // When a build plan is present, buildCompileTools also exposes read_build_plan.
    compileTools = buildCompileTools(session, opts.toolDir, opts.sessionPath, {
      candidate: opts.candidate,
      sharedContext: opts.sharedContext,
      buildPlanPath: opts.buildPlanPath,
      sharedModules: opts.sharedModules,
    });

    // Resolve the shared modules + producer→consumer token contracts + the general
    // dependency contract the plan assigned this tool, so verification can assert
    // modules are imported, require a chained test for each producer-sourced token
    // param, and inject/gate the contracted inputs.
    ({ assignedSharedModules, tokenParams, emittedTokens, requiredInputs } =
      resolvePlanSliceFromFile(opts.buildPlanPath, opts.candidate?.toolName, opts.sharedModules));
    // Credential values for the emit-time secret guard (loaded for the data path,
    // never passed on argv).
    const creds = await loadCredentialStore(opts.site ?? session.site);
    credentialValues = creds?.values ?? {};
  }

  // The custom done/give_up tools live alongside in MCP space.
  const doneTool: Tool = {
    name: 'done',
    description:
      'Call this when you have successfully completed the task. Triggers external verification of the artifacts. If verification fails, the result will list the issues and you should fix them and call done again.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was accomplished' },
      },
      required: ['summary'],
    },
  };
  const giveUpTool: Tool = {
    name: 'give_up',
    description:
      'Call this when you have encountered a categorical impossibility and cannot proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you cannot complete the task' },
        what_was_tried: {
          type: 'string',
          description: 'Summary of approaches you tried before giving up',
        },
      },
      required: ['reason', 'what_was_tried'],
    },
  };

  // Auth mode only: checkpoint tools. Each records its request to the checkpoint
  // sentinel and instructs the agent to STOP; the orchestrator performs the
  // action live (it owns the persistent browser session + the user TUI) and
  // resumes the agent with the result. The agent never runs a live login itself.
  const checkpointTools: Tool[] = isAuthMode
    ? [
        {
          name: 'run_verification',
          description:
            'Hand the current workflow.json to the verification stage to run LIVE (the only thing that fires a real login). phase="initiate" sends the OTP/push (reaches AWAITING_2FA); phase="submit_otp" submits an otp_code; phase="complete" polls a push. After calling this you MUST stop — the orchestrator runs it and resumes you with the result as a new message. Do NOT call any other tool in the same turn.',
          inputSchema: {
            type: 'object',
            properties: {
              phase: { type: 'string', enum: ['initiate', 'submit_otp', 'complete'] },
              otp_code: { type: 'string', description: 'For submit_otp only.' },
            },
            required: ['phase'],
          },
        },
        {
          name: 'prompt_user',
          description:
            'Ask the human (in the teach TUI) to supply the live second factor — e.g. enter the code they received, click the emailed link then confirm, or approve the push then confirm. Provide a clear message and optional choice options. After calling this you MUST stop; the orchestrator collects the answer and resumes you with it.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'What to ask the user to do.' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional fixed choices; omit for free-text (e.g. the OTP code).',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'wait_for_cooldown',
          description:
            'When a verification failed only because the site rate-flagged repeated logins (not a defect in your workflow), wait out a cool-off WITHOUT firing any login. After calling this you MUST stop; the orchestrator waits (informing the user) and resumes you so you can run_verification once more.',
          inputSchema: {
            type: 'object',
            properties: {
              minutes: { type: 'number', description: 'Cool-off minutes (5–10 typical).' },
              reason: {
                type: 'string',
                description: 'Why you believe it is a cool-off, not a defect.',
              },
            },
            required: ['minutes'],
          },
        },
      ]
    : [];

  let verificationFailures = 0;
  /** One pending checkpoint per segment — refuse a second so the orchestrator
   *  acts on exactly one request. Cleared implicitly: each segment is a fresh
   *  process with the sentinel removed before spawn. */
  let checkpointWritten = false;

  const server = new Server(
    { name: 'imprint-compile', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: isAuthMode
        ? 'These tools let you turn the captured login + 2FA flow into an auth workflow.json. Read the recording, write workflow.json, test it live with run_verification (AWAITING_2FA = success), and call done() when login works. The done tool verifies the workflow structure and will tell you what to fix.'
        : 'These tools let you reverse-engineer the captured session into workflow.json + parser.ts + parser.test.ts. Read the recording, write the artifacts, run tests, and call done() when verified. The done tool runs external verification and will tell you what to fix if anything is wrong.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...compileTools.map(
        (t): Tool => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema as Tool['inputSchema'],
        }),
      ),
      ...checkpointTools,
      doneTool,
      giveUpTool,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    // Custom done — runs verification inline.
    if (name === 'done') {
      const summary = (args as { summary?: string }).summary ?? 'Task completed';
      log(`done() called: ${summary}`);

      // Auth mode: lightweight structural verification (the agent already proved
      // the workflow works live via run_verification). No param/live stamps.
      if (isAuthMode) {
        const failures = authExternalVerification(
          opts.toolDir,
          (opts.authToolPlan?.captures ?? []).map((c) => ({ name: c.name, usedAs: c.usedAs })),
        );
        if (failures.length === 0) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              { summary, verification: 'passed', warnings: [], timestamp: Date.now() },
              null,
              2,
            ),
            'utf8',
          );
          log(`auth verification passed; wrote ${sentinel}`);
          return {
            content: [
              {
                type: 'text',
                text: 'DONE_VERIFIED — verification passed. The orchestrator will exit shortly. Do not call any more tools.',
              },
            ],
          };
        }

        verificationFailures++;
        log(`auth verification failed (cycle ${verificationFailures}/${maxVerificationCycles})`);
        if (verificationFailures >= maxVerificationCycles) {
          const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
          writeFileSync(
            sentinel,
            JSON.stringify(
              {
                summary,
                verification: 'failed',
                cycles: verificationFailures,
                failures,
                timestamp: Date.now(),
              },
              null,
              2,
            ),
            'utf8',
          );
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Verification failed after ${maxVerificationCycles} cycles. Giving up. Final failures:\n${failures.map((f) => `- ${f}`).join('\n')}`,
              },
            ],
          };
        }

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `You called done but verification failed (cycle ${verificationFailures}/${maxVerificationCycles}):

${failures.map((f) => `- ${f}`).join('\n')}

Fix the issues in workflow.json, re-test with run_verification, and call done again when fixed.`,
            },
          ],
        };
      }

      const { failures, warnings, paramVerification, liveVerification } =
        await externalVerification(opts.toolDir, session, opts.sessionPath, {
          expectedToolName: opts.candidate?.toolName,
          likelyParams: opts.candidate?.likelyParams,
          candidateRequestSeqs: opts.candidate?.requestSeqs,
          // Widen Fix B's variation pool to dependency requests so a token that
          // varies only across them and is frozen as a literal in the tool's
          // request is caught (the cross-request session-token leak case).
          dependencyRequestSeqs: opts.candidate?.dependencySeqs,
          assignedSharedModules,
          tokenParams,
          emittedTokens,
          requiredInputs,
          credentialValues,
        });
      if (warnings.length > 0) {
        log(`verification warnings (non-blocking):\n${warnings.join('\n')}`);
      }
      if (failures.length === 0) {
        // Persist per-parameter verified flags + the live-verification stamp
        // onto workflow.json. Audit and teach read the stamp.
        applyLiveVerification(opts.toolDir, liveVerification);
        const paramWarnings = applyParamVerification(opts.toolDir, paramVerification);
        if (paramWarnings.length > 0) {
          log(`parameter verification:\n${paramWarnings.join('\n')}`);
        }
        const allWarnings = [...warnings, ...paramWarnings];
        const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
        writeFileSync(
          sentinel,
          JSON.stringify(
            { summary, verification: 'passed', warnings: allWarnings, timestamp: Date.now() },
            null,
            2,
          ),
          'utf8',
        );
        log(`verification passed; wrote ${sentinel}`);
        return {
          content: [
            {
              type: 'text',
              text: 'DONE_VERIFIED — verification passed. The orchestrator will exit shortly. Do not call any more tools.',
            },
          ],
        };
      }

      verificationFailures++;
      log(`verification failed (cycle ${verificationFailures}/${maxVerificationCycles})`);
      if (verificationFailures >= maxVerificationCycles) {
        const sentinel = pathJoin(opts.toolDir, DONE_SENTINEL);
        writeFileSync(
          sentinel,
          JSON.stringify(
            {
              summary,
              verification: 'failed',
              cycles: verificationFailures,
              failures,
              warnings,
              timestamp: Date.now(),
            },
            null,
            2,
          ),
          'utf8',
        );
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Verification failed after ${maxVerificationCycles} cycles. Giving up. Final failures:\n${failures.map((f) => `- ${f}`).join('\n')}`,
            },
          ],
        };
      }

      const continuationMessage = `You called done but verification failed (cycle ${verificationFailures}/${maxVerificationCycles}):

${failures.map((f) => `- ${f}`).join('\n')}

Resume your work. Read the files you wrote (workflow.json, parser.ts, parser.test.ts), fix the issues, re-run tests, and call done again when fixed.`;
      return {
        isError: true,
        content: [{ type: 'text', text: continuationMessage }],
      };
    }

    // Auth-mode checkpoint tools — record the request and end the segment. The
    // orchestrator performs the action live and resumes the agent with the result.
    if (name === 'run_verification' || name === 'prompt_user' || name === 'wait_for_cooldown') {
      if (checkpointWritten) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'A checkpoint is already pending this turn. STOP now — do not call another tool; the orchestrator will act and resume you.',
            },
          ],
        };
      }
      const checkpoint: Record<string, unknown> = { kind: name, ...args, timestamp: Date.now() };
      const sentinel = pathJoin(opts.toolDir, CHECKPOINT_SENTINEL);
      writeFileSync(sentinel, JSON.stringify(checkpoint, null, 2), 'utf8');
      checkpointWritten = true;
      log(`checkpoint(${name}) recorded; wrote ${sentinel}`);
      return {
        content: [
          {
            type: 'text',
            text: `CHECKPOINT_RECORDED (${name}) — STOP now and reply briefly that you are waiting. The orchestrator will perform this and resume you with the result as a new message. Do not call any more tools.`,
          },
        ],
      };
    }

    // Custom give_up — writes sentinel and exits.
    if (name === 'give_up') {
      const reason = (args as { reason?: string }).reason ?? 'unknown';
      const whatWasTried = (args as { what_was_tried?: string }).what_was_tried ?? '';
      log(`give_up() called: ${reason}`);
      const sentinel = pathJoin(opts.toolDir, GIVE_UP_SENTINEL);
      writeFileSync(
        sentinel,
        JSON.stringify({ reason, what_was_tried: whatWasTried, timestamp: Date.now() }, null, 2),
        'utf8',
      );
      return {
        content: [
          {
            type: 'text',
            text: 'GIVE_UP_RECORDED — the orchestrator will exit shortly. Do not call any more tools.',
          },
        ],
      };
    }

    // Standard read/write tools — delegate to the shared handlers.
    const tool = compileTools.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }

    let result: { result: string; isError?: boolean };
    try {
      result = await tool.handler(args);
    } catch (err) {
      result = {
        result: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: result.result }],
      isError: result.isError ?? false,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio transport ready (${compileTools.length + 2} tools)`);

  // Block until the orchestrator closes us. Mirrors mcp-server.ts:230.
  await new Promise<void>((resolve) => {
    const close = (reason: string): void => {
      log(`closing: ${reason}`);
      resolve();
    };
    transport.onclose = () => close('client disconnected');
    process.once('SIGINT', () => close('SIGINT'));
    process.once('SIGTERM', () => close('SIGTERM'));
  });
}

/** Sentinel file names exposed for the orchestrator to poll. */
export const COMPILE_SENTINELS = {
  done: DONE_SENTINEL,
  giveUp: GIVE_UP_SENTINEL,
  checkpoint: CHECKPOINT_SENTINEL,
} as const;
