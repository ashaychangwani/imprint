import type { ToolResult, Workflow } from '../../../src/imprint/types.ts';

/**
 * Echo workflow — a network-free fixture for MCP smoke tests. Exercises the
 * full handler path (async tool with awaits, JSON-encoded result) without
 * depending on outbound HTTPS, which the stdio client transport strips env
 * for and may fail in restrictive environments (corporate MITM, no
 * NODE_EXTRA_CA_CERTS passthrough).
 */
export const WORKFLOW: Workflow = {
  toolName: 'echo_test',
  intent: { description: 'Echo back a message after a tiny async tick.' },
  parameters: [
    {
      name: 'message',
      type: 'string',
      description: 'The text to echo back.',
    },
  ],
  requests: [],
  site: 'echo',
};

export async function echoTest(input: { message: string }): Promise<ToolResult> {
  process.stderr.write(`[echo] received: ${input.message}\n`);
  // Force a real microtask + macrotask boundary so we'd notice if the
  // transport closed mid-handler (the original fastmcp/bun failure mode).
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  return { ok: true, data: { echoed: input.message, ts: new Date().toISOString() } };
}
