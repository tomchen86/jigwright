/**
 * Validates stored review manifests and their repository, actor, and mandate context.
 *
 * Invariants:
 * - Manifest keys and repository baselines retain their exact validation.
 * - Actor and mandate context remain immutable and bound to the requested change.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { RecordedRoleParticipant } from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  parseTaskDiffReviewRecord,
  assertTaskDiffReviewChallengeResponseCurrent,
  parseTaskDiffReviewChallengeResponseRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewSubject,
  parseTaskDiffReviewScope,
} from '../../modules/assurance/task-diff-review.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import {
  type TaskDiffReviewManifestSnapshot,
  isRecord,
  hasExactKeys,
  isIdentity,
  GIT_OBJECT_ID,
  storeUnsafe,
  deepFreeze,
  type TaskDiffReviewContinuationManifestSnapshot,
  isProviderIdOrNull,
  isIdentityOrNull,
  isDigest,
  isAbsolutePath,
} from './task-diff-review-store-contracts.ts';

export function parseManifest(value: unknown): TaskDiffReviewManifestSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'reviewScope',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-manifest' ||
    !isIdentity(value.changeId) ||
    !isIdentity(value.taskId) ||
    !isIdentity(value.sessionId) ||
    !isIdentity(value.repositoryId) ||
    !isIdentity(value.repositoryIdentity) ||
    !GIT_OBJECT_ID.test(String(value.baseCommit)) ||
    !GIT_OBJECT_ID.test(String(value.baseTree)) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw storeUnsafe();
  }
  const subject = parseTaskDiffReviewSubject(value.subject);
  const reviewScope = parseTaskDiffReviewScope(value.reviewScope);
  if (reviewScope.currentSubjectDigest !== subject.subjectDigest) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit as string,
    baseTree: value.baseTree as string,
    subject,
    reviewScope,
    capabilityProfile: 'repository-read-only',
  });
}

export function parseContinuationManifest(
  value: unknown,
): TaskDiffReviewContinuationManifestSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'taskId',
      'sessionId',
      'repositoryId',
      'repositoryIdentity',
      'baseCommit',
      'baseTree',
      'subject',
      'review',
      'response',
      'capabilityProfile',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-manifest' ||
    !isIdentity(value.changeId) ||
    !isIdentity(value.taskId) ||
    !isIdentity(value.sessionId) ||
    !isIdentity(value.repositoryId) ||
    !isIdentity(value.repositoryIdentity) ||
    !GIT_OBJECT_ID.test(String(value.baseCommit)) ||
    !GIT_OBJECT_ID.test(String(value.baseTree)) ||
    value.capabilityProfile !== 'repository-read-only'
  ) {
    throw storeUnsafe();
  }
  const subject = parseTaskDiffReviewSubject(value.subject);
  const review = parseTaskDiffReviewRecord(value.review);
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    review,
    parseTaskDiffReviewChallengeResponseRecord(value.response),
  );
  if (
    subject.changeId !== value.changeId ||
    subject.taskId !== value.taskId ||
    subject.repositoryId !== value.repositoryIdentity ||
    subject.baseCommit !== value.baseCommit ||
    subject.baseTree !== value.baseTree ||
    review.subjectDigest !== subject.subjectDigest ||
    canonicalJson(review.subject) !== canonicalJson(subject)
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-manifest',
    changeId: value.changeId,
    taskId: value.taskId,
    sessionId: value.sessionId,
    repositoryId: value.repositoryId,
    repositoryIdentity: value.repositoryIdentity,
    baseCommit: value.baseCommit as string,
    baseTree: value.baseTree as string,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only',
  });
}

export function parseParticipant(value: unknown): RecordedRoleParticipant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    !isProviderIdOrNull(value.providerId) ||
    !isIdentityOrNull(value.sessionId) ||
    !isIdentityOrNull(value.principalId) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    providerId: value.providerId,
    sessionId: value.sessionId,
    principalId: value.principalId,
    identityAssurance:
      value.identityAssurance as RecordedRoleParticipant['identityAssurance'],
    engineSpawned: value.engineSpawned,
  });
}

export function parseMandateBinding(
  value: unknown,
  expectedChangeId: unknown,
): TaskMandateBinding | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    !isIdentity(value.mandateTaskId) ||
    !isIdentity(value.mandateId) ||
    !isDigest(value.mandateDigest) ||
    value.changeId !== expectedChangeId ||
    !isIdentity(value.changeId) ||
    !isAbsolutePath(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot ||
    Buffer.byteLength(value.externalAuditRoot) > 4096 ||
    value.externalAuditRoot.includes('\0')
  ) {
    throw storeUnsafe();
  }
  return deepFreeze({
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: value.changeId,
    externalAuditRoot: value.externalAuditRoot,
  });
}

export function parseBaseline(
  value: unknown,
): Readonly<{ head: string; tree: string }> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['head', 'tree']) ||
    !GIT_OBJECT_ID.test(String(value.head)) ||
    !GIT_OBJECT_ID.test(String(value.tree))
  ) {
    throw storeUnsafe();
  }
  return Object.freeze({
    head: value.head as string,
    tree: value.tree as string,
  });
}
