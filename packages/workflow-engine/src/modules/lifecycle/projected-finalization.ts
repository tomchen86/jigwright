/** Pure projected-finalization admission, reports, session projection and results. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { DocumentationReviewCapture } from '../assurance/documentation-closure.ts';
import {
  resolveExplicitFinalizeChecks,
  type FinalizeCheckEscalation,
} from '../assurance/finalize-check-policy.ts';
import { classifyProjectionPaths } from '../projection/engine-projection-registry.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { WorkflowConfig } from '../repository-consumer/workflow-config.ts';
import { digestRequiredCheckDefinitions } from './contract-digests.ts';
import type {
  FinalizeTransaction,
  ProtectedTaskApplyAuthorizationBinding,
} from './finalize-transaction.ts';
import type { SessionInspection } from './session-inspection.ts';
import type { TaskDiffReviewCompletionGateOptions } from './task-diff-review-contracts.ts';
import type { WorkflowReport } from './workflow-report.ts';
import type { WorkflowSession } from './workflow-session-contract.ts';

export const PROJECTED_SINGLE_PASS_ASSURANCE =
  'projected-single-pass-ordinary-failure' as const;

export type FinalizeTaskResult = {
  session: WorkflowSession;
  assurance: typeof PROJECTED_SINGLE_PASS_ASSURANCE;
  transactionId: string;
  checkReportId: string;
  completionReportId: string;
  finishReportId: string;
  completedTaskIds: string[];
  requiredChecks: string[];
  checkEscalation: 'all-tasks-terminal' | 'explicit' | null;
  stagedPaths: string[];
  tree: string;
};

export type FinalizeTaskOptions = Readonly<{
  fullGate?: boolean;
  consumedRoleResultReplay?: TaskDiffReviewCompletionGateOptions['consumedRoleResultReplay'];
  onCheckEscalation?: (
    escalation: Exclude<FinalizeCheckEscalation, null>,
    requiredChecks: readonly string[],
  ) => void;
  /** Internal exact authorization lineage; never accepted from a CLI caller. */
  protectedApply?: ProtectedTaskApplyAuthorizationBinding;
  testCrashAfter?:
    | 'projection-prepared'
    | 'task-projected'
    | 'projection-applied'
    | 'candidate-prepared'
    | 'checks-running'
    | 'checks-executed'
    | 'checked'
    | 'staged'
    | 'reports-persisted'
    | 'session-finished';
}>;

export type CandidateFinalizeTransaction = FinalizeTransaction & {
  candidateTree: string;
  candidateFingerprint: string;
};

export function assertCandidateTransaction(
  transaction: FinalizeTransaction,
): asserts transaction is CandidateFinalizeTransaction {
  if (
    transaction.phase === 'projection-prepared' ||
    transaction.candidateTree === null ||
    transaction.candidateFingerprint === null
  ) {
    throw transactionDiverged();
  }
}

export function createCheckReport(
  transaction: FinalizeTransaction,
  inspection: SessionInspection,
  checks: unknown[],
): WorkflowReport {
  const requiredChecks = [...transaction.requiredChecks];
  return {
    schemaVersion: 1,
    kind: 'check',
    finalizeProfile: PROJECTED_SINGLE_PASS_ASSURANCE,
    candidateTree: transaction.candidateTree,
    sessionId: transaction.sessionId,
    changeId: transaction.changeId,
    taskId: transaction.taskId,
    createdAt: transaction.createdAt,
    baseline: transaction.baseline,
    branch: transaction.branch,
    artifactDigests: inspection.artifactDigests,
    allowedPaths: inspection.session.allowedPaths,
    requiredChecks,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      inspection.contract.checks,
      requiredChecks,
    ),
    checkEscalation: transaction.checkEscalation,
    ...classifyProjectionPaths(
      inspection.changedPaths,
      [transaction.taskProjectionPath],
      [...transaction.transitionPaths],
    ),
    fingerprint: inspection.fingerprint,
    checks,
  };
}

export function createCompletionReport(
  transaction: FinalizeTransaction,
  inspection: SessionInspection,
  documentationReview: DocumentationReviewCapture | null,
): WorkflowReport {
  return {
    ...createCheckReport(transaction, inspection, []),
    kind: 'completion',
    parentReportId: transaction.checkReportId!,
    completedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    transitionPaths: [...transaction.transitionPaths],
    reconciledTasks: transaction.reconciledTasks,
    checks: undefined,
    ...(documentationReview === null ? {} : { documentationReview }),
  };
}

export function createFinishReport(
  transaction: FinalizeTransaction,
  inspection: SessionInspection,
  checkReport: WorkflowReport,
  completionReportId: string,
): WorkflowReport {
  return {
    ...createCheckReport(
      transaction,
      inspection,
      checkReport.checks as unknown[],
    ),
    kind: 'finish',
    parentReportId: completionReportId,
    completedTaskIds: [...transaction.completedTaskIds],
    projectionSourceDigest: transaction.projectionSourceDigest,
    transitionPaths: [...transaction.transitionPaths],
    stagedPaths: [...transaction.changedPaths],
    tree: transaction.candidateTree,
  };
}

export function finalizedSession(
  session: WorkflowSession,
  transaction: FinalizeTransaction,
): WorkflowSession {
  if (
    transaction.checkReportId === null ||
    transaction.completionReportId === null ||
    transaction.finishReportId === null
  ) {
    throw transactionDiverged();
  }
  return {
    ...session,
    latestCheckReportId: transaction.checkReportId,
    completionReportId: transaction.completionReportId,
    finishReportId: transaction.finishReportId,
  };
}

export function sessionHasFinalizeReports(
  session: WorkflowSession,
  transaction: FinalizeTransaction,
): boolean {
  return (
    session.latestCheckReportId === transaction.checkReportId &&
    session.completionReportId === transaction.completionReportId &&
    session.finishReportId === transaction.finishReportId
  );
}

export function resultFrom(
  transaction: CandidateFinalizeTransaction,
  session: WorkflowSession,
): FinalizeTaskResult {
  if (
    transaction.checkReportId === null ||
    transaction.completionReportId === null ||
    transaction.finishReportId === null
  ) {
    throw transactionDiverged();
  }
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

export function assertProtectedApplyRequestMatches(
  transaction: FinalizeTransaction,
  options: FinalizeTaskOptions,
): void {
  if (
    JSON.stringify(transaction.protectedApply ?? null) ===
    JSON.stringify(options.protectedApply ?? null)
  ) {
    return;
  }
  throw workflowError(
    'FINALIZE_REQUEST_CHANGED',
    'A durable protected Apply transaction can only resume under its exact Central Grant operation.',
    ExitCode.conflict,
  );
}

export function transactionDiverged() {
  return workflowError(
    'FINALIZE_TRANSACTION_DIVERGED',
    'Durable finalize state differs from its exact candidate transaction.',
    ExitCode.staleState,
  );
}

export function assertExplicitCheckRequestMatches(
  session: WorkflowSession,
  config: WorkflowConfig,
  transaction: FinalizeTransaction,
  options: FinalizeTaskOptions,
): void {
  if (options.fullGate !== true) return;
  const terminalChecks = config.allTasksTerminalChecks ?? [];
  const expected = resolveExplicitFinalizeChecks(
    session.requiredChecks,
    config,
  );
  if (
    terminalChecks.length === 0 ||
    JSON.stringify([...transaction.requiredChecks]) !== JSON.stringify(expected)
  ) {
    throw workflowError(
      'FINALIZE_REQUEST_CHANGED',
      'A durable finalize transaction cannot be escalated after it was created.',
      ExitCode.conflict,
      {
        recovery: `Resume without --full-gate: pnpm workflow finalize-recover ${transaction.sessionId} --json`,
      },
    );
  }
}

export function assertFinalizeTransactionIdentity(
  session: WorkflowSession,
  git: Pick<GitState, 'repositoryRealPath' | 'gitCommonDirectory'>,
  transaction: FinalizeTransaction,
): void {
  if (
    transaction.sessionId !== session.sessionId ||
    transaction.changeId !== session.changeId ||
    transaction.taskId !== session.taskId ||
    transaction.repositoryRoot !== git.repositoryRealPath ||
    transaction.gitCommonDirectory !== git.gitCommonDirectory ||
    transaction.branch !== session.branch ||
    JSON.stringify(transaction.baseline) !== JSON.stringify(session.baseline)
  ) {
    throw transactionDiverged();
  }
}
