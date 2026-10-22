import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runAgent} from '../src/agent.ts';
import {MemoryTraceSink} from '../src/tracing.ts';
import type {AssistantMessage, ToolSpec} from '../src/types.ts';

const context = {
  workspaceRoot: process.cwd(),
  emit: () => {},
  approve: async () => true,
};

function call(name = 'sample_tool'): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: {name, arguments: '{}'},
    }],
  };
}

const sampleTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'sample_tool',
      description: 'test',
      parameters: {type: 'object', properties: {}},
    },
  },
  execute: async () => 'private tool result',
};

test('one run id is shared by all events and successful runs have one terminal event', async () => {
  const sink = new MemoryTraceSink();
  let calls = 0;
  await runAgent('private prompt', context, [], [sampleTool], {
    trace: sink,
    callModel: async () => {
      calls++;
      return calls === 1 ? call() : {role: 'assistant', content: 'private answer'};
    },
  });

  assert.ok(sink.events.length > 0);
  assert.equal(new Set(sink.events.map(event => event.runId)).size, 1);
  assert.equal(sink.events.filter(event =>
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.cancelled').length, 1);
  assert.ok(sink.events.some(event => event.type === 'context.prepared'));
  assert.ok(sink.events.every(event => !JSON.stringify(event).includes('private')));
});

test('model failures, iteration limits, deadlines, and cancellation are classified safely', async () => {
  const modelFailure = new MemoryTraceSink();
  await assert.rejects(runAgent('x', context, [], [], {
    trace: modelFailure,
    callModel: async () => { throw new Error('secret model response'); },
  }));
  assert.deepEqual(
    modelFailure.events.filter(event => event.type === 'run.failed').map(event => event.outcome),
    ['model'],
  );
  assert.equal(JSON.stringify(modelFailure.events).includes('secret'), false);

  const limit = new MemoryTraceSink();
  await assert.rejects(runAgent('x', context, [], [], {
    trace: limit,
    maxIterations: 1,
    callModel: async () => call(),
  }));
  assert.equal(limit.events.find(event => event.type === 'run.failed')?.outcome, 'iteration_limit');

  const cancelled = new MemoryTraceSink();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAgent('x', context, [], [], {
    trace: cancelled,
    signal: controller.signal,
    callModel: async () => ({role: 'assistant', content: 'never'}),
  }));
  assert.equal(cancelled.events.find(event => event.type === 'run.cancelled')?.outcome, 'cancelled');

  const deadline = new MemoryTraceSink();
  let currentTime = 0;
  await assert.rejects(runAgent('x', context, [], [], {
    trace: deadline,
    maxDurationMs: 10,
    now: () => currentTime,
    callModel: async () => {
      currentTime = 11;
      return {role: 'assistant', content: 'late'};
    },
  }));
  assert.equal(deadline.events.find(event => event.type === 'run.cancelled')?.outcome, 'deadline');

  const contextBudget = new MemoryTraceSink();
  await assert.rejects(runAgent('x'.repeat(100), context, [], [], {
    trace: contextBudget,
    contextBudget: {maxInputTokens: 2},
    callModel: async () => ({role: 'assistant', content: 'never'}),
  }));
  assert.equal(contextBudget.events.find(event => event.type === 'model.request.failed')?.outcome, 'context_budget');
  assert.equal(contextBudget.events.find(event => event.type === 'run.failed')?.outcome, 'context_budget');
});

test('model and tool lifecycle events include non-negative durations and approvals record decisions', async () => {
  const sink = new MemoryTraceSink();
  const approvedTool: ToolSpec = {
    ...sampleTool,
    execute: async (_args, toolContext) => {
      const approved = await toolContext.approve('private action', toolContext.signal);
      return {approved, secret: 'private result'};
    },
  };
  let calls = 0;
  await runAgent('private prompt', {
    ...context,
    approve: async () => false,
  }, [], [approvedTool], {
    trace: sink,
    callModel: async () => {
      calls++;
      return calls === 1 ? call() : {role: 'assistant', content: 'done'};
    },
  });

  assert.ok(sink.events.some(event => event.type === 'model.request.started'));
  assert.ok(sink.events.some(event => event.type === 'model.request.completed'));
  assert.ok(sink.events.some(event => event.type === 'tool.started'));
  assert.ok(sink.events.some(event => event.type === 'tool.completed'));
  assert.equal(sink.events.find(event => event.type === 'tool.approval.resolved')?.approved, false);
  for (const event of sink.events) {
    if ('durationMs' in event) assert.ok(event.durationMs >= 0);
  }
});

test('sink failures do not disrupt the agent', async () => {
  const sink = {emit: async () => { throw new Error('sink failure'); }};
  const result = await runAgent('x', context, [], [], {
    trace: sink,
    callModel: async () => ({role: 'assistant', content: 'done'}),
  });
  assert.equal(result.answer, 'done');
});

test('tool failures are traced without arguments, results, or raw errors', async () => {
  const sink = new MemoryTraceSink();
  const failingTool = {...sampleTool, execute: async () => {
    throw new Error('secret tool error');
  }};
  let calls = 0;
  await runAgent('secret prompt', context, [], [failingTool], {
    trace: sink,
    callModel: async () => {
      calls++;
      return calls === 1 ? call() : {role: 'assistant', content: 'done'};
    },
  });
  assert.ok(sink.events.some(event => event.type === 'tool.failed'));
  assert.equal(JSON.stringify(sink.events).includes('secret'), false);
});
