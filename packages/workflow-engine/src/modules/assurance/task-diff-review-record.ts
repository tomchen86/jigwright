/** Canonical task diff review record data; parsing and effects stay with their existing implementation. */
import type { PathRole } from '../source/path-role-registry.ts';
import type { TASK_DIFF_REVIEW_COVERAGE } from './task-diff-review-schema.ts';

export type TaskDiffReviewPathRole = PathRole | 'unregistered';

export type TaskDiffDocumentationHint = Readonly<{
  reason:
    | 'workflow-lifecycle-changed'
    | 'public-interface-changed'
    | 'configuration-changed'
    | 'migration-changed'
    | 'user-visible-behavior-changed'
    | 'roadmap-state-changed'
    | 'authority-boundary-changed';
  suggestedPaths: readonly string[];
}>;

export type TaskDiffDocumentationClosureRequirement =
  | Readonly<{
      schemaVersion: 1;
      kind: 'task-diff-documentation-closure-requirement.v1';
      requirementDigest: string;
      required: false;
      basis: 'change-open';
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'task-diff-documentation-closure-requirement.v1';
      requirementDigest: string;
      required: true;
      basis: 'final-task';
      changeBaseCommit: string;
      changeBaseTree: string;
      candidateTree: string;
      changedPaths: readonly string[];
      patchDigest: string;
      hints: readonly TaskDiffDocumentationHint[];
    }>;

export type TaskDiffReviewRequirement = Readonly<{
  required: boolean;
  basis:
    | 'explicit'
    | 'behavioral-strategy'
    | 'risk-role'
    | 'mechanical-evidence'
    | 'policy-not-triggered';
  riskPaths: readonly Readonly<{
    path: string;
    role: TaskDiffReviewPathRole;
  }>[];
}>;

export type TaskDiffTreeEntry = Readonly<{
  mode: '100644' | '100755' | '120000' | '160000';
  objectId: string;
}>;

export type TaskDiffPathTransition = Readonly<{
  path: string;
  before: TaskDiffTreeEntry | null;
  after: TaskDiffTreeEntry | null;
}>;

export type CreateTaskDiffReviewSubjectInput = Readonly<{
  repositoryId: string;
  changeId: string;
  taskId: string;
  baseCommit: string;
  baseTree: string;
  candidateTree: string;
  transitions: readonly TaskDiffPathTransition[];
  taskContractDigest: string;
  requiredCheckPolicyDigest: string;
  checkEvidenceDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  planReviewNodeId: string;
  planningAssuranceDigest: string;
  reviewRequirement: TaskDiffReviewRequirement;
  documentationRequirement?: TaskDiffDocumentationClosureRequirement;
}>;

export type TaskDiffReviewSubject = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-subject.v1';
  subjectDigest: string;
  repositoryId: string;
  changeId: string;
  taskId: string;
  baseCommit: string;
  baseTree: string;
  candidateTree: string;
  changedPaths: readonly string[];
  transitions: readonly TaskDiffPathTransition[];
  patchDigest: string;
  taskContractDigest: string;
  requiredCheckPolicyDigest: string;
  checkEvidenceDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  planReviewNodeId: string;
  planningAssuranceDigest: string;
  reviewPolicyDigest: string;
  reviewRequirement: TaskDiffReviewRequirement;
  documentationRequirement: TaskDiffDocumentationClosureRequirement;
  requiredIndependence: 'session-independent';
  coverage: typeof TASK_DIFF_REVIEW_COVERAGE;
}>;

export type TaskDiffReviewPredecessor = Readonly<{
  subjectDigest: string;
  reviewRecordDigest: string;
  finalAssuranceCommitmentDigest: string | null;
}>;

export type TaskDiffReviewScope = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-scope.v1';
  scopeDigest: string;
  currentSubjectDigest: string;
  candidateIdentityDigest: string;
  mode: 'full' | 'delta';
  reviewedPaths: readonly string[];
  predecessor: TaskDiffReviewPredecessor | null;
}>;

export type TaskDiffReviewCandidatePlan =
  | Readonly<{
      action: 'not-required';
      candidateIdentityDigest: string;
      basis: 'mechanical-evidence' | 'policy-not-triggered';
    }>
  | Readonly<{
      action: 'reuse';
      candidateIdentityDigest: string;
      predecessor: TaskDiffReviewPredecessor;
    }>
  | Readonly<{
      action: 'review';
      candidateIdentityDigest: string;
      scope: TaskDiffReviewScope;
    }>;

export type TaskDiffReviewCandidatePredecessor = Readonly<{
  subject: TaskDiffReviewSubject;
  reviewRecordDigest: string;
  finalAssuranceCommitmentDigest: string | null;
}>;
