/**
 * Validates signed independent reviews of exact control-plane promotion
 * material and lineage.
 *
 * Invariants:
 * - The independent reviewer must differ from the grant signer.
 * - The review must be completed no later than grant issuance (reviewedAt
 *   not after grantIssuedAt).
 */
import { canonicalDigest, assertDigest, assertIsoTimestamp, sameJson, verifyHumanSignatureSafely, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE, freezeDeep, hasExactObjectKeys, assertNonEmpty, assertSortedUnique, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3, } from "./intervention-control-values.js";
import { REQUIRED_PROTECTED_CAPABILITIES, } from "./intervention-control-protected-manifest.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { normalizeAffectedCapabilitiesV2, verifyControlPlanePromotionMaterial, controlPlanePromotionMaterialDigest, verifyControlPlanePromotionLineage, } from "./intervention-control-promotion-material.js";
export function canonicalControlPlaneIndependentReviewAttestationPayload(payload) {
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigest(envelope) {
    validateControlPlaneIndependentReviewAttestation(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestation(envelope, context) {
    validateControlPlaneIndependentReviewAttestation(envelope);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    const payload = envelope.payload;
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    if (payload.repositoryId !== context.repositoryId) {
        throw workflowError('CONTROL_PLANE_REVIEW_REPOSITORY_MISMATCH', 'Independent review is bound to a different repository.', ExitCode.verification);
    }
    if (payload.candidateDigest !== context.candidateDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_CANDIDATE_MISMATCH', 'Independent review is bound to a different candidate.', ExitCode.verification);
    }
    if (payload.beforeClosureDigest !== context.beforeClosureDigest ||
        payload.afterClosureDigest !== context.afterClosureDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_CLOSURE_MISMATCH', 'Independent review is bound to different protected closures.', ExitCode.verification);
    }
    if (payload.recoveryBundleDigest !== context.recoveryBundleDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_RECOVERY_MISMATCH', 'Independent review is bound to a different recovery bundle.', ExitCode.verification);
    }
    if (!sameJson(payload.affectedCapabilities, context.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_CAPABILITY_MISMATCH', 'Independent review does not bind the exact affected capabilities.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayload(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review attestation signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
export function validateControlPlaneIndependentReviewAttestation(envelope) {
    if (!hasExactObjectKeys(envelope, ['payload', 'signature']) ||
        !hasExactObjectKeys(envelope.payload, [
            'affectedCapabilities',
            'afterClosureDigest',
            'beforeClosureDigest',
            'candidateDigest',
            'kind',
            'recoveryBundleDigest',
            'repositoryId',
            'reviewSummary',
            'reviewedAt',
            'reviewer',
            'verdict',
        ]) ||
        envelope.payload.kind !== 'control-plane-independent-review.v1' ||
        envelope.payload.verdict !== 'approved') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review attestation has an unknown or non-approved schema.', ExitCode.guard);
    }
    const payload = envelope.payload;
    for (const [value, label] of [
        [payload.repositoryId, 'Repository id'],
        [payload.reviewSummary, 'Review summary'],
        [payload.reviewer, 'Reviewer'],
        [envelope.signature, 'Review signature'],
    ]) {
        assertNonEmpty(value, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', label);
    }
    for (const digest of [
        payload.candidateDigest,
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.recoveryBundleDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    }
    if (!Array.isArray(payload.affectedCapabilities) ||
        payload.affectedCapabilities.some((capability) => !REQUIRED_PROTECTED_CAPABILITIES.includes(capability))) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review contains an unknown protected capability.', ExitCode.guard);
    }
    assertSortedUnique(payload.affectedCapabilities, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertIsoTimestamp(payload.reviewedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
}
export function validateControlPlaneIndependentReviewPayloadV2(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'candidateDigest',
        'frozenCandidateBundleDigest',
        'kind',
        'promotionMaterialDigest',
        'recoveryBundleDigest',
        'repositoryId',
        'reviewSummary',
        'reviewedAt',
        'reviewer',
        'verdict',
    ])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 has an unknown schema.', ExitCode.guard);
    }
    const payload = value;
    if (payload.kind !== 'control-plane-independent-review.v2' ||
        payload.verdict !== 'approved') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 is not an approved supported attestation.', ExitCode.guard);
    }
    for (const [field, label] of [
        [payload.repositoryId, 'Repository id'],
        [payload.reviewSummary, 'Review summary'],
        [payload.reviewer, 'Reviewer'],
    ]) {
        assertNonEmpty(field, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', label);
    }
    for (const digest of [
        payload.frozenCandidateBundleDigest,
        payload.candidateDigest,
        payload.promotionMaterialDigest,
        payload.beforeClosureDigest,
        payload.afterClosureDigest,
        payload.recoveryBundleDigest,
    ]) {
        assertDigest(digest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    }
    normalizeAffectedCapabilitiesV2(payload.affectedCapabilities, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertIsoTimestamp(payload.reviewedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
}
export function validateControlPlaneIndependentReviewAttestationV2(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v2 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneIndependentReviewPayloadV2(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Review signature');
}
export function canonicalControlPlaneIndependentReviewAttestationPayloadV2(payload) {
    validateControlPlaneIndependentReviewPayloadV2(payload);
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigestV2(envelope) {
    validateControlPlaneIndependentReviewAttestationV2(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestationV2(envelope, context) {
    validateControlPlaneIndependentReviewAttestationV2(envelope);
    const material = verifyControlPlanePromotionMaterial(context.material);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertNonEmpty(context.grantHumanSigner, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Grant signer');
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review v2 bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    const payload = envelope.payload;
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    const materialDigest = controlPlanePromotionMaterialDigest(material);
    if (payload.promotionMaterialDigest !== materialDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review is bound to different promotion material.', ExitCode.verification);
    }
    if (payload.repositoryId !== material.repositoryId ||
        payload.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        payload.candidateDigest !== material.candidateDigest ||
        payload.beforeClosureDigest !== material.beforeClosureDigest ||
        payload.afterClosureDigest !== material.afterClosureDigest ||
        payload.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(payload.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review denormalized bindings differ from promotion material.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayloadV2(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review v2 signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
export function reviewPayloadV2Projection(payload) {
    const { promotionLineageDigest: _promotionLineageDigest, ...rest } = payload;
    return { ...rest, kind: 'control-plane-independent-review.v2' };
}
export function validateControlPlaneIndependentReviewPayloadV3(value) {
    if (!hasExactObjectKeys(value, [
        'affectedCapabilities',
        'afterClosureDigest',
        'beforeClosureDigest',
        'candidateDigest',
        'frozenCandidateBundleDigest',
        'kind',
        'promotionLineageDigest',
        'promotionMaterialDigest',
        'recoveryBundleDigest',
        'repositoryId',
        'reviewSummary',
        'reviewedAt',
        'reviewer',
        'verdict',
    ]) ||
        value.kind !== 'control-plane-independent-review.v3') {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v3 has an unknown schema.', ExitCode.guard);
    }
    const payload = value;
    assertDigest(payload.promotionLineageDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    validateControlPlaneIndependentReviewPayloadV2(reviewPayloadV2Projection(payload));
}
export function validateControlPlaneIndependentReviewAttestationV3(value) {
    if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Independent review v3 envelope has an unknown schema.', ExitCode.guard);
    }
    const envelope = value;
    validateControlPlaneIndependentReviewPayloadV3(envelope.payload);
    assertNonEmpty(envelope.signature, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Review signature');
}
export function canonicalControlPlaneIndependentReviewAttestationPayloadV3(payload) {
    validateControlPlaneIndependentReviewPayloadV3(payload);
    return `${canonicalJson(payload)}\n`;
}
export function controlPlaneIndependentReviewAttestationDigestV3(envelope) {
    validateControlPlaneIndependentReviewAttestationV3(envelope);
    return canonicalDigest(envelope);
}
export function verifyControlPlaneIndependentReviewAttestationV3(envelope, context) {
    validateControlPlaneIndependentReviewAttestationV3(envelope);
    const material = verifyControlPlanePromotionMaterial(context.material);
    const lineage = verifyControlPlanePromotionLineage(context.lineage);
    assertDigest(context.expectedDigest, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    assertNonEmpty(context.grantHumanSigner, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID', 'Grant signer');
    assertIsoTimestamp(context.grantIssuedAt, 'CONTROL_PLANE_REVIEW_ATTESTATION_INVALID');
    const attestationDigest = canonicalDigest(envelope);
    const payload = envelope.payload;
    if (attestationDigest !== context.expectedDigest) {
        throw workflowError('CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH', 'Independent review v3 bytes do not match the grant-bound digest.', ExitCode.verification);
    }
    if (Date.parse(payload.reviewedAt) > Date.parse(context.grantIssuedAt)) {
        throw workflowError('CONTROL_PLANE_REVIEW_TIMESTAMP_INVALID', 'Independent review must be completed before grant issuance.', ExitCode.guard);
    }
    if (payload.reviewer === context.grantHumanSigner) {
        throw workflowError('CONTROL_PLANE_REVIEWER_NOT_INDEPENDENT', 'The independent reviewer must differ from the grant signer.', ExitCode.guard);
    }
    if (payload.promotionMaterialDigest !==
        controlPlanePromotionMaterialDigest(material) ||
        payload.promotionLineageDigest !== lineage.lineageDigest ||
        payload.repositoryId !== material.repositoryId ||
        payload.frozenCandidateBundleDigest !==
            material.frozenCandidateBundleDigest ||
        payload.candidateDigest !== material.candidateDigest ||
        payload.beforeClosureDigest !== material.beforeClosureDigest ||
        payload.afterClosureDigest !== material.afterClosureDigest ||
        payload.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
        !sameJson(payload.affectedCapabilities, material.affectedCapabilities)) {
        throw workflowError('CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH', 'Independent review v3 does not bind the exact material and predecessor lineage.', ExitCode.verification);
    }
    if (!verifyHumanSignatureSafely(context.verifyHumanSignature, canonicalControlPlaneIndependentReviewAttestationPayloadV3(payload), envelope.signature, payload.reviewer, CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3)) {
        throw workflowError('CONTROL_PLANE_REVIEW_SIGNATURE_INVALID', 'Independent review v3 signature could not be verified.', ExitCode.verification);
    }
    return freezeDeep({
        payload: {
            ...payload,
            affectedCapabilities: [...payload.affectedCapabilities],
        },
        signature: envelope.signature,
        attestationDigest,
        verification: 'independent-human-signature-verified',
    });
}
