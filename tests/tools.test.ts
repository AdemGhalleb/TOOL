import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {buildCommandEnvironment, SEARCH_LIMITS, tools} from '../src/tools.ts';
import {ToolCancellationError} from '../src/types.ts';

const searchTool = tools.find(
  tool => tool.definition.function.name === 'search_directory',
);
const writeTool = tools.find(
  tool => tool.definition.function.name === 'write_file',
);

function search(workspaceRoot: string, query: string, path = '.'): Promise<unknown> {
  assert.ok(searchTool);
  return searchTool.execute(
    {path, query},
    {workspaceRoot, emit: () => {}, approve: async () => true},
  );
}

async function withTempWorkspace(
  callback: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-harness-search-'));
  try {
    await callback(workspaceRoot);
  } finally {
    await rm(workspaceRoot, {recursive: true, force: true});
  }
}

test('command environment excludes secrets and arbitrary variables', () => {
  const environment = buildCommandEnvironment({
    PATH: 'safe-path',
    OPENROUTER_API_KEY: 'sentinel-secret',
    APP_SENTINEL: 'unlisted-value',
  });

  assert.deepEqual(environment, {PATH: 'safe-path'});
  assert.equal(environment.OPENROUTER_API_KEY, undefined);
  assert.equal(environment.APP_SENTINEL, undefined);
});

test('command environment preserves allowlisted platform variables', () => {
  const environment = buildCommandEnvironment({
    PATH: 'safe-path',
    HOME: 'home-dir',
    TMPDIR: 'temp-dir',
    SYSTEMROOT: 'windows-root',
    PATHEXT: '.EXE;.CMD',
    COMSPEC: 'command-shell',
    APP_SENTINEL: 'unlisted-value',
  });

  assert.deepEqual(environment, {
    PATH: 'safe-path',
    HOME: 'home-dir',
    TMPDIR: 'temp-dir',
    SYSTEMROOT: 'windows-root',
    PATHEXT: '.EXE;.CMD',
    COMSPEC: 'command-shell',
  });
});

test('command environment handles missing values and Windows variable casing', () => {
  assert.deepEqual(buildCommandEnvironment({}), {});
  assert.deepEqual(buildCommandEnvironment({systemroot: 'windows-root'}), {
    systemroot: 'windows-root',
  });
});

test('search_directory returns normal matches without truncation', async () => {
  await withTempWorkspace(async workspaceRoot => {
    await writeFile(join(workspaceRoot, 'file.txt'), 'first\nneedle here\n');

    assert.deepEqual(await search(workspaceRoot, 'needle'), {
      matches: ['file.txt:2:needle here'],
      truncated: false,
    });
  });
});

test('search_directory stops traversal at the file limit', async () => {
  await withTempWorkspace(async workspaceRoot => {
    for (let index = 0; index < SEARCH_LIMITS.maxFiles; index++) {
      await writeFile(join(workspaceRoot, `${index.toString().padStart(4, '0')}.txt`), 'no match');
    }
    await writeFile(join(workspaceRoot, 'zzzz.txt'), 'needle');

    const result = await search(workspaceRoot, 'needle') as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, true);
  });
});

test('search_directory skips oversized files and reports partial results', async () => {
  await withTempWorkspace(async workspaceRoot => {
    await writeFile(
      join(workspaceRoot, 'large.txt'),
      Buffer.concat([Buffer.from('needle\n'), Buffer.alloc(SEARCH_LIMITS.maxFileBytes, 'x')]),
    );
    await writeFile(join(workspaceRoot, 'small.txt'), 'needle\n');

    const result = await search(workspaceRoot, 'needle') as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, ['small.txt:1:needle']);
    assert.equal(result.truncated, true);
  });
});

test('search_directory bounds aggregate bytes before reaching later files', async () => {
  await withTempWorkspace(async workspaceRoot => {
    for (let index = 0; index < 5; index++) {
      await writeFile(
        join(workspaceRoot, `${index}.txt`),
        Buffer.alloc(SEARCH_LIMITS.maxFileBytes, 'x'),
      );
    }
    await writeFile(join(workspaceRoot, 'z.txt'), 'needle');

    const result = await search(workspaceRoot, 'needle') as {
      matches: string[];
      truncated: boolean;
    };
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, true);
  });
});

test('search_directory stops accumulating matches at the result limit', async () => {
  await withTempWorkspace(async workspaceRoot => {
    for (let index = 0; index < SEARCH_LIMITS.maxMatches + 1; index++) {
      await writeFile(join(workspaceRoot, `${index}.txt`), 'needle\n');
    }

    const result = await search(workspaceRoot, 'needle') as {
      matches: string[];
      truncated: boolean;
    };
    assert.equal(result.matches.length, SEARCH_LIMITS.maxMatches);
    assert.equal(result.truncated, true);
  });
});

test('search_directory ignores excluded directories', async () => {
  await withTempWorkspace(async workspaceRoot => {
    await mkdir(join(workspaceRoot, '.git'));
    await mkdir(join(workspaceRoot, 'node_modules'));
    await writeFile(join(workspaceRoot, '.git', 'hidden.txt'), 'needle');
    await writeFile(join(workspaceRoot, 'node_modules', 'hidden.txt'), 'needle');

    assert.deepEqual(await search(workspaceRoot, 'needle'), {
      matches: [],
      truncated: false,
    });
  });
});

test('search_directory does not follow directory symlinks', async () => {
  await withTempWorkspace(async workspaceRoot => {
    const outside = await mkdtemp(join(tmpdir(), 'agent-harness-outside-'));
    try {
      await writeFile(join(outside, 'outside.txt'), 'needle');
      await symlink(outside, join(workspaceRoot, 'linked'), 'junction');

      assert.deepEqual(await search(workspaceRoot, 'needle'), {
        matches: [],
        truncated: false,
      });
    } finally {
      await rm(outside, {recursive: true, force: true});
    }
  });
});

test('search_directory tolerates files disappearing during a search', async () => {
  await withTempWorkspace(async workspaceRoot => {
    await writeFile(join(workspaceRoot, 'present.txt'), 'needle');
    await rm(join(workspaceRoot, 'present.txt'));

    assert.deepEqual(await search(workspaceRoot, 'needle'), {
      matches: [],
      truncated: false,
    });
  });
});

test('a normal approval permits a write operation', async () => {
  await withTempWorkspace(async workspaceRoot => {
    assert.ok(writeTool);
    const result = await writeTool.execute(
      {path: 'approved.txt', content: 'saved'},
      {workspaceRoot, emit: () => {}, approve: async () => true},
    );

    assert.deepEqual(result, {approved: true, path: 'approved.txt'});
    assert.equal(await readFile(join(workspaceRoot, 'approved.txt'), 'utf8'), 'saved');
  });
});

test('cancellation immediately after approval prevents a write', async () => {
  await withTempWorkspace(async workspaceRoot => {
    assert.ok(writeTool);
    const controller = new AbortController();
    await assert.rejects(
      writeTool.execute(
        {path: 'expired.txt', content: 'must not save'},
        {
          workspaceRoot,
          emit: () => {},
          approve: async () => {
            controller.abort();
            return true;
          },
          signal: controller.signal,
        },
      ),
      ToolCancellationError,
    );
    await assert.rejects(readFile(join(workspaceRoot, 'expired.txt'), 'utf8'));
  });
});

test('run_command executes with the sanitized environment and keeps its result shape', async () => {
  const secretKey = 'OPENROUTER_API_KEY';
  const appKey = 'AGENT_HARNESS_SENTINEL';
  const previousSecret = process.env[secretKey];
  const previousAppValue = process.env[appKey];
  process.env[secretKey] = 'sentinel-secret';
  process.env[appKey] = 'unlisted-value';

  try {
    const commandTool = tools.find(tool => tool.definition.function.name === 'run_command');
    assert.ok(commandTool);
    const result = await commandTool.execute(
      {command: `node -e "process.stdout.write(String(process.env.${secretKey}) + '|' + String(process.env.${appKey}))"`},
      {workspaceRoot: process.cwd(), emit: () => {}, approve: async () => true},
    );

    assert.deepEqual(result, {
      approved: true,
      exitCode: 0,
      stdout: 'undefined|undefined',
      stderr: '',
      error: null,
    });
  } finally {
    if (previousSecret === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previousSecret;
    if (previousAppValue === undefined) delete process.env[appKey];
    else process.env[appKey] = previousAppValue;
  }
});

test('run_command keeps its error result fields for a failed command', async () => {
  const commandTool = tools.find(tool => tool.definition.function.name === 'run_command');
  assert.ok(commandTool);
  const result = await commandTool.execute(
    {command: 'agent-harness-command-that-does-not-exist'},
    {workspaceRoot: process.cwd(), emit: () => {}, approve: async () => true},
  );

  assert.equal(typeof result, 'object');
  assert.ok(result !== null);
  assert.deepEqual(Object.keys(result).sort(), [
    'approved',
    'error',
    'exitCode',
    'stderr',
    'stdout',
  ]);
  assert.equal(result.approved, true);
  assert.equal(result.exitCode, 1);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.equal(typeof result.error, 'string');
});
