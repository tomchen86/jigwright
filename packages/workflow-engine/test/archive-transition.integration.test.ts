import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition } from '../src/application/archive/archive-transition.ts';
import {
  commitSession,
  completeTask,
  finishSession,
} from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  checkSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import { runCli } from '../src/cli.ts';
import { validateCiArchiveCommit } from '../src/entrypoints/ci/ci-archive.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  promoteWorkItem,
  showWorkItem,
  validateWorkRegistry,
  workItemDigest,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';

test('archive transition persists evidence, applies exact staging, commits, and is idempotent', () => {
  const repository = completedFixture(addedDelta());
  try {
    const bindingPath = 'workflow/change-providers/demo-change.json';
    const bindingBefore = fs.readFileSync(path.join(repository, bindingPath));
    const before = git(repository, ['rev-parse', 'HEAD']).trim();
    const committed = commitArchiveTransition(repository, 'demo-change');

    assert.equal(committed.status, 'committed');
    assert.notEqual(committed.commitHash, before);
    assert.match(committed.reportId, /^[0-9a-f]{64}$/);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.deepEqual(
      fs.readFileSync(path.join(repository, bindingPath)),
      bindingBefore,
    );
    assert.equal(committed.changedPaths.includes(bindingPath), false);
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repository, committed.archivePath)),
      true,
    );
    assert.equal(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']).trim(),
      'Archive demo-change\n\nChange: demo-change\nTransition: archive',
    );
    assert.equal(
      fs.existsSync(
        path.join(
          runtimeRoot(repository),
          'archive-reports',
          `${committed.reportId}.json`,
        ),
      ),
      true,
    );

    const replay = commitArchiveTransition(repository, 'demo-change');
    assert.equal(replay.status, 'already-archived');
    assert.equal(replay.commitHash, committed.commitHash);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      committed.commitHash,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive CLI exposes the exact public transition command', () => {
  const repository = completedFixture(addedDelta());
  try {
    assert.equal(runCli(['archive', 'demo-change', '--json'], repository), 0);
    assert.match(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']),
      /Transition: archive/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive closes linked Work Items and renders registry history in the verified commit', () => {
  let itemId = '';
  let itemPath = '';
  const repository = completedFixture(addedDelta(), (fixture) => {
    const created = createWorkItem(
      fixture,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Deliver the archive reconciliation MVP',
        summary: 'Close this exact Work Item with its archived change.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:50:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000005',
      },
    );
    const accepted = applyWorkItemReview(
      fixture,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T04:50:30.000Z',
    );
    const promoted = promoteWorkItem(
      fixture,
      accepted.id,
      'demo-change',
      () => '2026-08-24T04:51:00.000Z',
      workItemDigest(accepted),
    );
    itemId = promoted.item.id;
    itemPath = created.relativePath;
    git(fixture, ['add', '--', `:(literal)${itemPath}`]);
    git(fixture, ['commit', '-m', 'Seed linked Work Item']);
  });
  try {
    const archiveAt = new Date();
    const committed = commitArchiveTransition(
      repository,
      'demo-change',
      process.env,
      { now: () => archiveAt },
    );

    assert.equal(committed.status, 'committed');
    const parent = git(repository, [
      'rev-parse',
      `${committed.commitHash}^`,
    ]).trim();
    const closedAt = new Date(
      git(repository, ['show', '-s', '--format=%cI', parent]).trim(),
    ).toISOString();
    const closedYear = closedAt.slice(0, 4);
    assert.deepEqual(showWorkItem(repository, itemId), {
      ...showWorkItemAtCommit(repository, committed.commitHash, itemPath),
      stage: 'closed',
      closure: {
        at: closedAt,
        outcome: 'delivered',
        changeId: 'demo-change',
      },
    });
    const closed = showWorkItem(repository, itemId);
    assert.deepEqual(closed.timeline.at(-1), {
      at: closedAt,
      event: 'closed',
      changeId: 'demo-change',
    });
    assert.deepEqual(validateWorkRegistry(repository), {
      itemCount: 1,
      sourceCount: 0,
    });
    assert.match(
      fs.readFileSync(path.join(repository, 'docs/BACKLOG.md'), 'utf8'),
      /No open Work Items\./,
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, `docs/work-history/${closedYear}.md`),
        'utf8',
      ),
      new RegExp(`${itemId}.*delivered; demo-change`),
    );
    for (const expectedPath of [
      itemPath,
      'docs/BACKLOG.md',
      'docs/work-registry/inventory.json',
      `docs/work-history/${closedYear}.md`,
    ]) {
      assert.equal(committed.changedPaths.includes(expectedPath), true);
    }
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.deepEqual(
      validateCiArchiveCommit(repository, committed.commitHash, 'demo-change')
        .changedPaths,
      committed.changedPaths,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rejects silently ignored delta outcomes', () => {
  const repository = completedFixture(
    [
      '# Delta',
      '',
      '<!-- ARCHIVE_IGNORE_DELTA -->',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Ignored archive change',
      'The system SHALL detect an archive projection that ignores its delta.',
      '',
      '#### Scenario: Archive ignores the reviewed delta',
      '',
      '- **WHEN** the public archive reports a change without applying it',
      '- **THEN** the transition rejects the inconsistent outcome',
      '',
    ].join('\n'),
  );
  try {
    const before = repositoryState(repository);
    assert.throws(
      () => commitArchiveTransition(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rejects real-worktree drift before patch application', () => {
  const repository = completedFixture(addedDelta());
  const driftPath = path.join(repository, 'drift.txt');
  try {
    const before = repositoryState(repository);
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeApply: () => fs.writeFileSync(driftPath, 'drift\n'),
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_ELIGIBILITY_CHANGED'),
    );
    fs.rmSync(driftPath);
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rolls back its patch when the branch loses the compare-and-swap race', () => {
  const repository = completedFixture(addedDelta());
  const before = git(repository, ['rev-parse', 'HEAD']).trim();
  let competingCommit = '';
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeRefUpdate: ({ headRef }) => {
            competingCommit = git(repository, [
              'commit-tree',
              `${before}^{tree}`,
              '-p',
              before,
              '-m',
              'Competing commit',
            ]).trim();
            git(repository, ['update-ref', headRef, competingCommit, before]);
          },
        }),
      (error) => isWorkflowError(error, 'ARCHIVE_HEAD_CHANGED'),
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      competingCommit,
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/archive')),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transition rolls back its patch when persisted evidence is tampered', () => {
  const repository = completedFixture(addedDelta());
  const before = repositoryState(repository);
  try {
    assert.throws(
      () =>
        commitArchiveTransition(repository, 'demo-change', process.env, {
          beforeRefUpdate: ({ reportId }) => {
            fs.appendFileSync(
              path.join(
                runtimeRoot(repository),
                'archive-reports',
                `${reportId}.json`,
              ),
              'tamper',
            );
          },
        }),
      (error) => isWorkflowError(error, 'CONTENT_RECORD_DIGEST_MISMATCH'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function completedFixture(
  delta: string,
  beforePlanning?: (repository: string) => void,
): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    delta,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive delta']);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  beforePlanning?.(repository);
  writeReadyV3ExemptChange(repository);
  fs.chmodSync(runtimeRoot(repository), 0o700);
  withPlanningIgnoredDeltaDisabled(repository, delta, () =>
    commitPlanningTransition(repository, 'demo-change'),
  );
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  checkSession(repository, session.sessionId);
  completeTask(repository, session.sessionId);
  finishSession(repository, session.sessionId);
  const completed = commitSession(
    repository,
    session.sessionId,
    'Complete demo task',
  );
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', completed.commitHash]);
  syncOriginMain(repository);
  git(repository, ['checkout', '-b', 'work/archive-demo']);
  return repository;
}

function showWorkItemAtCommit(
  repository: string,
  commitHash: string,
  itemPath: string,
): Record<string, unknown> {
  return JSON.parse(
    git(repository, ['show', `${commitHash}:${itemPath}`]),
  ) as Record<string, unknown>;
}

function withPlanningIgnoredDeltaDisabled<T>(
  repository: string,
  delta: string,
  action: () => T,
): T {
  if (!delta.includes('ARCHIVE_IGNORE_DELTA')) return action();
  const helperPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/archive-helper.js',
  );
  const original = fs.readFileSync(helperPath, 'utf8');
  const disabled = original.replace(
    "'ARCHIVE_IGNORE_DELTA'",
    "'DISABLED_ARCHIVE_IGNORE_DELTA'",
  );
  assert.notEqual(disabled, original);
  fs.writeFileSync(helperPath, disabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(helperPath, original);
  }
}

function addedDelta(): string {
  return [
    '# Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    'The system SHALL provide a demo.',
    '',
    '#### Scenario: Demo works',
    '',
    '- **WHEN** the demo runs',
    '- **THEN** it succeeds',
    '',
  ].join('\n');
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}
