/**
 * Model calls through the Claude Agent SDK (the Claude Code engine), signed in with a Claude plan.
 *
 * Why this exists: a Pro/Max plan does not include API credits, but the Agent SDK can run on the
 * plan's own usage limits when Claude Code is signed in (`claude` -> /login, or CLAUDE_CODE_OAUTH_TOKEN).
 * Meant for running on your own machine, with your own login. Do not point other people at it.
 *
 * Safety is the same as the API engine, enforced twice:
 *  1. the model is only told about allowlisted MCP tools (everything else is on the deny list, and all
 *     built-in tools such as Bash and Read are switched off), and
 *  2. a PreToolUse hook re-checks every call against the allowlist and the call budget.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  query,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { config, type DomainConfig } from './config.js';
import { mcpHeaders, type McpSession } from './mcp.js';
import type { DomainResult, ToolEventMeta } from './types.js';

export class SdkError extends Error {}

let sandbox: string | undefined;
/** An empty scratch directory, so no project CLAUDE.md, skills or settings can leak into a session. */
const workdir = () => (sandbox ??= mkdtempSync(join(tmpdir(), 'a2a-twin-')));

/**
 * The environment for the Claude Code process. API keys are removed on purpose: if one is present Claude Code
 * prefers it over the plan login, which would bill the API instead of using the plan.
 * Set AGENT_SDK_ALLOW_API_KEY=1 to keep them (tests do this against a local fake).
 */
function sdkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (process.env.AGENT_SDK_ALLOW_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'a2a-twin/0.1.0';
  return env;
}

const LOGIN_HINT =
  'Claude Code ยังไม่ได้ login หรือ login หมดอายุ: เปิด terminal พิมพ์ `claude` แล้วใช้ /login ' +
  '(หรือรัน `claude setup-token` แล้วตั้งค่า CLAUDE_CODE_OAUTH_TOKEN) จากนั้นรัน `npm run check`';

/** Turns a Claude Code error code into something a person can act on. */
function explain(code: string | undefined, detail: string): string {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'verification_required':
      return `${LOGIN_HINT} (${detail || code})`;
    case 'rate_limit':
      return `โควตาของแผนสมาชิกเต็มชั่วคราว (rate limit) รอสักพักแล้วลองใหม่ หรือถามให้แคบลง (${detail || code})`;
    case 'billing_error':
    case 'account_on_hold':
      return `บัญชี Claude มีปัญหาเรื่อง billing หรือถูกระงับ ตรวจที่ claude.ai (${detail || code})`;
    case 'overloaded':
      return `โมเดลมีคนใช้เยอะ ลองใหม่อีกครั้ง (${detail || code})`;
    case 'model_not_found':
      return `บัญชีนี้ใช้โมเดล "${config.model}" ไม่ได้ ลองตั้ง MODEL=sonnet (${detail || code})`;
    default:
      return detail || code || 'Claude Code failed without an error message';
  }
}

interface DrainHooks {
  onInit?(init: SDKSystemMessage): void;
  onToolUse?(id: string, name: string, input: unknown): void;
  onToolResult?(id: string, isError: boolean, chars: number): void;
}

interface Drained {
  text: string;
  init?: SDKSystemMessage;
}

type Block = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown };

const textLength = (content: unknown): number => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n, c) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0);
  return 0;
};

/** Reads a Claude Code message stream to the end and returns the final text. Throws SdkError on failure. */
async function drain(q: Query, h: DrainHooks): Promise<Drained> {
  let init: SDKSystemMessage | undefined;
  let errorCode: string | undefined;

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      init = msg;
      h.onInit?.(msg);
    } else if (msg.type === 'assistant') {
      if (msg.error) errorCode = msg.error;
      for (const b of msg.message.content as Block[]) {
        if (b.type === 'tool_use' && b.id && b.name) h.onToolUse?.(b.id, b.name, b.input);
      }
    } else if (msg.type === 'user') {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b.type === 'tool_result' && b.tool_use_id) h.onToolResult?.(b.tool_use_id, !!b.is_error, textLength(b.content));
        }
      }
    } else if (msg.type === 'result') {
      if (msg.subtype !== 'success') {
        const why = msg.subtype === 'error_max_turns' ? 'ใช้จำนวนรอบสูงสุดแล้วโดยยังไม่ได้คำตอบ' : msg.subtype;
        throw new SdkError(explain(errorCode, why));
      }
      if (msg.is_error) throw new SdkError(explain(errorCode, msg.result));
      return { text: msg.result, init };
    }
  }
  throw new SdkError(explain(errorCode, 'Claude Code ended without a result'));
}

function base(extra: Options): Options {
  return {
    model: config.model,
    cwd: workdir(),
    env: sdkEnv(),
    settingSources: [], // no user/project settings, hooks, skills or CLAUDE.md
    persistSession: false, // do not write transcripts into ~/.claude
    strictMcpConfig: true, // ignore every MCP server except the ones we pass
    permissionMode: 'dontAsk', // anything not pre-approved is denied, never prompted
    stderr: (d) => {
      if (process.env.DEBUG_SDK === '1') console.error('[claude-code]', d.trimEnd());
    },
    ...extra,
  };
}

/** Wraps an AbortSignal and a deadline into the AbortController the SDK wants. */
function controller(signal: AbortSignal | undefined, timeoutMs: number): { ac: AbortController; done: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new SdkError(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    ac,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** One model call with no tools (planner and merger). */
export async function sdkComplete(system: string, user: string): Promise<string> {
  const { ac, done } = controller(undefined, config.agentTimeoutMs);
  const q = query({
    prompt: user,
    options: base({ systemPrompt: system, tools: [], mcpServers: {}, maxTurns: 1, abortController: ac }),
  });
  try {
    return (await drain(q, {})).text;
  } catch (e) {
    throw ac.signal.aborted && ac.signal.reason instanceof SdkError ? ac.signal.reason : e;
  } finally {
    done();
    q.close();
  }
}

export interface AgentRun {
  cfg: DomainConfig;
  session: McpSession;
  system: string;
  question: string;
  signal: AbortSignal;
  onTool: (m: Omit<ToolEventMeta, 'kind'>) => void;
}

const shortArgs = (input: unknown) => {
  const s = JSON.stringify(input ?? {});
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

/** A domain agent's tool loop, run by Claude Code against the domain's remote MCP server. */
export async function sdkRunAgent(a: AgentRun): Promise<{ text: string; toolCalls: DomainResult['toolCalls'] }> {
  const { cfg, session } = a;
  const prefix = `mcp__${cfg.id}__`;
  const short = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

  // Hand Claude Code the same kind of connection that already worked for our own client.
  const headers = mcpHeaders(cfg);
  const server: McpServerConfig =
    session.transport === 'stdio'
      ? { type: 'stdio', command: cfg.mcpCommand, args: cfg.mcpArgs, env: cfg.mcpEnv, alwaysLoad: true }
      : session.transport === 'sse'
        ? { type: 'sse', url: cfg.mcpUrl, headers, alwaysLoad: true }
        : { type: 'http', url: cfg.mcpUrl, headers, alwaysLoad: true };

  let calls = 0;
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  });
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const name = input.tool_name;
    if (!name.startsWith(prefix) || !cfg.toolAllow.test(name.slice(prefix.length))) {
      return deny(`Tool "${name}" is not on the read-only allowlist`);
    }
    if (++calls > config.maxToolCalls) {
      return deny('Tool call budget used up. Give your final JSON answer now with what you have.');
    }
    return {};
  };

  const { ac, done } = controller(a.signal, config.agentTimeoutMs);
  const q = query({
    prompt: a.question,
    options: base({
      systemPrompt: a.system,
      tools: [], // no built-in tools: no Bash, no file access, no web
      mcpServers: { [cfg.id]: server },
      allowedTools: session.tools.map((t) => prefix + t.name),
      disallowedTools: session.blocked.map((n) => prefix + n),
      hooks: { PreToolUse: [{ hooks: [guard] }] },
      maxTurns: config.maxToolCalls + 3,
      abortController: ac,
    }),
  });

  const pending = new Map<string, string>();
  const toolCalls: DomainResult['toolCalls'] = [];

  try {
    const { text } = await drain(q, {
      onInit(init) {
        const s = init.mcp_servers.find((m) => m.name === cfg.id);
        if (s?.status !== 'connected') {
          throw new SdkError(
            `Claude Code ต่อ MCP server "${cfg.id}" ไม่ได้ (สถานะ: ${s?.status ?? 'ไม่พบ'}) ตรวจ URL/คำสั่ง, token และ header ด้วย \`npm run check\` (ถ้าเริ่มช้า ตั้ง MCP_TIMEOUT)`,
          );
        }
      },
      onToolUse(id, name, input) {
        pending.set(id, short(name));
        a.onTool({ tool: short(name), phase: 'call', detail: shortArgs(input) });
      },
      onToolResult(id, isError, chars) {
        const tool = pending.get(id) ?? 'unknown';
        pending.delete(id);
        toolCalls.push({ tool, ok: !isError });
        a.onTool(isError ? { tool, phase: 'error', detail: 'blocked or failed' } : { tool, phase: 'result', detail: `${chars} chars` });
      },
    });
    return { text, toolCalls };
  } catch (e) {
    throw ac.signal.aborted && ac.signal.reason instanceof SdkError ? ac.signal.reason : e;
  } finally {
    done();
    q.close();
  }
}

export interface Probe {
  reply: string;
  apiKeySource: string;
  version: string;
  model: string;
  /** Who Claude Code is signed in as, straight from Claude Code. Fields are absent for keys, gateways and fakes. */
  account: { email?: string; subscriptionType?: string; apiProvider?: string; tokenSource?: string };
}

/** Sends one tiny request and reports which credential Claude Code used. Powers `npm run check`. */
export async function sdkProbe(): Promise<Probe> {
  const { ac, done } = controller(undefined, 60_000);
  const q = query({
    prompt: 'ping',
    options: base({ systemPrompt: 'Reply with the single word OK.', tools: [], mcpServers: {}, maxTurns: 1, abortController: ac }),
  });
  try {
    const account = await q.accountInfo().catch(() => ({}) as Probe['account']);
    const { text, init } = await drain(q, {});
    return {
      reply: text.trim(),
      apiKeySource: String(init?.apiKeySource ?? 'unknown'),
      version: init?.claude_code_version ?? '?',
      model: init?.model ?? '?',
      account: { email: account.email, subscriptionType: account.subscriptionType, apiProvider: account.apiProvider, tokenSource: account.tokenSource },
    };
  } finally {
    done();
    q.close();
  }
}
