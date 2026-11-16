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
const createArchiveTransformation = createArchiveTransformationWithHandoff.bind(
  undefined,
  createArchiveProjectionDependencies(),
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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { withArchiveEligibility } from '../src/application/archive/archive-eligibility.ts';
import { createArchiveTransformation as createArchiveTransformationWithHandoff } from '../src/application/archive/archive-transformation.ts';
import { createOpenSpecPlanningArchiveProjectionPort } from '../src/composition-root/planning-archive-projection-production.ts';
import { commitSession } from '../src/runtime/finalization/commit.ts';
import { finalizeTask } from './support/session-lifecycle-host.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
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

test('archive transformation reaches planning-provider archive projection only through its port', () => {
  const source = fs.readFileSync(
    new URL(
      '../src/application/archive/archive-transformation.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(source, /openspec-adapter\/validation-payload/);
  assert.doesNotMatch(source, /openspec-executor/);
  assert.doesNotMatch(source, /\bcreateOpenSpecProcess\b/);
  assert.doesNotMatch(source, /\bresolveOpenSpecInstallation\b/);
  assert.doesNotMatch(source, /\bparseOpenSpecValidationPayloadV1\b/);
});

test('archive transformation returns an exact full-index patch without mutating the real worktree', () => {
  const repository = completedFixture();
  try {
    const before = realState(repository);
    const result = withArchiveEligibility(
      loadStableValidatedChangeContract,
      productionPlanningExecution,
      archiveEligibilityReplayServices,
      productionArchiveGrantCodec,
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

test('archive reconciliation failure prevents handoff and cleans its temporary projection', () => {
  const repository = completedFixture();
  const failure = new Error('injected registry reconciliation failure');
  let reconciliations = 0;
  let handoffCalls = 0;
  try {
    const before = realState(repository);
    const worktrees = git(repository, ['worktree', 'list', '--porcelain']);
    assert.throws(
      () =>
        withArchiveEligibility(
          loadStableValidatedChangeContract,
          productionPlanningExecution,
          archiveEligibilityReplayServices,
          productionArchiveGrantCodec,
          repository,
          'demo-change',
          (eligible) =>
            createArchiveTransformationWithHandoff(
              createArchiveProjectionDependencies(),
              () => {
                handoffCalls++;
                throw new Error('handoff must not run');
              },
              (root, changeId, archivedRoot, closedAt) => {
                reconciliations++;
                assert.notEqual(root, repository);
                assert.equal(changeId, eligible.changeId);
                assert.equal(archivedRoot, eligible.archiveDestination);
                assert.equal(
                  closedAt,
                  new Date(
                    git(root, [
                      'show',
                      '-s',
                      '--format=%cI',
                      eligible.head,
                    ]).trim(),
                  ).toISOString(),
                );
                throw failure;
              },
              eligible,
            ),
        ),
      (error) => error === failure,
    );
    assert.equal(reconciliations, 1);
    assert.equal(handoffCalls, 0);
    assert.deepEqual(realState(repository), before);
    assert.equal(
      git(repository, ['worktree', 'list', '--porcelain']),
      worktrees,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transformation refuses a bound provider projection that rejects rebuilt specs', () => {
  const repository = completedFixture();
  try {
    const before = realState(repository);
    const productionPort = createOpenSpecPlanningArchiveProjectionPort();
    assert.throws(
      () =>
        withArchiveEligibility(
          loadStableValidatedChangeContract,
          productionPlanningExecution,
          archiveEligibilityReplayServices,
          productionArchiveGrantCodec,
          repository,
          'demo-change',
          (eligible) =>
            createArchiveTransformation(eligible, {
              archiveProjectionPort: {
                ...productionPort,
                validateProjectedSpecs: (context) => ({
                  ...productionPort.validateProjectedSpecs(context),
                  valid: false,
                  diagnostics: [
                    {
                      level: 'ERROR',
                      path: 'openspec/specs/demo/spec.md',
                      message: 'The bound provider rejected rebuilt specs.',
                    },
                  ],
                }),
              },
            }),
        ),
      (error) => isWorkflowError(error, 'ARCHIVE_REBUILT_SPECS_INVALID'),
    );
    assert.deepEqual(realState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive transformation rejects an eligibility manifest that differs from the active tree', () => {
  const repository = completedFixture();
  try {
    assert.throws(
      () =>
        withArchiveEligibility(
          loadStableValidatedChangeContract,
          productionPlanningExecution,
          archiveEligibilityReplayServices,
          productionArchiveGrantCodec,
          repository,
          'demo-change',
          (eligible) =>
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
        withArchiveEligibility(
          loadStableValidatedChangeContract,
          productionPlanningExecution,
          archiveEligibilityReplayServices,
          productionArchiveGrantCodec,
          repository,
          'demo-change',
          (eligible) =>
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
            withArchiveEligibility(
              loadStableValidatedChangeContract,
              productionPlanningExecution,
              archiveEligibilityReplayServices,
              productionArchiveGrantCodec,
              repository,
              'demo-change',
              (eligible) =>
                createArchiveTransformation(eligible, {
                  testHooks: {
                    aroundArchivePreparation: (invoke) =>
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
  const enabled = disabled.replace(`'DISABLED_${marker}'`, `'${marker}'`);
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
