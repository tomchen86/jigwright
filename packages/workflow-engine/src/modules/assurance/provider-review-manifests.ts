/** Canonical provider review manifests DTOs; field and wire semantics are unchanged. */
import type { PlanReviewSubject } from './plan-review-subject.ts';
import type { PlanReviewTargetSnapshot } from './plan-review-target-snapshot-record.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewRecord,
} from './task-diff-review-artifact-record.ts';
import type {
  TaskDiffReviewScope,
  TaskDiffReviewSubject,
} from './task-diff-review-record.ts';

export type PlanReviewManifest = {
  schemaVersion: 1;
  kind: 'plan-review-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  subject: PlanReviewSubject;
  planningTarget?: PlanReviewTargetSnapshot;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  capabilityProfile: 'repository-read-only';
};

export type TaskDiffReviewContinuationManifest = {
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-manifest';
  changeId: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  repositoryIdentity: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskDiffReviewSubject;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  capabilityProfile: 'repository-read-only';
};

export type PlanReviewSnapshotRuntime = {
  root: string;
  files: Array<{ id: string; path: string }>;
};
