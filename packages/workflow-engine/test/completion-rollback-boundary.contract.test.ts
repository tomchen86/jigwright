import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { createFinalizationService } from '../src/application/finalize/lifecycle.ts';
import { createProductionFinalizationService } from '../src/composition-root/finalization-production.ts';
import { loadActiveSessionContext } from '../src/composition-root/lifecycle-context.ts';
import {
  assertCompletionRollbackDocumentPaths,
  assertCompletionRollbackReport,
  assertCompletionRollbackRepository,
  assertCompletionRollbackSession,
  normalizeCompletionRollbackReason,
  resetCompletionRollbackSession,
  type RollbackCompletionResult,
} from '../src/modules/lifecycle/completion-rollback.ts';
import type { WorkflowReport } from '../src/modules/lifecycle/workflow-report.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import { classifyProjectionPaths } from '../src/modules/projection/engine-projection-registry.ts';
import type { ManagedDocumentOperations } from '../src/modules/projection/managed-documents.ts';
import { rollbackCompletionProjection } from '../src/runtime/managed-documents/transaction/completion-rollback.ts';
import {
  digestTaskContent,
  projectTasksCompleted,
} from '../src/runtime/managed-documents/transaction/task-projection.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  runtimePaths,
  withSessionOperation,
  writeJsonAtomic,
} from '../src/runtime/session-workspace/session-store.ts';
import { writeImmutableReport } from '../src/runtime/storage-journal/report-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Context = Parameters<typeof rollbackCompletionProjection>[0];
type Contract = [
  Assert<Equal<WorkflowReport, Parameters<typeof writeImmutableReport>[1]>>,
  Assert<
    Equal<
      ReturnType<typeof rollbackCompletionProjection>,
      RollbackCompletionResult
    >
  >,
  Assert<Equal<RollbackCompletionResult['session'], WorkflowSession>>,
  Assert<
    Equal<
      'rollbackCompletion' extends keyof ReturnType<
        typeof createFinalizationService
      >
        ? true
        : false,
      false
    >
  >,
];
function validatorIsRequired(
  context: Context,
  documents: Pick<ManagedDocumentOperations, 'validateManagedDocuments'>,
): Contract | undefined {
  // @ts-expect-error The physical transaction has no default document validator.
  rollbackCompletionProjection(context, 'reason');
  // @ts-expect-error A validator capability must contain the real required method.
  rollbackCompletionProjection(context, 'reason', {});
  // @ts-expect-error Full context includes config, even for the physical transaction.
  const narrow: Context = {
    git: context.git,
    runtime: context.runtime,
    session: context.session,
  };
  // @ts-expect-error The canonical method property remains readonly.
  documents.validateManagedDocuments = () => [];
  void narrow;
  return undefined;
}
void validatorIsRequired;

function createRollbackFixture(documentExisted = true) {
  const repository = fs.realpathSync(createFixtureRepository());
  const documentPath = 'docs/CURRENT_AND_NEXT_STEPS.md';
  const tasksRelative = 'openspec/changes/demo-change/tasks.md';
  const tasksPath = path.join(repository, tasksRelative);
  const documentAbsolute = path.join(repository, documentPath);
  const policyPath = path.join(repository, 'workflow/document-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.documents[documentPath] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.mkdirSync(path.dirname(documentAbsolute), { recursive: true });
  if (documentExisted)
    fs.writeFileSync(documentAbsolute, 'baseline document\n');
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  git(repository, [
    'add',
    'workflow/document-policy.json',
    ...(documentExisted ? [documentPath] : []),
  ]);
  git(repository, ['commit', '-m', 'Configure rollback fixture']);
  const observed = discoverRepository(repository);
  assert.ok(observed.branch);
  const runtime = runtimePaths(observed.gitCommonDirectory, 'workflow-engine');
  const session: WorkflowSession = {
    schemaVersion: 1,
    sessionId: 'session-rollback-boundary',
    state: 'active',
    changeId: 'demo-change',
    taskId: '1.1',
    repositoryRoot: observed.repositoryRealPath,
    gitCommonDirectory: observed.gitCommonDirectory,
    branch: observed.branch,
    baseline: { head: observed.head, tree: observed.tree },
    artifacts: { tasks: tasksRelative },
    allowedPaths: ['src/**'],
    requiredChecks: ['fixture'],
    requiredCheckDigests: { fixture: 'a'.repeat(64) },
    latestCheckReportId: 'b'.repeat(64),
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      concurrencyEnabled: false,
      routingWorksetDigest: `sha256:${'d'.repeat(64)}`,
      worktreeDigest: `sha256:${'e'.repeat(64)}`,
      resources: [],
    },
    planningAssurance: null,
    mandateBinding: null,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
  const tasks = projectTasksCompleted(tasksPath, ['1.1']);
  fs.writeFileSync(documentAbsolute, 'projected document\n');
  const transitionPaths = [documentPath];
  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'completion',
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    createdAt: session.createdAt,
    parentReportId: session.latestCheckReportId,
    planningAssurance: null,
    ...classifyProjectionPaths(
      [documentPath, tasksRelative].sort(),
      [tasksRelative],
      transitionPaths,
    ),
    completedTaskIds: ['1.1'],
    transitionPaths,
    projectionSourceDigest: digestTaskContent(tasks.before),
  };
  session.completionReportId = writeImmutableReport(runtime.reports, report);
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  writeJsonAtomic(sessionPath, session);
  fs.mkdirSync(runtime.locks, { recursive: true });
  fs.writeFileSync(
    path.join(runtime.locks, `${session.changeId}.lock`),
    `${JSON.stringify({ sessionId: session.sessionId, changeId: session.changeId, taskId: session.taskId, ownerToken: crypto.randomUUID(), pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  const context = loadActiveSessionContext(repository, session.sessionId);
  return {
    repository,
    context,
    report,
    tasksPath,
    tasks,
    documentPath,
    documentAbsolute,
    sessionPath,
    recordDirectory: path.join(
      runtime.root,
      'completion-rollbacks',
      session.sessionId,
    ),
    run(
      documents: Pick<ManagedDocumentOperations, 'validateManagedDocuments'>,
    ) {
      return withSessionOperation(runtime, session.sessionId, () =>
        rollbackCompletionProjection(
          context,
          'Investigate projected evidence.',
          documents,
        ),
      );
    },
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function unchangedProjection(
  fixture: ReturnType<typeof createRollbackFixture>,
) {
  assert.equal(fs.readFileSync(fixture.tasksPath, 'utf8'), fixture.tasks.after);
  assert.equal(
    fs.readFileSync(fixture.documentAbsolute, 'utf8'),
    'projected document\n',
  );
}

test('rollback policy preserves original reason and full session, repository and report admission', () => {
  const fixture = createRollbackFixture();
  try {
    const { context, report } = fixture;
    assert.equal(normalizeCompletionRollbackReason(' \n reason \n '), 'reason');
    assert.throws(
      () => normalizeCompletionRollbackReason(' \n '),
      (error) => isWorkflowError(error, 'ROLLBACK_REASON_REQUIRED'),
    );
    assert.throws(
      () => normalizeCompletionRollbackReason('reason\ninside'),
      (error) => isWorkflowError(error, 'ROLLBACK_REASON_INVALID'),
    );
    assert.doesNotThrow(() => assertCompletionRollbackSession(context.session));
    for (const patch of [
      { completionReportId: undefined },
      { finishReportId: 'a'.repeat(64) },
      { commitReportId: 'a'.repeat(64) },
    ]) {
      assert.throws(
        () => assertCompletionRollbackSession({ ...context.session, ...patch }),
        (error) =>
          isWorkflowError(error, 'ROLLBACK_REQUIRES_PROJECTED_SESSION'),
      );
    }
    assert.doesNotThrow(() =>
      assertCompletionRollbackRepository(context.git, context.session),
    );
    for (const key of [
      'repositoryRealPath',
      'gitCommonDirectory',
      'branch',
      'head',
    ] as const) {
      assert.throws(
        () =>
          assertCompletionRollbackRepository(
            { ...context.git, [key]: 'foreign' },
            context.session,
          ),
        (error) => isWorkflowError(error, 'ROLLBACK_REPOSITORY_DRIFT'),
      );
    }
    assert.doesNotThrow(() =>
      assertCompletionRollbackReport(report, context.session),
    );
    for (const patch of [
      { kind: 'check' as const },
      { changeId: 'foreign' },
      { taskId: 'foreign' },
      { parentReportId: 'a'.repeat(64) },
    ]) {
      assert.throws(
        () =>
          assertCompletionRollbackReport(
            { ...report, ...patch },
            context.session,
          ),
        (error) => isWorkflowError(error, 'COMPLETION_REPORT_STALE'),
      );
    }
    const unread = new Error('later report property must not be read');
    assert.throws(
      () =>
        assertCompletionRollbackReport(
          {
            ...report,
            kind: 'check',
            get changeId(): string {
              throw unread;
            },
          },
          context.session,
        ),
      (error) => isWorkflowError(error, 'COMPLETION_REPORT_STALE'),
    );
    assert.doesNotThrow(() =>
      assertCompletionRollbackDocumentPaths(
        [fixture.documentPath],
        [fixture.documentPath],
      ),
    );
    assert.throws(
      () =>
        assertCompletionRollbackDocumentPaths(
          ['foreign'],
          [fixture.documentPath],
        ),
      (error) => isWorkflowError(error, 'COMPLETION_REPORT_STALE'),
    );
  } finally {
    fixture.dispose();
  }
});

test('rollback reset removes only the two evidence pointers and preserves complete nested references', () => {
  const fixture = createRollbackFixture();
  try {
    const session = fixture.context.session;
    const beforeKeys = Object.keys(session);
    const reset = resetCompletionRollbackSession(session);
    assert.deepEqual(
      Object.keys(reset),
      beforeKeys.filter(
        (key) => !['latestCheckReportId', 'completionReportId'].includes(key),
      ),
    );
    assert.equal(reset.latestCheckReportId, undefined);
    assert.equal(reset.completionReportId, undefined);
    assert.equal(reset.baseline, session.baseline);
    assert.equal(reset.isolation, session.isolation);
    assert.equal(reset.artifacts, session.artifacts);
    assert.equal(reset.allowedPaths, session.allowedPaths);
    assert.equal(reset.mandateBinding, null);
    assert.equal(Object.isFrozen(reset), false);
    assert.ok(session.latestCheckReportId);
    assert.ok(session.completionReportId);
  } finally {
    fixture.dispose();
  }
});

test('production composes the original frozen operation shape with fresh rollback identity per construction', () => {
  const first = createProductionFinalizationService();
  const second = createProductionFinalizationService();
  const keys = [
    'rollbackCompletion',
    'recoverFinalize',
    'finalizeSession',
    'finalizeProtectedTaskApplyUnderGrant',
    'finalizeTask',
    'completeTask',
    'finishSession',
  ] as const;
  assert.deepEqual(Object.keys(first), keys);
  assert.deepEqual(Object.keys(second), keys);
  assert.equal(Object.isFrozen(first), true);
  for (const key of keys) assert.notEqual(first[key], second[key]);
});

test('physical rollback requires the original late document receiver and retains its refusal before mutations', () => {
  const fixture = createRollbackFixture();
  try {
    const failure = new Error('document validation refused');
    let lookups = 0;
    const documents = {
      get validateManagedDocuments() {
        lookups += 1;
        return function (this: unknown, repository: string): string[] {
          assert.equal(this, documents);
          assert.equal(repository, fixture.repository);
          assert.equal(
            fs.existsSync(
              path.join(
                fixture.context.runtime.operations,
                `${fixture.context.session.sessionId}.lock`,
              ),
            ),
            true,
          );
          unchangedProjection(fixture);
          throw failure;
        };
      },
    };
    assert.equal(lookups, 0);
    assert.throws(
      () => fixture.run(documents),
      (error) => error === failure,
    );
    assert.equal(lookups, 1);
    unchangedProjection(fixture);
    assert.equal(fs.existsSync(fixture.recordDirectory), false);
  } finally {
    fixture.dispose();
  }
});

test('physical rollback preserves journal bytes and publishes the reset only after restored projections', () => {
  const fixture = createRollbackFixture();
  try {
    const result = fixture.run({ validateManagedDocuments: () => [] });
    assert.equal(
      fs.readFileSync(fixture.tasksPath, 'utf8'),
      fixture.tasks.before,
    );
    assert.equal(
      fs.readFileSync(fixture.documentAbsolute, 'utf8'),
      'baseline document\n',
    );
    assert.deepEqual(Object.keys(result), [
      'session',
      'completionReportId',
      'rollbackRecordId',
      'restoredPaths',
      'rolledBackAt',
      'reason',
    ]);
    const bytes = fs.readFileSync(
      path.join(fixture.recordDirectory, `${result.rollbackRecordId}.json`),
    );
    assert.equal(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      result.rollbackRecordId,
    );
    const expectedRecord = {
      schemaVersion: 1,
      kind: 'completion-rollback',
      sessionId: fixture.context.session.sessionId,
      changeId: fixture.context.session.changeId,
      taskId: fixture.context.session.taskId,
      completionReportId: fixture.context.session.completionReportId,
      rolledBackAt: result.rolledBackAt,
      reason: 'Investigate projected evidence.',
      restoredPaths: [
        fixture.documentPath,
        'openspec/changes/demo-change/tasks.md',
      ],
    };
    assert.equal(
      bytes.toString(),
      `${JSON.stringify(expectedRecord, null, 2)}\n`,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(fixture.sessionPath, 'utf8')),
      result.session,
    );
    assert.equal(result.session.latestCheckReportId, undefined);
    assert.equal(result.session.completionReportId, undefined);
  } finally {
    fixture.dispose();
  }
});

test('session publication failure removes its journal and restores tasks before projected documents', (t) => {
  const fixture = createRollbackFixture();
  try {
    const failure = new Error('session publication failed');
    const rename = fs.renameSync;
    const write = fs.writeFileSync;
    const restored: string[] = [];
    let publicationFailed = false;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === fixture.sessionPath) {
        assert.equal(fs.readdirSync(fixture.recordDirectory).length, 1);
        assert.equal(
          fs.readFileSync(fixture.tasksPath, 'utf8'),
          fixture.tasks.before,
        );
        assert.equal(
          fs.readFileSync(fixture.documentAbsolute, 'utf8'),
          'baseline document\n',
        );
        publicationFailed = true;
        throw failure;
      }
      return rename(from, to);
    });
    t.mock.method(
      fs,
      'writeFileSync',
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (
          publicationFailed &&
          typeof args[0] === 'string' &&
          [fixture.tasksPath, fixture.documentAbsolute].includes(args[0])
        )
          restored.push(args[0]);
        return write(...args);
      },
    );
    assert.throws(
      () => fixture.run({ validateManagedDocuments: () => [] }),
      (error) => error === failure,
    );
    assert.equal(publicationFailed, true);
    assert.deepEqual(restored, [fixture.tasksPath, fixture.documentAbsolute]);
    assert.deepEqual(fs.readdirSync(fixture.recordDirectory), []);
    unchangedProjection(fixture);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(fixture.sessionPath, 'utf8')),
      fixture.context.session,
    );
  } finally {
    t.mock.restoreAll();
    fixture.dispose();
  }
});

test('a fresh session reread refuses drift and missing-document compensation retains its original masking error', () => {
  for (const documentExisted of [true, false]) {
    const fixture = createRollbackFixture(documentExisted);
    try {
      const changedSession = {
        ...fixture.context.session,
        allowedPaths: ['src/**', 'other/**'],
      };
      const documents = {
        validateManagedDocuments() {
          writeJsonAtomic(fixture.sessionPath, changedSession);
          return [];
        },
      };
      assert.throws(
        () => fixture.run(documents),
        (error) =>
          isWorkflowError(
            error,
            documentExisted
              ? 'SESSION_CHANGED_DURING_TRANSITION'
              : 'ROLLBACK_PATH_UNSAFE',
          ),
      );
      assert.equal(
        fs.readFileSync(fixture.tasksPath, 'utf8'),
        fixture.tasks.after,
      );
      assert.equal(fs.existsSync(fixture.documentAbsolute), documentExisted);
      if (documentExisted)
        assert.equal(
          fs.readFileSync(fixture.documentAbsolute, 'utf8'),
          'projected document\n',
        );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(fixture.sessionPath, 'utf8')),
        changedSession,
      );
      assert.equal(fs.existsSync(fixture.recordDirectory), false);
    } finally {
      fixture.dispose();
    }
  }
});

test('rollback policy and physical transaction reject backedges and the application factory does not reacquire the moved use case', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const prefix = 'packages/workflow-engine/src/';
  const resolver = readRepositoryDependencies(root);
  for (const file of [
    'modules/lifecycle/completion-rollback.ts',
    'modules/lifecycle/workflow-report.ts',
  ]) {
    const check = (extra = '') =>
      assert.deepEqual(
        resolver.read(path.join(root, prefix, file), extra).problems,
        [],
      );
    check();
    for (const declaration of [
      "import { discoverRepository } from '../../runtime/repository-transaction/git.ts';",
      "import type { discoverRepository } from '../../runtime/repository-transaction/git.ts';",
    ])
      assert.throws(() => check('\n' + declaration), assert.AssertionError);
  }
  const transaction =
    prefix + 'runtime/managed-documents/transaction/completion-rollback.ts';
  const checkTransaction = (extra = '') =>
    assert.deepEqual(
      resolver.read(path.join(root, transaction), extra).problems,
      [],
    );
  checkTransaction();
  for (const declaration of [
    "import { createProductionFinalizationService } from '../../../composition-root/finalization-production.ts';",
    "import type { createProductionFinalizationService } from '../../../composition-root/finalization-production.ts';",
  ])
    assert.throws(
      () => checkTransaction('\n' + declaration),
      assert.AssertionError,
    );
  const checkApplication = (extra = '') =>
    assert.equal(
      resolver
        .read(
          path.join(root, prefix, 'application/finalize/lifecycle.ts'),
          extra,
        )
        .edges.some((edge) => edge.to === transaction),
      false,
    );
  checkApplication();
  for (const declaration of [
    "import { rollbackCompletionProjection } from '../../runtime/managed-documents/transaction/completion-rollback.ts';",
    "import type { rollbackCompletionProjection } from '../../runtime/managed-documents/transaction/completion-rollback.ts';",
  ])
    assert.throws(
      () => checkApplication('\n' + declaration),
      assert.AssertionError,
    );
});
