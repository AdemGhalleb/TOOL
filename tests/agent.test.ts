import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  AgentRunLimitError,
  runAgent,
  validateToolArguments,
} from '../src/agent.ts';
import {ToolCancellationError} from '../src/types.ts';
import type {AssistantMessage, Message, ToolSpec} from '../src/types.ts';

const context = {
  workspaceRoot: process.cwd(),
  emit: () => {},
  approve: async () => true,
};

function tool(execute: ToolSpec['execute']): ToolSpec {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'sample_tool',
        description: 'Test tool',
        parameters: {type: 'object', properties: {}},
      },
    },
    execute,
  };
}

function toolCall(content: string | null = null): AssistantMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {name: 'sample_tool', arguments: '{}'},
      },
    ],
  };
}

function customToolCall(argumentsText: string, name = 'sample_tool'): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {name, arguments: argumentsText},
      },
    ],
  };
}

test('runAgent returns a normal final answer before either limit', async () => {
  const result = await runAgent(
    'hello',
    context,
    [],
    [],
    {callModel: async () => ({role: 'assistant', content: 'done'})},
  );

  assert.equal(result.answer, 'done');
});

test('repeated model requests receive bounded contexts without shrinking run history', async () => {
  const requests: Message[][] = [];
  let modelCalls = 0;
  const initialMessages: Message[] = [
    {role: 'system', content: 'instructions'},
    {role: 'user', content: 'old '.repeat(100)},
    {role: 'assistant', content: 'old answer'},
  ];

  const result = await runAgent(
    'latest',
    context,
    initialMessages,
    [tool(async () => 'ok')],
    {
      maxIterations: 2,
      contextBudget: {maxInputTokens: 45},
      callModel: async messages => {
        requests.push(messages);
        modelCalls++;
        return modelCalls === 1
          ? toolCall()
          : {role: 'assistant', content: 'done'};
      },
    },
  );

  assert.equal(result.answer, 'done');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].some(message => message.content === 'old '.repeat(100)), false);
  assert.equal(requests[1].some(message => message.role === 'tool'), true);
  assert.equal(initialMessages.length, 3);
  assert.equal(result.messages.length, 7);
});

test('runAgent stops after the configured number of model iterations', async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  await assert.rejects(
    runAgent(
      'repeat',
      context,
      [],
      [tool(async () => { toolCalls += 1; return 'ok'; })],
      {
        maxIterations: 2,
        callModel: async () => { modelCalls += 1; return toolCall(); },
      },
    ),
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'iterations',
  );
  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 2);
});

test('a tool response cannot reset or bypass the iteration limit', async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  await assert.rejects(
    runAgent(
      'keep going',
      context,
      [],
      [tool(async () => { toolCalls += 1; return 'ok'; })],
      {
        maxIterations: 3,
        callModel: async () => {
          modelCalls += 1;
          return toolCall();
        },
      },
    ),
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'iterations',
  );
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 3);
});

test('deadline exhaustion prevents a returned tool call from starting', async () => {
  let currentTime = 0;
  let toolCalls = 0;
  await assert.rejects(
    runAgent(
      'run a tool',
      context,
      [],
      [tool(async () => { toolCalls += 1; return 'unexpected'; })],
      {
        maxDurationMs: 100_000,
        now: () => currentTime,
        callModel: async () => {
          currentTime = 100_001;
          return toolCall();
        },
      },
    ),
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'deadline',
  );
  assert.equal(toolCalls, 0);
});

test('deadline is established once and prevents a later model request', async () => {
  let currentTime = 0;
  let modelCalls = 0;
  await assert.rejects(
    runAgent(
      'continue',
      context,
      [],
      [tool(async () => { currentTime = 100_001; return 'ok'; })],
      {
        maxDurationMs: 100_000,
        now: () => currentTime,
        callModel: async () => {
          modelCalls += 1;
          return toolCall();
        },
      },
    ),
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'deadline',
  );
  assert.equal(modelCalls, 1);
});

test('tool errors remain tool results and the model can complete normally', async () => {
  let modelCalls = 0;
  const result = await runAgent(
    'try the tool',
    context,
    [],
    [tool(async () => { throw new Error('expected tool failure'); })],
    {
      callModel: async messages => {
        modelCalls += 1;
        if (modelCalls === 1) return toolCall();
        const toolMessage = messages.find(message => message.role === 'tool');
        assert.ok(toolMessage && toolMessage.content.includes('expected tool failure'));
        return {role: 'assistant', content: 'completed with the tool error'};
      },
    },
  );

  assert.equal(result.answer, 'completed with the tool error');
});

test('runtime validation rejects malformed and non-object arguments', () => {
  const definition = tool(() => Promise.resolve()).definition;

  for (const value of [null, [], 'text', 42]) {
    assert.throws(
      () => validateToolArguments(definition, value),
      /Tool arguments must be a JSON object/,
    );
  }
});

test('runtime validation rejects missing, mistyped, and unknown arguments', () => {
  const definition = {
    ...tool(() => Promise.resolve()).definition,
    function: {
      ...tool(() => Promise.resolve()).definition.function,
      parameters: {
        type: 'object' as const,
        properties: {
          path: {type: 'string' as const, minLength: 1},
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };

  assert.throws(
    () => validateToolArguments(definition, {}),
    /Missing required tool argument: path/,
  );
  assert.throws(
    () => validateToolArguments(definition, {path: 7}),
    /Tool argument path must be a string/,
  );
  assert.throws(
    () => validateToolArguments(definition, {path: ''}),
    /Tool argument path must not be empty/,
  );
  assert.throws(
    () => validateToolArguments(definition, {path: 'ok', extra: true}),
    /Unknown tool argument: extra/,
  );
});

test('invalid tool calls become controlled tool errors without dispatch', async () => {
  let executions = 0;
  let modelCalls = 0;
  const result = await runAgent(
    'validate arguments',
    context,
    [],
    [tool(async () => { executions += 1; return 'must not run'; })],
    {
      callModel: async messages => {
        modelCalls += 1;
        if (modelCalls === 1) return customToolCall('{');
        const toolMessage = messages.find(message => message.role === 'tool');
        assert.ok(toolMessage?.content.includes('JSON'));
        return {role: 'assistant', content: 'recovered'};
      },
    },
  );

  assert.equal(result.answer, 'recovered');
  assert.equal(executions, 0);
});

test('unknown tools are controlled errors and do not dispatch a fallback', async () => {
  let modelCalls = 0;
  const result = await runAgent(
    'unknown tool',
    context,
    [],
    [],
    {
      callModel: async messages => {
        modelCalls += 1;
        if (modelCalls === 1) return customToolCall('{}', 'not_a_tool');
        assert.ok(messages.some(message => message.role === 'tool'));
        return {role: 'assistant', content: 'recovered'};
      },
    },
  );

  assert.equal(result.answer, 'recovered');
});

test('a cancelled run cannot start a tool operation', async () => {
  const controller = new AbortController();
  controller.abort();
  let toolCalls = 0;

  await assert.rejects(
    runAgent(
      'cancelled',
      context,
      [],
      [tool(async () => { toolCalls += 1; return 'unexpected'; })],
      {signal: controller.signal, callModel: async () => toolCall()},
    ),
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'deadline',
  );
  assert.equal(toolCalls, 0);
});

test('cancellation rejects a pending approval and prevents its side effect', async () => {
  const controller = new AbortController();
  let approvalReject: ((error: unknown) => void) | undefined;
  let sideEffects = 0;
  const approvalContext = {
    ...context,
    approve: (_action: string, signal?: AbortSignal) =>
      new Promise<boolean>((resolve, reject) => {
        approvalReject = reject;
        signal?.addEventListener(
          'abort',
          () => reject(new ToolCancellationError()),
          {once: true},
        );
      }),
  };

  const run = runAgent(
    'approve later',
    approvalContext,
    [],
    [tool(async (_args, toolContext) => {
      await toolContext.approve('protected action', toolContext.signal);
      if (toolContext.signal?.aborted) throw new ToolCancellationError();
      sideEffects += 1;
      return 'done';
    })],
    {signal: controller.signal, callModel: async () => toolCall()},
  );

  await new Promise<void>(resolve => queueMicrotask(resolve));
  controller.abort();
  approvalReject?.(new ToolCancellationError());

  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof AgentRunLimitError && error.limit === 'deadline',
  );
  assert.equal(sideEffects, 0);
});

test('approval cancellation is isolated to its own run', async () => {
  const cancelled = new AbortController();
  const other = new AbortController();
  let cancelledCalls = 0;
  let otherCalls = 0;

  const makeContext = (counter: {value: number}) => ({
    ...context,
    approve: async (_action: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new ToolCancellationError();
      return true;
    },
  });

  cancelled.abort();
  await assert.rejects(
    runAgent(
      'cancel one',
      makeContext({value: cancelledCalls}),
      [],
      [tool(async () => { cancelledCalls += 1; return 'no'; })],
      {signal: cancelled.signal, callModel: async () => toolCall()},
    ),
    AgentRunLimitError,
  );

  const result = await runAgent(
    'continue other',
    makeContext({value: otherCalls}),
    [],
    [tool(async () => { otherCalls += 1; return 'ok'; })],
    {
      signal: other.signal,
      maxIterations: 1,
      callModel: async () => toolCall(),
    },
  ).catch(error => error);
  assert.ok(result instanceof AgentRunLimitError);
  assert.equal(cancelledCalls, 0);
  assert.equal(otherCalls, 1);
});
