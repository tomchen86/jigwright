import type { TaskStrategyImplementationOperations } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationSession } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyImplementationJournal } from './task-strategy-implementation-operations.ts';
import type { TaskStrategyTransaction } from '../../modules/assurance/task-strategy-evidence.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { taskStrategyImplementationReservationForAttempt } from '../../modules/assurance/task-strategy-implementation-attempt.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { TaskStrategyCorrectionProjection } from '../../modules/assurance/task-strategy-correction-round-record.ts';
import {
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskStrategyImplementationSubject } from '../../modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  type CollaborationGrantRequest,
  type CollaborationGrantExpectedBinding,
  collaborationPolicyDigestForPhase,
} from '../../modules/authority/collaboration-grant-codec.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  type AuthoritativeCollaborationGrantVerifier,
  assertAuthoritativeCollaborationGrantVerifier,
} from '../../modules/authority/grant-verifier-port.ts';
import crypto from 'node:crypto';

import type {
  TaskStrategyRedAuthor,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';

/**
 * Builds implementation subjects, status, and collaboration authority from
 * current RED state.
 *
 * Invariants:
 * - Recorded RED authors must retain provider, session, and principal
 *   identities.
 */

import type { TaskStrategyImplementationReservation } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyImplementationProviderAttempt } from '../../modules/assurance/task-strategy-implementation-record.ts';
import type { TaskStrategyGreenFailureRecord } from '../../modules/provider-orchestration/task-strategy-correction-record.ts';

export function createTaskStrategyImplementationContext(
  operations: Pick<
    TaskStrategyImplementationOperations,
    'session' | 'observeJournal' | 'baseline' | 'dataPolicy'
  >,
) {
  function requireRecordedRedAuthor(
    value: TaskStrategyImplementationReservation['redAuthor'],
  ): TaskStrategyRedAuthor {
    if (
      value.providerId === null ||
      value.sessionId === null ||
      value.principalId === null ||
      value.identityAssurance === 'maintainer-signed' ||
      value.engineSpawned !== false
    ) {
      throw implementationResultStale();
    }
    return Object.freeze({
      providerId: value.providerId,
      sessionId: value.sessionId,
      principalId: value.principalId,
      identityAssurance: value.identityAssurance,
      engineSpawned: false,
    });
  }

  function implementationResultStale() {
    return workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_RESULT_STALE',
      'The provider result no longer matches its exact sealed RED subject, assignment, observation, or patch bytes.',
      ExitCode.staleState,
    );
  }

  function renderStatus(
    runtime: TaskStrategyImplementationJournal,
    root: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
  ): TaskStrategyImplementationStatus {
    if (attempt.root.recordDigest !== root.recordDigest) {
      throw implementationResultStale();
    }
    const reservation =
      taskStrategyImplementationReservationForAttempt(attempt);
    const invocation = runtime.provider.read(reservation.request.invocationId);
    let state:
      | 'waiting-for-provider'
      | 'provider-succeeded-awaiting-import'
      | 'patch-imported'
      | 'provider-failed';
    if (invocation.state === 'succeeded' && invocation.result !== null) {
      const resultBinding = runtime.implementation.readResult(
        reservation.sessionId,
        reservation.subject.subjectDigest,
      );
      const patchBinding = runtime.patch.readCurrentBinding(
        reservation.sessionId,
        reservation.subject.sourceTree,
      );
      if (resultBinding !== null) {
        runtime.implementation.assertProviderCurrent(
          reservation,
          invocation,
          resultBinding,
        );
      }
      state =
        resultBinding !== null &&
        patchBinding !== null &&
        patchBinding.patchDigest === resultBinding.output.patchDigest &&
        patchBinding.candidateTree !== resultBinding.output.sourceTree
          ? 'patch-imported'
          : 'provider-succeeded-awaiting-import';
    } else {
      state =
        invocation.state === 'failed'
          ? 'provider-failed'
          : 'waiting-for-provider';
    }
    if (state === 'patch-imported') {
      return Object.freeze({
        state,
        sessionId: reservation.sessionId,
        subject: reservation.subject,
        assignment: reservation.assignment,
        ownerInvestigationId: reservation.ownerInvestigationId,
        invocationId: reservation.request.invocationId,
        failure: null,
      });
    }
    return Object.freeze({
      state,
      sessionId: reservation.sessionId,
      subject: reservation.subject,
      assignment: reservation.assignment,
      ownerInvestigationId: reservation.ownerInvestigationId,
      invocationId: reservation.request.invocationId,
      failure: invocation.failure,
    });
  }

  function requireCurrentRedTransaction(
    cwd: string,
    context: TaskStrategyImplementationSession,
  ) {
    const runtime = operations.observeJournal(cwd);
    const transaction = runtime.correction.readTransaction(
      context.session.sessionId,
    );
    if (transaction === null) {
      throw workflowError(
        'TASK_STRATEGY_RED_REQUIRED',
        'Task implementation requires an engine-sealed RED transaction.',
        ExitCode.guard,
      );
    }
    const inspection = operations.session.inspectExpected(
      cwd,
      context.session.sessionId,
      context.session,
    );
    const preview = operations.session.previewCandidate(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    );
    const redCandidateCurrent =
      transaction.red.candidateTree === preview.tree &&
      canonicalJson(transaction.red.changedPaths) ===
        canonicalJson(inspection.changedPaths);
    const currentPatchHead =
      operations.session.resolveCorrection(inspection).head;
    const recoverableCorrection = readRecoverableCorrectionCandidate(
      runtime,
      transaction,
      preview.tree,
    );
    const importedCandidateCurrent =
      currentPatchHead !== null &&
      currentPatchHead.record.candidateTree === preview.tree;
    if (
      transaction.changeId !== context.session.changeId ||
      transaction.taskId !== context.session.taskId ||
      transaction.baseline.head !== context.session.baseline.head ||
      transaction.baseline.tree !== context.session.baseline.tree ||
      (!redCandidateCurrent &&
        !importedCandidateCurrent &&
        !recoverableCorrection)
    ) {
      throw workflowError(
        'TASK_STRATEGY_RED_STALE',
        'The sealed RED transaction no longer matches the exact task candidate.',
        ExitCode.staleState,
      );
    }
    return transaction;
  }

  function readRecoverableCorrectionCandidate(
    runtime: TaskStrategyImplementationJournal,
    transaction: TaskStrategyTransaction,
    currentTree: string,
  ): boolean {
    const rounds = runtime.correction.listRounds(
      transaction.sessionId,
      transaction.recordDigest,
    );
    const latest = rounds.at(-1);
    if (latest === undefined || latest.importRecord !== null) {
      return false;
    }
    const binding =
      latest.reservation.authority.kind === 'provider'
        ? runtime.implementation.readResult(
            transaction.sessionId,
            latest.reservation.correctionSubjectDigest,
          )
        : latest.reservation.authority.kind === 'caller-supplied'
          ? runtime.implementation.readCallerResult(
              transaction.sessionId,
              latest.reservation.correctionSubjectDigest,
            )
          : null;
    if (binding === null) return false;
    const patchDigest = binding.output.patchDigest;
    const record = runtime.patch.readRecord(
      transaction.sessionId,
      patchDigest,
      binding.output.sourceTree,
    );
    return record !== null && record.candidateTree === currentTree;
  }

  function implementationTask(
    cwd: string,
    context: TaskStrategyImplementationSession,
    transaction: TaskStrategyTransaction,
  ) {
    const inspection = operations.session.inspectExpected(
      cwd,
      context.session.sessionId,
      context.session,
    );
    const task = inspection.contract.execution?.tasks[context.session.taskId];
    if (
      task === undefined ||
      (task.strategy !== 'cross-agent-tdd' &&
        task.strategy !== 'tdd-single-agent') ||
      task.strategy !== transaction.strategy ||
      sha256(canonicalJson(task)) !== transaction.taskContractDigest
    ) {
      throw workflowError(
        'TASK_STRATEGY_CONTRACT_STALE',
        'The sealed RED transaction no longer matches its reviewed task contract.',
        ExitCode.staleState,
      );
    }
    return task;
  }

  function resolveCurrentImplementationSubject(
    cwd: string,
    context: TaskStrategyImplementationSession,
    transaction: TaskStrategyTransaction,
  ): Readonly<{
    subject: TaskStrategyImplementationSubject;
    greenFailureRecord: TaskStrategyGreenFailureRecord | null;
  }> {
    const initialSubject = createSubject(transaction);
    const inspection = operations.session.inspectExpected(
      cwd,
      context.session.sessionId,
      context.session,
    );
    const projection = operations.session.resolveCorrection(inspection);
    if (projection.transaction.recordDigest !== transaction.recordDigest) {
      throw implementationResultStale();
    }
    if (projection.exhausted) {
      throw workflowError(
        'TASK_STRATEGY_CORRECTION_EXHAUSTED',
        'The bounded task-strategy correction budget is exhausted.',
        ExitCode.guard,
      );
    }
    const correction = resolveCorrectionSubjectInput(inspection, projection);
    if (correction === null) {
      return Object.freeze({
        subject: initialSubject,
        greenFailureRecord: null,
      });
    }
    return Object.freeze({
      subject: createTaskStrategyCorrectionSubject({
        subject: initialSubject,
        round: correction.round,
        greenFailureRecord: correction.greenFailureRecord,
      }),
      greenFailureRecord: correction.greenFailureRecord,
    });
  }

  function resolveCorrectionSubjectInput(
    inspection: SessionInspection,
    projection: TaskStrategyCorrectionProjection,
  ): Readonly<{
    round: number;
    greenFailureRecord: TaskStrategyGreenFailureRecord;
  }> | null {
    if (projection.failure !== null) {
      return Object.freeze({
        round: projection.completedCorrectionRounds + 1,
        greenFailureRecord: projection.failure,
      });
    }
    if (projection.completedCorrectionRounds === 0) return null;
    if (projection.head === null) throw implementationResultStale();
    const runtime = operations.observeJournal(inspection.git.repositoryRoot);
    const greenFailureRecord = runtime.correction.readFailure(
      inspection.session.sessionId,
      projection.head.record.sourceTree,
    );
    if (greenFailureRecord === null) throw implementationResultStale();
    return Object.freeze({
      round: projection.completedCorrectionRounds,
      greenFailureRecord,
    });
  }

  function createSubject(
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

  function recordRedAuthor(
    transaction: TaskStrategyTransaction,
  ): TaskStrategyRedAuthor {
    return Object.freeze({
      providerId: transaction.author.providerId,
      sessionId: transaction.sessionId,
      principalId: `provider:${transaction.author.providerId}`,
      identityAssurance: transaction.author.assurance,
      engineSpawned: false,
    });
  }

  function assertReservationCurrent(
    context: TaskStrategyImplementationSession,
    transaction: TaskStrategyTransaction,
    subject: TaskStrategyImplementationSubject,
    reservation: TaskStrategyImplementationReservation,
  ): void {
    if (
      reservation.sessionId !== context.session.sessionId ||
      reservation.changeId !== context.session.changeId ||
      reservation.taskId !== context.session.taskId ||
      reservation.repositoryRoot !== context.git.repositoryRealPath ||
      reservation.gitCommonDirectory !== context.git.gitCommonDirectory ||
      reservation.branch !== context.session.branch ||
      canonicalJson(reservation.baseline) !==
        canonicalJson(context.session.baseline) ||
      canonicalJson(reservation.mandateBinding) !==
        canonicalJson(context.session.mandateBinding ?? null) ||
      canonicalJson(reservation.subject) !== canonicalJson(subject) ||
      reservation.createdAt !== transaction.createdAt
    ) {
      throw requestConflict();
    }
  }

  function implementationGrantRequest(
    context: TaskStrategyImplementationSession,
    subject: TaskStrategyImplementationSubject,
    redAuthor: TaskStrategyRedAuthor,
    callableProviderIds: readonly ProviderId[],
  ): CollaborationGrantRequest | null {
    const providerId = redAuthor.providerId;
    if (
      providerId === null ||
      (redAuthor.identityAssurance !== 'self-declared' &&
        redAuthor.identityAssurance !== 'runtime-hint' &&
        redAuthor.identityAssurance !== 'adapter-assigned') ||
      callableProviderIds.length !== 1 ||
      callableProviderIds[0] !== providerId
    ) {
      return null;
    }
    return {
      changeId: context.session.changeId,
      taskId: context.session.taskId,
      baselineCommit: context.session.baseline.head,
      baselineTree: context.session.baseline.tree,
      targetDigest: subject.subjectDigest,
      lifecyclePhase: 'task-implementation',
      rolePair: {
        authorRole: 'red-author',
        conflictingRole: 'task-implementer',
      },
      availableActor: {
        kind: 'provider',
        providerId,
        assurance: redAuthor.identityAssurance,
      },
      degradedForm: 'same-provider-fresh-session',
      reason:
        'No session-independent task implementer is enabled for this exact sealed RED subject.',
      ttlMinutes: 30,
      maxUses: 1,
    };
  }

  function collaborationPause(
    sessionId: string,
    subject: TaskStrategyImplementationSubject,
    grantRequest: CollaborationGrantRequest | null,
  ): TaskStrategyImplementationStatus {
    return Object.freeze({
      state: 'collaboration-grant-required' as const,
      sessionId,
      subject,
      inputSchema: Object.freeze({
        schemaVersion: 1 as const,
        kind: 'collaboration-grant-selection' as const,
        lifecyclePhase: 'task-implementation' as const,
        conflictingRole: 'task-implementer' as const,
        grantRequest,
        allowedDegradedForms: Object.freeze(
          grantRequest === null
            ? (['caller-supplied'] as const)
            : (['same-provider-fresh-session'] as const),
        ),
        resumeOption: '--grant <grant-id>' as const,
      }),
    });
  }

  function deriveCollaborationGrantBinding(
    repositoryRoot: string,
    request: CollaborationGrantRequest,
  ): CollaborationGrantExpectedBinding {
    const policy = parseMaintainerPolicy(
      JSON.parse(
        operations.baseline.readDocument(
          repositoryRoot,
          request.baselineCommit,
          'workflow/maintainer-policy.json',
        ),
      ),
    );
    return {
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      policyBlob: operations.baseline.readMaintainerBlob(
        repositoryRoot,
        request.baselineCommit,
      ),
      collaborationPolicyDigest: collaborationPolicyDigestForPhase(
        request.lifecyclePhase,
      ),
      changeId: request.changeId,
      taskId: request.taskId,
      baselineCommit: request.baselineCommit,
      baselineTree: request.baselineTree,
      targetDigest: request.targetDigest,
      lifecyclePhase: request.lifecyclePhase,
      rolePair: request.rolePair,
      availableActor: request.availableActor,
      degradedForm: request.degradedForm,
      reason: request.reason,
    };
  }

  function collaborationTransitionDigest(
    expectedBinding: CollaborationGrantExpectedBinding,
  ): string {
    return sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'collaboration-role-transition',
        expectedBinding,
      }),
    );
  }

  function resolveAuthoritativeCollaborationGrantVerifier(
    candidate: unknown,
  ): AuthoritativeCollaborationGrantVerifier {
    assertAuthoritativeCollaborationGrantVerifier(candidate);
    return candidate;
  }

  function baselineAdapterPolicy(repositoryRoot: string, commit: string) {
    try {
      return operations.dataPolicy.parseCurrentDocument(
        operations.baseline.readDocument(
          repositoryRoot,
          commit,
          'workflow/ai-adapter-policy.json',
        ),
      );
    } catch (error) {
      throw workflowError(
        'TASK_STRATEGY_IMPLEMENTATION_BASELINE_POLICY_INVALID',
        'Task implementation could not verify its baseline adapter policy.',
        ExitCode.staleState,
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  function requestConflict() {
    return workflowError(
      'TASK_STRATEGY_IMPLEMENTATION_REQUEST_CONFLICT',
      'Task implementation provider work differs from its current sealed RED owner.',
      ExitCode.staleState,
    );
  }

  function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function sha256Bytes(value: Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  return {
    requireRecordedRedAuthor,
    implementationResultStale,
    renderStatus,
    requireCurrentRedTransaction,
    implementationTask,
    resolveCurrentImplementationSubject,
    recordRedAuthor,
    assertReservationCurrent,
    implementationGrantRequest,
    collaborationPause,
    deriveCollaborationGrantBinding,
    collaborationTransitionDigest,
    resolveAuthoritativeCollaborationGrantVerifier,
    baselineAdapterPolicy,
    requestConflict,
    sha256,
    sha256Bytes,
  };
}
