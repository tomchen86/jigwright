import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createRepositoryHookRules,
  type RepositoryHookDependencies,
} from '../src/modules/lifecycle/repository-hooks.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

function memoryRepository() {
  const events: string[] = [];
  const state = {
    message: 'Add a repository hook\n',
    sessions: [] as ReturnType<RepositoryHookDependencies['listSessions']>,
    staged: [] as string[],
    publicationFailure: null as Error | null,
    validationFailure: null as Error | null,
  };
  const validated = {
    repositoryRoot: '/repository/alias',
    changes: ['change-a'],
    documents: ['README.md'],
  };
  const publications: Parameters<
    RepositoryHookDependencies['assertActivePublishTransaction']
  >[] = [];
  const dependencies: RepositoryHookDependencies = {
    readCommitMessage(cwd, requestedPath) {
      assert.equal(cwd, '/caller');
      assert.equal(requestedPath, 'COMMIT_EDITMSG');
      events.push('message');
      return state.message;
    },
    validateRepositoryState(cwd) {
      assert.equal(cwd, '/caller');
      events.push('repository');
      if (state.validationFailure) throw state.validationFailure;
      return validated;
    },
    validateWorkflowIntegrationAssets(root) {
      assert.equal(root, validated.repositoryRoot);
      events.push('integration');
    },
    realRepositoryPath(root) {
      assert.equal(root, validated.repositoryRoot);
      events.push('realpath');
      return '/repository/real';
    },
    listSessions(cwd) {
      assert.equal(cwd, '/caller');
      events.push('sessions');
      return state.sessions;
    },
    findStagedLifecyclePaths(root) {
      assert.equal(root, validated.repositoryRoot);
      events.push('staged');
      return state.staged;
    },
    readStagedLifecycleSource() {
      assert.fail('No routing file was staged in this scenario.');
    },
    assertActivePublishTransaction(...args) {
      events.push('publication');
      publications.push(args);
      if (state.publicationFailure) throw state.publicationFailure;
    },
  };
  const rules = createRepositoryHookRules(dependencies);
  return { rules, events, state, validated, publications };
}

test('hook construction and rejected usage do not observe a repository', () => {
  const memory = memoryRepository();
  assert.deepEqual(memory.events, []);
  assert.equal(memory.rules.runRepositoryHook.length, 3);
  assert.throws(
    () =>
      memory.rules.runRepositoryHook('/caller', 'pre-commit', ['unexpected']),
    {
      code: 'INVALID_HOOK_USAGE',
    },
  );
  assert.deepEqual(memory.events, []);
});

test('commit message admission precedes repository observations and preserves result references', () => {
  const memory = memoryRepository();
  memory.state.message = 'WIP\n';
  assert.throws(
    () =>
      memory.rules.runRepositoryHook('/caller', 'commit-msg', [
        'COMMIT_EDITMSG',
      ]),
    {
      code: 'COMMIT_MESSAGE_INVALID',
    },
  );
  assert.deepEqual(memory.events, ['message']);
  memory.events.length = 0;
  memory.state.message =
    'Add a repository hook\r\n\r\nExplain the change\r\n# Ignore this comment\r\n';
  const result = memory.rules.runRepositoryHook('/caller', 'commit-msg', [
    'COMMIT_EDITMSG',
  ]);
  assert.deepEqual(memory.events, [
    'message',
    'repository',
    'integration',
    'realpath',
  ]);
  assert.equal(result.changes, memory.validated.changes);
  assert.equal(result.documents, memory.validated.documents);
});

test('pre-commit rereads sessions and blocks only the matching active worktree before staged reads', () => {
  const memory = memoryRepository();
  memory.state.sessions = [
    { state: 'active', repositoryRoot: '/repository/other' },
  ];
  memory.rules.runRepositoryHook('/caller', 'pre-commit', []);
  assert.deepEqual(memory.events, [
    'repository',
    'integration',
    'realpath',
    'sessions',
    'staged',
  ]);
  memory.events.length = 0;
  memory.state.sessions = [
    { state: 'active', repositoryRoot: '/repository/real' },
  ];
  assert.throws(
    () => memory.rules.runRepositoryHook('/caller', 'pre-commit', []),
    {
      code: 'ACTIVE_SESSION_REQUIRES_MANAGED_COMMIT',
    },
  );
  assert.deepEqual(memory.events, [
    'repository',
    'integration',
    'realpath',
    'sessions',
  ]);
});

test('unmanaged staged lifecycle paths fail after session checks without reading an absent routing source', () => {
  const memory = memoryRepository();
  memory.state.staged = ['openspec/changes/change-a/tasks.md'];
  assert.throws(
    () => memory.rules.runRepositoryHook('/caller', 'pre-commit', []),
    {
      code: 'MANAGED_DIFF_REQUIRES_WORKFLOW_COMMIT',
      details: { stagedPaths: memory.state.staged },
    },
  );
  assert.deepEqual(memory.events, [
    'repository',
    'integration',
    'realpath',
    'sessions',
    'staged',
  ]);
});

test('publication receives exact optional inputs after validation and retains failure identity', () => {
  const memory = memoryRepository();
  const args = ['origin', 'ssh://repository'];
  const environment = { HOOK_TRANSACTION: 'example' };
  const signer = {
    assertHumanPresent() {
      assert.fail('The hook must delegate signing.');
    },
    identity() {
      assert.fail('The hook must delegate signing.');
    },
    sign() {
      assert.fail('The hook must delegate signing.');
    },
    verify() {
      assert.fail('The hook must delegate signing.');
    },
  };
  const failure = new Error('publication unavailable');
  memory.state.publicationFailure = failure;
  assert.throws(
    () =>
      memory.rules.runRepositoryHook('/caller', 'pre-push', args, {
        environment,
        externalEffectSigner: signer,
      }),
    (error) => error === failure,
  );
  assert.deepEqual(memory.events, [
    'repository',
    'integration',
    'realpath',
    'publication',
  ]);
  assert.equal(memory.publications[0]?.[1], args);
  assert.equal(memory.publications[0]?.[2], environment);
  assert.equal(memory.publications[0]?.[3], signer);
  memory.events.length = 0;
  memory.state.validationFailure = new Error('validation unavailable');
  assert.throws(
    () => memory.rules.runRepositoryHook('/caller', 'pre-push', []),
    (error) => error === memory.state.validationFailure,
  );
  assert.deepEqual(memory.events, ['repository']);
  assert.equal(memory.publications.length, 1);
  memory.state.validationFailure = null;
  memory.state.publicationFailure = null;
  memory.rules.runRepositoryHook('/caller', 'pre-push', []);
  assert.equal(memory.publications[1]?.[2], undefined);
  assert.equal(memory.publications[1]?.[3], undefined);
});

test('hook rules and specification path policy have complete pure type and value closures', () => {
  for (const file of [
    'repository-hooks.ts',
    'repository-specification-policy.ts',
  ]) {
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(import.meta.dirname, '../src/modules/lifecycle', file),
      ).size > 1,
    );
  }
});
