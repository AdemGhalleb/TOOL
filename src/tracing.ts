import {randomUUID} from 'node:crypto';

export type TraceErrorCategory =
  | 'cancelled'
  | 'context_budget'
  | 'deadline'
  | 'iteration_limit'
  | 'model'
  | 'tool'
  | 'unknown';

export interface TraceBase {
  runId: string;
  type: string;
  timestamp: string;
}

export interface RunStartedEvent extends TraceBase {
  type: 'run.started';
}

export interface RunTerminalEvent extends TraceBase {
  type: 'run.completed' | 'run.failed' | 'run.cancelled';
  durationMs: number;
  outcome?: TraceErrorCategory;
}

export interface ModelRequestEvent extends TraceBase {
  type: 'model.request.started' | 'model.request.completed' | 'model.request.failed';
  iteration: number;
  durationMs?: number;
  outcome?: TraceErrorCategory;
}

export interface ContextPreparedEvent extends TraceBase {
  type: 'context.prepared';
  iteration: number;
  estimatedInputTokens: number;
  selectedGroupCount: number;
  excludedGroupCount: number;
  excludedMessageCount: number;
}

export interface ToolEvent extends TraceBase {
  type: 'tool.started' | 'tool.completed' | 'tool.failed';
  iteration: number;
  toolName: string;
  durationMs?: number;
  outcome?: TraceErrorCategory;
}

export interface ApprovalEvent extends TraceBase {
  type: 'tool.approval.requested' | 'tool.approval.resolved';
  iteration: number;
  toolName: string;
  approved?: boolean;
}

export type TraceEvent =
  | RunStartedEvent
  | RunTerminalEvent
  | ModelRequestEvent
  | ContextPreparedEvent
  | ToolEvent
  | ApprovalEvent;

export interface TraceSink {
  emit(event: TraceEvent): void | Promise<void>;
}

export const noopTraceSink: TraceSink = {
  emit: () => {},
};

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  constructor(private readonly maxEvents = 1_000) {}

  emit(event: TraceEvent): void {
    if (this.events.length >= this.maxEvents) this.events.shift();
    this.events.push(event);
  }
}

export function createRunId(): string {
  return randomUUID();
}

export function monotonicNow(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function classifyError(error: unknown): TraceErrorCategory {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as {name?: unknown}).name;
    if (name === 'ContextBudgetError') return 'context_budget';
    if (name === 'AgentRunLimitError') {
      const limit = (error as {limit?: unknown}).limit;
      if (limit === 'iterations') return 'iteration_limit';
      return limit === 'cancelled' ? 'cancelled' : 'deadline';
    }
    if (name === 'ToolCancellationError') return 'cancelled';
  }
  return 'unknown';
}
