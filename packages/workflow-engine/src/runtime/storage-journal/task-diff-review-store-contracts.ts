/**
 * Defines persisted review records and their shared identity and error operations.
 *
 * Invariants:
 * - Record schemas and digest inputs retain their exact representations.
 * - Accepted values remain recursively immutable.
 *
 * Depends on: TaskDiff assurance records, provider role identity, and workflow errors.
 * Failure modes: Record identities drift or callers mutate accepted review evidence.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  type WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  RecordedRoleParticipant,
  AdmittedRoleResult,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import type {
  TaskDiffReviewRecord,
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewContinuationSubmission,
  TaskDiffFinalAssuranceRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type {
  TaskDiffReviewSubject,
  TaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const TASK_DIFF_REVIEW_GLOBAL_NAMESPACES = new Set([
  'external-authority',
  'final-assurance',
  'lineage-supersessions',
]);

export type TaskDiffReviewManifestSnapshot = Readonly<{
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
}>;

export type TaskDiffReviewReservationRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-reservation.v1';
  reservationDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  manifest: TaskDiffReviewManifestSnapshot;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskDiffReviewResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-result-binding.v1';
  bindingDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  subjectDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  runtimeObservationDigest: string;
  providerObservationNodeId: string;
  providerObservationDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
  roleResult: AdmittedRoleResult;
  review: TaskDiffReviewRecord;
  createdAt: string;
}>;

export type TaskDiffReviewContinuationManifestSnapshot = Readonly<{
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
}>;

export type TaskDiffReviewContinuationReservationRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-reservation.v1';
  reservationDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseline: Readonly<{ head: string; tree: string }>;
  mandateBinding: TaskMandateBinding | null;
  subject: TaskDiffReviewSubject;
  implementationActor: RecordedRoleParticipant;
  review: TaskDiffReviewRecord;
  response: TaskDiffReviewChallengeResponseRecord;
  manifest: TaskDiffReviewContinuationManifestSnapshot;
  request: ProviderInvocationRequest;
  authorizationNodeId: string;
  reservationNodeId: string;
  createdAt: string;
}>;

export type TaskDiffReviewContinuationResultBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-continuation-result-binding.v1';
  bindingDigest: string;
  ownerInvestigationId: string;
  sessionId: string;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  runtimeObservationDigest: string;
  providerResultNodeId: string;
  providerResultDigest: string;
  submission: TaskDiffReviewContinuationSubmission;
  createdAt: string;
}>;

export type TaskDiffFinalAssuranceBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-final-assurance-binding.v1';
  bindingDigest: string;
  subjectDigest: string;
  assuranceNodeId: string;
  assuranceResultDigest: string;
  assurance: TaskDiffFinalAssuranceRecord;
  createdAt: string;
}>;

/**
 * Session-free projection of one semantic review-lineage edge. The complete
 * subjects and reviews are retained so replay never depends on a mutable
 * provider session store. This record carries no closure or freshness
 * authority; the successor review scope remains the semantic source of truth.
 */
export type TaskDiffReviewLineageSupersessionRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-review-lineage-supersession.v1';
  supersessionDigest: string;
  predecessorSubject: TaskDiffReviewSubject;
  predecessorSubjectDigest: string;
  predecessorReview: TaskDiffReviewRecord;
  predecessorReviewRecordDigest: string;
  successorSubject: TaskDiffReviewSubject;
  successorSubjectDigest: string;
  successorReview: TaskDiffReviewRecord;
  successorReviewRecordDigest: string;
  successorReviewScope: TaskDiffReviewScope;
  successorReviewScopeDigest: string;
}>;

export type CreateTaskDiffReviewLineageSupersessionInput = Readonly<{
  predecessorSubject: TaskDiffReviewSubject;
  predecessorReview: TaskDiffReviewRecord;
  successorSubject: TaskDiffReviewSubject;
  successorReview: TaskDiffReviewRecord;
  successorReviewScope: TaskDiffReviewScope;
  successorReviewScopeDigest: string;
}>;

export function withoutDigest<T extends Record<string, unknown>>(
  value: T,
  digestKey: keyof T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== digestKey),
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function assertDigest(value: unknown): string {
  if (!isDigest(value)) throw storeUnsafe();
  return value;
}

export function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY.test(value);
}

export function isIdentityOrNull(value: unknown): value is string | null {
  return value === null || isIdentity(value);
}

export function isProviderIdOrNull(value: unknown): value is ProviderId | null {
  return value === null || value === 'claude' || value === 'codex';
}

export function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function storeUnsafe(): WorkflowError {
  return workflowError(
    'TASK_DIFF_REVIEW_STORE_UNSAFE',
    'TaskDiffReview durable state is missing, malformed, or unsafe.',
    ExitCode.guard,
  );
}
