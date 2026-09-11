/** Role assignment values and deterministic independence/candidate selection policy. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ActorAssurance } from './actor-identity.ts';
import {
  requireProviderCapability,
  type ProviderId,
  type CapabilityPurpose,
} from './provider-registry.ts';
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  type CollaborationDegradedForm,
  type IndependenceDimension,
} from './role-independence.ts';

/**
 * Role independence is always expressed at an explicit dimension. Provider
 * inequality, principal inequality, and session inequality are never
 * interchangeable. The ordinary floor is session independence relative to the
 * role being challenged; an explicit risk policy may require provider
 * independence. Repository or caller policy cannot lower the session floor,
 * and only an eligible collaboration grant produces a precisely labeled
 * below-floor contribution.
 */

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

export const ROLE_CAPABILITY: Record<EngineProviderRole, CapabilityPurpose> = {
  'plan-reviewer': 'plan-review',
  'task-diff-reviewer': 'task-diff-review',
  'task-implementer': 'task-implementation',
};

export function roleSupportsPurpose(
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
