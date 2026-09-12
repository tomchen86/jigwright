/** Pure admission and state reset for reversing an unfinished completion projection. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { WorkflowSession } from './workflow-session-contract.ts';
import { staleReport, type WorkflowReport } from './workflow-report.ts';

export type RollbackCompletionResult = {
  session: WorkflowSession;
  completionReportId: string;
  rollbackRecordId: string;
  restoredPaths: string[];
  rolledBackAt: string;
  reason: string;
};

export function normalizeCompletionRollbackReason(reason: string): string {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw workflowError(
      'ROLLBACK_REASON_REQUIRED',
      'Rolling back a completion projection requires a non-empty reason.',
      ExitCode.usage,
    );
  }
  if (/\p{Cc}/u.test(normalizedReason)) {
    throw workflowError(
      'ROLLBACK_REASON_INVALID',
      'Completion rollback reason contains control characters.',
      ExitCode.usage,
    );
  }

  return normalizedReason;
}

export function assertCompletionRollbackSession(
  session: WorkflowSession,
): asserts session is WorkflowSession & { completionReportId: string } {
  if (
    !session.completionReportId ||
    session.finishReportId ||
    session.commitReportId
  ) {
    throw workflowError(
      'ROLLBACK_REQUIRES_PROJECTED_SESSION',
      'Completion rollback requires an active projected session that has not been finished or committed.',
      ExitCode.staleState,
    );
  }
}

export function assertCompletionRollbackRepository(
  current: GitState,
  session: WorkflowSession,
): void {
  if (
    current.repositoryRealPath !== session.repositoryRoot ||
    current.gitCommonDirectory !== session.gitCommonDirectory ||
    current.branch !== session.branch ||
    current.head !== session.baseline.head
  ) {
    throw workflowError(
      'ROLLBACK_REPOSITORY_DRIFT',
      'Repository identity, branch, or HEAD changed before completion rollback.',
      ExitCode.staleState,
    );
  }
}

export function assertCompletionRollbackReport(
  report: WorkflowReport,
  session: WorkflowSession,
): void {
  if (
    report.kind !== 'completion' ||
    report.changeId !== session.changeId ||
    report.taskId !== session.taskId ||
    report.parentReportId !== session.latestCheckReportId
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
}

export function assertCompletionRollbackDocumentPaths(
  transitionPaths: string[],
  configuredTransitionPaths: string[],
): void {
  if (
    transitionPaths.some(
      (documentPath) => !configuredTransitionPaths.includes(documentPath),
    )
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
}

export function resetCompletionRollbackSession(
  session: WorkflowSession,
): WorkflowSession {
  const {
    latestCheckReportId: _check,
    completionReportId: _completion,
    ...reset
  } = session;
  const resetSession: WorkflowSession = reset;
  return resetSession;
}
