/**
 * Recording tools and contract-level verification shared by every auth compile
 * provider. Site behavior is decided by the compile agent and encoded in the
 * auth action program, not inferred here.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import type { AgentTool } from './agent.ts';
import { AuthBrowserActionSchema } from './auth-browser-discovery.ts';
import type { AuthCheckpoint, AuthCheckpointResult } from './compile-agent-types.ts';
import {
  type CompileToolContext,
  bodyEncodingContractFailures,
  buildReadFileTool,
  buildReadRequestTool,
  buildReadResponseBodyTool,
  buildReadSessionSummaryTool,
  buildRunTestsTool,
  buildSearchRequestsTool,
  buildWriteFileTool,
  irreversibleProvenanceFailures,
  requestEncodingTestContractFailures,
} from './compile-tools.ts';
import { isIrreversibleRequest, workflowHasIrreversibleEffect } from './effects.ts';
import { recordedRequestMatchesWorkflow } from './recording-request.ts';
import { captureHeader, captureValueMatches, resolveJsonCapture } from './request-capture.ts';
import {
  type Session,
  type Workflow,
  WorkflowSchema,
  authActionOutcomes,
  persistedCaptureName,
} from './types.ts';

type TeachCredentials = { site: string; values: Record<string, string> };

export const AUTH_VERIFICATION_ATTEMPT_SENTINEL = '.auth-verification-attempt.json';

export interface AuthCliCompileMode {
  site: string;
  contextRef?: string;
  authPlanJson: string;
  allowedTools: readonly string[];
  initialPrompt: string;
  /** Host-only native/API execution; CLI-only drivers retain the sentinel fallback. */
  executeCheckpoint?: (
    checkpoint: AuthCheckpoint,
    signal?: AbortSignal,
  ) => Promise<AuthCheckpointResult>;
}

export const AUTH_COMPILE_TOOL_NAMES = [
  'read_session_summary',
  'search_requests',
  'read_request',
  'read_response_body',
  'write_file',
  'read_file',
  'run_tests',
  'run_verification',
  'inspect_verification_page',
  'interact_verification_browser',
  'prompt_user',
  'wait_for_cooldown',
] as const;

export const AUTH_CHECKPOINT_TOOLS: Omit<AgentTool, 'handler'>[] = [
  {
    name: 'interact_verification_browser',
    description:
      'Explore the live auth UI in the retained verification browser and capture its network requests/responses as additional readable recording evidence. Can open a browser before a workflow exists. Choose inspect, navigate, click, fill, select, press, or wait from observed page controls. For fill values use stored ${credential.NAME} or current ${prompt.ID} references; answers are resolved locally. Capture continues between calls and while prompting the human. This does not verify the compiled workflow.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inspect', 'navigate', 'click', 'fill', 'select', 'press', 'wait'],
        },
        url: { type: 'string', description: 'HTTP(S) destination for navigate.' },
        selector: {
          type: 'string',
          description: 'Exact CSS selector from the observed UI for click/fill/select.',
        },
        value: {
          type: 'string',
          description:
            'Value for fill/select; secret inputs use credential or current prompt references.',
        },
        key: { type: 'string', description: 'Keyboard key for press, e.g. Enter or Tab.' },
        milliseconds: { type: 'number', description: 'Observation wait duration, 0–30000 ms.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_verification',
    description:
      'Run one action from the current workflow.json live in the verification browser. First reuse the proven noninteractive session-check or context-restoration action before restarting login. Branch on current response evidence before delivering MFA. Supply the action name and only its declared parameters. Set freshSession only when observed evidence means the prior browser and continuation state must be discarded. Set cleanSession only when evidence requires also withholding stored cookies and browser storage.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'An action declared in authConfig.actions.',
        },
        parameters: {
          type: 'object',
          description: 'Scalar values required by this action, keyed by workflow parameter name.',
        },
        freshSession: {
          type: 'boolean',
          description:
            'Close and discard the prior verification browser and continuation state before running this action. Defaults to false.',
        },
        cleanSession: {
          type: 'boolean',
          description:
            'Also withhold stored cookies and browser storage for this fresh run. Credential values remain available.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'inspect_verification_page',
    description:
      'Inspect the currently rendered page in the existing verification browser without navigating, resetting state, or running another auth action. Returns rendered body text, final URL, title, and optional cookies. Known user-supplied secrets are masked; other cookie values remain private evidence. Use when observed verification evidence warrants inspecting the page.',
    input_schema: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'number',
          description: 'Maximum rendered body-text characters to return (256–20000).',
        },
        includeCookies: {
          type: 'boolean',
          description:
            'Include cookies with names, values, domains, paths, expirations, and flags. Known user-supplied secrets are masked. Defaults to true.',
        },
      },
    },
  },
  {
    name: 'prompt_user',
    description:
      'Ask the human for input or an external action required by the compiled auth program. A selected fixed option is returned as an answered choice with its exact value; free-text answers remain current opaque response references. A choice is not proof that a live action succeeded.',
    input_schema: {
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
      'Request a delay without running any live action. Use only when the observed site response justifies waiting.',
    input_schema: {
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
];

/** Parse the same host request for inline and checkpoint/resume adapters. */
export function parseAuthCheckpoint(name: string, input: unknown): AuthCheckpoint {
  switch (name) {
    case 'interact_verification_browser':
      return { kind: name, ...AuthBrowserActionSchema.parse(input) };
    case 'run_verification':
      return {
        kind: name,
        ...z
          .object({
            action: z.string().min(1),
            parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
            freshSession: z.boolean().optional(),
            cleanSession: z.boolean().optional(),
          })
          .parse(input),
      };
    case 'inspect_verification_page':
      return {
        kind: name,
        ...z
          .object({ maxChars: z.number().optional(), includeCookies: z.boolean().optional() })
          .parse(input),
      };
    case 'prompt_user':
      return {
        kind: name,
        ...z
          .object({ message: z.string().min(1), options: z.array(z.string()).optional() })
          .parse(input),
      };
    case 'wait_for_cooldown':
      return {
        kind: name,
        ...z
          .object({ minutes: z.number().nonnegative(), reason: z.string().optional() })
          .parse(input),
      };
    default:
      throw new Error(`Unknown auth checkpoint: ${name}`);
  }
}

export function buildAuthCompileTools(
  session: Session,
  toolDir: string,
  sessionPath: string,
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
    buildRunTestsTool(toolDir, sessionPath, {
      networkDisabled: session.requests.some(isIrreversibleRequest),
    }),
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

export async function authLivePreflightFailures(
  toolDir: string,
  session?: Session,
  requiredCredentialNames: readonly string[] = [],
  authRequestSeqs: readonly number[] = [],
  sessionPath = '',
): Promise<string[]> {
  const failures = authWorkflowPreflightFailures(toolDir, session, requiredCredentialNames);
  if (failures.length > 0) return failures;
  const parsed = parseWorkflow(
    pathJoin(toolDir, 'workflow.json'),
    requiredCredentialNames,
    session,
  );
  if (!parsed.workflow) return parsed.failures;
  const requestTestPath = pathJoin(toolDir, 'request.test.ts');
  const requestTestExists = existsSync(requestTestPath);
  failures.push(
    ...bodyEncodingContractFailures(parsed.workflow),
    ...requestEncodingTestContractFailures(
      parsed.workflow,
      requestTestExists ? readFileSync(requestTestPath, 'utf8') : undefined,
    ),
  );
  if ((parsed.workflow.authConfig?.persist.length ?? 0) > 0 && !requestTestExists) {
    failures.push(
      'request.test.ts is required to exercise auth workflows that persist captured credentials',
    );
  }
  if (session) {
    failures.push(
      ...irreversibleProvenanceFailures(session, parsed.workflow, {
        candidateRequestSeqs: [...authRequestSeqs],
      }),
    );
  }
  if (workflowHasIrreversibleEffect(parsed.workflow)) {
    failures.push('auth live verification is disabled for workflows with irreversible requests');
  }
  if (failures.length === 0 && requestTestExists) {
    const testResult = await buildRunTestsTool(toolDir, sessionPath, {
      networkDisabled: workflowHasIrreversibleEffect(parsed.workflow),
    }).handler({});
    if (testResult.isError) {
      failures.push(`agent-authored request tests failed: ${testResult.result}`);
    }
  }
  return failures;
}

export function authExternalVerification(
  toolDir: string,
  requiredDurableCredentials: Array<{ name: string; usedAs?: string }> = [],
  options: { requireLiveAttempt?: boolean; requiredCredentialNames?: readonly string[] } = {},
): string[] {
  const workflowPath = pathJoin(toolDir, 'workflow.json');
  if (!existsSync(workflowPath)) return ['workflow.json does not exist'];

  const parsed = parseWorkflow(workflowPath, options.requiredCredentialNames);
  if (!parsed.workflow) return parsed.failures;
  const failures = [...parsed.failures];
  const workflow = parsed.workflow;
  const requestTestPath = pathJoin(toolDir, 'request.test.ts');
  const requestTestExists = existsSync(requestTestPath);
  failures.push(...bodyEncodingContractFailures(workflow));
  failures.push(
    ...requestEncodingTestContractFailures(
      workflow,
      requestTestExists ? readFileSync(requestTestPath, 'utf8') : undefined,
    ),
  );
  if ((workflow.authConfig?.persist.length ?? 0) > 0 && !requestTestExists) {
    failures.push(
      'request.test.ts is required to exercise auth workflows that persist captured credentials',
    );
  }
  const persisted = new Set(workflow.authConfig?.persist ?? []);

  const missingContracts = requiredDurableCredentials.filter((capture) => {
    const target = (capture.usedAs ?? '').toLowerCase();
    return (
      target.length > 0 &&
      target !== 'header:cookie' &&
      target !== 'header:set-cookie' &&
      !persisted.has(capture.name)
    );
  });
  if (missingContracts.length > 0) {
    failures.push(
      `authConfig.persist must include downstream credential interface(s): ${missingContracts
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
    for (const branch of action.branches ?? []) {
      const capture = branch.when;
      if (captures.has(capture.name)) {
        failures.push(
          `capture name ${JSON.stringify(capture.name)} must be unique across the auth workflow`,
        );
      }
      captures.add(capture.name);
      const lastStep = action.steps.at(-1);
      const request = lastStep && workflow.requests[lastStep.request];
      if (request) captureOwners.set(capture.name, { request, capture });
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
    for (const outcome of authActionOutcomes(action)) {
      for (const evidence of outcome.evidence) {
        if (!captures.has(evidence)) {
          failures.push(
            `action ${JSON.stringify(name)} references unknown evidence capture ${JSON.stringify(evidence)}`,
          );
        }
      }
      if (outcome.type === 'pause') {
        if (!config.actions[outcome.next]) {
          failures.push(
            `action ${JSON.stringify(name)} pauses to unknown action ${JSON.stringify(outcome.next)}`,
          );
        }
        for (const carried of outcome.carry) {
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
  }

  if (!hasSuccess) failures.push('authConfig.actions has no success outcome');
  const persistedCredentials = new Set(config.persist);
  for (const credentialName of Object.keys(config.persistBindings ?? {})) {
    if (!persistedCredentials.has(credentialName)) {
      failures.push(
        `authConfig.persistBindings declares unused credential ${JSON.stringify(credentialName)}`,
      );
    }
  }
  for (const name of config.persist) {
    const captureName = persistedCaptureName(config, name);
    if (!captures.has(captureName)) {
      failures.push(
        `authConfig.persist credential ${JSON.stringify(name)} references unknown capture ${JSON.stringify(captureName)}`,
      );
      continue;
    }
    const owner = captureOwners.get(captureName);
    if (!owner) continue;
    const { request, capture } = owner;
    if (request.recordingRequestSeq === undefined) {
      failures.push(
        `persisted capture ${JSON.stringify(captureName)} must declare recordingRequestSeq on its producing request`,
      );
    } else if (session) {
      const recorded = session.requests.find(
        (candidate) => candidate.seq === request.recordingRequestSeq,
      );
      if (!recorded) {
        failures.push(
          `persisted capture ${JSON.stringify(captureName)} references missing recorded request seq ${request.recordingRequestSeq}`,
        );
      } else if (!recordedRequestMatchesWorkflow(recorded, request)) {
        failures.push(
          `persisted capture ${JSON.stringify(captureName)} recordingRequestSeq ${request.recordingRequestSeq} does not match its workflow request`,
        );
      } else {
        if (!recordedResponseProducesCapture(recorded, capture)) {
          failures.push(
            `persisted capture ${JSON.stringify(captureName)} is not produced by recorded request seq ${request.recordingRequestSeq}`,
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
      value = resolveJsonCapture(JSON.parse(body), capture.path, capture.decodeJsonPath);
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
  const pending = [entry];
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const action = actions[current];
    if (!action) continue;
    for (const outcome of authActionOutcomes(action)) {
      if (outcome.type === 'success') return true;
      pending.push(outcome.next);
    }
  }
  return false;
}

export function authWorkflowHash(workflow: Workflow): string {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
}

export interface AuthVerificationReceiptStatus {
  status: 'verified' | 'stale' | 'failed' | 'missing';
  reason: string;
  action?: string;
  backend?: string;
  timestamp?: number;
}

/** Read the latest auth verification receipt without initiating authentication.
 * The workflow hash is authoritative: a successful receipt for older generated
 * code is diagnostic history, not current verification evidence. */
export function readAuthVerificationReceiptStatus(
  toolDir: string,
  workflow: Workflow,
): AuthVerificationReceiptStatus {
  const path = pathJoin(toolDir, AUTH_VERIFICATION_ATTEMPT_SENTINEL);
  if (!existsSync(path)) {
    return {
      status: 'missing',
      reason: 'no live auth verification attempt was recorded',
    };
  }

  let attempt: {
    action?: unknown;
    ok?: unknown;
    workflowHash?: unknown;
    backend?: unknown;
    timestamp?: unknown;
  };
  try {
    attempt = JSON.parse(readFileSync(path, 'utf8')) as typeof attempt;
  } catch (err) {
    return {
      status: 'failed',
      reason: `live auth verification record is invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const details = {
    ...(typeof attempt.action === 'string' ? { action: attempt.action } : {}),
    ...(typeof attempt.backend === 'string' ? { backend: attempt.backend } : {}),
    ...(typeof attempt.timestamp === 'number' ? { timestamp: attempt.timestamp } : {}),
  };
  if (attempt.ok !== true || typeof attempt.action !== 'string') {
    return {
      status: 'failed',
      reason: 'the most recent live auth verification did not succeed',
      ...details,
    };
  }
  if (attempt.workflowHash !== authWorkflowHash(workflow)) {
    return {
      status: 'stale',
      reason: 'workflow.json changed after the most recent successful live auth verification',
      ...details,
    };
  }
  const action = workflow.authConfig?.actions[attempt.action];
  if (!action || !authActionOutcomes(action).some((outcome) => outcome.type === 'success')) {
    return {
      status: 'failed',
      reason: `the most recent successful live action ${JSON.stringify(attempt.action)} does not declare a success outcome`,
      ...details,
    };
  }
  return {
    status: 'verified',
    reason: `live auth verification succeeded with action ${JSON.stringify(attempt.action)}`,
    ...details,
  };
}

function liveAttemptFailures(toolDir: string, workflow: Workflow): string[] {
  const receipt = readAuthVerificationReceiptStatus(toolDir, workflow);
  if (receipt.status === 'verified') return [];
  const suffix = receipt.status === 'missing' ? '; call run_verification before done' : '';
  return [`${receipt.reason}${suffix}`];
}
