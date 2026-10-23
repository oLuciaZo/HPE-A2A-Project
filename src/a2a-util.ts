import { randomUUID } from 'node:crypto';
import { Message, TaskState, type Part } from '@a2a-js/sdk';
import type { AgentState } from './types.js';

export const textPart = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});

export const dataPart = (value: unknown): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: 'application/json',
});

export function agentMessage(text: string, taskId: string, contextId: string): Message {
  return Message.fromJSON({
    messageId: randomUUID(),
    taskId,
    contextId,
    role: 'ROLE_AGENT',
    parts: [{ text }],
  });
}

export function userMessage(text: string): Message {
  return Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] });
}

export function textOf(message: Message | undefined): string {
  if (!message) return '';
  return message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function stateName(state: TaskState): AgentState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return 'submitted';
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed';
    case TaskState.TASK_STATE_FAILED:
      return 'failed';
    case TaskState.TASK_STATE_CANCELED:
      return 'canceled';
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'input-required';
    case TaskState.TASK_STATE_REJECTED:
      return 'rejected';
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'auth-required';
    default:
      return 'working';
  }
}

export const isTerminal = (s: AgentState) =>
  s === 'completed' || s === 'failed' || s === 'canceled' || s === 'rejected';

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson<T>(text: string): T | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
