import {callModel} from './openrouter.ts';
import {prepareContext, type ContextBudget} from './context.ts';
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
    readonly limit: 'iterations' | 'deadline',
    maxIterations = MAX_AGENT_ITERATIONS,
  ) {
    super(
      limit === 'iterations'
        ? `Agent stopped after ${maxIterations} model iterations.`
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

async function executeToolCalls(
  calls: ToolCall[],
  messages: Message[],
  tools: ToolSpec[],
  context: ToolContext,
  checkDeadline: () => void,
): Promise<void> {
  const toolMap = new Map(
    tools.map(tool => [tool.definition.function.name, tool]),
  );

  for (const call of calls) {
    let result: ToolExecutionResult;

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

      checkDeadline();
      const data = await tool.execute(
        validatedArguments,
        context,
      );
      result = {ok: true, data};
    } catch (error) {
      if (error instanceof AgentRunLimitError) throw error;
      if (error instanceof ToolCancellationError) {
        throw new AgentRunLimitError('deadline');
      }
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
  const deadline = now() + (options.maxDurationMs ?? MAX_AGENT_DURATION_MS);
  const maxIterations = options.maxIterations ?? MAX_AGENT_ITERATIONS;
  const controller = new AbortController();
  const cancelRun = () => controller.abort();
  options.signal?.addEventListener('abort', cancelRun, {once: true});
  if (options.signal?.aborted) controller.abort();
  const runContext: ToolContext = {...context, signal: controller.signal};
  const deadlineTimer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - now()),
  );
  const checkDeadline = (): void => {
    if (now() >= deadline || controller.signal.aborted) {
      throw new AgentRunLimitError('deadline');
    }
  };

  const messages: Message[] =
    initialMessages.length > 0
      ? [...initialMessages]
      : [{role: 'system', content: SYSTEM_PROMPT}];

  messages.push({role: 'user', content: userInput});

  let iteration = 0;
  try {
    while (true) {
      checkDeadline();
      if (iteration >= maxIterations) {
        throw new AgentRunLimitError('iterations', maxIterations);
      }

      iteration += 1;
      context.emit(`Model turn ${iteration}`);
      let assistant;
      try {
        assistant = await (options.callModel ?? callModel)(
          prepareContext(messages, options.contextBudget),
          tools,
          controller.signal,
        );
      } catch (error) {
        if (now() >= deadline || controller.signal.aborted) {
          throw new AgentRunLimitError('deadline');
        }
        throw error;
      }
      checkDeadline();
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
        checkDeadline,
      );
    }
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', cancelRun);
  }
}
