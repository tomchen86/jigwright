import type { ChangeRoutingAdmissionReader } from '../../modules/lifecycle/change-routing.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
/**
 * Builds implementation subjects, status, and collaboration authority from
 * current RED state.
 *
 * Invariants:
 * - Recorded RED authors must retain provider, session, and principal
 *   identities.
 */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { inspectSession } from '../session-inspection/session-inspection.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  resolveCurrentTaskStrategyCorrection,
  type TaskStrategyCorrectionProjection,
} from './task-strategy-correction.ts';
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
  TaskStrategyImplementationRuntimeBindings,
  TaskStrategyImplementationRuntimeData,
} from './task-strategy-implementation-lifecycle.ts';
type TaskStrategyImplementationReservation =
  TaskStrategyImplementationRuntimeData['TaskStrategyImplementationReservation'];
type TaskStrategyImplementationProviderAttempt =
  TaskStrategyImplementationRuntimeData['TaskStrategyImplementationProviderAttempt'];
type TaskStrategyGreenFailureRecord =
  TaskStrategyImplementationRuntimeData['TaskStrategyGreenFailureRecord'];
import type {
  TaskStrategyRedAuthor,
  TaskStrategyImplementationStatus,
} from './task-strategy-implementation-lifecycle.ts';
export function createTaskStrategyImplementationContext(
  changeContract: ChangeContractServices,
  runtime: TaskStrategyImplementationRuntimeBindings,
) {
  const {
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
  } = runtime;
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
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    root: TaskStrategyImplementationReservation,
    attempt: TaskStrategyImplementationProviderAttempt,
  ): TaskStrategyImplementationStatus {
    if (attempt.root.recordDigest !== root.recordDigest) {
      throw implementationResultStale();
    }
    const reservation =
      taskStrategyImplementationReservationForAttempt(attempt);
    const invocation = readProviderInvocation(
      runtime,
      reservation.request.invocationId,
    );
    let state:
      | 'waiting-for-provider'
      | 'provider-succeeded-awaiting-import'
      | 'patch-imported'
      | 'provider-failed';
    if (invocation.state === 'succeeded' && invocation.result !== null) {
      const resultBinding = readTaskStrategyImplementationResultBinding(
        runtime,
        reservation.sessionId,
        reservation.subject.subjectDigest,
      );
      const patchBinding = readTaskStrategyPatchCurrentBinding(
        runtime,
        reservation.sessionId,
        reservation.subject.sourceTree,
      );
      if (resultBinding !== null) {
        assertTaskStrategyImplementationProviderAuthorityCurrent(
          runtime,
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
    context: ReturnType<typeof loadActiveSessionContext>,
  ) {
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const transaction = readTaskStrategyTransaction(
      runtime,
      context.session.sessionId,
    );
    if (transaction === null) {
      throw workflowError(
        'TASK_STRATEGY_RED_REQUIRED',
        'Task implementation requires an engine-sealed RED transaction.',
        ExitCode.guard,
      );
    }
    const inspection = inspectSession(
      changeContract,
      cwd,
      context.session.sessionId,
      {
        expectedSession: context.session,
      },
    );
    const preview = previewExactStaging(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      [...inspection.changedPaths],
    );
    const redCandidateCurrent =
      transaction.red.candidateTree === preview.tree &&
      canonicalJson(transaction.red.changedPaths) ===
        canonicalJson(inspection.changedPaths);
    const currentPatchHead =
      resolveCurrentTaskStrategyCorrection(inspection).head;
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
    runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
    currentTree: string,
  ): boolean {
    const rounds = listTaskStrategyCorrectionRounds(
      runtime,
      transaction.sessionId,
      transaction.recordDigest,
    );
    const latest = rounds.at(-1);
    if (latest === undefined || latest.importRecord !== null) {
      return false;
    }
    const binding =
      latest.reservation.authority.kind === 'provider'
        ? readTaskStrategyImplementationResultBinding(
            runtime,
            transaction.sessionId,
            latest.reservation.correctionSubjectDigest,
          )
        : latest.reservation.authority.kind === 'caller-supplied'
          ? readTaskStrategyCallerImplementationBinding(
              runtime,
              transaction.sessionId,
              latest.reservation.correctionSubjectDigest,
            )
          : null;
    if (binding === null) return false;
    const patchDigest = binding.output.patchDigest;
    const record = readTaskStrategyPatchRecord(
      runtime,
      transaction.sessionId,
      patchDigest,
      binding.output.sourceTree,
    );
    return record !== null && record.candidateTree === currentTree;
  }

  function implementationTask(
    cwd: string,
    context: ReturnType<typeof loadActiveSessionContext>,
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  ) {
    const inspection = inspectSession(
      changeContract,
      cwd,
      context.session.sessionId,
      {
        expectedSession: context.session,
      },
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
    context: ReturnType<typeof loadActiveSessionContext>,
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
  ): Readonly<{
    subject: TaskStrategyImplementationSubject;
    greenFailureRecord: TaskStrategyGreenFailureRecord | null;
  }> {
    const initialSubject = createSubject(transaction);
    const inspection = inspectSession(
      changeContract,
      cwd,
      context.session.sessionId,
      {
        expectedSession: context.session,
      },
    );
    const projection = resolveCurrentTaskStrategyCorrection(inspection);
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
    inspection: ReturnType<typeof inspectSession>,
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
    const runtime = loadInvestigationRuntimeContext(
      inspection.git.repositoryRoot,
    ).runtime;
    const greenFailureRecord = readTaskStrategyGreenFailureRecord(
      runtime,
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
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
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
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
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
    context: ReturnType<typeof loadActiveSessionContext>,
    transaction: NonNullable<ReturnType<typeof readTaskStrategyTransaction>>,
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
    context: ReturnType<typeof loadActiveSessionContext>,
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
        runGit(repositoryRoot, [
          'show',
          `${request.baselineCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    return {
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${request.baselineCommit}:workflow/maintainer-policy.json`,
      ]).trim(),
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
      return parseAiAdapterPolicyDocument(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/ai-adapter-policy.json`,
        ]),
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
