import type { Domain } from './types.js';

// Read ./.env if there is one, so `npm run check`, `npm start` and `npm run dev` all see the same settings.
// Variables that are already set in the environment win over the file. Tests turn this off (A2A_NO_DOTENV=1).
if (process.env.A2A_NO_DOTENV !== '1') {
  try {
    process.loadEnvFile('.env');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

const env = process.env;

function num(key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
}

function regex(key: string, fallback: RegExp): RegExp {
  const raw = env[key];
  if (!raw) return fallback;
  try {
    return new RegExp(raw);
  } catch {
    throw new Error(`${key} is not a valid regular expression: ${raw}`);
  }
}

/**
 * Only tools whose names look read-only are exposed to the agents by default
 * (get_*, list_*, search_*, find_*, including prefixed names like central_get_alerts).
 * Widen it per domain with MIST_TOOL_ALLOW / CENTRAL_TOOL_ALLOW if you are sure.
 */
export const DEFAULT_TOOL_ALLOW = /(^|_)(get|list|search|find)_/;

export type McpTransport = 'auto' | 'http' | 'sse' | 'stdio';

export interface DomainConfig {
  id: Domain;
  label: string;
  agentPort: number;
  agentUrl: string;
  /** Remote MCP server (http/sse/auto). */
  mcpUrl: string;
  /** Sent as "Authorization: Bearer <token>". */
  mcpToken: string;
  /** Extra headers for a remote MCP server, e.g. X-Mist-Base-URL. */
  mcpHeaders: Record<string, string>;
  /** Local MCP server started as a child process (stdio), e.g. `uvx ... central-mcp-server`. */
  mcpCommand: string;
  mcpArgs: string[];
  mcpEnv: Record<string, string>;
  /** "auto" (the default for a URL) tries Streamable HTTP, then SSE. */
  mcpTransport: McpTransport;
  toolAllow: RegExp;
}

/** Splits "a b c" on whitespace, or reads a JSON array when the value starts with "[". */
function words(key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    } catch {
      /* falls through to the error below */
    }
    throw new Error(`${key} looks like JSON but is not an array of strings`);
  }
  return raw.split(/\s+/);
}

/** Reads "Name<sep>value;Name2<sep>value2" into an object. Only the first separator in each pair counts. */
function pairs(key: string, sep: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (env[key] ?? '').split(';')) {
    if (!part.trim()) continue;
    const i = part.indexOf(sep);
    if (i <= 0) throw new Error(`${key}: expected Name${sep}value pairs separated by ";", got "${part.trim()}"`);
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function domain(id: Domain, label: string, defaultPort: number): DomainConfig {
  const P = id.toUpperCase();
  const command = env[`${P}_MCP_COMMAND`]?.trim() ?? '';
  const rawTransport = (env[`${P}_MCP_TRANSPORT`] ?? '').toLowerCase();
  if (rawTransport && !['auto', 'http', 'sse', 'stdio'].includes(rawTransport)) {
    throw new Error(`${P}_MCP_TRANSPORT must be "auto", "http", "sse" or "stdio"`);
  }
  const transport = (rawTransport && rawTransport !== 'auto' ? rawTransport : command ? 'stdio' : 'auto') as McpTransport;
  const agentPort = num(`${P}_AGENT_PORT`, defaultPort);
  return {
    id,
    label,
    agentPort,
    agentUrl: env[`${P}_AGENT_URL`] ?? `http://127.0.0.1:${agentPort}`,
    mcpUrl: env[`${P}_MCP_URL`] ?? '',
    mcpToken: env[`${P}_MCP_TOKEN`] ?? '',
    mcpHeaders: pairs(`${P}_MCP_HEADERS`, ':'),
    mcpCommand: command,
    mcpArgs: words(`${P}_MCP_ARGS`),
    mcpEnv: pairs(`${P}_MCP_ENV`, '='),
    mcpTransport: transport,
    toolAllow: regex(`${P}_TOOL_ALLOW`, DEFAULT_TOOL_ALLOW),
  };
}

/**
 * Which way the model is called:
 *  - "agent-sdk": through the Claude Agent SDK (Claude Code), signed in with a Claude plan (Pro/Max/...).
 *    No API key and no API billing. Meant for running on your own machine.
 *  - "api": the Messages API with ANTHROPIC_API_KEY (Claude Console billing).
 * Unset: "api" if ANTHROPIC_API_KEY is set, otherwise "agent-sdk".
 */
export type Engine = 'api' | 'agent-sdk';

function engine(): Engine {
  const raw = (env.ENGINE ?? '').toLowerCase();
  if (raw === 'api' || raw === 'agent-sdk') return raw;
  if (raw) throw new Error('ENGINE must be "agent-sdk" or "api"');
  return env.ANTHROPIC_API_KEY ? 'api' : 'agent-sdk';
}

export const config = {
  mock: env.MOCK === '1',
  engine: engine(),
  host: env.HOST ?? '127.0.0.1',
  port: num('PORT', 3000),
  /** Shared password for the dashboard (HTTP basic auth, any username). */
  password: env.DASHBOARD_PASSWORD ?? '',
  model: env.MODEL ?? 'claude-sonnet-5-5',
  maxToolCalls: num('MAX_TOOL_CALLS', 8),
  agentTimeoutMs: num('AGENT_TIMEOUT_MS', 120_000),
  maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 2),
  startAgents: env.START_AGENTS !== '0',
  agentHost: env.AGENT_HOST ?? '127.0.0.1',
  /** Mock mode only: pause between simulated steps, in ms. */
  mockStepMs: num('MOCK_STEP_MS', 1100),
  domains: {
    mist: domain('mist', 'Mist agent', 4101),
    central: domain('central', 'Central agent', 4102),
  } as Record<Domain, DomainConfig>,
};

export const DOMAINS: Domain[] = ['mist', 'central'];

/** Throws a readable error when a real (non-mock) run is missing required settings. */
export function assertRealModeConfig(opts: { domain?: Domain; mcp: boolean }): void {
  const problems: string[] = [];
  if (config.engine === 'api' && !env.ANTHROPIC_API_KEY) problems.push('ENGINE=api needs ANTHROPIC_API_KEY');
  if (opts.mcp) {
    for (const d of DOMAINS) {
      if (opts.domain && opts.domain !== d) continue;
      const c = config.domains[d];
      const D = d.toUpperCase();
      if (c.mcpTransport === 'stdio' ? !c.mcpCommand : !c.mcpUrl) {
        problems.push(c.mcpTransport === 'stdio' ? `${D}_MCP_COMMAND is not set` : `${D}_MCP_URL is not set (or set ${D}_MCP_COMMAND for a local stdio server)`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`Cannot run without MOCK=1: ${problems.join('; ')}`);
  }
}
