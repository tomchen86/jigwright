import { inspectSession } from '../src/application/finalize/verification.ts';
import {
  productionChangeRoutingInspector,
  productionChangeRoutingAdmissionReader,
} from '../src/composition-root/change-routing-observation-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  isWorkflowError,
  sourceRepositoryRoot,
  configureChecks,
} from './fixture.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { abortSession } from '../src/composition-root/task-session-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepareChangeRoutingReview,
  applyChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import { spawnSync } from 'node:child_process';
import { renderHandoff as renderHandoffWithContractReader } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { commitSession } from '../src/application/finalize/lifecycle.ts';
import { finalizeTask } from './support/local-engine-selection-host.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  addConcurrentChangeSkeleton,
  declareConcurrentWorkset,
  prepareConcurrentTaskWorktree,
  removeConcurrentTaskWorktree,
  snapshotTaskPreflightState,
  prepareCurrentChangeOnMain,
} from './support/session-lifecycle-fixture.ts';

test('two declared disjoint changes own durable isolated writers and an undeclared third writer is rejected', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    addConcurrentChangeSkeleton(repository, 'third-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixtures']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
    );
    const third = prepareConcurrentTaskWorktree(
      repository,
      'third-change',
      'src/third/**',
    );
    fixtures.push(first, second, third);

    let admissionReads = 0;
    const firstSession = startSession(
      (root, changeId) => {
        admissionReads += 1;
        return productionChangeRoutingAdmissionReader(root, changeId);
      },
      first.worktree,
      'demo-change',
      '1.1',
    );
    assert.equal(
      admissionReads,
      2,
      'start observes admission before and inside the lifecycle lock',
    );
    const routingChanged = new Error('injected fresh routing observation');
    let verificationReads = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () =>
          inspectSession(
            () => {
              verificationReads += 1;
              throw routingChanged;
            },
            first.worktree,
            firstSession.sessionId,
          ),
        (error) => error === routingChanged,
      );
    }
    assert.equal(
      verificationReads,
      2,
      'verification never caches a previous routing admission',
    );
    const secondSession = startSession(
      productionChangeRoutingAdmissionReader,
      second.worktree,
      'second-change',
      '1.1',
    );

    assert.notEqual(firstSession.repositoryRoot, secondSession.repositoryRoot);
    assert.notEqual(firstSession.branch, secondSession.branch);
    assert.equal(firstSession.isolation?.routingRole, 'primary');
    assert.equal(secondSession.isolation?.routingRole, 'concurrent');
    assert.equal(
      firstSession.isolation?.routingWorksetDigest,
      secondSession.isolation?.routingWorksetDigest,
    );
    assert.equal(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ).length,
      2,
    );
    const clearConcurrent = prepareChangeRoutingReview(first.worktree, {
      schemaVersion: 1,
      action: { kind: 'clear-concurrent' },
    });
    assert.throws(
      () => applyChangeRoutingReview(first.worktree, clearConcurrent),
      (error) => isWorkflowError(error, 'CHANGE_ROUTING_WORKSET_BUSY'),
    );
    assert.throws(
      () =>
        startSession(
          productionChangeRoutingAdmissionReader,
          third.worktree,
          'third-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'CHANGE_ROUTING_REQUIRED'),
    );

    abortSession(first.worktree, firstSession.sessionId, 'Test cleanup.');
    abortSession(second.worktree, secondSession.sessionId, 'Test cleanup.');
    assert.deepEqual(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ),
      [],
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('status inspects each concurrent active session in its own durable worktree', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent status fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const primary = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/primary/**',
    );
    const concurrent = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      ['src/concurrent/**', 'test/concurrent/**'],
      [],
      {
        executionTask({ policy }) {
          return {
            strategy: 'tdd-single-agent',
            enforcement: 'planned',
            allowedPaths: policy.allowedPaths,
            requiredChecks: policy.requiredChecks,
            diffReview: 'policy-required',
            behaviorContractRefs: [
              {
                specPath: 'specs/demo/spec.md',
                requirement: 'Demo behavior',
                scenario: 'Demo succeeds',
              },
            ],
            testPathScopes: ['test/concurrent/**'],
            fixturePathScopes: [],
            implementationPathScopes: ['src/concurrent/**'],
            redCheck: 'fixture',
            greenChecks: ['fixture'],
            requiredImplementerIndependence: 'none',
          };
        },
      },
    );
    fixtures.push(primary, concurrent);

    const primarySession = startSession(
      productionChangeRoutingAdmissionReader,
      primary.worktree,
      'demo-change',
      '1.1',
    );
    const concurrentSession = startSession(
      productionChangeRoutingAdmissionReader,
      concurrent.worktree,
      'second-change',
      '1.1',
    );
    const beforePrimary = snapshotTaskPreflightState(primary.worktree);
    const beforeConcurrent = snapshotTaskPreflightState(concurrent.worktree);

    const exact = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'status',
        concurrentSession.sessionId,
        '--json',
      ],
      { cwd: primary.worktree, encoding: 'utf8' },
    );
    assert.equal(exact.status, 0, exact.stderr);
    const exactOutput = JSON.parse(exact.stdout) as {
      session: { sessionId: string; isolation: { routingRole: string } };
      taskStrategy: { sessionId: string; strategy: string; state: string };
    };
    assert.equal(exactOutput.session.sessionId, concurrentSession.sessionId);
    assert.equal(exactOutput.session.isolation.routingRole, 'concurrent');
    assert.deepEqual(exactOutput.taskStrategy, {
      schemaVersion: 1,
      kind: 'task-strategy-lifecycle-status.v1',
      invocationId: null,
      sessionId: concurrentSession.sessionId,
      strategy: 'tdd-single-agent',
      state: 'red-authoring',
      transactionDigest: null,
      sessionState: 'active',
    });

    const inventory = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'status',
        '--json',
      ],
      { cwd: primary.worktree, encoding: 'utf8' },
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const inventoryOutput = JSON.parse(inventory.stdout) as {
      sessions: Array<{
        sessionId: string;
        isolation: { routingRole: string };
      }>;
      taskStrategies: Array<{
        sessionId: string;
        strategy: string;
        state: string;
      }>;
    };
    assert.equal(
      inventoryOutput.sessions.find(
        ({ sessionId }) => sessionId === primarySession.sessionId,
      )?.isolation.routingRole,
      'primary',
    );
    assert.equal(
      inventoryOutput.sessions.find(
        ({ sessionId }) => sessionId === concurrentSession.sessionId,
      )?.isolation.routingRole,
      'concurrent',
    );
    assert.deepEqual(
      inventoryOutput.taskStrategies.find(
        ({ sessionId }) => sessionId === concurrentSession.sessionId,
      ),
      {
        schemaVersion: 1,
        kind: 'task-strategy-lifecycle-status.v1',
        invocationId: null,
        sessionId: concurrentSession.sessionId,
        strategy: 'tdd-single-agent',
        state: 'red-authoring',
        transactionDigest: null,
        sessionState: 'active',
      },
    );
    assert.deepEqual(
      snapshotTaskPreflightState(primary.worktree),
      beforePrimary,
    );
    assert.deepEqual(
      snapshotTaskPreflightState(concurrent.worktree),
      beforeConcurrent,
    );

    abortSession(
      primary.worktree,
      primarySession.sessionId,
      'Concurrent status test cleanup.',
    );
    abortSession(
      concurrent.worktree,
      concurrentSession.sessionId,
      'Concurrent status test cleanup.',
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a routed writer keeps its source workset through completion projection and finalize', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    prepareCurrentChangeOnMain(repository);
    applyChangeRoutingReview(
      repository,
      prepareChangeRoutingReview(repository, {
        schemaVersion: 1,
        action: { kind: 'focus', changeId: 'demo-change' },
      }),
    );
    renderHandoff(repository);
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Declare primary test workset']);
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const worktree = fixture.worktree;
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      worktree,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(worktree, 'src/task'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, 'src/task/feature.ts'),
      'export const feature = true;\n',
    );

    assert.throws(
      () => finalizeTask(worktree, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(
      worktree,
      session.sessionId,
      'src/task/feature.ts',
    );
    const finalized = finalizeTask(worktree, session.sessionId);
    assert.equal(finalized.session.finishReportId !== undefined, true);
    const committed = commitSession(
      productionChangeRoutingAdmissionReader,
      worktree,
      session.sessionId,
      'Complete routed fixture task',
    );
    assert.equal(committed.session.state, 'committed');
  } finally {
    if (fixture !== undefined) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a second task writer is rejected when its declared write scope overlaps', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/shared/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/shared/file.ts',
    );
    fixtures.push(first, second);

    startSession(
      productionChangeRoutingAdmissionReader,
      first.worktree,
      'demo-change',
      '1.1',
    );
    assert.throws(
      () =>
        startSession(
          productionChangeRoutingAdmissionReader,
          second.worktree,
          'second-change',
          '1.1',
        ),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_SCOPE_CONFLICT') &&
        (error as WorkflowError).details?.conflictingChangeId === 'demo-change',
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent writers reject distinct paths in the same serialized policy class', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'workflow/first-policy.json',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'workflow/second-policy.json',
    );
    fixtures.push(first, second);

    startSession(
      productionChangeRoutingAdmissionReader,
      first.worktree,
      'demo-change',
      '1.1',
    );
    assert.throws(
      () =>
        startSession(
          productionChangeRoutingAdmissionReader,
          second.worktree,
          'second-change',
          '1.1',
        ),
      (error) =>
        isWorkflowError(error, 'TASK_SESSION_SERIALIZED_SCOPE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent destructive checks require distinct disposable database leases before editing', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    const consumerConfigPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumerConfig = JSON.parse(
      fs.readFileSync(consumerConfigPath, 'utf8'),
    ) as { databasePolicy: { adapterId: string } };
    consumerConfig.databasePolicy.adapterId = 'postgresql-disposable-v1';
    fs.writeFileSync(
      consumerConfigPath,
      `${JSON.stringify(consumerConfig, null, 2)}\n`,
    );
    configureChecks(
      repository,
      {
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['destructive'],
    );
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add destructive concurrent fixtures']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
    );
    fixtures.push(first, second);
    const environment = {
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL: 'postgresql://localhost:5432/concurrent_test',
    };

    startSession(
      productionChangeRoutingAdmissionReader,
      first.worktree,
      'demo-change',
      '1.1',
      { environment },
    );
    assert.throws(
      () =>
        startSession(
          productionChangeRoutingAdmissionReader,
          second.worktree,
          'second-change',
          '1.1',
          {
            environment,
          },
        ),
      (error) => isWorkflowError(error, 'TASK_SESSION_RESOURCE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('concurrent writers reject a shared guard-declared exclusive resource', () => {
  const repository = createFixtureRepository();
  const fixtures: Array<{ parent: string; worktree: string }> = [];
  try {
    addConcurrentChangeSkeleton(repository, 'second-change');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Add concurrent change fixture']);
    declareConcurrentWorkset(repository, 'second-change');
    const first = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/first/**',
      ['simulator:shared-test'],
    );
    const second = prepareConcurrentTaskWorktree(
      repository,
      'second-change',
      'src/second/**',
      ['simulator:shared-test'],
    );
    fixtures.push(first, second);

    startSession(
      productionChangeRoutingAdmissionReader,
      first.worktree,
      'demo-change',
      '1.1',
    );
    assert.throws(
      () =>
        startSession(
          productionChangeRoutingAdmissionReader,
          second.worktree,
          'second-change',
          '1.1',
        ),
      (error) => isWorkflowError(error, 'TASK_SESSION_RESOURCE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
