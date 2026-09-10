/**
 * Produces a control-plane approval candidate from frozen repository,
 * sidecar and supervisor evidence.
 *
 * Invariants:
 * - The frozen candidate must recompute as a Class-C protected-capability
 *   change.
 */
import { createControlPlaneCandidateMaterial } from './control-plane-candidate-material.ts';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootstrapInterventionStateRoot,
  readInitialControlPlaneSupervisorAnchorEvidence,
  readBuiltInControlPlaneEngineArtifact,
} from '../../../bootstrap/control-plane-trust.ts';
import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
  runGitBuffer,
} from '../../runtime/repository-transaction/git.ts';
import {
  canonicalControlPlaneIndependentReviewAttestationPayloadV3,
  classifyProtectedCandidateImpactV2,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  controlPlaneCandidateDigestV2,
  controlPlanePromotionMaterialDigest,
  createControlPlanePromotionBundleV3,
  createControlPlanePromotionLineage,
  createControlPlanePromotionMaterial,
  createControlPlaneRecoveryBundleMaterial,
  normalizeControlPlaneTaskMandateBinding,
  type ControlPlaneIndependentReviewAttestationEnvelopeV3,
  type ControlPlaneIndependentReviewAttestationPayloadV3,
  type ControlPlanePromotionFileMaterial,
  type ExactControlPlaneChangeV2,
  type ProtectedCandidateImpact,
  type Sha256Digest,
} from '../../modules/authority/intervention-control.ts';
import {
  appendControlPlaneSupervisorHistoryRecord,
  controlPlaneSupervisorHistoryDirectory,
  createControlPlaneSupervisorHistoryAnchor,
  readControlPlaneSupervisorHistory,
  type VerifiedControlPlaneSupervisorHistory,
} from '../../runtime/storage-journal/control-plane-supervisor-history.ts';
import {
  findPersistedBootstrapSidecarSessionForIntervention,
  readPersistedControlPlaneUpdate,
  type PersistenceHumanSignatureVerifier,
} from '../../runtime/storage-journal/intervention-control-persistence.ts';
import {
  findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer,
  persistControlPlaneApprovalCandidateV3,
  readPersistedControlPlaneApprovalCandidateCurrent,
  readControlPlaneSupervisorState,
  type PersistedControlPlaneApprovalCandidateV3,
} from './intervention-control-updater.ts';
import { readInterventionEngineArtifact } from './intervention-maintenance.ts';
import {
  assertStoredCandidateSupportingArtifacts,
  readStoredImmutableCandidateBundle,
  type ImmutableCandidateBundleV2,
} from '../../modules/authority/maintainer-candidate.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { loadProtectedCapabilitiesFromTrustBase } from '../../adapters/consumer/repository/work-registry/protected-capabilities.ts';

const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;

interface ExactGitFileState {
  path: string;
  mode: '100644' | '100755';
  objectId: string;
  content: Buffer;
  contentDigest: Sha256Digest;
}

interface DerivedFrozenCandidate {
  exactChanges: ExactControlPlaneChangeV2[];
  beforeFiles: ControlPlanePromotionFileMaterial[];
  afterFiles: ControlPlanePromotionFileMaterial[];
}

interface ControlPlanePromotionReviewSummaryBase {
  repositoryId: string;
  frozenCandidateBundleDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  affectedCapabilities: ProtectedCandidateImpact['affectedCapabilities'];
  candidateArtifactId: Sha256Digest;
  candidateExecutableProvenanceDigest: Sha256Digest;
  recoveryArtifactId: Sha256Digest;
  recoveryExecutableProvenanceDigest: Sha256Digest;
  rollbackTestReportDigest: Sha256Digest;
  behaviorChangeSummary: string;
  humanReadable: string;
}

export interface ControlPlanePromotionReviewSummaryV3 extends Omit<
  ControlPlanePromotionReviewSummaryBase,
  'humanReadable'
> {
  kind: 'control-plane-promotion-review-summary.v3';
  promotionLineageDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousSupervisorRecordDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlanePromotionProducerDependenciesV3 {
  now?: () => Date;
  reviewSigner: MaintainerSignerProvider;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  presentReviewSummary: (summary: ControlPlanePromotionReviewSummaryV3) => void;
}

export interface ControlPlanePromotionProducerResultV3 {
  kind: 'control-plane-promotion-producer-result.v3';
  action: 'produce-control-plane-approval-candidate';
  replayed: boolean;
  candidate: PersistedControlPlaneApprovalCandidateV3;
  summary: ControlPlanePromotionReviewSummaryV3;
}

/**
 * Produce a lineage-bound promotion candidate. V3 authority is derived from
 * the unique durable supervisor-history leaf; callers still name only the
 * stored frozen candidate and cannot supply predecessor or generation data.
 */
export function produceControlPlaneApprovalCandidateV3(
  requestedRepositoryRoot: string,
  stateRoot: string,
  requestedCandidateBundleDigest: string,
  dependencies: ControlPlanePromotionProducerDependenciesV3,
): ControlPlanePromotionProducerResultV3 {
  requireProducerDependencies(dependencies);
  const repository = discoverRepository(requestedRepositoryRoot);
  if (
    !path.isAbsolute(requestedRepositoryRoot) ||
    path.resolve(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    fs.realpathSync(requestedRepositoryRoot) !== requestedRepositoryRoot ||
    requestedRepositoryRoot !== repository.repositoryRealPath ||
    repository.statusEntries.length !== 0
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_REPOSITORY_NOT_CLEAN',
      'Control-plane promotion material must be produced from the exact clean repository root.',
      ExitCode.conflict,
    );
  }
  assertProducerStateRoot(repository.gitCommonDirectory, stateRoot);
  const candidate = readStoredImmutableCandidateBundle(
    repository.gitCommonDirectory,
    requestedCandidateBundleDigest,
  );
  assertFrozenCandidatePrestate(repository, candidate);
  assertStoredCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    candidate.mandateBinding.changeId,
    candidate,
  );
  const derived = deriveFrozenCandidate(repository.repositoryRoot, candidate);
  const beforeManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  const afterManifest = loadProtectedCapabilitiesFromTrustBase(
    repository.repositoryRoot,
    candidate.candidateCommit,
  );
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest,
    afterManifest,
    changes: derived.exactChanges,
  });
  if (impact.class !== 'C') {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CLASSIFICATION_MISMATCH',
      'The frozen candidate does not recompute as a Class-C protected-capability change.',
      ExitCode.verification,
    );
  }

  const supervisor = readControlPlaneSupervisorState(stateRoot);
  if (supervisor.repositoryId !== candidate.repositoryId) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_SUPERVISOR_MISMATCH',
      'The supervisor repository identity differs from the frozen candidate.',
      ExitCode.staleState,
    );
  }
  const authority = ensureTerminalSupervisorHistory(
    stateRoot,
    supervisor,
    candidate.expectedOldCommit,
  );
  const { history, restartArtifact } = authority;
  if (
    history.leaf.recordDigest !== history.records.at(-1)?.recordDigest ||
    history.generation !== supervisor.generation ||
    history.supervisorRecordDigest !== supervisor.recordDigest ||
    history.activeTrustCommit !== candidate.expectedOldCommit ||
    history.activeArtifact.artifactId !==
      supervisor.activeArtifact.artifactId ||
    history.activeArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest ||
    history.activeArtifact.closureDigest !==
      supervisor.activeArtifact.closureDigest ||
    supervisor.activeArtifact.closureDigest !== beforeManifest.manifestDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
      'The frozen candidate does not extend the exact terminal supervisor history leaf.',
      ExitCode.staleState,
    );
  }
  if (
    restartArtifact.artifactId !== supervisor.activeArtifact.artifactId ||
    restartArtifact.executableDigest !==
      supervisor.activeArtifact.executableDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_SUCCESSOR_ARTIFACT_UNAVAILABLE',
      'The terminal supervisor history does not resolve the exact active recovery artifact.',
      ExitCode.staleState,
    );
  }

  const sidecar = findPersistedBootstrapSidecarSessionForIntervention(
    stateRoot,
    candidate.mandateBinding.changeId,
  );
  if (sidecar.artifacts.length !== 1) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SELECTION_AMBIGUOUS',
      'A frozen global promotion requires exactly one durable sidecar EngineArtifact; caller-selected artifacts are forbidden.',
      ExitCode.conflict,
    );
  }
  const sidecarArtifact = sidecar.artifacts[0]!;
  const candidateArtifactRecord = readInterventionEngineArtifact(
    stateRoot,
    sidecarArtifact.artifactId,
  );
  if (
    sidecarArtifact.evidenceDigest !== candidateArtifactRecord.recordDigest ||
    sidecarArtifact.sourceDigest !==
      candidateArtifactRecord.artifact.sourceDigest ||
    sidecarArtifact.executableDigest !==
      candidateArtifactRecord.artifact.executableDigest ||
    candidateArtifactRecord.interventionChangeId !==
      candidate.mandateBinding.changeId
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_BINDING_MISMATCH',
      'The durable sidecar does not bind the exact candidate EngineArtifact record.',
      ExitCode.verification,
    );
  }
  const expectedArtifactSourceDigest = frozenCandidateSourceDigest(
    candidate.expectedOldCommit,
    derived.exactChanges,
  );
  if (
    candidateArtifactRecord.artifact.sourceDigest !==
    expectedArtifactSourceDigest
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
      'The candidate EngineArtifact source snapshot does not match the exact frozen Class-C diff.',
      ExitCode.verification,
    );
  }

  const candidateExecutable = readStableExecutable(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
  );
  const restartExecutable = readStableExecutable(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
  );
  const candidateSelfTest = runControlPlaneProbe(
    candidateArtifactRecord.executablePath,
    candidateArtifactRecord.artifact.executableDigest,
    '--control-plane-self-test',
    {
      kind: 'control-plane-self-test.v1',
      property: 'healthy',
      closureDigest: afterManifest.manifestDigest,
    },
  );
  const restartProbe = runControlPlaneProbe(
    supervisor.activeArtifact.executablePath,
    restartArtifact.executableDigest,
    '--control-plane-restart-probe',
    {
      kind: 'control-plane-restart.v1',
      property: 'ready',
      closureDigest: beforeManifest.manifestDigest,
    },
  );
  assertExecutableUnchanged(
    candidateArtifactRecord.executablePath,
    candidateExecutable,
    candidateArtifactRecord.artifact.executableDigest,
  );
  assertExecutableUnchanged(
    supervisor.activeArtifact.executablePath,
    restartExecutable,
    restartArtifact.executableDigest,
  );
  const rollbackReport = Buffer.from(
    `${canonicalJson({
      kind: 'control-plane-rollback-test-report.v3',
      candidate: {
        artifactId: candidateArtifactRecord.artifact.artifactId,
        executableDigest: candidateArtifactRecord.artifact.executableDigest,
        expectedClosureDigest: afterManifest.manifestDigest,
        response: candidateSelfTest,
      },
      recovery: {
        artifactId: restartArtifact.artifactId,
        executableDigest: restartArtifact.executableDigest,
        expectedClosureDigest: beforeManifest.manifestDigest,
        response: restartProbe,
      },
    })}\n`,
  );
  const rollbackTestReportDigest = rawDigest(rollbackReport);
  const recoveryBundle = createControlPlaneRecoveryBundleMaterial({
    repositoryId: candidate.repositoryId,
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact,
    restartExecutableBase64: restartExecutable.toString('base64'),
    restartExecutableProvenanceDigest: supervisor.recordDigest,
    previousFiles: derived.beforeFiles,
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest,
  });
  const mandateBinding = normalizeControlPlaneTaskMandateBinding({
    schemaVersion: candidate.mandateBinding.schemaVersion,
    parentTaskId: candidate.mandateBinding.mandateTaskId,
    mandateId: candidate.mandateBinding.mandateId,
    mandateDigest: candidate.mandateBinding.mandateDigest,
    changeId: candidate.mandateBinding.changeId,
    externalAuditRoot: candidate.mandateBinding.externalAuditRoot,
  });
  const behaviorChangeSummary =
    `Frozen Class-C candidate ${candidate.candidateBundleDigest} changes ` +
    `${derived.exactChanges.length} exact Git paths and affects ` +
    `${impact.affectedCapabilities.join(', ')}.`;
  const material = createControlPlanePromotionMaterial({
    mandateBinding,
    repositoryId: candidate.repositoryId,
    frozenCandidateBundleDigest: prefixedCandidateDigest(
      candidate.candidateBundleDigest,
    ),
    candidateDigest: controlPlaneCandidateDigestV2(derived.exactChanges),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    affectedCapabilities: impact.affectedCapabilities,
    behaviorChangeSummary,
    exactChanges: derived.exactChanges,
    candidateArtifact: candidateArtifactRecord.artifact,
    candidateExecutableBase64: candidateExecutable.toString('base64'),
    candidateExecutableProvenanceDigest: candidateArtifactRecord.recordDigest,
    candidateFiles: derived.afterFiles,
    recoveryBundle,
  });
  const lineage = createControlPlanePromotionLineage({
    historyAnchorDigest: history.anchor.recordDigest,
    previousTerminalRecordDigest: history.leaf.recordDigest,
    previousSupervisorRecordDigest: supervisor.recordDigest,
    previousGeneration: supervisor.generation,
    candidateGeneration: supervisor.generation + 1,
    rollbackGeneration: supervisor.generation + 2,
    previousActiveTrustCommit: history.activeTrustCommit,
    candidateTrustCommit: candidate.candidateCommit,
  });
  const promotionMaterialDigest = controlPlanePromotionMaterialDigest(material);
  const baseSummary = promotionReviewSummaryBase(
    material,
    promotionMaterialDigest,
    rollbackTestReportDigest,
  );
  const summary = Object.freeze({
    ...baseSummary,
    kind: 'control-plane-promotion-review-summary.v3' as const,
    promotionLineageDigest: lineage.lineageDigest,
    previousGeneration: lineage.previousGeneration,
    candidateGeneration: lineage.candidateGeneration,
    rollbackGeneration: lineage.rollbackGeneration,
    previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
    previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
    humanReadable: [
      'Successive control-plane promotion review v3',
      `Lineage: ${lineage.lineageDigest}`,
      `History anchor: ${lineage.historyAnchorDigest}`,
      `Previous terminal: ${lineage.previousTerminalRecordDigest}`,
      `Supervisor generation: ${lineage.previousGeneration} -> ${lineage.candidateGeneration}`,
      baseSummary.humanReadable,
    ].join('\n'),
  });
  const replayReviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  const existing =
    findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer(
      stateRoot,
      promotionMaterialDigest,
      lineage.lineageDigest,
      replayReviewer,
    );
  if (existing !== null) {
    const review = existing.bundle.independentReviewAttestation;
    if (
      !verifySignatureSafely(
        dependencies.verifyHumanSignature,
        canonicalControlPlaneIndependentReviewAttestationPayloadV3(
          review.payload,
        ),
        review.signature,
        replayReviewer,
        CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
      )
    ) {
      throw producerError(
        'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
        'The persisted successor review signature could not be verified for replay.',
        ExitCode.verification,
      );
    }
    return Object.freeze({
      kind: 'control-plane-promotion-producer-result.v3' as const,
      action: 'produce-control-plane-approval-candidate' as const,
      replayed: true,
      candidate: existing,
      summary,
    });
  }

  dependencies.presentReviewSummary(summary);
  dependencies.reviewSigner.assertHumanPresent();
  const reviewer = reviewerIdentity(dependencies.reviewSigner.identity());
  if (reviewer !== replayReviewer) {
    throw producerError(
      'CONTROL_PLANE_REVIEWER_IDENTITY_DRIFT',
      'The configured reviewer identity changed during the review ceremony.',
      ExitCode.staleState,
    );
  }
  const reviewedAt = producerNow(dependencies).toISOString();
  const reviewPayload: ControlPlaneIndependentReviewAttestationPayloadV3 = {
    kind: 'control-plane-independent-review.v3',
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest,
    promotionLineageDigest: lineage.lineageDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    recoveryBundleDigest: material.recoveryBundle.bundleDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    verdict: 'approved',
    reviewedAt,
    reviewSummary:
      'Independent reviewer approved the exact successor material, predecessor lineage, and recovery evidence.',
    reviewer,
  };
  const signature = dependencies.reviewSigner
    .sign(
      canonicalControlPlaneIndependentReviewAttestationPayloadV3(reviewPayload),
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
    )
    .trim();
  if (
    !verifySignatureSafely(
      dependencies.verifyHumanSignature,
      canonicalControlPlaneIndependentReviewAttestationPayloadV3(reviewPayload),
      signature,
      reviewer,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
    )
  ) {
    throw producerError(
      'CONTROL_PLANE_REVIEW_SIGNATURE_INVALID',
      'The independently produced successor review signature could not be verified.',
      ExitCode.verification,
    );
  }
  const review: ControlPlaneIndependentReviewAttestationEnvelopeV3 = {
    payload: reviewPayload,
    signature,
  };
  const bundle = createControlPlanePromotionBundleV3({
    material,
    lineage,
    independentReviewAttestation: review,
  });
  const persisted = persistControlPlaneApprovalCandidateV3(
    stateRoot,
    {
      txId: `control-plane-successor-${bundle.bundleDigest.slice('sha256:'.length)}`,
      mandateBinding,
      beforeManifest,
      afterManifest,
      bundle,
    },
    new Date(reviewedAt),
  );
  return Object.freeze({
    kind: 'control-plane-promotion-producer-result.v3' as const,
    action: 'produce-control-plane-approval-candidate' as const,
    replayed: false,
    candidate: persisted,
    summary,
  });
}

function promotionReviewSummaryBase(
  material: ReturnType<typeof createControlPlanePromotionMaterial>,
  promotionMaterialDigest: Sha256Digest,
  rollbackTestReportDigest: Sha256Digest,
): ControlPlanePromotionReviewSummaryBase {
  const humanReadable = [
    'Independent control-plane promotion review',
    `Repository: ${material.repositoryId}`,
    `Frozen Class-C candidate: ${material.frozenCandidateBundleDigest}`,
    `Promotion material: ${promotionMaterialDigest}`,
    `Candidate digest: ${material.candidateDigest}`,
    `Before closure: ${material.beforeClosureDigest}`,
    `After closure: ${material.afterClosureDigest}`,
    `Affected capabilities: ${material.affectedCapabilities.join(', ')}`,
    `Candidate EngineArtifact: ${material.candidateArtifact.artifactId}`,
    `Candidate executable provenance: ${material.candidateExecutableProvenanceDigest}`,
    `Recovery EngineArtifact: ${material.recoveryBundle.restartArtifact.artifactId}`,
    `Recovery executable provenance: ${material.recoveryBundle.restartExecutableProvenanceDigest}`,
    `Rollback-test evidence: ${rollbackTestReportDigest}`,
    `Behavior change: ${material.behaviorChangeSummary}`,
  ].join('\n');
  return Object.freeze({
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    promotionMaterialDigest,
    candidateDigest: material.candidateDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    candidateArtifactId: material.candidateArtifact.artifactId,
    candidateExecutableProvenanceDigest:
      material.candidateExecutableProvenanceDigest,
    recoveryArtifactId: material.recoveryBundle.restartArtifact.artifactId,
    recoveryExecutableProvenanceDigest:
      material.recoveryBundle.restartExecutableProvenanceDigest,
    rollbackTestReportDigest,
    behaviorChangeSummary: material.behaviorChangeSummary,
    humanReadable,
  });
}

function producerNow(dependencies: { now?: () => Date }): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_CLOCK_INVALID',
      'Control-plane producer clock is invalid.',
      ExitCode.usage,
    );
  }
  return new Date(now.getTime());
}

function requireProducerDependencies(dependencies: {
  reviewSigner: unknown;
  verifyHumanSignature: unknown;
  presentReviewSummary: unknown;
}): void {
  if (
    !dependencies.reviewSigner ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.presentReviewSummary !== 'function'
  ) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_DEPENDENCIES_REQUIRED',
      'Production producer requires the independent review UI, signer, and trusted verifier.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function verifySignatureSafely(
  verifier: PersistenceHumanSignatureVerifier,
  payload: string,
  signature: string,
  identity: string,
  namespace: string,
): boolean {
  try {
    return verifier(payload, signature, identity, namespace);
  } catch {
    return false;
  }
}

function prefixedCandidateDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw producerError(
      'CONTROL_PLANE_PRODUCER_FROZEN_CANDIDATE_MISMATCH',
      'Frozen candidate digest is not canonical.',
      ExitCode.verification,
    );
  }
  return `sha256:${value}`;
}

function reviewerIdentity(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw producerError(
      'CONTROL_PLANE_REVIEWER_IDENTITY_INVALID',
      'The configured independent reviewer identity is not canonical.',
      ExitCode.unsafeEnvironment,
    );
  }
  return value;
}

function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function gitMaterialInvalid(filePath: string) {
  return producerError(
    'CONTROL_PLANE_PRODUCER_GIT_MATERIAL_INVALID',
    `Candidate path ${filePath} is not an exact regular Git blob.`,
    ExitCode.verification,
  );
}

function executableInvalid() {
  return producerError(
    'CONTROL_PLANE_PRODUCER_EXECUTABLE_INVALID',
    'Engine executable bytes, mode, or provenance changed during production.',
    ExitCode.verification,
  );
}

function processEvidenceInvalid() {
  return producerError(
    'CONTROL_PLANE_PRODUCER_ROLLBACK_TEST_FAILED',
    'Candidate self-test or recovery restart probe did not produce exact passing evidence.',
    ExitCode.verification,
  );
}

function producerError(code: string, message: string, exitCode: ExitCodeValue) {
  return workflowError(code, message, exitCode);
}

export type ControlPlaneCandidateMaterialBindings = {
  controlPlaneSupervisorHistoryDirectory: typeof controlPlaneSupervisorHistoryDirectory;
  fs: typeof fs;
  readControlPlaneSupervisorHistory: typeof readControlPlaneSupervisorHistory;
  readBuiltInControlPlaneEngineArtifact: typeof readBuiltInControlPlaneEngineArtifact;
  producerError: typeof producerError;
  ExitCode: typeof ExitCode;
  readInitialControlPlaneSupervisorAnchorEvidence: typeof readInitialControlPlaneSupervisorAnchorEvidence;
  createControlPlaneSupervisorHistoryAnchor: typeof createControlPlaneSupervisorHistoryAnchor;
  appendControlPlaneSupervisorHistoryRecord: typeof appendControlPlaneSupervisorHistoryRecord;
  readPersistedControlPlaneUpdate: typeof readPersistedControlPlaneUpdate;
  readPersistedControlPlaneApprovalCandidateCurrent: typeof readPersistedControlPlaneApprovalCandidateCurrent;
  runGit: typeof runGit;
  canonicalJson: typeof canonicalJson;
  bootstrapInterventionStateRoot: typeof bootstrapInterventionStateRoot;
  path: typeof path;
  runGitBuffer: typeof runGitBuffer;
  compareCanonicalStrings: typeof compareCanonicalStrings;
  rawDigest: typeof rawDigest;
  gitMaterialInvalid: typeof gitMaterialInvalid;
  MAX_EXECUTABLE_BYTES: typeof MAX_EXECUTABLE_BYTES;
  executableInvalid: typeof executableInvalid;
  childProcess: typeof childProcess;
  PROCESS_TIMEOUT_MS: typeof PROCESS_TIMEOUT_MS;
  MAX_PROCESS_OUTPUT_BYTES: typeof MAX_PROCESS_OUTPUT_BYTES;
  processEvidenceInvalid: typeof processEvidenceInvalid;
};
export type ControlPlaneCandidateMaterialBindingsTypes = {
  VerifiedControlPlaneSupervisorHistory: VerifiedControlPlaneSupervisorHistory;
  ImmutableCandidateBundleV2: ImmutableCandidateBundleV2;
  DerivedFrozenCandidate: DerivedFrozenCandidate;
  ExactControlPlaneChangeV2: ExactControlPlaneChangeV2;
  ControlPlanePromotionFileMaterial: ControlPlanePromotionFileMaterial;
  Sha256Digest: Sha256Digest;
  ExactGitFileState: ExactGitFileState;
  readControlPlaneSupervisorState: typeof readControlPlaneSupervisorState;
  readBuiltInControlPlaneEngineArtifact: typeof readBuiltInControlPlaneEngineArtifact;
  discoverRepository: typeof discoverRepository;
};

const {
  ensureTerminalSupervisorHistory,
  assertFrozenCandidatePrestate,
  assertProducerStateRoot,
  deriveFrozenCandidate,
  frozenCandidateSourceDigest,
  readStableExecutable,
  assertExecutableUnchanged,
  runControlPlaneProbe,
} = createControlPlaneCandidateMaterial(() => ({
  controlPlaneSupervisorHistoryDirectory,
  fs,
  readControlPlaneSupervisorHistory,
  readBuiltInControlPlaneEngineArtifact,
  producerError,
  ExitCode,
  readInitialControlPlaneSupervisorAnchorEvidence,
  createControlPlaneSupervisorHistoryAnchor,
  appendControlPlaneSupervisorHistoryRecord,
  readPersistedControlPlaneUpdate,
  readPersistedControlPlaneApprovalCandidateCurrent,
  runGit,
  canonicalJson,
  bootstrapInterventionStateRoot,
  path,
  runGitBuffer,
  compareCanonicalStrings,
  rawDigest,
  gitMaterialInvalid,
  MAX_EXECUTABLE_BYTES,
  executableInvalid,
  childProcess,
  PROCESS_TIMEOUT_MS,
  MAX_PROCESS_OUTPUT_BYTES,
  processEvidenceInvalid,
}));
