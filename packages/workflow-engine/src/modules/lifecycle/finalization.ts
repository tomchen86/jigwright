/** Pure finalization, commit and recovery contracts and admission rules. */
import crypto from 'node:crypto';
import type { WorkflowSession } from './workflow-session-contract.ts';
import {
  type FinalizeTaskResult,
  type FinalizeTaskOptions,
  PROJECTED_SINGLE_PASS_ASSURANCE,
} from './projected-finalization.ts';
import { type TaskDiffReviewCompletionGateOptions } from './task-diff-review-contracts.ts';
import {
  type FinalizeTransaction,
  type ProtectedTaskApplyAuthorizationBinding,
} from './finalize-transaction.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { WorkflowReport } from './workflow-report.ts';
import {
  parseDocumentationReviewCapture,
  createDocumentationClosureRecord,
} from '../assurance/documentation-closure.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ProtectedTaskApplyFinalizationParametersV1 } from '../authority/protected-task-apply-grant.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProtectedTaskApplyRecoveryParametersV1,
  type ProtectedTaskApplyRecoveryAuthorizationBinding,
} from '../authority/protected-task-apply-recovery-grant.ts';
import {
  MAX_FINALIZE_CANCELLATION_REASON_BYTES,
  type FinalizeCancellation,
} from './finalize-cancellation.ts';
import type { SessionInspection } from './session-inspection.ts';
import { reportString, staleReport } from './workflow-report.ts';

export type CompleteTaskResult = {
  session: WorkflowSession;
  reportId: string;
  completedTaskIds: string[];
};

export type FinishSessionResult = {
  session: WorkflowSession;
  reportId: string;
  stagedPaths: string[];
  tree: string;
};

export type FinalizeSessionResult = Omit<FinalizeTaskResult, 'session'> & {
  session: WorkflowSession;
  commitReportId: string;
  commitHash: string;
};

export type FinalizeSessionOptions = Readonly<{
  fullGate?: boolean;
  consumedRoleResultReplay?: TaskDiffReviewCompletionGateOptions['consumedRoleResultReplay'];
  onCheckEscalation?: FinalizeTaskOptions['onCheckEscalation'];
  testCrashAfter?: FinalizeTaskOptions['testCrashAfter'] | 'finalized';
}>;

export type ProtectedTaskApplyLifecycleState = Readonly<{
  phase: 'pending' | 'in-progress' | 'cancelled' | 'completed';
  changeId: string;
  sessionId: string;
  taskId: string;
  branch: string;
  baseline: WorkflowSession['baseline'];
  mandateBinding: NonNullable<WorkflowSession['mandateBinding']>;
  changedPaths: readonly string[];
  commitMessage: string;
  fullGate: boolean;
  stateFingerprint: `sha256:${string}`;
  transactionId: string | null;
  commitHash: string | null;
  authorization: Readonly<{
    changeId: string;
    taskId: string;
    mandateTaskId: string;
    changedPaths: readonly string[];
    roles: readonly string[];
    matchedPatterns: readonly string[];
    unclassifiedScope: boolean;
  }> | null;
}>;

export type TaskDiffReviewReplayOptions = Pick<
  TaskDiffReviewCompletionGateOptions,
  'consumedRoleResultReplay'
>;

export type FinalizeRecoveryStatus = Readonly<{
  state: 'in-progress' | 'recovery-required' | 'completed';
  transactionId: string;
  phase: FinalizeTransaction['phase'];
  retrySafe: boolean;
  recoveryCommand: string;
}>;

export function assertFinalizeTransactionMatchesSession(
  transaction: FinalizeTransaction,
  session: WorkflowSession,
  git: Pick<GitState, 'repositoryRealPath' | 'gitCommonDirectory'>,
): void {
  if (
    transaction.repositoryRoot !== git.repositoryRealPath ||
    transaction.gitCommonDirectory !== git.gitCommonDirectory ||
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.branch !== session.branch ||
    JSON.stringify(transaction.baseline) !== JSON.stringify(session.baseline)
  ) {
    throw invalidCompletedFinalize();
  }
}

export function isCompletedFinalizeTransaction(
  transaction: FinalizeTransaction,
): transaction is FinalizeTransaction & {
  candidateTree: string;
  checkReportId: string;
  completionReportId: string;
  finishReportId: string;
} {
  return (
    transaction.phase === 'completed' &&
    transaction.candidateTree !== null &&
    transaction.checkReportId !== null &&
    transaction.completionReportId !== null &&
    transaction.finishReportId !== null
  );
}

export function finalizeResultFromTransaction(
  transaction: FinalizeTransaction & {
    candidateTree: string;
    checkReportId: string;
    completionReportId: string;
    finishReportId: string;
  },
  session: WorkflowSession,
): FinalizeTaskResult {
  return {
    session,
    assurance: PROJECTED_SINGLE_PASS_ASSURANCE,
    transactionId: transaction.transactionId,
    checkReportId: transaction.checkReportId,
    completionReportId: transaction.completionReportId,
    finishReportId: transaction.finishReportId,
    completedTaskIds: [...transaction.completedTaskIds],
    requiredChecks: [...transaction.requiredChecks],
    checkEscalation: transaction.checkEscalation,
    stagedPaths: [...transaction.changedPaths],
    tree: transaction.candidateTree,
  };
}

export function documentationClosureForCommit(
  repositoryRoot: string,
  session: WorkflowSession,
  completionReport: WorkflowReport,
  finalTask: boolean,
  projectedCommitTree: string,
  projectionPaths: readonly string[],
) {
  if (!finalTask) {
    if (completionReport.documentationReview !== undefined) {
      throw invalidDocumentationClosureCapture();
    }
    return null;
  }
  const captured = parseDocumentationReviewCapture(
    completionReport.documentationReview,
  );
  if (captured.review.subject.documentationRequirement?.required !== true) {
    throw workflowError(
      'DOCUMENTATION_CLOSURE_REQUIRED',
      'The final task commit requires a satisfied documentation closure review.',
      ExitCode.verification,
    );
  }
  return createDocumentationClosureRecord({
    changeId: session.changeId,
    taskId: session.taskId,
    review: captured.review,
    finalAssurance: captured.finalAssurance,
    remediation: session.documentationRemediation ?? null,
    projectedCommitTree,
    projectionPaths: [...projectionPaths].sort(),
  });
}

function invalidDocumentationClosureCapture() {
  return workflowError(
    'DOCUMENTATION_CLOSURE_CAPTURE_INVALID',
    'The completion report documentation review capture is missing, malformed, or unexpected.',
    ExitCode.verification,
  );
}

export function invalidCompletedFinalize() {
  return workflowError(
    'FINALIZE_TRANSACTION_INVALID',
    'Completed finalize state does not match its immutable transaction and commit evidence.',
    ExitCode.staleState,
  );
}

export function assertProtectedApplyAuthorizationMatchesParameters(
  authorization: ProtectedTaskApplyAuthorizationBinding,
  parameters: ProtectedTaskApplyFinalizationParametersV1,
): void {
  if (
    authorization.transitionId !== 'task.protected-apply.finalize.v1' ||
    authorization.stateBindingDigest !== parameters.stateBindingDigest ||
    authorization.parametersDigest !==
      protectedTaskApplyFingerprint(parameters) ||
    authorization.commitMessage !== parameters.commitMessage
  ) {
    throw protectedTaskApplyAuthorizationInvalid(
      'Protected Apply authorization does not bind the exact transition parameters.',
    );
  }
}

export function protectedTaskApplyFingerprint(
  value: unknown,
): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

export function protectedTaskApplyAuthorizationInvalid(message: string) {
  return workflowError(
    'PROTECTED_TASK_APPLY_AUTHORIZATION_INVALID',
    message,
    ExitCode.guard,
  );
}

export type FinalizeCancellationResult = Readonly<{
  state: 'cancelled';
  sessionId: string;
  transactionId: string;
  reason: string;
  cancelledAt: string;
}>;

export type FinalizeCancellationOptions = Readonly<{
  consumedRoleResultReplay?: TaskDiffReviewCompletionGateOptions['consumedRoleResultReplay'];
  testCrashAfter?:
    'cancellation-requested' | 'projection-restored' | 'cancellation-completed';
}>;

export type ProtectedFinalizeRecoveryContext = Readonly<{
  parameters: ProtectedTaskApplyRecoveryParametersV1;
  authorization: ProtectedTaskApplyRecoveryAuthorizationBinding;
  assertLifecycleOwned(): void;
}>;

export function assertFinalizeCancellationReason(reason: string): void {
  if (
    reason.length === 0 ||
    reason.trim() !== reason ||
    Buffer.byteLength(reason) > MAX_FINALIZE_CANCELLATION_REASON_BYTES ||
    /\p{Cc}/u.test(reason)
  ) {
    throw workflowError(
      'FINALIZE_CANCELLATION_REASON_INVALID',
      `Finalize cancellation requires one trimmed reason of at most ${MAX_FINALIZE_CANCELLATION_REASON_BYTES} bytes without control characters.`,
      ExitCode.usage,
    );
  }
}

export function assertCancellationRequest(
  cancellation: FinalizeCancellation,
  session: WorkflowSession,
  git: Pick<GitState, 'repositoryRealPath' | 'gitCommonDirectory'>,
  transactionId: string,
  reason: string,
): void {
  assertFinalizeTransactionMatchesSession(
    cancellation.transaction,
    session,
    git,
  );
  if (
    cancellation.sessionId !== session.sessionId ||
    cancellation.transactionId !== transactionId ||
    cancellation.reason !== reason
  ) {
    throw invalidFinalizeCancellation(
      'Finalize cancellation does not match the exact transaction and reason.',
    );
  }
}

export function assertProtectedFinalizeRecoveryContext(
  transaction: FinalizeTransaction,
  context: ProtectedFinalizeRecoveryContext | null,
  reason: string,
): asserts context is ProtectedFinalizeRecoveryContext {
  const protectedApply = transaction.protectedApply;
  if (protectedApply === undefined || context === null) {
    throw invalidFinalizeCancellation(
      'Protected finalize cancellation requires its exact recovery Grant.',
    );
  }
  const { parameters, authorization } = context;
  if (
    parameters.changeId !== transaction.changeId ||
    parameters.taskId !== transaction.taskId ||
    parameters.sessionId !== transaction.sessionId ||
    parameters.transactionId !== transaction.transactionId ||
    parameters.transactionDigest !== transaction.recordDigest ||
    parameters.transactionPhase !== transaction.phase ||
    parameters.reason !== reason ||
    parameters.parentChallengeId !== protectedApply.challengeId ||
    parameters.parentOperationId !== protectedApply.operationId ||
    parameters.parentApprovalSubjectDigest !==
      protectedApply.approvalSubjectDigest ||
    parameters.parentStateBindingDigest !== protectedApply.stateBindingDigest ||
    parameters.parentParametersDigest !== protectedApply.parametersDigest ||
    authorization.parentChallengeId !== protectedApply.challengeId ||
    authorization.parentOperationId !== protectedApply.operationId ||
    authorization.parentApprovalSubjectDigest !==
      protectedApply.approvalSubjectDigest ||
    authorization.parentStateBindingDigest !==
      protectedApply.stateBindingDigest ||
    authorization.parentParametersDigest !== protectedApply.parametersDigest
  ) {
    throw invalidFinalizeCancellation(
      'Protected finalize cancellation no longer matches its exact recovery Grant.',
    );
  }
}

export function cancellationResult(
  cancellation: FinalizeCancellation,
): FinalizeCancellationResult {
  if (cancellation.phase !== 'completed' || cancellation.cancelledAt === null) {
    throw invalidFinalizeCancellation(
      'Finalize cancellation is not durably completed.',
    );
  }
  return {
    state: 'cancelled',
    sessionId: cancellation.sessionId,
    transactionId: cancellation.transactionId,
    reason: cancellation.reason,
    cancelledAt: cancellation.cancelledAt,
  };
}

export function invalidFinalizeCancellation(message: string) {
  return workflowError(
    'FINALIZE_CANCELLATION_INVALID',
    message,
    ExitCode.staleState,
  );
}

export function assertFinishProjectionMatches(
  report: WorkflowReport,
  inspection: SessionInspection,
  stagedPaths: string[],
  currentStaged: string[],
  tree: string,
): void {
  if (
    JSON.stringify(stagedPaths) !== JSON.stringify(currentStaged) ||
    JSON.stringify(stagedPaths) !== JSON.stringify(inspection.changedPaths) ||
    reportString(report, 'tree', 'FINISH_REPORT_STALE') !== tree
  ) {
    throw staleReport('FINISH_REPORT_STALE');
  }
}

export function assertProjectedFinalizeReportChain(
  session: WorkflowSession,
  completionReport: WorkflowReport,
  finishReport: WorkflowReport,
  checkReport: WorkflowReport,
): void {
  const candidateTree = reportString(
    finishReport,
    'candidateTree',
    'FINISH_REPORT_STALE',
  );
  if (
    checkReport.kind !== 'check' ||
    completionReport.kind !== 'completion' ||
    checkReport.parentReportId !== undefined ||
    completionReport.parentReportId !== session.latestCheckReportId ||
    checkReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    completionReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    finishReport.finalizeProfile !== PROJECTED_SINGLE_PASS_ASSURANCE ||
    checkReport.checkEscalation !== finishReport.checkEscalation ||
    completionReport.checkEscalation !== finishReport.checkEscalation ||
    reportString(checkReport, 'candidateTree', 'FINISH_REPORT_STALE') !==
      candidateTree ||
    reportString(completionReport, 'candidateTree', 'FINISH_REPORT_STALE') !==
      candidateTree ||
    reportString(finishReport, 'tree', 'FINISH_REPORT_STALE') !== candidateTree
  ) {
    throw staleReport('FINISH_REPORT_STALE');
  }
}

export function assertProtectedTaskApplyParametersMatch(
  observed: ProtectedTaskApplyLifecycleState,
  parameters: ProtectedTaskApplyFinalizationParametersV1,
): void {
  if (
    canonicalJson({
      changeId: observed.changeId,
      sessionId: observed.sessionId,
      taskId: observed.taskId,
      branch: observed.branch,
      baseline: observed.baseline,
      mandateBinding: observed.mandateBinding,
      changedPaths: observed.changedPaths,
      commitMessage: observed.commitMessage,
      fullGate: observed.fullGate,
    }) !==
    canonicalJson({
      changeId: parameters.changeId,
      sessionId: parameters.sessionId,
      taskId: parameters.taskId,
      branch: parameters.branch,
      baseline: parameters.baseline,
      mandateBinding: parameters.mandateBinding,
      changedPaths: parameters.changedPaths,
      commitMessage: parameters.commitMessage,
      fullGate: parameters.fullGate === true,
    })
  ) {
    throw protectedTaskApplyAuthorizationInvalid(
      'The protected task changed after its exact Grant was prepared.',
    );
  }
}
