import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  callModel,
  normalizeAssistantMessage,
  ProviderError,
} from '../src/openrouter.ts';
import type {Message} from '../src/types.ts';

const messages: Message[] = [{role: 'user', content: 'hello'}];

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', ...headers},
  });
}

test('transient provider failure retries once and succeeds', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await callModel(messages, [], undefined, {
    apiKey: 'test-key',
    fetchFn: (async () => {
      attempts++;
      return attempts === 1
        ? jsonResponse(500, {error: 'private'})
        : jsonResponse(200, {
            choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'done'}}],
          });
    }) as typeof fetch,
    wait: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result.content, 'done');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

test('exhausted retries stop with a classified server error', async () => {
  let attempts = 0;
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      maxRetries: 1,
      fetchFn: (async () => {
        attempts++;
        return jsonResponse(503, {error: 'private'});
      }) as typeof fetch,
      wait: async () => {},
    }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.kind === 'server' &&
      error.transient,
  );
  assert.equal(attempts, 2);
});

test('authentication and malformed-request failures are not retried', async () => {
  for (const status of [400, 401, 403]) {
    let attempts = 0;
    await assert.rejects(
      callModel(messages, [], undefined, {
        apiKey: 'test-key',
        fetchFn: (async () => {
          attempts++;
          return jsonResponse(status, {error: 'Bearer secret'});
        }) as typeof fetch,
        wait: async () => { throw new Error('wait should not run'); },
      }),
      ProviderError,
    );
    assert.equal(attempts, 1);
  }
});

test('HTTP 429 respects Retry-After and remains bounded', async () => {
  let attempts = 0;
  const waits: number[] = [];
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      maxRetries: 1,
      fetchFn: (async () => {
        attempts++;
        return jsonResponse(429, {error: 'private'}, {'retry-after': '2'});
      }) as typeof fetch,
      wait: async milliseconds => { waits.push(milliseconds); },
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'rate_limit',
  );
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2000]);
});

test('network failures are transient and retried', async () => {
  let attempts = 0;
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      maxRetries: 1,
      fetchFn: (async () => {
        attempts++;
        throw new TypeError('socket failure');
      }) as typeof fetch,
      wait: async () => {},
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'network',
  );
  assert.equal(attempts, 2);
});

test('malformed JSON and unexpected structures are permanent validation failures', async () => {
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      fetchFn: (async () => new Response('{', {status: 200})) as typeof fetch,
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'invalid_json',
  );
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      fetchFn: (async () => jsonResponse(200, {choices: []})) as typeof fetch,
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'invalid_response',
  );
});

test('empty content, unexpected finish reasons, and malformed tool calls are rejected', async () => {
  assert.throws(
    () => normalizeAssistantMessage({role: 'assistant', content: '   ', tool_calls: []}),
    (error: unknown) => error instanceof ProviderError && error.kind === 'empty_response',
  );
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      fetchFn: (async () => jsonResponse(200, {
        choices: [{finish_reason: 'mystery', message: {role: 'assistant', content: 'done'}}],
      })) as typeof fetch,
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'unexpected_finish',
  );
  for (const toolCall of [
    {id: '', type: 'function', function: {name: 'tool', arguments: '{}'}},
    {id: '1', type: 'function', function: {name: '', arguments: '{}'}},
    {id: '1', type: 'function', function: {name: 'tool', arguments: '{'}},
    {id: '1', type: 'function', function: {name: 'tool', arguments: '[]'}},
  ]) {
    assert.throws(
      () => normalizeAssistantMessage({role: 'assistant', content: null, tool_calls: [toolCall]}),
      ProviderError,
    );
  }
  assert.throws(
    () => normalizeAssistantMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        {id: '1', type: 'function', function: {name: 'tool', arguments: '{}'}},
        {id: '1', type: 'function', function: {name: 'tool', arguments: '{}'}},
      ],
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'malformed_tool_call',
  );
});

test('cancellation during retry backoff is preserved', async () => {
  const controller = new AbortController();
  await assert.rejects(
    callModel(messages, [], controller.signal, {
      apiKey: 'test-key',
      fetchFn: (async () => jsonResponse(500, {error: 'private'})) as typeof fetch,
      wait: async (_milliseconds, signal) => {
        controller.abort();
        if (signal.aborted) throw new ProviderError('aborted', 'The model request was cancelled.', false);
      },
    }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'aborted',
  );
});

test('deadline expiration prevents retry backoff', async () => {
  let waits = 0;
  let time = 0;
  await assert.rejects(
    callModel(messages, [], undefined, {
      apiKey: 'test-key',
      deadlineMs: 10,
      now: () => time,
      fetchFn: (async () => {
        time = 20;
        return jsonResponse(503, {error: 'private'});
      }) as typeof fetch,
      wait: async () => { waits++; },
    }),
    (error: unknown) => error instanceof ProviderError &&
      (error.kind === 'server' || error.kind === 'timeout'),
  );
  assert.equal(waits, 0);
});
