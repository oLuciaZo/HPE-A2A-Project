import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { DomainConfig } from './config.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpKind = 'http' | 'sse' | 'stdio';

export interface McpSession {
  /** How we actually connected (the Agent SDK is given the same kind). */
  transport: McpKind;
  /** Tools that passed the read-only allowlist: the only ones a model may see or call. */
  tools: ToolDef[];
  /** Names the server lists that the allowlist filtered out (kept for display and for the Agent SDK deny list). */
  blocked: string[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Headers for a remote MCP server (shared by our own client and the Agent SDK's MCP config). */
export function mcpHeaders(cfg: DomainConfig): Record<string, string> {
  return { ...(cfg.mcpToken ? { Authorization: `Bearer ${cfg.mcpToken}` } : {}), ...cfg.mcpHeaders };
}

function makeTransport(cfg: DomainConfig, kind: McpKind): Transport {
  if (kind === 'stdio') {
    if (!cfg.mcpCommand) throw new Error(`${cfg.id.toUpperCase()}_MCP_COMMAND is not set`);
    return new StdioClientTransport({
      command: cfg.mcpCommand,
      args: cfg.mcpArgs,
      // Only a safe base (PATH, HOME, ...) plus what you listed in *_MCP_ENV: the other platform's secrets stay out.
      env: { ...getDefaultEnvironment(), ...cfg.mcpEnv },
      stderr: process.env.DEBUG_SDK === '1' ? 'inherit' : 'ignore',
    });
  }
  if (!cfg.mcpUrl) throw new Error(`${cfg.id.toUpperCase()}_MCP_URL is not set`);
  const headers = mcpHeaders(cfg);
  const url = new URL(cfg.mcpUrl);
  return kind === 'sse'
    ? new SSEClientTransport(url, {
        requestInit: { headers },
        // The SSE stream itself is opened by EventSource, which needs the headers too.
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
        },
      } as ConstructorParameters<typeof SSEClientTransport>[1])
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/**
 * Connects to a remote MCP server and exposes only the tools that match the
 * allowlist. The allowlist is enforced again at call time, so a tool the model
 * invents (or that was filtered out) can never be executed.
 */
export async function connectMcp(cfg: DomainConfig, opts: { allowEmpty?: boolean } = {}): Promise<McpSession> {
  // "auto" (a URL with no explicit transport) tries Streamable HTTP first, then SSE.
  const kinds: McpKind[] = cfg.mcpTransport === 'auto' ? ['http', 'sse'] : [cfg.mcpTransport];
  let client: Client | undefined;
  let used: McpKind = kinds[0];
  const errors: string[] = [];
  for (const kind of kinds) {
    const c = new Client({ name: `a2a-twin-${cfg.id}`, version: '0.1.0' });
    try {
      await c.connect(makeTransport(cfg, kind));
      client = c;
      used = kind;
      break;
    } catch (e) {
      errors.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
      await c.close().catch(() => undefined);
    }
  }
  if (!client) throw new Error(kinds.length > 1 ? `could not connect (${errors.join(' | ')})` : errors[0]);

  const listed = await client.listTools();
  const tools: ToolDef[] = listed.tools
    .filter((t) => cfg.toolAllow.test(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

  const blocked = listed.tools.filter((t) => !cfg.toolAllow.test(t.name)).map((t) => t.name);

  if (tools.length === 0 && !opts.allowEmpty) {
    await client.close();
    throw new Error(
      `${cfg.id}: the MCP server exposes ${listed.tools.length} tools but none match the read-only allowlist (${cfg.toolAllow})`,
    );
  }

  const allowed = new Set(tools.map((t) => t.name));

  return {
    transport: used,
    tools,
    blocked,
    async call(name, args) {
      if (!allowed.has(name)) throw new Error(`Tool "${name}" is not on the read-only allowlist`);
      const res = await client.callTool({ name, arguments: args });
      const parts = Array.isArray(res.content) ? (res.content as { type: string; text?: string }[]) : [];
      const text = parts.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content omitted]`)).join('\n');
      if (res.isError) throw new Error(text || 'The tool reported an error');
      return text;
    },
    close: () => client.close(),
  };
}
