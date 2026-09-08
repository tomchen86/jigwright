/**
 * Defines immutable external review records and shared subject and identity validation.
 *
 * Invariants:
 * - Content and authority retain their distinct record schemas.
 * - Digest operations and malformed-store errors remain exact.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewSubmission,
  TaskDiffReviewContinuationSubmission,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  type TaskDiffReviewSubject,
  type TaskDiffReviewScope,
  parseTaskDiffReviewSubject,
} from '../../modules/assurance/task-diff-review.ts';
import type { RecordedRoleParticipant } from '../../modules/provider-orchestration/role-scheduler.ts';

const DIGEST = /^[0-9a-f]{64}$/u;

export type TaskDiffExternalDegradedForm =
  'caller-supplied' | 'direct-human-review';

export type TaskDiffExternalGrantReference = Readonly<{
  degradedForm: TaskDiffExternalDegradedForm;
  grantId: string;
  grantEnvelopeDigest: string;
  grantTransitionDigest: string;
  grantTargetDigest: string;
}>;

export type TaskDiffExternalReviewReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-reservation.v1';
  reservationDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  implementationActor: RecordedRoleParticipant;
  grant: TaskDiffExternalGrantReference;
}>;

export type TaskDiffExternalReviewBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-binding.v1';
  bindingDigest: string;
  reservationDigest: string;
  targetDigest: string;
  subjectDigest: string;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  grant: TaskDiffExternalGrantReference;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
  reviewRecordDigest: string;
}>;

export type TaskDiffExternalContinuationReservation = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-continuation-reservation.v1';
  reservationDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  grant: TaskDiffExternalGrantReference;
}>;

/**
 * This binding authenticates only the external continuation contribution.
 * It deliberately records no disposition, verdict, or closure state. The
 * governing TaskDiff validator remains the only place that may close a
 * challenge or mint Final Assurance.
 */
export type TaskDiffExternalContinuationBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-continuation-binding.v1';
  bindingDigest: string;
  reservationDigest: string;
  targetDigest: string;
  subjectDigest: string;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  grant: TaskDiffExternalGrantReference;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
}>;

/**
 * Immutable external response content only. This record binds the complete
 * TaskDiff challenge response to its exact review and subject, but carries no
 * admission, identity, grant, disposition, or closure authority.
 */
export type TaskDiffExternalChallengeResponse = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-challenge-response.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  response: TaskDiffReviewChallengeResponseRecord;
}>;

/** Authority-free review content awaiting a separately authenticated role. */
export type TaskDiffExternalReviewSubmission = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-review-submission.v1';
  recordDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewScope: TaskDiffReviewScope;
  reviewScopeDigest: string;
  submission: TaskDiffReviewSubmission;
  inputDigest: string;
}>;

/**
 * Immutable authority-free continuation content. `proposedDispositions` are
 * advisory reviewer output only; this record has no identity, grant, closure,
 * or Final Assurance authority.
 */
export type TaskDiffExternalClosureSubmission = Readonly<{
  schemaVersion: 1;
  kind: 'task-diff-external-closure-submission.v1';
  recordDigest: string;
  targetDigest: string;
  subject: TaskDiffReviewSubject;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  submission: TaskDiffReviewContinuationSubmission;
  inputDigest: string;
}>;

export type PrepareTaskDiffExternalReviewReservationInput = Readonly<{
  subject: TaskDiffReviewSubject;
  policyDigest: string;
  inputDigest: string;
  reviewScopeDigest: string;
  submissionRecordDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  implementationActor: RecordedRoleParticipant;
  grant: TaskDiffExternalGrantReference;
}>;

export type PrepareTaskDiffExternalReviewBindingInput = Readonly<{
  reservation: TaskDiffExternalReviewReservation;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
  reviewRecordDigest: string;
}>;

export type PrepareTaskDiffExternalContinuationReservationInput = Readonly<{
  subject: TaskDiffReviewSubject;
  policyDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
  inputDigest: string;
  contentNodeId: string;
  contentResultDigest: string;
  grant: TaskDiffExternalGrantReference;
}>;

export type PrepareTaskDiffExternalContinuationBindingInput = Readonly<{
  reservation: TaskDiffExternalContinuationReservation;
  grantUseDigest: string;
  admittedRoleResultDigest: string;
  directHumanReviewAttestationDigest: string | null;
  contentNodeId: string;
  contentResultDigest: string;
  authorityNodeId: string;
  authorityResultDigest: string;
}>;

export type PrepareTaskDiffExternalChallengeResponseInput = Readonly<{
  subject: TaskDiffReviewSubject;
  response: TaskDiffReviewChallengeResponseRecord;
}>;

export type PrepareTaskDiffExternalReviewSubmissionInput = Readonly<{
  subject: TaskDiffReviewSubject;
  reviewScope: TaskDiffReviewScope;
  submission: TaskDiffReviewSubmission;
  inputDigest: string;
}>;

export type PrepareTaskDiffExternalClosureSubmissionInput = Readonly<{
  subject: TaskDiffReviewSubject;
  submission: TaskDiffReviewContinuationSubmission;
  inputDigest: string;
}>;

export function parseSubject(value: unknown): TaskDiffReviewSubject {
  try {
    return parseTaskDiffReviewSubject(value);
  } catch {
    throw storeInvalid();
  }
}

export function parseRecordedParticipant(
  value: unknown,
): RecordedRoleParticipant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    (value.providerId !== null &&
      value.providerId !== 'codex' &&
      value.providerId !== 'claude') ||
    (value.sessionId !== null &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        value.principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw storeInvalid();
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

export function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw storeInvalid();
  }
  return value;
}

export function digestRecord(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function withoutDigest<T extends Record<string, unknown>>(
  value: T,
  key: keyof T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return canonicalJson(actual) === canonicalJson(expected);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function storeInvalid() {
  return workflowError(
    'TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID',
    'TaskDiff external review authority state is invalid.',
    ExitCode.verification,
    {
      recovery:
        'Inspect the exact collaboration grant, external review reservation, and admitted role-result evidence; do not edit runtime records by hand.',
    },
  );
}
