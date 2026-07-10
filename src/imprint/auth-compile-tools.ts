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
  buildSearchRequestsTool,
  buildWriteFileTool,
} from './compile-tools.ts';
import { parsePlaybook } from './playbook-parser.ts';
import { collectStatePlaceholders } from './runtime.ts';
import { WorkflowSchema } from './types.ts';
import type { Locator, Playbook, Session, Workflow } from './types.ts';

type TeachCredentials = { site: string; values: Record<string, string> };

export const AUTH_VERIFICATION_ATTEMPT_SENTINEL = '.auth-verification-attempt.json';

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
  'search_requests',
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
  const writeFile = buildWriteFileTool(
    toolDir,
    process.env.IMPRINT_AUTH_ALLOW_PLAYBOOK_FALLBACK === '1' ? ['playbook.yaml'] : [],
  );
  const writeHandler = writeFile.handler;
  const runBash = buildRunBashTool(toolDir);
  return [
    buildReadSessionSummaryTool(session, context),
    buildSearchRequestsTool(session),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    {
      ...writeFile,
      // Auth normally runs on cdp-replay (a real headed browser that replays the
      // recorded requests in-page). A login playbook fallback exists only as an
      // explicitly enabled last resort for non-replayable browser-minted submits.
      //
      // Validate workflow.json before writing it so the agent gets immediate,
      // non-live feedback for recorded-only auth values instead of burning
      // verifier attempts on a workflow that is already structurally stale.
      handler: async (input: unknown) => {
        const { relativePath, content } = input as { relativePath?: string; content?: string };
        if (relativePath === 'workflow.json' && typeof content === 'string') {
          const failures = authWorkflowContentPreflightFailures(content, session);
          if (failures.length > 0) {
            return {
              result: `workflow.json rejected by auth preflight:\n${failures
                .map((failure) => `- ${failure}`)
                .join('\n')}`,
              isError: true,
            };
          }
        }
        return writeHandler(input);
      },
    },
    buildReadFileTool(toolDir),
    {
      ...runBash,
      handler: async (input: unknown) => {
        if (!existsSync(pathJoin(toolDir, 'workflow.json'))) {
          return {
            result:
              'run_bash is unavailable before the first workflow.json. Use the recording tools, write the recording-derived auth workflow, and request live verification first.',
            isError: true,
          };
        }
        return runBash.handler(input);
      },
    },
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
  options: { requireLiveAttempt?: boolean } = {},
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

  if (options.requireLiveAttempt) {
    failures.push(...authWorkflowPreflightFailuresFromWorkflow(workflow));
    failures.push(...authVerificationAttemptFailures(toolDir, workflow));
  } else {
    failures.push(...authExternalStructureFailures(workflow));
  }

  if (workflow.toolKind !== 'authenticate') {
    failures.push(
      `workflow.toolKind must be 'authenticate', got '${workflow.toolKind ?? '(undefined)'}'`,
    );
  }

  if (!workflow.requests || workflow.requests.length === 0) {
    failures.push('workflow.requests is empty — auth tool needs at least one request');
  }

  // Downstream auth contract: every durable token a DATA tool consumes via
  // ${credential.<name>} (a build-plan authTool capture whose usedAs is a header)
  // must be persisted by a matching authConfig.sessionCapture, or the data tool's
  // contracted auth header can never resolve at runtime. Cookies persist
  // automatically, so only the NON-cookie header contracts are checked here.
  const authConfig = workflow.authConfig;
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

  failures.push(...authPlaybookVerificationFailures(toolDir));

  return failures;
}

/** Preserve the external verifier's compatibility contract for callers that
 * only need artifact-shape checks. Compiler done() paths opt into the stricter
 * write-time preflight together with the live-attempt gate above. */
function authExternalStructureFailures(workflow: Workflow): string[] {
  const failures: string[] = [];
  const authConfig = workflow.authConfig;

  if (!authConfig) {
    failures.push('workflow.authConfig is missing');
    return failures;
  }

  if (authConfig.twoFactorType === 'push') {
    if (!authConfig.pollEndpoint) {
      failures.push("authConfig.twoFactorType is 'push' but authConfig.pollEndpoint is missing");
    }
    return failures;
  }

  if (authConfig.twoFactorType !== 'otp') return failures;

  if (!workflow.parameters.some((parameter) => parameter.name === 'otp_code')) {
    failures.push("authConfig.twoFactorType is 'otp' but no 'otp_code' parameter is declared");
  }

  const initiateCount = authConfig.initiateRequestCount || 0;
  const initiateCaptureNames = new Set<string>();
  for (const request of workflow.requests.slice(0, initiateCount)) {
    for (const capture of request.captures ?? []) initiateCaptureNames.add(capture.name);
  }

  const available = new Set([...(authConfig.twoFactorContext ?? []), ...initiateCaptureNames]);
  const uncovered = new Set<string>();
  for (const request of workflow.requests.slice(initiateCount)) {
    for (const name of collectStatePlaceholders(request)) {
      if (!available.has(name)) uncovered.add(name);
    }
  }
  if (uncovered.size > 0) {
    const refs = [...uncovered].map((name) => `\${state.${name}}`).join(', ');
    failures.push(
      `submit_otp requests reference ${refs} but those are neither listed in authConfig.twoFactorContext nor captured on an initiate-phase request — they will be undefined on the stateless submit_otp call`,
    );
  }

  return failures;
}

function authVerificationAttemptFailures(toolDir: string, workflow: Workflow): string[] {
  const attemptPath = pathJoin(toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL);
  if (!existsSync(attemptPath)) {
    return ['no live auth verification attempt was recorded; call run_verification before done'];
  }

  let attempt: { phase?: unknown; ok?: unknown };
  try {
    attempt = JSON.parse(readFileSync(attemptPath, 'utf8')) as {
      phase?: unknown;
      ok?: unknown;
    };
  } catch (err) {
    return [
      `live auth verification record is invalid: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }

  if (attempt.ok !== true) {
    return [
      'the most recent live auth verification did not succeed; fix the workflow and verify again',
    ];
  }

  const twoFactorType = workflow.authConfig?.twoFactorType ?? 'none';
  const requiredPhase =
    twoFactorType === 'push' ? 'complete' : twoFactorType === 'otp' ? 'submit_otp' : 'initiate';
  if (attempt.phase !== requiredPhase) {
    return [
      `the most recent live auth verification succeeded only for phase ${JSON.stringify(attempt.phase)}; a ${twoFactorType} workflow must successfully verify phase ${JSON.stringify(requiredPhase)} before done`,
    ];
  }
  return [];
}

export function authWorkflowPreflightFailures(toolDir: string, session?: Session): string[] {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return ['workflow.json does not exist'];
  return authWorkflowContentPreflightFailures(readFileSync(workflowPath, 'utf8'), session);
}

/** A signed/encrypted credential request must reach the live verifier before an
 * agent can classify its recorded envelope as stale. This gate is deliberately
 * recording-driven and provider-independent. */
export function authGiveUpPreflightFailures(
  toolDir: string,
  session: Session,
  loginRequestSeqs: number[],
): string[] {
  const loginRequests =
    loginRequestSeqs.length > 0
      ? session.requests.filter((request) => loginRequestSeqs.includes(request.seq))
      : session.requests;
  const hasRecordedCrypto = loginRequests.some(
    (request) => request.body && bodyContainsRecordedCryptoField(request.body),
  );
  if (!hasRecordedCrypto) return [];
  if (existsSync(pathJoin(toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL))) return [];
  return [
    'The recorded credential submit contains signed/encrypted auth fields, but no live verification has run. Preserve the recorded envelope in workflow.json and call run_verification before classifying it as stale or calling give_up.',
  ];
}

function authWorkflowContentPreflightFailures(content: string, session?: Session): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return [`workflow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    return [`workflow.json does not match WorkflowSchema: ${parsed.error.message}`];
  }

  return [
    ...authWorkflowPreflightFailuresFromWorkflow(parsed.data),
    ...recordingAwareAuthWorkflowFailures(parsed.data, session),
  ];
}

function authWorkflowPreflightFailuresFromWorkflow(workflow: Workflow): string[] {
  const failures: string[] = [];
  if (workflow.toolKind !== 'authenticate') return failures;

  failures.push(...authPhaseStructureFailures(workflow));

  workflow.requests.forEach((request, requestIndex) => {
    const where = `request ${requestIndex}`;
    if (requestCarriesPkceChallenge(request)) {
      failures.push(
        `${where} carries an OAuth PKCE code challenge directly. A challenge is only valid with the verifier state owned by the relying-party page; use search_requests to find the recorded Document producer and represent that GET with mode="navigate" instead of replaying or synthesizing the issuer/API request.`,
      );
    }
    if (request.mode === 'navigate') {
      if (request.method.toUpperCase() !== 'GET') {
        failures.push(
          `${where} uses mode="navigate" but method is ${request.method}; navigation only supports GET`,
        );
      }
      if (!request.navigation?.urlIncludes && !request.navigation?.cookie) {
        failures.push(
          `${where} uses mode="navigate" without navigation.urlIncludes or navigation.cookie evidence; bound completion to a recorded redirect URL or resulting cookie`,
        );
      }
      if (request.navigation?.urlIncludes && request.url.includes(request.navigation.urlIncludes)) {
        failures.push(
          `${where} navigation.urlIncludes already matches the starting URL and cannot prove that navigation completed; use a recorded destination URL or resulting cookie`,
        );
      }
    } else if (request.navigation) {
      failures.push(`${where} declares navigation criteria without mode="navigate"`);
    }
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!looksDynamicTemplate(value) && isRecordedCorrelationHeader(name, value)) {
        failures.push(
          `${where} header "${name}" hardcodes a recorded correlation/request id (${redactExample(
            value,
          )}). Use a supported generated/state value, or omit the header if the browser/site regenerates it.`,
        );
      }
    }

    if (!request.body) return;
    for (const finding of recordedOnlyBodyFindings(request.body)) {
      failures.push(`${where} body ${finding}`);
    }
  });

  return failures;
}

function requestCarriesPkceChallenge(request: Workflow['requests'][number]): boolean {
  if (/[?&]code_challenge=/i.test(request.url)) return true;
  if (!request.body) return false;
  if (/(?:^|[&?])code_?challenge=/i.test(request.body)) return true;
  try {
    const parsed = JSON.parse(request.body) as unknown;
    return objectHasPkceChallengeKey(parsed);
  } catch {
    return false;
  }
}

function objectHasPkceChallengeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(objectHasPkceChallengeKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => /^code_?challenge$/i.test(key) || objectHasPkceChallengeKey(child),
  );
}

function authPhaseStructureFailures(workflow: Workflow): string[] {
  const failures: string[] = [];
  const authConfig = workflow.authConfig;
  if (!authConfig) return ['workflow.authConfig is missing'];
  if (authConfig.twoFactorType === 'none') return failures;

  const initiateCount = authConfig.initiateRequestCount;
  if (initiateCount <= 0) {
    failures.push(
      'authConfig.initiateRequestCount must include the login and 2FA-delivery requests; zero cannot deliver a challenge',
    );
    return failures;
  }
  if (initiateCount >= workflow.requests.length) {
    failures.push(
      `authConfig.initiateRequestCount (${initiateCount}) must leave at least one request for the completion phase`,
    );
    return failures;
  }

  const contextNames = new Set(authConfig.twoFactorContext);
  if (contextNames.size === 0) {
    failures.push(
      'authConfig.twoFactorContext must name the challenge/tracking values carried from initiate into completion',
    );
  }

  const deliveryRequest = workflow.requests[initiateCount - 1];
  const deliveryEvidence = (deliveryRequest?.captures ?? []).filter((capture) =>
    contextNames.has(capture.name),
  );
  if (deliveryEvidence.length === 0) {
    failures.push(
      'the final initiate request must capture at least one authConfig.twoFactorContext value as evidence that the 2FA delivery request succeeded',
    );
  }

  if (authConfig.twoFactorType === 'push' && !authConfig.pollEndpoint) {
    failures.push("authConfig.twoFactorType is 'push' but authConfig.pollEndpoint is missing");
  }
  if (
    authConfig.twoFactorType === 'otp' &&
    !workflow.parameters.some((parameter) => parameter.name === 'otp_code')
  ) {
    failures.push("authConfig.twoFactorType is 'otp' but no 'otp_code' parameter is declared");
  }

  const available = new Set(contextNames);
  const uncovered = new Set<string>();
  if (authConfig.pollBody) {
    for (const match of authConfig.pollBody.matchAll(/\$\{state\.([A-Za-z0-9_.-]+)\}/g)) {
      const name = match[1];
      if (name && !available.has(name)) uncovered.add(name);
    }
  }
  for (const request of workflow.requests.slice(initiateCount)) {
    for (const name of collectStatePlaceholders(request)) {
      if (!available.has(name)) uncovered.add(name);
    }
    for (const capture of request.captures ?? []) available.add(capture.name);
  }
  if (uncovered.size > 0) {
    const refs = [...uncovered].map((name) => `\${state.${name}}`).join(', ');
    failures.push(
      `completion references ${refs} before those values are available; carry initiate values in authConfig.twoFactorContext or capture them earlier in completion`,
    );
  }

  return failures;
}

function looksDynamicTemplate(value: string): boolean {
  return /\$\{(?:credential|state|param|response\[\d+\]|generated|env)\./.test(value);
}

function recordingAwareAuthWorkflowFailures(workflow: Workflow, session?: Session): string[] {
  if (!session) return [];

  const failures: string[] = [];
  failures.push(...recordingAwareCaptureFailures(workflow, session));
  if (workflow.requestTransformModule) return failures;

  workflow.requests.forEach((request, requestIndex) => {
    if (!request.body || !requestBodySubmitsCredentialPassword(request.body)) return;

    const recorded = session.requests.find(
      (captured) =>
        captured.method.toUpperCase() === request.method.toUpperCase() &&
        captured.url === request.url,
    );
    if (!recorded?.body || !bodyContainsRecordedCryptoField(recorded.body)) return;
    // A recorded signed/encrypted envelope may still be replayable from the
    // live login page. Preserve it and let bounded CDP verification decide.
    // What is never equivalent is dropping the envelope and submitting only
    // the raw credential fields.
    if (
      bodyContainsRecordedCryptoField(request.body) ||
      bodyContainsDynamicCryptoField(request.body)
    ) {
      return;
    }

    failures.push(
      `request ${requestIndex} ${request.method} ${request.url} submits ${'${credential.password}'} directly, but the matching recording sent browser-computed auth crypto fields. Add a requestTransformModule that derives the live encrypted/signature fields, capture them from a prior live response if the site exposes them, or give up under the no-playbook policy instead of replacing the encrypted login with a non-equivalent raw-password form.`,
    );
  });

  return failures;
}

function recordingAwareCaptureFailures(workflow: Workflow, session: Session): string[] {
  const failures: string[] = [];
  workflow.requests.forEach((request, requestIndex) => {
    const recorded = session.requests.find(
      (candidate) =>
        candidate.method.toUpperCase() === request.method.toUpperCase() &&
        candidate.url === request.url,
    );
    if (!recorded?.response?.body) return;

    let response: unknown;
    try {
      response = JSON.parse(recorded.response.body);
    } catch {
      return;
    }

    for (const capture of request.captures ?? []) {
      if (capture.source !== 'json') continue;
      const brittle = fixedIndexWithRecordedDiscriminator(capture.path, response);
      if (!brittle) continue;
      failures.push(
        `request ${requestIndex} capture "${capture.name}" path "${capture.path}" uses fixed index [${brittle.index}] for a recorded array whose elements have distinct "${brittle.field}" values. Select by the stable field predicate [${brittle.field}=${brittle.value}] so live array reordering cannot select a different auth method/device.`,
      );
    }
  });
  return failures;
}

type JsonPathToken =
  | { kind: 'property'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'predicate'; field: string; value: string };

function fixedIndexWithRecordedDiscriminator(
  path: string,
  root: unknown,
): { index: number; field: string; value: string } | undefined {
  const tokens = parseCapturePath(path);
  if (!tokens) return undefined;

  let current = root;
  for (const token of tokens) {
    if (token.kind === 'property') {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[token.value];
      continue;
    }
    if (token.kind === 'predicate') {
      if (!Array.isArray(current)) return undefined;
      current = current.find(
        (item) =>
          item != null &&
          typeof item === 'object' &&
          String((item as Record<string, unknown>)[token.field]) === token.value,
      );
      continue;
    }

    if (!Array.isArray(current)) return undefined;
    if (current.length > 1) {
      const discriminator = recordedArrayDiscriminator(current, token.value);
      if (discriminator) return { index: token.value, ...discriminator };
    }
    current = current[token.value];
  }
  return undefined;
}

function parseCapturePath(path: string): JsonPathToken[] | undefined {
  const tokens: JsonPathToken[] = [];
  let cursor = path.startsWith('$') ? 1 : 0;
  while (cursor < path.length) {
    if (path[cursor] === '.') {
      cursor += 1;
      continue;
    }
    if (path[cursor] === '[') {
      const end = path.indexOf(']', cursor + 1);
      if (end < 0) return undefined;
      const content = path.slice(cursor + 1, end);
      if (/^\d+$/.test(content)) {
        tokens.push({ kind: 'index', value: Number.parseInt(content, 10) });
      } else {
        const equalsAt = content.indexOf('=');
        if (equalsAt <= 0) return undefined;
        tokens.push({
          kind: 'predicate',
          field: content.slice(0, equalsAt),
          value: content.slice(equalsAt + 1),
        });
      }
      cursor = end + 1;
      continue;
    }

    const end = path.slice(cursor).search(/[.[]/);
    const next = end < 0 ? path.length : cursor + end;
    if (next === cursor) return undefined;
    tokens.push({ kind: 'property', value: path.slice(cursor, next) });
    cursor = next;
  }
  return tokens;
}

function recordedArrayDiscriminator(
  items: unknown[],
  selectedIndex: number,
): { field: string; value: string } | undefined {
  const selected = items[selectedIndex];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return undefined;
  if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    return undefined;
  }

  const selectedRecord = selected as Record<string, unknown>;
  const candidates = Object.keys(selectedRecord)
    .filter((field) => {
      const values = items.map((item) => (item as Record<string, unknown>)[field]);
      if (values.some((value) => !isPredicateScalar(value))) return false;
      const strings = values.map(String);
      return (
        new Set(strings).size === strings.length && !strings.some((value) => value.includes(']'))
      );
    })
    .sort((a, b) => discriminatorPriority(a) - discriminatorPriority(b));
  const field = candidates[0];
  if (!field) return undefined;
  return { field, value: String(selectedRecord[field]) };
}

function isPredicateScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function discriminatorPriority(field: string): number {
  if (/^(?:category|type|method|deliveryMethod)$/i.test(field)) return 0;
  if (/^(?:name|id|kind)$/i.test(field)) return 1;
  return 2;
}

function requestBodySubmitsCredentialPassword(body: string): boolean {
  return /\$\{credential\.password\}/.test(body);
}

function bodyContainsRecordedCryptoField(body: string): boolean {
  return bodyEntries(body).some(([key, value]) => isRecordedCryptoField(key, value));
}

function bodyContainsDynamicCryptoField(body: string): boolean {
  return bodyEntries(body).some(
    ([key, value]) =>
      /^(?:encryptedData|encryptedPayload|encryptedPassword|signature|sig|publicKey)$/i.test(key) &&
      looksDynamicTemplate(value),
  );
}

function bodyEntries(body: string): Array<[string, string]> {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const entries: Array<[string, string]> = [];
      collectJsonStringEntries(JSON.parse(trimmed), [], entries);
      return entries;
    } catch {
      return [];
    }
  }

  if (!body.includes('=')) return [];
  return [...new URLSearchParams(body).entries()];
}

function collectJsonStringEntries(
  value: unknown,
  path: string[],
  entries: Array<[string, string]>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectJsonStringEntries(item, [...path, String(index)], entries),
    );
    return;
  }
  if (value == null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    if (typeof child === 'string') entries.push([key, child]);
    collectJsonStringEntries(child, nextPath, entries);
  }
}

function isRecordedCorrelationHeader(name: string, value: string): boolean {
  return (
    /(?:^|[-_])(correlation|request|trace|transaction)[-_]?(?:id|identifier)?(?:$|[-_])/i.test(
      name,
    ) && looksLikeUuid(value)
  );
}

function recordedOnlyBodyFindings(body: string): string[] {
  const failures: string[] = [];
  const trimmed = body.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectRecordedOnlyJsonFindings(JSON.parse(trimmed), [], failures);
      return failures;
    } catch {
      return failures;
    }
  }

  if (body.includes('=')) {
    const params = new URLSearchParams(body);
    for (const [key, value] of params.entries()) {
      if (looksDynamicTemplate(value)) continue;
      if (isRecordedBrowserTimeField(key)) {
        failures.push(
          `field "${key}" hardcodes browser-time value "${value}". Remove it if optional, or regenerate it instead of freezing the recording's clock.`,
        );
      } else if (isRecordedNonceField(key, value)) {
        failures.push(
          `field "${key}" hardcodes a recorded nonce/challenge (${redactExample(
            value,
          )}). Wire it from ${'${generated.uuid}'}/${'${generated.nonce}'} or a state capture, not the recording.`,
        );
      }
    }
  }

  return failures;
}

function collectRecordedOnlyJsonFindings(value: unknown, path: string[], failures: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectRecordedOnlyJsonFindings(item, [...path, String(index)], failures),
    );
    return;
  }
  if (value == null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    if (typeof child === 'string' && !looksDynamicTemplate(child)) {
      if (isRecordedNonceField(key, child)) {
        failures.push(
          `field "${nextPath.join('.')}" hardcodes a recorded nonce/challenge (${redactExample(
            child,
          )}). Use a generated value or derive/capture the live value instead.`,
        );
      } else if (key === 'name' && looksLikePersonalDeviceLocator(child)) {
        failures.push(
          `field "${nextPath.join('.')}" hardcodes account/device-specific text "${child}". Remove the optional trusted-device request or use a portable value.`,
        );
      }
    }
    collectRecordedOnlyJsonFindings(child, nextPath, failures);
  }
}

function isRecordedBrowserTimeField(key: string): boolean {
  return /^b_(?:hour|minute|second|dayNumber|month|year|timeZone)$/i.test(key);
}

function isRecordedNonceField(key: string, value: string): boolean {
  return (
    /^(?:nonce|codeChallenge|code_challenge|codeVerifier|code_verifier)$/i.test(key) ||
    (/(?:nonce|challenge|correlation|requestId|trackingId|messageTrackingId)$/i.test(key) &&
      looksLikeUuid(value))
  );
}

function isRecordedCryptoField(key: string, value: string): boolean {
  if (
    !/^(?:encryptedData|encryptedPayload|encryptedPassword|signature|sig|publicKey)$/i.test(key)
  ) {
    return false;
  }
  const decoded = safeDecodeURIComponent(value);
  return looksLikeHighEntropyAuthValue(decoded);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeHighEntropyAuthValue(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 32) return false;
  if (/^[A-Za-z0-9+/=_-]+$/.test(compact)) return true;
  if (/^[0-9a-f]+$/i.test(compact)) return true;
  return false;
}

function looksLikeUuid(value: string): boolean {
  return /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(value);
}

function redactExample(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function authPlaybookVerificationFailures(toolDir: string): string[] {
  const playbookPath = pathJoin(toolDir, 'playbook.yaml');
  if (!existsSync(playbookPath)) return [];

  let playbook: Playbook;
  try {
    playbook = parsePlaybook(readFileSync(playbookPath, 'utf8'));
  } catch (err) {
    return [
      `playbook.yaml is not valid or does not match PlaybookSchema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ];
  }

  const overfitLocators = collectAuthPlaybookLocatorStrings(playbook).filter((value) =>
    looksLikePersonalDeviceLocator(value),
  );
  if (overfitLocators.length === 0) return [];

  const examples = [...new Set(overfitLocators)]
    .slice(0, 5)
    .map((v) => `"${v}"`)
    .join(', ');
  return [
    `playbook.yaml contains account/device-specific locator text (${examples}). Use stable semantic login/challenge labels or structural locators; do not target a particular user's device, account name, masked destination, or recording-specific option text.`,
  ];
}

function collectAuthPlaybookLocatorStrings(playbook: Playbook): string[] {
  const values: string[] = [];
  const addLocator = (loc: Locator): void => {
    if ('value' in loc && loc.value) values.push(loc.value);
    if ('value_pattern' in loc && loc.value_pattern) values.push(loc.value_pattern);
    if ('name' in loc && loc.name) values.push(loc.name);
  };

  for (const step of playbook.steps) {
    if ('locators' in step && step.locators) {
      for (const loc of step.locators) addLocator(loc);
    }
  }
  if (playbook.result.source === 'dom') {
    for (const loc of playbook.result.locators) addLocator(loc);
  }
  return values;
}

function looksLikePersonalDeviceLocator(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  // Auth playbooks should not select a concrete user's enrolled device or
  // account option. These labels vary per account and make the compiled tool
  // non-portable even when the login protocol is otherwise correct.
  return /\b(?:iPhone|iPad|Pixel|Galaxy|Android|MacBook|Windows\s+PC|Chrome Browser on Mac OS Desktop)\b/i.test(
    normalized,
  );
}
