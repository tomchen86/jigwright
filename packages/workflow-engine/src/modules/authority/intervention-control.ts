/**
 * Models minimal updater transitions, recovery decisions and permitted
 * workflow replacement reasons.
 *
 * Invariants:
 * - The minimal updater advances only along `MINIMAL_UPDATER_TRANSITIONS`;
 *   an event unmapped from the current state is rejected.
 * - `validateWorkflowSupersedeReason` refuses execution-failure reasons,
 *   accepting only the explicit replacement reasons in
 *   `WORKFLOW_SUPERSEDE_REASONS`.
 */
import {
  type Sha256Digest,
  freezeDeep,
  canonicalDigest,
  assertDigest,
  assertNonEmpty,
  assertMonotonicTimestamp,
} from './intervention-control-values.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  type VerifiedControlPlaneGrantV2,
  type VerifiedControlPlaneGrantV3,
} from './intervention-control-promotion-grant.ts';

export {
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
} from './intervention-control-values.ts';

export type { Sha256Digest } from './intervention-control-values.ts';

export {
  createWipCheckpoint,
  verifyWipCheckpoint,
  beginHarnessIntervention,
  createEngineArtifact,
  canonicalHarnessMaintenanceGrantPayload,
  verifyHarnessMaintenanceGrant,
  prepareEngineAdoption,
  advanceEngineAdoption,
  decideEngineAdoptionRecovery,
  finalizeEngineAdoption,
} from './intervention-control-adoption.ts';

export type {
  WipCheckpointInput,
  WipCheckpoint,
  ParentChangeStatus,
  HarnessInterventionBlocker,
  ParentChangeState,
  HarnessInterventionRelationship,
  EngineArtifactInput,
  EngineArtifact,
  HarnessMaintenanceOperation,
  HarnessMaintenanceWaiver,
  HarnessMaintenanceGrantPayload,
  HarnessMaintenanceGrantEnvelope,
  VerifiedHarnessMaintenanceGrant,
  EngineAdoptionState,
  EngineAdoptionJournal,
  EngineAdoptionRecoveryDecision,
} from './intervention-control-adoption.ts';

export {
  REQUIRED_PROTECTED_CAPABILITIES,
  protectedCapabilityClosureDigest,
  createProtectedCapabilityManifest,
  controlPlaneCandidateDigest,
  classifyProtectedCandidateImpact,
} from './intervention-control-protected-manifest.ts';

export type {
  ProtectedCapability,
  ProtectedCapabilityEntry,
  CollaborationGrantVerifierComposition,
  RoleContextSharingGrantVerifierBinding,
  ProtectedCapabilityManifest,
  ExactControlPlaneChange,
  ProtectedCandidateImpact,
} from './intervention-control-protected-manifest.ts';

export {
  canonicalControlPlaneIndependentReviewAttestationPayload,
  controlPlaneIndependentReviewAttestationDigest,
  verifyControlPlaneIndependentReviewAttestation,
  canonicalControlPlaneIndependentReviewAttestationPayloadV2,
  controlPlaneIndependentReviewAttestationDigestV2,
  verifyControlPlaneIndependentReviewAttestationV2,
  canonicalControlPlaneIndependentReviewAttestationPayloadV3,
  controlPlaneIndependentReviewAttestationDigestV3,
  verifyControlPlaneIndependentReviewAttestationV3,
} from './intervention-control-review.ts';

export type {
  ControlPlaneIndependentReviewAttestationPayload,
  ControlPlaneIndependentReviewAttestationEnvelope,
  VerifiedControlPlaneIndependentReviewAttestation,
  ControlPlaneIndependentReviewAttestationPayloadV2,
  ControlPlaneIndependentReviewAttestationEnvelopeV2,
  VerifiedControlPlaneIndependentReviewAttestationV2,
  ControlPlaneIndependentReviewAttestationPayloadV3,
  ControlPlaneIndependentReviewAttestationEnvelopeV3,
  VerifiedControlPlaneIndependentReviewAttestationV3,
} from './intervention-control-review.ts';

export {
  normalizeControlPlaneTaskMandateBinding,
  createControlPlanePromotionLineage,
  controlPlanePromotionLineageDigest,
  controlPlaneCandidateDigestV2,
  classifyProtectedCandidateImpactV2,
  createControlPlaneRecoveryBundleMaterial,
  createControlPlanePromotionMaterial,
  controlPlanePromotionMaterialDigest,
} from './intervention-control-promotion-material.ts';

export type {
  ControlPlaneTaskMandateBinding,
  ControlPlaneFileModeV2,
  ExactControlPlaneChangeV2,
  ControlPlanePromotionFileMaterial,
  ControlPlaneRecoveryBundleMaterial,
  ControlPlanePromotionLineage,
  ControlPlanePromotionMaterial,
} from './intervention-control-promotion-material.ts';

export {
  createControlPlanePromotionBundleV2,
  controlPlanePromotionBundleDigestV2,
  canonicalControlPlaneGrantPayloadV2,
  verifyControlPlaneGrantV2,
  createControlPlanePromotionBundleV3,
  verifyControlPlanePromotionBundleV3,
  controlPlanePromotionBundleDigestV3,
  canonicalControlPlaneGrantPayloadV3,
  verifyControlPlaneGrantV3,
} from './intervention-control-promotion-grant.ts';

export type {
  ControlPlanePromotionBundleV2,
  ControlPlaneGrantPayloadV2,
  ControlPlaneGrantEnvelopeV2,
  VerifiedControlPlaneGrantV2,
  ControlPlanePromotionBundleV3,
  ControlPlaneGrantPayloadV3,
  ControlPlaneGrantEnvelopeV3,
  VerifiedControlPlaneGrantV3,
} from './intervention-control-promotion-grant.ts';

export type MinimalUpdaterState =
  | 'PREPARED'
  | 'OLD_CLOSURE_VERIFIED'
  | 'CANDIDATE_VERIFIED'
  | 'RECOVERY_VERIFIED'
  | 'SWITCHED'
  | 'SELF_TESTED'
  | 'ROLLBACK_REQUIRED'
  | 'FINALIZED'
  | 'ROLLED_BACK';

export interface MinimalUpdaterTransaction {
  kind: 'minimal-control-plane-updater.v1';
  txId: string;
  grantId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  updaterVersion: number;
  state: MinimalUpdaterState;
  history: Array<{ state: MinimalUpdaterState; at: string }>;
  journalDigest: Sha256Digest;
}

type MinimalUpdaterEvent =
  | { kind: 'old-closure-verified'; at: string }
  | { kind: 'candidate-verified'; at: string }
  | { kind: 'recovery-bundle-verified'; at: string }
  | { kind: 'atomic-switch-completed'; at: string }
  | { kind: 'self-tests-passed'; at: string }
  | { kind: 'self-tests-failed'; at: string }
  | { kind: 'finalize'; at: string }
  | { kind: 'rollback-completed'; at: string };

function minimalUpdaterPayload(
  tx: Omit<MinimalUpdaterTransaction, 'journalDigest'>,
) {
  return { ...tx };
}

function buildMinimalUpdaterTransaction(
  tx: Omit<MinimalUpdaterTransaction, 'journalDigest'>,
): MinimalUpdaterTransaction {
  return freezeDeep({
    ...tx,
    journalDigest: canonicalDigest(minimalUpdaterPayload(tx)),
  });
}

function verifyMinimalUpdaterTransaction(tx: MinimalUpdaterTransaction): void {
  assertDigest(tx.journalDigest, 'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT');
  const { journalDigest, ...payload } = tx;
  if (
    canonicalDigest(minimalUpdaterPayload(payload)) !== journalDigest ||
    tx.history.length === 0 ||
    tx.history.at(-1)?.state !== tx.state
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT',
      'Minimal updater journal failed integrity verification.',
      ExitCode.verification,
    );
  }
}

export function prepareMinimalUpdaterTransaction(
  grant: VerifiedControlPlaneGrantV2 | VerifiedControlPlaneGrantV3,
  input: { txId: string; now: Date },
): MinimalUpdaterTransaction {
  assertNonEmpty(
    input.txId,
    'CONTROL_PLANE_UPDATE_INVALID',
    'Control-plane transaction id',
  );
  if (
    grant.verification !== 'human-signature-verified' ||
    grant.payload.oneShot !== true
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_GRANT_INVALID',
      'Minimal updater requires a verified one-shot Control-Plane Grant.',
      ExitCode.guard,
    );
  }
  if (input.now.getTime() >= Date.parse(grant.payload.expiresAt)) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_GRANT_EXPIRED',
      'Grant expired before updater preparation.',
      ExitCode.staleState,
    );
  }
  const at = input.now.toISOString();
  return buildMinimalUpdaterTransaction({
    kind: 'minimal-control-plane-updater.v1',
    txId: input.txId,
    grantId: grant.payload.grantId,
    candidateDigest: grant.payload.candidateDigest,
    beforeClosureDigest: grant.payload.beforeClosureDigest,
    afterClosureDigest: grant.payload.afterClosureDigest,
    recoveryBundleDigest: grant.payload.recoveryBundle.bundleDigest,
    updaterVersion: grant.payload.updaterVersion,
    state: 'PREPARED',
    history: [{ state: 'PREPARED', at }],
  });
}

const MINIMAL_UPDATER_TRANSITIONS: Record<
  MinimalUpdaterState,
  Partial<Record<MinimalUpdaterEvent['kind'], MinimalUpdaterState>>
> = {
  PREPARED: { 'old-closure-verified': 'OLD_CLOSURE_VERIFIED' },
  OLD_CLOSURE_VERIFIED: { 'candidate-verified': 'CANDIDATE_VERIFIED' },
  CANDIDATE_VERIFIED: { 'recovery-bundle-verified': 'RECOVERY_VERIFIED' },
  RECOVERY_VERIFIED: { 'atomic-switch-completed': 'SWITCHED' },
  SWITCHED: {
    'self-tests-passed': 'SELF_TESTED',
    'self-tests-failed': 'ROLLBACK_REQUIRED',
  },
  SELF_TESTED: { finalize: 'FINALIZED' },
  ROLLBACK_REQUIRED: { 'rollback-completed': 'ROLLED_BACK' },
  FINALIZED: {},
  ROLLED_BACK: {},
};

export function advanceMinimalUpdaterTransaction(
  tx: MinimalUpdaterTransaction,
  event: MinimalUpdaterEvent,
): MinimalUpdaterTransaction {
  verifyMinimalUpdaterTransaction(tx);
  const nextState = MINIMAL_UPDATER_TRANSITIONS[tx.state][event.kind];
  if (nextState === undefined) {
    throw workflowError(
      'CONTROL_PLANE_UPDATE_TRANSITION_INVALID',
      `Cannot apply ${event.kind} while updater is ${tx.state}.`,
      ExitCode.conflict,
    );
  }
  assertMonotonicTimestamp(
    tx.history.at(-1)!.at,
    event.at,
    'CONTROL_PLANE_UPDATE_TRANSITION_INVALID',
  );
  const { journalDigest: _journalDigest, ...payload } = tx;
  return buildMinimalUpdaterTransaction({
    ...payload,
    state: nextState,
    history: [...tx.history, { state: nextState, at: event.at }],
  });
}

export type ControlPlaneRecoveryDecision = {
  action:
    | 'none'
    | 'resume-verification'
    | 'rollback-with-recovery-bundle'
    | 'finalize';
  authoritativeClosureDigest: Sha256Digest;
  terminal: boolean;
};

export function decideControlPlaneRecovery(
  tx: MinimalUpdaterTransaction,
): ControlPlaneRecoveryDecision {
  verifyMinimalUpdaterTransaction(tx);
  switch (tx.state) {
    case 'PREPARED':
    case 'OLD_CLOSURE_VERIFIED':
    case 'CANDIDATE_VERIFIED':
    case 'RECOVERY_VERIFIED':
      return {
        action: 'resume-verification',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: false,
      };
    case 'SWITCHED':
    case 'ROLLBACK_REQUIRED':
      return {
        action: 'rollback-with-recovery-bundle',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: false,
      };
    case 'SELF_TESTED':
      return {
        action: 'finalize',
        authoritativeClosureDigest: tx.afterClosureDigest,
        terminal: false,
      };
    case 'FINALIZED':
      return {
        action: 'none',
        authoritativeClosureDigest: tx.afterClosureDigest,
        terminal: true,
      };
    case 'ROLLED_BACK':
      return {
        action: 'none',
        authoritativeClosureDigest: tx.beforeClosureDigest,
        terminal: true,
      };
  }
}

// ---------------------------------------------------------------------------
// M11: supersede restriction and legacy v1 read-only verification
// ---------------------------------------------------------------------------

export const WORKFLOW_SUPERSEDE_REASONS = [
  'semantic-decision-no-continuing-value',
  'user-abandoned-goal-for-different-workflow',
  'workflow-replaced',
  'workflows-merged',
] as const;

export type WorkflowSupersedeReason =
  (typeof WORKFLOW_SUPERSEDE_REASONS)[number];

const EXECUTION_FAILURE_REASONS = new Set([
  'environment-drift',
  'execution-limit-change',
  'network-error',
  'provider-adapter-upgrade',
  'provider-process-failure',
  'provider-timeout',
  'rate-limit',
  'retry-policy-change',
  'schema-invalid',
  'validator-repair',
  'worker-crash',
]);

export function validateWorkflowSupersedeReason(reason: string): {
  allowed: true;
  reason: WorkflowSupersedeReason;
} {
  if (WORKFLOW_SUPERSEDE_REASONS.includes(reason as WorkflowSupersedeReason)) {
    return { allowed: true, reason: reason as WorkflowSupersedeReason };
  }
  if (EXECUTION_FAILURE_REASONS.has(reason)) {
    throw workflowError(
      'SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN',
      'Execution failures must use retry, repair, grant, or recovery; they cannot supersede a workflow.',
      ExitCode.guard,
    );
  }
  if (reason === 'contract-or-baseline-change') {
    throw workflowError(
      'SUPERSEDE_REQUIRES_EPOCH_ROLLOVER',
      'Contract or baseline changes require an epoch rollover, not supersede.',
      ExitCode.guard,
    );
  }
  throw workflowError(
    'SUPERSEDE_REASON_UNSUPPORTED',
    'Supersede requires an explicit workflow-replacement reason.',
    ExitCode.usage,
  );
}
