import type { TaskMandateProviderAdmission } from '../../modules/authority/task-mandate-access-contract.ts';

import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
/**
 * Starts and inspects implementation runs and verifies their current
 * provider ownership.
 *
 * Invariants:
 * - Provider ownership must match the current implementation reservation
 *   and manifest.
 */
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';

import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  parseAiAdapterPolicyDocument,
} from '../../runtime/provider-execution/ai-adapter-policy.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { type CollaborationGrantRequest } from '../../modules/authority/collaboration-grant-codec.ts';

import { consumeCollaborationGrantUnderLifecycleLock } from '../../runtime/storage-journal/collaboration-grant-consumption.ts';
import { inspectCollaborationGrantsUnderLifecycleLock } from '../../runtime/storage-journal/collaboration-grant-records.ts';
import {
  readReservedCollaborationGrantUnderLifecycleLock,
  reserveCollaborationGrantUnderLifecycleLock,
} from '../../runtime/storage-journal/collaboration-grant-reservation.ts';
import { type CollaborationGrantUseProjection } from '../../modules/authority/collaboration-grant-records.ts';

import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';

import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../../runtime/storage-journal/evidence-object-store.ts';

import { previewExactStaging } from '../../runtime/repository-transaction/git-transitions.ts';

import { runGit } from '../../runtime/repository-transaction/git.ts';

import {
  loadActiveSessionContext,
  loadInvestigationRuntimeContext,
} from '../../composition-root/lifecycle-context.ts';

import {
  createProviderInvocation,
  createProviderRetryReservation,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from '../../runtime/storage-journal/provider-invocation-store.ts';

import type { ProviderRetryDecisionBinding } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';

import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

import {
  type GrantedRoleAssignment,
  type ProviderRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';

import {
  withRepositoryLifecycleOperation,
  withSessionOperation,
} from '../../runtime/session-workspace/session-store.ts';

import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';

import {
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  readTaskStrategyGreenFailureRecord,
} from '../../runtime/storage-journal/task-strategy-correction-store.ts';

import type { TaskStrategyGreenFailureRecord } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';

import {
  listTaskStrategyCorrectionRounds,
  publishTaskStrategyCorrectionRoundImport,
  publishTaskStrategyCorrectionRoundResult,
  readTaskStrategyCorrectionRound,
  reserveTaskStrategyCorrectionRound,
  type TaskStrategyCorrectionReservationAuthority,
  type TaskStrategyCorrectionResultAuthority,
} from '../../runtime/storage-journal/task-strategy-correction-round-store.ts';

import {
  assertTaskStrategyCallerImplementationAuthorityCurrent,
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  createTaskStrategyCallerImplementationBinding,
  createTaskStrategyCallerImplementationReservation,
  createTaskStrategyImplementationResultBinding,
  createTaskStrategyImplementationReservation,
  readCurrentTaskStrategyImplementationProviderAttempt,
  readTaskStrategyImplementationProviderAttempt,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyImplementationReservation,
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
  type TaskStrategyCallerImplementationBinding,
  type TaskStrategyCallerImplementationReservation,
  type TaskStrategyImplementationResultBinding,
  type TaskStrategyImplementationReservation,
  type TaskStrategyImplementationProviderAttempt,
} from '../../runtime/storage-journal/task-strategy-provider-store.ts';

import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
} from '../../runtime/storage-journal/task-strategy-patch-store.ts';

import { readTaskStrategyTransaction } from '../../runtime/storage-journal/task-strategy-store.ts';

import { createTaskStrategyImplementationContext } from './task-strategy-implementation-context.ts';

import { createTaskStrategyCallerAdmission } from './task-strategy-caller-admission.ts';

import { createTaskStrategyProviderReservations } from './task-strategy-provider-reservations.ts';

import { createTaskStrategyProviderResults } from './task-strategy-provider-results.ts';

// Production observations stay anchored at the existing lifecycle boundary.
const runtime = {
  loadInvestigationRuntimeContext,
  taskStrategyImplementationReservationForAttempt,
  readProviderInvocation,
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyPatchCurrentBinding,
  assertTaskStrategyImplementationProviderAuthorityCurrent,
  loadActiveSessionContext,
  readTaskStrategyTransaction,
  previewExactStaging,
  listTaskStrategyCorrectionRounds,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyPatchRecord,
  readTaskStrategyGreenFailureRecord,
  runGit,
  parseAiAdapterPolicyDocument,
  readTaskStrategyCallerImplementationReservation,
  inspectCollaborationGrantsUnderLifecycleLock,
  reserveCollaborationGrantUnderLifecycleLock,
  readReservedCollaborationGrantUnderLifecycleLock,
  createEvidenceNode,
  writeEvidenceNode,
  createTaskStrategyCallerImplementationReservation,
  assertTaskStrategyCallerImplementationReservationAuthorityCurrent,
  consumeCollaborationGrantUnderLifecycleLock,
  createTaskStrategyCallerImplementationBinding,
  assertTaskStrategyCallerImplementationAuthorityCurrent,
  reserveTaskStrategyCorrectionRound,
  DEFAULT_TASK_STRATEGY_CORRECTION_POLICY,
  publishTaskStrategyCorrectionRoundResult,
  publishTaskStrategyCorrectionRoundImport,
  providerInvocationManifestDigest,
  storeProviderExecutionPolicySnapshot,
  createTaskStrategyImplementationReservation,
  readEvidenceNode,
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  createProviderRetryReservation,
  readCurrentTaskStrategyImplementationProviderAttempt,
  providerInvocationExists,
  readProviderInvocationRequest,
  readProviderInvocationManifest,
  createProviderInvocation,
  readTaskStrategyCorrectionRound,
  taskStrategyImplementationProviderAttemptReservationDigest,
  createTaskStrategyImplementationResultBinding,
};

export type TaskStrategyImplementationRuntimeBindings = typeof runtime;

export type TaskStrategyImplementationRuntimeData = {
  TaskStrategyImplementationReservation: TaskStrategyImplementationReservation;
  TaskStrategyImplementationProviderAttempt: TaskStrategyImplementationProviderAttempt;
  TaskStrategyGreenFailureRecord: TaskStrategyGreenFailureRecord;
  TaskStrategyCallerImplementationReservation: TaskStrategyCallerImplementationReservation;
  TaskStrategyCorrectionReservationAuthority: TaskStrategyCorrectionReservationAuthority;
  TaskStrategyCallerImplementationBinding: TaskStrategyCallerImplementationBinding;
  TaskStrategyCorrectionResultAuthority: TaskStrategyCorrectionResultAuthority;
  ProviderRetryDecisionBinding: ProviderRetryDecisionBinding;
  TaskStrategyImplementationResultBinding: TaskStrategyImplementationResultBinding;
  CollaborationGrantUseProjection: CollaborationGrantUseProjection;
};

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
      failure: ReturnType<typeof readProviderInvocation>['failure'];
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
  routingAdmissionReader: ChangeRoutingAdmissionReader,
  roleAdmission: Pick<
    RoleAdmissionServices,
    'admitRoleResult' | 'authorizeGrantedOrdinaryRole'
  >,
  taskMandate: Pick<
    TaskMandateProviderAdmission,
    'authorizeTaskMandateProviderReservationUnderLifecycleLock'
  >,
) {
  const context = createTaskStrategyImplementationContext(
    routingAdmissionReader,
    runtime,
  );

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
    routingAdmissionReader,
    roleAdmission,
    runtime,
    context,
  );

  const { renderCallerImplementationStatus } = callerAdmission;

  const providerReservations = createTaskStrategyProviderReservations(
    roleAdmission,
    runtime,
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
    routingAdmissionReader,
    roleAdmission,
    runtime,
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
    const initial = loadActiveSessionContext(cwd, requestedSessionId);
    return withRepositoryLifecycleOperation(initial.runtime, (assertOwned) =>
      withSessionOperation(initial.runtime, requestedSessionId, () => {
        assertOwned();
        const context = loadActiveSessionContext(cwd, requestedSessionId);
        const runtime = loadInvestigationRuntimeContext(cwd).runtime;
        const transaction = requireCurrentRedTransaction(cwd, context);
        // Older sealed RED records embedded the exact evidence node before the
        // content-addressed object store became a scheduling dependency. Only
        // this mutating transition may publish those same verified bytes;
        // inspection and owner-currentness checks remain strictly read-only.
        writeEvidenceNode(runtime, transaction.red.evidenceNode);
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
        const existing = readTaskStrategyImplementationReservation(
          runtime,
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
        let attempt = readCurrentTaskStrategyImplementationProviderAttempt(
          runtime,
          created,
        );
        if (
          options.retryProviderFailure === true &&
          providerInvocationExists(runtime, attempt.request.invocationId) &&
          readProviderInvocation(runtime, attempt.request.invocationId)
            .state === 'failed'
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
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
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
    const reservation = readTaskStrategyImplementationReservation(
      runtime,
      context.session.sessionId,
      subject.subjectDigest,
    );
    if (reservation === null) {
      const callerReservation = readTaskStrategyCallerImplementationReservation(
        runtime,
        context.session.sessionId,
        subject.subjectDigest,
      );
      const callerBinding = readTaskStrategyCallerImplementationBinding(
        runtime,
        context.session.sessionId,
        subject.subjectDigest,
      );
      if (callerReservation !== null || callerBinding !== null) {
        if (callerReservation === null) throw implementationResultStale();
        assertTaskStrategyCallerImplementationReservationAuthorityCurrent(
          runtime,
          transaction,
          subject,
          callerReservation,
        );
        if (callerBinding !== null) {
          assertTaskStrategyCallerImplementationAuthorityCurrent(
            runtime,
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
    const attempt = readCurrentTaskStrategyImplementationProviderAttempt(
      runtime,
      reservation,
    );
    if (!providerInvocationExists(runtime, attempt.request.invocationId)) {
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
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const invocation = readProviderInvocation(runtime, requestedInvocationId);
    const manifest = readProviderInvocationManifest(
      runtime,
      requestedInvocationId,
    );
    const request = readProviderInvocationRequest(
      runtime,
      requestedInvocationId,
    );
    if (manifest.kind !== 'task-strategy-implementation-manifest') {
      throw requestConflict();
    }
    const context = loadActiveSessionContext(cwd, manifest.subject.sessionId);
    const transaction = requireCurrentRedTransaction(cwd, context);
    const subject = resolveCurrentImplementationSubject(
      cwd,
      context,
      transaction,
    ).subject;
    const reservation = readTaskStrategyImplementationReservation(
      runtime,
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
    const attempt = readTaskStrategyImplementationProviderAttempt(
      runtime,
      reservation,
      invocation.invocationId,
    );
    const current = readCurrentTaskStrategyImplementationProviderAttempt(
      runtime,
      reservation,
    );
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
