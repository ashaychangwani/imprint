import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 't', version: '0.0.1' });
server.registerTool('echo', { description: 'echo', inputSchema: { msg: z.string() } }, async (args) => ({
  content: [{ type: 'text', text: 'echo: ' + JSON.stringify(args) }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('connected\n');
