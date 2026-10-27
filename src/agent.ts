import {callModel} from './openrouter.ts';
import {ContextBudgetError, prepareContextWithMetadata, type ContextBudget} from './context.ts';
import {
  classifyError,
  createRunId,
  monotonicNow,
  noopTraceSink,
  type TraceSink,
} from './tracing.ts';
import {ToolCancellationError} from './types.ts';
import type {
  AgentRunResult,
  Message,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolSpec,
} from './types.ts';

/** Maximum model-request rounds in one run; tool replies stay within that round. */
export const MAX_AGENT_ITERATIONS = 12;
/** Maximum wall-clock duration of one run (two minutes). */
export const MAX_AGENT_DURATION_MS = 120_000;

export class AgentRunLimitError extends Error {
  constructor(
    readonly limit: 'iterations' | 'deadline' | 'cancelled',
    maxIterations = MAX_AGENT_ITERATIONS,
  ) {
    super(
      limit === 'iterations'
        ? `Agent stopped after ${maxIterations} model iterations.`
        : limit === 'cancelled'
          ? 'Agent run was cancelled.'
          : 'Agent stopped because its execution deadline expired.',
    );
    this.name = 'AgentRunLimitError';
  }
}

export interface AgentRunOptions {
  maxIterations?: number;
  maxDurationMs?: number;
  now?: () => number;
  callModel?: typeof callModel;
  contextBudget?: ContextBudget;
  signal?: AbortSignal;
  trace?: TraceSink;
  runId?: string;
}

export function validateToolArguments(
  definition: ToolDefinition,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object.');
  }

  const argumentsObject = value as Record<string, unknown>;
  const schema = definition.function.parameters;
  for (const name of schema.required ?? []) {
    if (!(name in argumentsObject)) {
      throw new Error(`Missing required tool argument: ${name}.`);
    }
  }

  for (const name of Object.keys(argumentsObject)) {
    const property = schema.properties[name];
    if (!property) {
      if (schema.additionalProperties === false) {
        throw new Error(`Unknown tool argument: ${name}.`);
      }
      continue;
    }

    const argument = argumentsObject[name];
    if (property.type === 'string' && typeof argument !== 'string') {
      throw new Error(`Tool argument ${name} must be a string.`);
    }
    if (
      property.minLength !== undefined &&
      typeof argument === 'string' &&
      argument.length < property.minLength
    ) {
      throw new Error(`Tool argument ${name} must not be empty.`);
    }
    if (
      property.maxLength !== undefined &&
      typeof argument === 'string' &&
      argument.length > property.maxLength
    ) {
      throw new Error(`Tool argument ${name} is too long.`);
    }
  }

  return argumentsObject;
}

async function safeTrace(
  sink: TraceSink,
  event: Parameters<TraceSink['emit']>[0],
): Promise<void> {
  try {
    await sink.emit(event);
  } catch {
    // Observability must never alter agent behavior.
  }
}

async function executeToolCalls(
  calls: ToolCall[],
  messages: Message[],
  tools: ToolSpec[],
  context: ToolContext,
  checkActive: () => void,
  trace: TraceSink,
  runId: string,
  iteration: number,
  now: () => number,
): Promise<void> {
  const toolMap = new Map(
    tools.map(tool => [tool.definition.function.name, tool]),
  );

  for (const call of calls) {
    checkActive();
    let result: ToolExecutionResult;
    const toolName = call.function.name;
    const toolStarted = now();
    await safeTrace(trace, {
      runId, type: 'tool.started', timestamp: new Date().toISOString(),
      iteration, toolName,
    });

    try {
      const tool = toolMap.get(call.function.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${call.function.name}`);
      }

      const value: unknown = JSON.parse(call.function.arguments);
      const validatedArguments = validateToolArguments(
        tool.definition,
        value,
      );

      checkActive();
      const toolContext: ToolContext = {
        ...context,
        approve: async (action, signal) => {
          await safeTrace(trace, {
            runId, type: 'tool.approval.requested', timestamp: new Date().toISOString(),
            iteration, toolName,
          });
          const approved = await context.approve(action, signal);
          await safeTrace(trace, {
            runId, type: 'tool.approval.resolved', timestamp: new Date().toISOString(),
            iteration, toolName, approved,
          });
          return approved;
        },
      };
      const data = await tool.execute(
        validatedArguments,
        toolContext,
      );
      checkActive();
      result = {ok: true, data};
    } catch (error) {
      if (error instanceof AgentRunLimitError) {
        if (error.limit !== 'iterations') {
          await safeTrace(trace, {
            runId, type: 'tool.failed', timestamp: new Date().toISOString(),
            iteration, toolName, durationMs: Math.max(0, now() - toolStarted),
            outcome: error.limit === 'deadline' ? 'deadline' : 'cancelled',
          });
        }
        throw error;
      }
      if (error instanceof ToolCancellationError) {
        const outcome = context.signal?.reason === 'deadline' ? 'deadline' : 'cancelled';
        await safeTrace(trace, {
          runId, type: 'tool.failed', timestamp: new Date().toISOString(),
          iteration, toolName, durationMs: Math.max(0, now() - toolStarted),
          outcome,
        });
        checkActive();
        throw new AgentRunLimitError('cancelled');
      }
      await safeTrace(trace, {
        runId, type: 'tool.failed', timestamp: new Date().toISOString(),
        iteration, toolName, durationMs: Math.max(0, now() - toolStarted),
        outcome: 'tool',
      });
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.ok) {
      await safeTrace(trace, {
        runId, type: 'tool.completed', timestamp: new Date().toISOString(),
        iteration, toolName, durationMs: Math.max(0, now() - toolStarted),
      });
    }

    context.emit(
      `Tool: ${call.function.name}\n${JSON.stringify(result, null, 2)}`,
    );
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }

}

const SYSTEM_PROMPT = `You are a small coding agent.
Use tools for every claim about workspace files and every local action.
Never claim an action succeeded without a matching tool result.
If a required tool is unavailable or an action is denied, say so clearly.
Return a concise response when the task is complete.`;

export async function runAgent(
  userInput: string,
  context: ToolContext,
  initialMessages: Message[] = [],
  tools: ToolSpec[] = [],
  options: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const now = options.now ?? Date.now;
  const trace = options.trace ?? noopTraceSink;
  const runId = options.runId ?? createRunId();
  const startedAt = monotonicNow();
  let terminalEmitted = false;
  await safeTrace(trace, {
    runId, type: 'run.started', timestamp: new Date().toISOString(),
  });
  const deadline = now() + (options.maxDurationMs ?? MAX_AGENT_DURATION_MS);
  const maxIterations = options.maxIterations ?? MAX_AGENT_ITERATIONS;
  const controller = new AbortController();
  const cancelRun = () => controller.abort('cancelled');
  options.signal?.addEventListener('abort', cancelRun, {once: true});
  if (options.signal?.aborted) controller.abort();
  const runContext: ToolContext = {...context, signal: controller.signal};
  const deadlineTimer = setTimeout(
    () => controller.abort('deadline'),
    Math.max(0, deadline - now()),
  );
  const checkActive = (): void => {
    if (now() >= deadline || controller.signal.reason === 'deadline') {
      throw new AgentRunLimitError('deadline');
    }
    if (controller.signal.aborted) throw new AgentRunLimitError('cancelled');
  };

  const messages: Message[] =
    initialMessages.length > 0
      ? [...initialMessages]
      : [{role: 'system', content: SYSTEM_PROMPT}];

  messages.push({role: 'user', content: userInput});

  let iteration = 0;
  try {
    while (true) {
      checkActive();
      if (iteration >= maxIterations) {
        throw new AgentRunLimitError('iterations', maxIterations);
      }

      iteration += 1;
      context.emit(`Model turn ${iteration}`);
      const modelStarted = monotonicNow();
      await safeTrace(trace, {
        runId, type: 'model.request.started', timestamp: new Date().toISOString(),
        iteration,
      });
      let assistant;
      try {
        const prepared = prepareContextWithMetadata(messages, options.contextBudget);
        await safeTrace(trace, {
          runId, type: 'context.prepared', timestamp: new Date().toISOString(),
          iteration,
          estimatedInputTokens: prepared.estimatedInputTokens,
          selectedGroupCount: prepared.selectedGroupCount,
          excludedGroupCount: prepared.excludedGroupCount,
          excludedMessageCount: prepared.excludedMessageCount,
        });
        assistant = await (options.callModel ?? callModel)(
          prepared.messages,
          tools,
          controller.signal,
        );
      } catch (error) {
        await safeTrace(trace, {
          runId, type: 'model.request.failed', timestamp: new Date().toISOString(),
          iteration, durationMs: Math.max(0, monotonicNow() - modelStarted),
          outcome: error instanceof ContextBudgetError ? 'context_budget' : classifyError(error) === 'unknown' ? 'model' : classifyError(error),
        });
        checkActive();
        throw error;
      }
      await safeTrace(trace, {
        runId, type: 'model.request.completed', timestamp: new Date().toISOString(),
        iteration, durationMs: Math.max(0, monotonicNow() - modelStarted),
      });
      checkActive();
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          messages,
          answer: assistant.content ?? 'No text returned.',
        };
      }

      await executeToolCalls(
        calls,
        messages,
        tools,
        runContext,
        checkActive,
        trace,
        runId,
        iteration,
        monotonicNow,
      );
    }
  } catch (error) {
    if (!terminalEmitted) {
      terminalEmitted = true;
      const category = classifyError(error);
      const traceCategory = category === 'unknown' ? 'model' : category;
      await safeTrace(trace, {
        runId,
        type: traceCategory === 'deadline' || traceCategory === 'cancelled'
          ? 'run.cancelled'
          : 'run.failed',
        timestamp: new Date().toISOString(),
        durationMs: Math.max(0, monotonicNow() - startedAt),
        outcome: traceCategory,
      });
    }
    throw error;
  } finally {
    if (!terminalEmitted) {
      terminalEmitted = true;
      await safeTrace(trace, {
        runId, type: 'run.completed', timestamp: new Date().toISOString(),
        durationMs: Math.max(0, monotonicNow() - startedAt),
      });
    }
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', cancelRun);
  }
}
