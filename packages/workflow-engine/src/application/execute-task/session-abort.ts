/**
 * Aborts an active task session and releases the locks and publications it
 * took, including the protected recovery path that runs under a Grant.
 *
 * Invariants:
 * - Lock release order and publication rollback match the start path exactly.
 */
import type { StableValidatedChangeContractLoader } from '../../modules/assurance/validated-change-contract.ts';
import path from 'node:path';
import { loadWorkflowConfig } from '../../runtime/workflow-configuration/workflow-configuration.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { discoverRepository } from '../../runtime/repository-transaction/git.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  readSessionFile,
  releaseOwnedLock,
  releaseTaskSessionIsolationLeases,
  runtimePaths,
  type TaskSessionIsolationBinding,
  type WorkflowSession,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  writeJsonAtomic,
} from '../../runtime/session-workspace/session-store.ts';
import { type TaskAuthorizationRequirement } from '../../adapters/consumer/repository/work-registry/task-authorization-policy.ts';
import {
  completeTaskRevisionAbort,
  prepareTaskRevisionAbort,
} from '../revise/task-revision.ts';
import {
  assertProtectedTaskApplyRecoveryParameters,
  protectedTaskApplyRecoveryGrantRequired,
  type ProtectedTaskApplyRecoveryParametersV1,
} from '../../modules/authority/protected-task-apply-recovery-grant.ts';
import { protectedTaskApplyDescendantSettlementGrantRequired } from '../../modules/authority/protected-task-apply-descendant-settlement-grant.ts';
import { inspectPreparedGrantDescendants } from '../../modules/authority/grant-coordinator.ts';
import {
  readActiveFinalizeTransaction,
  readProtectedFinalizeCancellation,
} from '../finalize/finalize-cancellation.ts';

/**
 * Admits, publishes, inspects, and aborts task execution sessions.
 *
 * Invariants:
 * - A task session cannot start from detached HEAD.
 */

export type SessionStartOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  testHooks?: Readonly<{
    beforeIsolationLeasePublication?: (
      input: Readonly<{
        index: number;
        leasePath: string;
      }>,
    ) => void;
    afterSessionPublication?: (
      input: Readonly<{
        sessionPath: string;
      }>,
    ) => void;
  }>;
}>;

export type TaskSessionPreflightV1 = Readonly<{
  schemaVersion: 1;
  kind: 'task-session-preflight.v1';
  authority: 'advisory';
  status: 'ready' | 'mandate-required';
  changeId: string;
  taskId: string;
  observed: Readonly<{
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string;
    head: string;
    tree: string;
  }>;
  routing: Readonly<{
    role: TaskSessionIsolationBinding['routingRole'];
    worksetDigest: string;
    concurrencyEnabled: boolean;
  }>;
  scope: Readonly<{
    allowedPaths: readonly string[];
    requiredChecks: readonly string[];
    authorization: TaskAuthorizationRequirement;
  }>;
  isolation: TaskSessionIsolationBinding;
  mutationBoundary: Readonly<{
    git: 'read-only';
    runtime: 'read-only';
    grants: 'not-requested';
  }>;
}>;

type ValidatedChangeContract =
  ReturnType<StableValidatedChangeContractLoader>['contract'];

export type { WorkflowSession } from '../../runtime/session-workspace/session-store.ts';

export type {
  SessionCheck,
  SessionCheckOptions,
} from '../finalize/verification.ts';

export function abortSession(
  grantRecordStore: (
    runtimeRoot: string,
  ) => Parameters<typeof inspectPreparedGrantDescendants>[0],
  cwd: string,
  requestedSessionId: string,
  reason: string,
): WorkflowSession {
  if (!reason.trim()) {
    throw workflowError(
      'ABORT_REASON_REQUIRED',
      'Aborting a session requires a non-empty reason.',
      ExitCode.usage,
    );
  }

  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  const initial = readSessionFile(
    path.join(runtime.sessions, `${sessionId}.json`),
  );
  const initialTransaction = readActiveFinalizeTransaction(
    runtime.root,
    sessionId,
  );
  const parentChallengeId =
    initialTransaction?.protectedApply?.challengeId ?? null;
  if (initialTransaction?.protectedApply !== undefined) {
    const descendants = inspectPreparedGrantDescendants(
      grantRecordStore(runtime.root),
      initialTransaction.protectedApply.challengeId,
    );
    if (descendants !== null && descendants.nodes.length > 0) {
      if (
        initialTransaction.phase !== 'checks-running' &&
        initialTransaction.phase !== 'checked'
      ) {
        throw workflowError(
          'PROTECTED_TASK_APPLY_RECOVERY_PHASE_UNSUPPORTED',
          `Protected descendant settlement is not yet implemented for finalize phase ${initialTransaction.phase}.`,
          ExitCode.staleState,
        );
      }
      throw protectedTaskApplyDescendantSettlementGrantRequired({
        action: 'cancel-and-abort',
        changeId: initialTransaction.changeId,
        taskId: initialTransaction.taskId,
        sessionId: initialTransaction.sessionId,
        transactionId: initialTransaction.transactionId,
        transactionDigest: initialTransaction.recordDigest,
        transactionPhase: initialTransaction.phase,
        parentChallengeId: initialTransaction.protectedApply.challengeId,
        parentOperationId: initialTransaction.protectedApply.operationId,
        parentApprovalSubjectDigest:
          initialTransaction.protectedApply.approvalSubjectDigest,
        parentStateBindingDigest:
          initialTransaction.protectedApply.stateBindingDigest,
        parentParametersDigest:
          initialTransaction.protectedApply.parametersDigest,
        preparedDescendantTree: descendants,
        reason: reason.trim(),
      });
    }
  }
  const operation = () =>
    withSessionOperation(runtime, sessionId, () =>
      abortSessionUnlocked(runtime, sessionId, reason),
    );
  return withRepositoryLifecycleOperation(runtime, operation, {
    ...(parentChallengeId === null
      ? {}
      : { allowGrantChallengeIds: [parentChallengeId] }),
  });
}

export function abortSessionAfterProtectedTaskApplyRecoveryUnderGrant(
  cwd: string,
  candidate: ProtectedTaskApplyRecoveryParametersV1,
  assertLifecycleOwned: () => void,
): WorkflowSession {
  const parameters = assertProtectedTaskApplyRecoveryParameters(candidate);
  if (parameters.action !== 'cancel-and-abort') {
    throw workflowError(
      'PROTECTED_TASK_APPLY_RECOVERY_ACTION_INVALID',
      'Only cancel-and-abort recovery can terminate the task session.',
      ExitCode.guard,
    );
  }
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withSessionOperation(runtime, parameters.sessionId, () => {
    assertLifecycleOwned();
    const cancellation = readProtectedFinalizeCancellation(
      runtime.root,
      parameters.sessionId,
      parameters.parentChallengeId,
    );
    if (
      cancellation?.phase !== 'completed' ||
      cancellation.cancelledAt === null ||
      cancellation.transactionId !== parameters.transactionId ||
      cancellation.transaction.recordDigest !== parameters.transactionDigest ||
      cancellation.reason !== parameters.reason ||
      cancellation.transaction.protectedApply?.operationId !==
        parameters.parentOperationId
    ) {
      throw workflowError(
        'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
        'The exact protected finalize cancellation is not complete.',
        ExitCode.staleState,
      );
    }
    if (
      readActiveFinalizeTransaction(runtime.root, parameters.sessionId) !== null
    ) {
      throw workflowError(
        'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
        'The protected finalize transaction remains active after cancellation.',
        ExitCode.staleState,
      );
    }
    const session = readSessionFile(
      path.join(runtime.sessions, `${parameters.sessionId}.json`),
    );
    if (session.state === 'aborted') {
      if (session.abortReason !== parameters.reason) {
        throw workflowError(
          'PROTECTED_TASK_APPLY_RECOVERY_STATE_CHANGED',
          'The task session was aborted for another reason.',
          ExitCode.staleState,
        );
      }
      assertLifecycleOwned();
      releaseAbortedSessionLocks(runtime, session);
      assertLifecycleOwned();
      return session;
    }
    assertLifecycleOwned();
    const aborted = abortSessionUnlocked(
      runtime,
      parameters.sessionId,
      parameters.reason,
    );
    assertLifecycleOwned();
    return aborted;
  });
}

function abortSessionUnlocked(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
  reason: string,
): WorkflowSession {
  const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
  const session = readSessionFile(sessionPath);

  if (session.state === 'aborted' && session.revisionLeaseId !== undefined) {
    releaseAbortedSessionLocks(runtime, session);
    completeTaskRevisionAbort(runtime, session);
    return session;
  }
  if (session.state !== 'active' && session.state !== 'revising') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is already ${session.state}.`,
      ExitCode.staleState,
    );
  }
  if (
    session.completionReportId ||
    session.finishReportId ||
    session.commitReportId
  ) {
    throw workflowError(
      'ABORT_REQUIRES_ROLLBACK',
      'A projected, staged, or pending session requires an explicit engine rollback transition.',
      ExitCode.staleState,
    );
  }
  const transaction = readActiveFinalizeTransaction(runtime.root, sessionId);
  if (transaction?.protectedApply !== undefined) {
    throw protectedTaskApplyRecoveryGrantRequired({
      action: 'cancel-and-abort',
      changeId: transaction.changeId,
      taskId: transaction.taskId,
      sessionId: transaction.sessionId,
      transactionId: transaction.transactionId,
      transactionDigest: transaction.recordDigest,
      transactionPhase: transaction.phase,
      protectedApply: transaction.protectedApply,
      reason: reason.trim(),
    });
  }

  if (session.state === 'revising') {
    prepareTaskRevisionAbort(runtime, session, reason.trim());
  }

  const aborted: WorkflowSession = {
    ...session,
    state: 'aborted',
    abortedAt: new Date().toISOString(),
    abortReason: reason.trim(),
  };
  writeJsonAtomic(sessionPath, aborted);
  releaseAbortedSessionLocks(runtime, aborted);
  if (session.state === 'revising') {
    completeTaskRevisionAbort(runtime, aborted);
  }
  return aborted;
}

function releaseAbortedSessionLocks(
  runtime: ReturnType<typeof runtimePaths>,
  session: WorkflowSession,
): void {
  releaseOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
  );
  releaseTaskSessionIsolationLeases(runtime, session);
}
