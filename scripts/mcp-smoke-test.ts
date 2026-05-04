/**
 * Smoke test: act as an MCP client, talk to our own MCP server over stdio,
 * verify it lists the tool and (optionally) calls it.
 */

import { spawn } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';

const cliPath = pathResolve(import.meta.dir, '..', 'src', 'cli.ts');
// Use the bundled echo fixture so this works on any clean checkout
// without needing a generated tool. Override with --site=<name> via env if needed.
const site = process.env.IMPRINT_SMOKE_SITE ?? 'echo';
const proc = spawn('bun', [cliPath, 'mcp-server', site], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, IMPRINT_DEBUG: '1' },
});

const responses: unknown[] = [];
let buffer = '';
proc.stdout.on('data', (chunk: Buffer) => {
  process.stderr.write(`[client got ${chunk.length}B from child]\n`);
  buffer += chunk.toString('utf8');
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        console.error('non-json line:', line);
      }
    }
  }
});

const send = (msg: object): void => {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
};

const waitFor = async (matchId: number, timeoutMs = 5000): Promise<unknown> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = responses.find((r) => (r as { id?: number }).id === matchId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for id=${matchId}; got ${JSON.stringify(responses)}`);
};

// Wait for the child to fully boot before sending.
await new Promise((resolve) => setTimeout(resolve, 1500));
console.error('[client sending initialize]');

// 1. initialize
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'imprint-smoke', version: '0.0.1' },
  },
});
const initResp = await waitFor(1);
console.log('initialize:', JSON.stringify(initResp));

// 2. notifications/initialized
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// 3. tools/list
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const listResp = await waitFor(2);
console.log('tools/list:', JSON.stringify(listResp, null, 2));

proc.kill();
process.exit(0);
