import { randomUUID } from 'node:crypto';
import type { StampedEvent, TwinEvent } from './types.js';

interface Run {
  id: string;
  question: string;
  events: StampedEvent[];
  listeners: Set<(e: StampedEvent) => void>;
  done: boolean;
}

const MAX_RUNS = 50;

/** In-memory event log per run. Late or reconnecting viewers get a full replay. */
class Hub {
  private runs = new Map<string, Run>();

  create(question: string): string {
    const id = randomUUID();
    this.runs.set(id, { id, question, events: [], listeners: new Set(), done: false });
    // Drop the oldest finished runs once the cap is exceeded.
    if (this.runs.size > MAX_RUNS) {
      for (const [key, run] of this.runs) {
        if (this.runs.size <= MAX_RUNS) break;
        if (run.done) this.runs.delete(key);
      }
    }
    return id;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (!run.done) n++;
    return n;
  }

  emit(id: string, event: TwinEvent): void {
    const run = this.runs.get(id);
    if (!run || run.done) return;
    const stamped = { ...event, id: run.events.length + 1, ts: Date.now() } as StampedEvent;
    run.events.push(stamped);
    if (event.type === 'run.report' || event.type === 'run.error') run.done = true;
    for (const fn of run.listeners) fn(stamped);
  }

  /** Replays events after `afterId`, then streams new ones. Returns an unsubscribe function. */
  subscribe(id: string, fn: (e: StampedEvent) => void, afterId = 0): (() => void) | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    for (const e of run.events) if (e.id > afterId) fn(e);
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
  }

  isDone(id: string): boolean {
    return this.runs.get(id)?.done ?? true;
  }

  snapshot(id: string): { question: string; done: boolean; events: StampedEvent[] } | undefined {
    const run = this.runs.get(id);
    return run && { question: run.question, done: run.done, events: run.events };
  }
}

export const hub = new Hub();
