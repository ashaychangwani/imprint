/**
 * Smoke-test for the compile-time MCP server. Spawns
 * `imprint __mcp-compile-server` as a child, lists tools, calls
 * read_session_summary with the southwest-seats fixture, and prints results.
 *
 *   bun scripts/mcp-compile-client-test.ts
 */

import { resolve as pathResolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cliPath = pathResolve(import.meta.dir, '..', 'src', 'cli.ts');
const repoRoot = pathResolve(import.meta.dir, '..');
const sessionPath = pathResolve(
  repoRoot,
  'examples/southwest-seats/sessions/2026-05-06T07-20-10-599Z.redacted.json',
);
const exampleDir = pathResolve(repoRoot, 'examples/southwest-seats');

console.log('[client] spawning imprint __mcp-compile-server (stdio)…');
const transport = new StdioClientTransport({
  command: 'bun',
  args: [
    'run',
    cliPath,
    '__mcp-compile-server',
    '--session-path',
    sessionPath,
    '--example-dir',
    exampleDir,
  ],
  cwd: repoRoot,
  stderr: 'pipe',
});

const client = new Client({ name: 'imprint-compile-test', version: '0.0.1' });
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
  console.log(`  - ${t.name}: ${(t.description ?? '').slice(0, 80)}`);
}

console.log('\n[client] calling read_session_summary…');
const summary = await client.callTool({
  name: 'read_session_summary',
  arguments: {},
});
const summaryText =
  summary.content && Array.isArray(summary.content) && summary.content[0]
    ? (summary.content[0] as { text?: string }).text ?? ''
    : '';
const parsed = summaryText ? JSON.parse(summaryText) : {};
console.log(`[client] site=${parsed.site}, requestCount=${parsed.requestCount}`);
console.log(`[client] narration: ${(parsed.narration ?? []).length} entries`);
console.log(`[client] load-bearing requests: ${(parsed.loadBearingRequests ?? []).length}`);
if (parsed.loadBearingRequests && parsed.loadBearingRequests[0]) {
  const r = parsed.loadBearingRequests[0];
  console.log(`  first: seq=${r.seq} ${r.method} ${r.url.slice(0, 70)}`);
}

console.log('\n[client] calling done with no artifacts (expect verification failure)…');
const doneRes = await client.callTool({
  name: 'done',
  arguments: { summary: 'smoke test — no actual work done' },
});
const doneText =
  doneRes.content && Array.isArray(doneRes.content) && doneRes.content[0]
    ? (doneRes.content[0] as { text?: string }).text ?? ''
    : '';
console.log(`[client] done isError: ${doneRes.isError}`);
console.log(`[client] done text (first 300 chars): ${doneText.slice(0, 300)}`);

await client.close();
console.log('\n[client] done');
process.exit(0);
