import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  AgentRunLimitError,
  runAgent,
} from '../src/agent.ts';
import type {AssistantMessage, ToolSpec} from '../src/types.ts';

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
