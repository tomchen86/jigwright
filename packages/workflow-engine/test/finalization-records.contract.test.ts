import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceFinalizeTransactionRecord,
  createFinalizeTransaction,
  parseFinalizeTransaction,
  parseProtectedTaskApplyAuthorizationBinding,
  type FinalizeTransaction,
  type FinalizeTransactionSeed,
  type ProtectedTaskApplyAuthorizationBinding,
} from '../src/modules/lifecycle/finalize-transaction.ts';
import {
  assertSameCancellation,
  assertSameCancellationRequest,
  createFinalizeCancellation,
  parseFinalizeCancellation,
  prepareFinalizeCancellationCompletion,
  prepareFinalizeProjectionRestored,
  sealCancellation,
} from '../src/modules/lifecycle/finalize-cancellation.ts';
import {
  assertCancellationRequest,
  assertFinalizeCancellationReason,
  assertFinalizeTransactionMatchesSession,
  assertProjectedFinalizeReportChain,
  cancellationResult,
  finalizeResultFromTransaction,
  isCompletedFinalizeTransaction,
} from '../src/modules/lifecycle/finalization.ts';
import { PROJECTED_SINGLE_PASS_ASSURANCE } from '../src/modules/lifecycle/projected-finalization.ts';
import type { WorkflowSession } from '../src/modules/lifecycle/workflow-session-contract.ts';
import type { WorkflowReport } from '../src/modules/lifecycle/workflow-report.ts';
import {
  parseTaskAuthorizationPolicyFromWorkflowConfig,
  resolveTaskAuthorizationRequirementForPolicy,
} from '../src/modules/repository-consumer/task-authorization-policy.ts';
import { parsePathRoleRegistry } from '../src/modules/source/path-role-registry.ts';

const NOW = '2026-10-24T00:00:00.000Z';
const LATER = '2026-10-24T00:01:00.000Z';
const DIGEST = 'a'.repeat(64);
const TREE = 'b'.repeat(40);
const RECORD_INVALID = { code: 'FINALIZE_TRANSACTION_INVALID' };
const CANCELLATION_INVALID = { code: 'FINALIZE_CANCELLATION_INVALID' };

function authorization(): ProtectedTaskApplyAuthorizationBinding {
  return {
    schemaVersion: 1,
    kind: 'protected-task-apply-authorization.v1',
    transitionId: 'task.protected-apply.finalize.v1',
    challengeId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    approvalSubjectDigest: `sha256:${DIGEST}`,
    stateBindingDigest: `sha256:${DIGEST}`,
    parametersDigest: `sha256:${DIGEST}`,
    commitMessage: 'Finalize exact task',
  };
}

function seed(): FinalizeTransactionSeed {
  return {
    schemaVersion: 2,
    kind: 'projected-finalize-transaction.v2',
    sessionId: 'session-records',
    changeId: 'record-rules',
    taskId: '1.2',
    repositoryRoot: '/tmp/finalization-records',
    gitCommonDirectory: '/tmp/finalization-records/.git',
    branch: 'work/record-rules',
    baseline: { head: 'c'.repeat(40), tree: TREE },
    completedTaskIds: ['1.1', '1.2'],
    requiredChecks: ['unit', 'types'],
    checkEscalation: null,
    reconciledTasks: [
      {
        taskId: '1.1',
        commitHash: 'd'.repeat(40),
        changedPaths: ['src/first.ts'],
        checks: [{ id: 'unit', facts: { retained: true } }],
      },
    ],
    taskProjectionPath: 'spec/tasks.md',
    projectionMutations: [
      { path: 'docs/handoff.md', before: null, after: 'ready\n' },
      { path: 'spec/tasks.md', before: '- [ ] 1.2\n', after: '- [x] 1.2\n' },
    ],
    projectionSourceDigest: DIGEST,
    projectionBaseFingerprint: DIGEST,
    transitionPaths: ['docs/handoff.md'],
    previousIndexTree: TREE,
    createdAt: NOW,
    protectedApply: authorization(),
  };
}

function phases(): FinalizeTransaction[] {
  const prepared = createFinalizeTransaction(seed());
  const candidate = advanceFinalizeTransactionRecord(prepared, {
    ...prepared,
    phase: 'candidate-prepared',
    changedPaths: ['docs/handoff.md', 'spec/tasks.md', 'src/feature.ts'],
    candidateTree: TREE,
    candidateFingerprint: DIGEST,
    candidateStatusEntries: [' M src/feature.ts'],
  });
  const running = advanceFinalizeTransactionRecord(candidate, {
    ...candidate,
    phase: 'checks-running',
  });
  const checked = advanceFinalizeTransactionRecord(running, {
    ...running,
    phase: 'checked',
    checkReportId: '1'.repeat(64),
  });
  const staged = advanceFinalizeTransactionRecord(checked, {
    ...checked,
    phase: 'staged',
  });
  const persisted = advanceFinalizeTransactionRecord(staged, {
    ...staged,
    phase: 'reports-persisted',
    completionReportId: '2'.repeat(64),
    finishReportId: '3'.repeat(64),
  });
  const completed = advanceFinalizeTransactionRecord(persisted, {
    ...persisted,
    phase: 'completed',
  });
  return [prepared, candidate, running, checked, staged, persisted, completed];
}

function sessionFor(transaction: FinalizeTransaction): WorkflowSession {
  return {
    schemaVersion: 1,
    state: 'active',
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    baseline: transaction.baseline,
    repositoryRoot: transaction.repositoryRoot,
    gitCommonDirectory: transaction.gitCommonDirectory,
    branch: transaction.branch,
    artifacts: { tasks: DIGEST },
    allowedPaths: ['src/**'],
    requiredChecks: [...transaction.requiredChecks],
    requiredCheckDigests: { unit: DIGEST, types: DIGEST },
    planningAssurance: null,
    isolation: {
      schemaVersion: 1,
      routingRole: 'single',
      routingWorksetDigest: `sha256:${DIGEST}`,
      concurrencyEnabled: false,
      worktreeDigest: `sha256:${DIGEST}`,
      resources: [],
    },
    createdAt: NOW,
  };
}

test('transaction records preserve canonical copies, nested aliases and the exact protected binding', () => {
  const input = seed();
  const value = createFinalizeTransaction(input);
  assert.equal(value.phase, 'projection-prepared');
  assert.match(value.transactionId, /^[0-9a-f]{64}$/);
  assert.match(value.recordDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(value.baseline, input.baseline);
  assert.notEqual(value.completedTaskIds, input.completedTaskIds);
  assert.notEqual(value.requiredChecks, input.requiredChecks);
  assert.notEqual(value.projectionMutations, input.projectionMutations);
  assert.notEqual(value.projectionMutations[0], input.projectionMutations[0]);
  assert.notEqual(value.reconciledTasks[0], input.reconciledTasks[0]);
  assert.notEqual(
    value.reconciledTasks[0]!.checks[0],
    input.reconciledTasks[0]!.checks[0],
  );
  const originalCheck = input.reconciledTasks[0]!.checks[0] as {
    facts: unknown;
  };
  const copiedCheck = value.reconciledTasks[0]!.checks[0] as { facts: unknown };
  assert.equal(copiedCheck.facts, originalCheck.facts);
  assert.notEqual(value.protectedApply, input.protectedApply);
  assert.equal(Object.isFrozen(value.protectedApply), true);
  assert.equal(Object.isFrozen(value), false);
  assert.deepEqual(parseFinalizeTransaction(value), value);
  assert.notEqual(parseFinalizeTransaction(value), value);
  for (const invalid of [
    { ...value, recordDigest: 'f'.repeat(64) },
    { ...value, transactionId: 'f'.repeat(64) },
    { ...value, extra: true },
    { ...value, documentationReview: null },
    { ...value, protectedApply: undefined },
    { ...value, requiredChecks: ['unit', 'unit'] },
    { ...value, transitionPaths: ['spec/tasks.md'] },
    { ...value, taskProjectionPath: '../tasks.md' },
  ])
    assert.throws(() => parseFinalizeTransaction(invalid), RECORD_INVALID);
});

test('transaction phase advancement admits one successor and retains candidate and report constraints', () => {
  const all = phases();
  assert.deepEqual(
    all.map((x) => x.phase),
    [
      'projection-prepared',
      'candidate-prepared',
      'checks-running',
      'checked',
      'staged',
      'reports-persisted',
      'completed',
    ],
  );
  assert.equal(new Set(all.map((x) => x.transactionId)).size, 1);
  assert.equal(new Set(all.map((x) => x.recordDigest)).size, all.length);
  for (const value of all)
    assert.deepEqual(parseFinalizeTransaction(value), value);
  assert.throws(
    () => advanceFinalizeTransactionRecord(all[0]!, all[2]!),
    RECORD_INVALID,
  );
  assert.throws(
    () => advanceFinalizeTransactionRecord(all[6]!, all[6]!),
    /already terminal/,
  );
  assert.throws(
    () =>
      advanceFinalizeTransactionRecord(all[0]!, {
        ...all[1]!,
        candidateTree: null,
      }),
    RECORD_INVALID,
  );
  assert.throws(
    () =>
      advanceFinalizeTransactionRecord(all[2]!, {
        ...all[3]!,
        checkReportId: null,
      }),
    RECORD_INVALID,
  );
  assert.throws(
    () =>
      advanceFinalizeTransactionRecord(all[4]!, {
        ...all[5]!,
        finishReportId: null,
      }),
    RECORD_INVALID,
  );
  const other = createFinalizeTransaction({ ...seed(), taskId: '9.9' });
  assert.throws(
    () => advanceFinalizeTransactionRecord(other, all[1]!),
    /phase is invalid/,
  );
  const reads: string[] = [];
  const current = {
    ...all[0]!,
    get transactionId() {
      reads.push('identity');
      return all[0]!.transactionId;
    },
    get phase() {
      reads.push('phase');
      return all[0]!.phase;
    },
  };
  assert.throws(
    () =>
      advanceFinalizeTransactionRecord(current, {
        ...all[1]!,
        candidateTree: null,
      }),
    RECORD_INVALID,
  );
  assert.deepEqual([...reads], []);
  advanceFinalizeTransactionRecord(current, all[1]!);
  assert.deepEqual([...reads], ['identity', 'phase']);
});

test('protected transaction binding stays exact, fresh and frozen', () => {
  const input = authorization();
  const parsed = parseProtectedTaskApplyAuthorizationBinding(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  for (const change of [
    { challengeId: 'not-a-uuid' },
    { operationId: input.operationId.toUpperCase().replace('4', '5') },
    { transitionId: 'other' },
    { parametersDigest: DIGEST },
    { commitMessage: ' leading space' },
    { commitMessage: 'line\nbreak' },
    { commitMessage: 'x'.repeat(4097) },
    { unknown: true },
  ])
    assert.throws(
      () =>
        parseProtectedTaskApplyAuthorizationBinding({ ...input, ...change }),
      RECORD_INVALID,
    );
});

test('cancellation preparation separates phase admission from sealing without losing record identity', () => {
  const all = phases();
  for (const transaction of [all[0]!, all[1]!, all[4]!, all[6]!])
    assert.throws(
      () => createFinalizeCancellation(transaction, 'Retry exact checks', NOW),
      CANCELLATION_INVALID,
    );
  for (const transaction of [all[2]!, all[3]!]) {
    const requested = createFinalizeCancellation(
      transaction,
      'Retry exact checks',
      NOW,
    );
    assert.notEqual(requested.transaction, transaction);
    assert.deepEqual(requested.transaction, transaction);
    const preparedRestore = prepareFinalizeProjectionRestored(requested);
    assert.equal(preparedRestore.transaction, requested.transaction);
    assert.equal(preparedRestore.recordDigest, requested.recordDigest);
    assert.throws(
      () => parseFinalizeCancellation(preparedRestore),
      CANCELLATION_INVALID,
    );
    const restored = sealCancellation(preparedRestore);
    assert.equal(restored.phase, 'projection-restored');
    assert.notEqual(restored.recordDigest, requested.recordDigest);
    assert.throws(
      () => prepareFinalizeProjectionRestored(restored),
      /not awaiting restoration/,
    );
    assert.throws(
      () => prepareFinalizeCancellationCompletion(requested, LATER),
      /has not been restored/,
    );
    const completed = sealCancellation(
      prepareFinalizeCancellationCompletion(restored, LATER),
    );
    assert.deepEqual(cancellationResult(completed), {
      state: 'cancelled',
      sessionId: transaction.sessionId,
      transactionId: transaction.transactionId,
      reason: 'Retry exact checks',
      cancelledAt: LATER,
    });
    assert.deepEqual(parseFinalizeCancellation(completed), completed);
    assert.throws(() => cancellationResult(requested), /not durably completed/);
    for (const invalid of [
      { ...completed, recordDigest: DIGEST },
      { ...completed, reason: 'altered' },
      { ...completed, cancelledAt: null },
      { ...completed, extra: true },
    ])
      assert.throws(
        () => parseFinalizeCancellation(invalid),
        CANCELLATION_INVALID,
      );
  }
});

test('cancellation equality returns the observed record and preserves early phase refusal', () => {
  const cancellation = createFinalizeCancellation(
    phases()[2]!,
    'Retry exact checks',
    NOW,
  );
  assert.equal(
    assertSameCancellation(
      cancellation,
      JSON.parse(JSON.stringify(cancellation)),
    ),
    cancellation,
  );
  assert.equal(
    assertSameCancellationRequest(cancellation, cancellation),
    cancellation,
  );
  assert.throws(
    () =>
      assertSameCancellation(cancellation, {
        ...cancellation,
        reason: 'different',
      }),
    CANCELLATION_INVALID,
  );
  const wrongPhase = {
    ...cancellation,
    phase: 'completed' as const,
    get sessionId(): string {
      return assert.fail('phase refusal must precede session reads');
    },
  };
  assert.throws(
    () => assertSameCancellationRequest(wrongPhase, cancellation),
    CANCELLATION_INVALID,
  );
  const laterRequest = { ...cancellation, requestedAt: LATER };
  assert.equal(
    assertSameCancellationRequest(cancellation, laterRequest),
    cancellation,
  );
  assert.throws(
    () => assertSameCancellation(cancellation, laterRequest),
    CANCELLATION_INVALID,
  );
});

test('lifecycle cancellation admission retains reason errors and repository-first identity comparisons', () => {
  const transaction = phases()[2]!;
  const session = sessionFor(transaction);
  const git = {
    repositoryRealPath: transaction.repositoryRoot,
    gitCommonDirectory: transaction.gitCommonDirectory,
  };
  const cancellation = createFinalizeCancellation(
    transaction,
    'Retry exact checks',
    NOW,
  );
  assertCancellationRequest(
    cancellation,
    session,
    git,
    transaction.transactionId,
    cancellation.reason,
  );
  assert.throws(
    () =>
      assertCancellationRequest(
        cancellation,
        session,
        git,
        transaction.transactionId,
        'different',
      ),
    CANCELLATION_INVALID,
  );
  assertFinalizeCancellationReason('x'.repeat(1024));
  for (const reason of [
    '',
    ' leading',
    'trailing ',
    'line\nbreak',
    '字'.repeat(342),
  ]) {
    assert.throws(() => assertFinalizeCancellationReason(reason), {
      code: 'FINALIZE_CANCELLATION_REASON_INVALID',
    });
    assert.throws(
      () => createFinalizeCancellation(transaction, reason, NOW),
      CANCELLATION_INVALID,
    );
  }
  const reads: string[] = [];
  const observedGit = {
    get repositoryRealPath() {
      reads.push('repository');
      return '/different';
    },
    get gitCommonDirectory(): string {
      return assert.fail('first mismatch must stop later reads');
    },
  };
  assert.throws(
    () =>
      assertFinalizeTransactionMatchesSession(
        transaction,
        session,
        observedGit,
      ),
    RECORD_INVALID,
  );
  assert.deepEqual(reads, ['repository']);
  assertFinalizeTransactionMatchesSession(transaction, session, git);
});

test('completed replay results retain the session and copy arrays while report chain checks stay exact', () => {
  const transaction = phases()[6]!;
  assert.ok(isCompletedFinalizeTransaction(transaction));
  const session = sessionFor(transaction);
  const result = finalizeResultFromTransaction(transaction, session);
  assert.equal(result.session, session);
  assert.deepEqual(result.completedTaskIds, transaction.completedTaskIds);
  assert.notEqual(result.completedTaskIds, transaction.completedTaskIds);
  assert.notEqual(result.requiredChecks, transaction.requiredChecks);
  assert.notEqual(result.stagedPaths, transaction.changedPaths);
  assert.equal(result.tree, transaction.candidateTree);
  session.latestCheckReportId = transaction.checkReportId;
  const baseReport = {
    schemaVersion: 1 as const,
    sessionId: session.sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    createdAt: NOW,
    finalizeProfile: PROJECTED_SINGLE_PASS_ASSURANCE,
    candidateTree: TREE,
    checkEscalation: null,
  };
  const check: WorkflowReport = { ...baseReport, kind: 'check' };
  const completion: WorkflowReport = {
    ...baseReport,
    kind: 'completion',
    parentReportId: session.latestCheckReportId,
  };
  const finish: WorkflowReport = { ...baseReport, kind: 'finish', tree: TREE };
  assertProjectedFinalizeReportChain(session, completion, finish, check);
  assert.throws(
    () =>
      assertProjectedFinalizeReportChain(
        session,
        completion,
        { ...finish, tree: 'c'.repeat(40) },
        check,
      ),
    { code: 'FINISH_REPORT_STALE' },
  );
  assert.throws(
    () =>
      assertProjectedFinalizeReportChain(
        session,
        { ...completion, parentReportId: 'other' },
        finish,
        check,
      ),
    { code: 'FINISH_REPORT_STALE' },
  );
  assert.throws(
    () =>
      assertProjectedFinalizeReportChain(session, completion, finish, {
        ...check,
        parentReportId: 'unexpected',
      }),
    { code: 'FINISH_REPORT_STALE' },
  );
  assert.equal(
    isCompletedFinalizeTransaction({ ...transaction, finishReportId: null }),
    false,
  );
});

test('baseline task policy stays pure and keeps classified and unclassified scope distinct', () => {
  assert.equal(
    parseTaskAuthorizationPolicyFromWorkflowConfig({ schemaVersion: 1 }),
    null,
  );
  const source = {
    schemaVersion: 1,
    taskAuthorization: {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['lifecycle'],
    },
  };
  const policy = parseTaskAuthorizationPolicyFromWorkflowConfig(source);
  assert.ok(policy);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.mandateRequiredRoles), true);
  assert.notEqual(
    policy.mandateRequiredRoles,
    source.taskAuthorization.mandateRequiredRoles,
  );
  const registry = parsePathRoleRegistry({
    schemaVersion: 1,
    kind: 'path-role-registry',
    roles: { lifecycle: ['src/lifecycle/**'], ordinary: ['src/product/**'] },
  });
  const protectedScope = resolveTaskAuthorizationRequirementForPolicy(
    policy,
    registry,
    ['src/lifecycle/commit.ts'],
  );
  assert.equal(protectedScope.requiresMandate, true);
  assert.equal(Object.isFrozen(protectedScope.roles), true);
  assert.deepEqual(protectedScope.roles, ['lifecycle']);
  const unknown = resolveTaskAuthorizationRequirementForPolicy(
    policy,
    registry,
    ['future/**'],
  );
  assert.equal(unknown.requiresMandate, false);
  assert.equal(unknown.unclassifiedScope, true);
  assert.equal(
    resolveTaskAuthorizationRequirementForPolicy(policy, registry, [
      'src/product/view.ts',
    ]).requiresMandate,
    false,
  );
  assert.notEqual(protectedScope.policyDigest, unknown.policyDigest);
  for (const candidate of [
    { schemaVersion: 2 },
    {
      ...source,
      taskAuthorization: { ...source.taskAuthorization, extra: true },
    },
    {
      ...source,
      taskAuthorization: {
        ...source.taskAuthorization,
        mandateRequiredRoles: ['lifecycle', 'lifecycle'],
      },
    },
  ])
    assert.throws(
      () => parseTaskAuthorizationPolicyFromWorkflowConfig(candidate),
      { code: 'TASK_AUTHORIZATION_POLICY_INVALID' },
    );
});
