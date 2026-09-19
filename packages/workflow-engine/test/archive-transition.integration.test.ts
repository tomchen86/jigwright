import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { createArchiveProjectionDependencies } from '../src/composition-root/planning-archive-projection-production.ts';
import { loadStableValidatedChangeContract } from '../src/composition-root/validated-contract-context.ts';
import { archiveEligibilityReplayServices } from '../src/composition-root/ci-replay-production.ts';
import { productionPlanningArchiveSourcePolicy } from '../src/composition-root/planning-archive-projection-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { collaborationGrantCodec as productionArchiveGrantCodec } from '../src/runtime/grants/grant-services.ts';
import { reconcileArchivedWorkItems as productionArchivedWorkItemReconciler } from '../src/composition-root/work-registry-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { renderHandoffFromTrackedFacts as productionTrackedHandoffRenderer } from '../src/composition-root/handoff-production.ts';
const commitArchiveTransition = commitArchiveTransitionWithHandoff.bind(
  undefined,
  loadStableValidatedChangeContract,
  productionPlanningExecution,
  createArchiveProjectionDependencies(),
  archiveEligibilityReplayServices,
  productionArchiveGrantCodec,
  productionTrackedHandoffRenderer,
  productionArchivedWorkItemReconciler,
);
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitArchiveTransition as commitArchiveTransitionWithHandoff } from '../src/application/archive/archive-transition.ts';
import { commitSession } from '../src/application/finalize/lifecycle.ts';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  applyManagedChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import { validateRepositoryStateAtCommit } from '../src/composition-root/repository-validation.ts';
import { runCli } from '../bootstrap/workflow-engine-host.ts';
import { validateCiArchiveCommit } from '../src/composition-root/ci-replay-production.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  promoteWorkItem,
  showWorkItem,
  validateWorkRegistry,
  workItemDigest,
} from '../src/composition-root/work-registry-production.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
  syncOriginMain,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { readArchiveReport } from '../src/runtime/storage-journal/archive-report.ts';
import { writeContentRecord } from '../src/runtime/storage-journal/content-record-store.ts';

const LOCAL_PROTECTED_BASE_REF = 'refs/jigwright/protected-base';

test('local protected base archives unmerged managed tasks and advances both refs idempotently', () => {
  const repository = completedFixture(addedDelta(), undefined, {
    localProtectedBase: true,
  });
  try {
    const before = repositoryState(repository);
    const baseBefore = git(repository, [
      'rev-parse',
      LOCAL_PROTECTED_BASE_REF,
    ]).trim();
    assert.equal(git(repository, ['remote']), '');
    assert.equal(git(repository, ['for-each-ref', 'refs/remotes/']), '');
    assert.equal(baseBefore, git(repository, ['rev-parse', 'main']).trim());
    assert.notEqual(baseBefore, before.head);
    assert.equal(
      git(repository, ['merge-base', baseBefore, before.head]).trim(),
      baseBefore,
    );
    assert.match(
      git(repository, ['log', '--format=%B', `${baseBefore}..HEAD`]),
      /Complete demo task/,
    );

    const committed = commitArchiveTransition(repository, 'demo-change');

    assert.equal(committed.status, 'committed');
    assert.notEqual(committed.commitHash, before.head);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      committed.commitHash,
    );
    assert.equal(
      git(repository, ['rev-parse', LOCAL_PROTECTED_BASE_REF]).trim(),
      committed.commitHash,
    );
    assert.equal(git(repository, ['rev-parse', 'main']).trim(), baseBefore);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repository, committed.archivePath)),
      true,
    );
    assert.equal(
      readArchiveReport(
        path.join(runtimeRoot(repository), 'archive-reports'),
        committed.reportId,
      ).commitHash,
      committed.commitHash,
    );
    const after = repositoryState(repository);

    const replayed = commitArchiveTransition(repository, 'demo-change');

    assert.equal(replayed.status, 'already-archived');
    assert.equal(replayed.commitHash, committed.commitHash);
    assert.equal(replayed.reportId, committed.reportId);
    assert.deepEqual(repositoryState(repository), after);
    assert.equal(
      git(repository, ['rev-parse', LOCAL_PROTECTED_BASE_REF]).trim(),
      committed.commitHash,
    );
    assert.equal(git(repository, ['remote']), '');
    assert.equal(git(repository, ['for-each-ref', 'refs/remotes/']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('local protected-base drift rolls back archive without overwriting either ref', () => {
  const repository = completedFixture(addedDelta(), undefined, {
    localProtectedBase: true,
  });
  try {
    const before = repositoryState(repository);
    const baseBefore = git(repository, [
      'rev-parse',
      LOCAL_PROTECTED_BASE_REF,
    ]).trim();
    let competingCommit = '';
    assert.throws(() =>
      commitArchiveTransition(repository, 'demo-change', process.env, {
        beforeRefUpdate: () => {
          competingCommit = git(repository, [
            'commit-tree',
            `${baseBefore}^{tree}`,
            '-p',
            baseBefore,
            '-m',
            'Competing local protected base',
          ]).trim();
          git(repository, [
            'update-ref',
            LOCAL_PROTECTED_BASE_REF,
            competingCommit,
            baseBefore,
          ]);
        },
      }),
    );
    assert.notEqual(
      competingCommit,
      '',
      'archive must reach the ref update boundary',
    );
    assert.equal(
      git(repository, ['rev-parse', LOCAL_PROTECTED_BASE_REF]).trim(),
      competingCommit,
    );
    assert.deepEqual(repositoryState(repository), before);
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/demo-change')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes/archive')),
      false,
    );
    assert.equal(git(repository, ['for-each-ref', 'refs/remotes/']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive report reader rejects digest-valid extra own keys without mutation', () => {
  const repository = createFixtureRepository();
  try {
    const runtime = runtimeRoot(repository);
    const directory = path.join(runtime, 'archive-reports');
    const parent = git(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(
      path.join(repository, 'archive-report-fixture.txt'),
      'current archive report\n',
    );
    git(repository, ['add', 'archive-report-fixture.txt']);
    git(repository, ['commit', '-m', 'Prepare archive report fixture']);
    const commitHash = git(repository, ['rev-parse', 'HEAD']).trim();
    const patch = git(repository, ['diff', '--binary', parent, commitHash]);
    const reportId = writeContentRecord(directory, {
      schemaVersion: 1,
      kind: 'archive-transition',
      createdAt: '2026-09-01T00:00:00.000Z',
      changeId: 'demo-change',
      archivePath: 'openspec/changes/archive/2026-09-01-demo-change',
      parent,
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      commitHash,
      patch,
      patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
      changedPaths: git(repository, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        commitHash,
      ])
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort(),
      logicalIdentity: 'current-archive-report-fixture',
      contractDigest: '1'.repeat(64),
      promotedSpecDigests: {},
      archivedArtifactDigests: {},
      legacyProjection: { inferred: true },
    });
    const before = {
      repository: repositoryState(repository),
      refs: git(repository, ['show-ref']),
      worktrees: git(repository, ['worktree', 'list', '--porcelain']),
      runtime: snapshotDirectory(runtime),
    };

    assert.throws(
      () => readArchiveReport(directory, reportId),
      (error) => isWorkflowError(error, 'ARCHIVE_REPORT_INVALID'),
    );
    assert.deepEqual(
      {
        repository: repositoryState(repository),
        refs: git(repository, ['show-ref']),
        worktrees: git(repository, ['worktree', 'list', '--porcelain']),
        runtime: snapshotDirectory(runtime),
      },
      before,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

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

test('archive refreshes a current routed managed handoff in its immutable projection', () => {
  const repository = completedFixture(addedDelta(), undefined, {
    routedManagedHandoff: true,
  });
  try {
    const handoffPath = 'docs/CURRENT_AND_NEXT_STEPS.md';
    const before = fs.readFileSync(path.join(repository, handoffPath), 'utf8');
    assert.match(before, /## Pending Archival[\s\S]*`demo-change`/u);
    assert.match(before, /## Ready Changes[\s\S]*`other-change`/u);
    const foreignJournalPath = path.join(
      runtimeRoot(repository),
      'open-task',
      'transactions',
      'foreign-recovery.json',
    );
    fs.mkdirSync(path.dirname(foreignJournalPath), { recursive: true });
    fs.writeFileSync(
      foreignJournalPath,
      `${JSON.stringify({
        changeId: 'other-change',
        phase: 'prepared',
        sessionId: 'session-foreign-recovery',
      })}\n`,
    );

    const committed = commitArchiveTransition(repository, 'demo-change');

    assert.equal(committed.changedPaths.includes(handoffPath), true);
    const after = fs.readFileSync(path.join(repository, handoffPath), 'utf8');
    assert.doesNotMatch(after, /## Pending Archival[\s\S]*`demo-change`/u);
    assert.match(after, /## Ready Changes[\s\S]*`other-change`/u);
    assert.doesNotMatch(after, /\brecovery-required\b/u);
    assert.doesNotThrow(() =>
      validateRepositoryStateAtCommit(repository, committed.commitHash),
    );
    fs.rmSync(foreignJournalPath);
    assert.deepEqual(
      validateCiArchiveCommit(repository, committed.commitHash, 'demo-change')
        .changedPaths,
      committed.changedPaths,
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
  const delta = [
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
  ].join('\n');
  const repository = completedFixture(delta);
  try {
    const before = repositoryState(repository);
    assert.throws(
      () =>
        withPlanningIgnoredDeltaDisabled(repository, delta, () =>
          commitArchiveTransition(repository, 'demo-change', process.env, {
            aroundArchivePreparation: (invoke) =>
              withPlanningIgnoredDeltaEnabled(repository, invoke),
          }),
        ),
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
  options: Readonly<{
    routedManagedHandoff?: boolean;
    localProtectedBase?: boolean;
  }> = {},
): string {
  const repository = createFixtureRepository({
    initializeRemoteTrackingBase: options.localProtectedBase !== true,
  });
  if (options.routedManagedHandoff === true) {
    const policyPath = path.join(repository, 'workflow/document-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      documents: Record<string, unknown>;
    };
    policy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
      mode: 'generated',
      enforcement: 'active',
      source: 'openspec/changes/*/tasks.md',
      validator: 'managed-documents',
      transition: 'completion',
    };
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    delta,
  );
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure archive delta']);
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  if (options.localProtectedBase === true) {
    // Fixture setup only; real local initialization requires an exact Grant.
    git(repository, [
      'update-ref',
      LOCAL_PROTECTED_BASE_REF,
      'HEAD',
      '0'.repeat(40),
    ]);
  }
  beforePlanning?.(repository);
  writeReadyV3ExemptChange(repository);
  fs.chmodSync(runtimeRoot(repository), 0o700);
  withPlanningIgnoredDeltaDisabled(repository, delta, () =>
    commitPlanningTransition(repository, 'demo-change'),
  );
  if (options.routedManagedHandoff === true) {
    const companionChangeId = 'other-change';
    fs.cpSync(
      path.join(repository, 'openspec/changes/demo-change'),
      path.join(repository, 'openspec/changes', companionChangeId),
      { recursive: true },
    );
    const companionGuardPath = path.join(
      repository,
      'openspec/changes',
      companionChangeId,
      'guard.json',
    );
    const companionGuard = JSON.parse(
      fs.readFileSync(companionGuardPath, 'utf8'),
    ) as { changeId: string };
    companionGuard.changeId = companionChangeId;
    fs.writeFileSync(
      companionGuardPath,
      `${JSON.stringify(companionGuard, null, 2)}\n`,
    );
    const providerBindingPath = path.join(
      repository,
      'workflow/change-providers',
      `${companionChangeId}.json`,
    );
    const providerBinding = JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/change-providers/demo-change.json'),
        'utf8',
      ),
    ) as { changeId: string; planningRoot: string };
    providerBinding.changeId = companionChangeId;
    providerBinding.planningRoot = `openspec/changes/${companionChangeId}`;
    fs.writeFileSync(
      providerBindingPath,
      `${JSON.stringify(providerBinding, null, 2)}\n`,
    );
    writeReadyV3ExemptChange(repository, companionChangeId);
    git(repository, [
      'add',
      '--',
      `openspec/changes/${companionChangeId}`,
      `workflow/change-providers/${companionChangeId}.json`,
    ]);
    git(repository, ['commit', '-m', 'Seed companion routed change']);
    applyManagedChangeRoutingReview(
      repository,
      prepareChangeRoutingReview(repository, {
        schemaVersion: 1,
        action: { kind: 'focus', changeId: 'demo-change' },
      }),
    );
  }
  const session = startSession(
    productionChangeContract,
    repository,
    'demo-change',
    '1.1',
  );
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  assert.throws(
    () => finalizeTask(repository, session.sessionId),
    (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
  );
  satisfyCurrentTaskDiffReview(repository, session.sessionId);
  finalizeTask(repository, session.sessionId);
  const completed = commitSession(
    productionChangeContract,
    repository,
    session.sessionId,
    'Complete demo task',
  );
  if (options.localProtectedBase !== true) {
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', completed.commitHash]);
    syncOriginMain(repository);
  }
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

function withPlanningIgnoredDeltaEnabled<T>(
  repository: string,
  action: () => T,
): T {
  const helperPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/archive-helper.js',
  );
  const disabled = fs.readFileSync(helperPath, 'utf8');
  const enabled = disabled.replace(
    "'DISABLED_ARCHIVE_IGNORE_DELTA'",
    "'ARCHIVE_IGNORE_DELTA'",
  );
  assert.notEqual(enabled, disabled);
  fs.writeFileSync(helperPath, enabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(helperPath, disabled);
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

function snapshotDirectory(root: string): readonly unknown[] {
  const result: unknown[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return;
    result.push({
      path: relative,
      mode: stats.mode,
      kind: stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : stats.isSymbolicLink()
            ? 'symlink'
            : 'other',
      content: stats.isFile()
        ? fs.readFileSync(absolute).toString('base64')
        : stats.isSymbolicLink()
          ? fs.readlinkSync(absolute)
          : null,
    });
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, entry), path.join(relative, entry));
      }
    }
  };
  visit(root, '.');
  return result;
}
