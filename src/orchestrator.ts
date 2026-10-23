import Anthropic from '@anthropic-ai/sdk';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { assertRealModeConfig, config, DOMAINS } from './config.js';
import { hub } from './hub.js';
import { sdkComplete } from './agent-sdk-engine.js';
import { extractJson, isTerminal, stateName, textOf, userMessage } from './a2a-util.js';
import type {
  AgentState,
  Domain,
  DomainResult,
  Report,
  ReportFinding,
  Severity,
  ToolEventMeta,
  TwinEvent,
} from './types.js';

interface Assignment {
  agent: Domain;
  subtask: string;
}

interface Outcome {
  agent: Domain;
  ok: boolean;
  result?: DomainResult;
  error?: string;
}

const clients = new Map<Domain, Promise<Client>>();

function getClient(d: Domain): Promise<Client> {
  let c = clients.get(d);
  if (!c) {
    c = new ClientFactory().createFromUrl(config.domains[d].agentUrl);
    c.catch(() => clients.delete(d)); // retry on the next run
    clients.set(d, c);
  }
  return c;
}

let anthropic: Anthropic | undefined;
const model = () => (anthropic ??= new Anthropic());

async function ask(system: string, user: string, maxTokens = 2048): Promise<string> {
  if (config.engine === 'agent-sdk') return sdkComplete(system, user);
  const resp = await model().messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

// --- planning -------------------------------------------------------------

async function plan(question: string): Promise<Assignment[]> {
  const both = DOMAINS.map((agent) => ({ agent, subtask: question }));
  if (config.mock) return both;
  try {
    const cards = await Promise.all(
      DOMAINS.map(async (d) => {
        const card = await (await getClient(d)).getAgentCard();
        return {
          id: d,
          description: card.description,
          skills: card.skills.map((s) => ({ name: s.name, description: s.description })),
        };
      }),
    );
    const text = await ask(
      [
        'You are the orchestrator for network analyst agents. Decide which agents are needed to answer the question.',
        'Use both agents unless the question clearly concerns only one platform.',
        'Write each subtask as a self-contained instruction, because the agents cannot see the original question. Use the same language as the question.',
        'Reply with ONLY JSON: {"agents":[{"id":"mist"|"central","subtask":string}]}',
      ].join('\n'),
      JSON.stringify({ agents: cards, question }),
      600,
    );
    const parsed = extractJson<{ agents?: { id: string; subtask: string }[] }>(text);
    const picks = (parsed?.agents ?? [])
      .filter((a) => DOMAINS.includes(a.id as Domain) && typeof a.subtask === 'string' && a.subtask.trim())
      .map((a) => ({ agent: a.id as Domain, subtask: a.subtask.trim() }));
    return picks.length ? picks : both;
  } catch (e) {
    console.warn('[orchestrator] planning failed, using both agents:', e instanceof Error ? e.message : e);
    return both;
  }
}

// --- one A2A conversation with one agent ----------------------------------

async function askAgent(runId: string, d: Domain, subtask: string): Promise<Outcome> {
  const emit = (e: TwinEvent) => hub.emit(runId, e);
  emit({ type: 'a2a.sent', agent: d, subtask });

  let result: DomainResult | undefined;
  let summaryText = '';
  let last: AgentState | undefined;
  let error = '';

  try {
    const client = await getClient(d);
    const request = { tenant: '', message: userMessage(subtask), configuration: undefined, metadata: undefined };
    const stream = client.sendMessageStream(request, { signal: AbortSignal.timeout(config.agentTimeoutMs) });

    for await (const ev of stream) {
      const p = ev.payload;
      if (!p) continue;

      if (p.$case === 'task' || p.$case === 'statusUpdate') {
        const status = p.value.status;
        if (!status) continue;
        const state = stateName(status.state);

        if (p.$case === 'statusUpdate') {
          const meta = p.value.metadata as Partial<ToolEventMeta> | undefined;
          if (meta?.kind === 'tool' && meta.tool && meta.phase) {
            emit({ type: 'agent.tool', agent: d, tool: meta.tool, phase: meta.phase, detail: meta.detail });
          }
        }
        if (state !== last) {
          last = state;
          const detail = textOf(status.message) || undefined;
          emit({ type: 'agent.status', agent: d, state, detail });
          if (state !== 'completed' && isTerminal(state)) error = detail ?? state;
          if (state === 'input-required' || state === 'auth-required') {
            error = `agent asked for ${state}, which this app cannot provide`;
          }
        }
      } else if (p.$case === 'artifactUpdate') {
        for (const part of p.value.artifact?.parts ?? []) {
          if (part.content?.$case === 'data') result = part.content.value as DomainResult;
          if (part.content?.$case === 'text') summaryText ||= part.content.value;
        }
      }
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    error = name === 'TimeoutError' ? `timed out after ${Math.round(config.agentTimeoutMs / 1000)}s` : e instanceof Error ? e.message : String(e);
    if (last !== 'failed') emit({ type: 'agent.status', agent: d, state: 'failed', detail: error });
  }

  if (!error && !result && summaryText) {
    result = { summary: summaryText, findings: [], metrics: [], toolCalls: [] };
  }
  if (!error && last !== 'completed') error = 'the agent stream ended before the task completed';
  if (!error && !result) error = 'the agent completed without a result';

  const ok = !error && !!result;
  emit({ type: 'a2a.result', agent: d, ok });
  return { agent: d, ok, result, error: error || undefined };
}

// --- merging --------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const isSeverity = (s: unknown): s is Severity => s === 'info' || s === 'warning' || s === 'critical';

function mergeFallback(outcomes: Outcome[]): Pick2 {
  const good = outcomes.filter((o) => o.ok && o.result);
  const findings: ReportFinding[] = good
    .flatMap((o) => o.result!.findings.map((f) => ({ ...f, source: o.agent as Domain | 'both' })))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    headline: good.map((o) => o.result!.summary).join(' · '),
    metrics: good.flatMap((o) => o.result!.metrics).slice(0, 4),
    findings,
    next: findings
      .filter((f) => f.severity !== 'info')
      .slice(0, 4)
      .map((f) => `ตรวจต่อ: ${f.text}`),
  };
}

type Pick2 = Pick<Report, 'headline' | 'metrics' | 'findings' | 'next'>;

async function merge(question: string, outcomes: Outcome[]): Promise<Report> {
  const good = outcomes.filter((o) => o.ok && o.result);
  const gaps = outcomes
    .filter((o) => !o.ok)
    .map((o) => `${config.domains[o.agent].label} ไม่สำเร็จ: ${o.error ?? 'unknown error'}`);

  let body: Pick2;
  if (good.length === 0) {
    body = { headline: 'ไม่ได้รับผลจาก agent ใดเลย จึงยังสรุปไม่ได้', metrics: [], findings: [], next: [] };
  } else if (config.mock) {
    body = mergeFallback(outcomes);
  } else {
    try {
      const results: Record<string, unknown> = {};
      for (const o of good) {
        const { summary, findings, metrics } = o.result!;
        results[o.agent] = { summary, findings, metrics };
      }
      const text = await ask(
        [
          'You merge reports from network analyst agents into one report for a network team.',
          'Use ONLY the data in the agent results. Do not add facts. Merge duplicates and order findings by severity.',
          'If an agent failed, do not guess its data. Write in the same language as the question.',
          'Reply with ONLY JSON:',
          '{"headline": string (one-sentence answer to the question), "metrics": [{"label": string, "value": string, "sub"?: string}] (max 4),',
          '"findings": [{"source": "mist"|"central"|"both", "severity": "info"|"warning"|"critical", "text": string}],',
          '"next": [string] (max 4 concrete read-only checks or actions, each tied to a finding)}',
        ].join('\n'),
        JSON.stringify({ question, results, failed: gaps }),
        3000,
      );
      const parsed = extractJson<Partial<Pick2>>(text);
      if (!parsed?.headline) throw new Error('merge reply was not valid report JSON');
      body = {
        headline: String(parsed.headline),
        metrics: Array.isArray(parsed.metrics) ? parsed.metrics.slice(0, 4) : [],
        findings: (Array.isArray(parsed.findings) ? parsed.findings : [])
          .filter((f) => f && typeof f.text === 'string')
          .map((f) => ({
            source: (['mist', 'central', 'both'] as const).includes(f.source as never) ? f.source : 'both',
            severity: isSeverity(f.severity) ? f.severity : 'info',
            text: f.text,
          })),
        next: Array.isArray(parsed.next) ? parsed.next.map(String).slice(0, 4) : [],
      };
    } catch (e) {
      console.warn('[orchestrator] merge failed, using plain merge:', e instanceof Error ? e.message : e);
      body = mergeFallback(outcomes);
    }
  }

  return {
    ...body,
    gaps,
    toolCalls: outcomes.flatMap((o) => (o.result?.toolCalls ?? []).map((t) => ({ agent: o.agent, ...t }))),
    mock: config.mock,
  };
}

// --- public entry point ---------------------------------------------------

export async function runQuestion(runId: string, question: string): Promise<void> {
  const emit = (e: TwinEvent) => hub.emit(runId, e);
  try {
    emit({ type: 'run.started', question, mock: config.mock });
    if (!config.mock) assertRealModeConfig({ mcp: false });

    emit({ type: 'orch.status', code: 'planning' });
    const picks = await plan(question);

    emit({ type: 'orch.status', code: 'dispatching', detail: picks.map((p) => p.agent).join(',') });
    const pending = picks.map((p) => askAgent(runId, p.agent, p.subtask)); // never rejects
    emit({ type: 'orch.status', code: 'waiting' });
    const outcomes = await Promise.all(pending);

    emit({ type: 'orch.status', code: 'merging' });
    const report = await merge(question, outcomes);

    emit({ type: 'orch.status', code: 'done' });
    emit({ type: 'run.report', report });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[orchestrator] run failed:', message);
    emit({ type: 'orch.status', code: 'error' });
    emit({ type: 'run.error', message });
  }
}
