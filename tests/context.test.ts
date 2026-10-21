import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  ContextBudgetError,
  prepareContext,
} from '../src/context.ts';
import type {Message} from '../src/types.ts';

const system: Message = {role: 'system', content: 'instructions'};

test('a short conversation fits unchanged and does not mutate its input', () => {
  const messages: Message[] = [
    system,
    {role: 'user', content: 'first'},
    {role: 'assistant', content: 'answer'},
    {role: 'user', content: 'latest'},
  ];
  const original = structuredClone(messages);

  assert.deepEqual(
    prepareContext(messages, {maxInputTokens: 100}),
    messages,
  );
  assert.deepEqual(messages, original);
});

test('older completed exchanges are excluded in favor of recent history', () => {
  const messages: Message[] = [
    system,
    {role: 'user', content: 'old request '.repeat(20)},
    {role: 'assistant', content: 'old answer '.repeat(20)},
    {role: 'user', content: 'recent request'},
    {role: 'assistant', content: 'recent answer'},
    {role: 'user', content: 'latest request'},
  ];

  const prepared = prepareContext(messages, {maxInputTokens: 32});
  assert.deepEqual(prepared, [
    system,
    {role: 'user', content: 'recent request'},
    {role: 'assistant', content: 'recent answer'},
    {role: 'user', content: 'latest request'},
  ]);
  assert.equal(prepared.some(message => message.content === 'old request '.repeat(20)), false);
});

test('system instructions and latest request are retained in chronological order', () => {
  const prepared = prepareContext([
    system,
    {role: 'user', content: 'earlier'},
    {role: 'assistant', content: 'earlier answer'},
    {role: 'user', content: 'latest'},
  ], {maxInputTokens: 18});

  assert.deepEqual(prepared, [
    system,
    {role: 'user', content: 'latest'},
  ]);
});

test('tool calls are retained with all corresponding tool results', () => {
  const messages: Message[] = [
    system,
    {role: 'user', content: 'inspect'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: {name: 'read_file', arguments: '{"path":"a"}'},
        },
        {
          id: 'call-b',
          type: 'function',
          function: {name: 'read_file', arguments: '{"path":"b"}'},
        },
      ],
    },
    {role: 'tool', tool_call_id: 'call-a', content: 'a'},
    {role: 'tool', tool_call_id: 'call-b', content: 'b'},
    {role: 'assistant', content: 'completed'},
    {role: 'user', content: 'latest'},
  ];

  assert.deepEqual(prepareContext(messages, {maxInputTokens: 100}), messages);
});

test('orphaned and incomplete tool exchanges are rejected', () => {
  assert.throws(
    () => prepareContext([
      system,
      {role: 'user', content: 'latest'},
      {role: 'tool', tool_call_id: 'missing', content: 'result'},
    ]),
    ContextBudgetError,
  );
  assert.throws(
    () => prepareContext([
      system,
      {
        role: 'user',
        content: 'latest',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'missing-result',
          type: 'function',
          function: {name: 'tool', arguments: '{}'},
        }],
      },
    ]),
    ContextBudgetError,
  );
});

test('an oversized latest message fails explicitly instead of being truncated', () => {
  assert.throws(
    () => prepareContext([
      system,
      {role: 'user', content: 'x'.repeat(1_000)},
    ], {maxInputTokens: 20}),
    /latest user request/,
  );
});

test('a context that cannot fit after reductions fails clearly', () => {
  assert.throws(
    () => prepareContext([
      {role: 'system', content: 'system '.repeat(20)},
      {role: 'user', content: 'latest'},
    ], {maxInputTokens: 10}),
    /latest user request and system instructions/,
  );
});

test('a message exactly at the estimated budget is accepted', () => {
  assert.deepEqual(
    prepareContext([
      {role: 'system', content: 'a'},
      {role: 'user', content: 'b'},
    ], {maxInputTokens: 10}),
    [
      {role: 'system', content: 'a'},
      {role: 'user', content: 'b'},
    ],
  );
});
