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
import { freezeDeep, canonicalDigest, assertDigest, assertNonEmpty, assertMonotonicTimestamp, } from "./intervention-control-values.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export { HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE, CONTROL_PLANE_SIGNATURE_NAMESPACE_V2, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2, CONTROL_PLANE_SIGNATURE_NAMESPACE_V3, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3, } from "./intervention-control-values.js";
export { createWipCheckpoint, verifyWipCheckpoint, beginHarnessIntervention, createEngineArtifact, canonicalHarnessMaintenanceGrantPayload, verifyHarnessMaintenanceGrant, prepareEngineAdoption, advanceEngineAdoption, decideEngineAdoptionRecovery, finalizeEngineAdoption, } from "./intervention-control-adoption.js";
export { REQUIRED_PROTECTED_CAPABILITIES, protectedCapabilityClosureDigest, createProtectedCapabilityManifest, controlPlaneCandidateDigest, classifyProtectedCandidateImpact, } from "./intervention-control-protected-manifest.js";
export { canonicalControlPlaneIndependentReviewAttestationPayload, controlPlaneIndependentReviewAttestationDigest, verifyControlPlaneIndependentReviewAttestation, canonicalControlPlaneIndependentReviewAttestationPayloadV2, controlPlaneIndependentReviewAttestationDigestV2, verifyControlPlaneIndependentReviewAttestationV2, canonicalControlPlaneIndependentReviewAttestationPayloadV3, controlPlaneIndependentReviewAttestationDigestV3, verifyControlPlaneIndependentReviewAttestationV3, } from "./intervention-control-review.js";
export { normalizeControlPlaneTaskMandateBinding, createControlPlanePromotionLineage, controlPlanePromotionLineageDigest, controlPlaneCandidateDigestV2, classifyProtectedCandidateImpactV2, createControlPlaneRecoveryBundleMaterial, createControlPlanePromotionMaterial, controlPlanePromotionMaterialDigest, } from "./intervention-control-promotion-material.js";
export { createControlPlanePromotionBundleV2, controlPlanePromotionBundleDigestV2, canonicalControlPlaneGrantPayloadV2, verifyControlPlaneGrantV2, createControlPlanePromotionBundleV3, verifyControlPlanePromotionBundleV3, controlPlanePromotionBundleDigestV3, canonicalControlPlaneGrantPayloadV3, verifyControlPlaneGrantV3, } from "./intervention-control-promotion-grant.js";
function minimalUpdaterPayload(tx) {
    return { ...tx };
}
function buildMinimalUpdaterTransaction(tx) {
    return freezeDeep({
        ...tx,
        journalDigest: canonicalDigest(minimalUpdaterPayload(tx)),
    });
}
function verifyMinimalUpdaterTransaction(tx) {
    assertDigest(tx.journalDigest, 'CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT');
    const { journalDigest, ...payload } = tx;
    if (canonicalDigest(minimalUpdaterPayload(payload)) !== journalDigest ||
        tx.history.length === 0 ||
        tx.history.at(-1)?.state !== tx.state) {
        throw workflowError('CONTROL_PLANE_UPDATE_JOURNAL_CORRUPT', 'Minimal updater journal failed integrity verification.', ExitCode.verification);
    }
}
export function prepareMinimalUpdaterTransaction(grant, input) {
    assertNonEmpty(input.txId, 'CONTROL_PLANE_UPDATE_INVALID', 'Control-plane transaction id');
    if (grant.verification !== 'human-signature-verified' ||
        grant.payload.oneShot !== true) {
        throw workflowError('CONTROL_PLANE_UPDATE_GRANT_INVALID', 'Minimal updater requires a verified one-shot Control-Plane Grant.', ExitCode.guard);
    }
    if (input.now.getTime() >= Date.parse(grant.payload.expiresAt)) {
        throw workflowError('CONTROL_PLANE_UPDATE_GRANT_EXPIRED', 'Grant expired before updater preparation.', ExitCode.staleState);
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
const MINIMAL_UPDATER_TRANSITIONS = {
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
export function advanceMinimalUpdaterTransaction(tx, event) {
    verifyMinimalUpdaterTransaction(tx);
    const nextState = MINIMAL_UPDATER_TRANSITIONS[tx.state][event.kind];
    if (nextState === undefined) {
        throw workflowError('CONTROL_PLANE_UPDATE_TRANSITION_INVALID', `Cannot apply ${event.kind} while updater is ${tx.state}.`, ExitCode.conflict);
    }
    assertMonotonicTimestamp(tx.history.at(-1).at, event.at, 'CONTROL_PLANE_UPDATE_TRANSITION_INVALID');
    const { journalDigest: _journalDigest, ...payload } = tx;
    return buildMinimalUpdaterTransaction({
        ...payload,
        state: nextState,
        history: [...tx.history, { state: nextState, at: event.at }],
    });
}
export function decideControlPlaneRecovery(tx) {
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
];
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
export function validateWorkflowSupersedeReason(reason) {
    if (WORKFLOW_SUPERSEDE_REASONS.includes(reason)) {
        return { allowed: true, reason: reason };
    }
    if (EXECUTION_FAILURE_REASONS.has(reason)) {
        throw workflowError('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN', 'Execution failures must use retry, repair, grant, or recovery; they cannot supersede a workflow.', ExitCode.guard);
    }
    if (reason === 'contract-or-baseline-change') {
        throw workflowError('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER', 'Contract or baseline changes require an epoch rollover, not supersede.', ExitCode.guard);
    }
    throw workflowError('SUPERSEDE_REASON_UNSUPPORTED', 'Supersede requires an explicit workflow-replacement reason.', ExitCode.usage);
}
