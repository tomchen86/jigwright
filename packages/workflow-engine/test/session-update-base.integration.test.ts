import { verifyPullRequest } from '../src/composition-root/ci-verification-production.ts';
import {
  productionChangeRoutingInspector,
  productionChangeRoutingAdmissionReader,
} from '../src/composition-root/change-routing-observation-production.ts';
import {
  loadChangeContract as productionChangeContractReader,
  loadCommittedChangeContract as productionCommittedChangeContractReader,
} from '../src/composition-root/consumer-contract-production.ts';
const updateTaskSessionBase = updateTaskSessionBaseWithContractReader.bind(
  undefined,
  verifyPullRequest,
  productionChangeRoutingInspector,
  {
    loadChangeContract: productionChangeContractReader,
    loadCommittedChangeContract: productionCommittedChangeContractReader,
  },
);
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateTaskSessionBase as updateTaskSessionBaseWithContractReader } from '../src/application/execute-task/update-base.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { commitSession } from '../src/application/finalize/lifecycle.ts';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import {
  prepareFinishedNonFinalTaskForBaseUpdate,
  removeConcurrentTaskWorktree,
  snapshotTaskPreflightState,
  prepareConcurrentTaskWorktree,
} from './support/session-lifecycle-fixture.ts';

test('update-base replays a finished non-final task branch and recomputes local PR assurance', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    const { committed, started } = prepared;
    const finishedSession = getSession(fixture.worktree, started.sessionId);
    const expectedInvalidatedRuntimeReportIds = [
      finishedSession.latestCheckReportId,
      finishedSession.completionReportId,
      finishedSession.finishReportId,
      finishedSession.commitReportId,
      finishedSession.implementationReconciliationReportId,
    ]
      .filter((reportId): reportId is string => reportId !== undefined)
      .sort();
    assert.ok(expectedInvalidatedRuntimeReportIds.length > 0);

    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const ontoCommit = git(repository, ['rev-parse', 'main']).trim();

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      result: {
        changeId: string;
        oldHead: string;
        newHead: string;
        ontoCommit: string;
        invalidatedRuntimeReportIds: string[];
        revalidated: {
          planningGenerationId: string;
          allowedPaths: string[];
        };
        assurance: {
          base: string;
          head: string;
          checkIds: string[];
        };
      };
    };
    assert.equal(output.result.changeId, 'demo-change');
    assert.equal(output.result.oldHead, committed.commitHash);
    assert.notEqual(output.result.newHead, output.result.oldHead);
    assert.equal(output.result.ontoCommit, ontoCommit);
    assert.deepEqual(
      output.result.invalidatedRuntimeReportIds,
      expectedInvalidatedRuntimeReportIds,
    );
    assert.match(
      output.result.revalidated.planningGenerationId,
      /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(output.result.revalidated.allowedPaths, ['src/task/**']);
    assert.deepEqual(output.result.assurance, {
      base: ontoCommit,
      head: output.result.newHead,
      checkIds: ['fixture'],
    });

    const refreshed = getSession(fixture.worktree, started.sessionId);
    assert.equal(refreshed.state, 'committed');
    assert.equal(refreshed.commitHash, committed.commitHash);
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(
          path.resolve(
            fixture.worktree,
            git(fixture.worktree, ['rev-parse', '--git-common-dir']).trim(),
          ),
          'workflow-engine',
          'base-refreshes',
          'demo-change',
          `${output.result.newHead}.json`,
        ),
        'utf8',
      ),
    ) as {
      sessionId: string;
      oldHead: string;
      newHead: string;
      invalidatedRuntimeReportIds: string[];
      assuranceCheckIds: string[];
    };
    assert.equal(receipt.sessionId, started.sessionId);
    assert.equal(receipt.oldHead, committed.commitHash);
    assert.equal(receipt.newHead, output.result.newHead);
    assert.deepEqual(
      receipt.invalidatedRuntimeReportIds,
      expectedInvalidatedRuntimeReportIds,
    );
    assert.deepEqual(receipt.assuranceCheckIds, ['fixture']);
    git(fixture.worktree, [
      'merge-base',
      '--is-ancestor',
      ontoCommit,
      output.result.newHead,
    ]);
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      output.result.newHead,
    );
    const repeated = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(repeated.status, 14, repeated.stderr);
    assert.match(
      `${repeated.stdout}\n${repeated.stderr}`,
      /UPDATE_BASE_NOT_ADVANCED/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      output.result.newHead,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base rolls back when the selected local ref changes before receipt publication', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const ontoCommit = git(repository, ['rev-parse', 'main']).trim();
    const before = snapshotTaskPreflightState(fixture.worktree);
    let movedOntoCommit: string | undefined;

    assert.throws(
      () =>
        updateTaskSessionBase(
          fixture!.worktree,
          'demo-change',
          'main',
          process.env,
          {
            beforeReceiptPublication(context) {
              assert.deepEqual(context, { ontoRef: 'main', ontoCommit });
              fs.writeFileSync(
                path.join(repository, 'src/base-drift.ts'),
                'export const baseDrift = true;\n',
              );
              git(repository, ['add', 'src/base-drift.ts']);
              git(repository, [
                'commit',
                '-m',
                'Advance selected base during update',
              ]);
              movedOntoCommit = git(repository, ['rev-parse', 'main']).trim();
            },
          },
        ),
      (error) => {
        assert.equal(
          isWorkflowError(error, 'UPDATE_BASE_TARGET_CHANGED'),
          true,
        );
        assert.deepEqual((error as WorkflowError).details, {
          ontoRef: 'main',
          expectedOntoCommit: ontoCommit,
          observedOntoCommit: movedOntoCommit,
        });
        return true;
      },
    );
    assert.notEqual(movedOntoCommit, undefined);
    const after = snapshotTaskPreflightState(fixture.worktree);
    assert.deepEqual(
      {
        head: after.head,
        tree: after.tree,
        status: after.status,
        runtime: after.runtime,
      },
      {
        head: before.head,
        tree: before.tree,
        status: before.status,
        runtime: before.runtime,
      },
    );
    assert.equal(
      git(repository, ['rev-parse', 'main']).trim(),
      movedOntoCommit,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base revalidates active writers after acquiring the lifecycle lock', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const prepared = prepareFinishedNonFinalTaskForBaseUpdate(repository);
    fixture = prepared.fixture;
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);
    const beforeHead = git(fixture.worktree, ['rev-parse', 'HEAD']).trim();
    const refreshRoot = path.join(
      runtimeRoot(fixture.worktree),
      'base-refreshes',
      'demo-change',
    );
    let interleavedSession: ReturnType<typeof startSession> | undefined;

    assert.throws(
      () =>
        updateTaskSessionBase(
          fixture!.worktree,
          'demo-change',
          'main',
          process.env,
          {
            afterFinishedSessionPreflight() {
              interleavedSession = startSession(
                productionChangeRoutingAdmissionReader,
                fixture!.worktree,
                'demo-change',
                '1.2',
              );
            },
          },
        ),
      (error) => isWorkflowError(error, 'UPDATE_BASE_ACTIVE_SESSION_PRESENT'),
    );
    assert.ok(interleavedSession);
    assert.equal(interleavedSession.state, 'active');
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      beforeHead,
    );
    assert.equal(fs.existsSync(refreshRoot), false);
    abortSession(
      fixture.worktree,
      interleavedSession.sessionId,
      'Release the interleaved update-base regression session.',
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base refuses an active writer before changing Git history', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const started = startSession(
      productionChangeRoutingAdmissionReader,
      fixture.worktree,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(result.status, 13, result.stdout);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /UPDATE_BASE_ACTIVE_SESSION_PRESENT/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      started.baseline.head,
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base rolls back when generated reconciliation needs a reviewed transition', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      documents: { handoffPath: string };
    };
    consumer.documents.handoffPath = 'notebook/handoff.md';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'tracked default handoff sentinel\n',
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Configure alternate handoff path']);
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const taskWorktree = fixture.worktree;
    const started = startSession(
      productionChangeRoutingAdmissionReader,
      taskWorktree,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(taskWorktree, 'src/task'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(taskWorktree, 'src/task/feature.ts'),
      'export const feature = true;\n',
    );
    assert.throws(
      () => finalizeTask(taskWorktree, started.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(
      taskWorktree,
      started.sessionId,
      'src/task/feature.ts',
    );
    finalizeTask(taskWorktree, started.sessionId);
    const committed = commitSession(
      productionChangeRoutingAdmissionReader,
      taskWorktree,
      started.sessionId,
      'Complete concurrent fixture task',
    );
    fs.writeFileSync(
      path.join(repository, 'src/base-update.ts'),
      'export const baseUpdate = true;\n',
    );
    git(repository, ['add', 'src/base-update.ts']);
    git(repository, ['commit', '-m', 'Advance fixture base']);

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'update-base',
        'demo-change',
        '--onto',
        'main',
        '--json',
      ],
      { cwd: fixture.worktree, encoding: 'utf8' },
    );
    assert.equal(result.status, 14, result.stderr);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /UPDATE_BASE_GENERATED_RECONCILIATION_REQUIRED/,
    );
    assert.equal(
      git(fixture.worktree, ['rev-parse', 'HEAD']).trim(),
      committed.commitHash,
    );
    assert.equal(git(fixture.worktree, ['status', '--porcelain']), '');
    assert.equal(
      fs.existsSync(path.join(fixture.worktree, 'notebook/handoff.md')),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(fixture.worktree, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      'tracked default handoff sentinel\n',
    );
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
