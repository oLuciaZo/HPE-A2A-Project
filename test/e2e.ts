/**
 * End-to-end check of the whole pipeline: orchestrator -> A2A over HTTP -> domain agents -> (MCP, model).
 *   E2E_MODE=mock  simulated agents, no network beyond localhost
 *   E2E_MODE=real  real MCP client + real model loop (Messages API), against local fakes of the MCP servers and the Anthropic API
 *   E2E_MODE=sdk   ENGINE=agent-sdk: the real Claude Code binary signed in with a (fake) plan token, against the same fakes
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report, StampedEvent } from '../src/types.js';

const mode = process.env.E2E_MODE === 'real' ? 'real' : process.env.E2E_MODE === 'sdk' ? 'sdk' : 'mock';
const POISON_API_KEY = 'sk-ant-api03-must-never-be-sent';
const PLAN_TOKEN = 'sk-ant-oat01-fake-plan-token';

// Config is read once at import, so the environment must be set first. Never pick up a developer's own .env.
process.env.A2A_NO_DOTENV = '1';
process.env.MIST_AGENT_PORT = '4311';
process.env.CENTRAL_AGENT_PORT = '4312';
const TOKEN = 'test-secret-token';
// Mist is a remote HTTP server that also needs a custom header; Central is a local stdio server that needs an env var.
const MIST_HEADER = { name: 'X-Mist-Base-URL', value: 'https://api.mist.com' };
const STDIO_STATS = join(mkdtempSync(join(tmpdir(), 'a2a-e2e-')), 'stdio-calls.txt');
const stdioCalls = () => (existsSync(STDIO_STATS) ? readFileSync(STDIO_STATS, 'utf8').split('\n').filter(Boolean) : []);
let fakeMcp: ReturnType<typeof import('./fakes.js').startFakeMcp>[] = [];
let fakeModel: ReturnType<typeof import('./fakes.js').startFakeAnthropic> | undefined;

if (mode === 'mock') {
  process.env.MOCK = '1';
  process.env.MOCK_STEP_MS = '40';
} else {
  const fakes = await import('./fakes.js');
  fakeMcp = [fakes.startFakeMcp(5302, 'get_mist_stats', 'bounce_port', TOKEN, MIST_HEADER)];
  // In sdk mode the first agent turn fires 10 parallel calls, to prove the call budget (8) holds.
  fakeModel = fakes.startFakeAnthropic(5301, 'bounce_port', mode === 'sdk' ? { burst: 10 } : {});
  Object.assign(process.env, {
    ...(mode === 'sdk'
      ? { ENGINE: 'agent-sdk', CLAUDE_CODE_OAUTH_TOKEN: PLAN_TOKEN, ANTHROPIC_API_KEY: POISON_API_KEY }
      : { ENGINE: 'api', ANTHROPIC_API_KEY: 'fake-key' }),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:5301',
    MIST_MCP_URL: 'http://127.0.0.1:5302/mcp',
    MIST_MCP_TOKEN: TOKEN,
    MIST_MCP_HEADERS: `${MIST_HEADER.name}:${MIST_HEADER.value}`,
    CENTRAL_MCP_COMMAND: 'node',
    CENTRAL_MCP_ARGS: `${fileURLToPath(new URL('./fake-stdio-mcp.mjs', import.meta.url))} central_get_alerts central_bounce_port`,
    CENTRAL_MCP_ENV: `FAKE_TOKEN=stdio-secret;FAKE_STATS_FILE=${STDIO_STATS}`,
  });
}

const { config, DOMAINS } = await import('../src/config.js');
const { startDomainAgent } = await import('../src/domain-agent.js');
const { hub } = await import('../src/hub.js');
const { runQuestion } = await import('../src/orchestrator.js');

const servers = [];
for (const d of DOMAINS) servers.push(await startDomainAgent(config.domains[d]));

async function run(question: string): Promise<{ events: StampedEvent[]; report: Report }> {
  const id = hub.create(question);
  const events: StampedEvent[] = [];
  hub.subscribe(id, (e) => events.push(e));
  await runQuestion(id, question);
  const last = events.at(-1);
  assert.ok(last, 'no events were emitted');
  assert.equal(last.type, 'run.report', `run ended with ${last.type}: ${JSON.stringify(last)}`);
  return { events, report: (last as Extract<StampedEvent, { type: 'run.report' }>).report };
}

const types = (events: StampedEvent[]) => events.map((e) => e.type);
let passed = 0;
const ok = (name: string) => {
  console.log(`  ok  ${name}`);
  passed++;
};

try {
  console.log(`e2e (${mode})`);

  // 1. Happy path
  const happy = await run('สรุปสุขภาพเครือข่ายทุกไซต์วันนี้');
  assert.deepEqual(types(happy.events).slice(0, 2), ['run.started', 'orch.status']);
  for (const d of DOMAINS) {
    const states = happy.events.filter((e) => e.type === 'agent.status' && e.agent === d).map((e) => (e as { state: string }).state);
    assert.deepEqual([states[0], states.at(-1)], ['submitted', 'completed'], `${d} lifecycle: ${states}`);
    assert.ok(happy.events.some((e) => e.type === 'agent.tool' && e.agent === d && e.phase === 'call'), `${d} made no tool call event`);
  }
  assert.equal(happy.report.gaps.length, 0);
  assert.equal(happy.report.mock, mode === 'mock');
  assert.equal(config.engine, mode === 'sdk' ? 'agent-sdk' : mode === 'real' ? 'api' : config.engine);
  assert.ok(happy.report.findings.length > 0 && happy.report.headline.length > 0);
  ok('both agents go submitted -> completed, tool events and a report arrive');

  // 2. IDs are sequential so SSE replay with Last-Event-ID is exact
  happy.events.forEach((e, i) => assert.equal(e.id, i + 1));
  ok('event ids are sequential');

  // 3. One agent failing must not sink the run
  if (mode === 'mock') {
    const partial = await run('สรุปสุขภาพเครือข่าย FAIL_MIST');
    assert.equal(partial.report.gaps.length, 1);
    assert.match(partial.report.gaps[0], /Mist agent/);
    assert.ok(partial.report.findings.every((f) => f.source === 'central'));
    ok('a failed agent becomes a gap, the other agent still reports');
  }

  if (mode !== 'mock') {
    assert.equal(happy.report.headline, 'merged headline');
    assert.deepEqual(happy.report.next, ['check merged finding']);
    ok('planner and merger model calls were used');

    const agentCalls = fakeModel!.seen.filter((s) => s.role === 'agent');
    assert.ok(agentCalls.length >= 4, 'each agent should call the model at least twice');
    assert.ok(agentCalls.every((c) => c.toolNames.length > 0), 'agents must be offered the read-only tool');
    if (mode === 'sdk') {
      assert.ok(agentCalls.every((c) => c.toolNames.every((n) => /^mcp__(mist|central)__/.test(n))), `built-in tools were offered: ${agentCalls[0].toolNames}`);
    }
    for (const call of agentCalls) {
      assert.ok(!call.toolNames.some((n) => /bounce/.test(n)), `destructive tool offered to the model: ${call.toolNames}`);
    }
    ok('destructive tools are never offered to the model');

    for (const m of fakeMcp) {
      assert.ok(m.stats.authedRequests > 0, 'bearer token was not sent');
      assert.equal(m.stats.rejectedRequests, 0, 'MCP server rejected a request');
      assert.ok(!m.stats.toolCalls.some((n) => /bounce/.test(n)), `destructive tool reached the MCP server: ${m.stats.toolCalls}`);
      assert.ok(m.stats.toolCalls.length >= 1, 'the read-only tool was never called');
    }
    // Central (stdio): the env var reached the child process, and the destructive tool never ran.
    assert.ok(stdioCalls().length >= 1, 'the stdio read-only tool was never called');
    assert.ok(!stdioCalls().some((n) => /bounce/.test(n)), `destructive tool ran on the stdio server: ${stdioCalls()}`);
    assert.ok(!stdioCalls().some((n) => /no-env/.test(n)), 'FAKE_TOKEN did not reach the stdio server environment');
    ok('Mist over HTTP with a custom header, Central over stdio with its env: both worked');

    if (mode === 'sdk') {
      // 10 parallel calls were requested per agent; the budget of config.maxToolCalls must hold.
      for (const m of fakeMcp) {
        assert.equal(m.stats.toolCalls.length, config.maxToolCalls, `expected exactly ${config.maxToolCalls} read calls, got ${m.stats.toolCalls.length}`);
      }
      assert.equal(stdioCalls().length, config.maxToolCalls, `expected exactly ${config.maxToolCalls} stdio read calls, got ${stdioCalls().length}`);
      const overBudget = happy.report.toolCalls.filter((t) => !/bounce/.test(t.tool) && !t.ok);
      assert.equal(overBudget.length, 2 * (10 - config.maxToolCalls), 'over-budget calls should be denied and audited');
      ok('the tool call budget holds even when the model fires 10 calls at once');

      // The plan login was used, never the API key.
      const creds = fakeModel!.credentials;
      assert.ok(creds.length > 0, 'the fake API saw no requests');
      assert.ok(!creds.some((c) => c.apiKey === POISON_API_KEY), 'the API key leaked into a Claude Code request');
      assert.ok(creds.every((c) => c.bearer === PLAN_TOKEN), 'every request should carry the plan token');
      ok('requests used the plan login token and never the ANTHROPIC_API_KEY');
    }
    ok('bearer token sent, read-only tool called, destructive tool never reached the MCP server');

    const blocked = happy.report.toolCalls.filter((t) => /bounce/.test(t.tool));
    assert.ok(blocked.length >= 2 && blocked.every((t) => !t.ok), 'blocked attempts should appear in the audit trail as failed');
    ok('blocked attempts show up in the audit trail as failed');
  }

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  servers.forEach((s) => s.close());
  fakeMcp.forEach((m) => m.close());
  fakeModel?.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
