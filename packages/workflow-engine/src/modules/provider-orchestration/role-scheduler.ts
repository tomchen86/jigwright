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
  canonicalCollaborationGrantEnvelope,
  directHumanReviewAttestationDigest,
  parseCollaborationGrantEnvelope,
  validateDirectHumanReviewAttestation,
  type CollaborationDegradedForm,
  type DirectHumanReviewAttestation,
} from '../authority/collaboration-grant.ts';
import {
  consumedCollaborationGrantUseForReplay,
  validateCollaborationGrantUseProjection,
  type CollaborationGrantUseProjection,
  type CollaborationGrantUseValidationOptions,
  type CollaborationReservationRecord,
  type VerifiedConsumedCollaborationGrantReplay,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
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

/**
 * Role independence is always expressed at an explicit dimension. Provider
 * inequality, principal inequality, and session inequality are never
 * interchangeable. The ordinary floor is session independence relative to the
 * role being challenged; an explicit risk policy may require provider
 * independence. Repository or caller policy cannot lower the session floor,
 * and only an eligible collaboration grant produces a precisely labeled
 * below-floor contribution.
 */
export type IndependenceDimension =
  | 'provider-independent'
  | 'principal-independent'
  | 'session-independent'
  | 'none';

export type OrdinaryRole = 'plan-reviewer';
export type TaskDiffReviewRole = 'task-diff-reviewer';
export type TaskImplementerRole = 'task-implementer';
export type EngineProviderRole =
  OrdinaryRole | TaskDiffReviewRole | TaskImplementerRole;

/**
 * A role participant. Provider and session are optional so the type can also
 * represent caller-supplied or direct-human degraded work that has no engine
 * provider session at all.
 */
export type RoleParticipant = {
  providerId: ProviderId | undefined;
  sessionId: string | undefined;
  principalId: string | undefined;
  identityAssurance: ActorAssurance;
  engineSpawned: boolean;
};

export type RecordedRoleParticipant = {
  providerId: ProviderId | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance: ActorAssurance | 'maintainer-signed';
  engineSpawned: boolean;
};

export type RoleIndependence = {
  principalIndependent: boolean | null;
  providerIndependent: boolean;
  sessionIndependent: boolean;
  achievedIndependence: IndependenceDimension;
};

export type RoleCandidate = {
  providerId: ProviderId;
  sessionId: string;
  enabled: boolean;
  available: boolean;
};

export type RoleAssignment = {
  role: EngineProviderRole;
  providerId: ProviderId;
  sessionId: string;
  targetDigest: string;
  requiredIndependence: IndependenceDimension;
  achievedIndependence: IndependenceDimension;
};

export type ScheduleOrdinaryRoleInput = {
  role: EngineProviderRole;
  purpose?: CapabilityPurpose;
  author: RoleParticipant;
  targetDigest: string;
  candidates: RoleCandidate[];
  requestedIndependence?: IndependenceDimension;
};

export type ScheduleOrdinaryRoleResult =
  | {
      outcome: 'assigned';
      assignment: RoleAssignment;
    }
  | {
      outcome: 'collaboration-grant-required';
      role: EngineProviderRole;
      requiredIndependence: IndependenceDimension;
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE';
    };

export type GrantedRoleAssignment = {
  role: EngineProviderRole;
  providerId: ProviderId | null;
  sessionId: string | null;
  targetDigest: string;
  requiredIndependence: 'provider-independent';
  achievedIndependence: 'session-independent' | 'none';
  providerIndependent: false;
  sessionIndependent: boolean;
  engineSpawned: boolean;
  orchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  grantId: string;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  author: RecordedRoleParticipant;
  participant: RecordedRoleParticipant;
  callableProviderIds: readonly ProviderId[];
  degradedAuthorityOverride?: TaskDiffChallengeClosureAuthorityOverride;
  directHumanReviewAttestationDigest: string | null;
};

export type TaskDiffChallengeClosureAuthorityOverride = Readonly<{
  kind: 'task-diff-challenge-closure';
  targetDigest: string;
  subjectDigest: string;
  reviewRecordDigest: string;
  responseDigest: string;
}>;

export type GrantedSameProviderRoleAssignment = GrantedRoleAssignment & {
  providerId: ProviderId;
  sessionId: string;
  achievedIndependence: 'session-independent';
  sessionIndependent: true;
  engineSpawned: true;
  orchestration: 'engine-spawned-provider';
  degradedForm: 'same-provider-fresh-session';
  directHumanReviewAttestationDigest: null;
};

export type RoleContextSharingGrantedRoleAssignment = Readonly<{
  role: 'plan-reviewer';
  providerId: ProviderId;
  sessionId: string;
  targetDigest: string;
  requiredIndependence: 'provider-independent';
  achievedIndependence: 'session-independent';
  authorityKind: 'role-context-sharing-grant.v1';
  roleContextSharingGrantId: string;
  authorizedEffect: 'role-context-sharing-degradation';
  exactRolePairs: readonly (
    'author-builder' | 'author-reviewer' | 'builder-reviewer'
  )[];
  contextGeneration: number;
  sessionGeneration: number;
  sharedEngineSessionId: string;
  providerDefinitionDigest: string;
  reservationReceiptDigest: string;
}>;

export type ProviderRoleAssignment =
  | RoleAssignment
  | GrantedSameProviderRoleAssignment
  | RoleContextSharingGrantedRoleAssignment;

export type RoleContentAdmission = {
  kind:
    'blind-survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
  nodeId: string;
  resultDigest: string;
  outputSchema: { id: string; version: number; digest: string };
  evaluator: string;
  policyDigest: string;
  contentDigest: string;
  current: true;
};

export type RoleProviderInvocationEvidence = {
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
  providerId: ProviderId;
  sessionId: string;
  targetDigest: string;
  engineSpawned: true;
};

type AdmittedRoleResultCommon = {
  role: EngineProviderRole;
  targetDigest: string;
  author: RecordedRoleParticipant;
  participant: RecordedRoleParticipant;
  orchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  requiredIndependence: 'provider-independent' | 'session-independent';
  achievedIndependence: IndependenceDimension;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence | null;
  directHumanReviewAttestation: DirectHumanReviewAttestation | null;
  resultDigest: string;
};

export type AdmittedRoleResult =
  | (AdmittedRoleResultCommon & {
      schemaVersion: 1;
      form:
        | 'ordinary-provider'
        | 'granted-same-provider'
        | 'granted-caller-supplied'
        | 'direct-human-attestation';
      assignment: RoleAssignment | GrantedRoleAssignment;
      grantUse: CollaborationGrantUseProjection | null;
      roleContextSharingUse?: never;
    })
  | (AdmittedRoleResultCommon & {
      schemaVersion: 2;
      form: 'granted-role-context-sharing';
      assignment: RoleContextSharingGrantedRoleAssignment;
      orchestration: 'engine-spawned-provider';
      providerInvocation: RoleProviderInvocationEvidence;
      grantUse: null;
      roleContextSharingUse: ConsumedRoleContextSharingUseEvidenceV1;
      directHumanReviewAttestation: null;
    });

export type AdmitRoleResultInput = {
  assignment: RoleAssignment | GrantedRoleAssignment;
  author: RoleParticipant | RecordedRoleParticipant;
  participant: RoleParticipant | RecordedRoleParticipant;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence | null;
  grantUse: unknown | null;
  grantValidation: Omit<
    CollaborationGrantUseValidationOptions,
    'expectedAssignment' | 'contentAdmission'
  > | null;
};

export type AdmitConsumedRoleResultReplayInput = Omit<
  AdmitRoleResultInput,
  'grantUse' | 'grantValidation'
> &
  Readonly<{
    replay: VerifiedConsumedCollaborationGrantReplay;
  }>;

export type AdmitRoleContextSharingResultInput = Readonly<{
  assignment: RoleContextSharingGrantedRoleAssignment;
  author: RoleParticipant | RecordedRoleParticipant;
  participant: RoleParticipant | RecordedRoleParticipant;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence;
  consumedUse: ConsumedRoleContextSharingUseEvidenceV1;
}>;

export type RoleContextSharingResultAdmissionBindingInput = Omit<
  AdmitRoleContextSharingResultInput,
  'consumedUse'
>;

export type NormalizedRoleContextSharingResultAdmissionBinding = Readonly<{
  assignment: RoleContextSharingGrantedRoleAssignment;
  author: RecordedRoleParticipant;
  participant: RecordedRoleParticipant;
  content: RoleContentAdmission;
  providerInvocation: RoleProviderInvocationEvidence;
}>;

export type AdmitConsumedRoleContextSharingResultReplayInput = Omit<
  AdmitRoleContextSharingResultInput,
  'consumedUse'
> &
  Readonly<{
    replay: VerifiedConsumedRoleContextSharingReplay;
  }>;

export type DirectHumanReviewProof = {
  attestation: DirectHumanReviewAttestation;
  policy: MaintainerPolicy;
  verifier: GrantVerifierPort;
  now: Date;
  reviewNodeId: string;
  reviewResultDigest: string;
};

export type AuthorizeGrantedOrdinaryRoleInput = {
  role: EngineProviderRole;
  author: RoleParticipant;
  targetDigest: string;
  reservation: CollaborationReservationRecord;
  actualParticipant: RoleParticipant;
  callableProviderIds: ProviderId[];
  degradedAuthorityOverride?: TaskDiffChallengeClosureAuthorityOverride;
  directHumanReview?: DirectHumanReviewProof;
};

const ROLE_CAPABILITY: Record<EngineProviderRole, CapabilityPurpose> = {
  'plan-reviewer': 'plan-review',
  'task-diff-reviewer': 'task-diff-review',
  'task-implementer': 'task-implementation',
};

function roleSupportsPurpose(
  role: EngineProviderRole,
  purpose: CapabilityPurpose,
): boolean {
  return (
    ROLE_CAPABILITY[role] === purpose ||
    (role === 'plan-reviewer' && purpose === 'survey')
  );
}

/**
 * Assess independence of a candidate relative to the author being challenged.
 * Provider independence requires the candidate to have a provider distinct from
 * the author's. Session independence requires both author and candidate to have
 * defined session IDs, the candidate to be engine-spawned, and the IDs to
 * differ; it is never manufactured relative to an author with no session.
 * Principal independence is unknown (`null`) whenever either principal is
 * unidentified. When principal independence is positively established and
 * provider independence is not, the achieved summary is `principal-independent`
 * before session independence is considered.
 */
export function assessRoleIndependence(
  author: RoleParticipant,
  candidate: RoleParticipant,
): RoleIndependence {
  const providerIndependent =
    candidate.providerId !== undefined &&
    author.providerId !== undefined &&
    candidate.providerId !== author.providerId;
  const sessionIndependent =
    candidate.engineSpawned &&
    candidate.sessionId !== undefined &&
    author.sessionId !== undefined &&
    candidate.sessionId !== author.sessionId;
  const principalIndependent =
    author.principalId === undefined || candidate.principalId === undefined
      ? null
      : candidate.principalId !== author.principalId;

  let achievedIndependence: IndependenceDimension = 'none';
  if (providerIndependent) {
    achievedIndependence = 'provider-independent';
  } else if (principalIndependent === true) {
    achievedIndependence = 'principal-independent';
  } else if (sessionIndependent) {
    achievedIndependence = 'session-independent';
  }

  return {
    principalIndependent,
    providerIndependent,
    sessionIndependent,
    achievedIndependence,
  };
}

/**
 * Schedule an ordinary role at the session-independent floor, or at an
 * explicitly requested provider-independent risk floor. A weaker or unrelated
 * dimension fails closed.
 * Every runtime candidate ID is checked against the code-owned registry and the
 * required purpose capability, so an unknown candidate fails closed rather
 * than being launched. The first enabled, available candidate meeting the
 * requested floor is assigned; otherwise the transition pauses for an eligible
 * collaboration grant.
 */
export function scheduleOrdinaryRole(
  input: ScheduleOrdinaryRoleInput,
): ScheduleOrdinaryRoleResult {
  const requiredIndependence: IndependenceDimension =
    input.requestedIndependence ?? 'session-independent';

  if (
    requiredIndependence !== 'session-independent' &&
    requiredIndependence !== 'provider-independent'
  ) {
    throw workflowError(
      'ROLE_INDEPENDENCE_DOWNGRADE',
      `Ordinary role "${input.role}" requires at least session-independent; ` +
        `it cannot use ${requiredIndependence}.`,
      ExitCode.guard,
    );
  }

  // Every candidate ID must be a reviewed provider that supports the required
  // capability; an unknown candidate fails closed before any selection.
  const capability = input.purpose ?? ROLE_CAPABILITY[input.role];
  if (!roleSupportsPurpose(input.role, capability)) {
    throw workflowError(
      'ROLE_CAPABILITY_INVALID',
      `Role "${input.role}" cannot perform ${capability}.`,
      ExitCode.guard,
    );
  }
  for (const candidate of input.candidates) {
    requireProviderCapability(
      candidate.providerId,
      capability,
      'repository-read-only',
    );
  }

  const selected = input.candidates.find((candidate) => {
    if (!candidate.enabled || !candidate.available) {
      return false;
    }
    const independence = assessRoleIndependence(input.author, {
      providerId: candidate.providerId,
      sessionId: candidate.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    });
    return requiredIndependence === 'provider-independent'
      ? independence.providerIndependent
      : independence.sessionIndependent;
  });

  if (!selected) {
    return {
      outcome: 'collaboration-grant-required',
      role: input.role,
      requiredIndependence,
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    };
  }

  const assignment: RoleAssignment = Object.freeze({
    role: input.role,
    providerId: selected.providerId,
    sessionId: selected.sessionId,
    targetDigest: input.targetDigest,
    requiredIndependence,
    achievedIndependence: assessRoleIndependence(input.author, {
      providerId: selected.providerId,
      sessionId: selected.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    }).achievedIndependence,
  });

  return { outcome: 'assigned', assignment };
}

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
export function authorizeGrantedOrdinaryRole(
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

export type RoleResultAdmissionBindings = Readonly<{
  hasExactKeys: typeof hasExactKeys;
  deepFreeze: typeof deepFreeze;
  consumedCollaborationGrantUseForReplay: typeof consumedCollaborationGrantUseForReplay;
  validateCollaborationGrantUseProjection: typeof validateCollaborationGrantUseProjection;
}>;

const roleResultAdmission = createRoleResultAdmission({
  hasExactKeys,
  deepFreeze,
  consumedCollaborationGrantUseForReplay,
  validateCollaborationGrantUseProjection,
});
export const assertAdmittedRoleResultRecord =
  roleResultAdmission.assertAdmittedRoleResultRecord;
export const admitRoleResult = roleResultAdmission.admitRoleResult;
export const admitConsumedRoleResultReplay =
  roleResultAdmission.admitConsumedRoleResultReplay;
export const admitRoleContextSharingResult =
  roleResultAdmission.admitRoleContextSharingResult;
export const normalizeRoleContextSharingResultAdmissionBinding =
  roleResultAdmission.normalizeRoleContextSharingResultAdmissionBinding;
export const admitConsumedRoleContextSharingResultReplay =
  roleResultAdmission.admitConsumedRoleContextSharingResultReplay;
export const isGrantedSameProviderRoleAssignment =
  roleResultAdmission.isGrantedSameProviderRoleAssignment;

export type { CollaborationGrantUseProjection } from '../../runtime/storage-journal/collaboration-grant-store.ts';
