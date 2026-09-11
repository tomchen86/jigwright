/**
 * Builds and verifies promotion Grants bound to exact control-plane
 * material and review evidence.
 *
 * Invariants:
 * - A Control-Plane Grant v2 is valid only for a positive lifetime of at
 *   most five minutes (`CONTROL_PLANE_GRANT_V2_MAX_TTL_MS`).
 * - The v3 Grant reuses material checks but verifies the actual human
 *   signature under its own v3 namespace.
 */
import {
  type ControlPlanePromotionMaterial,
  verifyControlPlanePromotionMaterial,
  controlPlanePromotionMaterialDigest,
  type ControlPlaneTaskMandateBinding,
  type ExactControlPlaneChangeV2,
  normalizeControlPlaneTaskMandateBinding,
  normalizedExactChangesV2,
  normalizeAffectedCapabilitiesV2,
  controlPlaneCandidateDigestV2,
  classifyProtectedCandidateImpactV2,
  type ControlPlanePromotionLineage,
  verifyControlPlanePromotionLineage,
} from './intervention-control-promotion-material.ts';

import {
  type Sha256Digest,
  hasExactObjectKeys,
  sameJson,
  freezeDeep,
  canonicalDigest,
  assertDigest,
  assertNonEmpty,
  assertIsoTimestamp,
  type HumanSignatureVerifier,
  verifyHumanSignatureSafely,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
} from './intervention-control-values.ts';

import {
  type ControlPlaneIndependentReviewAttestationEnvelopeV2,
  validateControlPlaneIndependentReviewAttestationV2,
  controlPlaneIndependentReviewAttestationDigestV2,
  verifyControlPlaneIndependentReviewAttestationV2,
  type ControlPlaneIndependentReviewAttestationEnvelopeV3,
  validateControlPlaneIndependentReviewAttestationV3,
  controlPlaneIndependentReviewAttestationDigestV3,
  reviewPayloadV2Projection,
  verifyControlPlaneIndependentReviewAttestationV3,
} from './intervention-control-review.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  type ProtectedCapability,
  type ProtectedCapabilityManifest,
  verifyProtectedManifest,
} from './intervention-control-protected-manifest.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export const CONTROL_PLANE_GRANT_V2_MAX_TTL_MS = 5 * 60 * 1000;

export interface ControlPlanePromotionBundleV2 {
  kind: 'control-plane-promotion-bundle.v2';
  material: ControlPlanePromotionMaterial;
  promotionMaterialDigest: Sha256Digest;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelopeV2;
  bundleDigest: Sha256Digest;
}

export function createControlPlanePromotionBundleV2(input: {
  material: ControlPlanePromotionMaterial;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelopeV2;
}): ControlPlanePromotionBundleV2 {
  if (
    !hasExactObjectKeys(input, ['independentReviewAttestation', 'material'])
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
      'Promotion bundle v2 input has an unknown schema.',
      ExitCode.guard,
    );
  }
  const material = verifyControlPlanePromotionMaterial(input.material);
  const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
  validateControlPlaneIndependentReviewAttestationV2(
    input.independentReviewAttestation,
  );
  const review = input.independentReviewAttestation.payload;
  if (
    review.promotionMaterialDigest !== promotionMaterialDigest ||
    review.repositoryId !== material.repositoryId ||
    review.frozenCandidateBundleDigest !==
      material.frozenCandidateBundleDigest ||
    review.candidateDigest !== material.candidateDigest ||
    review.beforeClosureDigest !== material.beforeClosureDigest ||
    review.afterClosureDigest !== material.afterClosureDigest ||
    review.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
    !sameJson(review.affectedCapabilities, material.affectedCapabilities)
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH',
      'Signed review does not bind the exact promotion material.',
      ExitCode.verification,
    );
  }
  const payload = {
    kind: 'control-plane-promotion-bundle.v2' as const,
    material,
    promotionMaterialDigest,
    independentReviewAttestation: structuredClone(
      input.independentReviewAttestation,
    ),
  };
  return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}

export function verifyControlPlanePromotionBundleV2(
  value: unknown,
): ControlPlanePromotionBundleV2 {
  if (
    !hasExactObjectKeys(value, [
      'bundleDigest',
      'independentReviewAttestation',
      'kind',
      'material',
      'promotionMaterialDigest',
    ])
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
      'Promotion bundle v2 has an unknown schema.',
      ExitCode.guard,
    );
  }
  const bundle = value as ControlPlanePromotionBundleV2;
  if (bundle.kind !== 'control-plane-promotion-bundle.v2') {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
      'Promotion bundle v2 kind is not supported.',
      ExitCode.guard,
    );
  }
  assertDigest(
    bundle.promotionMaterialDigest,
    'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
  );
  assertDigest(bundle.bundleDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
  const rebuilt = createControlPlanePromotionBundleV2({
    material: bundle.material,
    independentReviewAttestation: bundle.independentReviewAttestation,
  });
  if (!sameJson(rebuilt, bundle)) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH',
      'Promotion bundle v2 digest or canonical bytes mismatch.',
      ExitCode.verification,
    );
  }
  return rebuilt;
}

export function controlPlanePromotionBundleDigestV2(
  bundle: ControlPlanePromotionBundleV2,
): Sha256Digest {
  return verifyControlPlanePromotionBundleV2(bundle).bundleDigest;
}

export interface ControlPlaneGrantPayloadV2 {
  kind: 'control-plane-grant.v2';
  grantId: string;
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  frozenCandidateBundleDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChangeV2[];
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  affectedCapabilities: ProtectedCapability[];
  behaviorChangeSummary: string;
  recoveryBundle: {
    bundleDigest: Sha256Digest;
    previousClosureDigest: Sha256Digest;
    restartArtifactDigest: Sha256Digest;
    rollbackTestReportDigest: Sha256Digest;
  };
  independentReviewAttestationDigest: Sha256Digest;
  updaterVersion: 2;
  oneShot: true;
  issuedAt: string;
  expiresAt: string;
  humanSigner: string;
}

export interface ControlPlaneGrantEnvelopeV2 {
  payload: ControlPlaneGrantPayloadV2;
  signature: string;
}

export interface VerifiedControlPlaneGrantV2 {
  payload: ControlPlaneGrantPayloadV2;
  signature: string;
  verifiedAt: string;
  verification: 'human-signature-verified';
}

export function validateControlPlaneGrantPayloadV2(
  value: unknown,
): asserts value is ControlPlaneGrantPayloadV2 {
  if (
    !hasExactObjectKeys(value, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateDigest',
      'exactChanges',
      'expiresAt',
      'frozenCandidateBundleDigest',
      'grantId',
      'humanSigner',
      'independentReviewAttestationDigest',
      'issuedAt',
      'kind',
      'mandateBinding',
      'oneShot',
      'promotionBundleDigest',
      'promotionMaterialDigest',
      'recoveryBundle',
      'repositoryId',
      'updaterVersion',
    ])
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 has an unknown schema.',
      ExitCode.guard,
    );
  }
  const payload = value as ControlPlaneGrantPayloadV2;
  if (
    payload.kind !== 'control-plane-grant.v2' ||
    payload.oneShot !== true ||
    payload.updaterVersion !== 2
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 must be one-shot and require updater v2.',
      ExitCode.guard,
    );
  }
  normalizeControlPlaneTaskMandateBinding(payload.mandateBinding);
  for (const [field, label] of [
    [payload.grantId, 'Grant id'],
    [payload.repositoryId, 'Repository id'],
    [payload.behaviorChangeSummary, 'Behavior change summary'],
    [payload.humanSigner, 'Human signer'],
  ] as const) {
    assertNonEmpty(field, 'CONTROL_PLANE_GRANT_INVALID', label);
  }
  for (const digest of [
    payload.frozenCandidateBundleDigest,
    payload.candidateDigest,
    payload.promotionMaterialDigest,
    payload.promotionBundleDigest,
    payload.beforeClosureDigest,
    payload.afterClosureDigest,
    payload.independentReviewAttestationDigest,
  ]) {
    assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
  }
  const exactChanges = normalizedExactChangesV2(
    payload.exactChanges,
    'CONTROL_PLANE_GRANT_INVALID',
  );
  if (!sameJson(exactChanges, payload.exactChanges)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 exact changes are not canonical.',
      ExitCode.guard,
    );
  }
  normalizeAffectedCapabilitiesV2(
    payload.affectedCapabilities,
    'CONTROL_PLANE_GRANT_INVALID',
  );
  if (
    !hasExactObjectKeys(payload.recoveryBundle, [
      'bundleDigest',
      'previousClosureDigest',
      'restartArtifactDigest',
      'rollbackTestReportDigest',
    ])
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 recovery binding has an unknown schema.',
      ExitCode.guard,
    );
  }
  for (const digest of [
    payload.recoveryBundle.bundleDigest,
    payload.recoveryBundle.previousClosureDigest,
    payload.recoveryBundle.restartArtifactDigest,
    payload.recoveryBundle.rollbackTestReportDigest,
  ]) {
    assertDigest(digest, 'CONTROL_PLANE_GRANT_INVALID');
  }
  if (
    payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH',
      'Grant recovery material does not restore the exact old closure.',
      ExitCode.verification,
    );
  }
  assertIsoTimestamp(payload.issuedAt, 'CONTROL_PLANE_GRANT_INVALID');
  assertIsoTimestamp(payload.expiresAt, 'CONTROL_PLANE_GRANT_INVALID');
  const lifetimeMs =
    Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
  if (lifetimeMs <= 0 || lifetimeMs > CONTROL_PLANE_GRANT_V2_MAX_TTL_MS) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 expiry must be within five minutes of issuance.',
      ExitCode.usage,
    );
  }
}

export function validateControlPlaneGrantEnvelopeV2(
  value: unknown,
): asserts value is ControlPlaneGrantEnvelopeV2 {
  if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 envelope has an unknown schema.',
      ExitCode.guard,
    );
  }
  const envelope = value as ControlPlaneGrantEnvelopeV2;
  validateControlPlaneGrantPayloadV2(envelope.payload);
  assertNonEmpty(
    envelope.signature,
    'CONTROL_PLANE_GRANT_INVALID',
    'Signature',
  );
}

export function canonicalControlPlaneGrantPayloadV2(
  payload: ControlPlaneGrantPayloadV2,
): string {
  validateControlPlaneGrantPayloadV2(payload);
  return `${canonicalJson(payload)}\n`;
}

export function verifyControlPlaneGrantV2(
  envelope: ControlPlaneGrantEnvelopeV2,
  context: {
    now: Date;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV2;
    consumedGrantIds: ReadonlySet<string>;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): VerifiedControlPlaneGrantV2 {
  validateControlPlaneGrantEnvelopeV2(envelope);
  const payload = envelope.payload;
  if (context.consumedGrantIds.has(payload.grantId)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_ALREADY_CONSUMED',
      'One-shot Control-Plane Grant v2 has already been consumed.',
      ExitCode.conflict,
    );
  }
  const bundle = verifyControlPlanePromotionBundleV2(context.bundle);
  if (payload.promotionBundleDigest !== bundle.bundleDigest) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH',
      'Control-Plane Grant v2 is bound to a different reviewed bundle.',
      ExitCode.verification,
    );
  }
  const material = bundle.material;
  if (
    payload.promotionMaterialDigest !== bundle.promotionMaterialDigest ||
    payload.frozenCandidateBundleDigest !==
      material.frozenCandidateBundleDigest ||
    payload.candidateDigest !== material.candidateDigest ||
    payload.repositoryId !== material.repositoryId ||
    payload.beforeClosureDigest !== material.beforeClosureDigest ||
    payload.afterClosureDigest !== material.afterClosureDigest ||
    payload.behaviorChangeSummary !== material.behaviorChangeSummary ||
    !sameJson(payload.mandateBinding, material.mandateBinding) ||
    !sameJson(payload.exactChanges, material.exactChanges) ||
    !sameJson(payload.affectedCapabilities, material.affectedCapabilities)
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_MATERIAL_MISMATCH',
      'Control-Plane Grant v2 does not bind the exact promotion material.',
      ExitCode.verification,
    );
  }
  const recovery = material.recoveryBundle;
  if (
    payload.recoveryBundle.bundleDigest !== recovery.bundleDigest ||
    payload.recoveryBundle.previousClosureDigest !==
      recovery.previousClosureDigest ||
    payload.recoveryBundle.restartArtifactDigest !==
      recovery.restartArtifact.executableDigest ||
    payload.recoveryBundle.rollbackTestReportDigest !==
      recovery.rollbackTestReportDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_RECOVERY_BUNDLE_MISMATCH',
      'Control-Plane Grant v2 recovery binding is not exact.',
      ExitCode.verification,
    );
  }
  const reviewDigest = controlPlaneIndependentReviewAttestationDigestV2(
    bundle.independentReviewAttestation,
  );
  if (payload.independentReviewAttestationDigest !== reviewDigest) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_ATTESTATION_DIGEST_MISMATCH',
      'Control-Plane Grant v2 binds different independent-review bytes.',
      ExitCode.verification,
    );
  }
  verifyProtectedManifest(context.beforeManifest);
  verifyProtectedManifest(context.afterManifest);
  if (payload.beforeClosureDigest !== context.beforeManifest.manifestDigest) {
    throw workflowError(
      'CONTROL_PLANE_BEFORE_CLOSURE_MISMATCH',
      'Control-Plane Grant v2 is stale for the old protected closure.',
      ExitCode.staleState,
    );
  }
  if (payload.afterClosureDigest !== context.afterManifest.manifestDigest) {
    throw workflowError(
      'CONTROL_PLANE_AFTER_CLOSURE_MISMATCH',
      'Control-Plane Grant v2 does not bind the candidate protected closure.',
      ExitCode.verification,
    );
  }
  const exactChanges = normalizedExactChangesV2(payload.exactChanges);
  if (
    context.beforeManifest.manifestDigest !==
      context.afterManifest.manifestDigest &&
    !exactChanges.some(
      (change) => change.path === context.beforeManifest.manifestPath,
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_MANIFEST_DIFF_MISSING',
      'Changed protected manifest is absent from the exact candidate diff.',
      ExitCode.verification,
    );
  }
  if (payload.candidateDigest !== controlPlaneCandidateDigestV2(exactChanges)) {
    throw workflowError(
      'CONTROL_PLANE_CANDIDATE_DIGEST_MISMATCH',
      'Control-Plane Grant v2 candidate digest mismatch.',
      ExitCode.verification,
    );
  }
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest: context.beforeManifest,
    afterManifest: context.afterManifest,
    changes: exactChanges,
  });
  if (impact.class !== 'C') {
    throw workflowError(
      'CONTROL_PLANE_GRANT_NOT_REQUIRED',
      'Candidate does not affect a protected capability.',
      ExitCode.usage,
    );
  }
  if (!sameJson(payload.affectedCapabilities, impact.affectedCapabilities)) {
    throw workflowError(
      'CONTROL_PLANE_CAPABILITY_IMPACT_MISMATCH',
      'Control-Plane Grant v2 affected capabilities are not exact.',
      ExitCode.verification,
    );
  }
  if (!Number.isFinite(context.now.getTime())) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v2 verification time is invalid.',
      ExitCode.usage,
    );
  }
  if (context.now.getTime() < Date.parse(payload.issuedAt)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_NOT_YET_VALID',
      'Control-Plane Grant v2 cannot be used before issuance.',
      ExitCode.staleState,
    );
  }
  if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_EXPIRED',
      'Control-Plane Grant v2 has expired.',
      ExitCode.staleState,
    );
  }
  if (
    !verifyHumanSignatureSafely(
      context.verifyHumanSignature,
      canonicalControlPlaneGrantPayloadV2(payload),
      envelope.signature,
      payload.humanSigner,
      CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      'Human Control-Plane Grant v2 signature could not be verified.',
      ExitCode.verification,
    );
  }
  verifyControlPlaneIndependentReviewAttestationV2(
    bundle.independentReviewAttestation,
    {
      material,
      expectedDigest: payload.independentReviewAttestationDigest,
      grantHumanSigner: payload.humanSigner,
      grantIssuedAt: payload.issuedAt,
      verifyHumanSignature: context.verifyHumanSignature,
    },
  );
  const mandateBinding = normalizeControlPlaneTaskMandateBinding(
    payload.mandateBinding,
  );
  return freezeDeep({
    payload: {
      ...payload,
      mandateBinding,
      exactChanges: exactChanges.map((change) => ({ ...change })),
      affectedCapabilities: [...payload.affectedCapabilities],
      recoveryBundle: { ...payload.recoveryBundle },
    },
    signature: envelope.signature,
    verifiedAt: context.now.toISOString(),
    verification: 'human-signature-verified',
  });
}

export interface ControlPlanePromotionBundleV3 {
  kind: 'control-plane-promotion-bundle.v3';
  material: ControlPlanePromotionMaterial;
  promotionMaterialDigest: Sha256Digest;
  lineage: ControlPlanePromotionLineage;
  promotionLineageDigest: Sha256Digest;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelopeV3;
  bundleDigest: Sha256Digest;
}

export interface ControlPlaneGrantPayloadV3 extends Omit<
  ControlPlaneGrantPayloadV2,
  'kind' | 'promotionBundleDigest' | 'updaterVersion'
> {
  kind: 'control-plane-grant.v3';
  promotionLineageDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  updaterVersion: 3;
}

export interface ControlPlaneGrantEnvelopeV3 {
  payload: ControlPlaneGrantPayloadV3;
  signature: string;
}

export interface VerifiedControlPlaneGrantV3 {
  payload: ControlPlaneGrantPayloadV3;
  signature: string;
  verifiedAt: string;
  verification: 'human-signature-verified';
}

export function createControlPlanePromotionBundleV3(input: {
  material: ControlPlanePromotionMaterial;
  lineage: ControlPlanePromotionLineage;
  independentReviewAttestation: ControlPlaneIndependentReviewAttestationEnvelopeV3;
}): ControlPlanePromotionBundleV3 {
  if (
    !hasExactObjectKeys(input, [
      'independentReviewAttestation',
      'lineage',
      'material',
    ])
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
      'Promotion bundle v3 input has an unknown schema.',
      ExitCode.guard,
    );
  }
  const material = verifyControlPlanePromotionMaterial(input.material);
  const lineage = verifyControlPlanePromotionLineage(input.lineage);
  validateControlPlaneIndependentReviewAttestationV3(
    input.independentReviewAttestation,
  );
  const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
  const review = input.independentReviewAttestation.payload;
  if (
    review.promotionMaterialDigest !== promotionMaterialDigest ||
    review.promotionLineageDigest !== lineage.lineageDigest ||
    review.repositoryId !== material.repositoryId ||
    review.frozenCandidateBundleDigest !==
      material.frozenCandidateBundleDigest ||
    review.candidateDigest !== material.candidateDigest ||
    review.beforeClosureDigest !== material.beforeClosureDigest ||
    review.afterClosureDigest !== material.afterClosureDigest ||
    review.recoveryBundleDigest !== material.recoveryBundle.bundleDigest ||
    !sameJson(review.affectedCapabilities, material.affectedCapabilities)
  ) {
    throw workflowError(
      'CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH',
      'Signed review does not bind the exact v3 promotion material and lineage.',
      ExitCode.verification,
    );
  }
  const payload = {
    kind: 'control-plane-promotion-bundle.v3' as const,
    material,
    promotionMaterialDigest,
    lineage,
    promotionLineageDigest: lineage.lineageDigest,
    independentReviewAttestation: structuredClone(
      input.independentReviewAttestation,
    ),
  };
  return freezeDeep({ ...payload, bundleDigest: canonicalDigest(payload) });
}

export function verifyControlPlanePromotionBundleV3(
  value: unknown,
): ControlPlanePromotionBundleV3 {
  if (
    !hasExactObjectKeys(value, [
      'bundleDigest',
      'independentReviewAttestation',
      'kind',
      'lineage',
      'material',
      'promotionLineageDigest',
      'promotionMaterialDigest',
    ]) ||
    (value as { kind?: unknown }).kind !== 'control-plane-promotion-bundle.v3'
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
      'Promotion bundle v3 has an unknown schema.',
      ExitCode.guard,
    );
  }
  const bundle = value as ControlPlanePromotionBundleV3;
  assertDigest(
    bundle.promotionMaterialDigest,
    'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
  );
  assertDigest(
    bundle.promotionLineageDigest,
    'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID',
  );
  assertDigest(bundle.bundleDigest, 'CONTROL_PLANE_PROMOTION_BUNDLE_INVALID');
  const rebuilt = createControlPlanePromotionBundleV3({
    material: bundle.material,
    lineage: bundle.lineage,
    independentReviewAttestation: bundle.independentReviewAttestation,
  });
  if (!sameJson(rebuilt, bundle)) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH',
      'Promotion bundle v3 digest or canonical bytes mismatch.',
      ExitCode.verification,
    );
  }
  return rebuilt;
}

export function controlPlanePromotionBundleDigestV3(
  bundle: ControlPlanePromotionBundleV3,
): Sha256Digest {
  return verifyControlPlanePromotionBundleV3(bundle).bundleDigest;
}

export function grantPayloadV2Projection(
  payload: ControlPlaneGrantPayloadV3,
  promotionBundleDigest: Sha256Digest,
  reviewDigest: Sha256Digest,
): ControlPlaneGrantPayloadV2 {
  const { promotionLineageDigest: _promotionLineageDigest, ...rest } = payload;
  return {
    ...rest,
    kind: 'control-plane-grant.v2',
    promotionBundleDigest,
    independentReviewAttestationDigest: reviewDigest,
    updaterVersion: 2,
  };
}

export function validateControlPlaneGrantPayloadV3(
  value: unknown,
): asserts value is ControlPlaneGrantPayloadV3 {
  if (
    !hasExactObjectKeys(value, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateDigest',
      'exactChanges',
      'expiresAt',
      'frozenCandidateBundleDigest',
      'grantId',
      'humanSigner',
      'independentReviewAttestationDigest',
      'issuedAt',
      'kind',
      'mandateBinding',
      'oneShot',
      'promotionBundleDigest',
      'promotionLineageDigest',
      'promotionMaterialDigest',
      'recoveryBundle',
      'repositoryId',
      'updaterVersion',
    ]) ||
    (value as { kind?: unknown }).kind !== 'control-plane-grant.v3' ||
    (value as { updaterVersion?: unknown }).updaterVersion !== 3
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v3 has an unknown schema or updater version.',
      ExitCode.guard,
    );
  }
  const payload = value as ControlPlaneGrantPayloadV3;
  assertDigest(payload.promotionLineageDigest, 'CONTROL_PLANE_GRANT_INVALID');
  validateControlPlaneGrantPayloadV2(
    grantPayloadV2Projection(
      payload,
      payload.promotionBundleDigest,
      payload.independentReviewAttestationDigest,
    ),
  );
}

export function validateControlPlaneGrantEnvelopeV3(
  value: unknown,
): asserts value is ControlPlaneGrantEnvelopeV3 {
  if (!hasExactObjectKeys(value, ['payload', 'signature'])) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_INVALID',
      'Control-Plane Grant v3 envelope has an unknown schema.',
      ExitCode.guard,
    );
  }
  const envelope = value as ControlPlaneGrantEnvelopeV3;
  validateControlPlaneGrantPayloadV3(envelope.payload);
  assertNonEmpty(
    envelope.signature,
    'CONTROL_PLANE_GRANT_INVALID',
    'Signature',
  );
}

export function canonicalControlPlaneGrantPayloadV3(
  payload: ControlPlaneGrantPayloadV3,
): string {
  validateControlPlaneGrantPayloadV3(payload);
  return `${canonicalJson(payload)}\n`;
}

export function verifyControlPlaneGrantV3(
  envelope: ControlPlaneGrantEnvelopeV3,
  context: {
    now: Date;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV3;
    consumedGrantIds: ReadonlySet<string>;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): VerifiedControlPlaneGrantV3 {
  validateControlPlaneGrantEnvelopeV3(envelope);
  const payload = envelope.payload;
  const bundle = verifyControlPlanePromotionBundleV3(context.bundle);
  if (context.consumedGrantIds.has(payload.grantId)) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_ALREADY_CONSUMED',
      'One-shot Control-Plane Grant v3 has already been consumed.',
      ExitCode.conflict,
    );
  }
  const reviewDigest = controlPlaneIndependentReviewAttestationDigestV3(
    bundle.independentReviewAttestation,
  );
  if (
    payload.promotionBundleDigest !== bundle.bundleDigest ||
    payload.promotionMaterialDigest !== bundle.promotionMaterialDigest ||
    payload.promotionLineageDigest !== bundle.promotionLineageDigest ||
    payload.independentReviewAttestationDigest !== reviewDigest
  ) {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH',
      'Control-Plane Grant v3 binds a different material, lineage, review, or bundle.',
      ExitCode.verification,
    );
  }

  // Reuse the complete v2 material/classification/time validation with a
  // structural projection. Authority is checked separately below against the
  // actual v3 payloads and namespaces, so no v2 signature can authorize v3.
  const projectedReview: ControlPlaneIndependentReviewAttestationEnvelopeV2 = {
    payload: reviewPayloadV2Projection(
      bundle.independentReviewAttestation.payload,
    ),
    signature: bundle.independentReviewAttestation.signature,
  };
  const projectedBundle = createControlPlanePromotionBundleV2({
    material: bundle.material,
    independentReviewAttestation: projectedReview,
  });
  const projectedGrant: ControlPlaneGrantEnvelopeV2 = {
    payload: grantPayloadV2Projection(
      payload,
      projectedBundle.bundleDigest,
      controlPlaneIndependentReviewAttestationDigestV2(projectedReview),
    ),
    signature: envelope.signature,
  };
  verifyControlPlaneGrantV2(projectedGrant, {
    now: context.now,
    beforeManifest: context.beforeManifest,
    afterManifest: context.afterManifest,
    bundle: projectedBundle,
    consumedGrantIds: context.consumedGrantIds,
    verifyHumanSignature: () => true,
  });

  if (
    !verifyHumanSignatureSafely(
      context.verifyHumanSignature,
      canonicalControlPlaneGrantPayloadV3(payload),
      envelope.signature,
      payload.humanSigner,
      CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
    )
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      'Human Control-Plane Grant v3 signature could not be verified.',
      ExitCode.verification,
    );
  }
  verifyControlPlaneIndependentReviewAttestationV3(
    bundle.independentReviewAttestation,
    {
      material: bundle.material,
      lineage: bundle.lineage,
      expectedDigest: reviewDigest,
      grantHumanSigner: payload.humanSigner,
      grantIssuedAt: payload.issuedAt,
      verifyHumanSignature: context.verifyHumanSignature,
    },
  );
  return freezeDeep({
    payload: {
      ...payload,
      mandateBinding: { ...payload.mandateBinding },
      exactChanges: payload.exactChanges.map((change) => ({ ...change })),
      affectedCapabilities: [...payload.affectedCapabilities],
      recoveryBundle: { ...payload.recoveryBundle },
    },
    signature: envelope.signature,
    verifiedAt: context.now.toISOString(),
    verification: 'human-signature-verified',
  });
}
