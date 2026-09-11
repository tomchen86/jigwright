/** Role-result admission records and the evidence required by admission rules. */
import type {
  EngineProviderRole,
  RecordedRoleParticipant,
  RoleParticipant,
  RoleAssignment,
  GrantedRoleAssignment,
  RoleContextSharingGrantedRoleAssignment,
  TaskDiffChallengeClosureAuthorityOverride,
} from './role-assignment.ts';
import type { ProviderId } from './provider-registry.ts';
import type { IndependenceDimension } from './role-independence.ts';
import type { DirectHumanReviewAttestation } from '../authority/collaboration-grant-codec.ts';
import type {
  CollaborationGrantUseProjection,
  CollaborationGrantUseValidationOptions,
  CollaborationReservationRecord,
  VerifiedConsumedCollaborationGrantReplay,
} from '../authority/collaboration-grant-records.ts';
import type { GrantVerifierPort } from '@jigwright/core/grant-verifier-port';
import type { MaintainerPolicy } from '../authority/maintainer-policy.ts';
import type { ConsumedRoleContextSharingUseEvidenceV1 } from '../authority/role-context-sharing-grant-lifecycle-port.ts';
import type { VerifiedConsumedRoleContextSharingReplay } from '../authority/role-context-sharing-grant-lifecycle-port.ts';
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
