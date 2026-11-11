/**
 * `imprint mcp-server` — exposes every generated tool under
 * <IMPRINT_HOME>/<site>/ as an MCP tool. Stdio + Streamable HTTP transports.
 * See docs/getting-started.md for Claude Desktop / mcp-inspector wire-up.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { resolve as pathResolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type BackendAttemptFact,
  cdpReplayPoolKey,
  resolveLadder,
  runWithLadder,
} from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { TimeoutError, withTimeoutCleanup } from './concurrency.ts';
import { withSiteAuthRecoveryLock } from './credential-store.ts';
import { createLog } from './log.ts';
import { McpCdpSessions } from './mcp-cdp-sessions.ts';
import {
  type RecoveryPolicy,
  loadRecoveryPolicy,
  recoverSession,
  unsafeAuthRequests,
} from './mcp-session-recovery.ts';
import { imprintHomeDir } from './paths.ts';
import { loadBackendsCacheStatus, persistRuntimeBackendsCache } from './probe-backends.ts';
import { checkSiteCredentialsReady, loadCredentialStore } from './runtime.ts';
import { availableSitesHint } from './sites.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import {
  type ResolvedTool as DiscoveredTool,
  buildZodValidator,
  discoverTools,
} from './tool-loader.ts';
import type { ConcreteBackend, ToolResult, Workflow, WorkflowParameter } from './types.ts';
import { VERSION } from './version.ts';

interface RunMcpServerOptions {
  /** Site name. */
  site: string;
  /** Override generated asset root. Defaults to IMPRINT_HOME (~/.imprint). */
  assetRoot?: string;
  /** Use Streamable HTTP transport instead of stdio. */
  http?: boolean;
  /** Port for HTTP transport (default 8765). */
  port?: number;
  /** Hostname for HTTP transport (default 127.0.0.1). */
  host?: string;
  /** Server display name advertised to clients. */
  name?: string;
  /** Server version. */
  version?: string;
  /** Optional exact tool-name allowlist. Used by audit sessions to keep
   * human-interactive authentication workflows out of headless MCP exposure. */
  includeToolNames?: readonly string[];
}

interface ResolvedTool extends DiscoveredTool {
  inputSchema: Tool['inputSchema'];
  playbookPath?: string;
  /** Probe-cached ladder; runtime starts here instead of the default. */
  preferredOrder?: ConcreteBackend[];
}

/** Exact allowlist selection used by bounded MCP sessions such as audit. An
 * omitted allowlist preserves normal production behavior and exposes all tools. */
export function selectMcpTools<T extends { workflow: { toolName: string } }>(
  tools: readonly T[],
  includeToolNames?: readonly string[],
): T[] {
  if (!includeToolNames) return [...tools];
  const includedNames = new Set(includeToolNames);
  return tools.filter((tool) => includedNames.has(tool.workflow.toolName));
}

/** Tool description shown to MCP clients. Includes the operator's
 *  recorded narration when present — surprisingly load-bearing for the
 *  LLM picking the right tool. */
export function buildToolDescription(w: ResolvedTool['workflow']): string {
  const base = w.intent.description;
  const said = w.intent.userSaid?.trim();
  const context = said ? `${base}\n\nRecording context: "${said}"` : base;
  if (!w.limitations?.length) return context;
  const limitations = w.limitations
    .map((entry) => {
      const omitted = entry.omittedParameters?.length
        ? ` Omitted inputs: ${entry.omittedParameters.join(', ')}.`
        : '';
      return `- ${entry.feature}: ${entry.reason}${omitted}`;
    })
    .join('\n');
  return `${context}\n\nKnown limitations:\n${limitations}`;
}

/** MCP advertises tool input as JSON Schema; build it directly from
 *  workflow parameters rather than going through Zod. */
export function buildJsonSchema(
  parameters: WorkflowParameter[],
  opts?: { authConfig?: Workflow['authConfig'] },
): Tool['inputSchema'] {
  const properties: Record<
    string,
    { type: string; description: string; enum?: Array<string | number | boolean> }
  > = {};
  const required: string[] = [];
  for (const p of parameters) {
    // Producer-sourced params: tell the orchestrating LLM where to mint/derive
    // the value so it calls the producer once and reuses it, rather than
    // fabricating context the consumer would reject or misinterpret.
    const description = p.sourcedFrom
      ? `${p.description} Obtain this value from the \`${p.sourcedFrom.tool}\` tool's \`${p.sourcedFrom.field}\` output — call \`${p.sourcedFrom.tool}\` first and reuse the value across calls (no need to re-fetch each time).`
      : p.description;
    const property: { type: string; description: string; enum?: Array<string | number | boolean> } =
      {
        type: p.type,
        description,
      };
    if (p.choices?.length) property.enum = p.choices;
    properties[p.name] = property;
    if (p.default === undefined && !opts?.authConfig) required.push(p.name);
  }
  if (opts?.authConfig) {
    properties.action = {
      type: 'string',
      description: `Auth action to run. Defaults to ${JSON.stringify(opts.authConfig.entry)}.`,
      enum: Object.keys(opts.authConfig.actions),
    };
    properties.continuation = {
      type: 'string',
      description: 'One-use opaque token returned by the previous auth action.',
    };
  }
  return {
    type: 'object',
    properties,
    required: required.length ? required : undefined,
  };
}

const log = createLog('mcp');

interface StoredAuthContinuation {
  toolName: string;
  nextAction?: string;
  state: Record<string, unknown>;
  recoveryRevision?: string;
  recoveryBrowser?: CdpBrowserFetch;
}

export class AuthContinuationStore {
  private readonly values = new Map<string, StoredAuthContinuation>();

  issue(value: StoredAuthContinuation): string {
    const token = randomUUID();
    this.values.set(token, value);
    return token;
  }

  consume(token: string, toolName: string, action: string): StoredAuthContinuation | undefined {
    const value = this.values.get(token);
    this.values.delete(token);
    if (!value || value.toolName !== toolName || value.nextAction !== action) return undefined;
    return value;
  }

  isManaged(token: string): boolean {
    return this.values.get(token)?.recoveryRevision !== undefined;
  }

  pending(
    toolName: string,
    isRetained: (browser: CdpBrowserFetch) => boolean,
  ):
    | {
        nextAction: string;
        continuation: string;
        managed: boolean;
      }
    | undefined {
    for (const [continuation, entry] of this.values) {
      if (entry.toolName !== toolName || !entry.nextAction) continue;
      if (entry.recoveryBrowser && !isRetained(entry.recoveryBrowser)) {
        this.values.delete(continuation);
      } else {
        return {
          nextAction: entry.nextAction,
          continuation,
          managed: entry.recoveryRevision !== undefined,
        };
      }
    }
    return undefined;
  }

  clearTool(toolName: string): void {
    for (const [token, value] of this.values) {
      if (value.toolName === toolName) this.values.delete(token);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

export async function runSerializedBySite<T>(
  queues: Map<string, Promise<void>>,
  site: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(site) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(site, tail);
  tail.finally(() => {
    if (queues.get(site) === tail) queues.delete(site);
  });
  return await run;
}

function auditToolDeadlineMs(): number | undefined {
  const raw = Number(process.env.IMPRINT_AUDIT_TOOL_DEADLINE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (process.env.IMPRINT_AUDIT_PACING_MS !== undefined) return 120_000;
  return undefined;
}

/** Build the MCP Server with all discovered tools registered. */
function buildServer(
  name: string,
  version: string,
  tools: ResolvedTool[],
  assetRoot: string,
  recoveryPolicy?: RecoveryPolicy,
): { server: Server; closeCdpPool: () => Promise<void> } {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions:
        'Imprint runs deterministic workflows captured from real browser sessions. Data tools can escalate through API, browser, and playbook backends. Authenticate tools execute their compiled action program without playbooks. Error codes: AUTH_EXPIRED (401); ACTION_REQUIRED (run nextAction and pass continuation back unchanged); STATE_MISSING; FORBIDDEN; RATE_LIMITED; BAD_RESPONSE; NETWORK; UNKNOWN.',
    },
  );

  const validators = new Map(
    tools.map(
      (t) =>
        [
          t.workflow.toolName,
          buildZodValidator(t.workflow.parameters, {
            allOptional: t.workflow.toolKind === 'authenticate',
          }),
        ] as const,
    ),
  );

  // Per-site stealth-fetch cache so the ~12s bootstrap runs once per site.
  const stealthCache = new Map<string, StealthFetch>();

  const cdpSessions = new McpCdpSessions();
  const cdpPool = cdpSessions.pool;
  const authContinuations = new AuthContinuationStore();
  const isRetained = (browser: CdpBrowserFetch) => [...cdpPool.values()].includes(browser);
  function authBrowser(tool: ResolvedTool): CdpBrowserFetch | undefined {
    const prefix = cdpReplayPoolKey(tool.site, tool.workflow.toolName, '');
    return [...cdpPool.entries()].reverse().find(([key]) => key.startsWith(prefix))?.[1];
  }

  // Per-tool memo of the winning backend for THIS server session. After the
  // first call discovers the right rung, later calls skip the doomed early ones
  // Its lifetime follows that tool's CDP sessions: idle/timeout cleanup clears
  // only the affected tool's memo.
  const winnerCache = cdpSessions.winners;

  // Keep same-site calls sequential so concurrent calls cannot race a tool's
  // browser, winner memo, or backend cache. Unrelated sites remain independent.
  const siteExecutionQueues = new Map<string, Promise<void>>();
  const authTool =
    recoveryPolicy &&
    tools.find(
      ({ workflow, site }) =>
        workflow.toolName === recoveryPolicy.authTool &&
        workflow.toolKind === 'authenticate' &&
        workflow.site === site &&
        workflow.authConfig?.actions,
    );
  let recoveryGeneration = 0;
  const shuttingDown = new AbortController();
  const activeRecovery = new Set<Promise<unknown>>();

  async function trackRecovery<T>(work: Promise<T>): Promise<T> {
    activeRecovery.add(work);
    try {
      return await work;
    } finally {
      activeRecovery.delete(work);
    }
  }

  async function executeTool(
    tool: ResolvedTool,
    args: Record<string, string | number | boolean>,
    initialState?: Record<string, unknown>,
    options?: {
      retainBrowser?: boolean;
      browserOnly?: boolean;
      authBrowser?: CdpBrowserFetch;
      replayOnly?: boolean;
      signal?: AbortSignal;
      credentials?: Awaited<ReturnType<typeof loadCredentialStore>>;
    },
  ): Promise<Awaited<ReturnType<typeof runWithLadder>>> {
    const preferred = resolveLadder('auto', tool.preferredOrder);
    const ladder: ConcreteBackend[] = options?.browserOnly
      ? ['cdp-replay']
      : options?.replayOnly
        ? preferred.filter((backend) => backend !== 'playbook')
        : preferred;
    cdpSessions.beginCall(tool.site, tool.workflow.toolName);
    const execution = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([execution.signal, options.signal])
      : execution.signal;
    const run = runWithLadder(ladder, tool, args, assetRoot, stealthCache, {
      cdpPool,
      authBrowser: options?.authBrowser,
      winnerCache,
      initialState,
      credentials: options?.credentials ?? undefined,
      signal,
    });
    const deadline = auditToolDeadlineMs();
    try {
      return deadline
        ? await withTimeoutCleanup(
            run,
            deadline,
            `${tool.workflow.toolName} audit MCP call`,
            () => {
              execution.abort();
              void cdpSessions.closeTool(tool.site, tool.workflow.toolName);
            },
          )
        : await run;
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      return {
        result: {
          ok: false,
          error: 'NETWORK',
          message: `${tool.workflow.toolName} exceeded the audit MCP internal deadline after ${Math.round((deadline ?? 0) / 1000)}s`,
        },
        usedBackend: ladder[0] ?? 'fetch',
        attempts: [],
      };
    } finally {
      if (!options?.retainBrowser) cdpSessions.finishCall(tool.site, tool.workflow.toolName);
    }
  }

  function authRequired(
    message: string,
    continuation?: {
      authTool: string;
      nextAction: string;
      continuation?: string;
    },
  ): CallToolResult {
    const instructions = [`[AUTH_REQUIRED] ${message}`];
    if (continuation) {
      instructions.push(
        `Continue with ${continuation.authTool} using action ${JSON.stringify(continuation.nextAction)}.`,
      );
      if (continuation.continuation) {
        instructions.push(`  continuation: ${JSON.stringify(continuation.continuation)}`);
      }
    }
    return {
      isError: false,
      structuredContent: { status: 'auth_required', message, ...continuation },
      content: [{ type: 'text', text: instructions.join('\n') }],
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.workflow.toolName,
      description: buildToolDescription(tool.workflow),
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.workflow.toolName === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const validator = validators.get(req.params.name);
    const parsed = validator?.safeParse(req.params.arguments ?? {});
    if (parsed && !parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid arguments: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
          },
        ],
      };
    }
    const args = (parsed?.data ?? req.params.arguments ?? {}) as Record<
      string,
      string | number | boolean
    >;

    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    const isAuth = tool.workflow.toolKind === 'authenticate';
    if (isAuth && typeof rawArgs.action === 'string') args.action = rawArgs.action;
    const action = String(args.action ?? (isAuth ? tool.workflow.authConfig?.entry : '') ?? '');
    let continuation: StoredAuthContinuation | undefined;
    let managedToken: string | undefined;
    const invalidContinuation = (): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: 'Invalid or expired continuation token.' }],
    });
    if (isAuth && rawArgs.continuation !== undefined) {
      if (typeof rawArgs.continuation !== 'string') return invalidContinuation();
      if (authContinuations.isManaged(rawArgs.continuation)) {
        managedToken = rawArgs.continuation;
      } else {
        continuation = authContinuations.consume(
          rawArgs.continuation,
          tool.workflow.toolName,
          action,
        );
        if (!continuation) return invalidContinuation();
      }
    }

    const policy = recoveryPolicy;
    const protectedRead =
      !isAuth &&
      authTool &&
      policy?.protectedTools.includes(tool.workflow.toolName) &&
      tool.site === tool.workflow.site &&
      tool.site === authTool.site &&
      tool.workflow.requests.length > 0 &&
      tool.workflow.requests.every((request) => request.effect === 'safe');
    const generation = recoveryGeneration;
    const requestConsent =
      server.getClientCapabilities()?.elicitation?.form && policy
        ? async (name: string, signal: AbortSignal) => {
            const response = await server.elicitInput(
              {
                mode: 'form',
                message: `Allow ${tool.site} to run the sign-in step "${name}"? It may send a new approval request.`,
                requestedSchema: { type: 'object', properties: {} },
              },
              { signal, timeout: policy.timeoutMs, relatedRequestId: extra.requestId },
            );
            return response.action === 'accept';
          }
        : undefined;
    try {
      return await runSerializedBySite(siteExecutionQueues, tool.site, async () => {
        const signal =
          protectedRead || managedToken !== undefined
            ? AbortSignal.any([extra.signal, shuttingDown.signal])
            : undefined;
        signal?.throwIfAborted();
        if (managedToken !== undefined) {
          continuation = authContinuations.consume(managedToken, tool.workflow.toolName, action);
          if (!continuation) return invalidContinuation();
        }
        const revision = continuation?.recoveryRevision;
        if (continuation?.recoveryBrowser && !isRetained(continuation.recoveryBrowser)) {
          return authRequired(
            'The browser for this sign-in has closed. Start sign-in again if needed.',
          );
        }

        // Pace only the bounded audit harness.
        const pacingMs = Number(process.env.IMPRINT_AUDIT_PACING_MS);
        if (Number.isFinite(pacingMs) && pacingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pacingMs));
        }

        const authName = authTool?.workflow.toolName;
        if (
          authName === tool.workflow.toolName &&
          policy &&
          !continuation &&
          (args.action ?? tool.workflow.authConfig?.entry) ===
            (policy.startAction ?? tool.workflow.authConfig?.entry) &&
          authContinuations.pending(authName, isRetained)
        ) {
          authContinuations.clearTool(authName);
          await cdpSessions.closeTool(tool.site, authName);
        }

        let outcome: Awaited<ReturnType<typeof executeTool>>;
        if (revision !== undefined && signal) {
          const resumed = await trackRecovery(
            withSiteAuthRecoveryLock(tool.site, signal, async () => {
              const saved = await loadCredentialStore(tool.site, signal, { includeEmpty: true });
              if (!saved || saved.durableRevision !== revision) {
                await cdpSessions.closeTool(tool.site, tool.workflow.toolName);
                return authRequired('The saved session changed. Retry the protected call.');
              }
              const unsafe = unsafeAuthRequests(tool.workflow, action);
              if (!unsafe) return authRequired('This action needs standalone manual sign-in.');
              if (unsafe.size && !(requestConsent && (await requestConsent(action, signal)))) {
                if (!continuation) return invalidContinuation();
                const token = authContinuations.issue(continuation);
                return authRequired('Consent is required before running that sign-in action.', {
                  authTool: tool.workflow.toolName,
                  nextAction: action,
                  continuation: token,
                });
              }
              if (
                (await loadCredentialStore(tool.site, signal, { includeEmpty: true }))
                  ?.durableRevision !== revision
              ) {
                await cdpSessions.closeTool(tool.site, tool.workflow.toolName);
                return authRequired('The saved session changed. Retry the protected call.');
              }
              if (continuation?.recoveryBrowser && !isRetained(continuation.recoveryBrowser)) {
                return authRequired(
                  'The browser for this sign-in has closed. Start sign-in again if needed.',
                );
              }
              return executeTool(tool, args, continuation?.state, {
                browserOnly: true,
                authBrowser: continuation?.recoveryBrowser,
                signal,
                credentials: { ...saved, authCommitRevision: revision },
              });
            }),
          );
          if ('content' in resumed) return resumed;
          outcome = resumed;
        } else {
          const saved = protectedRead
            ? await loadCredentialStore(tool.site, signal, { includeEmpty: true })
            : undefined;
          outcome = await executeTool(tool, args, continuation?.state, {
            signal,
            credentials: saved,
          });

          if (
            authTool &&
            policy &&
            signal &&
            protectedRead &&
            !outcome.result.ok &&
            outcome.result.error === 'AUTH_EXPIRED'
          ) {
            if (generation !== recoveryGeneration) {
              return authRequired(
                'Another call already tried to renew this session. Try again to start a new attempt.',
              );
            }
            const deadline = AbortSignal.timeout(policy.timeoutMs);
            const recoverySignal = AbortSignal.any([signal, deadline]);
            try {
              const result = await trackRecovery(
                withSiteAuthRecoveryLock(tool.site, recoverySignal, async () => {
                  const current = await loadCredentialStore(tool.site, recoverySignal, {
                    includeEmpty: true,
                  });
                  const currentRevision = current?.durableRevision;
                  if (currentRevision !== saved?.durableRevision)
                    return { status: 'retry' } as const;
                  if (!current || currentRevision === undefined) {
                    return {
                      status: 'blocked',
                      message: 'The saved session could not be loaded.',
                    } as const;
                  }

                  const authName = authTool.workflow.toolName;
                  const pending = authContinuations.pending(authName, isRetained);
                  if (pending && !pending.managed) {
                    return {
                      status: 'blocked',
                      message: 'Finish the standalone sign-in, then retry the protected call.',
                    } as const;
                  }
                  if (pending) {
                    return {
                      status: 'manual',
                      action: pending.nextAction,
                      continuation: pending.continuation,
                      message: 'A sign-in is already waiting for a response.',
                    } as const;
                  }
                  await cdpSessions.closeTool(tool.site, authName);
                  const stillCurrent = async () =>
                    (await loadCredentialStore(tool.site, recoverySignal, { includeEmpty: true }))
                      ?.durableRevision === currentRevision;
                  let keepBrowser = false;
                  try {
                    const recovered = await recoverSession(authTool.workflow, policy, {
                      signal: recoverySignal,
                      execute: async (action, state) => {
                        if (!(await stillCurrent())) {
                          return {
                            ok: false,
                            error: 'AUTH_EXPIRED',
                            message: 'The saved session changed.',
                          };
                        }
                        return (
                          await executeTool(authTool, { action }, state, {
                            browserOnly: true,
                            authBrowser: state === undefined ? undefined : authBrowser(authTool),
                            retainBrowser: true,
                            signal: recoverySignal,
                            credentials: { ...current, authCommitRevision: currentRevision },
                          })
                        ).result;
                      },
                      requestConsent: requestConsent
                        ? async (name) =>
                            (await stillCurrent()) && requestConsent(name, recoverySignal)
                        : undefined,
                    });

                    if (recovered.status !== 'authenticated' && !(await stillCurrent())) {
                      return { status: 'retry' } as const;
                    }
                    if (recovered.status === 'manual') {
                      const unsafe = unsafeAuthRequests(authTool.workflow, recovered.action);
                      const browser =
                        recovered.state === undefined ? undefined : authBrowser(authTool);
                      if (!unsafe || (unsafe.size && (!requestConsent || !browser))) {
                        return {
                          status: 'blocked',
                          message: 'This action needs standalone manual sign-in.',
                        } as const;
                      }
                      keepBrowser = browser !== undefined;
                      return {
                        ...recovered,
                        continuation:
                          browser && recovered.state !== undefined
                            ? authContinuations.issue({
                                toolName: authName,
                                nextAction: recovered.action,
                                state: recovered.state,
                                recoveryRevision: currentRevision,
                                recoveryBrowser: browser,
                              })
                            : undefined,
                      };
                    }
                    return recovered;
                  } finally {
                    if (keepBrowser) cdpSessions.finishCall(tool.site, authName);
                    else await cdpSessions.closeTool(tool.site, authName);
                  }
                }),
              );
              if (result.status === 'manual') {
                return authRequired(result.message, {
                  authTool: authTool.workflow.toolName,
                  nextAction: result.action,
                  continuation: result.continuation,
                });
              }
              if (result.status === 'blocked') return authRequired(result.message);
            } catch (error) {
              if (signal.aborted || !deadline.aborted) throw error;
              return authRequired('Sign-in did not finish before the recovery deadline.');
            } finally {
              recoveryGeneration++;
            }
            outcome = await executeTool(tool, args, undefined, { signal, replayOnly: true });
            if (!outcome.result.ok && outcome.result.error === 'AUTH_EXPIRED') {
              return authRequired(
                'The session is still unavailable after retrying the protected call.',
              );
            }
          }
        }
        const { result, usedBackend, attempts } = outcome;
        if (!result.ok) {
          const continuationToken =
            tool.workflow.toolKind === 'authenticate' && result.continuation
              ? authContinuations.issue({
                  toolName: tool.workflow.toolName,
                  nextAction:
                    result.nextAction ?? String(args.action ?? tool.workflow.authConfig?.entry),
                  state: result.continuation,
                  recoveryRevision: revision,
                  recoveryBrowser: continuation?.recoveryBrowser,
                })
              : undefined;
          const text = formatToolError(result, continuationToken, attempts);
          return {
            isError: true,
            content: [{ type: 'text', text: `${text}\n(backend: ${usedBackend})` }],
          };
        }
        try {
          const cache = persistRuntimeBackendsCache({ tool, assetRoot, usedBackend, attempts });
          if (cache) {
            tool.preferredOrder = cache.preferredOrder;
            log(
              `  learned backend order for ${tool.workflow.toolName}: ${cache.preferredOrder.join(' → ')}`,
            );
          }
        } catch (err) {
          log(
            `  warning: could not persist backend order for ${tool.workflow.toolName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const text =
          typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
        return { content: [{ type: 'text', text: `${text}\n\n(backend: ${usedBackend})` }] };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `[INTERNAL] ${msg}` }] };
    }
  });

  async function closeCdpPool(): Promise<void> {
    shuttingDown.abort();
    const closing = cdpSessions.closeAll();
    await Promise.allSettled(activeRecovery);
    await closing;
    authContinuations.clear();
  }

  return { server, closeCdpPool };
}

export function formatToolError(
  result: Extract<ToolResult, { ok: false }>,
  continuationToken?: string,
  attempts: readonly BackendAttemptFact[] = [],
): string {
  const lines = [`[${result.error}] ${result.message}`];
  if (result.error === 'STATE_MISSING' && result.missing?.length) {
    for (const item of result.missing) {
      lines.push(
        `  - ${item.name}: ${item.failure} (${item.capability})${item.message ? ` — ${item.message}` : ''}`,
      );
    }
  }
  if (result.nextAction) lines.push(`  nextAction: ${result.nextAction}`);
  if (continuationToken) lines.push(`  continuation: ${JSON.stringify(continuationToken)}`);
  if (result.remediation) lines.push(`  → ${result.remediation}`);
  if (result.pageDiagnostic) {
    const page = result.pageDiagnostic;
    lines.push(
      `Rendered page observed after a failed browser call (possibly before fallback; not the requested API response): ${JSON.stringify(
        {
          url: page.url.slice(0, 300),
          title: page.title.slice(0, 300),
          bodyText: page.bodyText.slice(0, 3_000),
          truncated:
            page.truncated ||
            page.url.length > 300 ||
            page.title.length > 300 ||
            page.bodyText.length > 3_000,
        },
      )}`,
    );
  }
  if (attempts.length > 0) {
    lines.push('Backend attempts:');
    for (const attempt of attempts) {
      lines.push(
        `  - ${attempt.backend}: ${attempt.outcome} in ${attempt.durationMs}ms — ${attempt.detail}`,
      );
    }
  }
  return lines.join('\n');
}

export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  const assetRoot = opts.assetRoot ?? imprintHomeDir();
  const discoveredAll = await discoverTools(assetRoot, opts.site, '[imprint mcp]');
  const discovered = selectMcpTools(discoveredAll, opts.includeToolNames);
  const tools: ResolvedTool[] = discovered.map((t) => {
    const playbookPath = pathResolve(t.dir, 'playbook.yaml');
    const cacheStatus = loadBackendsCacheStatus(t.site, assetRoot, t.dir, {
      toolName: t.workflow.toolName,
    });
    if (cacheStatus.status === 'stale' || cacheStatus.status === 'invalid') {
      log(
        `  ${t.workflow.toolName}: ${cacheStatus.status} backends.json (${cacheStatus.reason}); run \`${cacheStatus.remediation}\``,
      );
    }
    return {
      ...t,
      inputSchema: buildJsonSchema(t.workflow.parameters, {
        authConfig: t.workflow.toolKind === 'authenticate' ? t.workflow.authConfig : undefined,
      }),
      playbookPath: existsSync(playbookPath) ? playbookPath : undefined,
      preferredOrder: cacheStatus.status === 'ok' ? cacheStatus.cache.preferredOrder : undefined,
    };
  });
  if (tools.length === 0) {
    throw new Error(
      `No generated tool found for site "${opts.site}"\n${availableSitesHint(assetRoot, opts.site)}\n→ run \`imprint teach ${opts.site}\` or \`imprint emit ~/.imprint/<site>/<toolName>/workflow.json\` to codegen a tool.`,
    );
  }

  const name = opts.name ?? `imprint-${opts.site}`;
  const version = opts.version ?? VERSION;

  for (const t of tools) {
    log(`registered ${t.workflow.toolName} (${t.site}) — ${t.workflow.parameters.length} param(s)`);
    if (t.preferredOrder) {
      log(`  preferred backend order (probed): ${t.preferredOrder.join(' → ')}`);
    }
    if (t.playbookPath) {
      log('  playbook.yaml found (available as ladder fallback)');
    }
  }

  // Pre-flight: warn loudly if any tool's site has a credentials manifest
  // declaring secrets that aren't yet provisioned. We log instead of throw
  // so the MCP server still comes up — the user might be intentionally
  // running an unauthenticated subset of tools — but the warning gives them
  // the exact commands to run before the first tool call fails.
  const reportedSites = new Set<string>();
  for (const t of tools) {
    if (reportedSites.has(t.site)) continue;
    reportedSites.add(t.site);
    try {
      const report = await checkSiteCredentialsReady(t.site);
      if (!report.ok) {
        // Two-line summary on the warning, then the full multi-line
        // remediation block. The message is already formatted for humans.
        log(
          `  ⚠ site "${t.site}" is missing ${report.missing.length} credential(s) declared in credentials.manifest.json`,
        );
        for (const line of report.message.split('\n')) {
          log(`    ${line}`);
        }
      }
    } catch (err) {
      log(
        `  ⚠ credential pre-flight for "${t.site}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opts.http) {
    const port = opts.port ?? 8765;
    const host = opts.host ?? '127.0.0.1';
    await runHttp(name, version, tools, host, port, assetRoot);
  } else {
    let policy: RecoveryPolicy | undefined;
    if (!opts.includeToolNames) {
      try {
        policy = loadRecoveryPolicy(assetRoot, opts.site);
      } catch {
        log('Ignoring invalid mcp-session-recovery.json. Existing tools are still available.');
      }
    }
    await runStdio(name, version, tools, assetRoot, policy);
  }
}

/**
 * Stdio transport. The SDK's StdioServerTransport just attaches data
 * listeners to process.stdin and returns; if we let runMcpServer resolve
 * here, cli.ts would call process.exit(0) and kill the server before any
 * client request arrived. Block until the transport closes (client EOFs
 * stdin) or we get SIGINT/SIGTERM.
 */
async function runStdio(
  name: string,
  version: string,
  tools: ResolvedTool[],
  assetRoot: string,
  policy?: RecoveryPolicy,
): Promise<void> {
  const { server, closeCdpPool } = buildServer(name, version, tools, assetRoot, policy);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`stdio transport ready (${tools.length} tool${tools.length === 1 ? '' : 's'})`);

  await new Promise<void>((resolve) => {
    const done = (reason: string): void => {
      log(`stdio transport closing: ${reason}`);
      resolve();
    };
    transport.onclose = () => done('client disconnected');
    process.once('SIGINT', () => done('SIGINT'));
    process.once('SIGTERM', () => done('SIGTERM'));
  });
  await closeCdpPool();
}

/**
 * Streamable HTTP transport. We construct a tiny Node http server ourselves
 * so we know exactly when the listen completes — fastmcp's wrapper has been
 * unreliable about that under Bun.
 *
 * One transport instance + one Server instance handle every request. POST
 * `/mcp` carries the JSON-RPC payload. The transport handles framing,
 * accept-header negotiation (json vs SSE), and session id management.
 */
async function runHttp(
  name: string,
  version: string,
  tools: ResolvedTool[],
  host: string,
  port: number,
  assetRoot: string,
): Promise<void> {
  const { server, closeCdpPool } = buildServer(name, version, tools, assetRoot);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/mcp')) {
      try {
        // The transport reads the body itself when we pass undefined as the
        // 3rd arg AND the request is a POST; for GET (SSE keep-alive) it
        // pumps the response stream.
        await transport.handleRequest(req, res);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: tools.length }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. POST /mcp for the MCP endpoint, GET /health for status.');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  log(`HTTP transport ready on http://${host}:${port}/mcp (health: /health)`);

  // Keep the process alive until SIGINT/SIGTERM. Without this, bun
  // sometimes exits even though the http server is listening.
  await new Promise<void>((resolve) => {
    const shutdown = (sig: NodeJS.Signals): void => {
      log(`received ${sig}, shutting down`);
      httpServer.close(() => resolve());
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
  await closeCdpPool();
}
