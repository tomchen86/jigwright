import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { withArchiveEligibility } from '../src/application/archive/archive-eligibility.ts';
import { createArchiveTransformation } from '../src/application/archive/archive-transformation.ts';
import {
  commitSession,
  finalizeTask,
} from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { startSession } from '../src/application/execute-task/session.ts';
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

test('archive transformation returns an exact full-index patch without mutating the real worktree', () => {
  const repository = completedFixture();
  try {
    const before = realState(repository);
    const result = withArchiveEligibility(
      repository,
      'demo-change',
      (eligible) => createArchiveTransformation(eligible),
    );

    assert.deepEqual(realState(repository), before);
    assert.equal(result.changeId, 'demo-change');
    assert.match(result.archiveName, /^\d{4}-\d{2}-\d{2}-demo-change$/);
    assert.equal(
      result.archivePath,
      `openspec/changes/archive/${result.archiveName}`,
    );
    assert.deepEqual(result.baseSpecPaths, ['openspec/specs/demo/spec.md']);
    assert.ok(
      result.changedPaths.every(
        (changedPath) =>
          changedPath.startsWith('openspec/changes/demo-change/') ||
          changedPath.startsWith(`${result.archivePath}/`) ||
          result.baseSpecPaths.includes(changedPath),
      ),
    );
    assert.match(result.patch, /^diff --git /m);
    assert.match(result.patch, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);
    assert.match(result.patchDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(result.archivedArtifactDigests).sort(), [
      '.openspec.yaml',
      'design.md',
      'execution.json',
      'guard.json',
      'investigation.json',
      'plan-review.json',
      'proposal.md',
      'specs/demo/spec.md',
      'tasks.md',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transformation rejects an eligibility manifest that differs from the active tree', () => {
  const repository = completedFixture();
  try {
    assert.throws(
      () =>
        withArchiveEligibility(repository, 'demo-change', (eligible) =>
          createArchiveTransformation({
            ...eligible,
            activeArtifactPaths: eligible.activeArtifactPaths.slice(1),
          }),
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSFORMATION_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transformation rejects a schema selection that contradicts its manifest', () => {
  const repository = completedFixture();
  try {
    assert.throws(
      () =>
        withArchiveEligibility(repository, 'demo-change', (eligible) =>
          createArchiveTransformation({
            ...eligible,
            schemaName: 'expense-app',
          }),
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_TRANSFORMATION_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const fault of [
  ['PARTIAL_FAILURE', 'OPENSPEC_ARCHIVE_FAILED'],
  ['ARCHIVE_ESCAPE', 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'],
  ['ARCHIVE_UNEXPECTED', 'ARCHIVE_TRANSFORMATION_PATHS_INVALID'],
] as const) {
  test(`archive transformation confines ${fault[0].toLowerCase()} faults`, () => {
    const repository = completedFixture(fault[0]);
    try {
      const before = realState(repository);
      assert.throws(
        () =>
          withPlanningFaultDisabled(repository, fault[0], () =>
            withArchiveEligibility(repository, 'demo-change', (eligible) =>
              createArchiveTransformation(eligible, {
                testHooks: {
                  aroundOpenSpecArchive: (invoke) =>
                    withArchiveFaultEnabled(repository, fault[0], invoke),
                },
              }),
            ),
          ),
        (error) => isWorkflowError(error, fault[1]),
      );
      assert.deepEqual(realState(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function completedFixture(marker?: string): string {
  const repository = createFixtureRepository();
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  if (marker) {
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
      `\n${marker}\n`,
    );
  }
  writeReadyV3ExemptChange(repository);
  fs.chmodSync(runtimeRoot(repository), 0o700);
  withPlanningFaultDisabled(repository, marker, () =>
    commitPlanningTransition(repository, 'demo-change'),
  );
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  assert.throws(
    () => finalizeTask(repository, session.sessionId),
    (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
  );
  satisfyCurrentTaskDiffReview(repository, session.sessionId);
  finalizeTask(repository, session.sessionId);
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

function withPlanningFaultDisabled<T>(
  repository: string,
  marker: string | undefined,
  action: () => T,
): T {
  if (!marker) return action();
  const binaryPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const original = fs.readFileSync(binaryPath, 'utf8');
  const disabled = original.replace(`'${marker}'`, `'DISABLED_${marker}'`);
  assert.notEqual(disabled, original);
  fs.writeFileSync(binaryPath, disabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(binaryPath, original);
  }
}

function withArchiveFaultEnabled<T>(
  repository: string,
  marker: string,
  action: () => T,
): T {
  const binaryPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/bin/openspec.js',
  );
  const disabled = fs.readFileSync(binaryPath, 'utf8');
  const enabled = disabled.replace(
    `'DISABLED_${marker}'`,
    `'${marker}'`,
  );
  assert.notEqual(enabled, disabled);
  fs.writeFileSync(binaryPath, enabled);
  try {
    return action();
  } finally {
    fs.writeFileSync(binaryPath, disabled);
  }
}

function realState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    worktrees: git(repository, ['worktree', 'list', '--porcelain']),
  };
}
