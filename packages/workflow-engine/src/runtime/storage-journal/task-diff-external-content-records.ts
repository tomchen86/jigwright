/**
 * Constructs and validates immutable external submissions and challenge responses.
 *
 * Invariants:
 * - Content remains bound to its exact subject, review, and response digests.
 * - Content records carry no admission, grant, or closure authority.
 */
import {
  parseTaskDiffReviewChallengeResponseRecord,
  parseTaskDiffReviewSubmission,
  parseTaskDiffReviewContinuationSubmission,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewSubmission,
  TaskDiffReviewContinuationSubmission,
} from '../../modules/assurance/task-diff-review-artifact-record.ts';
import { parseTaskDiffReviewScope } from '../../modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewScope } from '../../modules/assurance/task-diff-review-record.ts';
import {
  type PrepareTaskDiffExternalChallengeResponseInput,
  type TaskDiffExternalChallengeResponse,
  parseSubject,
  storeInvalid,
  digestRecord,
  type PrepareTaskDiffExternalReviewSubmissionInput,
  type TaskDiffExternalReviewSubmission,
  assertDigest,
  type PrepareTaskDiffExternalClosureSubmissionInput,
  type TaskDiffExternalClosureSubmission,
  isRecord,
  hasExactKeys,
  withoutDigest,
  deepFreeze,
} from './task-diff-external-store-contracts.ts';
import { taskDiffExternalContinuationTargetDigest } from './task-diff-external-authority-records.ts';

export function prepareTaskDiffExternalChallengeResponse(
  input: PrepareTaskDiffExternalChallengeResponseInput,
): TaskDiffExternalChallengeResponse {
  const subject = parseSubject(input.subject);
  const response = parseChallengeResponse(input.response);
  if (response.subjectDigest !== subject.subjectDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-challenge-response.v1' as const,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: response.reviewRecordDigest,
    responseDigest: response.responseDigest,
    response,
  };
  return parseTaskDiffExternalChallengeResponse({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalReviewSubmission(
  input: PrepareTaskDiffExternalReviewSubmissionInput,
): TaskDiffExternalReviewSubmission {
  const subject = parseSubject(input.subject);
  const reviewScope = parseReviewScope(input.reviewScope);
  const submission = parseSubmission(input.submission);
  if (reviewScope.currentSubjectDigest !== subject.subjectDigest) {
    throw storeInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-submission.v1' as const,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewScope,
    reviewScopeDigest: reviewScope.scopeDigest,
    submission,
    inputDigest: assertDigest(input.inputDigest),
  };
  return parseTaskDiffExternalReviewSubmission({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalClosureSubmission(
  input: PrepareTaskDiffExternalClosureSubmissionInput,
): TaskDiffExternalClosureSubmission {
  const subject = parseSubject(input.subject);
  const submission = parseContinuationSubmission(input.submission);
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: submission.reviewRecordDigest,
    responseDigest: submission.responseDigest,
  });
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-closure-submission.v1' as const,
    targetDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: submission.reviewRecordDigest,
    responseDigest: submission.responseDigest,
    submission,
    inputDigest: assertDigest(input.inputDigest),
  };
  return parseTaskDiffExternalClosureSubmission({
    ...body,
    recordDigest: digestRecord(body),
  });
}

export function parseTaskDiffExternalChallengeResponse(
  value: unknown,
): TaskDiffExternalChallengeResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subject',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'response',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-challenge-response.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const response = parseChallengeResponse(value.response);
  const record: TaskDiffExternalChallengeResponse = {
    schemaVersion: 1,
    kind: 'task-diff-external-challenge-response.v1',
    recordDigest: assertDigest(value.recordDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    response,
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    response.subjectDigest !== subject.subjectDigest ||
    record.reviewRecordDigest !== response.reviewRecordDigest ||
    record.responseDigest !== response.responseDigest ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalReviewSubmission(
  value: unknown,
): TaskDiffExternalReviewSubmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'subject',
      'subjectDigest',
      'reviewScope',
      'reviewScopeDigest',
      'submission',
      'inputDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-submission.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const reviewScope = parseReviewScope(value.reviewScope);
  const record: TaskDiffExternalReviewSubmission = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-submission.v1',
    recordDigest: assertDigest(value.recordDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewScope,
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submission: parseSubmission(value.submission),
    inputDigest: assertDigest(value.inputDigest),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    reviewScope.currentSubjectDigest !== subject.subjectDigest ||
    record.reviewScopeDigest !== reviewScope.scopeDigest ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalClosureSubmission(
  value: unknown,
): TaskDiffExternalClosureSubmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'recordDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'submission',
      'inputDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-closure-submission.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const submission = parseContinuationSubmission(value.submission);
  const record: TaskDiffExternalClosureSubmission = {
    schemaVersion: 1,
    kind: 'task-diff-external-closure-submission.v1',
    recordDigest: assertDigest(value.recordDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    submission,
    inputDigest: assertDigest(value.inputDigest),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    record.reviewRecordDigest !== submission.reviewRecordDigest ||
    record.responseDigest !== submission.responseDigest ||
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.recordDigest !== digestRecord(withoutDigest(record, 'recordDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

function parseChallengeResponse(
  value: unknown,
): TaskDiffReviewChallengeResponseRecord {
  try {
    return parseTaskDiffReviewChallengeResponseRecord(value);
  } catch {
    throw storeInvalid();
  }
}

function parseReviewScope(value: unknown): TaskDiffReviewScope {
  try {
    return parseTaskDiffReviewScope(value);
  } catch {
    throw storeInvalid();
  }
}

function parseSubmission(value: unknown): TaskDiffReviewSubmission {
  try {
    return parseTaskDiffReviewSubmission(value);
  } catch {
    throw storeInvalid();
  }
}

function parseContinuationSubmission(
  value: unknown,
): TaskDiffReviewContinuationSubmission {
  try {
    return parseTaskDiffReviewContinuationSubmission(value);
  } catch {
    throw storeInvalid();
  }
}
