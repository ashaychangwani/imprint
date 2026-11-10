/** Stdio adapter for the provider-neutral compiler tool executor. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { inheritedCompileProviderControl } from './compile-provider-control.ts';
import {
  type CompileToolExecutorOptions,
  createCompileToolExecutor,
} from './compile-tool-executor.ts';
import { terminateOwnedCompilerProcesses } from './compiler-process.ts';
import { createLog } from './log.ts';
export {
  COMPILE_SENTINELS,
  canWaiveIrreversibleLiveVerification,
  compileDoneToolDescription,
} from './compile-tool-executor.ts';
const log = createLog('mcp-compile');

export async function runCompileMcpServer(opts: CompileToolExecutorOptions): Promise<void> {
  const providerControl = inheritedCompileProviderControl();
  const executor = createCompileToolExecutor(opts, { providerControl });
  const server = new Server(
    { name: 'imprint-compile', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: executor.instructions,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: executor.tools }));
  server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
    executor.callTool(req.params.name, req.params.arguments, extra.signal),
  );
  const transport = new StdioServerTransport();
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let closing = false;
  const close = (reason: string): void => {
    if (closing) return;
    closing = true;
    log(`closing: ${reason}`);
    settle();
    void server.close().catch(() => undefined);
  };
  const inputEnded = () => close('client input ended');
  const outputEnded = () => close('response channel ended');
  const protocolError = () => close('protocol or channel error');
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = () => close(`received ${signal}`);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  server.onclose = () => close('client disconnected');
  server.onerror = protocolError;
  process.stdin.once('end', inputEnded);
  process.stdin.once('error', protocolError);
  process.stdout.once('finish', outputEnded);
  process.stdout.once('close', outputEnded);
  process.stdout.once('error', protocolError);
  try {
    await server.connect(transport);
    log(`stdio transport ready (${executor.tools.length} tools)`);
    await closed;
  } finally {
    process.stdin.removeListener('end', inputEnded);
    process.stdin.removeListener('error', protocolError);
    process.stdout.removeListener('finish', outputEnded);
    process.stdout.removeListener('close', outputEnded);
    process.stdout.removeListener('error', protocolError);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    server.onclose = undefined;
    await server.close().catch(() => undefined);
    await terminateOwnedCompilerProcesses('SIGINT');
    await executor.close();
    providerControl?.dispose();
  }
}
