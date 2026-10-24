/** Canonical durable projected-finalization transaction data. */
import type { DocumentationReviewCapture } from '../assurance/documentation-closure.ts';
import type { FinalizeCheckEscalation } from '../assurance/finalize-check-policy.ts';

export type FinalizeTransactionPhase =
  | 'projection-prepared'
  | 'candidate-prepared'
  | 'checks-running'
  | 'checked'
  | 'staged'
  | 'reports-persisted'
  | 'completed';

export type FinalizeProjectionMutation = Readonly<{
  path: string;
  before: string | null;
  after: string;
}>;

export type FinalizeReconciledTask = Readonly<{
  taskId: string;
  commitHash: string;
  changedPaths: readonly string[];
  checks: readonly unknown[];
}>;

export type ProtectedTaskApplyAuthorizationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'protected-task-apply-authorization.v1';
  transitionId: 'task.protected-apply.finalize.v1';
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
  parametersDigest: `sha256:${string}`;
  commitMessage: string;
}>;

export type FinalizeTransaction = Readonly<{
  schemaVersion: 2;
  kind: 'projected-finalize-transaction.v2';
  transactionId: string;
  recordDigest: string;
  phase: FinalizeTransactionPhase;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  completedTaskIds: readonly string[];
  requiredChecks: readonly string[];
  checkEscalation: FinalizeCheckEscalation;
  reconciledTasks: readonly FinalizeReconciledTask[];
  taskProjectionPath: string;
  projectionMutations: readonly FinalizeProjectionMutation[];
  projectionSourceDigest: string;
  projectionBaseFingerprint: string;
  transitionPaths: readonly string[];
  changedPaths: readonly string[];
  candidateTree: string | null;
  candidateFingerprint: string | null;
  candidateStatusEntries: readonly string[];
  previousIndexTree: string;
  createdAt: string;
  checkReportId: string | null;
  completionReportId: string | null;
  finishReportId: string | null;
  documentationReview?: DocumentationReviewCapture;
  protectedApply?: ProtectedTaskApplyAuthorizationBinding;
}>;
