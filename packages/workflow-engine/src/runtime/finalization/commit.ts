/** Commits and replays exact finalized candidates and finds managed task commits. */
import path from 'node:path';
import fs from 'node:fs';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import {
  type CommitSessionResult,
  resumePendingCommit,
  finalizeCommittedSession,
} from './commit-recovery.ts';
import {
  runSessionOperation,
  getSession,
  loadActiveSessionContext,
} from '../repository-observation/workflow-session-context.ts';
import { type ProtectedTaskApplyAuthorizationBinding } from '../../modules/lifecycle/finalize-transaction.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { readImmutableReport } from '../storage-journal/report-store.ts';
import {
  reportTaskIds,
  reportString,
  reportStringArray,
  assertInspectionReport,
  assertReportChecks,
  staleReport,
  assertCompletionTaskIds,
  assertProjectionPathClassification,
} from '../../modules/lifecycle/workflow-report.ts';
import { inspectSession } from '../repository-validation/session-inspection.ts';
import { classifyProjectionPaths } from '../../modules/projection/engine-projection-registry.ts';
import {
  assertProtectedTaskApplyNotRequired,
  assertProtectedApplyTransactionAuthorization,
} from './protected-apply.ts';
import {
  protectedTaskApplyAuthorizationInvalid,
  documentationClosureForCommit,
  invalidCompletedFinalize,
  assertFinishProjectionMatches,
  assertProjectedFinalizeReportChain,
} from '../../modules/lifecycle/finalization.ts';
import { readSessionReport } from '../storage-journal/session-report-reader.ts';
import { readFinalizeTransaction } from '../storage-journal/finalize-transaction.ts';
import { resolveFinalizeCheckPolicy } from '../../modules/assurance/finalize-check-policy.ts';
import { parseTasks } from '../../modules/planning-provider/planning-artifact-parsers.ts';
import {
  createManagedCommitObject,
  commitFacts,
  updateManagedRef,
  listStagedPaths,
  type TaskCommit,
  findExactTaskCommits,
} from '../repository-transaction/git-transitions.ts';
import { assertCommitObject } from '../repository-validation/commit-replay/commit-object-validation.ts';
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import { writeSessionReport } from '../repository-validation/session-verification.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import { persistSession } from '../session-workspace/session-persistence.ts';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { parseDocumentationClosureFromCommitMessage } from '../../modules/assurance/documentation-closure.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import {
  assertChangeId,
  assertTaskId,
} from '../../foundation/repository-path/repository-path.ts';

export function commitSession(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedSessionId: string,
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
): CommitSessionResult {
  return runSessionOperation(cwd, requestedSessionId, () =>
    commitSessionUnlocked(
      changeContract,
      cwd,
      requestedSessionId,
      subject,
      environment,
    ),
  );
}

export function commitSessionUnlocked(
  changeContract: ChangeContractServices,
  cwd: string,
  requestedSessionId: string,
  subject: string,
  environment: NodeJS.ProcessEnv,
  protectedApply: ProtectedTaskApplyAuthorizationBinding | null = null,
): CommitSessionResult {
  const observed = getSession(cwd, requestedSessionId);
  if (observed.state === 'committed') {
    return replayCommittedCommit(cwd, observed, subject);
  }
  const context = loadActiveSessionContext(cwd, requestedSessionId);
  const initialSession = context.session;
  if (initialSession.commitReportId || initialSession.commitHash) {
    return resumePendingCommit(context, subject);
  }
  if (!initialSession.finishReportId) {
    throw workflowError(
      'FINISH_REPORT_REQUIRED',
      'A current finish report is required before commit.',
      ExitCode.verification,
    );
  }
  if (!initialSession.completionReportId) {
    throw workflowError(
      'COMPLETION_REPORT_REQUIRED',
      'An authorized completion report is required before commit.',
      ExitCode.verification,
    );
  }
  const completionReport = readImmutableReport(
    context.runtime.reports,
    initialSession.sessionId,
    initialSession.completionReportId,
  );
  const completedTaskIds = reportTaskIds(
    completionReport,
    'COMPLETION_REPORT_STALE',
  );
  const projectionSourceDigest = reportString(
    completionReport,
    'projectionSourceDigest',
    'COMPLETION_REPORT_STALE',
  );
  const transitionPaths = reportStringArray(
    completionReport,
    'transitionPaths',
    'COMPLETION_REPORT_STALE',
  );
  const inspection = inspectSession(changeContract, cwd, requestedSessionId, {
    projectedTaskIds: completedTaskIds,
    projectionSourceDigest,
    authorizedTransitionPaths: transitionPaths,
  });
  const pathClassification = classifyProjectionPaths(
    inspection.changedPaths,
    [path.relative(inspection.git.repositoryRoot, inspection.tasksPath)],
    transitionPaths,
  );
  if (protectedApply === null) {
    assertProtectedTaskApplyNotRequired(
      inspection.git.repositoryRoot,
      inspection.contract.config,
      inspection.session,
      pathClassification.taskPaths,
    );
  } else {
    assertProtectedApplyTransactionAuthorization(
      cwd,
      inspection.session,
      protectedApply,
    );
    if (protectedApply.commitMessage !== subject) {
      throw protectedTaskApplyAuthorizationInvalid(
        'Protected Apply commit subject no longer matches its exact authorization.',
      );
    }
  }
  const finishReport = readSessionReport(
    inspection,
    initialSession.finishReportId,
  );
  const finalizeTransaction = readFinalizeTransaction(
    context.runtime.root,
    initialSession.sessionId,
  );
  const checkPolicy =
    finalizeTransaction === null
      ? resolveFinalizeCheckPolicy(
          parseTasks(fs.readFileSync(inspection.tasksPath, 'utf8')),
          initialSession.requiredChecks,
          inspection.contract.config,
        )
      : {
          requiredChecks: [...finalizeTransaction.requiredChecks],
          checkEscalation: finalizeTransaction.checkEscalation,
        };
  const requiredChecks = [...checkPolicy.requiredChecks];
  assertInspectionReport(
    finishReport,
    inspection,
    'finish',
    'FINISH_REPORT_STALE',
    requiredChecks,
  );
  assertReportChecks(
    finishReport,
    inspection,
    requiredChecks,
    'FINISH_REPORT_STALE',
  );
  if (finishReport.checkEscalation !== checkPolicy.checkEscalation) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  assertCompletionTaskIds(
    completionReport,
    inspection,
    'COMPLETION_REPORT_STALE',
  );
  assertProjectionPathClassification(
    completionReport,
    pathClassification,
    'COMPLETION_REPORT_STALE',
  );
  assertProjectionPathClassification(
    finishReport,
    pathClassification,
    'FINISH_REPORT_STALE',
  );
  if (finishReport.parentReportId !== initialSession.completionReportId) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  assertProjectedFinalizeCandidateChain(
    inspection,
    initialSession,
    completionReport,
    finishReport,
  );
  assertFinishProjection(finishReport, inspection);

  const expectedTree = reportString(
    finishReport,
    'tree',
    'FINISH_REPORT_STALE',
  );
  const documentationClosure = documentationClosureForCommit(
    inspection.git.repositoryRoot,
    initialSession,
    completionReport,
    inspection.contract.tasks.every(({ completed }) => completed),
    expectedTree,
    [
      ...pathClassification.taskProjectionPaths,
      ...pathClassification.engineProjectionPaths,
    ],
  );
  const commitHash = createManagedCommitObject(
    inspection.git.repositoryRoot,
    expectedTree,
    initialSession.baseline.head,
    subject,
    initialSession.changeId,
    initialSession.taskId,
    environment,
    documentationClosure,
  );
  const facts = commitFacts(inspection.git.repositoryRoot, commitHash);
  assertCommitObject(
    inspection.git.repositoryRoot,
    initialSession,
    subject,
    facts,
    expectedTree,
    inspection.changedPaths,
    documentationClosure,
  );

  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'commit',
    sessionId: initialSession.sessionId,
    changeId: initialSession.changeId,
    taskId: initialSession.taskId,
    createdAt: new Date().toISOString(),
    parentReportId: initialSession.finishReportId,
    baseline: initialSession.baseline,
    branch: initialSession.branch,
    commitHash,
    tree: facts.tree,
    ...pathClassification,
    completedTaskIds,
    projectionSourceDigest,
    transitionPaths,
    message: facts.message,
  };
  const reportId = writeSessionReport(inspection, report);
  const pending: WorkflowSession = {
    ...initialSession,
    commitReportId: reportId,
    commitHash,
  };
  persistSession(inspection, pending);
  updateManagedRef(
    inspection.git.repositoryRoot,
    initialSession.baseline.head,
    commitHash,
  );
  return finalizeCommittedSession(context.runtime, pending);
}

function replayCommittedCommit(
  cwd: string,
  session: WorkflowSession,
  subject: string,
): CommitSessionResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  if (
    session.repositoryRoot !== git.repositoryRealPath ||
    session.gitCommonDirectory !== git.gitCommonDirectory ||
    session.state !== 'committed' ||
    !session.finishReportId ||
    !session.commitReportId ||
    !session.commitHash
  ) {
    throw invalidCompletedFinalize();
  }
  const report = readImmutableReport(
    runtime.reports,
    session.sessionId,
    session.commitReportId,
  );
  const changedPaths = reportStringArray(
    report,
    'changedPaths',
    'PENDING_COMMIT_INVALID',
  );
  const facts = commitFacts(git.repositoryRoot, session.commitHash);
  const reportMessage = reportString(
    report,
    'message',
    'PENDING_COMMIT_INVALID',
  );
  assertCommitObject(
    git.repositoryRoot,
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
    throw invalidCompletedFinalize();
  }
  return {
    session,
    reportId: session.commitReportId,
    commitHash: session.commitHash,
  };
}

function assertFinishProjection(
  report: WorkflowReport,
  inspection: SessionInspection,
): void {
  const stagedPaths = reportStringArray(
    report,
    'stagedPaths',
    'FINISH_REPORT_STALE',
  );
  const currentStaged = listStagedPaths(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  const tree = runGit(inspection.git.repositoryRoot, ['write-tree']).trim();
  assertFinishProjectionMatches(
    report,
    inspection,
    stagedPaths,
    currentStaged,
    tree,
  );
}

function assertProjectedFinalizeCandidateChain(
  inspection: ReturnType<typeof inspectSession>,
  session: WorkflowSession,
  completionReport: WorkflowReport,
  finishReport: WorkflowReport,
): void {
  const projectedFields = [
    completionReport.finalizeProfile,
    completionReport.candidateTree,
    finishReport.finalizeProfile,
    finishReport.candidateTree,
  ];
  if (projectedFields.every((value) => value === undefined)) return;
  if (!session.latestCheckReportId) {
    throw staleReport('FINISH_REPORT_STALE');
  }
  const checkReport = readSessionReport(
    inspection,
    session.latestCheckReportId,
  );
  assertProjectedFinalizeReportChain(
    session,
    completionReport,
    finishReport,
    checkReport,
  );
}

export function findTaskCommits(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string,
): TaskCommit[] {
  const changeId = assertChangeId(requestedChangeId);
  const taskId = assertTaskId(requestedTaskId);
  return findExactTaskCommits(
    discoverRepository(cwd).repositoryRoot,
    changeId,
    taskId,
  );
}
