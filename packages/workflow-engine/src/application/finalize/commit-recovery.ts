import { parseDocumentationClosureFromCommitMessage } from '../../modules/assurance/documentation-closure.ts';
/**
 * Resumes a pending managed commit and finalizes its session and isolation
 * leases.
 *
 * Invariants:
 * - Recovery accepts HEAD only at the recorded baseline or the
 *   already-created managed commit.
 */
import path from 'node:path';

import { assertCommitObject } from '../../runtime/repository-validation/commit-replay/commit-object-validation.ts';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  commitFacts,
  updateManagedRef,
} from '../../runtime/repository-transaction/git-transitions.ts';
import { type readWorkflowSessionContext } from '../../runtime/repository-observation/workflow-session-context.ts';
import { readImmutableReport } from '../../runtime/storage-journal/report-store.ts';
import {
  reportString,
  reportStringArray,
  staleReport,
} from '../../runtime/storage-journal/report-validation.ts';
import {
  releaseOwnedLock,
  releaseTaskSessionIsolationLeases,
  type runtimePaths,
  type WorkflowSession,
  writeJsonAtomic,
} from '../../runtime/session-workspace/session-store.ts';

export type CommitSessionResult = {
  session: WorkflowSession;
  reportId: string;
  commitHash: string;
};

export function resumePendingCommit(
  context: ReturnType<typeof readWorkflowSessionContext>,
  subject: string,
): CommitSessionResult {
  const session = context.session;
  if (
    !session.commitReportId ||
    !session.commitHash ||
    !session.finishReportId
  ) {
    throw workflowError(
      'PENDING_COMMIT_INVALID',
      'Pending managed commit state is incomplete.',
      ExitCode.staleState,
    );
  }
  const report = readImmutableReport(
    context.runtime.reports,
    session.sessionId,
    session.commitReportId,
  );
  const facts = commitFacts(context.git.repositoryRoot, session.commitHash);
  const changedPaths = reportStringArray(
    report,
    'changedPaths',
    'PENDING_COMMIT_INVALID',
  );
  const reportMessage = reportString(
    report,
    'message',
    'PENDING_COMMIT_INVALID',
  );
  assertCommitObject(
    context.git.repositoryRoot,
    session,
    subject,
    facts,
    reportString(report, 'tree', 'PENDING_COMMIT_INVALID'),
    changedPaths,
    parseDocumentationClosureFromCommitMessage(reportMessage),
  );
  if (
    report.kind !== 'commit' ||
    report.parentReportId !== session.finishReportId ||
    report.commitHash !== session.commitHash ||
    reportMessage !== facts.message
  ) {
    throw staleReport('PENDING_COMMIT_INVALID');
  }
  if (context.git.head === session.baseline.head) {
    updateManagedRef(
      context.git.repositoryRoot,
      session.baseline.head,
      session.commitHash,
    );
  } else if (context.git.head !== session.commitHash) {
    throw workflowError(
      'PENDING_COMMIT_HEAD_DIVERGED',
      'HEAD does not match the pending managed commit or its baseline.',
      ExitCode.staleState,
    );
  }
  return finalizeCommittedSession(context.runtime, session);
}

export function finalizeCommittedSession(
  runtime: ReturnType<typeof runtimePaths>,
  pending: WorkflowSession,
): CommitSessionResult {
  if (!pending.commitReportId || !pending.commitHash) {
    throw workflowError(
      'PENDING_COMMIT_INVALID',
      'Pending managed commit state is incomplete.',
      ExitCode.staleState,
    );
  }
  const committed: WorkflowSession = {
    ...pending,
    state: 'committed',
    committedAt: new Date().toISOString(),
  };
  writeJsonAtomic(
    path.join(runtime.sessions, `${pending.sessionId}.json`),
    committed,
  );
  releaseOwnedLock(
    path.join(runtime.locks, `${pending.changeId}.lock`),
    pending.sessionId,
  );
  releaseTaskSessionIsolationLeases(runtime, committed);
  return {
    session: committed,
    reportId: pending.commitReportId,
    commitHash: pending.commitHash,
  };
}
