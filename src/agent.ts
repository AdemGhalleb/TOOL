import {callModel} from './openrouter.ts';
import type {
  AgentRunResult,
  Message,
  ToolCall,
  ToolContext,
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Tool arguments must decode to a JSON object.');
      }

      checkDeadline();
      const data = await tool.execute(
        value as Record<string, unknown>,
        context,
      );
      result = {ok: true, data};
    } catch (error) {
      if (error instanceof AgentRunLimitError) throw error;
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
          messages,
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

      await executeToolCalls(calls, messages, tools, context, checkDeadline);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}
