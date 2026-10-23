import { assertRealModeConfig, config, DOMAINS } from './config.js';
import { startDomainAgent } from './domain-agent.js';
import { startServer } from './server.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

async function main() {
  if (!LOOPBACK.has(config.host) && !config.password) {
    console.error(
      `Refusing to listen on ${config.host} without DASHBOARD_PASSWORD.\n` +
        'This dashboard can start network queries; set a password, or bind to 127.0.0.1.',
    );
    process.exit(1);
  }

  if (config.engine === 'agent-sdk' && !config.mock && !LOOPBACK.has(config.host)) {
    console.error(
      `Refusing to listen on ${config.host} with ENGINE=agent-sdk.\n` +
        'This engine runs on your own Claude plan login, which is for personal use on your own machine.\n' +
        'Bind to 127.0.0.1, or use ENGINE=api with an ANTHROPIC_API_KEY to share the dashboard.',
    );
    process.exit(1);
  }

  if (config.mock) {
    console.log('MOCK=1: simulated agents and data. No model or MCP calls are made.');
  } else {
    console.log(
      config.engine === 'agent-sdk'
        ? `Engine: agent-sdk (Claude Code signed in with your Claude plan), model ${config.model}. Run "npm run check" to verify the login.`
        : `Engine: api (ANTHROPIC_API_KEY), model ${config.model}.`,
    );
    try {
      assertRealModeConfig({ mcp: config.startAgents });
    } catch (e) {
      console.error(`${e instanceof Error ? e.message : e}\nTip: run with MOCK=1 to try the demo without credentials.`);
      process.exit(1);
    }
  }

  if (config.startAgents) {
    if (!LOOPBACK.has(config.agentHost)) {
      console.warn(
        `WARNING: agents listen on ${config.agentHost} and the A2A endpoints have no authentication. ` +
          'Keep them on loopback or a private network.',
      );
    }
    for (const d of DOMAINS) await startDomainAgent(config.domains[d]);
  } else {
    console.log('START_AGENTS=0: expecting agents at', DOMAINS.map((d) => config.domains[d].agentUrl).join(', '));
  }

  await startServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
