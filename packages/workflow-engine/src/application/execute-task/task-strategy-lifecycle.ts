import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
/**
 * Inspects and resumes task strategies across mechanical and TDD execution
 * states.
 *
 * Invariants:
 * - Mechanical and other non-TDD tasks cannot retain a TDD strategy
 *   transaction.
 */
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  CrossAgentTddExecution,
  ExecutionTask,
  TddSingleAgentExecution,
} from '../../modules/planning-provider/planning-artifact-types.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import {
  providerInvocationExists,
  readProviderInvocation,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import { type WorkflowSession } from './session.ts';
import { getSession } from '../../runtime/repository-observation/workflow-session-context.ts';
import {
  inspectTaskMechanicalTransformLifecycle,
  resumeTaskMechanicalTransformation,
} from './task-mechanical-transform-lifecycle.ts';
import type {
  TaskStrategyImplementationLifecycle,
  BeginTaskStrategyImplementationOptions,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
import { createTaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import type { ManagedTaskStrategyState } from '../../modules/lifecycle/managed-workflow-state-contract.ts';
import {
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readCurrentTaskStrategyImplementationProviderAttempt,
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
} from '../../runtime/storage-journal/task-strategy-provider-store.ts';
import { sealTaskStrategyRed } from './task-strategy-execution.ts';
import {
  adoptCurrentTaskStrategyCorrection,
  adoptCurrentTaskStrategyImplementation,
} from './task-strategy-patch.ts';
import {
  resolveCurrentTaskStrategyCorrection,
  resolveCurrentTaskStrategyImplementationAuthority,
  type TaskStrategyCorrectionProjection,
} from './task-strategy-correction.ts';
import type { createTaskStrategyRedRevisionService } from './task-strategy-red-revision.ts';
import type { TaskStrategyRedRevisionRequest } from '../../runtime/storage-journal/task-strategy-red-revision-store.ts';
import { readTaskStrategyPatchCurrentBinding } from '../../runtime/storage-journal/task-strategy-patch-store.ts';
import {
  readTaskStrategyTransaction,
  type TaskStrategyTransaction,
} from '../../runtime/storage-journal/task-strategy-store.ts';
import { inspectSession } from '../finalize/verification.ts';

type TddStrategy = 'cross-agent-tdd' | 'tdd-single-agent';

export type TaskStrategyLifecycleState = ManagedTaskStrategyState;

export type TaskStrategyLifecycleStatus = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-lifecycle-status.v1';
  sessionId: string;
  strategy: string | null;
  state: TaskStrategyLifecycleState;
  transactionDigest: string | null;
  invocationId: string | null;
  sessionState: string;
  inputSchema?: unknown;
}>;

export type ResumeTaskStrategyOptions = Readonly<{
  explicitActor?: string;
  collaborationGrant?: BeginTaskStrategyImplementationOptions['collaborationGrant'];
  redRevisionRequest?: TaskStrategyRedRevisionRequest;
}>;

/** Strictly read durable strategy state; never seal, reserve, dispatch, or import. */
export function inspectTaskStrategyLifecycle(
  reviewedAssets: ReviewedGeneratedAssetInventory,
  changeContract: ChangeContractServices,
  cwd: string,
  requestedSessionId: string,
): TaskStrategyLifecycleStatus {
  const session = getSession(cwd, requestedSessionId);
  const context = loadInvestigationRuntimeContext(cwd);
  const transaction = readTaskStrategyTransaction(
    context.runtime,
    session.sessionId,
  );
  if (session.state !== 'active') {
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: transaction?.strategy ?? null,
      state: 'session-terminal',
      transactionDigest: transaction?.recordDigest ?? null,
      sessionState: session.state,
    });
  }

  const contract = changeContract.loadStableValidatedChangeContract(
    discoverRepository(cwd),
    session.changeId,
  ).contract;
  const task = contract.execution?.tasks[session.taskId];
  if (task?.strategy === 'mechanical-transform') {
    if (transaction !== null) throw lifecycleStale();
    const mechanical = inspectTaskMechanicalTransformLifecycle(
      reviewedAssets,
      changeContract,
      cwd,
      session.sessionId,
    );
    if (mechanical === null) throw lifecycleStale();
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: task.strategy,
      state: mechanical.state,
      transactionDigest: null,
      sessionState: session.state,
    });
  }
  if (!isTddExecution(task)) {
    if (transaction !== null) throw lifecycleStale();
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: task?.strategy ?? null,
      state: 'not-required',
      transactionDigest: null,
      sessionState: session.state,
    });
  }
  if (transaction === null) {
    return lifecycleStatus({
      sessionId: session.sessionId,
      strategy: task.strategy,
      state: 'red-authoring',
      transactionDigest: null,
      sessionState: session.state,
    });
  }
  assertTransactionContractCurrent(transaction, session, task);
  const inspection = inspectSession(changeContract, cwd, session.sessionId);
  const correction = resolveCurrentTaskStrategyCorrection(inspection);
  const implementationAuthority =
    resolveCurrentTaskStrategyImplementationAuthority(inspection, correction);
  return projectDurableImplementationState(
    context.runtime,
    transaction,
    session.state,
    correction,
    implementationAuthority.subject,
  );
}

/**
 * Advance only the next durable strategy substate. Process dispatch remains a
 * CLI concern so the domain transition cannot launch an arbitrary executable.
 */
export function resumeTaskStrategy(
  reviewedAssets: ReviewedGeneratedAssetInventory,
  changeContract: ChangeContractServices,
  implementation: Pick<
    TaskStrategyImplementationLifecycle,
    'beginTaskStrategyImplementation'
  >,
  redRevision: ReturnType<typeof createTaskStrategyRedRevisionService>,
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
  cwd: string,
  requestedSessionId: string,
  options: ResumeTaskStrategyOptions = {},
): TaskStrategyLifecycleStatus {
  let current = inspectTaskStrategyLifecycle(
    reviewedAssets,
    changeContract,
    cwd,
    requestedSessionId,
  );
  if (current.state === 'not-required') return current;
  if (current.state === 'session-terminal') {
    throw workflowError(
      'TASK_STRATEGY_RESUME_NOT_APPLICABLE',
      'Only an active task strategy transaction can be resumed.',
      ExitCode.staleState,
    );
  }
  if (current.strategy === 'mechanical-transform') {
    if (
      options.explicitActor !== undefined ||
      options.collaborationGrant !== undefined ||
      options.redRevisionRequest !== undefined
    ) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_INPUT_INVALID',
        'Deterministic mechanical transformation resume does not accept provider, grant, or RED-revision input.',
        ExitCode.usage,
      );
    }
    resumeTaskMechanicalTransformation(
      reviewedAssets,
      changeContract,
      cwd,
      current.sessionId,
    );
    return inspectTaskStrategyLifecycle(
      reviewedAssets,
      changeContract,
      cwd,
      current.sessionId,
    );
  }
  if (options.redRevisionRequest !== undefined) {
    if (
      options.redRevisionRequest.sessionId !== current.sessionId ||
      options.explicitActor !== undefined ||
      options.collaborationGrant !== undefined
    ) {
      throw workflowError(
        'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
        'RED revision input must name this session and cannot be combined with actor or collaboration-grant authority.',
        ExitCode.usage,
      );
    }
    redRevision.beginTaskStrategyRedRevision(cwd, options.redRevisionRequest);
    return inspectTaskStrategyLifecycle(
      reviewedAssets,
      changeContract,
      cwd,
      current.sessionId,
    );
  }

  redRevision.continueTaskStrategyRedRevision(cwd, current.sessionId);
  current = inspectTaskStrategyLifecycle(
    reviewedAssets,
    changeContract,
    cwd,
    current.sessionId,
  );
  if (current.state === 'red-authoring') {
    const transaction = sealTaskStrategyRed(
      changeContract,
      cwd,
      current.sessionId,
      {
        ...(options.explicitActor === undefined
          ? {}
          : { explicitActor: options.explicitActor }),
      },
    );
    if (transaction.strategy === 'tdd-single-agent') {
      return inspectTaskStrategyLifecycle(
        reviewedAssets,
        changeContract,
        cwd,
        current.sessionId,
      );
    }
  }

  current = inspectTaskStrategyLifecycle(
    reviewedAssets,
    changeContract,
    cwd,
    current.sessionId,
  );
  if (
    current.strategy === 'tdd-single-agent' &&
    current.state === 'implementation-required'
  ) {
    const adopted = adoptCurrentTaskStrategyImplementation(
      changeContract,
      cwd,
      current.sessionId,
    );
    return adopted === null
      ? current
      : inspectTaskStrategyLifecycle(
          reviewedAssets,
          changeContract,
          cwd,
          current.sessionId,
        );
  }
  if (
    current.strategy === 'tdd-single-agent' &&
    current.state === 'correction-required'
  ) {
    const adopted = adoptCurrentTaskStrategyCorrection(
      changeContract,
      cwd,
      current.sessionId,
    );
    return adopted === null
      ? current
      : inspectTaskStrategyLifecycle(
          reviewedAssets,
          changeContract,
          cwd,
          current.sessionId,
        );
  }
  if (
    current.state === 'patch-imported' ||
    current.state === 'correction-exhausted' ||
    (current.state === 'correction-required' &&
      current.strategy === 'tdd-single-agent')
  ) {
    return current;
  }
  const advanced = implementation.beginTaskStrategyImplementation(
    readProviderRetryAccountingEvidence,
    cwd,
    current.sessionId,
    {
      ...(current.state === 'provider-failed'
        ? { retryProviderFailure: true as const }
        : {}),
      ...(options.collaborationGrant === undefined
        ? {}
        : { collaborationGrant: options.collaborationGrant }),
    },
  );
  const transaction = requireTransaction(cwd, current.sessionId);
  return projectAdvancedStatus(advanced, transaction, 'active');
}

function projectDurableImplementationState(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  transaction: TaskStrategyTransaction,
  sessionState: string,
  correction: TaskStrategyCorrectionProjection,
  expectedSubject: TaskStrategyImplementationSubject,
): TaskStrategyLifecycleStatus {
  const base = {
    sessionId: transaction.sessionId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    sessionState,
  };
  const patchBinding = correction.head?.binding ?? null;
  if (correction.exhausted) {
    return lifecycleStatus({
      ...base,
      state: 'correction-exhausted',
    });
  }
  if (transaction.strategy === 'tdd-single-agent') {
    return lifecycleStatus({
      ...base,
      state:
        correction.failure !== null
          ? 'correction-required'
          : patchBinding === null
            ? 'implementation-required'
            : 'patch-imported',
    });
  }

  const reservation = readTaskStrategyImplementationReservation(
    runtime,
    transaction.sessionId,
    expectedSubject.subjectDigest,
  );
  const callerReservation = readTaskStrategyCallerImplementationReservation(
    runtime,
    transaction.sessionId,
    expectedSubject.subjectDigest,
  );
  const callerBinding = readTaskStrategyCallerImplementationBinding(
    runtime,
    transaction.sessionId,
    expectedSubject.subjectDigest,
  );
  if (reservation === null) {
    if (callerReservation !== null || callerBinding !== null) {
      if (
        callerReservation === null ||
        callerReservation.subjectDigest !== expectedSubject.subjectDigest
      ) {
        throw lifecycleStale();
      }
      return lifecycleStatus({
        ...base,
        state:
          callerBinding !== null &&
          callerBinding.subjectDigest === callerReservation.subjectDigest &&
          patchBinding !== null &&
          patchBinding.patchDigest === callerBinding.output.patchDigest
            ? 'patch-imported'
            : 'caller-supplied-awaiting-import',
      });
    }
    return lifecycleStatus({
      ...base,
      state: correction.failure === null ? 'ready' : 'correction-required',
    });
  }
  if (
    reservation.subject.subjectDigest !== expectedSubject.subjectDigest ||
    reservation.subject.transactionDigest !== transaction.recordDigest
  ) {
    throw lifecycleStale();
  }
  const attempt = readCurrentTaskStrategyImplementationProviderAttempt(
    runtime,
    reservation,
  );
  if (!providerInvocationExists(runtime, attempt.request.invocationId)) {
    return lifecycleStatus({
      ...base,
      state: 'reservation-persisted',
      invocationId: attempt.request.invocationId,
    });
  }
  const invocation = readProviderInvocation(
    runtime,
    attempt.request.invocationId,
  );
  if (invocation.state === 'failed') {
    return lifecycleStatus({
      ...base,
      state: 'provider-failed',
      invocationId: invocation.invocationId,
    });
  }
  if (invocation.state !== 'succeeded') {
    return lifecycleStatus({
      ...base,
      state: 'waiting-for-provider',
      invocationId: invocation.invocationId,
    });
  }
  const result = readTaskStrategyImplementationResultBinding(
    runtime,
    transaction.sessionId,
    expectedSubject.subjectDigest,
  );
  return lifecycleStatus({
    ...base,
    state:
      result !== null &&
      result.subjectDigest === expectedSubject.subjectDigest &&
      patchBinding !== null &&
      result.output.patchDigest === patchBinding.patchDigest
        ? 'patch-imported'
        : 'provider-succeeded-awaiting-import',
    invocationId: invocation.invocationId,
  });
}

function projectAdvancedStatus(
  advanced: TaskStrategyImplementationStatus,
  transaction: TaskStrategyTransaction,
  sessionState: string,
): TaskStrategyLifecycleStatus {
  return lifecycleStatus({
    sessionId: advanced.sessionId,
    strategy: transaction.strategy,
    state:
      advanced.state === 'provider-not-required'
        ? 'implementation-required'
        : advanced.state,
    transactionDigest: transaction.recordDigest,
    invocationId: 'invocationId' in advanced ? advanced.invocationId : null,
    sessionState,
    ...('inputSchema' in advanced ? { inputSchema: advanced.inputSchema } : {}),
  });
}

function assertTransactionContractCurrent(
  transaction: TaskStrategyTransaction,
  session: WorkflowSession,
  task: CrossAgentTddExecution | TddSingleAgentExecution,
): void {
  if (
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.strategy !== task.strategy ||
    transaction.baseline.head !== session.baseline.head ||
    transaction.baseline.tree !== session.baseline.tree ||
    transaction.taskContractDigest !== sha256(canonicalJson(task))
  ) {
    throw lifecycleStale();
  }
}

function subject(
  transaction: TaskStrategyTransaction,
): TaskStrategyImplementationSubject {
  return createTaskStrategyImplementationSubject({
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    strategy: transaction.strategy,
    transactionDigest: transaction.recordDigest,
    taskContractDigest: transaction.taskContractDigest,
    sourceTree: transaction.red.candidateTree,
    failureFingerprint: transaction.red.failureFingerprint,
    redEvidenceNodeId: transaction.red.evidenceNodeId,
    redEvidenceResultDigest: transaction.red.evidenceResultDigest,
    testPaths: transaction.red.testPaths,
    fixturePaths: transaction.red.fixturePaths,
    frozenFiles: transaction.red.files,
  });
}

function requireTransaction(
  cwd: string,
  sessionId: string,
): TaskStrategyTransaction {
  const context = loadInvestigationRuntimeContext(cwd);
  const transaction = readTaskStrategyTransaction(context.runtime, sessionId);
  if (transaction === null) throw lifecycleStale();
  return transaction;
}

function lifecycleStatus(
  input: Omit<
    TaskStrategyLifecycleStatus,
    'schemaVersion' | 'kind' | 'invocationId'
  > & { invocationId?: string | null },
): TaskStrategyLifecycleStatus {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'task-strategy-lifecycle-status.v1',
    invocationId: null,
    ...input,
  });
}

function isTddExecution(
  task: ExecutionTask | undefined,
): task is CrossAgentTddExecution | TddSingleAgentExecution {
  return isTddStrategy(task?.strategy);
}

function isTddStrategy(value: unknown): value is TddStrategy {
  return value === 'cross-agent-tdd' || value === 'tdd-single-agent';
}

function lifecycleStale() {
  return workflowError(
    'TASK_STRATEGY_LIFECYCLE_STALE',
    'Durable task strategy state no longer matches the active reviewed task contract.',
    ExitCode.staleState,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
