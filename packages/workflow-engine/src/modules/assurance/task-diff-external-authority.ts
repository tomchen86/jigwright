/**
 * Constructs and validates external review and continuation grant bindings.
 *
 * Invariants:
 * - Bindings retain their exact reservation, target, grant, and attestation identities.
 * - Continuation contribution records contain no independent verdict or closure authority.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  sha256,
  assertDigest,
  type PrepareTaskDiffExternalReviewReservationInput,
  type TaskDiffExternalReviewReservation,
  parseSubject,
  storeInvalid,
  parseRecordedParticipant,
  digestRecord,
  type PrepareTaskDiffExternalReviewBindingInput,
  type TaskDiffExternalReviewBinding,
  type PrepareTaskDiffExternalContinuationReservationInput,
  type TaskDiffExternalContinuationReservation,
  type PrepareTaskDiffExternalContinuationBindingInput,
  type TaskDiffExternalContinuationBinding,
  isRecord,
  hasExactKeys,
  withoutDigest,
  deepFreeze,
  type TaskDiffExternalGrantReference,
  type TaskDiffExternalDegradedForm,
} from './task-diff-external-record.ts';

const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function taskDiffExternalContinuationTargetDigest(input: {
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
}): string {
  return sha256(
    canonicalJson({
      schema: 'workflow.task-diff-external-continuation-target.v1',
      subjectDigest: assertDigest(input.subjectDigest),
      reviewRecordDigest: assertDigest(input.reviewRecordDigest),
      responseDigest: assertDigest(input.responseDigest),
    }),
  );
}

export function prepareTaskDiffExternalReviewReservation(
  input: PrepareTaskDiffExternalReviewReservationInput,
): TaskDiffExternalReviewReservation {
  const subject = parseSubject(input.subject);
  const policyDigest = assertDigest(input.policyDigest);
  if (policyDigest !== subject.reviewPolicyDigest) throw storeInvalid();
  const grant = parseGrantReference(input.grant);
  if (grant.grantTargetDigest !== subject.subjectDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-reservation.v1' as const,
    targetDigest: subject.subjectDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    policyDigest,
    inputDigest: assertDigest(input.inputDigest),
    reviewScopeDigest: assertDigest(input.reviewScopeDigest),
    submissionRecordDigest: assertDigest(input.submissionRecordDigest),
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    implementationActor: parseRecordedParticipant(input.implementationActor),
    grant,
  };
  return parseTaskDiffExternalReviewReservation({
    ...body,
    reservationDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalReviewBinding(
  input: PrepareTaskDiffExternalReviewBindingInput,
): TaskDiffExternalReviewBinding {
  const reservation = parseTaskDiffExternalReviewReservation(input.reservation);
  const directHumanReviewAttestationDigest = parseAttestationDigest(
    reservation.grant.degradedForm,
    input.directHumanReviewAttestationDigest,
  );
  if (
    assertDigest(input.contentNodeId) !== reservation.contentNodeId ||
    assertDigest(input.contentResultDigest) !== reservation.contentResultDigest
  ) {
    throw storeInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-review-binding.v1' as const,
    reservationDigest: reservation.reservationDigest,
    targetDigest: reservation.targetDigest,
    subjectDigest: reservation.subjectDigest,
    policyDigest: reservation.policyDigest,
    inputDigest: reservation.inputDigest,
    reviewScopeDigest: reservation.reviewScopeDigest,
    submissionRecordDigest: reservation.submissionRecordDigest,
    grant: reservation.grant,
    grantUseDigest: assertDigest(input.grantUseDigest),
    admittedRoleResultDigest: assertDigest(input.admittedRoleResultDigest),
    directHumanReviewAttestationDigest,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    authorityNodeId: assertDigest(input.authorityNodeId),
    authorityResultDigest: assertDigest(input.authorityResultDigest),
    reviewRecordDigest: assertDigest(input.reviewRecordDigest),
  };
  return parseTaskDiffExternalReviewBinding({
    ...body,
    bindingDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalContinuationReservation(
  input: PrepareTaskDiffExternalContinuationReservationInput,
): TaskDiffExternalContinuationReservation {
  const subject = parseSubject(input.subject);
  const policyDigest = assertDigest(input.policyDigest);
  const reviewRecordDigest = assertDigest(input.reviewRecordDigest);
  const responseDigest = assertDigest(input.responseDigest);
  if (policyDigest !== subject.reviewPolicyDigest) throw storeInvalid();
  const targetDigest = taskDiffExternalContinuationTargetDigest({
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest,
    responseDigest,
  });
  const grant = parseGrantReference(input.grant);
  if (grant.grantTargetDigest !== targetDigest) throw storeInvalid();
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-continuation-reservation.v1' as const,
    targetDigest,
    subject,
    subjectDigest: subject.subjectDigest,
    policyDigest,
    reviewRecordDigest,
    responseDigest,
    inputDigest: assertDigest(input.inputDigest),
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    grant,
  };
  return parseTaskDiffExternalContinuationReservation({
    ...body,
    reservationDigest: digestRecord(body),
  });
}

export function prepareTaskDiffExternalContinuationBinding(
  input: PrepareTaskDiffExternalContinuationBindingInput,
): TaskDiffExternalContinuationBinding {
  const reservation = parseTaskDiffExternalContinuationReservation(
    input.reservation,
  );
  const directHumanReviewAttestationDigest = parseAttestationDigest(
    reservation.grant.degradedForm,
    input.directHumanReviewAttestationDigest,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-external-continuation-binding.v1' as const,
    reservationDigest: reservation.reservationDigest,
    targetDigest: reservation.targetDigest,
    subjectDigest: reservation.subjectDigest,
    policyDigest: reservation.policyDigest,
    reviewRecordDigest: reservation.reviewRecordDigest,
    responseDigest: reservation.responseDigest,
    inputDigest: reservation.inputDigest,
    grant: reservation.grant,
    grantUseDigest: assertDigest(input.grantUseDigest),
    admittedRoleResultDigest: assertDigest(input.admittedRoleResultDigest),
    directHumanReviewAttestationDigest,
    contentNodeId: assertDigest(input.contentNodeId),
    contentResultDigest: assertDigest(input.contentResultDigest),
    authorityNodeId: assertDigest(input.authorityNodeId),
    authorityResultDigest: assertDigest(input.authorityResultDigest),
  };
  return parseTaskDiffExternalContinuationBinding({
    ...body,
    bindingDigest: digestRecord(body),
  });
}

export function parseTaskDiffExternalReviewReservation(
  value: unknown,
): TaskDiffExternalReviewReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'policyDigest',
      'inputDigest',
      'reviewScopeDigest',
      'submissionRecordDigest',
      'contentNodeId',
      'contentResultDigest',
      'implementationActor',
      'grant',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-reservation.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const record: TaskDiffExternalReviewReservation = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-reservation.v1',
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    inputDigest: assertDigest(value.inputDigest),
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submissionRecordDigest: assertDigest(value.submissionRecordDigest),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    implementationActor: parseRecordedParticipant(value.implementationActor),
    grant: parseGrantReference(value.grant),
  };
  if (
    record.targetDigest !== subject.subjectDigest ||
    record.subjectDigest !== subject.subjectDigest ||
    record.policyDigest !== subject.reviewPolicyDigest ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.reservationDigest !==
      digestRecord(withoutDigest(record, 'reservationDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalReviewBinding(
  value: unknown,
): TaskDiffExternalReviewBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'reservationDigest',
      'targetDigest',
      'subjectDigest',
      'policyDigest',
      'inputDigest',
      'reviewScopeDigest',
      'submissionRecordDigest',
      'grant',
      'grantUseDigest',
      'admittedRoleResultDigest',
      'directHumanReviewAttestationDigest',
      'contentNodeId',
      'contentResultDigest',
      'authorityNodeId',
      'authorityResultDigest',
      'reviewRecordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-review-binding.v1'
  ) {
    throw storeInvalid();
  }
  const grant = parseGrantReference(value.grant);
  const record: TaskDiffExternalReviewBinding = {
    schemaVersion: 1,
    kind: 'task-diff-external-review-binding.v1',
    bindingDigest: assertDigest(value.bindingDigest),
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    inputDigest: assertDigest(value.inputDigest),
    reviewScopeDigest: assertDigest(value.reviewScopeDigest),
    submissionRecordDigest: assertDigest(value.submissionRecordDigest),
    grant,
    grantUseDigest: assertDigest(value.grantUseDigest),
    admittedRoleResultDigest: assertDigest(value.admittedRoleResultDigest),
    directHumanReviewAttestationDigest: parseAttestationDigest(
      grant.degradedForm,
      value.directHumanReviewAttestationDigest,
    ),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    authorityNodeId: assertDigest(value.authorityNodeId),
    authorityResultDigest: assertDigest(value.authorityResultDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
  };
  if (
    record.targetDigest !== record.subjectDigest ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.bindingDigest !==
      digestRecord(withoutDigest(record, 'bindingDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalContinuationReservation(
  value: unknown,
): TaskDiffExternalContinuationReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'reservationDigest',
      'targetDigest',
      'subject',
      'subjectDigest',
      'policyDigest',
      'reviewRecordDigest',
      'responseDigest',
      'inputDigest',
      'contentNodeId',
      'contentResultDigest',
      'grant',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-continuation-reservation.v1'
  ) {
    throw storeInvalid();
  }
  const subject = parseSubject(value.subject);
  const record: TaskDiffExternalContinuationReservation = {
    schemaVersion: 1,
    kind: 'task-diff-external-continuation-reservation.v1',
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subject,
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    inputDigest: assertDigest(value.inputDigest),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    grant: parseGrantReference(value.grant),
  };
  if (
    record.subjectDigest !== subject.subjectDigest ||
    record.policyDigest !== subject.reviewPolicyDigest ||
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.reservationDigest !==
      digestRecord(withoutDigest(record, 'reservationDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function parseTaskDiffExternalContinuationBinding(
  value: unknown,
): TaskDiffExternalContinuationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'bindingDigest',
      'reservationDigest',
      'targetDigest',
      'subjectDigest',
      'policyDigest',
      'reviewRecordDigest',
      'responseDigest',
      'inputDigest',
      'contentNodeId',
      'contentResultDigest',
      'grant',
      'grantUseDigest',
      'admittedRoleResultDigest',
      'directHumanReviewAttestationDigest',
      'authorityNodeId',
      'authorityResultDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-diff-external-continuation-binding.v1'
  ) {
    throw storeInvalid();
  }
  const grant = parseGrantReference(value.grant);
  const record: TaskDiffExternalContinuationBinding = {
    schemaVersion: 1,
    kind: 'task-diff-external-continuation-binding.v1',
    bindingDigest: assertDigest(value.bindingDigest),
    reservationDigest: assertDigest(value.reservationDigest),
    targetDigest: assertDigest(value.targetDigest),
    subjectDigest: assertDigest(value.subjectDigest),
    policyDigest: assertDigest(value.policyDigest),
    reviewRecordDigest: assertDigest(value.reviewRecordDigest),
    responseDigest: assertDigest(value.responseDigest),
    inputDigest: assertDigest(value.inputDigest),
    grant,
    grantUseDigest: assertDigest(value.grantUseDigest),
    admittedRoleResultDigest: assertDigest(value.admittedRoleResultDigest),
    directHumanReviewAttestationDigest: parseAttestationDigest(
      grant.degradedForm,
      value.directHumanReviewAttestationDigest,
    ),
    contentNodeId: assertDigest(value.contentNodeId),
    contentResultDigest: assertDigest(value.contentResultDigest),
    authorityNodeId: assertDigest(value.authorityNodeId),
    authorityResultDigest: assertDigest(value.authorityResultDigest),
  };
  if (
    record.targetDigest !== taskDiffExternalContinuationTargetDigest(record) ||
    record.grant.grantTargetDigest !== record.targetDigest ||
    record.bindingDigest !==
      digestRecord(withoutDigest(record, 'bindingDigest'))
  ) {
    throw storeInvalid();
  }
  return deepFreeze(record);
}

export function reviewBindingMatchesReservation(
  binding: TaskDiffExternalReviewBinding,
  reservation: TaskDiffExternalReviewReservation,
): boolean {
  return (
    binding.reservationDigest === reservation.reservationDigest &&
    binding.targetDigest === reservation.targetDigest &&
    binding.subjectDigest === reservation.subjectDigest &&
    binding.policyDigest === reservation.policyDigest &&
    binding.inputDigest === reservation.inputDigest &&
    binding.reviewScopeDigest === reservation.reviewScopeDigest &&
    binding.submissionRecordDigest === reservation.submissionRecordDigest &&
    binding.contentNodeId === reservation.contentNodeId &&
    binding.contentResultDigest === reservation.contentResultDigest &&
    canonicalJson(binding.grant) === canonicalJson(reservation.grant)
  );
}

export function continuationBindingMatchesReservation(
  binding: TaskDiffExternalContinuationBinding,
  reservation: TaskDiffExternalContinuationReservation,
): boolean {
  return (
    binding.reservationDigest === reservation.reservationDigest &&
    binding.targetDigest === reservation.targetDigest &&
    binding.subjectDigest === reservation.subjectDigest &&
    binding.policyDigest === reservation.policyDigest &&
    binding.reviewRecordDigest === reservation.reviewRecordDigest &&
    binding.responseDigest === reservation.responseDigest &&
    binding.inputDigest === reservation.inputDigest &&
    binding.contentNodeId === reservation.contentNodeId &&
    binding.contentResultDigest === reservation.contentResultDigest &&
    canonicalJson(binding.grant) === canonicalJson(reservation.grant)
  );
}

function parseGrantReference(value: unknown): TaskDiffExternalGrantReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'degradedForm',
      'grantId',
      'grantEnvelopeDigest',
      'grantTransitionDigest',
      'grantTargetDigest',
    ]) ||
    (value.degradedForm !== 'caller-supplied' &&
      value.degradedForm !== 'direct-human-review') ||
    typeof value.grantId !== 'string' ||
    !GRANT_ID.test(value.grantId)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    degradedForm: value.degradedForm,
    grantId: value.grantId,
    grantEnvelopeDigest: assertDigest(value.grantEnvelopeDigest),
    grantTransitionDigest: assertDigest(value.grantTransitionDigest),
    grantTargetDigest: assertDigest(value.grantTargetDigest),
  });
}

function parseAttestationDigest(
  degradedForm: TaskDiffExternalDegradedForm,
  value: unknown,
): string | null {
  if (degradedForm === 'caller-supplied') {
    if (value !== null) throw storeInvalid();
    return null;
  }
  return assertDigest(value);
}
