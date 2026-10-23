# A2A twin: decisions and status (2026-10-16)

## Decisions (from the user)
- Language: TypeScript.
- MCP servers: the user's existing Claude Desktop config shows Mist is a remote server (`https://mcp.ai.juniper.net/mcp/mist`, Bearer token plus an `X-Mist-Base-URL` header, reached through `mcp-remote`) and Central is a local stdio server (`uvx --prerelease=allow --with mcp<2 central-mcp-server` with CENTRAL_BASE_URL / CENTRAL_CLIENT_ID / CENTRAL_CLIENT_SECRET in env). Both are supported (see "MCP connection types").
- Dashboard: a digital-twin page. Originally "shareable with the team"; now run on the user's own machine only (see Model access).
- Model access: the user is on a Claude **Pro** plan, has no API credits and will not buy any. They chose to run the model layer through the Agent SDK on the plan's limits, on their own machine ("run บนเครื่องตัวเองได้ไม่มีปัญหา").
- Secrets: the user pasted Central and Mist credentials into the chat, and later a whole `.env` (values looked shortened, including a `CLAUDE_CODE_OAUTH_TOKEN`). None were written to any file, the project or the zip (scanned). Advised the user to rotate anything real.

## What was built
Prototype project `a2a-twin` (delivered as a zip in the chat): Orchestrator + Mist agent + Central agent talking A2A v1.0, each domain agent using its own MCP server; Express server streaming run events over SSE to a character-based dashboard; report with an audit trail of every tool call.

Second iteration (same day): `ENGINE=agent-sdk|api`. `agent-sdk` calls the model through `@anthropic-ai/claude-agent-sdk` (Claude Code 2.1.301 is bundled for all platforms), signed in with the plan; `api` is the original Messages API path. New `npm run check` verifies login/plan and lists allowed and blocked MCP tools per domain.

Third iteration: MCP connection types (see below). Then a bug fix: `npm run check` did not read `.env` (only `node --env-file` did), so the user's first check reported both MCP URLs as unset. `config.ts` now loads `./.env` itself (`process.loadEnvFile`, shell variables win, `A2A_NO_DOTENV=1` turns it off, used by tests; `engines.node >= 20.12`). `npm start` replaces the `node --env-file` command in the docs.

## MCP connection types
- Remote: `*_MCP_URL`, `*_MCP_TOKEN` (sent as Bearer), `*_MCP_HEADERS` (`Name:value;Name2:value2`), `*_MCP_TRANSPORT=auto|http|sse` (auto tries Streamable HTTP then SSE).
- Local stdio: `*_MCP_COMMAND`, `*_MCP_ARGS` (whitespace-split or JSON array), `*_MCP_ENV` (`KEY=value;KEY2=value2`). Our own client spawns the server with only a safe base environment plus `*_MCP_ENV`; with ENGINE=agent-sdk Claude Code spawns a second copy with the same command/args/env.
- With ENGINE=agent-sdk Claude Code gets the same kind of connection that worked for our own client (`McpSession.transport`).
- A `npx mcp-remote <url> --header ...` entry in Claude Desktop is just a stdio bridge to a remote server: use the URL and headers directly.
- The URL/token/headers settings of a platform that uses stdio (and the reverse) are ignored; empty values are harmless. `*_MCP_COMMAND` wins.

## Findings worth keeping
- `@a2a-js/sdk` installed as v1.3.0 (A2A spec v1.0). Its API differs from older examples: protobuf-style types (`Part.content.$case`, `TaskState.TASK_STATE_*`), `X.fromJSON({...})` helpers to build objects, `DefaultRequestHandler` + `jsonRpcHandler` + `agentCardHandler` on the server, `ClientFactory.createFromUrl` + `sendMessageStream` on the client. The first event an executor publishes must be a `task` or `message`.
- A2A reports only the overall task state. Per-tool activity is sent as status-update `metadata` (`kind: "tool"`), which the dashboard turns into the MCP animations.
- Safety: only tools matching `(^|_)(get|list|search|find)_` are exposed to the model, and the allowlist is enforced again at call time. Destructive tools (bounce port, create SSID/VLAN/role) are excluded by default. From the tool names seen in this workspace, Mist's seven tools (get_mist_config, get_mist_stats, find_mist_entity, search_mist_data, get_mist_insights, get_mist_constants, get_mist_self) all pass; Central's get_* pass while central_bounce_port, central_run_network_test and central_run_show_commands are blocked.

## Model access (checked 2026-10-16 against official docs)
- The API engine needs `ANTHROPIC_API_KEY`, billed separately from a claude.ai plan. Pro has no monthly API credits (Max and Team do).
- The Agent SDK / `claude -p` can authenticate with a subscription: `/login`, or `claude setup-token` (needs Pro, Max, Team or Enterprise) which prints a one-year token for `CLAUDE_CODE_OAUTH_TOKEN`. That token can only make model requests; MCP servers configured locally still work. `--bare` mode ignores the subscription login. An `ANTHROPIC_API_KEY` in the environment takes precedence over the subscription, so the agent-sdk engine strips it from the Claude Code process (override: `AGENT_SDK_ALLOW_API_KEY=1`, used by tests). `CLAUDE_CODE_OAUTH_TOKEN` outranks a `/login` credential, so an invalid token in `.env` would break a working login.
- **Confirmed on the user's machine** (their `npm run check`, 2026-10-16 22:14): the bundled Claude Code 2.1.301 used the login of their installed `claude` and `accountInfo()` reported the plan as "Claude Pro" with their email. No token was needed (that run did not read `.env`, so the token in their `.env` was not involved).
- Usage from the SDK and `claude -p` still draws from plan limits per the support article updated 2026-10-07. A change announced 2026-05-14 (separate API-priced budget from 2026-06-15) was paused on 2026-06-15. Policy has moved before and could move again.
- Policy limit: Anthropic's Claude Code legal page says developers building products or services should use API keys, may not route requests through Free/Pro/Max credentials on behalf of their users, and may not collect, store or intermediate Claude.ai credentials. The advertised Pro/Max limits assume ordinary, individual use of Claude Code and the Agent SDK. An end user signing in to the unmodified Claude Code binary with their own subscription is allowed.
- Consequence, enforced in code: `ENGINE=agent-sdk` refuses to start on a non-loopback `HOST`. Team sharing options: each member runs their own copy with their own plan, share the Markdown report from the dashboard, or use `ENGINE=api`.

## Agent SDK engine: how it is locked down
Built-in tools off (`tools: []`), only our MCP server (`strictMcpConfig`), no settings/CLAUDE.md/skills (`settingSources: []`), no transcripts (`persistSession: false`), empty temp cwd, `permissionMode: dontAsk`, allowlisted tool names in `allowedTools`, the rest in `disallowedTools`, plus a PreToolUse hook that re-checks the allowlist and enforces `MAX_TOOL_CALLS`. MCP is connected by Claude Code itself with `alwaysLoad: true` (so tools are never deferred behind tool search). Timeouts and cancels abort the Claude Code process.

## Tested
- Mock mode end to end in a real browser (happy path, agent failure, shared-link replay, hostile text rendered as text).
- Real-mode code path against local fakes of the MCP servers and the Anthropic API (bearer auth, allowlist, model loop, planner, merger).
- Agent SDK engine with the real bundled Claude Code binary, a fake plan token (`CLAUDE_CODE_OAUTH_TOKEN`) and a fake streaming Anthropic API: plan token used and a poisoned `ANTHROPIC_API_KEY` never sent; destructive tool never offered or executed; 10 parallel calls capped at 8; planner/agents/merger all ran; also run in an environment with all sandbox Claude/CCR variables removed. Mutation checks: disabling the budget guard or the deny list makes the tests fail. Compiled `dist` app driven over HTTP/SSE and in headless Chromium (report, tool events, audit trail).
- MCP connection types: fake Mist over HTTP that rejects requests without `X-Mist-Base-URL`, fake Central over stdio that refuses to answer unless its env var arrived; both work with the API engine and with Claude Code. Mutation checks: dropping the extra headers or Claude Code's stdio env makes the tests fail.
- `.env` loading: file in cwd is read, shell variables win, `A2A_NO_DOTENV=1` ignores it, a missing file is fine, and the full test suite passes with a stray `.env` planted in the project.
- `npm run check` against fakes (success, wrong MCP token, malformed header setting). Clean `npm ci` + typecheck + mock test from the zip. Lockfile has the bundled Claude Code binary for macOS, Linux and Windows.
- Password protection, refusal to bind non-loopback without a password, refusal of agent-sdk on non-loopback, input validation.

## Not tested yet
- How much Pro quota one question uses, and the error text when the plan limit is hit (mapped from Claude Code error codes, not seen live).
- The real Mist endpoint (does it speak Streamable HTTP or SSE; auto-detect should cope) and the real Central stdio server via `uvx` (cold start may exceed Claude Code's MCP connect wait; the README suggests warming the cache with `npm run check` and setting `MCP_TIMEOUT`, which is unverified against `alwaysLoad`'s 5s cap). Also not checked: whether running two copies of the Central server (ours for the allowlist, Claude Code's for the agent) causes any problem with Central's API credentials. The user's first MCP check did not run because of the `.env` bug above; waiting for their re-run.
- The real model on the full multi-agent flow. (Incidental: during a no-login experiment two tiny requests reached the real model through the sandbox's own connection and returned normal text, so `sdkComplete` works against a real model.)
- `docker build` of the Dockerfile (now `ENGINE=api` only).

## Open items
- User to re-run `npm run check` with the fixed zip and report the MCP part.
- User should remove (or comment out) `CLAUDE_CODE_OAUTH_TOKEN` in `.env`: the login already works and the pasted value looked truncated.
- Review the allowed/blocked tool list per domain printed by `npm run check` before first real use (the read-only filter is name-based).
- If quota runs out too fast: lower `MAX_TOOL_CALLS`, smaller `MODEL`, or split models per role (planner/merger on a small model).
- The user should rotate any real credentials that were pasted in chat.