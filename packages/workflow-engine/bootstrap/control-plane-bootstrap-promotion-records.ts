/** Pure promotion material, lineage, review, and Grant record validation. */
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  isRecord,
  hasExactKeys,
  isDigest,
  isNonEmptyTrimmed,
  canonicalDigest,
  isCanonicalIso,
  CONTROL_PLANE_GRANT_MAX_TTL_MS,
  supervisorNotTerminal,
  positiveSafeInteger,
  isGitObjectId,
  MAX_PROMOTION_FILE_BYTES,
  rawDigest,
  sortedUniqueStrings,
  safeClosurePath,
  MAX_PROMOTION_TOTAL_BYTES,
} from './control-plane-bootstrap-values.ts';
import type { Sha256Digest } from './control-plane-bootstrap-types.ts';
import { validAffectedCapabilitiesV2 } from './control-plane-bootstrap-protected-records.ts';

export function validTerminalObservationsV2(
  history: unknown,
  observations: unknown,
  createdAt: unknown,
  updatedAt: unknown,
): boolean {
  if (
    !Array.isArray(history) ||
    !Array.isArray(observations) ||
    history.length !== observations.length + 1 ||
    history.length < 2 ||
    !isRecord(history[0]) ||
    history[0].at !== createdAt ||
    !isRecord(history.at(-1)) ||
    history.at(-1)?.at !== updatedAt
  ) {
    return false;
  }
  const eventForTransition: Record<string, string> = {
    'PREPARED\0OLD_CLOSURE_VERIFIED': 'old-closure-verified',
    'OLD_CLOSURE_VERIFIED\0CANDIDATE_VERIFIED': 'candidate-verified',
    'CANDIDATE_VERIFIED\0RECOVERY_VERIFIED': 'recovery-bundle-verified',
    'RECOVERY_VERIFIED\0SWITCHED': 'atomic-switch-completed',
    'SWITCHED\0SELF_TESTED': 'self-tests-passed',
    'SWITCHED\0ROLLBACK_REQUIRED': 'self-tests-failed',
    'SELF_TESTED\0FINALIZED': 'finalize',
    'ROLLBACK_REQUIRED\0ROLLED_BACK': 'rollback-completed',
  };
  return observations.every((observation, index) => {
    const before = history[index];
    const after = history[index + 1];
    if (
      !isRecord(observation) ||
      !isRecord(before) ||
      !isRecord(after) ||
      !hasExactKeys(observation, [
        'evidenceDigest',
        'eventKind',
        'fromState',
        'recordedAt',
        'sequence',
        'toState',
      ])
    ) {
      return false;
    }
    return (
      observation.sequence === index + 1 &&
      observation.fromState === before.state &&
      observation.toState === after.state &&
      observation.eventKind ===
        eventForTransition[`${String(before.state)}\0${String(after.state)}`] &&
      observation.recordedAt === after.at &&
      isDigest(observation.evidenceDigest)
    );
  });
}

function validControlPlaneGrantPayloadV3(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  expiresAt: string;
  grantId: string;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown> & {
    bundleDigest: Sha256Digest;
  };
  repositoryId: string;
  updaterVersion: 3;
} {
  if (
    !hasExactKeys(payload, [
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
    payload.kind !== 'control-plane-grant.v3' ||
    payload.oneShot !== true ||
    payload.updaterVersion !== 3 ||
    !isNonEmptyTrimmed(payload.grantId) ||
    !isNonEmptyTrimmed(payload.repositoryId) ||
    !isNonEmptyTrimmed(payload.behaviorChangeSummary) ||
    !isNonEmptyTrimmed(payload.humanSigner) ||
    !validTaskMandateBindingV2(payload.mandateBinding) ||
    !validExactChangesV2(payload.exactChanges) ||
    !validAffectedCapabilitiesV2(payload.affectedCapabilities) ||
    !isDigest(payload.frozenCandidateBundleDigest) ||
    !isDigest(payload.candidateDigest) ||
    !isDigest(payload.promotionMaterialDigest) ||
    !isDigest(payload.promotionBundleDigest) ||
    !isDigest(payload.promotionLineageDigest) ||
    !isDigest(payload.beforeClosureDigest) ||
    !isDigest(payload.afterClosureDigest) ||
    !isDigest(payload.independentReviewAttestationDigest) ||
    payload.candidateDigest !==
      canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: payload.exactChanges,
      }) ||
    !isCanonicalIso(payload.issuedAt) ||
    !isCanonicalIso(payload.expiresAt)
  ) {
    return false;
  }
  const lifetime = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
  if (lifetime <= 0 || lifetime > CONTROL_PLANE_GRANT_MAX_TTL_MS) {
    return false;
  }
  if (
    !isRecord(payload.recoveryBundle) ||
    !hasExactKeys(payload.recoveryBundle, [
      'bundleDigest',
      'previousClosureDigest',
      'restartArtifactDigest',
      'rollbackTestReportDigest',
    ]) ||
    !isDigest(payload.recoveryBundle.bundleDigest) ||
    !isDigest(payload.recoveryBundle.previousClosureDigest) ||
    !isDigest(payload.recoveryBundle.restartArtifactDigest) ||
    !isDigest(payload.recoveryBundle.rollbackTestReportDigest) ||
    payload.recoveryBundle.previousClosureDigest !== payload.beforeClosureDigest
  ) {
    return false;
  }
  return true;
}

export function assertedGrantPayloadV3(value: Record<string, unknown>): Record<
  string,
  unknown
> & {
  affectedCapabilities: string[];
  afterClosureDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  exactChanges: Array<Record<string, unknown>>;
  grantId: string;
  humanSigner: string;
  independentReviewAttestationDigest: Sha256Digest;
  issuedAt: string;
  mandateBinding: Record<string, unknown>;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  recoveryBundle: Record<string, unknown> & {
    bundleDigest: Sha256Digest;
  };
  repositoryId: string;
} {
  if (!validControlPlaneGrantPayloadV3(value)) throw supervisorNotTerminal();
  return value;
}

function validPromotionLineageV3(value: unknown): value is Record<
  string,
  unknown
> & {
  historyAnchorDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  previousSupervisorRecordDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousActiveTrustCommit: string;
  candidateTrustCommit: string;
  lineageDigest: Sha256Digest;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateGeneration',
      'candidateTrustCommit',
      'historyAnchorDigest',
      'kind',
      'lineageDigest',
      'previousActiveTrustCommit',
      'previousGeneration',
      'previousSupervisorRecordDigest',
      'previousTerminalRecordDigest',
      'rollbackGeneration',
    ]) ||
    value.kind !== 'control-plane-promotion-lineage.v1' ||
    !isDigest(value.historyAnchorDigest) ||
    !isDigest(value.previousTerminalRecordDigest) ||
    !isDigest(value.previousSupervisorRecordDigest) ||
    !isDigest(value.lineageDigest) ||
    !positiveSafeInteger(value.previousGeneration) ||
    value.candidateGeneration !== Number(value.previousGeneration) + 1 ||
    value.rollbackGeneration !== Number(value.previousGeneration) + 2 ||
    !isGitObjectId(value.previousActiveTrustCommit) ||
    !isGitObjectId(value.candidateTrustCommit)
  ) {
    return false;
  }
  const { lineageDigest, ...payload } = value;
  return canonicalDigest(payload) === lineageDigest;
}

export function validPromotionBundleV3(
  bundle: Record<string, unknown>,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
): bundle is Record<string, unknown> & {
  independentReviewAttestation: Record<string, unknown>;
  lineage: ReturnType<typeof assertedPromotionLineageV3>;
  material: Record<string, unknown> & {
    affectedCapabilities: string[];
    candidateArtifact: Record<string, unknown>;
    candidateExecutableBase64: string;
    recoveryBundle: Record<string, unknown> & {
      restartArtifact: Record<string, unknown>;
      restartExecutableBase64: string;
    };
  };
  bundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
} {
  if (
    !hasExactKeys(bundle, [
      'bundleDigest',
      'independentReviewAttestation',
      'kind',
      'lineage',
      'material',
      'promotionLineageDigest',
      'promotionMaterialDigest',
    ]) ||
    bundle.kind !== 'control-plane-promotion-bundle.v3' ||
    !isRecord(bundle.material) ||
    !isRecord(bundle.independentReviewAttestation) ||
    !validPromotionLineageV3(bundle.lineage) ||
    !isDigest(bundle.promotionMaterialDigest) ||
    !isDigest(bundle.promotionLineageDigest) ||
    !isDigest(bundle.bundleDigest)
  ) {
    return false;
  }
  const { bundleDigest, ...bundlePayload } = bundle;
  if (
    canonicalDigest(bundlePayload) !== bundleDigest ||
    canonicalDigest(bundle.material) !== bundle.promotionMaterialDigest ||
    bundle.promotionLineageDigest !== bundle.lineage.lineageDigest ||
    bundle.bundleDigest !== grant.promotionBundleDigest ||
    bundle.promotionMaterialDigest !== grant.promotionMaterialDigest ||
    bundle.promotionLineageDigest !== grant.promotionLineageDigest ||
    !validPromotionMaterialV2(
      bundle.material,
      grant,
      beforeManifest,
      afterManifest,
    ) ||
    !validIndependentReviewV3(
      bundle.independentReviewAttestation,
      bundle.material,
      bundle.lineage,
      bundle.promotionMaterialDigest,
      grant,
    )
  ) {
    return false;
  }
  return true;
}

export function assertedPromotionLineageV3(value: unknown): Record<
  string,
  unknown
> & {
  historyAnchorDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  previousSupervisorRecordDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousActiveTrustCommit: string;
  candidateTrustCommit: string;
  lineageDigest: Sha256Digest;
} {
  if (!validPromotionLineageV3(value)) throw supervisorNotTerminal();
  return value;
}

function validIndependentReviewV3(
  envelope: Record<string, unknown>,
  material: Record<string, unknown>,
  lineage: ReturnType<typeof assertedPromotionLineageV3>,
  materialDigest: Sha256Digest,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
): boolean {
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    return false;
  }
  const review = envelope.payload;
  return (
    hasExactKeys(review, [
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
    ]) &&
    review.kind === 'control-plane-independent-review.v3' &&
    review.verdict === 'approved' &&
    isNonEmptyTrimmed(review.repositoryId) &&
    isNonEmptyTrimmed(review.reviewSummary) &&
    isNonEmptyTrimmed(review.reviewer) &&
    isCanonicalIso(review.reviewedAt) &&
    validAffectedCapabilitiesV2(review.affectedCapabilities) &&
    isDigest(review.promotionLineageDigest) &&
    review.repositoryId === material.repositoryId &&
    review.frozenCandidateBundleDigest ===
      material.frozenCandidateBundleDigest &&
    review.candidateDigest === material.candidateDigest &&
    review.promotionMaterialDigest === materialDigest &&
    review.promotionLineageDigest === lineage.lineageDigest &&
    review.beforeClosureDigest === material.beforeClosureDigest &&
    review.afterClosureDigest === material.afterClosureDigest &&
    isRecord(material.recoveryBundle) &&
    review.recoveryBundleDigest === material.recoveryBundle.bundleDigest &&
    canonicalJson(review.affectedCapabilities) ===
      canonicalJson(material.affectedCapabilities) &&
    canonicalDigest(envelope) === grant.independentReviewAttestationDigest &&
    Date.parse(String(review.reviewedAt)) <= Date.parse(grant.issuedAt) &&
    review.reviewer !== grant.humanSigner
  );
}

function validPromotionMaterialV2(
  material: Record<string, unknown>,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
  beforeManifest: Record<string, unknown>,
  afterManifest: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(material, [
      'affectedCapabilities',
      'afterClosureDigest',
      'beforeClosureDigest',
      'behaviorChangeSummary',
      'candidateArtifact',
      'candidateDigest',
      'candidateExecutableBase64',
      'candidateExecutableProvenanceDigest',
      'candidateFiles',
      'exactChanges',
      'frozenCandidateBundleDigest',
      'kind',
      'mandateBinding',
      'recoveryBundle',
      'repositoryId',
    ]) ||
    material.kind !== 'control-plane-promotion-material.v1' ||
    !isNonEmptyTrimmed(material.repositoryId) ||
    !isNonEmptyTrimmed(material.behaviorChangeSummary) ||
    !validTaskMandateBindingV2(material.mandateBinding) ||
    !validExactChangesV2(material.exactChanges) ||
    !validAffectedCapabilitiesV2(material.affectedCapabilities) ||
    !isDigest(material.frozenCandidateBundleDigest) ||
    !isDigest(material.candidateDigest) ||
    !isDigest(material.beforeClosureDigest) ||
    !isDigest(material.afterClosureDigest) ||
    !isDigest(material.candidateExecutableProvenanceDigest) ||
    material.repositoryId !== grant.repositoryId ||
    material.frozenCandidateBundleDigest !==
      grant.frozenCandidateBundleDigest ||
    material.candidateDigest !== grant.candidateDigest ||
    material.beforeClosureDigest !== grant.beforeClosureDigest ||
    material.afterClosureDigest !== grant.afterClosureDigest ||
    material.behaviorChangeSummary !== grant.behaviorChangeSummary ||
    canonicalJson(material.mandateBinding) !==
      canonicalJson(grant.mandateBinding) ||
    canonicalJson(material.exactChanges) !==
      canonicalJson(grant.exactChanges) ||
    canonicalJson(material.affectedCapabilities) !==
      canonicalJson(grant.affectedCapabilities) ||
    material.beforeClosureDigest !== beforeManifest.manifestDigest ||
    material.afterClosureDigest !== afterManifest.manifestDigest ||
    material.candidateDigest !==
      canonicalDigest({
        kind: 'control-plane-candidate.v2',
        changes: material.exactChanges,
      }) ||
    !validEngineArtifactV2(material.candidateArtifact) ||
    material.candidateArtifact.sourceChangeId !==
      material.mandateBinding.changeId
  ) {
    return false;
  }
  const candidateExecutable = canonicalBase64Bytes(
    material.candidateExecutableBase64,
    MAX_PROMOTION_FILE_BYTES,
    false,
  );
  if (
    candidateExecutable === null ||
    rawDigest(candidateExecutable) !==
      material.candidateArtifact.executableDigest ||
    !validPromotionFilesV2(
      material.candidateFiles,
      material.exactChanges,
      'after',
    ) ||
    !validRecoveryMaterialV2(
      material.recoveryBundle,
      material.exactChanges,
      material.repositoryId,
      material.beforeClosureDigest,
      grant,
    )
  ) {
    return false;
  }
  return true;
}

function validRecoveryMaterialV2(
  recovery: unknown,
  changes: Array<Record<string, unknown>>,
  repositoryId: string,
  beforeClosureDigest: Sha256Digest,
  grant: ReturnType<typeof assertedGrantPayloadV3>,
): recovery is Record<string, unknown> & {
  restartArtifact: Record<string, unknown>;
  restartExecutableBase64: string;
} {
  if (
    !isRecord(recovery) ||
    !hasExactKeys(recovery, [
      'bundleDigest',
      'kind',
      'previousClosureDigest',
      'previousFiles',
      'repositoryId',
      'restartArtifact',
      'restartExecutableBase64',
      'restartExecutableProvenanceDigest',
      'rollbackTestReportBase64',
      'rollbackTestReportDigest',
    ]) ||
    recovery.kind !== 'control-plane-recovery-bundle.v2' ||
    recovery.repositoryId !== repositoryId ||
    recovery.previousClosureDigest !== beforeClosureDigest ||
    !isDigest(recovery.restartExecutableProvenanceDigest) ||
    !isDigest(recovery.rollbackTestReportDigest) ||
    !isDigest(recovery.bundleDigest) ||
    !validEngineArtifactV2(recovery.restartArtifact) ||
    !validPromotionFilesV2(recovery.previousFiles, changes, 'before')
  ) {
    return false;
  }
  const restartExecutable = canonicalBase64Bytes(
    recovery.restartExecutableBase64,
    MAX_PROMOTION_FILE_BYTES,
    false,
  );
  const rollbackReport = canonicalBase64Bytes(
    recovery.rollbackTestReportBase64,
    MAX_PROMOTION_FILE_BYTES,
    true,
  );
  const { bundleDigest, ...recoveryPayload } = recovery;
  return (
    restartExecutable !== null &&
    rollbackReport !== null &&
    rawDigest(restartExecutable) ===
      recovery.restartArtifact.executableDigest &&
    rawDigest(rollbackReport) === recovery.rollbackTestReportDigest &&
    canonicalDigest(recoveryPayload) === bundleDigest &&
    grant.recoveryBundle.bundleDigest === bundleDigest &&
    grant.recoveryBundle.previousClosureDigest === beforeClosureDigest &&
    grant.recoveryBundle.restartArtifactDigest ===
      recovery.restartArtifact.executableDigest &&
    grant.recoveryBundle.rollbackTestReportDigest ===
      recovery.rollbackTestReportDigest
  );
}

function validTaskMandateBindingV2(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'parentTaskId',
      'schemaVersion',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.parentTaskId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.parentTaskId) &&
    typeof value.mandateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.mandateId,
    ) &&
    typeof value.mandateDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.mandateDigest) &&
    typeof value.changeId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) &&
    typeof value.externalAuditRoot === 'string' &&
    path.isAbsolute(value.externalAuditRoot) &&
    path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
    value.externalAuditRoot !== path.parse(value.externalAuditRoot).root
  );
}

export function validEngineArtifactV2(value: unknown): value is Record<
  string,
  unknown
> & {
  artifactId: Sha256Digest;
  executableDigest: Sha256Digest;
  sourceChangeId: string;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'canReadSessionSchemas',
      'executableDigest',
      'kind',
      'policySchemaVersion',
      'protocolVersion',
      'smokeReportDigest',
      'sourceChangeId',
      'sourceDigest',
      'writesSessionSchema',
    ]) ||
    value.kind !== 'engine-artifact.v1' ||
    !isNonEmptyTrimmed(value.sourceChangeId) ||
    !isDigest(value.sourceDigest) ||
    !isDigest(value.executableDigest) ||
    !isDigest(value.smokeReportDigest) ||
    !isDigest(value.artifactId) ||
    !Number.isSafeInteger(value.protocolVersion) ||
    Number(value.protocolVersion) < 1 ||
    !Number.isSafeInteger(value.policySchemaVersion) ||
    Number(value.policySchemaVersion) < 1 ||
    !isNonEmptyTrimmed(value.writesSessionSchema) ||
    !sortedUniqueStrings(value.canReadSessionSchemas, false) ||
    !value.canReadSessionSchemas.includes(value.writesSessionSchema)
  ) {
    return false;
  }
  const { artifactId, ...payload } = value;
  return canonicalDigest(payload) === artifactId;
}

export function validExactChangesV2(
  value: unknown,
): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return false;
  const paths: string[] = [];
  for (const change of value) {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, [
        'afterDigest',
        'afterMode',
        'beforeDigest',
        'beforeMode',
        'path',
      ]) ||
      !safeClosurePath(change.path)
    ) {
      return false;
    }
    const beforePresent = change.beforeDigest !== null;
    const afterPresent = change.afterDigest !== null;
    if (
      (beforePresent && !isDigest(change.beforeDigest)) ||
      (afterPresent && !isDigest(change.afterDigest)) ||
      beforePresent !== (change.beforeMode !== null) ||
      afterPresent !== (change.afterMode !== null) ||
      (change.beforeMode !== null &&
        change.beforeMode !== '100644' &&
        change.beforeMode !== '100755') ||
      (change.afterMode !== null &&
        change.afterMode !== '100644' &&
        change.afterMode !== '100755') ||
      (!beforePresent && !afterPresent) ||
      (change.beforeDigest === change.afterDigest &&
        change.beforeMode === change.afterMode)
    ) {
      return false;
    }
    paths.push(change.path);
  }
  return sortedUniqueStrings(paths, false);
}

function validPromotionFilesV2(
  value: unknown,
  changes: Array<Record<string, unknown>>,
  side: 'before' | 'after',
): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let totalBytes = 0;
  const observed: Array<Record<string, unknown>> = [];
  for (const file of value) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ['contentBase64', 'contentDigest', 'mode', 'path']) ||
      !safeClosurePath(file.path) ||
      (file.mode !== '100644' && file.mode !== '100755') ||
      !isDigest(file.contentDigest)
    ) {
      return false;
    }
    const bytes = canonicalBase64Bytes(
      file.contentBase64,
      MAX_PROMOTION_FILE_BYTES,
      true,
    );
    if (bytes === null || rawDigest(bytes) !== file.contentDigest) return false;
    totalBytes += bytes.length;
    if (totalBytes > MAX_PROMOTION_TOTAL_BYTES) return false;
    observed.push({
      path: file.path,
      mode: file.mode,
      contentDigest: file.contentDigest,
    });
  }
  const expected = changes
    .filter((change) =>
      side === 'before'
        ? change.beforeDigest !== null
        : change.afterDigest !== null,
    )
    .map((change) => ({
      path: change.path,
      mode: side === 'before' ? change.beforeMode : change.afterMode,
      contentDigest:
        side === 'before' ? change.beforeDigest : change.afterDigest,
    }));
  return canonicalJson(observed) === canonicalJson(expected);
}

export function canonicalBase64Bytes(
  value: unknown,
  limit: number,
  allowEmpty: boolean,
): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((limit * 4) / 3) + 4
  ) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= limit &&
    (allowEmpty || bytes.length > 0) &&
    bytes.toString('base64') === value
    ? bytes
    : null;
}

export function validBoundedSignature(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= 64 * 1024
  );
}
