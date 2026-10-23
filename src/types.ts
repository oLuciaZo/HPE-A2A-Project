export type Domain = 'mist' | 'central';

export type AgentState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'auth-required';

export type OrchCode = 'planning' | 'dispatching' | 'waiting' | 'merging' | 'done' | 'error';

export type Severity = 'info' | 'warning' | 'critical';

export interface Metric {
  label: string;
  value: string;
  sub?: string;
}

export interface Finding {
  severity: Severity;
  text: string;
}

/** What one domain agent returns to the orchestrator (as a data part). */
export interface DomainResult {
  summary: string;
  findings: Finding[];
  metrics: Metric[];
  toolCalls: { tool: string; ok: boolean }[];
}

export interface ReportFinding extends Finding {
  source: Domain | 'both';
}

export interface Report {
  headline: string;
  metrics: Metric[];
  findings: ReportFinding[];
  next: string[];
  /** Things the report could not cover, e.g. an agent that failed. */
  gaps: string[];
  /** Audit trail: every tool call made on the way to the report. */
  toolCalls: { agent: Domain; tool: string; ok: boolean }[];
  mock: boolean;
}

/** Events the dashboard consumes. Machine fields only; the UI owns the wording. */
export type TwinEvent =
  | { type: 'run.started'; question: string; mock: boolean }
  | { type: 'orch.status'; code: OrchCode; detail?: string }
  | { type: 'a2a.sent'; agent: Domain; subtask: string }
  | { type: 'agent.status'; agent: Domain; state: AgentState; detail?: string }
  | { type: 'agent.tool'; agent: Domain; tool: string; phase: 'call' | 'result' | 'error'; detail?: string }
  | { type: 'a2a.result'; agent: Domain; ok: boolean }
  | { type: 'run.report'; report: Report }
  | { type: 'run.error'; message: string };

export type StampedEvent = TwinEvent & { id: number; ts: number };

/** Metadata the domain agents attach to A2A status updates for tool calls. */
export interface ToolEventMeta {
  kind: 'tool';
  tool: string;
  phase: 'call' | 'result' | 'error';
  detail?: string;
}
