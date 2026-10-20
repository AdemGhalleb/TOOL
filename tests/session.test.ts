import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  loadSession,
  saveSession,
  SESSION_LIMITS,
  validateSessionData,
} from '../src/session.ts';
import type {Message} from '../src/types.ts';

async function withTempDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-harness-session-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

const validMessages: Message[] = [
  {role: 'system', content: 'system'},
  {role: 'user', content: 'hello'},
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {name: 'read_file', arguments: '{"path":"x"}'},
      },
    ],
  },
  {role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}'},
  {role: 'assistant', content: 'done'},
];

test('valid sessions load with the provider message shapes intact', async () => {
  await withTempDirectory(async directory => {
    const path = join(directory, 'session.json');
    await writeFile(path, JSON.stringify(validMessages), 'utf8');
    assert.deepEqual(await loadSession(path), validMessages);
  });
});

test('a missing session preserves first-run behavior', async () => {
  await withTempDirectory(async directory => {
    assert.deepEqual(await loadSession(join(directory, 'missing.json')), []);
  });
});

test('malformed and structurally invalid sessions recover as fresh sessions', async () => {
  await withTempDirectory(async directory => {
    const malformedPath = join(directory, 'malformed.json');
    await writeFile(malformedPath, '{', 'utf8');
    const invalidPath = join(directory, 'invalid.json');
    await writeFile(invalidPath, JSON.stringify({messages: []}), 'utf8');

    assert.deepEqual(await loadSession(malformedPath), []);
    assert.deepEqual(await loadSession(invalidPath), []);
  });
});

test('invalid roles, fields, and tool calls are rejected', () => {
  const invalidValues: unknown[] = [
    [{role: 'developer', content: 'no'}],
    [{role: 'user', content: 4}],
    [{role: 'assistant', content: null, tool_calls: [{id: 'x'}]}],
    [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'x',
        type: 'custom',
        function: {name: 'tool', arguments: '{}'},
      }],
    }],
    [{role: 'tool', tool_call_id: 'x', content: 'ok', extra: true}],
  ];

  for (const value of invalidValues) {
    assert.throws(() => validateSessionData(value));
  }
});

test('oversized files are rejected before reading their contents', async () => {
  let reads = 0;
  const fileSystem = {
    stat: async () => ({size: SESSION_LIMITS.maxFileBytes + 1}),
    readFile: async () => {
      reads++;
      return '[]';
    },
  };

  assert.deepEqual(
    await loadSession('oversized.json', fileSystem),
    [],
  );
  assert.equal(reads, 0);
});

test('message and nested string limits are enforced', () => {
  assert.throws(() =>
    validateSessionData(
      Array.from({length: SESSION_LIMITS.maxMessages + 1}, () => ({
        role: 'user',
        content: 'x',
      })),
    ),
  );
  assert.throws(() =>
    validateSessionData([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call',
        type: 'function',
        function: {
          name: 'tool',
          arguments: 'x'.repeat(SESSION_LIMITS.maxToolArgumentsChars + 1),
        },
      }],
    }]),
  );
  assert.throws(() =>
    validateSessionData([{
      role: 'user',
      content: 'x'.repeat(SESSION_LIMITS.maxMessageContentChars + 1),
    }]),
  );
});

test('invalid loaded state cannot reach a model request', async () => {
  await withTempDirectory(async directory => {
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify([{role: 'user', content: 9}]), 'utf8');
    const messages = await loadSession(path);
    assert.deepEqual(messages, []);
    assert.equal(messages.some(message => message.role === 'user' && typeof message.content !== 'string'), false);
  });
});

test('saving uses a replacement file and preserves the old file if replacement fails', async () => {
  await withTempDirectory(async directory => {
    const path = join(directory, 'session.json');
    await writeFile(path, JSON.stringify([{role: 'user', content: 'old'}]), 'utf8');
    const realFileSystem = {stat, readFile, writeFile, unlink};
    const failingFileSystem = {
      ...realFileSystem,
      rename: async () => {
        throw new Error('replacement failed');
      },
    };

    await assert.rejects(saveSession([{role: 'user', content: 'new'}], path, failingFileSystem));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [
      {role: 'user', content: 'old'},
    ]);
  });
});

test('valid sessions save and load through the atomic path', async () => {
  await withTempDirectory(async directory => {
    const path = join(directory, 'session.json');
    await saveSession(validMessages, path);
    assert.deepEqual(await loadSession(path), validMessages);
  });
});
