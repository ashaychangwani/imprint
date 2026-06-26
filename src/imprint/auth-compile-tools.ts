/**
 * Auth-specific compile tools + verification, shared by both auth compile
 * drivers:
 *   - the in-process runAgentLoop path (auth-compile-agent.ts, anthropic-api)
 *   - the claude-cli / codex-cli path (mcp-compile-server.ts in auth mode)
 *
 * Keeping these in one module guarantees the agent sees an identical toolset
 * and identical external verification regardless of which provider drives it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { AgentTool } from './agent.ts';
import {
  type CompileToolContext,
  buildReadFileTool,
  buildReadRequestTool,
  buildReadResponseBodyTool,
  buildReadSessionSummaryTool,
  buildRunBashTool,
  buildWriteFileTool,
} from './compile-tools.ts';
import { collectStatePlaceholders } from './runtime.ts';
import { WorkflowSchema } from './types.ts';
import type { Session } from './types.ts';

type TeachCredentials = { site: string; values: Record<string, string> };

/** Carried by the CLI compile drivers (claude-cli / codex-cli) to switch the
 *  shared spawn machinery from a data compile to an auth compile: the MCP
 *  server is launched in auth mode, and the agent gets the auth tool list +
 *  initial prompt. */
export interface AuthCliCompileMode {
  /** Site slug — the MCP server loads credentials from the store for it. */
  site: string;
  /** JSON-serialized AuthToolPlan, passed to the MCP server. */
  authPlanJson: string;
  /** Short tool names to pre-approve (the driver prefixes them per provider). */
  allowedTools: readonly string[];
  /** The initial user message handed to the agent on turn 1. */
  initialPrompt: string;
}

/** Short names of every tool the auth compile agent may call (excluding the
 *  lifecycle done/give_up). Used by the claude-cli path to build --allowedTools.
 *  The agent SHAPES from the recording with the read/write tools and never logs
 *  in itself; live login happens only via the checkpoint tools (run_verification
 *  / prompt_user / wait_for_cooldown), which the orchestrator executes. */
export const AUTH_COMPILE_TOOL_NAMES = [
  'read_session_summary',
  'read_request',
  'read_response_body',
  'write_file',
  'read_file',
  'run_bash',
  'run_verification',
  'prompt_user',
  'wait_for_cooldown',
] as const;

/** Assemble the auth compile SHAPING toolset (read/write only — no live login).
 *  The checkpoint tools (run_verification/prompt_user/wait_for_cooldown) and
 *  done()/give_up() are appended by the driver (mcp-compile-server in auth mode)
 *  because they are orchestrator-mediated, not executed in this process. */
export function buildAuthCompileTools(
  session: Session,
  toolDir: string,
  _sessionPath: string,
  teachCredentials: TeachCredentials,
): AgentTool[] {
  const context: CompileToolContext = { teachCredentials };
  return [
    buildReadSessionSummaryTool(session, context),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    // Auth runs on cdp-replay only (a real headed browser that replays the
    // recorded requests in-page) — there is no playbook rung in the auth path, so
    // the agent emits workflow.json only. No playbook.yaml in the write allowlist.
    buildWriteFileTool(toolDir),
    buildReadFileTool(toolDir),
    buildRunBashTool(toolDir),
  ];
}

// ─── External verification ──────────────────────────────────────────────────

/** Lightweight structural checks after the agent calls done(). The agent has
 *  already proven the workflow works live (AWAITING_2FA / ok:true from
 *  run_verification); this just guards the artifact's shape. Returns a list
 *  of failure strings (empty = passed).
 *
 *  `requiredSessionCaptures` carries the build plan's authTool captures: every
 *  durable token a downstream DATA tool consumes via `${credential.<name>}`
 *  (`usedAs` names the header it injects). For each one, the auth workflow MUST
 *  declare a matching `authConfig.sessionCapture` so the login persists it —
 *  otherwise the data tool's contracted auth header can never resolve at runtime. */
export function authExternalVerification(
  toolDir: string,
  requiredSessionCaptures: Array<{ name: string; usedAs?: string }> = [],
): string[] {
  const failures: string[] = [];
  const workflowPath = pathJoin(toolDir, 'workflow.json');

  if (!existsSync(workflowPath)) {
    failures.push('workflow.json does not exist');
    return failures;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(workflowPath, 'utf8'));
  } catch (err) {
    failures.push(
      `workflow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return failures;
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    failures.push(`workflow.json does not match WorkflowSchema: ${parsed.error.message}`);
    return failures;
  }

  const workflow = parsed.data;

  if (workflow.toolKind !== 'authenticate') {
    failures.push(
      `workflow.toolKind must be 'authenticate', got '${workflow.toolKind ?? '(undefined)'}'`,
    );
  }

  if (!workflow.requests || workflow.requests.length === 0) {
    failures.push('workflow.requests is empty — auth tool needs at least one request');
  }

  // Structural 2FA checks — assert the *shape* each structural case needs, never
  // a channel name or response string. WorkflowSchema already constrains the
  // enum to otp|push|none, so we only check that the artifact carries what the
  // runtime needs to actually run that case.
  const authConfig = workflow.authConfig;
  if (!authConfig) {
    failures.push('workflow.authConfig is missing');
  } else if (authConfig.twoFactorType === 'push') {
    // Push completes by polling an endpoint until a recording-grounded terminal
    // (pollTerminal) resolves; without an endpoint there's nothing to poll.
    if (!authConfig.pollEndpoint) {
      failures.push("authConfig.twoFactorType is 'push' but authConfig.pollEndpoint is missing");
    }
  } else if (authConfig.twoFactorType === 'otp') {
    // OTP completes via a second request carrying the live code.
    if (!workflow.parameters.some((p) => p.name === 'otp_code')) {
      failures.push("authConfig.twoFactorType is 'otp' but no 'otp_code' parameter is declared");
    }
    // Every ${state.X} the completion requests read must be carried across the
    // stateless initiate→submit_otp gap: either echoed via twoFactorContext or
    // (re)produced by a capture on an initiate-phase request.
    const initiateCount = authConfig.initiateRequestCount || 0;
    const completionRequests = workflow.requests.slice(initiateCount);
    const initiateCaptureNames = new Set<string>();
    // slice(0, initiateCount) — NOT `initiateCount || undefined`: when the count is
    // 0/unset there are NO initiate-phase requests, so `slice(0, 0)` must yield an
    // empty set. `|| undefined` would make this `slice(0, undefined)` = ALL requests,
    // counting completion-phase captures as "covered" and defeating the check.
    for (const req of workflow.requests.slice(0, initiateCount)) {
      for (const cap of req.captures ?? []) initiateCaptureNames.add(cap.name);
    }
    const covered = new Set([...(authConfig.twoFactorContext ?? []), ...initiateCaptureNames]);
    const uncovered = new Set<string>();
    for (const req of completionRequests) {
      for (const name of collectStatePlaceholders(req)) {
        if (!covered.has(name)) uncovered.add(name);
      }
    }
    if (uncovered.size > 0) {
      const refs = [...uncovered].map((n) => `\${state.${n}}`).join(', ');
      failures.push(
        `submit_otp requests reference ${refs} but those are neither listed in authConfig.twoFactorContext nor captured on an initiate-phase request — they will be undefined on the stateless submit_otp call`,
      );
    }
  }

  // Downstream auth contract: every durable token a DATA tool consumes via
  // ${credential.<name>} (a build-plan authTool capture whose usedAs is a header)
  // must be persisted by a matching authConfig.sessionCapture, or the data tool's
  // contracted auth header can never resolve at runtime. Cookies persist
  // automatically, so only the NON-cookie header contracts are checked here.
  const headerContracts = requiredSessionCaptures.filter((c) => {
    const u = (c.usedAs ?? '').toLowerCase();
    // Cookies persist automatically via the jar — only NON-cookie header tokens
    // need a sessionCapture.
    return u.startsWith('header:') && u !== 'header:cookie' && u !== 'header:set-cookie';
  });
  if (headerContracts.length > 0) {
    const persisted = new Set((authConfig?.sessionCapture ?? []).map((c) => c.name));
    const missing = headerContracts.filter((c) => !persisted.has(c.name));
    if (missing.length > 0) {
      failures.push(
        `the build plan's data tools consume ${missing
          .map((c) => `\`\${credential.${c.name}}\` (used as ${c.usedAs})`)
          .join(', ')} but workflow.authConfig.sessionCapture does not persist ${
          missing.length === 1 ? 'it' : 'them'
        }. Add a sessionCapture for each so a SUCCESSFUL login stores the token as a durable credential the data tools can reuse — grounded in the login completion response (a body field or a response header), never invented.`,
      );
    }
  }

  return failures;
}
