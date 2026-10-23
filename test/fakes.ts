import type { Server } from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface FakeMcpStats {
  authedRequests: number;
  rejectedRequests: number;
  toolCalls: string[];
}

/**
 * A stand-in for a remote MCP server: one read-only tool and one destructive tool,
 * behind a bearer token. Used to prove the read-only allowlist and auth handling.
 */
export function startFakeMcp(port: number, readTool: string, writeTool: string, token: string, requiredHeader?: { name: string; value: string }) {
  const stats: FakeMcpStats = { authedRequests: 0, rejectedRequests: 0, toolCalls: [] };
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const headerOk = !requiredHeader || req.headers[requiredHeader.name.toLowerCase()] === requiredHeader.value;
    if (req.headers.authorization !== `Bearer ${token}` || !headerOk) {
      stats.rejectedRequests++;
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    stats.authedRequests++;
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    server.registerTool(readTool, { description: 'Read-only lookup' }, async () => {
      stats.toolCalls.push(readTool);
      return { content: [{ type: 'text' as const, text: 'sites: 3, aps: 41' }] };
    });
    server.registerTool(writeTool, { description: 'Destructive action' }, async () => {
      stats.toolCalls.push(writeTool);
      return { content: [{ type: 'text' as const, text: 'port bounced' }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const httpServer: Server = app.listen(port, '127.0.0.1');
  return { stats, close: () => httpServer.close() };
}

export interface SeenModelRequest {
  role: 'planner' | 'merger' | 'agent';
  toolNames: string[];
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Sends a Messages API reply as a server-sent event stream (what Claude Code asks for). */
function sendStream(res: express.Response, content: Block[], stop: 'end_turn' | 'tool_use') {
  res.setHeader('content-type', 'text/event-stream');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  content.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * A scripted stand-in for the Anthropic Messages API (point ANTHROPIC_BASE_URL at it).
 * Answers both plain JSON and streaming requests, so it works for the SDK client and for Claude Code.
 * `opts.burst`: the first agent turn asks for that many calls to the allowed tool at once (budget test).
 */
export function startFakeAnthropic(port: number, writeToolAttempt: string, opts: { burst?: number } = {}) {
  const seen: SeenModelRequest[] = [];
  /** Credentials each request arrived with, to prove which one the client used. */
  const credentials: { apiKey?: string; bearer?: string }[] = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/v1/messages', (req, res) => {
    credentials.push({
      apiKey: req.headers['x-api-key'] as string | undefined,
      bearer: (req.headers.authorization as string | undefined)?.replace(/^Bearer /, ''),
    });
    const system: string = typeof req.body.system === 'string' ? req.body.system : JSON.stringify(req.body.system);
    const tools: { name: string }[] = req.body.tools ?? [];
    const messages: { role: string; content: unknown }[] = req.body.messages ?? [];

    const reply = (content: Block[], stop: 'end_turn' | 'tool_use') => {
      if (req.body.stream) {
        sendStream(res, content, stop);
        return;
      }
      res.json({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    const text = (t: string): Block => ({ type: 'text', text: t });

    if (system.includes('orchestrator for network analyst agents')) {
      seen.push({ role: 'planner', toolNames: [] });
      reply([text(JSON.stringify({ agents: [{ id: 'mist', subtask: 'Check Mist sites' }, { id: 'central', subtask: 'Check Central sites' }] }))], 'end_turn');
      return;
    }
    if (system.includes('You merge reports')) {
      seen.push({ role: 'merger', toolNames: [] });
      reply([text(JSON.stringify({
        headline: 'merged headline',
        metrics: [{ label: 'APs', value: '41' }],
        findings: [{ source: 'both', severity: 'warning', text: 'merged finding' }],
        next: ['check merged finding'],
      }))], 'end_turn');
      return;
    }
    if (!system.includes('read-only network operations analyst')) {
      // Anything else (a login probe, Claude Code's own housekeeping calls): a trivial answer, not recorded.
      reply([text('OK')], 'end_turn');
      return;
    }

    seen.push({ role: 'agent', toolNames: tools.map((t) => t.name) });
    const hasToolResult = messages.some(
      (m) => m.role === 'user' && Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === 'tool_result'),
    );
    if (!hasToolResult) {
      // Claude Code names MCP tools mcp__<server>__<tool>; the plain API client uses the bare name.
      const prefix = tools[0].name.match(/^mcp__[^_]+__/)?.[0] ?? '';
      const allowed = Array.from({ length: opts.burst ?? 1 }, (_, i): Block => ({ type: 'tool_use', id: `tu_a${i}`, name: tools[0].name, input: {} }));
      // The "model" calls the allowed tool(s), and also tries a tool it was never offered.
      reply([...allowed, { type: 'tool_use', id: 'tu_w', name: prefix + writeToolAttempt, input: {} }], 'tool_use');
      return;
    }
    reply([text(JSON.stringify({
      summary: 'fake domain summary',
      findings: [{ severity: 'warning', text: 'AP-X looks unhealthy' }],
      metrics: [{ label: 'APs', value: '41' }],
    }))], 'end_turn');
  });

  const httpServer: Server = app.listen(port, '127.0.0.1');
  return { seen, credentials, close: () => httpServer.close() };
}
