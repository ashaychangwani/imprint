import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolResult, Workflow } from './types.ts';

const RecoveryPolicySchema = z
  .object({
    authTool: z.string().min(1),
    protectedTools: z.array(z.string().min(1)).min(1),
    startAction: z.string().min(1).optional(),
    refreshAction: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1).max(2_147_483_647).default(240_000),
  })
  .strict();

export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;

export function loadRecoveryPolicy(assetRoot: string, site: string): RecoveryPolicy | undefined {
  const path = join(assetRoot, site, 'mcp-session-recovery.json');
  try {
    return RecoveryPolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

type AuthFailure = Extract<ToolResult, { ok: false }>;
type RecoveryResult =
  | { status: 'authenticated' }
  | { status: 'blocked'; message: string }
  | { status: 'manual'; action: string; state?: Record<string, unknown>; message: string };

interface RecoveryHost {
  signal: AbortSignal;
  execute(action: string, state?: Record<string, unknown>): Promise<ToolResult>;
  requestConsent?(action: string): Promise<boolean>;
}

function manual(action: string, pause?: AuthFailure): RecoveryResult {
  return {
    status: 'manual',
    action,
    state: pause?.continuation,
    message: pause?.message ?? 'Sign-in needs to continue through the authentication tool.',
  };
}

function isAuthenticated(result: ToolResult): boolean {
  return (
    result.ok &&
    typeof result.data === 'object' &&
    result.data !== null &&
    'authenticated' in result.data &&
    result.data.authenticated === true
  );
}

export function missingAuthInputs(
  workflow: Workflow,
  action: string,
  args: Record<string, unknown> = {},
): string[] {
  return (workflow.authConfig?.actions[action]?.parameters ?? []).filter(
    (name) =>
      args[name] === undefined &&
      !workflow.parameters.some(
        (parameter) => parameter.name === name && parameter.default !== undefined,
      ),
  );
}

/** Requests that need consent. Undefined means this action stays standalone. */
export function unsafeAuthRequests(workflow: Workflow, action: string): Set<number> | undefined {
  const actions = workflow.authConfig?.actions;
  const steps = actions && Object.hasOwn(actions, action) ? actions[action]?.steps : undefined;
  if (!steps) return undefined;

  const unsafe = new Set<number>();
  for (const step of steps) {
    const request = workflow.requests[step.request];
    if (request?.effect === 'safe' || request?.effect === 'idempotent') continue;
    if (
      request?.effect !== 'unsafe' ||
      request.mode === 'navigate' ||
      unsafe.has(step.request) ||
      (step.repeat?.maxAttempts ?? 1) > 1
    )
      return undefined;
    unsafe.add(step.request);
  }
  return unsafe;
}

export async function recoverSession(
  workflow: Workflow,
  policy: RecoveryPolicy,
  host: RecoveryHost,
): Promise<RecoveryResult> {
  const config = workflow.authConfig;
  if (!config?.actions) return { status: 'blocked', message: 'No compiled sign-in is available.' };

  let action = policy.startAction ?? config.entry;
  let pause: AuthFailure | undefined;
  const refresh = policy.refreshAction === action ? undefined : policy.refreshAction;
  const refreshAction =
    refresh && Object.hasOwn(config.actions, refresh) ? config.actions[refresh] : undefined;
  if (
    refresh &&
    refreshAction &&
    !missingAuthInputs(workflow, refresh).length &&
    refreshAction.steps.every(({ request }) => {
      const effect = workflow.requests[request]?.effect;
      return effect === 'safe' || effect === 'idempotent';
    })
  ) {
    host.signal.throwIfAborted();
    const result = await host.execute(refresh);
    if (isAuthenticated(result)) return { status: 'authenticated' };
    if (!result.ok && result.error === 'ACTION_REQUIRED' && result.nextAction) {
      if (result.resume !== 'automatic') return manual(result.nextAction, result);
      action = result.nextAction;
      pause = result;
    } else if (result.ok || result.error !== 'AUTH_EXPIRED') {
      return { status: 'blocked', message: 'The saved session could not be refreshed.' };
    }
  }

  const visited = new Set<string>();
  const dispatchedUnsafe = new Set<number>();
  while (!visited.has(action)) {
    visited.add(action);
    host.signal.throwIfAborted();
    const unsafe = unsafeAuthRequests(workflow, action);
    if (!unsafe || [...unsafe].some((request) => dispatchedUnsafe.has(request))) {
      return { status: 'blocked', message: 'This action needs standalone manual sign-in.' };
    }
    if (missingAuthInputs(workflow, action).length) return manual(action, pause);

    if (unsafe.size) {
      if (!host.requestConsent) {
        return {
          status: 'blocked',
          message: 'This client cannot request consent for a new approval. Use manual sign-in.',
        };
      }
      if (!(await host.requestConsent(action))) {
        return { status: 'blocked', message: 'Consent was declined or timed out.' };
      }
      for (const request of unsafe) dispatchedUnsafe.add(request);
    }

    host.signal.throwIfAborted();
    const result = await host.execute(action, pause?.continuation);
    if (isAuthenticated(result)) return { status: 'authenticated' };
    if (result.ok || result.error !== 'ACTION_REQUIRED' || !result.nextAction) {
      return {
        status: 'blocked',
        message: 'The compiled sign-in did not verify the session. Use the standalone auth tool.',
      };
    }
    if (result.resume !== 'automatic') return manual(result.nextAction, result);
    action = result.nextAction;
    pause = result;
  }
  return { status: 'blocked', message: 'The compiled sign-in repeated an action.' };
}
