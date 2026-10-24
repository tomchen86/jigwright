/** Coordinates ordinary and Grant-authorized finalization recovery and cancellation. */
import { type TaskDiffReviewCompletionOperations } from '../../modules/lifecycle/task-diff-review-contracts.ts';
import type {
  FinalizeCancellationOptions,
  FinalizeCancellationResult,
  ProtectedFinalizeRecoveryContext,
  TaskDiffReviewReplayOptions,
  FinalizeRecoveryStatus,
} from '../../modules/lifecycle/finalization.ts';
import {
  type ProtectedTaskApplyRecoveryParametersV1,
  type ProtectedTaskApplyRecoveryAuthorizationBinding,
  assertProtectedTaskApplyRecoveryParameters,
  assertProtectedTaskApplyRecoveryAuthorization,
  protectedTaskApplyRecoveryGrantRequired,
} from '../../modules/authority/protected-task-apply-recovery-grant.ts';
import { grantSha256 } from '../../modules/authority/grant-primitives.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertFinalizeCancellationReason,
  assertCancellationRequest,
  assertProtectedFinalizeRecoveryContext,
  cancellationResult,
  invalidFinalizeCancellation,
  assertFinalizeTransactionMatchesSession,
} from '../../modules/lifecycle/finalization.ts';
import {
  runSessionOperation,
  getSession,
} from '../repository-observation/workflow-session-context.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import {
  readFinalizeCancellation,
  publishFinalizeCancellation,
  markFinalizeProjectionRestored,
  completeFinalizeCancellation,
} from '../storage-journal/finalize-cancellation.ts';
import {
  readFinalizeTransaction,
  removeFinalizeTransaction,
} from '../storage-journal/finalize-transaction.ts';
import {
  createFinalizeCancellation,
  type FinalizeCancellation,
} from '../../modules/lifecycle/finalize-cancellation.ts';
import { restoreFinalizeTransactionProjection } from './projected-finalization.ts';
import { type FinalizeTransaction } from '../../modules/lifecycle/finalize-transaction.ts';

export function cancelFinalizeRecovery(
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    'assertTaskDiffReviewCompletionGateSatisfied'
  >,
  cwd: string,
  requestedSessionId: string,
  transactionId: string,
  reason: string,
  options: FinalizeCancellationOptions = {},
): FinalizeCancellationResult {
  return cancelFinalizeRecoveryInternal(
    taskDiffReview,
    cwd,
    requestedSessionId,
    transactionId,
    reason,
    options,
    null,
  );
}

export function cancelProtectedTaskApplyRecoveryUnderGrant(
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    'assertTaskDiffReviewCompletionGateSatisfied'
  >,
  cwd: string,
  candidate: ProtectedTaskApplyRecoveryParametersV1,
  candidateAuthorization: ProtectedTaskApplyRecoveryAuthorizationBinding,
  assertLifecycleOwned: () => void,
): FinalizeCancellationResult {
  const parameters = assertProtectedTaskApplyRecoveryParameters(candidate);
  const authorization = assertProtectedTaskApplyRecoveryAuthorization(
    candidateAuthorization,
  );
  if (
    authorization.parentChallengeId !== parameters.parentChallengeId ||
    authorization.parentOperationId !== parameters.parentOperationId ||
    authorization.parentApprovalSubjectDigest !==
      parameters.parentApprovalSubjectDigest ||
    authorization.parentStateBindingDigest !==
      parameters.parentStateBindingDigest ||
    authorization.parentParametersDigest !==
      parameters.parentParametersDigest ||
    authorization.action !== parameters.action ||
    authorization.stateBindingDigest !== parameters.stateBindingDigest ||
    authorization.parametersDigest !== grantSha256(canonicalJson(parameters))
  ) {
    throw workflowError(
      'PROTECTED_TASK_APPLY_RECOVERY_AUTHORIZATION_INVALID',
      'Protected task Apply recovery authorization does not bind the exact transition.',
      ExitCode.guard,
    );
  }
  return cancelFinalizeRecoveryInternal(
    taskDiffReview,
    cwd,
    parameters.sessionId,
    parameters.transactionId,
    parameters.reason,
    {},
    Object.freeze({ parameters, authorization, assertLifecycleOwned }),
  );
}

function cancelFinalizeRecoveryInternal(
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    'assertTaskDiffReviewCompletionGateSatisfied'
  >,
  cwd: string,
  requestedSessionId: string,
  transactionId: string,
  reason: string,
  options: FinalizeCancellationOptions,
  protectedRecovery: ProtectedFinalizeRecoveryContext | null,
): FinalizeCancellationResult {
  assertFinalizeCancellationReason(reason);
  return runSessionOperation(cwd, requestedSessionId, () => {
    protectedRecovery?.assertLifecycleOwned();
    const session = getSession(cwd, requestedSessionId);
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const archived = readFinalizeCancellation(runtime.root, transactionId);
    if (archived?.phase === 'completed') {
      assertCancellationRequest(archived, session, git, transactionId, reason);
      if (archived.transaction.protectedApply !== undefined) {
        assertProtectedFinalizeRecoveryContext(
          archived.transaction,
          protectedRecovery,
          reason,
        );
      }
      removeCancelledActiveTransaction(runtime.root, archived);
      return cancellationResult(archived);
    }
    const transaction = readFinalizeTransaction(
      runtime.root,
      session.sessionId,
    );
    if (transaction === null || transaction.transactionId !== transactionId) {
      throw invalidFinalizeCancellation(
        'The requested ambiguous finalize transaction is not active.',
      );
    }
    if (transaction.protectedApply !== undefined) {
      if (protectedRecovery === null) {
        throw protectedTaskApplyRecoveryGrantRequired({
          action: 'cancel',
          changeId: transaction.changeId,
          taskId: transaction.taskId,
          sessionId: transaction.sessionId,
          transactionId: transaction.transactionId,
          transactionDigest: transaction.recordDigest,
          transactionPhase: transaction.phase,
          protectedApply: transaction.protectedApply,
          reason,
        });
      }
      assertProtectedFinalizeRecoveryContext(
        transaction,
        protectedRecovery,
        reason,
      );
    } else if (protectedRecovery !== null) {
      throw invalidFinalizeCancellation(
        'Protected Apply recovery does not own this finalize transaction.',
      );
    }
    assertFinalizeTransactionMatchesSession(transaction, session, git);
    let cancellation = archived;
    if (cancellation === null) {
      if (
        protectedRecovery === null &&
        transaction.phase !== 'checks-running' &&
        !isAuthenticatedCheckedFinalizeCancellation(
          taskDiffReview,
          cwd,
          session.sessionId,
          transaction,
          options,
        )
      ) {
        throw invalidFinalizeCancellation(
          'The requested finalize transaction is not cancellable.',
        );
      }
      cancellation = publishFinalizeCancellation(
        runtime.root,
        createFinalizeCancellation(
          transaction,
          reason,
          new Date().toISOString(),
        ),
      );
      protectedRecovery?.assertLifecycleOwned();
      maybeInterruptFinalizeCancellation(options, 'cancellation-requested');
    } else {
      assertCancellationRequest(
        cancellation,
        session,
        git,
        transactionId,
        reason,
      );
    }
    if (cancellation.phase === 'requested') {
      restoreFinalizeTransactionProjection(cwd, transaction, cancellation);
      cancellation = markFinalizeProjectionRestored(runtime.root, cancellation);
      protectedRecovery?.assertLifecycleOwned();
      maybeInterruptFinalizeCancellation(options, 'projection-restored');
    }
    if (cancellation.phase === 'projection-restored') {
      cancellation = completeFinalizeCancellation(
        runtime.root,
        cancellation,
        new Date().toISOString(),
      );
      protectedRecovery?.assertLifecycleOwned();
      maybeInterruptFinalizeCancellation(options, 'cancellation-completed');
    }
    removeCancelledActiveTransaction(runtime.root, cancellation);
    protectedRecovery?.assertLifecycleOwned();
    return cancellationResult(cancellation);
  });
}

export function inspectFinalizeRecoveryStatus(
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    'assertTaskDiffReviewCompletionGateSatisfied'
  >,
  cwd: string,
  requestedSessionId: string,
  options: TaskDiffReviewReplayOptions = {},
): FinalizeRecoveryStatus | null {
  const session = getSession(cwd, requestedSessionId);
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  if (transaction === null) return null;
  assertFinalizeTransactionMatchesSession(transaction, session, git);
  if (transaction.protectedApply !== undefined) {
    return {
      state:
        transaction.phase === 'completed' ? 'completed' : 'recovery-required',
      transactionId: transaction.transactionId,
      phase: transaction.phase,
      retrySafe: transaction.phase !== 'checks-running',
      recoveryCommand: `pnpm workflow grant human recover ${transaction.protectedApply.challengeId} --json`,
    };
  }
  if (transaction.phase === 'checks-running') {
    return {
      state: 'recovery-required',
      transactionId: transaction.transactionId,
      phase: transaction.phase,
      retrySafe: false,
      recoveryCommand:
        `pnpm workflow finalize-recover ${session.sessionId} ` +
        `--cancel ${transaction.transactionId} --reason <text> --json`,
    };
  }
  if (
    isAuthenticatedCheckedFinalizeCancellation(
      taskDiffReview,
      cwd,
      session.sessionId,
      transaction,
      options,
    )
  ) {
    return {
      state: 'recovery-required',
      transactionId: transaction.transactionId,
      phase: transaction.phase,
      retrySafe: false,
      recoveryCommand:
        `pnpm workflow finalize-recover ${session.sessionId} ` +
        `--cancel ${transaction.transactionId} --reason <text> --json`,
    };
  }
  return {
    state: transaction.phase === 'completed' ? 'completed' : 'in-progress',
    transactionId: transaction.transactionId,
    phase: transaction.phase,
    retrySafe: true,
    recoveryCommand: `pnpm workflow finalize-recover ${session.sessionId} --json`,
  };
}

function isAuthenticatedCheckedFinalizeCancellation(
  taskDiffReview: Pick<
    TaskDiffReviewCompletionOperations,
    'assertTaskDiffReviewCompletionGateSatisfied'
  >,
  cwd: string,
  sessionId: string,
  transaction: FinalizeTransaction,
  options: TaskDiffReviewReplayOptions,
): boolean {
  if (transaction.phase !== 'checked' || transaction.candidateTree === null) {
    return false;
  }
  try {
    taskDiffReview.assertTaskDiffReviewCompletionGateSatisfied(cwd, sessionId, {
      projectedTaskIds: transaction.completedTaskIds,
      projectionSourceDigest: transaction.projectionSourceDigest,
      authorizedTransitionPaths: transaction.transitionPaths,
      transactionId: transaction.transactionId,
      candidateTree: transaction.candidateTree,
      ...(options.consumedRoleResultReplay === undefined
        ? {}
        : {
            consumedRoleResultReplay: options.consumedRoleResultReplay,
          }),
    });
    return false;
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    if (error.code === 'TASK_DIFF_REVIEW_CHANGES_REQUIRED') return true;
    if (
      ['TASK_DIFF_REVIEW_REQUIRED', 'TASK_DIFF_REVIEW_CHALLENGE_OPEN'].includes(
        error.code,
      )
    ) {
      return false;
    }
    throw error;
  }
}

function removeCancelledActiveTransaction(
  runtimeRoot: string,
  cancellation: FinalizeCancellation,
): void {
  const active = readFinalizeTransaction(
    runtimeRoot,
    cancellation.transaction.sessionId,
  );
  if (active === null) return;
  if (JSON.stringify(active) === JSON.stringify(cancellation.transaction)) {
    removeFinalizeTransaction(runtimeRoot, active);
  }
}

function maybeInterruptFinalizeCancellation(
  options: FinalizeCancellationOptions,
  phase: FinalizeCancellationOptions['testCrashAfter'],
): void {
  if (options.testCrashAfter === phase) {
    throw new Error(`Simulated finalize cancellation after ${String(phase)}.`);
  }
}
