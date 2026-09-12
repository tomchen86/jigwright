import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { READ_ONLY_PROBE_KINDS_V1 } from '@jigwright/core/read-only-probe';
import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from '../src/composition-root/lifecycle-context.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import { executeProviderReadOnlyProbe } from '../src/runtime/provider-execution/provider-probe-executor.ts';
import { observeInvestigationRuntimeContext } from '../src/runtime/repository-observation/investigation-runtime-context.ts';
import { readWorkflowSessionContext } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { resumePendingCommit } from '../src/runtime/repository-transaction/commit-recovery.ts';
import { managedCommitMessage } from '../src/runtime/repository-transaction/git-transitions.ts';
import {
  acquireTaskSessionIsolationLeases,
  closeTaskSessionIsolationLeaseAcquisition,
  writeJsonAtomic,
} from '../src/runtime/session-workspace/session-store.ts';
import { isWorkflowSession } from '../src/runtime/session-workspace/workflow-session-records.ts';
import { writeImmutableReport } from '../src/runtime/storage-journal/report-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type RawContext = ReturnType<typeof readWorkflowSessionContext>;
type ContextContract = [
  Assert<Equal<RawContext, ReturnType<typeof loadActiveSessionContext>>>,
  Assert<Equal<RawContext['session'], WorkflowSession>>,
  Assert<Equal<RawContext, Parameters<typeof resumePendingCommit>[0]>>,
  Assert<
    Equal<
      ReturnType<typeof observeInvestigationRuntimeContext>,
      Omit<
        ReturnType<typeof loadInvestigationRuntimeContext>,
        'planningProviderAuthoring' | 'planningProviderReviewedAssetMirrors'
      >
    >
  >,
];
function completeContextRemainsRequired(
  context: RawContext,
): ContextContract | undefined {
  context.git = context.git;
  context.config = context.config;
  context.runtime = context.runtime;
  context.session = context.session;
  context.session.mandateBinding = undefined;
  // @ts-expect-error The original nested runtime layout remains readonly.
  context.runtime.root = 'other';
  // @ts-expect-error Recovery retains config even though it does not read that field.
  const withoutConfig: RawContext = {
    git: context.git,
    runtime: context.runtime,
    session: context.session,
  };
  const narrowRuntime: RawContext = {
    ...context,
    // @ts-expect-error Downstream release needs the complete runtime layout.
    runtime: { root: 'root', sessions: 'sessions', reports: 'reports' },
  };
  const narrowSession: RawContext = {
    ...context,
    // @ts-expect-error Recovery retains every durable session field.
    session: {
      sessionId: 'session-a',
      changeId: 'change',
      taskId: '1.1',
      baseline: context.session.baseline,
    },
  };
  void [withoutConfig, narrowRuntime, narrowSession];
  return undefined;
}
void completeContextRemainsRequired;

function storedSession(repository: string): WorkflowSession {
  const { git: state } = observeInvestigationRuntimeContext(repository);
  assert.ok(state.branch);
  return {
    schemaVersion: 1,
    sessionId: 'session-context',
    state: 'active',
    changeId: 'demo-change',
    taskId: '1.1',
    repositoryRoot: state.repositoryRoot,
    gitCommonDirectory: state.gitCommonDirectory,
    branch: state.branch,
    baseline: {
      head: state.head,
      tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    },
    artifacts: { tasks: 'openspec/changes/demo-change/tasks.md' },
    allowedPaths: ['src/**'],
    requiredChecks: ['fixture'],
    requiredCheckDigests: { fixture: 'a'.repeat(64) },
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      routingWorksetDigest: `sha256:${'b'.repeat(64)}`,
      concurrencyEnabled: false,
      worktreeDigest: `sha256:${'c'.repeat(64)}`,
      resources: [],
    },
    planningAssurance: null,
    mandateBinding: null,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
}

function persistSession(repository: string, session: WorkflowSession) {
  assert.equal(isWorkflowSession(session), true);
  const runtime =
    observeInvestigationRuntimeContext(repository).lifecycleRuntime;
  writeJsonAtomic(
    path.join(runtime.sessions, `${session.sessionId}.json`),
    session,
  );
  return runtime;
}

test('runtime observation retains both layouts while composed providers remain lazy and capture the original Git object', () => {
  const repository = createFixtureRepository();
  try {
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumerBytes = fs.readFileSync(consumerPath);
    fs.rmSync(consumerPath);
    const observation = observeInvestigationRuntimeContext(repository);
    const composed = loadInvestigationRuntimeContext(repository);
    const {
      planningProviderAuthoring,
      planningProviderReviewedAssetMirrors,
      ...facts
    } = composed;
    assert.deepEqual(Object.keys(observation), [
      'git',
      'config',
      'runtime',
      'lifecycleRuntime',
    ]);
    assert.deepEqual(facts, observation);
    assert.deepEqual(Object.keys(composed), [
      ...Object.keys(observation),
      'planningProviderAuthoring',
      'planningProviderReviewedAssetMirrors',
    ]);
    assert.throws(planningProviderAuthoring, (error) =>
      isWorkflowError(error, 'REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
    assert.throws(planningProviderReviewedAssetMirrors, (error) =>
      isWorkflowError(error, 'REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
    fs.writeFileSync(consumerPath, consumerBytes);
    fs.mkdirSync(path.join(repository, 'missing'));
    const capturedGit = composed.git;
    composed.git = {
      ...capturedGit,
      repositoryRoot: path.join(repository, 'missing'),
    };
    assert.equal(planningProviderAuthoring().providerId, 'openspec');
    assert.ok(planningProviderReviewedAssetMirrors().length > 0);
    capturedGit.repositoryRoot = path.join(repository, 'missing');
    assert.throws(planningProviderAuthoring, (error) =>
      isWorkflowError(error, 'REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
    assert.throws(planningProviderReviewedAssetMirrors, (error) =>
      isWorkflowError(error, 'REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('raw session observation retains full stored states and composition alone requires active state', () => {
  const repository = createFixtureRepository();
  try {
    const active = storedSession(repository);
    for (const session of [
      active,
      {
        ...active,
        state: 'revising' as const,
        revisionLeaseId: 'revision-00000000-0000-4000-8000-000000000000',
      },
      {
        ...active,
        state: 'aborted' as const,
        abortedAt: active.createdAt,
        abortReason: 'Stopped.',
      },
      {
        ...active,
        state: 'committed' as const,
        committedAt: active.createdAt,
        latestCheckReportId: 'd'.repeat(64),
        completionReportId: 'e'.repeat(64),
        finishReportId: 'f'.repeat(64),
        commitReportId: '1'.repeat(64),
        commitHash: active.baseline.head,
      },
    ]) {
      persistSession(repository, session);
      const context = readWorkflowSessionContext(repository, session.sessionId);
      assert.deepEqual(Object.keys(context), [
        'git',
        'config',
        'runtime',
        'session',
      ]);
      assert.deepEqual(context.session, session);
      if (session.state === 'active') {
        assert.deepEqual(
          loadActiveSessionContext(repository, session.sessionId),
          context,
        );
      } else {
        assert.throws(
          () => loadActiveSessionContext(repository, session.sessionId),
          (error) => {
            assert.ok(error instanceof WorkflowError);
            assert.equal(error.code, 'SESSION_NOT_ACTIVE');
            assert.equal(
              error.message,
              `Session ${session.sessionId} is ${session.state}.`,
            );
            assert.equal(error.exitCode, ExitCode.staleState);
            return true;
          },
        );
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('configuration, identifier and stored-record failures retain their precedence before active admission', () => {
  const repository = createFixtureRepository();
  try {
    const session = storedSession(repository);
    const runtime = persistSession(repository, session);
    const configPath = path.join(repository, 'workflow/config.json');
    const configBytes = fs.readFileSync(configPath);
    fs.writeFileSync(configPath, '{');
    for (const load of [readWorkflowSessionContext, loadActiveSessionContext]) {
      assert.throws(
        () => load(repository, '../invalid'),
        (error) => isWorkflowError(error, 'UNREADABLE_CONTRACT'),
      );
    }
    fs.writeFileSync(configPath, configBytes);
    for (const load of [readWorkflowSessionContext, loadActiveSessionContext]) {
      assert.throws(
        () => load(repository, '../invalid'),
        (error) => isWorkflowError(error, 'INVALID_SESSION_ID'),
      );
      assert.throws(
        () => load(repository, 'session-absent'),
        (error) => isWorkflowError(error, 'SESSION_UNREADABLE'),
      );
    }
    const sessionPath = path.join(
      runtime.sessions,
      `${session.sessionId}.json`,
    );
    for (const [record, code] of [
      [{ ...session, state: 'unknown' }, 'INVALID_SESSION'],
      [{ ...session, sessionId: 'session-other' }, 'SESSION_ID_MISMATCH'],
    ] as const) {
      writeJsonAtomic(sessionPath, record);
      for (const load of [
        readWorkflowSessionContext,
        loadActiveSessionContext,
      ]) {
        assert.throws(
          () => load(repository, session.sessionId),
          (error) => isWorkflowError(error, code),
        );
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('all production probe kinds observe repository configuration before their branch', () => {
  const repository = createFixtureRepository();
  try {
    fs.writeFileSync(path.join(repository, 'workflow/config.json'), '{');
    for (const kind of READ_ONLY_PROBE_KINDS_V1) {
      const requiresTarget = [
        'binary-exists',
        'file-read',
        'validator-error',
        'dependency-availability',
      ].includes(kind);
      const result = executeProviderReadOnlyProbe(
        repository,
        {
          kind,
          ...(requiresTarget
            ? {
                target: kind === 'validator-error' ? 'VALIDATOR_ERROR' : 'node',
              }
            : {}),
          timeoutMs: 30_000,
        },
        {
          executionJobId: 'unread-job',
          failedAttemptId: 'unread-attempt',
          failedInvocationId: 'unread-invocation',
          failureCode: 'unread-code',
        },
      );
      assert.equal(result.state, 'failed', kind);
      assert.equal(result.code, 'UNREADABLE_CONTRACT', kind);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('pending commit recovery consumes the full observed session before and after the recorded ref update', () => {
  for (const refUpdated of [false, true]) {
    const repository = createFixtureRepository();
    try {
      const session = storedSession(repository);
      const runtime = persistSession(repository, session);
      const subject = 'Recover context fixture';
      const message = managedCommitMessage(
        subject,
        session.changeId,
        session.taskId,
      );
      fs.writeFileSync(path.join(repository, 'src/context.ts'), 'export {};\n');
      git(repository, ['add', 'src/context.ts']);
      const tree = git(repository, ['write-tree']).trim();
      const commitHash = git(repository, [
        'commit-tree',
        tree,
        '-p',
        session.baseline.head,
        '-m',
        message,
      ]).trim();
      const finishReportId = 'd'.repeat(64);
      const commitReportId = writeImmutableReport(runtime.reports, {
        schemaVersion: 1,
        kind: 'commit',
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        createdAt: session.createdAt,
        planningAssurance: null,
        parentReportId: finishReportId,
        commitHash,
        tree,
        changedPaths: ['src/context.ts'],
        message: `${message}\n`,
      });
      const pending = {
        ...session,
        latestCheckReportId: 'e'.repeat(64),
        completionReportId: 'f'.repeat(64),
        finishReportId,
        commitReportId,
        commitHash,
      };
      persistSession(repository, pending);
      fs.mkdirSync(runtime.locks, { recursive: true });
      const leases = acquireTaskSessionIsolationLeases(runtime, pending);
      closeTaskSessionIsolationLeaseAcquisition(leases);
      for (const lease of leases.publications)
        assert.equal(fs.existsSync(lease.filePath), true);
      if (refUpdated)
        git(repository, [
          'update-ref',
          'HEAD',
          commitHash,
          session.baseline.head,
        ]);
      const context = readWorkflowSessionContext(repository, session.sessionId);
      assert.deepEqual(context.session, pending);
      const result = resumePendingCommit(context, subject);
      assert.equal(result.commitHash, commitHash);
      assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), commitHash);
      assert.deepEqual(result.session.isolation, pending.isolation);
      assert.deepEqual(result.session.artifacts, pending.artifacts);
      assert.equal(result.session.mandateBinding, null);
      assert.deepEqual(
        readWorkflowSessionContext(repository, session.sessionId).session,
        result.session,
      );
      assert.equal(result.session.state, 'committed');
      for (const lease of leases.publications)
        assert.equal(fs.existsSync(lease.filePath), false);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('runtime context readers and consumers reject type and value dependencies on composition', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const prefix = 'packages/workflow-engine/src/';
  const resolver = readRepositoryDependencies(root);
  for (const relative of [
    'runtime/repository-observation/investigation-runtime-context.ts',
    'runtime/repository-observation/workflow-session-context.ts',
    'runtime/storage-journal/provider-worker-maintenance.ts',
    'runtime/provider-execution/execution-runtime.ts',
    'runtime/provider-execution/provider-probe-executor.ts',
    'runtime/repository-transaction/commit-recovery.ts',
  ]) {
    const check = (extra = '') => {
      const { edges } = resolver.read(path.join(root, prefix, relative), extra);
      assert.equal(
        edges.some((edge) => edge.to.startsWith(prefix + 'composition-root/')),
        false,
        relative,
      );
    };
    check();
    for (const declaration of [
      "import { loadActiveSessionContext } from '../../composition-root/lifecycle-context.ts';",
      "import type { loadActiveSessionContext } from '../../composition-root/lifecycle-context.ts';",
    ])
      assert.throws(() => check('\n' + declaration), assert.AssertionError);
  }
});
