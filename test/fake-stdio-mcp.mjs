// A stand-in for a local (stdio) MCP server such as `uvx central-mcp-server`.
// It refuses the read tool unless FAKE_TOKEN reached its environment, and logs every tool call to FAKE_STATS_FILE.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const [readTool, writeTool] = process.argv.slice(2);
const log = (name) => process.env.FAKE_STATS_FILE && appendFileSync(process.env.FAKE_STATS_FILE, `${name}\n`);

const server = new McpServer({ name: 'fake-stdio', version: '1.0.0' });
server.registerTool(readTool, { description: 'Read-only lookup' }, async () => {
  if (process.env.FAKE_TOKEN !== 'stdio-secret') {
    log(`${readTool}:no-env`);
    return { isError: true, content: [{ type: 'text', text: 'FAKE_TOKEN did not reach the server environment' }] };
  }
  log(readTool);
  return { content: [{ type: 'text', text: 'alerts: 2, devices: 12' }] };
});
server.registerTool(writeTool, { description: 'Destructive action' }, async () => {
  log(writeTool);
  return { content: [{ type: 'text', text: 'port bounced' }] };
});
await server.connect(new StdioServerTransport());
