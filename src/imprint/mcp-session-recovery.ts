import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withSiteAuthRecoveryLock } from './credential-store.ts';
import { type ToolResult, type Workflow, WorkflowSchema, authActionOutcomes } from './types.ts';

const PolicySchema = z
  .object({
    authTool: z.string().min(1),
    protectedTools: z.array(z.string().min(1)).min(1),
    statusAction: z.string(),
    refreshAction: z.string(),
    startAction: z.string(),
    approvalAction: z.string(),
    terminalAction: z.string(),
    nextActions: z.record(z.string(), z.array(z.string())),
    approvalMessage: z.string().min(1),
    approvalTimeoutMs: z.number().int().positive(),
    recoveryTimeoutMs: z.number().int().positive(),
    failureCooldownMs: z.number().int().positive(),
    refreshBeforeExpiryMs: z.number().int().positive().default(90_000),
    verifyAgainAfterMs: z.number().int().positive().default(45_000),
    signedOutResponse: z
      .object({ status: z.number().int().min(200).max(599), errorCode: z.string().min(1) })
      .strict()
      .optional(),
    browserVerificationResponse: z
      .object({ status: z.number().int().min(200).max(599), errorCode: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type RecoveryPolicy = z.infer<typeof PolicySchema>;

export function loadRecoveryPolicy(
  assetRoot: string,
  site: string,
  workflows: readonly Workflow[],
): RecoveryPolicy | undefined {
  const path = join(assetRoot, site, 'mcp-session-recovery.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const policy = PolicySchema.parse(JSON.parse(raw));
  const auth = workflows.find((workflow) => workflow.toolName === policy.authTool);
  const config =
    auth?.toolKind === 'authenticate' ? WorkflowSchema.parse(auth).authConfig : undefined;
  const invalid = (message: string) =>
    new Error(
      `Invalid session recovery policy for ${site}: ${message} → next step: check mcp-session-recovery.json and the authentication workflow.`,
    );
  if (auth?.site !== site || config?.persistCookiesOnPause !== false) {
    throw invalid('the auth tool must set persistCookiesOnPause to false');
  }
  const actions = config.actions;
  const actionSelector = auth?.parameters.find((parameter) => parameter.name === 'action');
  if (actionSelector?.type !== 'string' || actionSelector.default !== config.entry) {
    throw invalid('the auth tool must expose its action selector');
  }
  const names = new Set([
    policy.statusAction,
    policy.refreshAction,
    policy.startAction,
    policy.approvalAction,
    policy.terminalAction,
    ...Object.keys(policy.nextActions),
    ...Object.values(policy.nextActions).flat(),
  ]);
  for (const name of names) {
    const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!action || action.parameters.length !== 0 || !actionSelector.choices?.includes(name)) {
      throw invalid(`action ${JSON.stringify(name)} is missing or requires arguments`);
    }
  }
  const verificationActions = new Set([
    policy.statusAction,
    policy.refreshAction,
    policy.terminalAction,
  ]);
  if (verificationActions.has(policy.startAction)) {
    throw invalid('the sign-in start must be separate from verification actions');
  }
  for (const name of verificationActions) {
    const action = actions[name];
    if (
      !action ||
      authActionOutcomes(action).some(
        (outcome) => outcome.type !== 'success' || !outcome.evidence.length,
      )
    ) {
      throw invalid(
        `action ${JSON.stringify(name)} must complete with session evidence and no continuation`,
      );
    }
  }
  if (
    [policy.statusAction, policy.refreshAction, policy.startAction, policy.terminalAction].includes(
      policy.approvalAction,
    )
  ) {
    throw invalid(
      'the approval action must be separate from status, refresh, start and completion',
    );
  }
  for (const [name, next] of Object.entries(policy.nextActions)) {
    const action = actions[name];
    if (!action) throw invalid(`missing action ${JSON.stringify(name)}`);
    const declared = authActionOutcomes(action).flatMap((outcome) =>
      outcome.type === 'pause' ? [outcome.next] : [],
    );
    if (next.some((target) => !declared.includes(target))) {
      throw invalid(`action ${JSON.stringify(name)} has an undeclared transition`);
    }
  }
  for (const name of names) {
    if (verificationActions.has(name)) continue;
    const action = actions[name];
    if (
      !action ||
      authActionOutcomes(action).some(
        (outcome) => outcome.type !== 'pause' || !policy.nextActions[name]?.includes(outcome.next),
      )
    ) {
      throw invalid(`action ${JSON.stringify(name)} must pause with a declared continuation`);
    }
  }
  const approvalRequests = new Set(
    actions[policy.approvalAction]?.steps.map(({ request }) => request),
  );
  if (
    [...approvalRequests].filter((index) => auth?.requests[index]?.effect === 'unsafe').length !== 1
  ) {
    throw invalid('the approval action must declare exactly one unsafe request');
  }
  const beforeApproval = new Set([policy.statusAction, policy.refreshAction]);
  const pending = [policy.startAction];
  while (pending.length) {
    const name = pending.pop();
    if (!name || name === policy.approvalAction || beforeApproval.has(name)) continue;
    beforeApproval.add(name);
    pending.push(...(policy.nextActions[name] ?? []));
  }
  for (const name of names) {
    const dispatched = new Set<number>();
    for (const step of actions[name]?.steps ?? []) {
      const effect = auth?.requests[step.request]?.effect;
      if (!effect || effect === 'irreversible') {
        throw invalid(`action ${JSON.stringify(name)} has an unclassified or irreversible request`);
      }
      if (
        effect === 'unsafe' &&
        (dispatched.has(step.request) ||
          (step.repeat?.maxAttempts ?? 1) > 1 ||
          step.onError === 'retry' ||
          (name !== policy.approvalAction && approvalRequests.has(step.request)))
      ) {
        throw invalid(
          `action ${JSON.stringify(name)} can repeat an approval or other unsafe effect`,
        );
      }
      dispatched.add(step.request);
      if (beforeApproval.has(name) && (effect === 'unsafe' || approvalRequests.has(step.request))) {
        throw invalid(
          `action ${JSON.stringify(name)} can dispatch an approval effect before consent`,
        );
      }
    }
  }
  for (const name of policy.protectedTools) {
    const workflow = workflows.find((candidate) => candidate.toolName === name);
    if (
      !workflow ||
      workflow.site !== site ||
      workflow.toolKind === 'authenticate' ||
      workflow.requests.some((request) => request.effect !== 'safe')
    ) {
      throw invalid(`protected tool ${JSON.stringify(name)} must be a read-only data tool`);
    }
  }
  return policy;
}

export type RecoveryTrigger = 'expired' | 'forbidden' | 'inspect' | 'proactive';

export type RecoveryResult =
  | { status: 'renewed' | 'valid'; expiresAt?: number }
  | { status: 'unverified' }
  | { status: 'blocked'; message: string };

export class SessionFreshness {
  private checkedUntil = 0;
  private expiresAt?: number;
  private attemptedRefreshFor?: number;

  constructor(private readonly policy: RecoveryPolicy) {}

  next(now = Date.now()): RecoveryTrigger | 'ready' {
    if (this.expiresAt !== undefined) {
      if (now >= this.expiresAt) return 'expired';
      if (
        now >= this.expiresAt - this.policy.refreshBeforeExpiryMs &&
        this.attemptedRefreshFor !== this.expiresAt
      ) {
        this.attemptedRefreshFor = this.expiresAt;
        return 'proactive';
      }
    }
    return now < this.checkedUntil ? 'ready' : 'inspect';
  }

  observe(result: { expiresAt?: number }, now = Date.now()): void {
    if (result.expiresAt !== undefined && result.expiresAt > now) {
      this.expiresAt = result.expiresAt;
      this.checkedUntil = result.expiresAt;
    } else {
      if (this.expiresAt !== undefined && this.expiresAt <= now) this.expiresAt = undefined;
      this.checkedUntil = now + this.policy.verifyAgainAfterMs;
    }
  }

  invalidate(): void {
    this.checkedUntil = 0;
    this.expiresAt = undefined;
    this.attemptedRefreshFor = undefined;
  }
}

interface RecoveryHost {
  execute(action: string, state?: Record<string, unknown>): Promise<ToolResult>;
  requestApproval?: () => Promise<boolean>;
  beginInteractiveSignIn: () => boolean;
  recordApprovalAttempt: () => void;
  signal: AbortSignal;
}

function blocked(message: string): RecoveryResult {
  return { status: 'blocked', message };
}

export function verifiedSession(result: ToolResult): { expiresAt?: number } | undefined {
  if (
    !result.ok ||
    typeof result.data !== 'object' ||
    result.data === null ||
    !('authenticated' in result.data) ||
    result.data.authenticated !== true
  )
    return undefined;
  const expiresAt = 'expiresAt' in result.data ? result.data.expiresAt : undefined;
  return typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()
    ? { expiresAt }
    : {};
}

function matchesProviderResponse(
  result: ToolResult,
  expected: RecoveryPolicy['signedOutResponse'],
): boolean {
  return (
    !result.ok &&
    !!expected &&
    result.providerError?.status === expected.status &&
    result.providerError.errorCode === expected.errorCode
  );
}

export function isSignedOut(result: ToolResult, policy: RecoveryPolicy): boolean {
  return matchesProviderResponse(result, policy.signedOutResponse);
}

export async function recoverSession(
  policy: RecoveryPolicy,
  host: RecoveryHost,
  trigger: RecoveryTrigger,
): Promise<RecoveryResult> {
  host.signal.throwIfAborted();
  let signedOut = false;
  if (trigger === 'forbidden' || trigger === 'inspect') {
    const status = await host.execute(policy.statusAction);
    const valid = verifiedSession(status);
    if (valid) return { status: 'valid', ...valid };
    signedOut = isSignedOut(status, policy);
    if (!signedOut && (status.ok || status.error !== 'AUTH_EXPIRED')) {
      return { status: 'unverified' };
    }
  }

  if (!signedOut) {
    const refreshed = await host.execute(policy.refreshAction);
    const renewed = verifiedSession(refreshed);
    if (renewed) return { status: 'renewed', ...renewed };
    if (trigger === 'proactive') return { status: 'unverified' };
    if (!isSignedOut(refreshed, policy) && (refreshed.ok || refreshed.error !== 'AUTH_EXPIRED')) {
      return blocked(
        'The saved session could not be refreshed. Try again when the service is available.',
      );
    }
  }
  if (!host.requestApproval) {
    return blocked('Sign-in requires approval. Use an MCP client that supports approval prompts.');
  }

  if (!host.beginInteractiveSignIn()) {
    return blocked('A recent sign-in did not complete. Automatic sign-in is paused briefly.');
  }
  let action = policy.startAction;
  let state: Record<string, unknown> | undefined;
  const visited = new Set<string>();
  while (!visited.has(action)) {
    visited.add(action);
    host.signal.throwIfAborted();
    if (action === policy.approvalAction && !(await host.requestApproval())) {
      return blocked(
        'Sign-in approval was declined or timed out. The approval action did not run.',
      );
    }
    host.signal.throwIfAborted();
    if (action === policy.approvalAction) host.recordApprovalAttempt();
    const result = await host.execute(action, state);
    if (
      action === policy.startAction &&
      matchesProviderResponse(result, policy.browserVerificationResponse)
    ) {
      return blocked('The provider requires browser verification before sign-in can continue.');
    }
    if (action === policy.terminalAction) {
      const valid = verifiedSession(result);
      if (valid) return { status: 'renewed', ...valid };
    }
    if (
      result.ok ||
      result.error !== 'ACTION_REQUIRED' ||
      !result.nextAction ||
      !result.continuation ||
      !policy.nextActions[action]?.includes(result.nextAction)
    ) {
      const code = result.ok ? 'unexpected_success' : result.error;
      const status = !result.ok && result.status ? ` HTTP ${result.status}` : '';
      return blocked(`Sign-in stopped at ${action} (${code}${status}). The call is paused.`);
    }
    action = result.nextAction;
    state = result.continuation;
  }
  return blocked('The sign-in sequence attempted to repeat an action and was stopped.');
}

export async function withRecoveryLock(
  site: string,
  policy: RecoveryPolicy,
  signal: AbortSignal,
  task: (gate: {
    beginInteractiveSignIn: () => boolean;
    recordApprovalAttempt: () => void;
  }) => Promise<RecoveryResult>,
): Promise<RecoveryResult> {
  return withSiteAuthRecoveryLock(site, signal, async (directory) => {
    const cooldown = join(directory, 'cooldown');
    let until = 0;
    try {
      until = Number(readFileSync(cooldown, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let interactive = false;
    const writeCooldown = (duration: number) => {
      const pending = join(directory, 'cooldown.tmp');
      writeFileSync(pending, String(Date.now() + duration), { mode: 0o600 });
      renameSync(pending, cooldown);
    };
    const result = await task({
      beginInteractiveSignIn: () => {
        interactive = Date.now() >= until;
        return interactive;
      },
      recordApprovalAttempt: () => {
        writeCooldown(policy.recoveryTimeoutMs + policy.failureCooldownMs);
      },
    });
    if (result.status === 'blocked' && interactive) writeCooldown(policy.failureCooldownMs);
    if (result.status === 'valid' || result.status === 'renewed') rmSync(cooldown, { force: true });
    return result;
  });
}
