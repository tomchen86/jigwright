import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertExistingGovernanceIntakeChange,
  findActiveTaskSessionId,
  resolveActiveSession,
  resolveGovernanceIntakeRuntimeRoot,
  resolveRepositoryFindingScope,
  resolveTaskScope,
} from '../src/runtime/repository-observation/governance-intake-context.ts';
import { observeGovernanceIntakeCountContext } from '../src/runtime/repository-observation/governance-intake-count-context.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { loadWorkflowConfig } from '../src/runtime/workflow-configuration/workflow-configuration.ts';
import {
  runtimePaths,
  readSessionFile,
  type WorkflowSession,
} from '../src/runtime/session-workspace/session-store.ts';
import { createFixtureRepository } from './fixture.ts';
import { snapshotPlainTree } from './governance-intake-fixture.ts';

function session(repositoryRoot: string, id: string): WorkflowSession {
  const git = discoverRepository(repositoryRoot);
  return {
    schemaVersion: 1,
    sessionId: id,
    state: 'active',
    changeId: 'intake-context',
    taskId: '1.1',
    repositoryRoot,
    gitCommonDirectory: git.gitCommonDirectory,
    branch: 'work/intake-context',
    baseline: { head: git.head, tree: git.tree },
    artifacts: {},
    allowedPaths: [],
    requiredChecks: [],
    requiredCheckDigests: {},
    planningAssurance: null,
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      routingWorksetDigest: `sha256:${'a'.repeat(64)}`,
      concurrencyEnabled: false,
      worktreeDigest: `sha256:${'b'.repeat(64)}`,
      resources: [],
    },
    createdAt: '2026-10-02T00:00:00.000Z',
  };
}

test('intake observation retains configured runtime roots, sorted active scan, canonical worktree match and unreadable-record tolerance', () => {
  const repository = createFixtureRepository(),
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-context-'));
  try {
    const git = discoverRepository(repository),
      config = loadWorkflowConfig(git.repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    assert.equal(resolveGovernanceIntakeRuntimeRoot(repository), runtime.root);
    assert.deepEqual(observeGovernanceIntakeCountContext(repository), {
      repositoryRoot: git.repositoryRoot,
      runtimeRoot: runtime.root,
    });
    assert.deepEqual(resolveRepositoryFindingScope(repository), {
      repositoryRoot: git.repositoryRoot,
      runtimeRoot: runtime.root,
      sessionId: 'repository',
      changeId: 'repository',
      branch: git.branch ?? 'repository',
      head: git.head,
      tree: git.tree,
    });
    assert.equal(findActiveTaskSessionId(repository), null);
    assert.equal(resolveTaskScope(repository), null);
    fs.mkdirSync(runtime.sessions, { recursive: true });
    fs.writeFileSync(
      path.join(runtime.sessions, 'session-00-unreadable.json'),
      'invalid JSON',
    );
    fs.writeFileSync(
      path.join(runtime.sessions, 'ignored.txt'),
      'not a session',
    );
    const write = (value: WorkflowSession, filename = value.sessionId) => {
      fs.writeFileSync(
        path.join(runtime.sessions, `${filename}.json`),
        JSON.stringify(value),
      );
    };
    write(session(repository, 'session-mismatch'), 'session-01-mismatched');
    write({
      ...session(repository, 'session-02-missing'),
      repositoryRoot: path.join(temporary, 'missing'),
    });
    write({
      ...session(repository, 'session-03-inactive'),
      state: 'aborted',
      abortedAt: '2026-10-02T00:00:00.000Z',
      abortReason: 'test',
    });
    write({
      ...session(repository, 'session-04-foreign'),
      repositoryRoot: temporary,
    });
    assert.equal(findActiveTaskSessionId(repository), null);
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(repository, alias, 'dir');
    write({ ...session(repository, 'session-z-match'), repositoryRoot: alias });
    write(session(repository, 'session-a-match'));
    // Validate the positive records through the same canonical primitive before exercising scan order.
    assert.equal(
      readSessionFile(path.join(runtime.sessions, 'session-a-match.json'))
        .state,
      'active',
    );
    const before = snapshotPlainTree(runtime.sessions);
    assert.equal(findActiveTaskSessionId(repository), 'session-a-match');
    const expected = {
      repositoryRoot: git.repositoryRoot,
      runtimeRoot: runtime.root,
      sessionId: 'session-a-match',
      changeId: 'intake-context',
      branch: git.branch ?? 'work/intake-context',
      head: git.head,
      tree: git.tree,
    };
    assert.deepEqual(
      resolveActiveSession(repository, 'session-a-match'),
      expected,
    );
    assert.deepEqual(resolveTaskScope(repository), expected);
    assert.deepEqual(snapshotPlainTree(runtime.sessions), before);
    fs.unlinkSync(path.join(runtime.sessions, 'session-a-match.json'));
    assert.equal(findActiveTaskSessionId(repository), 'session-z-match');
    assert.throws(
      () => resolveActiveSession(repository, 'session-03-inactive'),
      { code: 'SESSION_NOT_ACTIVE' },
    );
    assert.throws(
      () => resolveActiveSession(repository, 'session-00-unreadable'),
      { code: 'SESSION_UNREADABLE' },
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Finding change observation accepts plain existing children and rejects unsafe identity, missing, file and symlink targets without mutation', () => {
  const repository = createFixtureRepository(),
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-change-'));
  try {
    const config = loadWorkflowConfig(repository),
      root = path.join(repository, config.changeRoot);
    fs.mkdirSync(path.join(root, 'plain-change'), { recursive: true });
    fs.writeFileSync(path.join(root, 'file-change'), 'not a directory');
    fs.symlinkSync(temporary, path.join(root, 'linked-change'), 'dir');
    const before = snapshotPlainTree(root);
    assert.equal(
      assertExistingGovernanceIntakeChange(repository, 'plain-change'),
      'plain-change',
    );
    for (const id of [
      '../plain-change',
      'Uppercase',
      'missing',
      'file-change',
      'linked-change',
    ])
      assert.throws(
        () => assertExistingGovernanceIntakeChange(repository, id),
        { code: 'GOVERNANCE_INTAKE_INVALID' },
      );
    assert.deepEqual(snapshotPlainTree(root), before);
    fs.renameSync(root, root + '-saved');
    fs.symlinkSync(root + '-saved', root, 'dir');
    assert.throws(
      () => assertExistingGovernanceIntakeChange(repository, 'plain-change'),
      /Configured change root is unsafe/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
