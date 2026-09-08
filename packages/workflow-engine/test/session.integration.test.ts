import test from 'node:test';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import assert from 'node:assert/strict';
import {
  startSession,
  checkSession,
  abortSession,
} from '../src/application/execute-task/session.ts';
import fs from 'node:fs';
import path from 'node:path';
import { prepareCurrentChange } from './support/session-lifecycle-fixture.ts';

if (import.meta.main) await import('./session-legacy-family.ts');
test('current lifecycle rejects a non-managed schema directly', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('start rejects protected and dirty repositories without leaving runtime state', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', 'work/demo-change']);
    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'PROTECTED_BRANCH'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );

    git(repository, ['checkout', 'work/demo-change']);
    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'existing work\n');

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'DIRTY_WORKTREE'),
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot(repository), 'sessions')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('active session pins a clean baseline, enforces scope, and releases its lock', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.equal(session.state, 'active');
    assert.equal(checkSession(repository, session.sessionId).passed, true);

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'TASK_SESSION_CHANGE_CONFLICT'),
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const allowedCheck = checkSession(repository, session.sessionId);
    assert.deepEqual(allowedCheck.changedPaths, ['src/feature.ts']);

    fs.writeFileSync(path.join(repository, 'outside.txt'), 'not allowed\n');
    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );

    const aborted = abortSession(
      repository,
      session.sessionId,
      'integration test',
    );
    assert.equal(aborted.state, 'aborted');
    assert.equal(
      fs.existsSync(
        path.join(runtimeRoot(repository), 'locks', 'demo-change.lock'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
