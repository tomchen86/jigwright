import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  isWorkflowError,
  prepareCurrentV3IntroductionFixture,
} from './fixture.ts';
import {
  startSession,
  getSession,
} from '../src/application/execute-task/session.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import assert from 'node:assert/strict';
import { reviseTask } from '../src/application/revise/task-revision.ts';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { commitSession } from '../src/application/finalize/lifecycle.ts';
import {
  finalizeTask,
  completeTask,
} from './support/local-engine-selection-host.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import {
  readImmutableReport,
  writeImmutableReport,
} from '../src/runtime/storage-journal/report-store.ts';
import { validateCiPlanningCommit } from '../src/composition-root/ci-replay-production.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { prepareCurrentChange } from './support/session-lifecycle-fixture.ts';

test('doctor counts a durable revising session as a write-capable session without mutation', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    assert.throws(
      () =>
        reviseTask(
          productionChangeContract,
          repository,
          started.sessionId,
          'Inspect current planning.',
          {
            testCrashAfter: 'session-revising',
          },
        ),
      /simulated task revision crash after session-revising/u,
    );
    assert.equal(getSession(repository, started.sessionId).state, 'revising');
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const before = {
      head: git(repository, ['rev-parse', 'HEAD']),
      status: git(repository, ['status', '--porcelain=v1', '-z']),
      sessionBytes: fs.readFileSync(sessionPath, 'utf8'),
    };

    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'doctor',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      (JSON.parse(run.stdout) as { activeSessionCount: number })
        .activeSessionCount,
      1,
    );
    assert.deepEqual(
      {
        head: git(repository, ['rev-parse', 'HEAD']),
        status: git(repository, ['status', '--porcelain=v1', '-z']),
        sessionBytes: fs.readFileSync(sessionPath, 'utf8'),
      },
      before,
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
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
    'requiredCheckDigests',
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
  const planningAssurance = schema.$defs.planningAssurance as {
    anyOf: Array<{
      properties?: { reviewRoleResultForm: { enum: string[] } };
    }>;
  };
  assert.deepEqual(
    planningAssurance.anyOf[1]?.properties?.reviewRoleResultForm.enum,
    [
      'ordinary-provider',
      'granted-same-provider',
      'granted-role-context-sharing',
      'granted-caller-supplied',
      'direct-human-attestation',
    ],
  );
});

test('current session reader rejects persisted records missing required check digests', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
    assert.equal(Object.hasOwn(stored, 'requiredCheckDigests'), true);
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

    delete stored.requiredCheckDigests;
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

    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
    commitSession(
      productionChangeContract,
      repository,
      started.sessionId,
      'Bind planning assurance',
    );

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

test('current session reader preserves R-007 assurance without fabricated standard Grant refs', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const sessionPath = path.join(
      runtimeRoot(repository),
      'sessions',
      `${started.sessionId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
      planningAssurance: Record<string, unknown>;
    };
    stored.planningAssurance = {
      ...stored.planningAssurance,
      reviewRoleResultForm: 'granted-role-context-sharing',
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'session-independent',
      degradationAuthorized: true,
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    };
    fs.writeFileSync(sessionPath, `${JSON.stringify(stored, null, 2)}\n`);

    assert.deepEqual(
      getSession(repository, started.sessionId).planningAssurance,
      stored.planningAssurance,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays v3 planning assurance from Git with the live validator', () => {
  const repository = createFixtureRepository();
  try {
    prepareCurrentV3IntroductionFixture(repository, 'demo-change');
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
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
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
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          started.sessionId,
        ),
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
    const started = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
    const checked = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      started.sessionId,
    );
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
