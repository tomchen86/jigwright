/**
 * Defines collaboration reservation, assignment, consumption, and inspection record shapes.
 *
 * Invariants:
 * - Public record fields retain their original optionality, nullable values, and discriminated states.
 * - Types add no runtime initialization or grant authority.
 */
import type {
  CollaborationDegradedForm,
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  CollaborationLifecyclePhase,
  DirectHumanReviewAttestation,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  CollaborationGrantEnvelope,
  CollaborationGrantCodec,
  CollaborationGrantExpectedBinding,
} from './collaboration-grant-codec.ts';
import type { HumanRevocationAuthorization } from './human-revocation-contract.ts';
import type {
  AuthoritativeCollaborationGrantVerifier,
  GrantVerifierPort,
} from './grant-verifier-port.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';

export type CollaborationGrantedAssignmentRecord = {
  role: 'plan-reviewer' | 'task-diff-reviewer' | 'task-implementer';
  providerId: 'codex' | 'claude' | null;
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
  author: CollaborationParticipantRecord;
  participant: CollaborationParticipantRecord;
  callableProviderIds: readonly ('codex' | 'claude')[];
  degradedAuthorityOverride?: Readonly<{
    kind: 'task-diff-challenge-closure';
    targetDigest: string;
    subjectDigest: string;
    reviewRecordDigest: string;
    responseDigest: string;
  }>;
  directHumanReviewAttestationDigest: string | null;
};

export type CollaborationParticipantRecord = {
  providerId: 'codex' | 'claude' | null;
  sessionId: string | null;
  principalId: string | null;
  identityAssurance:
    'self-declared' | 'runtime-hint' | 'adapter-assigned' | 'maintainer-signed';
  engineSpawned: boolean;
};

export type CollaborationStructuredContent = {
  kind:
    'blind-survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
  nodeId: string;
  resultDigest: string;
};

export type CollaborationGrantUseProjection = {
  schemaVersion: 1;
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
  reservedAt: string;
  lifecyclePhase: CollaborationLifecyclePhase;
  targetDigest: string;
  degradedForm: CollaborationDegradedForm;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  assignment: CollaborationGrantedAssignmentRecord;
  structuredContent: CollaborationStructuredContent;
  contentAuthority: 'reference-only-requires-governing-validator';
  directHumanReviewAttestation: DirectHumanReviewAttestation | null;
  retainedObligations: typeof COLLABORATION_GRANT_RETAINED_OBLIGATIONS;
  replayScope: typeof COLLABORATION_GRANT_REPLAY_SCOPE;
  residuals: typeof COLLABORATION_GRANT_RESIDUALS;
  envelope: CollaborationGrantEnvelope;
};

export type CollaborationReservationRecord = {
  schemaVersion: 1;
  state: 'reserved';
  grantId: string;
  transitionDigest: string;
  repositoryRoot: string;
  reservedAt: string;
  envelope: CollaborationGrantEnvelope;
};

type CollaborationTerminalRecordBase = {
  schemaVersion: 1;
  grantId: string;
  transitionDigest: string | null;
  reason: string;
  recordedAt: string;
  envelope: CollaborationGrantEnvelope;
  use: CollaborationGrantUseProjection | null;
};

export type CollaborationTerminalRecord = CollaborationTerminalRecordBase &
  (
    | {
        state: 'revoked';
        revocationAuthorization: HumanRevocationAuthorization;
      }
    | {
        state: 'consumed' | 'failed' | 'expired';
        revocationAuthorization?: never;
      }
  );

export type CollaborationGrantInspection = {
  grantId: string;
  version: CollaborationGrantEnvelope['payload']['version'];
  signatureNamespace: ReturnType<
    CollaborationGrantCodec['collaborationGrantSignatureNamespace']
  >;
  authorizedEffect: typeof COLLABORATION_GRANT_AUTHORIZED_EFFECT;
  state:
    'available' | 'reserved' | 'revoked' | 'consumed' | 'failed' | 'expired';
  changeId: string;
  taskId: string | null;
  lifecyclePhase: CollaborationLifecyclePhase;
  targetDigest: string;
  degradedForm: CollaborationDegradedForm;
  issuedAt: string;
  expiresAt: string;
  signer: string;
  signedEnvelopeDigest: string;
  transitionDigest?: string;
  terminalReason?: string;
  use?: CollaborationGrantUseProjection;
};

export type CollaborationReservationRequest = {
  transitionDigest: string;
  expected: CollaborationGrantExpectedBinding;
  now?: Date;
  verifier?: AuthoritativeCollaborationGrantVerifier;
};

export type CollaborationGrantSelectionCoreBinding = Pick<
  CollaborationGrantExpectedBinding,
  | 'repositoryId'
  | 'repositoryOrigin'
  | 'policyBlob'
  | 'collaborationPolicyDigest'
  | 'changeId'
  | 'taskId'
  | 'baselineCommit'
  | 'baselineTree'
  | 'targetDigest'
  | 'lifecyclePhase'
  | 'rolePair'
>;

export type CollaborationGrantSelectableDegradedForm = Extract<
  CollaborationDegradedForm,
  'caller-supplied' | 'direct-human-review'
>;

export type CollaborationGrantSelectionRequest = {
  expectedCore: CollaborationGrantSelectionCoreBinding;
  allowedDegradedForms: readonly CollaborationGrantSelectableDegradedForm[];
  now?: Date;
  verifier?: AuthoritativeCollaborationGrantVerifier;
};

export type CollaborationGrantSelection = {
  reservation: CollaborationReservationRecord;
  expectedBinding: CollaborationGrantExpectedBinding;
};

export type CollaborationConsumptionRequest = {
  transitionDigest: string;
  assignment: unknown;
  contentAdmission: CollaborationContentAdmission;
  directHumanReviewAttestation?: DirectHumanReviewAttestation | null;
  now?: Date;
  verifier?: AuthoritativeCollaborationGrantVerifier;
};

export type CollaborationContentAdmission = CollaborationStructuredContent & {
  current: true;
};

export type CollaborationGrantUseValidationOptions = {
  now: Date;
  expectedBinding: CollaborationGrantExpectedBinding;
  policy: MaintainerPolicy;
  verifier: GrantVerifierPort;
  transitionDigest: string;
  expectedAssignment: unknown;
  contentAdmission: CollaborationContentAdmission;
};

export type CollaborationGrantUseValidationEntry = {
  value: unknown;
  options: CollaborationGrantUseValidationOptions;
};

export type CollaborationGrantConsumedReplayRequest = Readonly<
  Pick<
    CollaborationConsumptionRequest,
    | 'transitionDigest'
    | 'assignment'
    | 'contentAdmission'
    | 'directHumanReviewAttestation'
  >
>;

export type VerifiedConsumedCollaborationGrantReplay = Readonly<{
  schemaVersion: 1;
  kind: 'verified-consumed-collaboration-grant-replay.v1';
  grantId: string;
  transitionDigest: string;
  useDigest: string;
}>;

export type ConsumedCollaborationGrantUseReader = (
  proof: VerifiedConsumedCollaborationGrantReplay,
) => CollaborationGrantUseProjection;
