import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AgentRunLimitError, runAgent} from '../src/agent.ts';
import {ContextBudgetError} from '../src/context.ts';
import {loadSession, SESSION_LIMITS, validateSessionData} from '../src/session.ts';
import {MemoryTraceSink} from '../src/tracing.ts';
import {ToolCancellationError} from '../src/types.ts';
import type {
  AssistantMessage,
  Message,
  ToolSpec,
} from '../src/types.ts';

export interface EvaluationResult {
  id: string;
  name: string;
  passed: boolean;
  expectedOutcome: string;
  actualOutcome: string;
  failures: string[];
}

export interface EvaluationReport {
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  scenarios: Array<{
    id: string;
    name: string;
    status: 'passed' | 'failed';
    expected: string;
    actual: string;
    failures: string[];
  }>;
  error: string | null;
}

export interface EvaluationCliOptions {
  run?: () => Promise<EvaluationResult[]>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface Scenario {
  id: string;
  name: string;
  expectedOutcome: string;
  run(): Promise<void>;
}

const context = {
  workspaceRoot: process.cwd(),
  emit: () => {},
  approve: async () => true,
};

function tool(
  execute: ToolSpec['execute'],
  parameters: ToolSpec['definition']['function']['parameters'] = {
    type: 'object',
    properties: {},
  },
): ToolSpec {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'sample_tool',
        description: 'Controlled evaluation tool.',
        parameters,
      },
    },
    execute,
  };
}

function toolCall(
  argumentsText = '{}',
  name = 'sample_tool',
): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'evaluation-call',
      type: 'function',
      function: {name, arguments: argumentsText},
    }],
  };
}

function terminalEvents(sink: MemoryTraceSink): string[] {
  return sink.events
    .filter(event =>
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled')
    .map(event => event.type);
}

function modelToolSequence(sink: MemoryTraceSink): string[] {
  return sink.events
    .filter(event =>
      event.type === 'model.request.started' ||
      event.type === 'model.request.completed' ||
      event.type === 'tool.started' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed')
    .map(event => event.type);
}

function scenario(
  id: string,
  name: string,
  expectedOutcome: string,
  run: () => Promise<void>,
): Scenario {
  return {id, name, expectedOutcome, run};
}

const scenarios: Scenario[] = [
  scenario(
    'successful-tool-use',
    'Successful tool use preserves the protocol exchange',
    'valid tool executes once, result reaches the next model request, run completes',
    async () => {
      const sink = new MemoryTraceSink();
      const requests: Message[][] = [];
      let executions = 0;
      let modelCalls = 0;
      const parameters = {
        type: 'object' as const,
        properties: {value: {type: 'string'}},
        required: ['value'],
        additionalProperties: false,
      };
      const result = await runAgent(
        'use the controlled tool',
        context,
        [],
        [tool(async args => {
          executions++;
          assert.equal(args.value, 'accepted');
          return 'controlled result';
        }, parameters)],
        {
          trace: sink,
          callModel: async messages => {
            requests.push(messages);
            modelCalls++;
            return modelCalls === 1
              ? toolCall('{"value":"accepted"}')
              : {role: 'assistant', content: 'complete'};
          },
        },
      );

      assert.equal(result.answer, 'complete');
      assert.equal(executions, 1);
      assert.equal(requests.length, 2);
      assert.ok(requests[1].some(message =>
        message.role === 'tool' &&
        message.tool_call_id === 'evaluation-call' &&
        message.content.includes('controlled result')));
      assert.deepEqual(modelToolSequence(sink), [
        'model.request.started',
        'model.request.completed',
        'tool.started',
        'tool.completed',
        'model.request.started',
        'model.request.completed',
      ]);
      assert.deepEqual(terminalEvents(sink), ['run.completed']);
    },
  ),
  scenario(
    'invalid-tool-calls',
    'Invalid model tool calls become controlled tool results',
    'unknown, malformed, mistyped, missing, and extra arguments never execute',
    async () => {
      const cases = [
        {name: 'unknown', argumentsText: '{}', toolName: 'missing_tool'},
        {name: 'malformed', argumentsText: '{'},
        {name: 'wrong-type', argumentsText: '{"value":4}'},
        {name: 'missing-required', argumentsText: '{}'},
        {name: 'unexpected-property', argumentsText: '{"value":"ok","extra":true}'},
      ];
      const parameters = {
        type: 'object' as const,
        properties: {value: {type: 'string'}},
        required: ['value'],
        additionalProperties: false,
      };

      for (const testCase of cases) {
        const sink = new MemoryTraceSink();
        let executions = 0;
        let modelCalls = 0;
        const result = await runAgent(
          testCase.name,
          context,
          [],
          [tool(async () => {
            executions++;
            return 'must not execute';
          }, parameters)],
          {
            trace: sink,
            callModel: async messages => {
              modelCalls++;
              if (modelCalls === 1) {
                return toolCall(testCase.argumentsText, testCase.toolName);
              }
              assert.ok(messages.some(message =>
                message.role === 'tool' &&
                message.content.includes('"ok":false')));
              return {role: 'assistant', content: 'recovered'};
            },
          },
        );
        assert.equal(result.answer, 'recovered', testCase.name);
        assert.equal(executions, 0, testCase.name);
        assert.ok(sink.events.some(event =>
          event.type === 'tool.failed'), testCase.name);
      }
    },
  ),
  scenario(
    'approval-side-effect-safety',
    'Approval and cancellation protect side effects',
    'approved operation runs; denied and cancelled operations do not',
    async () => {
      let sideEffects = 0;
      let modelCalls = 0;
      await runAgent(
        'approved operation',
        context,
        [],
        [tool(async (_args, toolContext) => {
          assert.equal(await toolContext.approve('private action', toolContext.signal), true);
          sideEffects++;
          return 'approved';
        })],
        {
          callModel: async () => {
            modelCalls++;
            return modelCalls === 1
              ? toolCall()
              : {role: 'assistant', content: 'done'};
          },
        },
      );

      let deniedCalls = 0;
      modelCalls = 0;
      await runAgent(
        'denied operation',
        {...context, approve: async () => false},
        [],
        [tool(async (_args, toolContext) => {
          if (await toolContext.approve('denied action', toolContext.signal)) {
            deniedCalls++;
          }
          return 'denied';
        })],
        {
          callModel: async () => {
            modelCalls++;
            return modelCalls === 1
              ? toolCall()
              : {role: 'assistant', content: 'done'};
          },
        },
      );

      const controller = new AbortController();
      let cancellationSideEffects = 0;
      modelCalls = 0;
      const cancelledRun = runAgent(
        'cancelled operation',
        {...context, approve: async () => {
          controller.abort();
          return true;
        }},
        [],
        [tool(async (_args, toolContext) => {
          await toolContext.approve('cancelled action', toolContext.signal);
          if (toolContext.signal?.aborted) throw new ToolCancellationError();
          cancellationSideEffects++;
          return 'must not complete';
        })],
        {
          signal: controller.signal,
          callModel: async () => {
            modelCalls++;
            return modelCalls === 1
              ? toolCall()
              : {role: 'assistant', content: 'done'};
          },
        },
      );

      await assert.rejects(cancelledRun, (error: unknown) =>
        error instanceof AgentRunLimitError && error.limit === 'deadline');
      assert.equal(sideEffects, 1);
      assert.equal(deniedCalls, 0);
      assert.equal(cancellationSideEffects, 0);
    },
  ),
  scenario(
    'execution-limits-and-failures',
    'Failures and limits produce non-success terminal outcomes',
    'model, tool, iteration, deadline, cancellation, and context failures classify correctly',
    async () => {
      const modelFailure = new MemoryTraceSink();
      await assert.rejects(runAgent('model failure', context, [], [], {
        trace: modelFailure,
        callModel: async () => { throw new Error('private model failure'); },
      }));
      assert.equal(modelFailure.events.find(event => event.type === 'run.failed')?.outcome, 'model');

      const toolFailure = new MemoryTraceSink();
      let modelCalls = 0;
      await runAgent('tool failure', context, [], [tool(async () => {
        throw new Error('private tool failure');
      })], {
        trace: toolFailure,
        callModel: async messages => {
          modelCalls++;
          if (modelCalls === 2) {
            assert.ok(messages.some(message =>
              message.role === 'tool' && message.content.includes('private tool failure')));
          }
          return modelCalls === 1
            ? toolCall()
            : {role: 'assistant', content: 'recovered'};
        },
      });
      assert.equal(toolFailure.events.find(event => event.type === 'tool.failed')?.outcome, 'tool');
      assert.equal(toolFailure.events.find(event => event.type === 'run.completed')?.type, 'run.completed');

      const iterationLimit = new MemoryTraceSink();
      await assert.rejects(runAgent('iteration limit', context, [], [], {
        trace: iterationLimit,
        maxIterations: 1,
        callModel: async () => toolCall(),
      }));
      assert.equal(iterationLimit.events.find(event => event.type === 'run.failed')?.outcome, 'iteration_limit');

      const deadline = new MemoryTraceSink();
      let currentTime = 0;
      await assert.rejects(runAgent('deadline', context, [], [], {
        trace: deadline,
        maxDurationMs: 10,
        now: () => currentTime,
        callModel: async () => {
          currentTime = 11;
          return {role: 'assistant', content: 'late'};
        },
      }));
      assert.equal(deadline.events.find(event => event.type === 'run.cancelled')?.outcome, 'deadline');

      const cancellation = new MemoryTraceSink();
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(runAgent('cancelled', context, [], [], {
        trace: cancellation,
        signal: controller.signal,
        callModel: async () => ({role: 'assistant', content: 'never'}),
      }));
      assert.equal(cancellation.events.find(event => event.type === 'run.cancelled')?.outcome, 'cancelled');

      const contextFailure = new MemoryTraceSink();
      await assert.rejects(runAgent('x'.repeat(100), context, [], [], {
        trace: contextFailure,
        contextBudget: {maxInputTokens: 2},
        callModel: async () => ({role: 'assistant', content: 'never'}),
      }), ContextBudgetError);
      assert.equal(contextFailure.events.find(event => event.type === 'run.failed')?.outcome, 'context_budget');
    },
  ),
  scenario(
    'context-management',
    'Context preparation is bounded and preserves protocol groups',
    'older exchanges are excluded, tool exchanges remain intact, and history is unchanged',
    async () => {
      const initialMessages: Message[] = [
        {role: 'system', content: 'instructions'},
        {role: 'user', content: 'old '.repeat(100)},
        {role: 'assistant', content: 'old answer'},
      ];
      const original = structuredClone(initialMessages);
      const requests: Message[][] = [];
      const sink = new MemoryTraceSink();
      let modelCalls = 0;
      const result = await runAgent(
        'latest',
        context,
        initialMessages,
        [tool(async () => 'tool result')],
        {
          trace: sink,
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
      assert.ok(requests[1].some(message => message.role === 'tool'));
      assert.deepEqual(initialMessages, original);
      assert.ok(sink.events.some(event =>
        event.type === 'context.prepared' &&
        event.excludedGroupCount > 0));
      await assert.rejects(runAgent('too large', context, [], [], {
        contextBudget: {maxInputTokens: 2},
        callModel: async () => ({role: 'assistant', content: 'never'}),
      }), ContextBudgetError);
    },
  ),
  scenario(
    'session-recovery',
    'Session recovery isolates invalid persisted state',
    'missing, malformed, invalid, oversized, and valid sessions have expected recovery behavior',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agent-harness-evaluation-'));
      try {
        assert.deepEqual(await loadSession(join(directory, 'missing.json')), []);

        const malformed = join(directory, 'malformed.json');
        await writeFile(malformed, '{', 'utf8');
        assert.deepEqual(await loadSession(malformed), []);

        const invalid = join(directory, 'invalid.json');
        await writeFile(invalid, JSON.stringify([{role: 'user', content: 4}]), 'utf8');
        assert.deepEqual(await loadSession(invalid), []);

        const oversized = join(directory, 'oversized.json');
        await writeFile(oversized, 'x'.repeat(SESSION_LIMITS.maxFileBytes + 1), 'utf8');
        assert.deepEqual(await loadSession(oversized), []);

        const validMessages: Message[] = [
          {role: 'user', content: 'hello'},
          {role: 'assistant', content: 'done'},
        ];
        const valid = join(directory, 'valid.json');
        await writeFile(valid, JSON.stringify(validMessages), 'utf8');
        assert.deepEqual(await loadSession(valid), validMessages);
        assert.deepEqual(validateSessionData(validMessages), validMessages);
        assert.equal(await readFile(valid, 'utf8'), JSON.stringify(validMessages));
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    },
  ),
  scenario(
    'tracing-integrity',
    'Tracing reflects runtime behavior without private content',
    'run IDs, lifecycle order, approvals, terminal uniqueness, and redaction are correct',
    async () => {
      const sink = new MemoryTraceSink();
      const secret = 'EVALUATION_PRIVATE_VALUE';
      let modelCalls = 0;
      await runAgent(secret, {
        ...context,
        approve: async () => false,
      }, [], [tool(async (_args, toolContext) => {
        await toolContext.approve(secret, toolContext.signal);
        return secret;
      })], {
        trace: sink,
        callModel: async () => {
          modelCalls++;
          return modelCalls === 1
            ? toolCall('{"secret":"EVALUATION_PRIVATE_VALUE"}')
            : {role: 'assistant', content: secret};
        },
      });

      assert.equal(new Set(sink.events.map(event => event.runId)).size, 1);
      assert.deepEqual(terminalEvents(sink), ['run.completed']);
      assert.ok(sink.events.some(event => event.type === 'tool.approval.requested'));
      assert.equal(sink.events.find(event => event.type === 'tool.approval.resolved')?.approved, false);
      assert.ok(sink.events.every(event => !JSON.stringify(event).includes(secret)));
      for (const event of sink.events) {
        if ('durationMs' in event) assert.ok(event.durationMs >= 0);
      }

      const failingSink = new MemoryTraceSink();
      let result = '';
      result = await runAgent('sink failure', context, [], [], {
        trace: {emit: async () => { throw new Error('private sink failure'); }},
        callModel: async () => ({role: 'assistant', content: 'still works'}),
      }).then(run => run.answer);
      assert.equal(result, 'still works');
      assert.ok(failingSink.events.length === 0);
    },
  ),
];

export async function runEvaluations(): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  for (const current of scenarios) {
    try {
      await current.run();
      results.push({
        id: current.id,
        name: current.name,
        passed: true,
        expectedOutcome: current.expectedOutcome,
        actualOutcome: 'scenario completed without assertion failures',
        failures: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: current.id,
        name: current.name,
        passed: false,
        expectedOutcome: current.expectedOutcome,
        actualOutcome: 'scenario threw or violated an assertion',
        failures: [message],
      });
    }
  }
  return results;
}

export function createEvaluationReport(
  results: EvaluationResult[],
  error: string | null = null,
): EvaluationReport {
  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;
  return {
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: results.length === 0 ? 0 : passed / results.length,
    },
    scenarios: results.map(result => ({
      id: result.id,
      name: result.name,
      status: result.passed ? 'passed' : 'failed',
      expected: result.expectedOutcome,
      actual: result.actualOutcome,
      failures: result.failures,
    })),
    error,
  };
}

export function parseEvaluationArgs(args: string[]): {json: boolean} {
  const unsupported = args.find(arg => arg !== '--json');
  if (unsupported) {
    throw new Error(`Unsupported option: ${unsupported}`);
  }
  return {json: args.includes('--json')};
}

function formatHumanReadable(report: EvaluationReport): string {
  const lines: string[] = [];
  for (const result of report.scenarios) {
    lines.push(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id}: ${result.name}`);
    if (result.status === 'failed') {
      for (const failure of result.failures) lines.push(`  ${failure}`);
    }
  }
  lines.push(
    `Summary: ${report.summary.passed}/${report.summary.total} passed ` +
    `(${(report.summary.passRate * 100).toFixed(1)}%)`,
  );
  return `${lines.join('\n')}\n`;
}

export async function runEvaluationCli(
  args: string[] = process.argv.slice(2),
  options: EvaluationCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? (text => process.stdout.write(text));
  const stderr = options.stderr ?? (text => process.stderr.write(text));
  let parsedArgs: {json: boolean};
  try {
    parsedArgs = parseEvaluationArgs(args);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    const results = await (options.run ?? runEvaluations)();
    const report = createEvaluationReport(results);
    stdout(parsedArgs.json
      ? `${JSON.stringify(report)}\n`
      : formatHumanReadable(report));
    return report.summary.failed > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${message}\n`);
    if (parsedArgs.json) {
      stdout(`${JSON.stringify(createEvaluationReport([], message))}\n`);
    }
    return 1;
  }
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runEvaluationCli();
}
