import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import { createCiHistoricalReplay } from '../src/runtime/repository-validation/commit-replay/ci-historical-contract.ts';
import { createTaskExecutionGenerationReader } from '../src/runtime/repository-validation/commit-replay/task-execution-evidence.ts';
import { assertCompletePlanningTree } from '../src/modules/assurance/commit-replay/ci-planning.ts';
import type { CiPlanningReplayOperations } from '../src/modules/assurance/commit-replay/ci-planning.ts';
import type { CiSequenceReplayOperations } from '../src/modules/assurance/commit-replay/ci-sequence.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import { managedCommitMessage } from '../src/runtime/repository-transaction/git-commit-messages.ts';

for (const name of [
  'ci-authority',
  'ci-task-state',
  'ci-planning',
  'ci-historical-contract',
  'ci-routing',
  'ci-sequence',
  'ci-archive',
  'ci-git',
  'ci-archive-tree',
]) {
  test(`${name} has a pure complete type and value dependency closure`, () => {
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(
          import.meta.dirname,
          `../src/modules/assurance/commit-replay/${name}.ts`,
        ),
      ).size > 1,
    );
  });
}
test('task execution generation rules and facts have a pure complete dependency closure', () => {
  assert.ok(
    assertPureDependencyClosure(
      path.resolve(
        import.meta.dirname,
        '../src/modules/assurance/task-execution-evidence.ts',
      ),
    ).size > 1,
  );
});

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}
function repository(t: test.TestContext, includePlan = true): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ci-replay-boundary-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Replay Fixture']);
  git(root, ['config', 'user.email', 'replay@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  if (includePlan) {
    fs.mkdirSync(path.join(root, 'openspec/changes/replay-case'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'openspec/changes/replay-case/plan-review.json'),
      '{}\n',
    );
  }
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'Initial fixture']);
  return root;
}

test('historical authority replays the governing commit again before reading task or guard bytes', (t) => {
  const root = repository(t);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const marker = new Error('required replay rejected');
  const seen: Parameters<
    CiPlanningReplayOperations['validateCiPlanningCommit']
  >[] = [];
  const replay = createCiHistoricalReplay({
    validateCiPlanningCommit(...args) {
      seen.push(args);
      throw marker;
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () =>
        replay.loadHistoricalTaskAuthority(root, head, 'replay-case', '1.1'),
      (error) => error === marker,
    );
  }
  assert.deepEqual(seen, [
    [root, head, 'replay-case', 'openspec/changes'],
    [root, head, 'replay-case', 'openspec/changes'],
  ]);
});

test('missing governing plan fails before the required replay callback', (t) => {
  const root = repository(t, false);
  let calls = 0;
  const replay = createCiHistoricalReplay({
    validateCiPlanningCommit() {
      calls++;
      throw new Error('unexpected replay');
    },
  });
  assert.throws(
    () =>
      replay.loadHistoricalTaskAuthority(
        root,
        git(root, ['rev-parse', 'HEAD']).trim(),
        'replay-case',
        '1.1',
      ),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_TASK_CURRENT_PLAN_REQUIRED',
  );
  assert.equal(calls, 0);
});

test('historical authority keeps the current-schema error mapping at the required replay boundary', (t) => {
  const root = repository(t);
  const replay = createCiHistoricalReplay({
    validateCiPlanningCommit() {
      throw workflowError(
        'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
        'fixture',
        ExitCode.guard,
      );
    },
  });
  assert.throws(
    () =>
      replay.loadHistoricalTaskAuthority(
        root,
        git(root, ['rev-parse', 'HEAD']).trim(),
        'replay-case',
        '1.1',
      ),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'CI_TASK_CURRENT_PLAN_REQUIRED',
  );
});

test('CI tree admission uses the required alternate provider before artifact and blob checks', () => {
  const marker = new Error('alternate grammar refused');
  const calls: string[] = [];
  assert.throws(
    () =>
      assertCompletePlanningTree(
        {
          admit(input) {
            calls.push(input.changeId);
            throw marker;
          },
          requiredArtifactPaths() {
            calls.push('required');
            return [];
          },
        },
        'custom',
        'replay-case',
        [
          {
            mode: '100755',
            type: 'blob',
            path: 'custom/replay-case/provider.document',
          },
        ],
        [],
        'selected',
        'selected',
      ),
    (error) => error === marker,
  );
  assert.deepEqual(calls, ['replay-case']);
});

test('task generation validates unique identities before any Git or required replay operation', () => {
  let calls = 0;
  const read = createTaskExecutionGenerationReader({
    validateCiPlanningCommit() {
      calls++;
      throw new Error('unexpected planning replay');
    },
    replayCommitSequence() {
      calls++;
      throw new Error('unexpected task replay');
    },
  });
  assert.throws(
    () =>
      read('/not-a-repository', 'openspec/changes', 'replay-case', [
        '1.1',
        '1.1',
      ]),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'TASK_EXECUTION_GENERATION_INVALID' &&
      error.message.includes('unique'),
  );
  assert.equal(calls, 0);
});

test('task generation replays each exact candidate on every observation and retains failure mapping', (t) => {
  const root = repository(t, false);
  fs.writeFileSync(path.join(root, 'README.md'), 'task change\n');
  git(root, ['add', '.']);
  git(root, [
    'commit',
    '--quiet',
    '-m',
    managedCommitMessage('Complete task fixture', 'replay-case', '1.1'),
  ]);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const seen: Parameters<CiSequenceReplayOperations['replayCommitSequence']>[] =
    [];
  let reject = false;
  const read = createTaskExecutionGenerationReader({
    validateCiPlanningCommit() {
      throw new Error('unexpected amendment replay');
    },
    replayCommitSequence(...args) {
      seen.push(args);
      if (reject) throw new Error('task replay rejected');
      return {
        completedTasks: [{ changeId: 'replay-case', taskId: '1.1' }],
        archivedChanges: [],
        authorityGrants: [],
        requiredCheckDefinitions: {},
        collaborationGrantUses: [],
      };
    },
  });
  const first = read(root, 'openspec/changes', 'replay-case', ['1.1']);
  assert.equal(first.boundary, null);
  assert.deepEqual(
    first.commitsByTask['1.1'].map((commit) => commit.hash),
    [head],
  );
  reject = true;
  assert.throws(
    () => read(root, 'openspec/changes', 'replay-case', ['1.1']),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'TASK_EXECUTION_GENERATION_INVALID' &&
      error.message.includes('canonical task-transition replay'),
  );
  assert.equal(seen.length, 2);
  for (const args of seen) {
    assert.equal(args[0], root);
    assert.deepEqual(
      args[1].map((commit) => commit.hash),
      [head],
    );
    assert.equal(args[2].size, 0);
  }
});
