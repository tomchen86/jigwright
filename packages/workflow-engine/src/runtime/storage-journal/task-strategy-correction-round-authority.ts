/**
 * Validates provider, local, and caller authority recorded in correction rounds.
 *
 * Invariants:
 * - Result authority retains every reservation, attempt, provider result, and caller grant binding.
 * - Unknown keys and malformed participant assurances remain rejected.
 *
 * Depends on: correction round schemas, provider identities, and exact value validators.
 * Failure modes: a correction result is accepted under another reservation or implementer.
 */
import type {
  TaskStrategyCorrectionProviderRequestIdentity,
  TaskStrategyCorrectionProviderReservationIdentity,
  TaskStrategyCorrectionProviderResultIdentity,
  TaskStrategyCorrectionProviderAttemptIdentity,
  TaskStrategyCorrectionCallerReservationIdentity,
  TaskStrategyCorrectionCallerResultIdentity,
  TaskStrategyCorrectionReservationAuthority,
  TaskStrategyCorrectionResultAuthority,
} from './task-strategy-correction-round-contract.ts';
import {
  isRecord,
  hasExactKeys,
  INVESTIGATION_ID,
  INVOCATION_ID,
  isDigest,
  correctionRoundStateInvalid,
  deepFreeze,
  isPositiveInteger,
} from './task-strategy-correction-round-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { TaskStrategyPatchImplementer } from './task-strategy-patch-store.ts';
import { isProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

function parseProviderRequest(
  value: unknown,
): TaskStrategyCorrectionProviderRequestIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'ownerInvestigationId',
      'invocationId',
      'requestDigest',
    ]) ||
    typeof value.ownerInvestigationId !== 'string' ||
    !INVESTIGATION_ID.test(value.ownerInvestigationId) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    ownerInvestigationId: value.ownerInvestigationId,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
  });
}

function parseProviderReservation(
  value: unknown,
): TaskStrategyCorrectionProviderReservationIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reservationDigest',
      'authorizationNodeId',
      'reservationNodeId',
    ]) ||
    !isDigest(value.reservationDigest) ||
    !isDigest(value.authorizationNodeId) ||
    !isDigest(value.reservationNodeId)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    reservationDigest: value.reservationDigest,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
  });
}

function parseProviderResult(
  value: unknown,
): TaskStrategyCorrectionProviderResultIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'providerResultNodeId',
      'providerResultDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.outputDigest) ||
    !isDigest(value.providerResultNodeId) ||
    !isDigest(value.providerResultDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    outputDigest: value.outputDigest,
    providerResultNodeId: value.providerResultNodeId,
    providerResultDigest: value.providerResultDigest,
  });
}

function parseProviderAttempt(
  value: unknown,
): TaskStrategyCorrectionProviderAttemptIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempt',
      'attemptReservationDigest',
      'invocationId',
      'requestDigest',
    ]) ||
    !isPositiveInteger(value.attempt) ||
    !isDigest(value.attemptReservationDigest) ||
    typeof value.invocationId !== 'string' ||
    !INVOCATION_ID.test(value.invocationId) ||
    !isDigest(value.requestDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    attempt: value.attempt,
    attemptReservationDigest: value.attemptReservationDigest,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
  });
}

function parseCallerReservation(
  value: unknown,
): TaskStrategyCorrectionCallerReservationIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reservationDigest',
      'grantId',
      'transitionDigest',
      'submissionNodeId',
      'submissionResultDigest',
    ]) ||
    !isDigest(value.reservationDigest) ||
    typeof value.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.grantId,
    ) ||
    !isDigest(value.transitionDigest) ||
    !isDigest(value.submissionNodeId) ||
    !isDigest(value.submissionResultDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    reservationDigest: value.reservationDigest,
    grantId: value.grantId,
    transitionDigest: value.transitionDigest,
    submissionNodeId: value.submissionNodeId,
    submissionResultDigest: value.submissionResultDigest,
  });
}

function parseCallerResult(
  value: unknown,
): TaskStrategyCorrectionCallerResultIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'bindingDigest',
      'resultNodeId',
      'resultDigest',
      'roleResultDigest',
      'grantUseDigest',
    ]) ||
    !isDigest(value.bindingDigest) ||
    !isDigest(value.resultNodeId) ||
    !isDigest(value.resultDigest) ||
    !isDigest(value.roleResultDigest) ||
    !isDigest(value.grantUseDigest)
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    bindingDigest: value.bindingDigest,
    resultNodeId: value.resultNodeId,
    resultDigest: value.resultDigest,
    roleResultDigest: value.roleResultDigest,
    grantUseDigest: value.grantUseDigest,
  });
}

export function parseReservationAuthority(
  value: unknown,
): TaskStrategyCorrectionReservationAuthority {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw correctionRoundStateInvalid();
  }
  if (value.kind === 'provider') {
    if (
      !hasExactKeys(value, ['kind', 'providerRequest', 'providerReservation'])
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'provider' as const,
      providerRequest: parseProviderRequest(value.providerRequest),
      providerReservation: parseProviderReservation(value.providerReservation),
    });
  }
  if (value.kind === 'caller-supplied') {
    if (!hasExactKeys(value, ['kind', 'callerReservation'])) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'caller-supplied' as const,
      callerReservation: parseCallerReservation(value.callerReservation),
    });
  }
  if (
    value.kind !== 'sealed-local' ||
    !hasExactKeys(value, ['kind', 'author'])
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    kind: 'sealed-local' as const,
    author: parsePatchImplementer(value.author),
  });
}

export function parseResultAuthority(
  value: unknown,
): TaskStrategyCorrectionResultAuthority {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw correctionRoundStateInvalid();
  }
  if (value.kind === 'provider') {
    if (
      !hasExactKeys(value, [
        'kind',
        'providerRequest',
        'providerReservation',
        'providerAttempt',
        'providerResult',
      ])
    ) {
      throw correctionRoundStateInvalid();
    }
    const providerRequest = parseProviderRequest(value.providerRequest);
    const providerAttempt = parseProviderAttempt(value.providerAttempt);
    const providerResult = parseProviderResult(value.providerResult);
    if (
      providerResult.invocationId !== providerAttempt.invocationId ||
      providerResult.requestDigest !== providerAttempt.requestDigest
    ) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'provider' as const,
      providerRequest,
      providerReservation: parseProviderReservation(value.providerReservation),
      providerAttempt,
      providerResult,
    });
  }
  if (value.kind === 'caller-supplied') {
    if (!hasExactKeys(value, ['kind', 'callerReservation', 'callerResult'])) {
      throw correctionRoundStateInvalid();
    }
    return deepFreeze({
      kind: 'caller-supplied' as const,
      callerReservation: parseCallerReservation(value.callerReservation),
      callerResult: parseCallerResult(value.callerResult),
    });
  }
  if (
    value.kind !== 'sealed-local' ||
    !hasExactKeys(value, ['kind', 'author'])
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    kind: 'sealed-local' as const,
    author: parsePatchImplementer(value.author),
  });
}

export function assertResultAuthorityMatchesReservation(
  result: TaskStrategyCorrectionResultAuthority,
  reservation: TaskStrategyCorrectionReservationAuthority,
): void {
  if (!resultAuthorityMatchesReservation(result, reservation)) {
    throw correctionRoundStateInvalid();
  }
}

export function resultAuthorityMatchesReservation(
  result: TaskStrategyCorrectionResultAuthority,
  reservation: TaskStrategyCorrectionReservationAuthority,
): boolean {
  if (result.kind !== reservation.kind) return false;
  if (result.kind === 'sealed-local') {
    return (
      reservation.kind === 'sealed-local' &&
      canonicalJson(result.author) === canonicalJson(reservation.author)
    );
  }
  if (result.kind === 'caller-supplied') {
    return (
      reservation.kind === 'caller-supplied' &&
      canonicalJson(result.callerReservation) ===
        canonicalJson(reservation.callerReservation)
    );
  }
  return (
    reservation.kind === 'provider' &&
    canonicalJson(result.providerRequest) ===
      canonicalJson(reservation.providerRequest) &&
    canonicalJson(result.providerReservation) ===
      canonicalJson(reservation.providerReservation)
  );
}

function parsePatchImplementer(value: unknown): TaskStrategyPatchImplementer {
  if (!isRecord(value)) throw correctionRoundStateInvalid();
  if (
    hasExactKeys(value, ['providerId', 'assurance']) &&
    typeof value.providerId === 'string' &&
    isProviderId(value.providerId) &&
    isActorAssurance(value.assurance)
  ) {
    return deepFreeze({
      providerId: value.providerId,
      assurance: value.assurance,
    });
  }
  if (
    !hasExactKeys(value, [
      'providerId',
      'principalId',
      'assurance',
      'degradedForm',
      'grantId',
    ]) ||
    value.providerId !== null ||
    typeof value.principalId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(value.principalId) ||
    !isActorAssurance(value.assurance) ||
    value.degradedForm !== 'caller-supplied' ||
    typeof value.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.grantId,
    )
  ) {
    throw correctionRoundStateInvalid();
  }
  return deepFreeze({
    providerId: null,
    principalId: value.principalId,
    assurance: value.assurance,
    degradedForm: 'caller-supplied' as const,
    grantId: value.grantId,
  });
}

function isActorAssurance(
  value: unknown,
): value is 'self-declared' | 'runtime-hint' | 'adapter-assigned' {
  return (
    value === 'self-declared' ||
    value === 'runtime-hint' ||
    value === 'adapter-assigned'
  );
}
