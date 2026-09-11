import type { CollaborationGrantCodec } from '../authority/collaboration-grant-codec.ts';
import type { ConsumedCollaborationGrantUseReader } from '../authority/collaboration-grant-records.ts';
import type { CollaborationGrantUseValidator } from '../authority/collaboration-grant-use.ts';
import type {
  RoleContentAdmission,
  RoleProviderInvocationEvidence,
  AdmittedRoleResult,
  AdmitRoleResultInput,
  AdmitConsumedRoleResultReplayInput,
  AdmitRoleContextSharingResultInput,
  RoleContextSharingResultAdmissionBindingInput,
  NormalizedRoleContextSharingResultAdmissionBinding,
  AdmitConsumedRoleContextSharingResultReplayInput,
  DirectHumanReviewProof,
  AuthorizeGrantedOrdinaryRoleInput,
} from './role-admission-contracts.ts';
export type {
  RoleContentAdmission,
  RoleProviderInvocationEvidence,
  AdmittedRoleResult,
  AdmitRoleResultInput,
  AdmitConsumedRoleResultReplayInput,
  AdmitRoleContextSharingResultInput,
  RoleContextSharingResultAdmissionBindingInput,
  NormalizedRoleContextSharingResultAdmissionBinding,
  AdmitConsumedRoleContextSharingResultReplayInput,
  DirectHumanReviewProof,
  AuthorizeGrantedOrdinaryRoleInput,
} from './role-admission-contracts.ts';

import {
  type OrdinaryRole,
  type TaskDiffReviewRole,
  type TaskImplementerRole,
  type EngineProviderRole,
  type RoleParticipant,
  type RecordedRoleParticipant,
  type RoleIndependence,
  type RoleCandidate,
  type RoleAssignment,
  type ScheduleOrdinaryRoleInput,
  type ScheduleOrdinaryRoleResult,
  type GrantedRoleAssignment,
  type TaskDiffChallengeClosureAuthorityOverride,
  type GrantedSameProviderRoleAssignment,
  type RoleContextSharingGrantedRoleAssignment,
  type ProviderRoleAssignment,
  ROLE_CAPABILITY,
  roleSupportsPurpose,
  assessRoleIndependence,
  scheduleOrdinaryRole,
} from './role-assignment.ts';
export {
  type OrdinaryRole,
  type TaskDiffReviewRole,
  type TaskImplementerRole,
  type EngineProviderRole,
  type RoleParticipant,
  type RecordedRoleParticipant,
  type RoleIndependence,
  type RoleCandidate,
  type RoleAssignment,
  type ScheduleOrdinaryRoleInput,
  type ScheduleOrdinaryRoleResult,
  type GrantedRoleAssignment,
  type TaskDiffChallengeClosureAuthorityOverride,
  type GrantedSameProviderRoleAssignment,
  type RoleContextSharingGrantedRoleAssignment,
  type ProviderRoleAssignment,
  assessRoleIndependence,
  scheduleOrdinaryRole,
} from './role-assignment.ts';
/**
 * Schedules independent provider roles and validates granted role
 * exceptions.
 *
 * Invariants:
 * - Ordinary roles require at least session independence.
 */
import { createRoleResultAdmission } from './role-result-admission.ts';
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ActorAssurance } from './actor-identity.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  type CollaborationDegradedForm,
} from './role-independence.ts';
import { type DirectHumanReviewAttestation } from '../authority/collaboration-grant-codec.ts';
import {
  type CollaborationGrantUseProjection,
  type CollaborationGrantUseValidationOptions,
  type CollaborationReservationRecord,
  type VerifiedConsumedCollaborationGrantReplay,
} from '../authority/collaboration-grant-records.ts';
import type { GrantVerifierPort } from '../authority/grant-verifier-port.ts';
import type { MaintainerPolicy } from '../authority/maintainer-policy.ts';
import type { ConsumedRoleContextSharingUseEvidenceV1 } from '../authority/role-context-sharing-grant-lifecycle-port.ts';
import { type VerifiedConsumedRoleContextSharingReplay } from '../authority/role-context-sharing-consumed-replay.ts';
import {
  isProviderId,
  requireProviderCapability,
  type CapabilityPurpose,
  type ProviderId,
} from './provider-registry.ts';

function assertTaskDiffChallengeClosureAuthorityOverride(
  value: TaskDiffChallengeClosureAuthorityOverride,
  role: EngineProviderRole,
  targetDigest: string,
): TaskDiffChallengeClosureAuthorityOverride {
  if (
    role !== 'task-diff-reviewer' ||
    !value ||
    typeof value !== 'object' ||
    !hasExactKeys(value, [
      'kind',
      'targetDigest',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
    ]) ||
    value.kind !== 'task-diff-challenge-closure' ||
    !/^[0-9a-f]{64}$/.test(value.subjectDigest) ||
    !/^[0-9a-f]{64}$/.test(value.reviewRecordDigest) ||
    !/^[0-9a-f]{64}$/.test(value.responseDigest) ||
    value.targetDigest !== targetDigest ||
    value.targetDigest !==
      crypto
        .createHash('sha256')
        .update(
          canonicalJson({
            schema: 'workflow.task-diff-external-continuation-target.v1',
            subjectDigest: value.subjectDigest,
            reviewRecordDigest: value.reviewRecordDigest,
            responseDigest: value.responseDigest,
          }),
        )
        .digest('hex')
  ) {
    throw grantedRoleInvalid();
  }
  return deepFreeze(structuredClone(value));
}

function recordParticipant(
  participant: RoleParticipant,
): RecordedRoleParticipant {
  if (
    !participant ||
    typeof participant !== 'object' ||
    (participant.providerId !== undefined &&
      !isProviderId(participant.providerId)) ||
    (participant.sessionId !== undefined &&
      (typeof participant.sessionId !== 'string' ||
        participant.sessionId.length === 0)) ||
    (participant.principalId !== undefined &&
      (typeof participant.principalId !== 'string' ||
        participant.principalId.length === 0)) ||
    !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(
      participant.identityAssurance,
    ) ||
    typeof participant.engineSpawned !== 'boolean'
  ) {
    throw grantedRoleInvalid();
  }
  return Object.freeze({
    providerId: participant.providerId ?? null,
    sessionId: participant.sessionId ?? null,
    principalId: participant.principalId ?? null,
    identityAssurance: participant.identityAssurance,
    engineSpawned: participant.engineSpawned,
  });
}

function grantedRoleInvalid() {
  return workflowError(
    'COLLABORATION_GRANT_ROLE_INVALID',
    'Collaboration grant does not authorize this exact degraded role assignment.',
    ExitCode.guard,
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string') &&
    expected.every((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key),
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export type { CollaborationGrantUseProjection } from '../authority/collaboration-grant-records.ts';

import type { IndependenceDimension } from './role-independence.ts';
export type { IndependenceDimension } from './role-independence.ts';

export type RoleSchedulerServices = Pick<
  CollaborationGrantCodec,
  | 'canonicalCollaborationGrantEnvelope'
  | 'directHumanReviewAttestationDigest'
  | 'parseCollaborationGrantEnvelope'
  | 'validateDirectHumanReviewAttestation'
> &
  Pick<
    typeof import('@jigwright/core/role-context-sharing-grant-codec'),
    | 'bindingFromRoleContextSharingGrantPayloadV1'
    | 'canonicalRoleContextSharingGrantEnvelopeV1'
  > &
  Readonly<{
    consumedCollaborationGrantUseForReplay: ConsumedCollaborationGrantUseReader;
    validateCollaborationGrantUseProjection: CollaborationGrantUseValidator['validateCollaborationGrantUseProjection'];
  }>;

export type RoleResultAdmissionBindings = Pick<
  RoleSchedulerServices,
  | 'bindingFromRoleContextSharingGrantPayloadV1'
  | 'canonicalRoleContextSharingGrantEnvelopeV1'
  | 'directHumanReviewAttestationDigest'
  | 'consumedCollaborationGrantUseForReplay'
  | 'validateCollaborationGrantUseProjection'
> &
  Readonly<{
    hasExactKeys: typeof hasExactKeys;
    deepFreeze: typeof deepFreeze;
  }>;

export function createRoleScheduler(services: RoleSchedulerServices) {
  const {
    canonicalCollaborationGrantEnvelope,
    directHumanReviewAttestationDigest,
    parseCollaborationGrantEnvelope,
    validateDirectHumanReviewAttestation,
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
    consumedCollaborationGrantUseForReplay,
    validateCollaborationGrantUseProjection,
  } = services;
  /**
   * Apply an already validated and atomically reserved collaboration grant to
   * one exact ordinary-role conflict. This is intentionally additive to
   * `scheduleOrdinaryRole`: an ordinary `RoleAssignment` satisfies the requested
   * session- or provider-independent floor, while degraded assignments have a
   * distinct type that cannot be mistaken for an ordinary result.
   *
   * The function derives achieved independence and orchestration from the actual
   * participant and callable-provider set. Callers cannot supply either claim.
   * A same-provider grant requires the only callable provider, a real
   * engine-spawned fresh session, and is labeled session-independent. A
   * caller-supplied or direct-human contribution is permitted only when no
   * provider is callable and always records no provider/session independence.
   */
  function authorizeGrantedOrdinaryRole(
    input: AuthorizeGrantedOrdinaryRoleInput,
  ): GrantedRoleAssignment {
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.callableProviderIds) ||
      !/^[0-9a-f]{64}$/.test(input.targetDigest)
    ) {
      throw grantedRoleInvalid();
    }
    const callableProviderIds = [...input.callableProviderIds];
    const degradedAuthorityOverride =
      input.degradedAuthorityOverride === undefined
        ? undefined
        : assertTaskDiffChallengeClosureAuthorityOverride(
            input.degradedAuthorityOverride,
            input.role,
            input.targetDigest,
          );
    if (
      callableProviderIds.some((providerId) => !isProviderId(providerId)) ||
      callableProviderIds.length !== new Set(callableProviderIds).size
    ) {
      throw grantedRoleInvalid();
    }
    const reservation = input.reservation;
    if (
      !reservation ||
      reservation.state !== 'reserved' ||
      !/^[0-9a-f]{64}$/.test(reservation.transitionDigest)
    ) {
      throw grantedRoleInvalid();
    }
    const envelope = parseCollaborationGrantEnvelope(
      canonicalCollaborationGrantEnvelope(reservation.envelope),
    );
    const payload = envelope.payload;
    if (
      payload.targetDigest !== input.targetDigest ||
      payload.rolePair.conflictingRole !== input.role ||
      (input.role === 'plan-reviewer' &&
        payload.lifecyclePhase !== 'blind-survey' &&
        payload.lifecyclePhase !== 'plan-review') ||
      (input.role === 'task-diff-reviewer' &&
        payload.lifecyclePhase !== 'task-diff-review') ||
      (input.role === 'task-implementer' &&
        payload.lifecyclePhase !== 'task-implementation')
    ) {
      throw grantedRoleInvalid();
    }
    const base = {
      role: input.role,
      targetDigest: payload.targetDigest,
      requiredIndependence: 'provider-independent' as const,
      providerIndependent: false as const,
      grantId: payload.grantId,
      degradedForm: payload.degradedForm,
      authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      author: recordParticipant(input.author),
      callableProviderIds: Object.freeze([...callableProviderIds].sort()),
      ...(degradedAuthorityOverride === undefined
        ? {}
        : { degradedAuthorityOverride }),
    };
    const participant = input.actualParticipant;
    if (
      payload.degradedForm === 'same-provider-fresh-session' &&
      payload.availableActor.kind === 'provider'
    ) {
      const providerId = payload.availableActor.providerId;
      if (
        input.author.providerId !== providerId ||
        callableProviderIds.length !== 1 ||
        callableProviderIds[0] !== providerId ||
        participant.providerId !== providerId ||
        participant.identityAssurance !== payload.availableActor.assurance ||
        degradedAuthorityOverride !== undefined ||
        !participant.engineSpawned ||
        typeof input.author.sessionId !== 'string' ||
        typeof participant.sessionId !== 'string' ||
        participant.sessionId.length === 0 ||
        participant.sessionId === input.author.sessionId
      ) {
        throw grantedRoleInvalid();
      }
      return Object.freeze({
        ...base,
        providerId,
        sessionId: participant.sessionId,
        achievedIndependence: 'session-independent' as const,
        sessionIndependent: true,
        engineSpawned: true,
        orchestration: 'engine-spawned-provider' as const,
        participant: recordParticipant(participant),
        directHumanReviewAttestationDigest: null,
      });
    }
    if (
      callableProviderIds.length !== 0 ||
      participant.providerId !== undefined ||
      participant.sessionId !== undefined ||
      participant.engineSpawned
    ) {
      throw grantedRoleInvalid();
    }
    if (
      payload.degradedForm === 'caller-supplied' &&
      payload.availableActor.kind === 'caller' &&
      participant.principalId === payload.availableActor.callerId &&
      participant.identityAssurance === payload.availableActor.assurance &&
      (input.role === 'task-implementer' ||
        (typeof input.author.principalId === 'string' &&
          participant.principalId !== input.author.principalId))
    ) {
      return Object.freeze({
        ...base,
        providerId: null,
        sessionId: null,
        achievedIndependence: 'none' as const,
        sessionIndependent: false,
        engineSpawned: false,
        orchestration: 'caller-supplied' as const,
        participant: recordParticipant(participant),
        directHumanReviewAttestationDigest: null,
      });
    }
    if (
      payload.degradedForm === 'direct-human-review' &&
      payload.availableActor.kind === 'direct-human' &&
      (input.role === 'plan-reviewer' || input.role === 'task-diff-reviewer') &&
      participant.principalId === payload.availableActor.identity &&
      input.directHumanReview
    ) {
      const attestation = validateDirectHumanReviewAttestation(
        input.directHumanReview.attestation,
        {
          now: input.directHumanReview.now,
          grantEnvelope: envelope,
          policy: input.directHumanReview.policy,
          verifier: input.directHumanReview.verifier,
          transitionDigest: reservation.transitionDigest,
          reviewNodeId: input.directHumanReview.reviewNodeId,
          reviewResultDigest: input.directHumanReview.reviewResultDigest,
        },
      );
      return Object.freeze({
        ...base,
        providerId: null,
        sessionId: null,
        achievedIndependence: 'none' as const,
        sessionIndependent: false,
        engineSpawned: false,
        orchestration: 'direct-human-review' as const,
        participant: {
          ...recordParticipant(participant),
          identityAssurance: 'maintainer-signed' as const,
        },
        directHumanReviewAttestationDigest:
          directHumanReviewAttestationDigest(attestation),
      });
    }
    throw grantedRoleInvalid();
  }
  const roleResultAdmission = createRoleResultAdmission({
    hasExactKeys,
    deepFreeze,
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
    directHumanReviewAttestationDigest,
    consumedCollaborationGrantUseForReplay,
    validateCollaborationGrantUseProjection,
  });
  return { authorizeGrantedOrdinaryRole, ...roleResultAdmission };
}

export type RoleAdmissionServices = ReturnType<typeof createRoleScheduler>;
