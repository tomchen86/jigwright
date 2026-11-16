import type { TaskStrategyImplementationOperations } from './task-strategy-implementation-operations.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
/** Start, inspect and verify TaskStrategy implementations through explicit observations and effects. */
import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { CollaborationGrantRequest } from '../../modules/authority/collaboration-grant-codec.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  GrantedRoleAssignment,
  ProviderRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import type { TaskStrategyImplementationReservation } from '../../modules/assurance/task-strategy-implementation-record.ts';
import { taskStrategyImplementationReservationForAttempt } from '../../modules/assurance/task-strategy-implementation-attempt.ts';
import { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';
import { createTaskStrategyCallerAdmission } from './task-strategy-caller-admission.ts';
import { createTaskStrategyProviderReservations } from './task-strategy-provider-reservations.ts';
import { createTaskStrategyProviderResults } from './task-strategy-provider-results.ts';

export type BeginTaskStrategyImplementationOptions = Readonly<{
  retryProviderFailure?: boolean;
  collaborationGrant?: Readonly<{
    grantId: string;
    now?: Date;
    verifier?: unknown;
    callerSupplied?: Readonly<{
      callerId: string;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
      patch: string | Buffer;
    }>;
  }>;
  testCrashAfter?:
    | 'provider-retry-reservation-persisted'
    | 'provider-result-persisted'
    | 'patch-applied'
    | 'receipt-persisted'
    | 'provider-patch-imported';
}>;

export type TaskStrategyRedAuthor = Readonly<{
  providerId: ProviderId;
  sessionId: string;
  principalId: string;
  identityAssurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  engineSpawned: false;
}>;

export type TaskStrategyImplementationStatus =
  | Readonly<{
      state: 'provider-not-required';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
    }>
  | Readonly<{
      state: 'ready' | 'reservation-persisted';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
    }>
  | Readonly<{
      state: 'collaboration-grant-required';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      inputSchema: Readonly<{
        schemaVersion: 1;
        kind: 'collaboration-grant-selection';
        lifecyclePhase: 'task-implementation';
        conflictingRole: 'task-implementer';
        grantRequest: CollaborationGrantRequest | null;
        allowedDegradedForms: readonly (
          'same-provider-fresh-session' | 'caller-supplied'
        )[];
        resumeOption: '--grant <grant-id>';
      }>;
    }>
  | Readonly<{
      state:
        | 'waiting-for-provider'
        | 'provider-succeeded-awaiting-import'
        | 'provider-failed';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      assignment: ProviderRoleAssignment;
      ownerInvestigationId: string;
      invocationId: string;
      failure: ProviderInvocationRecord['failure'];
    }>
  | Readonly<{
      state: 'caller-supplied-awaiting-import' | 'patch-imported';
      sessionId: string;
      subject: TaskStrategyImplementationSubject;
      assignment: ProviderRoleAssignment | GrantedRoleAssignment;
      ownerInvestigationId: string | null;
      invocationId: string | null;
      failure: null;
    }>;
/** Binds implementation admission without observing a repository at construction. */
export function createTaskStrategyImplementationLifecycle(
  operations: TaskStrategyImplementationOperations,
  roleAdmission: Pick<
    RoleAdmissionServices,
    'admitRoleResult' | 'authorizeGrantedOrdinaryRole'
  >,
  taskMandate: Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >,
) {
  const context = createTaskStrategyImplementationContext(operations);

  const {
    implementationResultStale,
    renderStatus,
    requireCurrentRedTransaction,
    implementationTask,
    resolveCurrentImplementationSubject,
    assertReservationCurrent,
    requestConflict,
  } = context;

  const callerAdmission = createTaskStrategyCallerAdmission(
    roleAdmission,
    operations,
    context,
  );

  const { renderCallerImplementationStatus } = callerAdmission;

  const providerReservations = createTaskStrategyProviderReservations(
    roleAdmission,
    operations,
    context,
    callerAdmission,
    taskMandate,
  );

  const {
    createImplementationReservation,
    reserveProviderRetryAttempt,
    ensureProviderInvocation,
  } = providerReservations;

  const providerResults = createTaskStrategyProviderResults(
    roleAdmission,
    operations,
    context,
  );

  const {
    ensureProviderCorrectionRoundReservation,
    providerCorrectionRoundNeedsReconciliation,
    reconcileProviderImplementationResult,
  } = providerResults;

  function beginTaskStrategyImplementation(
    readProviderRetryAccountingEvidence: ProviderRetryAccountingReader,
    cwd: string,
    requestedSessionId: string,
    options: BeginTaskStrategyImplementationOptions = {},
  ): TaskStrategyImplementationStatus {
    const initial = operations.session.loadActive(cwd, requestedSessionId);
    return operations.locks.repository(initial.runtime, (assertOwned) =>
      operations.locks.session(initial.runtime, requestedSessionId, () => {
        assertOwned();
        const context = operations.session.loadActive(cwd, requestedSessionId);
        const runtime = operations.observeJournal(cwd);
        const transaction = requireCurrentRedTransaction(cwd, context);
        // Older sealed RED records embedded the exact evidence node before the
        // content-addressed object store became a scheduling dependency. Only
        // this mutating transition may publish those same verified bytes;
        // inspection and owner-currentness checks remain strictly read-only.
        runtime.evidence.write(transaction.red.evidenceNode);
        const task = implementationTask(cwd, context, transaction);
        const current = resolveCurrentImplementationSubject(
          cwd,
          context,
          transaction,
        );
        const subject = current.subject;
        if (transaction.strategy === 'tdd-single-agent') {
          return Object.freeze({
            state: 'provider-not-required' as const,
            sessionId: context.session.sessionId,
            subject,
          });
        }
        const existing = runtime.implementation.readReservation(
          context.session.sessionId,
          subject.subjectDigest,
        );
        const created =
          existing ??
          createImplementationReservation(
            context,
            runtime,
            transaction,
            subject,
            current.greenFailureRecord,
            task,
            options.collaborationGrant,
            options.testCrashAfter,
            assertOwned,
          );
        if (!('recordDigest' in created)) return created;
        assertReservationCurrent(context, transaction, subject, created);
        ensureProviderCorrectionRoundReservation(
          runtime,
          transaction,
          created,
          current.greenFailureRecord,
        );
        let attempt = runtime.implementation.readCurrentAttempt(created);
        if (
          options.retryProviderFailure === true &&
          runtime.provider.exists(attempt.request.invocationId) &&
          runtime.provider.read(attempt.request.invocationId).state === 'failed'
        ) {
          const retry = reserveProviderRetryAttempt(
            context,
            runtime,
            created,
            attempt,
            options,
            assertOwned,
            readProviderRetryAccountingEvidence,
          );
          if ('state' in retry) return retry;
          attempt = retry;
        }
        ensureProviderInvocation(context, runtime, attempt, assertOwned);
        assertOwned();
        const status = renderStatus(runtime, created, attempt);
        return status.state === 'provider-succeeded-awaiting-import' ||
          (status.state === 'patch-imported' &&
            providerCorrectionRoundNeedsReconciliation(
              runtime,
              transaction,
              created,
            ))
          ? reconcileProviderImplementationResult(
              cwd,
              context,
              runtime,
              transaction,
              created,
              attempt,
              options,
              assertOwned,
            )
          : status;
      }),
    );
  }

  function inspectTaskStrategyImplementation(
    cwd: string,
    requestedSessionId: string,
  ): TaskStrategyImplementationStatus {
    const context = operations.session.loadActive(cwd, requestedSessionId);
    const runtime = operations.observeJournal(cwd);
    const transaction = requireCurrentRedTransaction(cwd, context);
    const subject = resolveCurrentImplementationSubject(
      cwd,
      context,
      transaction,
    ).subject;
    if (transaction.strategy === 'tdd-single-agent') {
      return Object.freeze({
        state: 'provider-not-required' as const,
        sessionId: context.session.sessionId,
        subject,
      });
    }
    const reservation = runtime.implementation.readReservation(
      context.session.sessionId,
      subject.subjectDigest,
    );
    if (reservation === null) {
      const callerReservation = runtime.implementation.readCallerReservation(
        context.session.sessionId,
        subject.subjectDigest,
      );
      const callerBinding = runtime.implementation.readCallerResult(
        context.session.sessionId,
        subject.subjectDigest,
      );
      if (callerReservation !== null || callerBinding !== null) {
        if (callerReservation === null) throw implementationResultStale();
        runtime.implementation.assertCallerReservationCurrent(
          transaction,
          subject,
          callerReservation,
        );
        if (callerBinding !== null) {
          runtime.implementation.assertCallerCurrent(
            transaction,
            subject,
            callerReservation,
            callerBinding,
          );
        }
        return renderCallerImplementationStatus(
          runtime,
          subject,
          callerReservation,
          callerBinding,
        );
      }
      return Object.freeze({
        state: 'ready' as const,
        sessionId: context.session.sessionId,
        subject,
      });
    }
    assertReservationCurrent(context, transaction, subject, reservation);
    const attempt = runtime.implementation.readCurrentAttempt(reservation);
    if (!runtime.provider.exists(attempt.request.invocationId)) {
      return Object.freeze({
        state: 'reservation-persisted' as const,
        sessionId: context.session.sessionId,
        subject,
      });
    }
    return renderStatus(runtime, reservation, attempt);
  }

  function assertTaskStrategyImplementationProviderOwnerCurrent(
    cwd: string,
    requestedInvocationId: string,
  ): TaskStrategyImplementationReservation {
    const runtime = operations.observeJournal(cwd);
    const invocation = runtime.provider.read(requestedInvocationId);
    const manifest = runtime.provider.readManifest(requestedInvocationId);
    const request = runtime.provider.readRequest(requestedInvocationId);
    if (manifest.kind !== 'task-strategy-implementation-manifest') {
      throw requestConflict();
    }
    const context = operations.session.loadActive(
      cwd,
      manifest.subject.sessionId,
    );
    const transaction = requireCurrentRedTransaction(cwd, context);
    const subject = resolveCurrentImplementationSubject(
      cwd,
      context,
      transaction,
    ).subject;
    const reservation = runtime.implementation.readReservation(
      manifest.subject.sessionId,
      subject.subjectDigest,
    );
    if (reservation === null) throw requestConflict();
    assertReservationCurrent(context, transaction, subject, reservation);
    if (
      invocation.investigationId !== reservation.ownerInvestigationId ||
      canonicalJson(invocation.mandateBinding ?? null) !==
        canonicalJson(reservation.mandateBinding) ||
      canonicalJson(manifest) !== canonicalJson(reservation.manifest) ||
      (invocation.attempt === 1 &&
        invocation.invocationId !== reservation.request.invocationId)
    ) {
      throw requestConflict();
    }
    const attempt = runtime.implementation.readAttempt(
      reservation,
      invocation.invocationId,
    );
    const current = runtime.implementation.readCurrentAttempt(reservation);
    if (
      canonicalJson(request) !== canonicalJson(attempt.request) ||
      current.request.invocationId !== attempt.request.invocationId
    ) {
      throw requestConflict();
    }
    return taskStrategyImplementationReservationForAttempt(attempt);
  }
  return {
    beginTaskStrategyImplementation,
    inspectTaskStrategyImplementation,
    assertTaskStrategyImplementationProviderOwnerCurrent,
  };
}
export type TaskStrategyImplementationLifecycle = ReturnType<
  typeof createTaskStrategyImplementationLifecycle
>;
