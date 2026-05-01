import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Bridge stdin EARLY (before any await).
const bunStdin = (
  globalThis as unknown as { Bun: { stdin: { stream: () => ReadableStream<Uint8Array> } } }
).Bun.stdin.stream();
const r = Readable.fromWeb(bunStdin as unknown as Parameters<typeof Readable.fromWeb>[0]);

process.stderr.write('about to import generated module\n');
const modulePath = resolve(import.meta.dir, '..', 'examples', 'discoverandgo', 'index.ts');
const mod = await import(modulePath);
process.stderr.write(`imported, has WORKFLOW: ${!!(mod as { WORKFLOW?: unknown }).WORKFLOW}\n`);

r.on('data', (chunk: Buffer | string) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  process.stderr.write(`[stdin] ${s.length}B: ${s.slice(0, 100).trim()}\n`);
});

const server = new McpServer({ name: 't', version: '0.0.1' });
server.registerTool(
  'echo',
  { description: 'echo', inputSchema: { msg: z.string() } },
  async (args) => ({ content: [{ type: 'text', text: 'echo: ' + JSON.stringify(args) }] }),
);
const transport = new StdioServerTransport(r, process.stdout);
await server.connect(transport);
process.stderr.write('connected\n');
