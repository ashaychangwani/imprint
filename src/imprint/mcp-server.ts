/**
 * `imprint mcp-server` — exposes every generated tool under
 * <IMPRINT_HOME>/<site>/ as an MCP tool. Stdio + Streamable HTTP transports.
 * See docs/getting-started.md for Claude Desktop / mcp-inspector wire-up.
 */

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
import { resolveLadder, runWithLadder } from './backend-ladder.ts';
import type { CdpBrowserFetch } from './cdp-browser-fetch.ts';
import { createLog } from './log.ts';
import { imprintHomeDir } from './paths.ts';
import { loadBackendsCacheStatus, persistRuntimeBackendsCache } from './probe-backends.ts';
import { checkSiteCredentialsReady } from './runtime.ts';
import { availableSitesHint } from './sites.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import {
  type ResolvedTool as DiscoveredTool,
  buildZodValidator,
  discoverTools,
} from './tool-loader.ts';
import type { ConcreteBackend, ToolResult, WorkflowParameter } from './types.ts';
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
}

interface ResolvedTool extends DiscoveredTool {
  inputSchema: Tool['inputSchema'];
  playbookPath?: string;
  /** Probe-cached ladder; runtime starts here instead of the default. */
  preferredOrder?: ConcreteBackend[];
}

/** Tool description shown to MCP clients. Includes the operator's
 *  recorded narration when present — surprisingly load-bearing for the
 *  LLM picking the right tool. */
function buildToolDescription(w: ResolvedTool['workflow']): string {
  const base = w.intent.description;
  const said = w.intent.userSaid?.trim();
  return said ? `${base}\n\nRecording context: "${said}"` : base;
}

/** MCP advertises tool input as JSON Schema; build it directly from
 *  workflow parameters rather than going through Zod. */
export function buildJsonSchema(
  parameters: WorkflowParameter[],
  opts?: { includeTwoFactorContext?: boolean },
): Tool['inputSchema'] {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const p of parameters) {
    // Producer-sourced token params: tell the orchestrating LLM where to mint the
    // value so it calls the producer once and reuses it, rather than fabricating
    // an opaque token (which the tool would reject).
    const description = p.sourcedFrom
      ? `${p.description} Obtain this value from the \`${p.sourcedFrom.tool}\` tool's \`${p.sourcedFrom.field}\` output — call \`${p.sourcedFrom.tool}\` first and reuse the value across calls (no need to re-fetch each time).`
      : p.description;
    properties[p.name] = { type: p.type, description };
    if (p.default === undefined) required.push(p.name);
  }
  // Auth 2FA bridge (stateless): on the second (submit_otp) call the caller
  // passes back the `twoFactorContext` object echoed verbatim in the prior
  // AWAITING_2FA result, so a login token captured on the first call is
  // available to the completion request. Never required (absent on initiate).
  if (opts?.includeTwoFactorContext) {
    properties.twoFactorContext = {
      type: 'object',
      description:
        'Only for the submit_otp call: pass back the `twoFactorContext` object returned verbatim in the previous AWAITING_2FA response.',
    };
  }
  return {
    type: 'object',
    properties,
    required: required.length ? required : undefined,
  };
}

const log = createLog('mcp');

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

/** Build the MCP Server with all discovered tools registered. */
function buildServer(
  name: string,
  version: string,
  tools: ResolvedTool[],
  assetRoot: string,
): { server: Server; closeCdpPool: () => Promise<void> } {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions:
        'Imprint runs deterministic workflows captured from real browser sessions. Tools prefer fetch API replay, may use gated fetch-bootstrap only for declared browser-minted state, then cdp-replay (API requests run inside a live trusted Chrome so a protected POST refreshes its anti-bot token between calls) for multi-step state-changing flows, then stealth-fetch for bot-defense state, and playbook only for full DOM interaction. Error codes: AUTH_EXPIRED (401, call authenticate_<site> if available or run `imprint login <site>`); AWAITING_2FA (2FA required — approve push / enter OTP then call again with action=complete); STATE_MISSING (required cookie/state was unavailable or ambiguous); FORBIDDEN (403); RATE_LIMITED (429, back off); BAD_RESPONSE (other 4xx/5xx); NETWORK (fetch failed); UNKNOWN (everything else).',
    },
  );

  const validators = new Map(
    tools.map((t) => [t.workflow.toolName, buildZodValidator(t.workflow.parameters)] as const),
  );

  // Per-site stealth-fetch cache so the ~12s bootstrap runs once per site.
  const stealthCache = new Map<string, StealthFetch>();

  // Per-site CDP browser pool: cdp-replay stores its live Chrome here after
  // the first successful call so subsequent calls reuse it (~2-5s vs ~33s).
  const cdpPool = new Map<string, CdpBrowserFetch>();
  const cdpIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const CDP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  // Per-tool memo of the winning backend for THIS server session. After the
  // first call discovers the right rung, later calls skip the doomed early ones
  // (e.g. southwest's ~80s fetch-bootstrap FORBIDDEN before cdp-replay wins). Its
  // lifetime is tied to `cdpPool`: the memoized cdp-replay is only cheap while
  // its Chrome is pooled, so a site's memo is evicted when that pool entry is
  // idle-closed (below) — otherwise the next call would start at a now-cold
  // cdp-replay and re-pay the ~33s relaunch.
  const winnerCache = new Map<string, ConcreteBackend>();

  // Browser-backed rungs share per-site state (CDP page/session, stealth token,
  // winner memo, and backend cache). Parallel MCP calls can race that state and
  // make Google Flights return fast empty result sets. Keep same-site execution
  // sequential while allowing unrelated sites to proceed independently.
  const siteExecutionQueues = new Map<string, Promise<void>>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.workflow.toolName,
      description: buildToolDescription(t.workflow),
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
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

    // Auth 2FA bridge (stateless): the validator strips unknown keys, so read the
    // echoed `twoFactorContext` from the raw arguments and seed it as initialState
    // so a token captured on the initiate call resolves on this submit_otp call.
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    const initialState =
      tool.workflow.toolKind === 'authenticate' &&
      rawArgs.twoFactorContext &&
      typeof rawArgs.twoFactorContext === 'object'
        ? (rawArgs.twoFactorContext as Record<string, unknown>)
        : undefined;

    try {
      return await runSerializedBySite(siteExecutionQueues, tool.site, async () => {
        // Audit-only pacing: when the audit harness sets IMPRINT_AUDIT_PACING_MS,
        // sleep before each actual workflow execution so same-site queued calls
        // stay spaced out instead of all waiting concurrently before the queue.
        // Unset in production -> no delay.
        const pacingMs = Number(process.env.IMPRINT_AUDIT_PACING_MS);
        if (Number.isFinite(pacingMs) && pacingMs > 0) {
          await new Promise((r) => setTimeout(r, pacingMs));
        }

        const ladder = resolveLadder('auto', tool.preferredOrder);
        const { result, usedBackend, attempts } = await runWithLadder(
          ladder,
          tool,
          args,
          assetRoot,
          stealthCache,
          {
            cdpPool,
            winnerCache,
            skipBootstrapSplice: Boolean(tool.preferredOrder?.length),
            initialState,
          },
        );
        // Reset the idle timer for this site's pooled Chrome.
        if (result.ok && usedBackend === 'cdp-replay' && cdpPool.has(tool.site)) {
          const prev = cdpIdleTimers.get(tool.site);
          if (prev) clearTimeout(prev);
          const timer = setTimeout(() => {
            const cf = cdpPool.get(tool.site);
            if (cf) {
              log(`closing idle CDP session for ${tool.site}`);
              cf.close().catch(() => {});
              cdpPool.delete(tool.site);
              cdpIdleTimers.delete(tool.site);
              // Drop this site's winner memo too: a memoized cdp-replay would now
              // point at a closed Chrome and re-pay the cold relaunch.
              for (const key of winnerCache.keys()) {
                if (key.startsWith(`${tool.site}:`)) winnerCache.delete(key);
              }
            }
          }, CDP_IDLE_TIMEOUT_MS);
          timer.unref();
          cdpIdleTimers.set(tool.site, timer);
        }
        if (!result.ok) {
          const text = formatToolError(result);
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
    for (const [site, cf] of cdpPool) {
      log(`shutdown: closing CDP session for ${site}`);
      await cf.close().catch(() => {});
    }
    cdpPool.clear();
    for (const timer of cdpIdleTimers.values()) clearTimeout(timer);
    cdpIdleTimers.clear();
    winnerCache.clear();
  }

  return { server, closeCdpPool };
}

function formatToolError(result: Extract<ToolResult, { ok: false }>): string {
  const lines = [`[${result.error}] ${result.message}`];
  if (result.error === 'STATE_MISSING' && result.missing?.length) {
    for (const item of result.missing) {
      lines.push(
        `  - ${item.name}: ${item.failure} (${item.capability})${item.message ? ` — ${item.message}` : ''}`,
      );
    }
  }
  // Auth 2FA bridge (stateless): echo the captured login context back to the
  // caller so it can pass it as `twoFactorContext` on the submit_otp call.
  if (result.error === 'AWAITING_2FA' && result.twoFactorContext) {
    lines.push(`  twoFactorContext: ${JSON.stringify(result.twoFactorContext)}`);
  }
  if (result.remediation) lines.push(`  → ${result.remediation}`);
  return lines.join('\n');
}

export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  const assetRoot = opts.assetRoot ?? imprintHomeDir();
  const discovered = await discoverTools(assetRoot, opts.site, '[imprint mcp]');
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
        includeTwoFactorContext: t.workflow.toolKind === 'authenticate',
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
    await runStdio(name, version, tools, assetRoot);
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
): Promise<void> {
  const { server, closeCdpPool } = buildServer(name, version, tools, assetRoot);
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
