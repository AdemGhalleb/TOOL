import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createEvaluationReport,
  runEvaluationCli,
  type EvaluationResult,
} from './evaluation.ts';

const passingResult: EvaluationResult = {
  id: 'passing',
  name: 'Passing scenario',
  passed: true,
  expectedOutcome: 'it passes',
  actualOutcome: 'it passed',
  failures: [],
};

const failingResult: EvaluationResult = {
  id: 'failing',
  name: 'Failing scenario',
  passed: false,
  expectedOutcome: 'it passes',
  actualOutcome: 'it failed',
  failures: ['assertion failed'],
};

test('JSON output is valid and summarizes scenario results', async () => {
  let output = '';
  const exitCode = await runEvaluationCli(['--json'], {
    run: async () => [passingResult, failingResult],
    stdout: text => { output += text; },
  });

  assert.equal(exitCode, 1);
  const report = JSON.parse(output);
  assert.deepEqual(report.summary, {
    total: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
  });
  assert.equal(report.scenarios[0].status, 'passed');
  assert.deepEqual(report.scenarios[0].failures, []);
  assert.equal(report.scenarios[1].status, 'failed');
  assert.deepEqual(report.scenarios[1].failures, ['assertion failed']);
});

test('JSON output for a passing run exits successfully without human text', async () => {
  let output = '';
  let diagnostics = '';
  const exitCode = await runEvaluationCli(['--json'], {
    run: async () => [passingResult],
    stdout: text => { output += text; },
    stderr: text => { diagnostics += text; },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output).summary, {
    total: 1,
    passed: 1,
    failed: 0,
    passRate: 1,
  });
  assert.equal(output.includes('PASS'), false);
  assert.equal(diagnostics, '');
});

test('empty reports have a safe zero pass rate', () => {
  assert.deepEqual(createEvaluationReport([]).summary, {
    total: 0,
    passed: 0,
    failed: 0,
    passRate: 0,
  });
});

test('human-readable output remains available by default', async () => {
  let output = '';
  const exitCode = await runEvaluationCli([], {
    run: async () => [passingResult],
    stdout: text => { output += text; },
  });

  assert.equal(exitCode, 0);
  assert.match(output, /^PASS passing: Passing scenario\n/);
  assert.match(output, /Summary: 1\/1 passed \(100\.0%\)\n$/);
});

test('unsupported options are rejected', async () => {
  let output = '';
  let diagnostics = '';
  const exitCode = await runEvaluationCli(['--jsson'], {
    stdout: text => { output += text; },
    stderr: text => { diagnostics += text; },
  });

  assert.equal(exitCode, 1);
  assert.equal(output, '');
  assert.match(diagnostics, /Unsupported option: --jsson/);
});

test('unexpected runner errors produce a failed JSON report and diagnostics', async () => {
  let output = '';
  let diagnostics = '';
  const exitCode = await runEvaluationCli(['--json'], {
    run: async () => { throw new Error('runner failed'); },
    stdout: text => { output += text; },
    stderr: text => { diagnostics += text; },
  });

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(output).error, 'runner failed');
  assert.match(diagnostics, /runner failed/);
});
