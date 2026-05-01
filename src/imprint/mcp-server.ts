/**
 * `imprint mcp-server <example>` — speak MCP stdio so Claude Desktop /
 * any MCP client can invoke the generated tool.
 *
 * Loads the generated module from `examples/<example>/index.ts`, builds a
 * Zod input schema from the workflow's `parameters`, and registers a single
 * MCP tool whose name matches `WORKFLOW.toolName`.
 *
 * Wire-up in Claude Desktop's claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "discoverandgo": {
 *         "command": "bun",
 *         "args": ["run", "/abs/path/to/imprint/src/cli.ts", "mcp-server", "discoverandgo"]
 *       }
 *     }
 *   }
 *
 * After restart, Claude Desktop will list `book_discoverandgo_museum_pass`
 * (or whatever the toolName is) under the MCP tools panel.
 */

import { resolve as pathResolve } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolResult, Workflow, WorkflowParameter } from './types.ts';

// CRITICAL: pick up the Web ReadableStream that cli.ts parked on globalThis
// at the very first line of the program. We then wrap it in a Node-style
// Readable here so the MCP SDK's StdioServerTransport (which uses .on('data'))
// works under Bun. Bun's process.stdin doesn't fire 'data' for piped input
// the way Node's does. See cli.ts header for the full explanation.
/**
 * Manual bridge: read chunks from Bun.stdin.stream() in a background loop
 * and forward them to a local Readable that the MCP transport subscribes
 * to. This is more robust than Readable.fromWeb because it preserves all
 * chunks even across the pause/resume transitions that happen as we add
 * listeners. The transport's data listener is added during server.connect();
 * any chunks read before then are buffered in the Readable until then.
 */
const STDIN_READER: Readable = (() => {
  const cached = (globalThis as unknown as { __imprintStdinStream?: ReadableStream<Uint8Array> })
    .__imprintStdinStream;
  if (!cached) return process.stdin as unknown as Readable;

  // PassThrough is a Readable+Writable that forwards what you write to it,
  // and properly emits 'data' events when listeners are attached. Cleaner
  // than rolling our own Readable subclass with a no-op read().
  const p = new PassThrough();

  // Background drain — read from the cached web stream and write into the
  // PassThrough. Listeners on p will receive the data.
  (async () => {
    try {
      const reader = cached.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          p.end();
          break;
        }
        if (value) p.write(Buffer.from(value));
      }
    } catch (err) {
      p.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return p;
})();

type GeneratedToolFn = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ToolResult>;

interface GeneratedModule {
  WORKFLOW: Workflow;
  // The function name is camelCase(toolName) — we discover it dynamically.
  [exportName: string]: unknown;
}

export interface RunMcpServerOptions {
  example: string;
  /** Override the generated module path (tests). */
  modulePath?: string;
}

/** Build a Zod raw shape from the workflow's parameter list. */
function buildInputSchema(parameters: WorkflowParameter[]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
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
    let withDescription = field.describe(p.description);
    if (p.default !== undefined) {
      withDescription = withDescription.optional();
    }
    shape[p.name] = withDescription;
  }
  return shape;
}

function findToolFunction(mod: GeneratedModule): GeneratedToolFn {
  // The codegen exports a function named camelCase(toolName).
  const toolName = mod.WORKFLOW.toolName;
  const camelName = toolName
    .split('_')
    .map((p, i) =>
      i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
    )
    .join('');
  const fn = mod[camelName];
  if (typeof fn !== 'function') {
    throw new Error(
      `Generated module is missing exported function "${camelName}" (derived from toolName "${toolName}"). Re-run \`imprint emit\`?`,
    );
  }
  return fn as GeneratedToolFn;
}

export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  const stdinReader = STDIN_READER;

  const modulePath = opts.modulePath ?? pathResolve('examples', opts.example, 'index.ts');
  const mod = (await import(modulePath)) as GeneratedModule;
  if (!mod.WORKFLOW) {
    throw new Error(`Generated module at ${modulePath} did not export WORKFLOW`);
  }
  const toolFn = findToolFunction(mod);
  const workflow = mod.WORKFLOW;

  // IMPORTANT: in MCP stdio mode, ALL non-protocol output must go to stderr.
  // stdout is reserved for the MCP framing. Console.log → stderr to be safe.
  const log = (msg: string): void => {
    process.stderr.write(`[imprint mcp] ${msg}\n`);
  };
  log(`starting MCP server for "${opts.example}" → tool "${workflow.toolName}"`);

  const server = new McpServer({
    name: `imprint-${opts.example}`,
    version: '0.1.0',
  });

  const inputShape = buildInputSchema(workflow.parameters);

  server.registerTool(
    workflow.toolName,
    {
      title: workflow.toolName,
      description: workflow.intent.description,
      inputSchema: inputShape,
    },
    async (args: Record<string, unknown>) => {
      const result = await toolFn(args);
      // MCP tool callbacks return { content: [...], isError? } shape.
      // We render the ToolResult as JSON in a single text block, and mark
      // isError on classified failure so the LLM knows it's a problem.
      return {
        isError: !result.ok,
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Debug: log every chunk seen on stdin (set IMPRINT_DEBUG to enable).
  if (process.env.IMPRINT_DEBUG) {
    stdinReader.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      process.stderr.write(`[stdin] ${s.length}B: ${s.slice(0, 120)}\n`);
    });
  }

  const transport = new StdioServerTransport(stdinReader, process.stdout);
  await server.connect(transport);
  log('connected. waiting for requests on stdio.');
}
