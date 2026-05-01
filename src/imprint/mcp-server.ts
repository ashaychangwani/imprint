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

import { existsSync, readdirSync, statSync } from 'node:fs';
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
import { z } from 'zod';
import type { ToolResult, Workflow, WorkflowParameter } from './types.ts';

type GeneratedToolFn = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ToolResult>;

interface GeneratedModule {
  WORKFLOW: Workflow;
  [exportName: string]: unknown;
}

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

interface ResolvedTool {
  site: string;
  workflow: Workflow;
  toolFn: GeneratedToolFn;
  /** JSON Schema for the tool's input — built from workflow.parameters. */
  inputSchema: Tool['inputSchema'];
}

/**
 * Discover every example directory containing a generated index.ts.
 * Each match is dynamically imported to extract its WORKFLOW + tool function.
 */
async function discoverTools(examplesDir: string, only?: string): Promise<ResolvedTool[]> {
  if (!existsSync(examplesDir)) return [];
  const entries = readdirSync(examplesDir);
  const out: ResolvedTool[] = [];
  for (const entry of entries) {
    if (only && entry !== only) continue;
    const dir = pathResolve(examplesDir, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const modulePath = pathResolve(dir, 'index.ts');
    if (!existsSync(modulePath)) continue;

    let mod: GeneratedModule;
    try {
      mod = (await import(modulePath)) as GeneratedModule;
    } catch (err) {
      process.stderr.write(
        `[imprint mcp] skipping ${entry}: failed to load (${err instanceof Error ? err.message : String(err)})\n`,
      );
      continue;
    }
    if (!mod.WORKFLOW) {
      process.stderr.write(`[imprint mcp] skipping ${entry}: missing WORKFLOW export\n`);
      continue;
    }
    const fn = findToolFunction(mod);
    if (!fn) {
      process.stderr.write(
        `[imprint mcp] skipping ${entry}: missing exported function for "${mod.WORKFLOW.toolName}"\n`,
      );
      continue;
    }
    out.push({
      site: entry,
      workflow: mod.WORKFLOW,
      toolFn: fn,
      inputSchema: buildJsonSchema(mod.WORKFLOW.parameters),
    });
  }
  return out;
}

function findToolFunction(mod: GeneratedModule): GeneratedToolFn | null {
  const camelName = mod.WORKFLOW.toolName
    .split('_')
    .map((p, i) =>
      i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join('');
  const fn = mod[camelName];
  return typeof fn === 'function' ? (fn as GeneratedToolFn) : null;
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

/**
 * Tighten the input shape with Zod after the LLM provides arguments. This
 * gives us friendly validation errors and type narrowing in the execute
 * callback.
 */
function buildZodValidator(parameters: WorkflowParameter[]): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const p of parameters) {
    let field: z.ZodType;
    switch (p.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
    }
    field = field.describe(p.description);
    if (p.default !== undefined) field = field.optional();
    shape[p.name] = field;
  }
  return z.object(shape);
}

const log = (msg: string): void => {
  process.stderr.write(`[imprint mcp] ${msg}\n`);
};

/** Build the MCP Server with all discovered tools registered. */
function buildServer(name: string, version: string, tools: ResolvedTool[]): Server {
  const server = new Server(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions:
        'Imprint runs deterministic workflows captured from real browser sessions. Each tool corresponds to one captured site. Call it with the documented parameters and the workflow will execute against the live site using stored credentials. If a call returns AUTH_EXPIRED, the user needs to re-run `imprint login <site>`.',
    },
  );

  const validators = new Map(
    tools.map((t) => [t.workflow.toolName, buildZodValidator(t.workflow.parameters)] as const),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.workflow.toolName,
      description: t.workflow.intent.description,
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
    const args = (parsed?.data ?? req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await tool.toolFn(args);
      if (!result.ok) {
        const text = result.remediation
          ? `[${result.error}] ${result.message}\n  → ${result.remediation}`
          : `[${result.error}] ${result.message}`;
        return { isError: true, content: [{ type: 'text', text }] };
      }
      const text =
        typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `[INTERNAL] ${msg}` }] };
    }
  });

  return server;
}

export async function runMcpServer(opts: RunMcpServerOptions = {}): Promise<void> {
  const examplesDir = opts.examplesDir ?? pathResolve(process.cwd(), 'examples');
  const tools = await discoverTools(examplesDir, opts.site);
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
  }

  if (opts.http) {
    const port = opts.port ?? 8765;
    const host = opts.host ?? '127.0.0.1';
    await runHttp(name, version, tools, host, port);
  } else {
    await runStdio(name, version, tools);
  }
}

/**
 * Stdio transport. The SDK's StdioServerTransport just attaches data
 * listeners to process.stdin and returns; if we let runMcpServer resolve
 * here, cli.ts would call process.exit(0) and kill the server before any
 * client request arrived. Block until the transport closes (client EOFs
 * stdin) or we get SIGINT/SIGTERM.
 */
async function runStdio(name: string, version: string, tools: ResolvedTool[]): Promise<void> {
  const server = buildServer(name, version, tools);
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
): Promise<void> {
  const server = buildServer(name, version, tools);
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
