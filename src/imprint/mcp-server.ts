/**
 * `imprint mcp-server` — exposes every generated workflow under
 * `examples/<site>/index.ts` as an MCP tool.
 *
 * Built directly on the official @modelcontextprotocol/sdk for maximum
 * compatibility with every MCP client (Claude Desktop, Claude Code, Cursor,
 * Continue.dev, mcp-inspector, etc.). Supports stdio (the canonical
 * transport for desktop clients) and Streamable HTTP (the modern transport
 * for remote agents).
 *
 * USAGE:
 *
 *   imprint mcp-server                         # all examples, stdio (default)
 *   imprint mcp-server --site discoverandgo    # one site only
 *   imprint mcp-server --http --port 8765      # Streamable HTTP transport
 *
 * Claude Desktop wire-up
 * (~/Library/Application Support/Claude/claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "imprint": {
 *         "command": "bun",
 *         "args": ["run", "/abs/path/to/imprint/src/cli.ts", "mcp-server"]
 *       }
 *     }
 *   }
 *
 * Restart Claude Desktop. Your tools (e.g. `book_discoverandgo_museum_pass`)
 * will appear in the MCP tools panel.
 *
 * mcp-inspector wire-up:
 *
 *   npx @modelcontextprotocol/inspector bun run src/cli.ts mcp-server
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
import {
  type ResolvedTool as DiscoveredTool,
  buildZodValidator,
  discoverTools,
} from './discover-tools.ts';
import { type BackendContext, ladderFor, runWithLadder } from './replay-backend.ts';
import type { StealthFetch } from './stealth-fetch.ts';
import type { WorkflowParameter } from './types.ts';

export interface RunMcpServerOptions {
  /** Restrict to one example. Otherwise every generated example is registered. */
  site?: string;
  /** Override examples directory. Defaults to <cwd>/examples. */
  examplesDir?: string;
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

/** A discovered tool decorated with the JSON Schema MCP advertises it as. */
interface ResolvedTool extends DiscoveredTool {
  inputSchema: Tool['inputSchema'];
  /** Path to playbook.md when one exists alongside index.ts. */
  playbookPath?: string;
}

/**
 * Build a JSON Schema for the tool's input from our workflow parameters.
 * MCP advertises tools using JSON Schema directly (it's an LLM-facing
 * description), so we generate it inline rather than going through Zod.
 */
function buildJsonSchema(parameters: WorkflowParameter[]): Tool['inputSchema'] {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const p of parameters) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.default === undefined) required.push(p.name);
  }
  return {
    type: 'object',
    properties,
    required: required.length ? required : undefined,
  };
}

const log = (msg: string): void => {
  process.stderr.write(`[imprint mcp] ${msg}\n`);
};

/** Build the MCP Server with all discovered tools registered. */
function buildServer(
  name: string,
  version: string,
  tools: ResolvedTool[],
  examplesDir: string,
): Server {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions:
        'Imprint runs deterministic workflows captured from real browser sessions. Each tool routes through fetch → stealth-fetch → playbook automatically — the cheap path is tried first; bot-protected sites escalate to slower paths. Error codes: AUTH_EXPIRED (401, run `imprint login <site>`); FORBIDDEN (403, all backends in the ladder failed — site needs a paid stealth provider or is fundamentally unscrapable); RATE_LIMITED (429, back off); BAD_RESPONSE (other 4xx/5xx); NETWORK (fetch failed); UNKNOWN (everything else).',
    },
  );

  const validators = new Map(
    tools.map((t) => [t.workflow.toolName, buildZodValidator(t.workflow.parameters)] as const),
  );

  // One StealthFetch instance per site, lazily created on first use,
  // reused across MCP calls in this process. Pays the ~12s bootstrap
  // once per site rather than per call.
  const stealthCache = new Map<string, StealthFetch>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.workflow.toolName,
      description: `${t.workflow.intent.description} — auto-routes through fetch / stealth-fetch / playbook depending on what works for this site.`,
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

    try {
      const ctx: BackendContext = {
        tool,
        params: args,
        examplesDir,
        stealthCache,
      };
      const { result, usedBackend } = await runWithLadder(ladderFor('auto'), ctx);
      if (!result.ok) {
        const text = result.remediation
          ? `[${result.error}] ${result.message}\n  → ${result.remediation}`
          : `[${result.error}] ${result.message}`;
        return {
          isError: true,
          content: [{ type: 'text', text: `${text}\n(backend: ${usedBackend})` }],
        };
      }
      const text =
        typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      return { content: [{ type: 'text', text: `${text}\n\n(backend: ${usedBackend})` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `[INTERNAL] ${msg}` }] };
    }
  });

  return server;
}

export async function runMcpServer(opts: RunMcpServerOptions = {}): Promise<void> {
  const examplesDir = opts.examplesDir ?? pathResolve(process.cwd(), 'examples');
  const discovered = await discoverTools(examplesDir, opts.site, '[imprint mcp]');
  const tools: ResolvedTool[] = discovered.map((t) => {
    const playbookPath = pathResolve(examplesDir, t.site, 'playbook.md');
    return {
      ...t,
      inputSchema: buildJsonSchema(t.workflow.parameters),
      playbookPath: existsSync(playbookPath) ? playbookPath : undefined,
    };
  });
  if (tools.length === 0) {
    const target = opts.site ? `for site "${opts.site}"` : `under ${examplesDir}`;
    throw new Error(
      `No generated tools found ${target}. Run \`imprint emit examples/<site>/workflow.json\` first.`,
    );
  }

  const name = opts.name ?? 'imprint';
  const version = opts.version ?? '0.1.0';

  for (const t of tools) {
    log(`registered ${t.workflow.toolName} (${t.site}) — ${t.workflow.parameters.length} param(s)`);
    if (t.playbookPath) {
      log(`  + ${t.workflow.toolName}_via_browser (playbook fallback)`);
    }
  }

  if (opts.http) {
    const port = opts.port ?? 8765;
    const host = opts.host ?? '127.0.0.1';
    await runHttp(name, version, tools, host, port, examplesDir);
  } else {
    await runStdio(name, version, tools, examplesDir);
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
  examplesDir: string,
): Promise<void> {
  const server = buildServer(name, version, tools, examplesDir);
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
  examplesDir: string,
): Promise<void> {
  const server = buildServer(name, version, tools, examplesDir);
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
}
