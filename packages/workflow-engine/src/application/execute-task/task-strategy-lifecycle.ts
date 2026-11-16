/** Inspect durable strategy state and select the next existing transition. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  CrossAgentTddExecution,
  ExecutionTask,
  TddSingleAgentExecution,
} from '../../modules/planning-provider/planning-artifact-types.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { ManagedTaskStrategyState } from '../../modules/lifecycle/managed-workflow-state-contract.ts';
import type { TaskStrategyTransaction } from '../../modules/assurance/task-strategy-evidence.ts';
import type { TaskStrategyCorrectionProjection } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import type { TaskStrategyImplementationStatus } from './task-strategy-implementation-lifecycle.ts';
import type {
  TaskStrategyLifecycleOperations,
  TaskStrategyLifecycleJournal,
  ResumeTaskStrategyOptions,
} from './task-strategy-lifecycle-operations.ts';
export type { ResumeTaskStrategyOptions } from './task-strategy-lifecycle-operations.ts';

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

/** Bind the complete orchestration without observing or advancing a session. */
export function createTaskStrategyLifecycle(
  operations: TaskStrategyLifecycleOperations,
) {
  /** Strictly read durable strategy state; never seal, reserve, dispatch, or import. */
  function inspectTaskStrategyLifecycle(
    cwd: string,
    requestedSessionId: string,
  ): TaskStrategyLifecycleStatus {
    const session = operations.session.read(cwd, requestedSessionId);
    const journal = operations.observeJournal(cwd);
    const transaction = journal.correction.readTransaction(session.sessionId);
    if (session.state !== 'active') {
      return lifecycleStatus({
        sessionId: session.sessionId,
        strategy: transaction?.strategy ?? null,
        state: 'session-terminal',
        transactionDigest: transaction?.recordDigest ?? null,
        sessionState: session.state,
      });
    }

    const contract = operations.session.loadStableContract(
      operations.session.discoverRepository(cwd),
      session.changeId,
    ).contract;
    const task = contract.execution?.tasks[session.taskId];
    if (task?.strategy === 'mechanical-transform') {
      if (transaction !== null) throw lifecycleStale();
      const mechanical = operations.mechanical.inspect(cwd, session.sessionId);
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
    const inspection = operations.session.inspect(cwd, session.sessionId);
    const correction = operations.session.resolveCorrection(inspection);
    const implementationAuthority =
      operations.session.resolveImplementationAuthority(inspection, correction);
    return projectDurableImplementationState(
      journal,
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
  function resumeTaskStrategy(
    cwd: string,
    requestedSessionId: string,
    options: ResumeTaskStrategyOptions = {},
  ): TaskStrategyLifecycleStatus {
    let current = inspectTaskStrategyLifecycle(cwd, requestedSessionId);
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
      operations.mechanical.resume(cwd, current.sessionId);
      return inspectTaskStrategyLifecycle(cwd, current.sessionId);
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
      operations.red.beginRevision(cwd, options.redRevisionRequest);
      return inspectTaskStrategyLifecycle(cwd, current.sessionId);
    }

    operations.red.continueRevision(cwd, current.sessionId);
    current = inspectTaskStrategyLifecycle(cwd, current.sessionId);
    if (current.state === 'red-authoring') {
      const transaction = operations.red.seal(cwd, current.sessionId, {
        ...(options.explicitActor === undefined
          ? {}
          : { explicitActor: options.explicitActor }),
      });
      if (transaction.strategy === 'tdd-single-agent') {
        return inspectTaskStrategyLifecycle(cwd, current.sessionId);
      }
    }

    current = inspectTaskStrategyLifecycle(cwd, current.sessionId);
    if (
      current.strategy === 'tdd-single-agent' &&
      current.state === 'implementation-required'
    ) {
      const adopted = operations.adopt.implementation(cwd, current.sessionId);
      return adopted === null
        ? current
        : inspectTaskStrategyLifecycle(cwd, current.sessionId);
    }
    if (
      current.strategy === 'tdd-single-agent' &&
      current.state === 'correction-required'
    ) {
      const adopted = operations.adopt.correction(cwd, current.sessionId);
      return adopted === null
        ? current
        : inspectTaskStrategyLifecycle(cwd, current.sessionId);
    }
    if (
      current.state === 'patch-imported' ||
      current.state === 'correction-exhausted' ||
      (current.state === 'correction-required' &&
        current.strategy === 'tdd-single-agent')
    ) {
      return current;
    }
    const advanced = operations.implementation.beginTaskStrategyImplementation(
      operations.readProviderRetryAccountingEvidence,
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
    journal: TaskStrategyLifecycleJournal,
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

    const reservation = journal.implementation.readReservation(
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    const callerReservation = journal.implementation.readCallerReservation(
      transaction.sessionId,
      expectedSubject.subjectDigest,
    );
    const callerBinding = journal.implementation.readCallerResult(
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
    const attempt = journal.implementation.readCurrentAttempt(reservation);
    if (!journal.provider.exists(attempt.request.invocationId)) {
      return lifecycleStatus({
        ...base,
        state: 'reservation-persisted',
        invocationId: attempt.request.invocationId,
      });
    }
    const invocation = journal.provider.read(attempt.request.invocationId);
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
    const result = journal.implementation.readResult(
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
      ...('inputSchema' in advanced
        ? { inputSchema: advanced.inputSchema }
        : {}),
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

  function requireTransaction(
    cwd: string,
    sessionId: string,
  ): TaskStrategyTransaction {
    const journal = operations.observeJournal(cwd);
    const transaction = journal.correction.readTransaction(sessionId);
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

  return { inspectTaskStrategyLifecycle, resumeTaskStrategy };
}
