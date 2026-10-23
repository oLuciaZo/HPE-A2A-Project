import { config } from './config.js';
import type { Domain, DomainResult } from './types.js';

export type ToolHook = (e: { tool: string; phase: 'call' | 'result' | 'error'; detail?: string }) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Scenario = 'health' | 'client';

export function pickScenario(question: string): Scenario {
  return /client|ไคลเอนต์|เครื่องลูกข่าย|ต่อ.*ไม่ติด|wi-?fi/i.test(question) ? 'client' : 'health';
}

interface Script {
  steps: { tool: string; args: string; got: string }[];
  result: Omit<DomainResult, 'toolCalls'>;
}

const SCRIPTS: Record<Scenario, Record<Domain, Script>> = {
  health: {
    mist: {
      steps: [
        { tool: 'get_mist_stats', args: 'type=sites', got: '4 sites' },
        { tool: 'search_mist_data', args: 'alarms, last 24h', got: '3 alarms' },
      ],
      result: {
        summary: 'Mist: 4 ไซต์ มี AP ออฟไลน์ 1 ตัว และมี client ที่เชื่อมต่อช้าเล็กน้อย',
        findings: [
          { severity: 'warning', text: 'AP-2F-05 ออฟไลน์ 40 นาที ที่ไซต์ HQ' },
          { severity: 'info', text: 'ลูกค้า 3% เชื่อมต่อช้า ที่ไซต์ Warehouse' },
        ],
        metrics: [
          { label: 'ไซต์ Mist', value: '4' },
          { label: 'AP ออฟไลน์', value: '1', sub: 'AP-2F-05' },
        ],
      },
    },
    central: {
      steps: [
        { tool: 'central_get_sites', args: '', got: '6 sites' },
        { tool: 'central_get_alerts', args: 'last 24h', got: '2 alerts' },
      ],
      result: {
        summary: 'Central: 6 ไซต์ มี AP หนึ่งตัวที่ช่อง 5 GHz โหลดสูง',
        findings: [{ severity: 'warning', text: 'AP-3F-02 ใช้ช่อง 5 GHz 91% ที่ไซต์ Branch-CM' }],
        metrics: [
          { label: 'ไซต์ Central', value: '6' },
          { label: 'AP โหลดสูง', value: '1', sub: 'AP-3F-02' },
        ],
      },
    },
  },
  client: {
    mist: {
      steps: [
        { tool: 'search_mist_data', args: 'clients with failures', got: '2 clients' },
        { tool: 'get_mist_insights', args: 'client events', got: '12 events' },
      ],
      result: {
        summary: 'Mist: พบ client ที่ authentication ล้มเหลวซ้ำ 1 เครื่อง',
        findings: [{ severity: 'critical', text: 'somchai-laptop: auth fail 12 ครั้ง (RADIUS timeout)' }],
        metrics: [{ label: 'client มีปัญหา (Mist)', value: '2' }],
      },
    },
    central: {
      steps: [
        { tool: 'central_get_clients', args: 'status=failed', got: '3 clients' },
        { tool: 'central_get_events', args: 'roaming, last 24h', got: '15 events' },
      ],
      result: {
        summary: 'Central: พบปัญหา roaming และ DHCP อย่างละ 1 เครื่อง',
        findings: [
          { severity: 'warning', text: 'guest-phone-77: roam ช้า 9 ครั้ง ระหว่าง AP-1F-01 และ AP-1F-02' },
          { severity: 'info', text: 'printer-ac12: DHCP fail 6 ครั้ง' },
        ],
        metrics: [{ label: 'client มีปัญหา (Central)', value: '3' }],
      },
    },
  },
};

/**
 * Simulated domain agent run. No network, no model: it walks a fixed script so the
 * whole pipeline (A2A over HTTP, SSE, dashboard) can be exercised without credentials.
 * Put FAIL_MIST or FAIL_CENTRAL in the question to simulate that agent failing.
 */
export async function runMock(domain: Domain, question: string, onTool: ToolHook): Promise<DomainResult> {
  const script = SCRIPTS[pickScenario(question)][domain];
  const pace = domain === 'mist' ? 1 : 0.8;
  const toolCalls: DomainResult['toolCalls'] = [];

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i];
    onTool({ tool: step.tool, phase: 'call', detail: step.args });
    await sleep(config.mockStepMs * pace);

    if (i === 0 && question.includes(`FAIL_${domain.toUpperCase()}`)) {
      onTool({ tool: step.tool, phase: 'error', detail: 'Simulated failure' });
      throw new Error('Simulated failure (mock)');
    }
    onTool({ tool: step.tool, phase: 'result', detail: step.got });
    toolCalls.push({ tool: step.tool, ok: true });
    await sleep(config.mockStepMs * 0.3);
  }
  return { ...script.result, toolCalls };
}
