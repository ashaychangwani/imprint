/**
 * Recording tools and contract-level verification shared by every auth compile
 * provider. Site behavior is decided by the compile agent and encoded in the
 * auth action program, not inferred here.
 */

import { createHash } from 'node:crypto';
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
import { recordedRequestMatchesWorkflow } from './recording-request.ts';
import { captureHeader, captureValueMatches, jsonpath } from './request-capture.ts';
import { type Session, type Workflow, WorkflowSchema } from './types.ts';

type TeachCredentials = { site: string; values: Record<string, string> };

export const AUTH_VERIFICATION_ATTEMPT_SENTINEL = '.auth-verification-attempt.json';

export interface AuthCliCompileMode {
  site: string;
  authPlanJson: string;
  allowedTools: readonly string[];
  initialPrompt: string;
}

export const AUTH_COMPILE_TOOL_NAMES = [
  'read_session_summary',
  'search_requests',
  'read_request',
  'read_response_body',
  'write_file',
  'read_file',
  'run_bash',
  'run_verification',
  'inspect_verification_page',
  'prompt_user',
  'wait_for_cooldown',
] as const;

export function buildAuthCompileTools(
  session: Session,
  toolDir: string,
  _sessionPath: string,
  teachCredentials: TeachCredentials,
): AgentTool[] {
  const context: CompileToolContext = { teachCredentials };
  return [
    buildReadSessionSummaryTool(session, context),
    buildSearchRequestsTool(session),
    buildReadRequestTool(session),
    buildReadResponseBodyTool(session),
    buildWriteFileTool(toolDir),
    buildReadFileTool(toolDir),
    buildRunBashTool(toolDir),
  ];
}

export function authWorkflowPreflightFailures(
  toolDir: string,
  session?: Session,
  requiredCredentialNames: readonly string[] = [],
): string[] {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return ['workflow.json does not exist'];
  return parseWorkflow(workflowPath, requiredCredentialNames, session).failures;
}

export function authExternalVerification(
  toolDir: string,
  requiredSessionCaptures: Array<{ name: string; usedAs?: string }> = [],
  options: { requireLiveAttempt?: boolean; requiredCredentialNames?: readonly string[] } = {},
): string[] {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return ['workflow.json does not exist'];

  const parsed = parseWorkflow(workflowPath, options.requiredCredentialNames);
  if (!parsed.workflow) return parsed.failures;
  const failures = [...parsed.failures];
  const workflow = parsed.workflow;
  const persisted = new Set(workflow.authConfig?.persist ?? []);

  const missingContracts = requiredSessionCaptures.filter((capture) => {
    const target = (capture.usedAs ?? '').toLowerCase();
    return (
      target.startsWith('header:') &&
      target !== 'header:cookie' &&
      target !== 'header:set-cookie' &&
      !persisted.has(capture.name)
    );
  });
  if (missingContracts.length > 0) {
    failures.push(
      `authConfig.persist must include downstream credential capture(s): ${missingContracts
        .map((capture) => capture.name)
        .join(', ')}`,
    );
  }

  if (options.requireLiveAttempt) {
    failures.push(...liveAttemptFailures(toolDir, workflow));
  }
  return failures;
}

function parseWorkflow(
  path: string,
  requiredCredentialNames: readonly string[] = [],
  session?: Session,
): { workflow?: Workflow; failures: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      failures: [
        `workflow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      failures: [`workflow.json does not match WorkflowSchema: ${parsed.error.message}`],
    };
  }
  return {
    workflow: parsed.data,
    failures: authProgramFailures(parsed.data, requiredCredentialNames, session),
  };
}

function authProgramFailures(
  workflow: Workflow,
  requiredCredentialNames: readonly string[] = [],
  session?: Session,
): string[] {
  const failures: string[] = [];
  if (workflow.toolKind !== 'authenticate') {
    failures.push(`workflow.toolKind must be "authenticate"`);
    return failures;
  }
  const config = workflow.authConfig;
  if (!config) return ['workflow.authConfig is missing'];

  const reachableRequestIndexes = new Set(
    Object.values(config.actions).flatMap((action) => action.steps.map((step) => step.request)),
  );
  const executable = JSON.stringify({
    bootstrap: workflow.bootstrap,
    requests: workflow.requests.filter((_, index) => reachableRequestIndexes.has(index)),
  });
  for (const name of requiredCredentialNames) {
    if (!executable.includes(`\${credential.${name}}`)) {
      failures.push(
        `workflow must use planned credential ${JSON.stringify(name)} as \${credential.${name}} in an executable request or bootstrap`,
      );
    }
  }
  if (!config.actions[config.entry]) {
    failures.push(`authConfig.entry references unknown action ${JSON.stringify(config.entry)}`);
  }

  const actionParameter = workflow.parameters.find((parameter) => parameter.name === 'action');
  const actionNames = Object.keys(config.actions);
  if (!actionParameter) {
    failures.push('workflow.parameters must declare the auth action selector');
  } else {
    const choices = new Set(actionParameter.choices ?? []);
    const mismatchedChoices =
      choices.size !== actionNames.length || actionNames.some((name) => !choices.has(name));
    if (
      actionParameter.type !== 'string' ||
      actionParameter.default !== config.entry ||
      mismatchedChoices
    ) {
      failures.push(
        'workflow action parameter must be a string whose default is authConfig.entry and whose choices exactly match authConfig.actions',
      );
    }
  }

  const parameters = new Set(workflow.parameters.map((parameter) => parameter.name));
  const captures = new Set<string>();
  const captureOwners = new Map<
    string,
    {
      request: Workflow['requests'][number];
      capture: NonNullable<Workflow['requests'][number]['captures']>[number];
    }
  >();
  for (const request of workflow.requests) {
    for (const capture of request.captures ?? []) {
      if (captures.has(capture.name)) {
        failures.push(
          `capture name ${JSON.stringify(capture.name)} must be unique across the auth workflow`,
        );
      }
      captures.add(capture.name);
      captureOwners.set(capture.name, { request, capture });
    }
  }
  for (const action of Object.values(config.actions)) {
    for (const step of action.steps) {
      if (step.repeat) {
        if (captures.has(step.repeat.until.name)) {
          failures.push(
            `capture name ${JSON.stringify(step.repeat.until.name)} must be unique across the auth workflow`,
          );
        }
        captures.add(step.repeat.until.name);
        const request = workflow.requests[step.request];
        if (request) {
          captureOwners.set(step.repeat.until.name, { request, capture: step.repeat.until });
        }
      }
    }
  }

  let hasSuccess = false;
  for (const [name, action] of Object.entries(config.actions)) {
    for (const parameter of action.parameters) {
      if (!parameters.has(parameter)) {
        failures.push(
          `action ${JSON.stringify(name)} references unknown parameter ${JSON.stringify(parameter)}`,
        );
      }
    }
    for (const [stepIndex, step] of action.steps.entries()) {
      if (!workflow.requests[step.request]) {
        failures.push(
          `action ${JSON.stringify(name)} step ${stepIndex} references missing request ${step.request}`,
        );
      }
      if (step.onError === 'retry' && !step.repeat) {
        failures.push(
          `action ${JSON.stringify(name)} step ${stepIndex} uses onError="retry" without repeat bounds`,
        );
      }
    }
    for (const evidence of action.outcome.evidence) {
      if (!captures.has(evidence)) {
        failures.push(
          `action ${JSON.stringify(name)} references unknown evidence capture ${JSON.stringify(evidence)}`,
        );
      }
    }
    if (action.outcome.type === 'pause') {
      if (!config.actions[action.outcome.next]) {
        failures.push(
          `action ${JSON.stringify(name)} pauses to unknown action ${JSON.stringify(action.outcome.next)}`,
        );
      }
      for (const carried of action.outcome.carry) {
        if (!captures.has(carried)) {
          failures.push(
            `action ${JSON.stringify(name)} carries unknown capture ${JSON.stringify(carried)}`,
          );
        }
      }
    } else {
      hasSuccess = true;
    }
  }

  if (!hasSuccess) failures.push('authConfig.actions has no success outcome');
  for (const name of config.persist) {
    if (!captures.has(name)) {
      failures.push(`authConfig.persist references unknown capture ${JSON.stringify(name)}`);
      continue;
    }
    const owner = captureOwners.get(name);
    if (!owner) continue;
    const { request, capture } = owner;
    if (request.recordingRequestSeq === undefined) {
      failures.push(
        `persisted capture ${JSON.stringify(name)} must declare recordingRequestSeq on its producing request`,
      );
    } else if (session) {
      const recorded = session.requests.find(
        (candidate) => candidate.seq === request.recordingRequestSeq,
      );
      if (!recorded) {
        failures.push(
          `persisted capture ${JSON.stringify(name)} references missing recorded request seq ${request.recordingRequestSeq}`,
        );
      } else if (!recordedRequestMatchesWorkflow(recorded, request)) {
        failures.push(
          `persisted capture ${JSON.stringify(name)} recordingRequestSeq ${request.recordingRequestSeq} does not match its workflow request`,
        );
      } else {
        if (!recordedResponseProducesCapture(recorded, capture)) {
          failures.push(
            `persisted capture ${JSON.stringify(name)} is not produced by recorded request seq ${request.recordingRequestSeq}`,
          );
        }
      }
    }
  }
  if (!reachableSuccess(config.entry, config.actions)) {
    failures.push('authConfig.entry cannot reach a success outcome');
  }
  return failures;
}

function recordedResponseProducesCapture(
  request: Session['requests'][number],
  capture: NonNullable<Workflow['requests'][number]['captures']>[number],
): boolean {
  const response = request.response;
  if (!response || capture.source === 'cookie') return false;
  const body = response.body ?? '';
  let value: unknown;
  if (capture.source === 'json') {
    try {
      value = jsonpath(JSON.parse(body), capture.path);
    } catch {
      return false;
    }
  } else if (capture.source === 'response_header') {
    value =
      capture.header.toLowerCase() === 'x-imprint-final-url'
        ? request.url
        : captureHeader(new Headers(response.headers), capture.header, capture.mode);
  } else {
    try {
      value = new RegExp(capture.pattern).exec(body)?.[capture.group ?? 1];
    } catch {
      return false;
    }
  }
  return captureValueMatches(value, capture.equals);
}

function reachableSuccess(
  entry: string,
  actions: NonNullable<Workflow['authConfig']>['actions'],
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = entry;
  while (current && !seen.has(current)) {
    seen.add(current);
    const action: (typeof actions)[string] | undefined = actions[current];
    if (!action) return false;
    if (action.outcome.type === 'success') return true;
    current = action.outcome.next;
  }
  return false;
}

export function authWorkflowHash(workflow: Workflow): string {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
}

function liveAttemptFailures(toolDir: string, workflow: Workflow): string[] {
  const path = pathJoin(toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL);
  if (!existsSync(path)) {
    return ['no live auth verification attempt was recorded; call run_verification before done'];
  }

  let attempt: { action?: unknown; ok?: unknown; workflowHash?: unknown };
  try {
    attempt = JSON.parse(readFileSync(path, 'utf8')) as typeof attempt;
  } catch (err) {
    return [
      `live auth verification record is invalid: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
  if (attempt.ok !== true || typeof attempt.action !== 'string') {
    return ['the most recent live auth verification did not succeed'];
  }
  if (attempt.workflowHash !== authWorkflowHash(workflow)) {
    return ['workflow.json changed after the most recent successful live auth verification'];
  }
  const action = workflow.authConfig?.actions[attempt.action];
  return action?.outcome.type === 'success'
    ? []
    : [
        `the most recent successful live action ${JSON.stringify(attempt.action)} does not declare a success outcome`,
      ];
}
