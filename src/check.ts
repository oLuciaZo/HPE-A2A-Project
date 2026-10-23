/**
 * `npm run check`: verifies, before you start the dashboard, that
 *  1. the model can be reached (for ENGINE=agent-sdk: Claude Code is signed in with your plan), and
 *  2. each remote MCP server connects, and which tools the agents will and will not be allowed to use.
 */
import { config, DOMAINS } from './config.js';
import { connectMcp } from './mcp.js';
import { sdkProbe } from './agent-sdk-engine.js';

let failed = false;
const ok = (s: string) => console.log(`  ok    ${s}`);
const warn = (s: string) => console.log(`  warn  ${s}`);
const bad = (s: string) => {
  failed = true;
  console.log(`  FAIL  ${s}`);
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function checkModel() {
  console.log(`\nModel (engine: ${config.engine}, model: ${config.model})`);
  if (config.engine === 'api') {
    if (process.env.ANTHROPIC_API_KEY) ok('ANTHROPIC_API_KEY is set (billed to your Claude Console account)');
    else bad('ENGINE=api needs ANTHROPIC_API_KEY');
    return;
  }
  if (process.env.ANTHROPIC_API_KEY && process.env.AGENT_SDK_ALLOW_API_KEY !== '1') {
    ok('ANTHROPIC_API_KEY is in your environment; it is ignored on purpose so your plan is used');
  }
  for (const v of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (process.env[v]) warn(`${v} is set, so Claude Code may not be talking to Anthropic with your plan login`);
  }
  try {
    const p = await sdkProbe();
    ok(`Claude Code ${p.version} answered "${p.reply}" (model ${p.model})`);
    const a = p.account;
    if (p.apiKeySource !== 'none') {
      warn(`credential source is "${p.apiKeySource}", so usage may be billed to the API instead of your plan`);
    } else if (a.subscriptionType) {
      ok(`signed in with your Claude plan: ${a.subscriptionType}${a.email ? ` (${a.email})` : ''}`);
    } else {
      warn('no API key is in use, but Claude Code did not report a Claude plan for this login. Run `claude`, then /status, to see which account it uses');
    }
  } catch (e) {
    bad(msg(e));
  }
}

async function checkMcp() {
  for (const d of DOMAINS) {
    const cfg = config.domains[d];
    const D = d.toUpperCase();
    const where = cfg.mcpTransport === 'stdio' ? `${cfg.mcpCommand} ${cfg.mcpArgs.join(' ')}`.trim() : cfg.mcpUrl;
    console.log(`\n${cfg.label} MCP (${cfg.mcpTransport})`);
    if (cfg.mcpTransport === 'stdio' ? !cfg.mcpCommand : !cfg.mcpUrl) {
      bad(`${D}_MCP_URL is not set (or set ${D}_MCP_COMMAND for a local stdio server)`);
      continue;
    }
    try {
      const t0 = Date.now();
      const s = await connectMcp(cfg, { allowEmpty: true });
      const secs = (Date.now() - t0) / 1000;
      try {
        ok(`connected over ${s.transport} in ${secs.toFixed(1)}s`);
        if (s.transport === 'stdio' && secs > 4) {
          warn('slow start: Claude Code waits only a few seconds for a local MCP server. If runs fail with "ต่อ MCP server ไม่ได้", set MCP_TIMEOUT=30000 in .env');
        }
        if (s.tools.length) ok(`${s.tools.length} read-only tools the agent may use: ${s.tools.map((t) => t.name).join(', ')}`);
        else bad(`no tool matches the read-only allowlist ${cfg.toolAllow}`);
        if (s.blocked.length) ok(`${s.blocked.length} tools blocked (not read-only by name): ${s.blocked.join(', ')}`);
        else warn('the server lists no write-style tools; check that the allowlist matches how its tools are named');
      } finally {
        await s.close();
      }
    } catch (e) {
      bad(`${where}: ${msg(e)}`);
    }
  }
}

await checkModel();
await checkMcp();
console.log(failed ? '\nNot ready: fix the FAIL lines above.' : '\nReady. Start with: npm run build && npm start');
process.exit(failed ? 1 : 0);
