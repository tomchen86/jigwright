/**
 * Validates review reservation and result envelopes against their embedded authority.
 *
 * Invariants:
 * - Digests bind the exact record, manifest, subject, and provider request.
 * - Continuation validation retains review, response, and provider identity checks.
 *
 * Depends on: Review manifests, provider invocation contracts, and TaskDiff assurance schemas.
 * Failure modes: A valid-looking envelope admits mismatched providers, stale responses, or altered evidence.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertInvestigationId,
  assertSessionId,
  assertInvocationId,
} from '../session-workspace/paths.ts';
import { recreateProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  ProviderRoleAssignment,
  RecordedRoleParticipant,
  AdmittedRoleResult,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  parseTaskDiffReviewRecord,
  assertTaskDiffReviewChallengeResponseCurrent,
  parseTaskDiffReviewChallengeResponseRecord,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  parseTaskDiffReviewContinuationSubmission,
  parseTaskDiffFinalAssuranceRecord,
  type TaskDiffReviewRecord,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import { parseTaskDiffReviewSubject } from '../../modules/assurance/task-diff-review.ts';
import {
  type TaskDiffReviewReservationRecord,
  isRecord,
  hasExactKeys,
  isDigest,
  isAbsolutePath,
  isIdentity,
  isTimestamp,
  storeUnsafe,
  sha256,
  withoutDigest,
  deepFreeze,
  type TaskDiffReviewResultBinding,
  type TaskDiffReviewContinuationReservationRecord,
  type TaskDiffReviewContinuationResultBinding,
  type TaskDiffFinalAssuranceBinding,
} from './task-diff-review-store-contracts.ts';
import {
  parseManifest,
  parseParticipant,
  parseMandateBinding,
  parseBaseline,
  parseContinuationManifest,
} from './task-diff-review-manifest-codec.ts';

export function parseTaskDiffReviewReservation(
  value: unknown,
): TaskDiffReviewReservationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'mandateBinding',
      'subject',
      'implementationActor',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isAbsolutePath(value.repositoryRoot) ||
    !isAbsolutePath(value.gitCommonDirectory) ||
    !isIdentity(value.branch) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw storeUnsafe();
  }
  const ownerInvestigationId = assertInvestigationId(
    value.ownerInvestigationId,
  );
  const sessionId = assertSessionId(value.sessionId);
  const subject = parseTaskDiffReviewSubject(value.subject);
  const request = recreateProviderInvocationRequest(value.request);
  const manifest = parseManifest(value.manifest);
  const implementationActor = parseParticipant(value.implementationActor);
  const mandateBinding = parseMandateBinding(
    value.mandateBinding,
    value.changeId,
  );
  const baseline = parseBaseline(value.baseline);
  const record: TaskDiffReviewReservationRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-reservation.v1',
    reservationDigest: value.reservationDigest,
    ownerInvestigationId,
    sessionId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    branch: value.branch,
    baseline,
    mandateBinding,
    subject,
    implementationActor,
    manifest,
    request,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
    createdAt: value.createdAt,
  };
  if (
    subject.changeId !== record.changeId ||
    subject.taskId !== record.taskId ||
    subject.baseCommit !== baseline.head ||
    subject.baseTree !== baseline.tree ||
    manifest.changeId !== record.changeId ||
    manifest.taskId !== record.taskId ||
    manifest.sessionId !== sessionId ||
    manifest.repositoryIdentity !== subject.repositoryId ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    request.invocationId !== assertInvocationId(request.invocationId) ||
    request.authorizationNodeId !== record.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    !taskDiffRoleAssignmentMatchesReservation(
      request.roleAssignment,
      implementationActor,
      subject.subjectDigest,
      request.providerId,
    ) ||
    record.reservationDigest !==
      sha256(canonicalJson(withoutDigest(record, 'reservationDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
}

export function parseTaskDiffReviewResultBinding(
  value: unknown,
): TaskDiffReviewResultBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'ownerInvestigationId',
      'sessionId',
      'subjectDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'runtimeObservationDigest',
      'providerObservationNodeId',
      'providerObservationDigest',
      'providerResultNodeId',
      'providerResultDigest',
      'roleResult',
      'review',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerObservationNodeId) ||
    !isDigest(value.providerObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isAdmittedTaskDiffRoleResultShape(value.roleResult) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const review = parseTaskDiffReviewRecord(value.review);
  const binding: TaskDiffReviewResultBinding = {
    schemaVersion: 1,
    kind: 'task-diff-review-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: assertInvestigationId(value.ownerInvestigationId),
    sessionId: assertSessionId(value.sessionId),
    subjectDigest: value.subjectDigest,
    invocationId: assertInvocationId(value.invocationId),
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerObservationNodeId: value.providerObservationNodeId,
    providerObservationDigest: value.providerObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    roleResult: structuredClone(value.roleResult),
    review,
    createdAt: value.createdAt,
  };
  if (
    review.subjectDigest !== binding.subjectDigest ||
    binding.roleResult.targetDigest !== binding.subjectDigest ||
    binding.roleResult.role !== 'task-diff-reviewer' ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

export function parseTaskDiffReviewContinuationReservation(
  value: unknown,
): TaskDiffReviewContinuationReservationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'ownerInvestigationId',
      'sessionId',
      'changeId',
      'taskId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'mandateBinding',
      'subject',
      'implementationActor',
      'review',
      'response',
      'manifest',
      'request',
      'authorizationNodeId',
      'reservationNodeId',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-reservation.v1' ||
    !isDigest(value.reservationDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isAbsolutePath(value.repositoryRoot) ||
    !isAbsolutePath(value.gitCommonDirectory) ||
    !isIdentity(value.branch) ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw storeUnsafe();
  }
  const ownerInvestigationId = assertInvestigationId(
    value.ownerInvestigationId,
  );
  const sessionId = assertSessionId(value.sessionId);
  const subject = parseTaskDiffReviewSubject(value.subject);
  const review = parseTaskDiffReviewRecord(value.review);
  const response = assertTaskDiffReviewChallengeResponseCurrent(
    review,
    parseTaskDiffReviewChallengeResponseRecord(value.response),
  );
  const manifest = parseContinuationManifest(value.manifest);
  const request = recreateProviderInvocationRequest(value.request);
  const implementationActor = parseParticipant(value.implementationActor);
  const mandateBinding = parseMandateBinding(
    value.mandateBinding,
    value.changeId,
  );
  const baseline = parseBaseline(value.baseline);
  const record: TaskDiffReviewContinuationReservationRecord = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-reservation.v1',
    reservationDigest: value.reservationDigest,
    ownerInvestigationId,
    sessionId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryRoot: value.repositoryRoot,
    gitCommonDirectory: value.gitCommonDirectory,
    branch: value.branch,
    baseline,
    mandateBinding,
    subject,
    implementationActor,
    review,
    response,
    manifest,
    request,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
    createdAt: value.createdAt,
  };
  if (
    subject.changeId !== record.changeId ||
    subject.taskId !== record.taskId ||
    subject.baseCommit !== baseline.head ||
    subject.baseTree !== baseline.tree ||
    review.subjectDigest !== subject.subjectDigest ||
    response.subjectDigest !== subject.subjectDigest ||
    manifest.changeId !== record.changeId ||
    manifest.taskId !== record.taskId ||
    manifest.sessionId !== sessionId ||
    manifest.repositoryIdentity !== subject.repositoryId ||
    canonicalJson(manifest.subject) !== canonicalJson(subject) ||
    canonicalJson(manifest.review) !== canonicalJson(review) ||
    canonicalJson(manifest.response) !== canonicalJson(response) ||
    request.invocationId !== assertInvocationId(request.invocationId) ||
    request.authorizationNodeId !== record.authorizationNodeId ||
    request.targetDigest !== subject.subjectDigest ||
    request.inputManifestDigest !== sha256(canonicalJson(manifest)) ||
    !continuationProviderMatchesReview(
      review,
      implementationActor,
      request.providerId,
    ) ||
    request.roleAssignment.role !== 'task-diff-reviewer' ||
    !continuationProviderMatchesReview(
      review,
      implementationActor,
      request.roleAssignment.providerId,
    ) ||
    request.roleAssignment.sessionId === review.assignment.reviewerSessionId ||
    request.outputSchema.id !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id ||
    request.outputSchema.version !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version ||
    request.outputSchema.digest !==
      TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest ||
    record.reservationDigest !==
      sha256(canonicalJson(withoutDigest(record, 'reservationDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(record);
}

export function parseTaskDiffReviewContinuationResultBinding(
  value: unknown,
): TaskDiffReviewContinuationResultBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'ownerInvestigationId',
      'sessionId',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'runtimeObservationDigest',
      'providerResultNodeId',
      'providerResultDigest',
      'submission',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-review-continuation-result-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    typeof value.ownerInvestigationId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.reviewRecordDigest) ||
    !isDigest(value.responseDigest) ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.runtimeObservationDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const submission = parseTaskDiffReviewContinuationSubmission(
    value.submission,
  );
  const binding: TaskDiffReviewContinuationResultBinding = {
    schemaVersion: 1,
    kind: 'task-diff-review-continuation-result-binding.v1',
    bindingDigest: value.bindingDigest,
    ownerInvestigationId: assertInvestigationId(value.ownerInvestigationId),
    sessionId: assertSessionId(value.sessionId),
    subjectDigest: value.subjectDigest,
    reviewRecordDigest: value.reviewRecordDigest,
    responseDigest: value.responseDigest,
    invocationId: assertInvocationId(value.invocationId),
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    runtimeObservationDigest: value.runtimeObservationDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
    submission,
    createdAt: value.createdAt,
  };
  if (
    submission.reviewRecordDigest !== binding.reviewRecordDigest ||
    submission.responseDigest !== binding.responseDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

export function parseTaskDiffFinalAssuranceBinding(
  value: unknown,
): TaskDiffFinalAssuranceBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'subjectDigest',
      'assuranceNodeId',
      'assuranceResultDigest',
      'assurance',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-final-assurance-binding.v1' ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.assuranceNodeId) ||
    !isDigest(value.assuranceResultDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw storeUnsafe();
  }
  const assurance = parseTaskDiffFinalAssuranceRecord(value.assurance);
  const binding: TaskDiffFinalAssuranceBinding = {
    schemaVersion: 1,
    kind: 'task-diff-final-assurance-binding.v1',
    bindingDigest: value.bindingDigest,
    subjectDigest: value.subjectDigest,
    assuranceNodeId: value.assuranceNodeId,
    assuranceResultDigest: value.assuranceResultDigest,
    assurance,
    createdAt: value.createdAt,
  };
  if (
    assurance.subjectDigest !== binding.subjectDigest ||
    binding.bindingDigest !==
      sha256(canonicalJson(withoutDigest(binding, 'bindingDigest')))
  ) {
    throw storeUnsafe();
  }
  return deepFreeze(binding);
}

function taskDiffRoleAssignmentMatchesReservation(
  assignment: ProviderRoleAssignment,
  implementationActor: RecordedRoleParticipant,
  subjectDigest: string,
  providerId: ProviderId,
): boolean {
  if (
    assignment.role !== 'task-diff-reviewer' ||
    assignment.providerId !== providerId ||
    assignment.targetDigest !== subjectDigest
  ) {
    return false;
  }
  if (!('grantId' in assignment)) {
    return (
      assignment.requiredIndependence === 'session-independent' &&
      (assignment.achievedIndependence === 'provider-independent' ||
        assignment.achievedIndependence === 'session-independent')
    );
  }
  return (
    assignment.requiredIndependence === 'provider-independent' &&
    assignment.degradedForm === 'same-provider-fresh-session' &&
    assignment.achievedIndependence === 'session-independent' &&
    assignment.providerIndependent === false &&
    assignment.sessionIndependent === true &&
    assignment.engineSpawned === true &&
    assignment.orchestration === 'engine-spawned-provider' &&
    assignment.author.providerId === implementationActor.providerId &&
    assignment.author.sessionId === implementationActor.sessionId &&
    assignment.participant.providerId === providerId &&
    assignment.participant.sessionId === assignment.sessionId &&
    assignment.participant.engineSpawned === true
  );
}

function continuationProviderMatchesReview(
  review: TaskDiffReviewRecord,
  implementationActor: RecordedRoleParticipant,
  providerId: ProviderId,
): boolean {
  const originalReviewer = review.assignment.reviewerProviderId;
  if (originalReviewer === null) return true;
  const implementationProvider =
    implementationActor.providerId ?? review.assignment.implementerProviderId;
  return originalReviewer === implementationProvider
    ? providerId !== implementationProvider
    : providerId === originalReviewer;
}

function isAdmittedTaskDiffRoleResultShape(
  value: unknown,
): value is AdmittedRoleResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'form',
      'role',
      'targetDigest',
      'assignment',
      'author',
      'participant',
      'orchestration',
      'requiredIndependence',
      'achievedIndependence',
      'content',
      'providerInvocation',
      'grantUse',
      'directHumanReviewAttestation',
      'resultDigest',
    ]) &&
    value.schemaVersion === 1 &&
    value.role === 'task-diff-reviewer' &&
    isDigest(value.targetDigest) &&
    isDigest(value.resultDigest) &&
    isRecord(value.assignment) &&
    isRecord(value.author) &&
    isRecord(value.participant) &&
    isRecord(value.content)
  );
}
