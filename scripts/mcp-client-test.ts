/**
 * Stdio MCP client smoke test. Spawns `imprint mcp-server echo` as a
 * child process, lists tools, and calls echo_test to exercise an async tool
 * implementation end-to-end. Mirrors mcp-http-client-test.ts so we can
 * confirm both transports behave identically.
 *
 *   bun scripts/mcp-client-test.ts
 */

import { resolve as pathResolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cliPath = pathResolve(import.meta.dir, '..', 'src', 'cli.ts');

console.log('[client] spawning imprint mcp-server (stdio, echo)…');
const transport = new StdioClientTransport({
  command: 'bun',
  args: [cliPath, 'mcp-server', 'echo'],
  cwd: pathResolve(import.meta.dir, '..'),
  env: { ...process.env, IMPRINT_HOME: pathResolve(import.meta.dir, '..', 'examples') },
  // Pipe stderr so we can attach our own listener and forward server logs.
  stderr: 'pipe',
});

const client = new Client({ name: 'imprint-stdio-test', version: '0.0.1' });
await client.connect(transport);
console.log('[client] connected');

const tStderr = transport.stderr;
if (tStderr) {
  tStderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[srv] ${chunk.toString('utf8')}`);
  });
}

console.log('[client] listing tools…');
const tools = await client.listTools();
console.log(`[client] ${tools.tools.length} tool(s):`);
for (const t of tools.tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

console.log('[client] calling echo_test…');
const result = await client.callTool({
  name: 'echo_test',
  arguments: { message: 'hello from stdio' },
});
console.log('[client] result:');
console.log(JSON.stringify(result, null, 2));

await client.close();
console.log('[client] done');
process.exit(0);
