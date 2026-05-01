/**
 * HTTP MCP client smoke test. Spawns the server as a subprocess on a random
 * high port, then drives it via the official Streamable HTTP client.
 */

import { spawn } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 49321;
const cliPath = pathResolve(import.meta.dir, '..', 'src', 'cli.ts');

console.log('[client] spawning HTTP MCP server…');
const proc = spawn(
  'bun',
  [cliPath, 'mcp-server', '--site', 'echo', '--http', '--port', String(PORT)],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: pathResolve(import.meta.dir, '..'),
  },
);

// Poll for the server to start accepting connections.
const baseUrl = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 5000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${baseUrl}/health`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    // not yet
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  console.error('[client] server never became ready');
  proc.kill();
  process.exit(1);
}
console.log('[client] server is up');

const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
const client = new Client({ name: 'imprint-http-test', version: '0.0.1' });
await client.connect(transport);
console.log('[client] connected');

const tools = await client.listTools();
console.log(`[client] ${tools.tools.length} tool(s):`);
for (const t of tools.tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

console.log('[client] calling echo_test…');
const result = await client.callTool({
  name: 'echo_test',
  arguments: { message: 'hello from http' },
});
console.log('[client] result:');
console.log(JSON.stringify(result, null, 2));

await client.close();
proc.kill();
process.exit(0);
