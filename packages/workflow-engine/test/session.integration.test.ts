import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCiPlanningCommit } from '../src/entrypoints/ci/ci-planning.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  commitSession,
  completeTask,
  finalizeTask,
  finishSession,
} from '../src/application/finalize/lifecycle.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { runRegisteredCheck } from '../src/adapters/consumer/repository/work-registry/registered-check.ts';
import {
  readImmutableReport,
  writeImmutableReport,
} from '../src/runtime/storage-journal/report-store.ts';
import {
  abortSession,
  checkSession,
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  addFixtureScripts,
  configureChecks,
  createFixtureRepository,
  git,
  installFakeOpenSpec,
  isWorkflowError,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';

if (import.meta.main) await import('./session-legacy-family.ts');

function prepareCurrentChange(repository: string, changeId = 'demo-change') {
  const ready = writeReadyV3ExemptChange(repository, changeId);
  commitPlanningTransition(repository, changeId);
  return ready;
}

function enableDisposableDatabasePolicy(repository: string): void {
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
}

function prepareCurrentChangeOnMain(
  repository: string,
  changeId = 'demo-change',
): void {
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  if (!fs.existsSync(maintainerPolicyPath)) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      maintainerPolicyPath,
    );
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Track fixture maintainer policy']);
  }
  const branch = `work/${changeId}`;
  git(repository, ['checkout', '-b', branch]);
  prepareCurrentChange(repository, changeId);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', branch]);
  git(repository, ['branch', '-d', branch]);
}

function prepareConcurrentTaskWorktree(
  repository: string,
  changeId: string,
  allowedPath: string,
  exclusiveResources: string[] = [],
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-concurrent-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    `work/${changeId}`,
    worktree,
    'main',
  ]);
  installFakeOpenSpec(worktree);
  const guardPath = path.join(
    worktree,
    'openspec/changes',
    changeId,
    'guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
    tasks: Record<
      string,
      { allowedPaths: string[]; exclusiveResources?: string[] }
    >;
  };
  guard.changeId = changeId;
  guard.tasks['1.1']!.allowedPaths = [allowedPath];
  if (exclusiveResources.length > 0) {
    guard.tasks['1.1']!.exclusiveResources = [...exclusiveResources].sort();
  }
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  prepareCurrentChange(worktree, changeId);
  return { parent, worktree };
}

function createTaskWorktreeFromPlannedBase(
  repository: string,
  changeId: string,
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-planned-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, ['worktree', 'add', '--quiet', worktree, `work/${changeId}`]);
  installFakeOpenSpec(worktree);
  return { parent, worktree };
}

function addConcurrentChangeSkeleton(
  repository: string,
  changeId: string,
): void {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.cpSync(
    path.join(repository, 'openspec/changes/demo-change'),
    changeDirectory,
    { recursive: true },
  );
  const guardPath = path.join(changeDirectory, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
  };
  guard.changeId = changeId;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  const providerBinding = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/change-providers/demo-change.json'),
      'utf8',
    ),
  ) as { changeId: string; planningRoot: string };
  providerBinding.changeId = changeId;
  providerBinding.planningRoot = `openspec/changes/${changeId}`;
  fs.writeFileSync(
    path.join(repository, 'workflow/change-providers', `${changeId}.json`),
    `${JSON.stringify(providerBinding, null, 2)}\n`,
  );
}

function declareConcurrentWorkset(
  repository: string,
  concurrentChangeId: string,
): void {
  prepareCurrentChangeOnMain(repository, 'demo-change');
  prepareCurrentChangeOnMain(repository, concurrentChangeId);
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    }),
  );
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'set-concurrent', changeId: concurrentChangeId },
    }),
  );
  renderHandoff(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare concurrent test workset']);
}

function removeConcurrentTaskWorktree(
  repository: string,
  fixture: { parent: string; worktree: string },
): void {
  git(repository, ['worktree', 'remove', '--force', fixture.worktree]);
  fs.rmSync(fixture.parent, { recursive: true, force: true });
}

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

test('current single-writer sessions use a neutral routing identity and reject the retired value', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    assert.equal(started.isolation?.routingRole, 'single');

    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      isolation: { routingRole: string };
    };
    stored.isolation.routingRole = 'legacy-single';
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);
    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current session reader rejects persisted records missing the isolation key', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const runtime = runtimeRoot(repository);
    const sessionPath = path.join(
      runtime,
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(stored, 'isolation'), true);
    const isolation = stored.isolation as {
      worktreeDigest: string;
      resources: Array<{ digest: string }>;
    };
    const lockPath = path.join(runtime, 'locks', 'demo-change.lock');
    const leasePaths = [
      path.join(
        runtime,
        'task-isolation',
        'worktrees',
        `${isolation.worktreeDigest.slice('sha256:'.length)}.lock`,
      ),
      ...isolation.resources.map(({ digest }) =>
        path.join(
          runtime,
          'task-isolation',
          'resources',
          `${digest.slice('sha256:'.length)}.lock`,
        ),
      ),
    ];
    const lockBytes = fs.readFileSync(lockPath);
    const leaseBytes = leasePaths.map((leasePath) =>
      fs.readFileSync(leasePath),
    );

    delete stored.isolation;
    const poisonedSessionBytes = `${JSON.stringify(stored, null, 2)}\n`;
    fs.writeFileSync(sessionPath, poisonedSessionBytes);

    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), poisonedSessionBytes);
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
    for (const [index, leasePath] of leasePaths.entries()) {
      assert.deepEqual(fs.readFileSync(leasePath), leaseBytes[index]);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current session reader rejects persisted records missing the planning assurance key', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(stored, 'planningAssurance'), true);
    stored.planningAssurance = null;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);
    assert.equal(
      getSession(repository, started.sessionId).planningAssurance,
      null,
    );
    delete stored.planningAssurance;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => getSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'INVALID_SESSION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked session schema exposes only the current WorkflowSession shape', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/schemas/session.schema.json'),
      'utf8',
    ),
  ) as {
    $id: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<
      string,
      { const?: unknown; enum?: unknown[]; $ref?: string }
    >;
    $defs: Record<string, unknown>;
  };

  assert.equal(
    schema.$id,
    'https://jigwright.local/workflow/session.schema.json',
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'sessionId',
    'state',
    'changeId',
    'taskId',
    'repositoryRoot',
    'gitCommonDirectory',
    'branch',
    'baseline',
    'artifacts',
    'allowedPaths',
    'requiredChecks',
    'isolation',
    'planningAssurance',
    'createdAt',
  ]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'abortReason',
    'abortedAt',
    'allowedPaths',
    'artifacts',
    'baseline',
    'branch',
    'changeId',
    'checkEvidenceEngineDigest',
    'commitHash',
    'commitReportId',
    'committedAt',
    'completionReportId',
    'createdAt',
    'documentationRemediation',
    'finishReportId',
    'gitCommonDirectory',
    'implementationReconciliationPaths',
    'implementationReconciliationReportId',
    'isolation',
    'latestCheckReportId',
    'mandateBinding',
    'planningAssurance',
    'repositoryRoot',
    'requiredCheckDigests',
    'requiredChecks',
    'revisionLeaseId',
    'schemaVersion',
    'sessionId',
    'state',
    'taskId',
  ]);
  assert.equal(schema.properties.schemaVersion?.const, 1);
  assert.deepEqual(schema.properties.state?.enum, [
    'active',
    'revising',
    'aborted',
    'committed',
  ]);
  assert.equal(
    schema.properties.isolation?.$ref,
    '#/$defs/taskSessionIsolationBinding',
  );
  assert.equal(
    schema.properties.planningAssurance?.$ref,
    '#/$defs/planningAssurance',
  );

  const mandateBinding = schema.$defs.taskMandateBinding as {
    additionalProperties: boolean;
    required: string[];
    properties: { schemaVersion: { const: number } };
  };
  assert.equal(mandateBinding.additionalProperties, false);
  assert.equal(mandateBinding.properties.schemaVersion.const, 1);
  assert.deepEqual(mandateBinding.required, [
    'schemaVersion',
    'mandateTaskId',
    'mandateId',
    'mandateDigest',
    'changeId',
    'externalAuditRoot',
  ]);

  const isolation = schema.$defs.taskSessionIsolationBinding as {
    additionalProperties: boolean;
    required: string[];
    properties: { schemaVersion: { const: number } };
  };
  assert.equal(isolation.additionalProperties, false);
  assert.equal(isolation.properties.schemaVersion.const, 1);
  assert.deepEqual(isolation.required, [
    'schemaVersion',
    'routingRole',
    'routingWorksetDigest',
    'concurrencyEnabled',
    'worktreeDigest',
    'resources',
  ]);
});

test('v3 sessions and every task report pin the exact planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const ready = prepareCurrentChange(repository);
    const expectedBinding = {
      ...ready.planningAssurance,
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    };

    const started = startSession(repository, 'demo-change', '1.1');
    assert.deepEqual(
      (started as typeof started & { planningAssurance: unknown })
        .planningAssurance,
      expectedBinding,
    );

    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    assert.throws(
      () => finalizeTask(repository, started.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, started.sessionId);
    finalizeTask(repository, started.sessionId);
    commitSession(repository, started.sessionId, 'Bind planning assurance');

    const committed = getSession(repository, started.sessionId);
    assert.deepEqual(
      fs.readdirSync(
        path.join(runtimeRoot(repository), 'task-isolation', 'worktrees'),
      ),
      [],
    );
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    for (const reportId of [
      committed.latestCheckReportId,
      committed.completionReportId,
      committed.finishReportId,
      committed.commitReportId,
    ]) {
      assert.match(reportId ?? '', /^[0-9a-f]{64}$/);
      const report = readImmutableReport(
        reportsRoot,
        started.sessionId,
        reportId!,
      );
      assert.deepEqual(report.planningAssurance, expectedBinding);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays v3 planning assurance from Git with the live validator', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const ready = prepareCurrentChange(repository);
    const planCommit = git(repository, ['rev-parse', 'HEAD']).trim();

    const validation = validateCiPlanningCommit(
      repository,
      planCommit,
      'demo-change',
    );

    // The CI loader reads only immutable Git objects, but must reach the exact
    // semantic result the live transition recorded.
    assert.equal(validation.schemaName, 'jigwright');
    assert.deepEqual(validation.planningAssurance, ready.planningAssurance);
    // An exempt plan consumes no collaboration grant, so its aggregate use set
    // is empty rather than absent.
    assert.deepEqual(validation.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI fails closed when a v3 plan omits tracked semantic evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);

    // The managed transition refuses to drop a required v3 artifact, so the
    // only way this tree reaches history is a hand-authored commit that never
    // passed the engine. CI must reject it from Git facts alone.
    git(repository, [
      'rm',
      '--quiet',
      'openspec/changes/demo-change/plan-review.json',
    ]);
    git(repository, [
      'commit',
      '--quiet',
      '-m',
      ['Plan demo-change', '', 'Change: demo-change', 'Transition: plan'].join(
        '\n',
      ),
    ]);
    const tampered = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, tampered, 'demo-change'),
      (error) => error instanceof WorkflowError,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('task transitions reject a session whose planning assurance is stale', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      planningAssurance: { planningGenerationId: string };
    };
    stored.planningAssurance.planningGenerationId = 'f'.repeat(64);
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, started.sessionId),
      (error) => isWorkflowError(error, 'SESSION_PLANNING_ASSURANCE_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion rejects a check report with mismatched planning assurance', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const checked = checkSession(repository, started.sessionId);
    const reportsRoot = path.join(runtimeRoot(repository), 'reports');
    const forged = structuredClone(
      readImmutableReport(reportsRoot, started.sessionId, checked.reportId),
    );
    (
      forged.planningAssurance as { planningGenerationId: string }
    ).planningGenerationId = 'f'.repeat(64);
    const forgedId = writeImmutableReport(reportsRoot, forged);
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      latestCheckReportId: string;
    };
    stored.latestCheckReportId = forgedId;
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => completeTask(repository, started.sessionId),
      (error) => isWorkflowError(error, 'CHECK_REPORT_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution returns pinned non-destructive evidence', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const result = runRegisteredCheck(repository, 'fixture', process.env);

    assert.equal(result.head, git(repository, ['rev-parse', 'HEAD']).trim());
    assert.deepEqual(
      {
        checkId: result.check.checkId,
        outcome: result.check.outcome,
        exitCode: result.check.exitCode,
        destructiveDatabase: result.check.destructiveDatabase,
      },
      {
        checkId: 'fixture',
        outcome: 'passed',
        exitCode: 0,
        destructiveDatabase: false,
      },
    );
    assert.match(result.check.runnerDigest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects unknown and destructive checks', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => runRegisteredCheck(repository, 'unknown', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_UNKNOWN'),
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

    assert.throws(
      () => runRegisteredCheck(repository, 'destructive', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_DESTRUCTIVE_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('registered check execution rejects dirty and mutated checkouts', () => {
  const dirtyRepository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(dirtyRepository, 'dirty.txt'), 'dirty\n');
    assert.throws(
      () => runRegisteredCheck(dirtyRepository, 'fixture', process.env),
      (error) => isWorkflowError(error, 'STANDALONE_CHECK_DIRTY_WORKTREE'),
    );
  } finally {
    fs.rmSync(dirtyRepository, { recursive: true, force: true });
  }

  const mutatingRepository = createFixtureRepository();
  try {
    configureChecks(
      mutatingRepository,
      {
        mutating: {
          command: [
            'node',
            'scripts/write-file.mjs',
            path.join(mutatingRepository, 'mutated.txt'),
          ],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    assert.throws(
      () => runRegisteredCheck(mutatingRepository, 'mutating', process.env),
      (error) => isWorkflowError(error, 'CI_CHECK_MUTATED_WORKTREE'),
    );
  } finally {
    fs.rmSync(mutatingRepository, { recursive: true, force: true });
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

    const firstSession = startSession(first.worktree, 'demo-change', '1.1');
    const secondSession = startSession(second.worktree, 'second-change', '1.1');

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
      () => startSession(third.worktree, 'third-change', '1.1'),
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
    const session = startSession(worktree, 'demo-change', '1.1');
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

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
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

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
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

    startSession(first.worktree, 'demo-change', '1.1', { environment });
    assert.throws(
      () =>
        startSession(second.worktree, 'second-change', '1.1', {
          environment,
        }),
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

    startSession(first.worktree, 'demo-change', '1.1');
    assert.throws(
      () => startSession(second.worktree, 'second-change', '1.1'),
      (error) => isWorkflowError(error, 'TASK_SESSION_RESOURCE_CONFLICT'),
    );
  } finally {
    for (const fixture of fixtures.reverse()) {
      removeConcurrentTaskWorktree(repository, fixture);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('update-base replays a finished non-final task branch and recomputes local PR assurance', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    const documentPolicyPath = path.join(
      repository,
      'workflow/document-policy.json',
    );
    const documentPolicy = JSON.parse(
      fs.readFileSync(documentPolicyPath, 'utf8'),
    ) as { documents: Record<string, unknown> };
    documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
      mode: 'generated',
      enforcement: 'active',
      transition: 'completion',
    };
    fs.writeFileSync(
      documentPolicyPath,
      `${JSON.stringify(documentPolicy, null, 2)}\n`,
    );
    renderHandoff(repository);
    git(repository, [
      'add',
      'workflow/document-policy.json',
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ]);
    git(repository, ['commit', '-m', 'Track fixture handoff']);
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<
        string,
        { allowedPaths: string[]; requiredChecks: string[] }
      >;
    };
    guard.tasks['1.1']!.allowedPaths = ['src/task/**'];
    guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']!);
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/tasks.md'),
      '\n- [ ] 1.2 Keep the fixture change open\n',
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--ff-only', 'work/demo-change']);
    fixture = createTaskWorktreeFromPlannedBase(repository, 'demo-change');
    const started = startSession(fixture.worktree, 'demo-change', '1.1');
    fs.mkdirSync(path.join(fixture.worktree, 'src/task'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.worktree, 'src/task/feature.ts'),
      'export const feature = true;\n',
    );
    finalizeTask(fixture.worktree, started.sessionId);
    const committed = commitSession(
      fixture.worktree,
      started.sessionId,
      'Complete concurrent fixture task',
    );

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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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
      assuranceCheckIds: string[];
    };
    assert.equal(receipt.sessionId, started.sessionId);
    assert.equal(receipt.oldHead, committed.commitHash);
    assert.equal(receipt.newHead, output.result.newHead);
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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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

test('update-base refuses an active writer before changing Git history', () => {
  const repository = createFixtureRepository();
  let fixture: { parent: string; worktree: string } | undefined;
  try {
    fixture = prepareConcurrentTaskWorktree(
      repository,
      'demo-change',
      'src/task/**',
    );
    const started = startSession(fixture.worktree, 'demo-change', '1.1');
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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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
    const started = startSession(taskWorktree, 'demo-change', '1.1');
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
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
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

test('check rejects workflow artifacts changed after session start', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    fs.appendFileSync(guardPath, '\n');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'ARTIFACTS_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check rejects a session whose task policy was broadened', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${session.sessionId}.json`,
    );
    const tampered = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    tampered.allowedPaths = ['outside.txt'];
    fs.writeFileSync(sessionPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_POLICY_TAMPERED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check executes required argv literally from the repository root', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-output-'),
  );
  const outputPath = path.join(outputDirectory, 'arguments.json');
  const sentinelPath = path.join(outputDirectory, 'shell-injection');
  const literalArgument = `; touch ${sentinelPath}`;

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        literal: {
          command: [
            'node',
            'scripts/capture-args.mjs',
            outputPath,
            literalArgument,
            '$(echo not-evaluated)',
          ],
          destructiveDatabase: false,
        },
      },
      ['literal'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId);
    const captured = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    assert.deepEqual(captured, {
      cwd: fs.realpathSync(repository),
      arguments: [literalArgument, '$(echo not-evaluated)'],
    });
    assert.equal(fs.existsSync(sentinelPath), false);
    assert.deepEqual(
      result.checks.map((check) => ({
        checkId: check.checkId,
        outcome: check.outcome,
        exitCode: check.exitCode,
      })),
      [{ checkId: 'literal', outcome: 'passed', exitCode: 0 }],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check fails on the first non-zero check and does not run later checks', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-check-failure-'),
  );
  const markerPath = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        failing: {
          command: ['node', 'scripts/fail.mjs'],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
      },
      ['failing', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_FAILED'), true);
        assert.deepEqual((error as WorkflowError).details, {
          checkId: 'failing',
          exitCode: 7,
          signal: null,
        });
        return true;
      },
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive database preflight runs before any required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-database-preflight-'),
  );
  const markerPath = path.join(outputDirectory, 'first-check-ran');

  try {
    addFixtureScripts(repository);
    enableDisposableDatabasePolicy(repository);
    configureChecks(
      repository,
      {
        first: {
          command: ['node', 'scripts/write-file.mjs', markerPath],
          destructiveDatabase: false,
        },
        destructive: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: true,
        },
      },
      ['first', 'destructive'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: { ...process.env },
        }),
      (error) =>
        isWorkflowError(error, 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED'),
    );
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('destructive check evidence includes only the redacted database identity', () => {
  const repository = createFixtureRepository();
  try {
    enableDisposableDatabasePolicy(repository);
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
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    const result = checkSession(repository, session.sessionId, {
      environment: {
        ...process.env,
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@127.0.0.1:5433/expense_test?ssl=false',
        DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/expense_dev',
      },
    });

    assert.equal(
      result.checks[0].databaseIdentity,
      'postgresql://127.0.0.1:5433/expense_test',
    );
    assert.equal(JSON.stringify(result).includes('marker-secret'), false);
    assert.equal(JSON.stringify(result).includes('ssl=false'), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check revalidates scope before running the next required check', () => {
  const repository = createFixtureRepository();
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-post-check-scope-'),
  );
  const outsidePath = path.join(repository, 'outside.txt');
  const laterMarker = path.join(outputDirectory, 'later-check-ran');

  try {
    addFixtureScripts(repository);
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/write-file.mjs', outsidePath],
          destructiveDatabase: false,
        },
        later: {
          command: ['node', 'scripts/write-file.mjs', laterMarker],
          destructiveDatabase: false,
        },
      },
      ['mutating', 'later'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'OUT_OF_SCOPE_PATHS'),
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('check rejects a lock removed by a passing required check', () => {
  const repository = createFixtureRepository();
  const lockPath = path.join(
    runtimeRoot(repository),
    'locks',
    'demo-change.lock',
  );

  try {
    configureChecks(
      repository,
      {
        mutating: {
          command: ['node', 'scripts/remove-file.mjs', lockPath],
          destructiveDatabase: false,
        },
      },
      ['mutating'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () => checkSession(repository, session.sessionId),
      (error) => isWorkflowError(error, 'SESSION_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check converts spawn errors without leaking environment values', () => {
  const repository = createFixtureRepository();
  try {
    configureChecks(
      repository,
      {
        overflowing: {
          command: ['node', 'scripts/overflow.mjs'],
          destructiveDatabase: false,
        },
      },
      ['overflowing'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(repository, 'demo-change', '1.1');

    assert.throws(
      () =>
        checkSession(repository, session.sessionId, {
          environment: {
            ...process.env,
            WORKFLOW_TEST_SECRET: 'marker-secret',
          },
        }),
      (error) => {
        assert.equal(isWorkflowError(error, 'CHECK_EXECUTION_FAILED'), true);
        assert.equal((error as Error).message.includes('marker-secret'), false);
        assert.equal(JSON.stringify(error).includes('marker-secret'), false);
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('change validation rejects inherited object properties as check IDs', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    configureChecks(
      repository,
      {
        fixture: {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        },
      },
      ['constructor'],
    );

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'UNKNOWN_REQUIRED_CHECK'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test(
  'node runner ignores caller-controlled PATH substitutes',
  { skip: process.platform === 'win32' },
  () => {
    const repository = createFixtureRepository();
    const fakeBin = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-bin-'),
    );
    const markerPath = path.join(fakeBin, 'fake-node-ran');
    const fakeNodePath = path.join(fakeBin, 'node');

    try {
      fs.writeFileSync(
        fakeNodePath,
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(markerPath)}\nexit 0\n`,
      );
      fs.chmodSync(fakeNodePath, 0o755);
      git(repository, ['checkout', '-b', 'work/demo-change']);
      prepareCurrentChange(repository);
      const session = startSession(repository, 'demo-change', '1.1');

      const result = checkSession(repository, session.sessionId, {
        environment: { ...process.env, PATH: fakeBin },
      });

      assert.equal(result.passed, true);
      assert.equal(fs.existsSync(markerPath), false);
      assert.equal(result.checks[0].runner, 'node');
      assert.match(result.checks[0].runnerDigest, /^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  },
);

test('change validation rejects bare executable check runners', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    configureChecks(
      repository,
      {
        unsafe: {
          command: ['pnpm', '--version'],
          destructiveDatabase: false,
        },
      },
      ['unsafe'],
    );

    assert.throws(
      () => startSession(repository, 'demo-change', '1.1'),
      (error) => isWorkflowError(error, 'INVALID_CHECK_DEFINITION'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
