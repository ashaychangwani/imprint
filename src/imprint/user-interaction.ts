/** Run-local human interaction shared by retained roles and compiler subprocesses. */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { AgentTool } from './agent-tool.ts';
import { AuthToolPlanSchema } from './auth-plan.ts';
import { abortSignalError, withAbortSignal } from './concurrency.ts';
import { createLog } from './log.ts';
import { type RunDeadlineRef, combinedDeadlineSignal } from './provider-retry.ts';

const UserPromptSchema = z
  .object({
    message: z.string().trim().min(1).max(8_000),
    options: z.array(z.string().min(1).max(500)).min(2).max(20).optional(),
    sensitive: z.boolean().default(false),
  })
  .strict();
export type UserPrompt = z.infer<typeof UserPromptSchema>;
export type UserPromptAnswer =
  | { status: 'answered'; value: string }
  | { status: 'cancelled' | 'unavailable'; reason: string };
export type OnUserPrompt = (prompt: UserPrompt, signal?: AbortSignal) => Promise<UserPromptAnswer>;
export const AgentInteractionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prompt_user'), prompt: UserPromptSchema }).strict(),
  z
    .object({
      action: z.literal('authenticate'),
      plan: AuthToolPlanSchema.unwrap()
        .extend({
          toolName: z.string().regex(/^[a-z][a-z0-9_]*$/),
        })
        .strict(),
    })
    .strict(),
]);
type AgentInteraction = z.infer<typeof AgentInteractionSchema>;
type AuthenticationResult = {
  status: 'authenticated' | 'failed' | 'unavailable';
  message: string;
  workflowPath?: string;
  contextRef?: string;
  operationId?: string;
};
type Authenticate = (
  plan: Extract<AgentInteraction, { action: 'authenticate' }>['plan'],
  signal?: AbortSignal,
) => Promise<AuthenticationResult>;

const context = new AsyncLocalStorage<UserInteraction>();
export const currentUserInteraction = () => context.getStore();
const USER_INTERACTION_ENV = 'IMPRINT_USER_INTERACTION_URL';

export const USER_INTERACTION_INSTRUCTIONS = `
HUMAN INTERACTION: You may ask the user for authentication, MFA approval, an OTP,
missing information, or another necessary decision. Return only
{"interaction":{"action":"prompt_user","prompt":{"message":"...","options":["Approved","Cancel"],"sensitive":false}}}
instead of your role decision, then continue after interactionResult. Omit options
for free text. Set sensitive:true for passwords, OTPs or other secrets. Secret
answers are host-held references; pass the returned reference unchanged as a
verification parameter, never try to inspect or publish its value. Cancelled or
unavailable input is not approval. Asking a question is not execution proof.
For a recorded authentication prerequisite, request
{"interaction":{"action":"authenticate","plan":{"toolName":"authenticate_site","credentialRequestSeqs":[1],"authRequestSeqs":[2],"credentialNames":["username","password"],"captures":[],"notes":"Recording-grounded login, factor and session requirements"}}}.
Use exact supplied recording sequences and credential names. This invokes the
auth compiler with run_verification, inspect_verification_page and prompt_user
on one persistent browser. It can send a recorded push/OTP challenge, ask the
user, and continue the same login context. Do not declare external MFA impossible
merely because an ordinary API-test action has no human-input field. After auth
succeeds, test your own operation again; auth success is not hotel/data proof.
Native agents and ordinary compilers also have prompt_user and authenticate
tools. The authenticate tool starts owned work and returns a pending handle
immediately; use await_authentication or authentication_status to inspect it,
and cancel_authentication with its ownerRef to detach your ownership. A transport
wait ending is not an authentication verdict. list_authentication_contexts lists
factual existing contexts and operations. Choose plan.contextRef to continue one
explicitly, or plan.newContext:true to request isolation. Without either, the
legacy per-tool-name context is retained. Different labels are never merged. Do not mix an interaction envelope with a role decision.
`;

interface AuthenticationContextInfo {
  contextRef: string;
  label: string;
  createdAt: string;
  recordingRef?: string;
  credentialRevision?: string;
  workflowPath?: string;
  workflowRevision?: string;
  latestAction?: string;
  latestOk?: boolean;
  latestStatus?: number;
  latestError?: string;
  recordingRevision?: string;
  evidenceRefs?: string[];
}
interface AuthenticationOperationInfo {
  operationId: string;
  contextRef: string;
  toolName: string;
  state: 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';
  createdAt: string;
  startedAt?: string;
  settledAt?: string;
  owners: number;
  result?: AuthenticationResult;
  message?: string;
}
interface AuthenticationHandle extends AuthenticationOperationInfo {
  status: 'pending';
  /** Deliberate run-owned handle; transient status/await calls do not own the work. */
  ownerRef: string;
}
type AuthenticationLifecycleEvent = Omit<AuthenticationOperationInfo, 'result' | 'message'> & {
  event: string;
  elapsedMs: number;
};
type AuthenticationOperation = {
  info: AuthenticationOperationInfo;
  controller: AbortController;
  work: Promise<AuthenticationResult>;
  owners: Set<string>;
  created: number;
};
const log = createLog('authentication');
// Bound only one transport wait, not the authentication operation's lifetime.
const AUTHENTICATION_WAIT_MS = 45_000;
const AuthenticationControlSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('start'), plan: AgentInteractionSchema.options[1].shape.plan })
    .strict(),
  z.object({ action: z.literal('contexts') }).strict(),
  z.object({ action: z.literal('status'), operationId: z.string() }).strict(),
  z
    .object({
      action: z.literal('await'),
      operationId: z.string(),
      waitMs: z.number().int().min(0).max(AUTHENTICATION_WAIT_MS).default(AUTHENTICATION_WAIT_MS),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), operationId: z.string(), ownerRef: z.string() }).strict(),
]);
type AuthenticationControl = z.infer<typeof AuthenticationControlSchema>;

export class UserInteraction {
  readonly #secrets = new Map<string, string>();
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  #deadlineControl?: ReturnType<typeof combinedDeadlineSignal>;
  #queue: Promise<unknown> = Promise.resolve();
  #authQueue: Promise<unknown> = Promise.resolve();
  readonly #authRequests = new Map<string, AuthenticationOperation>();
  readonly #authOperations = new Map<string, AuthenticationOperation>();
  readonly #authContexts = new Map<string, AuthenticationContextInfo>();
  readonly #legacyContexts = new Map<string, string>();
  readonly #cleanups = new Set<() => void | Promise<void>>();
  #closing?: Promise<void>;
  #authenticate?: Authenticate;

  constructor(
    readonly onPrompt?: OnUserPrompt,
    signal?: AbortSignal,
    readonly onEvent?: (event: AuthenticationLifecycleEvent) => void,
  ) {
    this.#signal = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;
  }
  get signal(): AbortSignal {
    return this.#deadlineControl?.signal ?? this.#signal;
  }
  setRunControl(
    deadline?: RunDeadlineRef,
    onDeadlineReached?: () => Promise<number | null | undefined>,
  ): void {
    this.#deadlineControl?.dispose();
    this.#deadlineControl = combinedDeadlineSignal(
      deadline,
      undefined,
      this.#signal,
      Date.now,
      undefined,
      onDeadlineReached,
    );
  }
  get hasAuthentication(): boolean {
    return this.#authenticate !== undefined;
  }
  run<T>(work: () => T): T {
    return context.run(this, work);
  }
  /** Bind native-family context as well as the human-interaction context. */
  setAuthenticate(handler: Authenticate): void {
    this.#authenticate = AsyncResource.bind(handler);
  }
  addCleanup(cleanup: () => void | Promise<void>): void {
    if (this.#abort.signal.aborted) {
      void Promise.resolve()
        .then(cleanup)
        .catch(() => {});
      return;
    }
    this.#cleanups.add(cleanup);
  }
  updateAuthenticationContext(
    contextRef: string,
    metadata: Partial<Omit<AuthenticationContextInfo, 'contextRef' | 'label' | 'createdAt'>>,
  ): void {
    const info = this.#authContexts.get(contextRef);
    if (info) Object.assign(info, metadata);
  }
  authenticationContexts(): Array<
    AuthenticationContextInfo & { operations: AuthenticationOperationInfo[] }
  > {
    return Array.from(this.#authContexts.values(), (info) => ({
      ...info,
      operations: Array.from(this.#authOperations.values())
        .filter((operation) => operation.info.contextRef === info.contextRef)
        .map((operation) => this.#snapshot(operation)),
    }));
  }
  #snapshot(operation: AuthenticationOperation): AuthenticationOperationInfo {
    return { ...operation.info, owners: operation.owners.size };
  }
  #event(event: string, operation: AuthenticationOperation): void {
    const { result: _result, message: _message, ...info } = this.#snapshot(operation);
    const facts = { event, ...info, elapsedMs: Math.round(performance.now() - operation.created) };
    log(JSON.stringify(facts));
    try {
      this.onEvent?.(facts);
    } catch {
      /* Optional diagnostics cannot change execution. */
    }
  }
  #operation(operationId: string): AuthenticationOperation {
    const operation = this.#authOperations.get(operationId);
    if (!operation)
      throw new Error(
        'Unknown authentication operation; inspect list_authentication_contexts for current references.',
      );
    return operation;
  }
  #release(operation: AuthenticationOperation, ownerRef: string): void {
    if (!operation.owners.delete(ownerRef))
      throw new Error('Unknown or already released authentication owner reference.');
    if (operation.owners.size === 0 && ['queued', 'running'].includes(operation.info.state)) {
      operation.info.state = 'cancelling';
      this.#event('cancellation_requested', operation);
      operation.controller.abort(new DOMException('No authentication owners remain', 'AbortError'));
    }
  }
  startAuthentication(
    plan: Extract<AgentInteraction, { action: 'authenticate' }>['plan'],
  ): AuthenticationHandle {
    const authenticate = this.#authenticate;
    if (!authenticate) throw new Error('No authentication host is attached to this agent.');
    if (this.signal.aborted) throw abortSignalError(this.signal);
    if (plan.contextRef && plan.newContext)
      throw new Error('Choose contextRef or newContext, not both.');
    let contextRef =
      plan.contextRef ?? (plan.newContext ? undefined : this.#legacyContexts.get(plan.toolName));
    if (contextRef && !this.#authContexts.has(contextRef))
      throw new Error(
        'Unknown or expired authentication contextRef; inspect list_authentication_contexts or request newContext:true.',
      );
    if (!contextRef) {
      contextRef = randomUUID();
      this.#authContexts.set(contextRef, {
        contextRef,
        label: plan.toolName,
        createdAt: new Date().toISOString(),
      });
      if (!plan.newContext) this.#legacyContexts.set(plan.toolName, contextRef);
    }
    // Explicit context identity participates in exact in-flight coalescing. A
    // completed operation is retained for inspection, never reused as proof.
    const { newContext: _newContext, ...prepared } = { ...plan, contextRef };
    const key = JSON.stringify(prepared);
    let operation = this.#authRequests.get(key);
    if (
      !operation ||
      operation.controller.signal.aborted ||
      ['completed', 'cancelled', 'error'].includes(operation.info.state)
    ) {
      const controller = new AbortController();
      const signal = AbortSignal.any([this.signal, controller.signal]);
      const previous = this.#authQueue;
      operation = {
        info: {
          operationId: randomUUID(),
          contextRef,
          toolName: plan.toolName,
          state: 'queued',
          createdAt: new Date().toISOString(),
          owners: 0,
        },
        controller,
        owners: new Set(),
        created: performance.now(),
        work: undefined as never,
      };
      const current = operation;
      // The public queued operation can cancel promptly, while this queue tail
      // still waits for the predecessor's real teardown before admitting work.
      const queued = previous
        .catch(() => {})
        .then(async () => {
          if (signal.aborted) throw abortSignalError(signal);
          current.info.state = 'running';
          current.info.startedAt = new Date().toISOString();
          this.#event('execution_started', current);
          const result = await authenticate(prepared, signal);
          if (signal.aborted) throw abortSignalError(signal);
          return {
            ...result,
            contextRef,
            operationId: current.info.operationId,
            message: this.sanitize(result.message),
          };
        });
      current.work = withAbortSignal(() => previous.catch(() => {}), signal)
        .then(() => queued)
        .then(
          (result) => {
            current.info.result = result;
            current.info.state = 'completed';
            return result;
          },
          (error: unknown) => {
            current.info.state = signal.aborted ? 'cancelled' : 'error';
            // Provider/transport failures remain errors, never authentication verdicts.
            current.info.message = this.sanitize(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          },
        )
        .finally(() => {
          current.info.settledAt = new Date().toISOString();
          if (this.#authRequests.get(key) === current) this.#authRequests.delete(key);
          this.#event('execution_settled', current);
        });
      // Queue ownership ends after actual work/cleanup, including active abort.
      this.#authQueue = queued;
      void queued.catch(() => {});
      void current.work.catch(() => {});
      this.#authRequests.set(key, current);
      this.#authOperations.set(current.info.operationId, current);
      this.#event('enqueued', current);
    }
    const ownerRef = randomUUID();
    operation.owners.add(ownerRef);
    return { status: 'pending', ownerRef, ...this.#snapshot(operation) };
  }
  async authenticationControl(
    input: AuthenticationControl,
    callerSignal = this.signal,
  ): Promise<unknown> {
    const signal = AbortSignal.any([this.signal, callerSignal]);
    if (signal.aborted) throw abortSignalError(signal);
    const control = AuthenticationControlSchema.parse(input);
    if (control.action === 'contexts') return { contexts: this.authenticationContexts() };
    if (control.action === 'start') {
      const handle = this.startAuthentication(control.plan);
      // Ownership transfers with the returned handle. A request cancelled before
      // that handoff must not leave deliberately pending work behind.
      await Promise.resolve();
      if (signal.aborted) {
        this.#release(this.#operation(handle.operationId), handle.ownerRef);
        throw abortSignalError(signal);
      }
      return handle;
    }
    const operation = this.#operation(control.operationId);
    if (control.action === 'cancel') {
      this.#release(operation, control.ownerRef);
      return this.#snapshot(operation);
    }
    if (control.action === 'status') return this.#snapshot(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await withAbortSignal(
        () =>
          Promise.race([
            operation.work.then(
              () => this.#snapshot(operation),
              () => this.#snapshot(operation),
            ),
            new Promise<AuthenticationOperationInfo>((resolve) => {
              timer = setTimeout(() => resolve(this.#snapshot(operation)), control.waitMs);
            }),
          ]),
        signal,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async request(
    input: AgentInteraction,
    callerSignal = this.signal,
  ): Promise<UserPromptAnswer | AuthenticationResult> {
    const signal = AbortSignal.any([this.signal, callerSignal]);
    const operation = AgentInteractionSchema.parse(input);
    if (signal.aborted) throw abortSignalError(signal);
    if (operation.action === 'authenticate') {
      if (!this.#authenticate)
        return {
          status: 'unavailable',
          message: 'No authentication host is attached to this agent.',
        };
      const handle = this.startAuthentication(operation.plan);
      const work = this.#operation(handle.operationId);
      try {
        return await withAbortSignal(() => work.work, signal);
      } finally {
        this.#release(work, handle.ownerRef);
      }
    }
    const onPrompt = this.onPrompt;
    if (!onPrompt)
      return {
        status: 'unavailable',
        reason:
          'User input is unavailable: run teach in an interactive terminal without --no-interactive, or provide onPrompt.',
      };
    const work = this.#queue
      .catch(() => {})
      .then(async (): Promise<UserPromptAnswer> => {
        if (signal.aborted) throw abortSignalError(signal);
        const answer = await withAbortSignal(() => onPrompt(operation.prompt, signal), signal);
        if (answer.status !== 'answered') return answer;
        if (!operation.prompt.sensitive) return answer;
        const reference = `\${prompt.${randomUUID()}}`;
        this.#secrets.set(reference, answer.value);
        return { status: 'answered', value: reference };
      });
    this.#queue = work;
    return await withAbortSignal(() => work, signal);
  }

  resolve<T>(value: T): T {
    const visit = (entry: unknown): unknown => {
      if (typeof entry === 'string') {
        if (/^\$\{prompt\.[^}]+\}$/.test(entry)) {
          if (!this.#secrets.has(entry)) throw new Error('Unknown or expired user-input reference');
          return this.#secrets.get(entry);
        }
        return entry;
      }
      if (Array.isArray(entry)) return entry.map(visit);
      if (entry && typeof entry === 'object')
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, visit(item)]));
      return entry;
    };
    return visit(value) as T;
  }

  sanitize(text: string): string {
    let result = text;
    for (const [reference, value] of this.#secrets) {
      if (value) result = result.split(value).join(reference);
    }
    return result;
  }

  clear(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#abort.abort(new DOMException('User-interaction host closed', 'AbortError'));
    this.#deadlineControl?.dispose();
    this.#secrets.clear();
    this.#authenticate = undefined;
    for (const operation of this.#authOperations.values()) operation.controller.abort();
    this.#authRequests.clear();
    this.#authContexts.clear();
    this.#legacyContexts.clear();
    const cleanups = Array.from(this.#cleanups);
    this.#closing = this.#authQueue
      .catch(() => {})
      .then(async () => {
        await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)));
        this.#authOperations.clear();
      });
    this.#cleanups.clear();
    return this.#closing;
  }
}

async function remoteInteraction(
  path: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = process.env[USER_INTERACTION_ENV];
  if (!url) throw new Error('No user-interaction host is attached');
  if (signal?.aborted) throw abortSignalError(signal);
  const requestId = randomUUID();
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    // Bun's fetch cancellation need not close the parent's node:http response
    // promptly. Relay cancellation explicitly; never rely on TCP idle expiry.
    cancellation ??= fetch(`${url}/cancel-request`, {
      method: 'POST',
      headers: { 'x-imprint-request-id': requestId },
    })
      .then(async (response) => {
        await response.arrayBuffer();
      })
      .catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(`${url}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-imprint-request-id': requestId },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new Error(body?.error ?? `User-interaction host returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    // The MCP lifetime drains active handlers, so this short relay settles
    // before a disconnect can terminate the compiler bridge process.
    await cancellation;
  }
}

export async function requestAgentInteraction(
  input: AgentInteraction,
  signal?: AbortSignal,
): Promise<UserPromptAnswer | AuthenticationResult> {
  const local = currentUserInteraction();
  if (local) return await local.request(input, signal ?? local.signal);
  if (process.env[USER_INTERACTION_ENV]) {
    const parsed = AgentInteractionSchema.parse(input);
    if (parsed.action === 'prompt_user')
      return (await remoteInteraction('request', parsed, signal)) as UserPromptAnswer;
    // The bridge carries short owned-operation requests instead of one silent
    // multi-minute fetch. Await-style callers still own/cancel their operation.
    const handle = (await remoteInteraction(
      'authentication',
      { action: 'start', plan: parsed.plan },
      signal,
    )) as AuthenticationHandle;
    try {
      for (;;) {
        const state = (await remoteInteraction(
          'authentication',
          { action: 'await', operationId: handle.operationId },
          signal,
        )) as AuthenticationOperationInfo;
        if (state.state === 'completed' && state.result) return state.result;
        if (state.state === 'cancelled')
          throw new DOMException(state.message ?? 'Authentication cancelled', 'AbortError');
        if (state.state === 'error')
          throw new Error(state.message ?? 'Authentication provider/transport failed');
      }
    } finally {
      // Cleanup must reach the host even if this caller's request signal aborted.
      await remoteInteraction('authentication', {
        action: 'cancel',
        operationId: handle.operationId,
        ownerRef: handle.ownerRef,
      }).catch(() => {});
    }
  }
  return input.action === 'prompt_user'
    ? { status: 'unavailable', reason: 'No terminal input host is attached to this agent.' }
    : { status: 'unavailable', message: 'No authentication host is attached to this agent.' };
}

export async function resolveUserInput<T>(value: T, signal?: AbortSignal): Promise<T> {
  const local = currentUserInteraction();
  if (local) return local.resolve(value);
  if (process.env[USER_INTERACTION_ENV])
    return (await remoteInteraction('resolve', value, signal)) as T;
  if (JSON.stringify(value)?.includes('${prompt.'))
    throw new Error('User-input reference has no attached host');
  return value;
}

async function requestAuthenticationControl(
  input: AuthenticationControl,
  signal?: AbortSignal,
): Promise<unknown> {
  const control = AuthenticationControlSchema.parse(input);
  const local = currentUserInteraction();
  if (local) return await local.authenticationControl(control, signal ?? local.signal);
  return await remoteInteraction('authentication', control, signal);
}

export function userInteractionTools(signal?: AbortSignal): AgentTool[] {
  const callSignal = (request?: { signal?: AbortSignal }): AbortSignal | undefined =>
    signal && request?.signal
      ? AbortSignal.any([signal, request.signal])
      : (request?.signal ?? signal);
  const controlTool = (
    name: string,
    action: 'contexts' | 'status' | 'await' | 'cancel',
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): AgentTool => ({
    name,
    description,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
    handler: async (input, request) => ({
      result: JSON.stringify(
        await requestAuthenticationControl(
          AuthenticationControlSchema.parse({ ...(input as object), action }),
          callSignal(request),
        ),
      ),
    }),
  });
  return [
    {
      name: 'prompt_user',
      description:
        'Ask the human for necessary input, a decision, or an external action. Use sensitive:true for OTPs and secrets; pass its returned reference unchanged to verification. Cancellation or unavailable input is not approval.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          sensitive: { type: 'boolean' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      handler: async (input, request) => ({
        result: JSON.stringify(
          await requestAgentInteraction(
            { action: 'prompt_user', prompt: UserPromptSchema.parse(input) },
            callSignal(request),
          ),
        ),
      }),
    },
    {
      name: 'authenticate',
      description:
        'Start owned recording-grounded authentication work and return a pending operation/context handle immediately. Use await_authentication or authentication_status for its factual result. Choose plan.contextRef to deliberately reuse a listed context or plan.newContext:true for isolation; omitted preserves legacy label reuse. Retain ownerRef to cancel/detach your ownership. The run owns deliberately pending work until its owners cancel or the run ends. Auth success never substitutes for testing the data operation.',
      input_schema: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: {
              toolName: { type: 'string' },
              contextRef: { type: 'string' },
              newContext: { type: 'boolean' },
              credentialRequestSeqs: { type: 'array', items: { type: 'integer' } },
              authRequestSeqs: { type: 'array', items: { type: 'integer' } },
              credentialNames: { type: 'array', items: { type: 'string' } },
              captures: { type: 'array', items: { type: 'object' } },
              notes: { type: 'string' },
            },
            required: ['toolName'],
            additionalProperties: false,
          },
        },
        required: ['plan'],
        additionalProperties: false,
      },
      handler: async (input, request) => {
        const parsed = AgentInteractionSchema.parse({
          ...(input as object),
          action: 'authenticate',
        });
        if (parsed.action !== 'authenticate') throw new Error('Expected authentication plan');
        return {
          result: JSON.stringify(
            await requestAuthenticationControl(
              { action: 'start', plan: parsed.plan },
              callSignal(request),
            ),
          ),
        };
      },
    },
    controlTool(
      'list_authentication_contexts',
      'contexts',
      'List factual retained auth contexts and their owned operations before choosing reuse, waiting, cancellation, or a separate context. Labels never imply equivalence.',
      {},
    ),
    controlTool(
      'authentication_status',
      'status',
      'Inspect an existing authentication operation. Transport/provider errors are separate from its authentication result.',
      { operationId: { type: 'string' } },
      ['operationId'],
    ),
    controlTool(
      'await_authentication',
      'await',
      'Wait for an existing owned operation, returning current state after at most 45s per transport call. Queued/running is pending, not a failed auth verdict. A cancelled wait detaches only this transient wait; the explicit owner handle continues until cancel_authentication or run cancellation.',
      {
        operationId: { type: 'string' },
        waitMs: { type: 'integer', minimum: 0, maximum: AUTHENTICATION_WAIT_MS },
      },
      ['operationId'],
    ),
    controlTool(
      'cancel_authentication',
      'cancel',
      'Release this explicit owner. Coalesced work continues for remaining owners; the last owner cancels it and its queue ownership remains until real cleanup settles.',
      { operationId: { type: 'string' }, ownerRef: { type: 'string' } },
      ['operationId', 'ownerRef'],
    ),
  ];
}

/** Child compilers request input from their parent's terminal, never from piped stdin. */
export async function withUserInteraction<T>(
  interaction: UserInteraction,
  work: () => Promise<T>,
): Promise<T> {
  const token = `/${randomUUID()}`;
  const bridgeRequests = new Map<string, AbortController>();
  const cancelledRequests = new Set<string>();
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      ![
        `${token}/request`,
        `${token}/resolve`,
        `${token}/authentication`,
        `${token}/cancel-request`,
      ].includes(request.url ?? '') ||
      request.headers.origin
    ) {
      response.writeHead(404).end();
      return;
    }
    const requestId = request.headers['x-imprint-request-id'];
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) {
      response.writeHead(400).end();
      return;
    }
    if (request.url === `${token}/cancel-request`) {
      const pending = bridgeRequests.get(requestId);
      if (pending) pending.abort(new DOMException('Requesting agent cancelled', 'AbortError'));
      else cancelledRequests.add(requestId);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const disconnected = new AbortController();
    bridgeRequests.set(requestId, disconnected);
    if (cancelledRequests.delete(requestId))
      disconnected.abort(new DOMException('Requesting agent cancelled', 'AbortError'));
    response.on('close', () => {
      if (!response.writableEnded)
        disconnected.abort(new DOMException('Requesting agent disconnected', 'AbortError'));
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64_000) throw new Error('Interaction request is too large');
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result =
        request.url === `${token}/resolve`
          ? interaction.resolve(value)
          : request.url === `${token}/authentication`
            ? await interaction.authenticationControl(
                AuthenticationControlSchema.parse(value),
                disconnected.signal,
              )
            : await interaction.request(AgentInteractionSchema.parse(value), disconnected.signal);
      if (request.url === `${token}/authentication` && value.action === 'start') {
        const pendingHandle = result as AuthenticationHandle;
        if (disconnected.signal.aborted) {
          await interaction
            .authenticationControl({
              action: 'cancel',
              operationId: pendingHandle.operationId,
              ownerRef: pendingHandle.ownerRef,
            })
            .catch(() => {});
          return;
        }
        const handle = pendingHandle;
        response.once('close', () => {
          if (!response.writableEnded)
            void interaction
              .authenticationControl({
                action: 'cancel',
                operationId: handle.operationId,
                ownerRef: handle.ownerRef,
              })
              .catch(() => {});
        });
      }
      response
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(result));
    } catch (error) {
      if (!response.destroyed)
        response.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: interaction.sanitize(
              error instanceof Error ? error.message : 'Interaction request failed',
            ),
          }),
        );
    } finally {
      bridgeRequests.delete(requestId);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Interaction bridge did not open');
  const previous = process.env[USER_INTERACTION_ENV];
  process.env[USER_INTERACTION_ENV] = `http://127.0.0.1:${address.port}${token}`;
  try {
    return await interaction.run(work);
  } finally {
    if (previous === undefined) delete process.env[USER_INTERACTION_ENV];
    else process.env[USER_INTERACTION_ENV] = previous;
    await interaction.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
