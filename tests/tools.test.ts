import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildCommandEnvironment, tools} from '../src/tools.ts';

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
