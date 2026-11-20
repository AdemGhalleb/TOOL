import {randomUUID} from 'node:crypto';

export type TraceErrorCategory =
  | 'cancelled'
  | 'context_budget'
  | 'deadline'
  | 'iteration_limit'
  | 'model'
  | 'provider_authentication'
  | 'provider_invalid_request'
  | 'provider_rate_limit'
  | 'provider_server'
  | 'provider_network'
  | 'provider_timeout'
  | 'provider_invalid_response'
  | 'provider_validation'
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
  type:
    | 'model.request.started'
    | 'model.request.completed'
    | 'model.request.failed'
    | 'model.retry'
    | 'model.validation_failed';
  iteration: number;
  durationMs?: number;
  outcome?: TraceErrorCategory;
  attempt?: number;
  delayMs?: number;
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
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as {kind?: unknown}).kind;
    if (kind === 'authentication') return 'provider_authentication';
    if (kind === 'invalid_request') return 'provider_invalid_request';
    if (kind === 'rate_limit') return 'provider_rate_limit';
    if (kind === 'server') return 'provider_server';
    if (kind === 'network') return 'provider_network';
    if (kind === 'timeout') return 'provider_timeout';
    if (kind === 'aborted') return 'cancelled';
    if (
      kind === 'invalid_json' ||
      kind === 'invalid_response' ||
      kind === 'empty_response' ||
      kind === 'unexpected_finish' ||
      kind === 'malformed_tool_call'
    ) return 'provider_validation';
  }
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
