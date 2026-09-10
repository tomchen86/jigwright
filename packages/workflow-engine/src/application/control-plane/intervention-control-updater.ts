/**
 * Prepares, executes, and recovers control-plane engine promotions.
 *
 * Invariants:
 * - Promotion authority must match the exact parent Task Mandate binding.
 */
import { createControlPlaneUpdaterStorage } from './control-plane-updater-storage.ts';
import { createControlPlaneUpdaterSupervisor } from './control-plane-updater-supervisor.ts';
import { createControlPlaneUpdaterApproval } from './control-plane-updater-approval.ts';
import { createControlPlaneUpdaterRecovery } from './control-plane-updater-recovery.ts';
import { createControlPlaneUpdaterAudit } from './control-plane-updater-audit.ts';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  consumePersistedControlPlaneRecoveryGrant,
  controlPlaneRecoveryPrestateDigest,
  createControlPlaneRecoveryAuditRecord,
  createControlPlaneRecoveryFailure,
  createControlPlaneRecoveryGrantPayload,
  createControlPlaneRecoveryReceipt,
  expirePersistedControlPlaneRecoveryGrant,
  failPersistedControlPlaneRecoveryGrant,
  findPersistedControlPlaneRecoveryGrantForSource,
  preparePersistedControlPlaneRecoveryGrantConsumption,
  reservePersistedControlPlaneRecoveryGrant,
  throwControlPlaneRecoveryAlreadyConsumed,
  throwControlPlaneRecoveryFailed,
  verifyControlPlaneRecoveryGrant,
  type ControlPlaneRecoveryAuditRecord,
  type ControlPlaneRecoveryGrantEnvelope,
  type ControlPlaneRecoveryGrantPayload,
  type ControlPlaneRecoveryReceipt,
  type ControlPlaneRecoveryStateBinding,
  type PersistedControlPlaneRecoveryGrant,
} from '../../modules/authority/control-plane-recovery-grant.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  ensurePlainDirectory,
  publishPreparedExclusiveLock,
  reclaimDeadPreparedLock,
} from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  classifyProtectedCandidateImpactV2,
  controlPlaneCandidateDigestV2,
  controlPlaneIndependentReviewAttestationDigestV3,
  controlPlanePromotionBundleDigestV3,
  createEngineArtifact,
  normalizeControlPlaneTaskMandateBinding,
  verifyControlPlaneIndependentReviewAttestationV3,
  verifyControlPlaneGrantV3,
  type ControlPlaneGrantEnvelopeV3,
  type ControlPlanePromotionMaterial,
  type ControlPlanePromotionBundleV3,
  type ControlPlaneTaskMandateBinding,
  type EngineArtifact,
  type ExactControlPlaneChangeV2,
  type ProtectedCandidateImpact,
  type ProtectedCapabilityManifest,
  type Sha256Digest,
} from '../../modules/authority/intervention-control.ts';
import {
  advanceBootstrapSidecarPromotionPin,
  bootstrapSidecarPromotionPinPath,
  advancePersistedControlPlaneUpdate,
  controlPlaneUpdateRecordPath,
  interventionControlPersistencePaths,
  preparePersistedControlPlaneUpdateV3,
  readPersistedControlPlaneUpdate,
  readBootstrapSidecarPromotionPin,
  recordBootstrapSidecarPromotionIfPresent,
  reserveBootstrapSidecarPromotion,
  type PersistedControlPlaneUpdateRecord,
  type PersistenceHumanSignatureVerifier,
} from '../../runtime/storage-journal/intervention-control-persistence.ts';
import {
  appendControlPlaneSupervisorHistoryRecord,
  createControlPlaneSupervisorHistoryTerminal,
  createControlPlaneSupervisorHistoryTransition,
  readControlPlaneSupervisorHistory,
  readControlPlaneSupervisorHistoryProgress,
  type ControlPlaneSupervisorHistoryTransition,
} from '../../runtime/storage-journal/control-plane-supervisor-history.ts';

const SUPPORTED_UPDATER_VERSION_V3 = 3;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

export interface PersistedControlPlaneApprovalCandidateV3 {
  kind: 'persisted-control-plane-approval-candidate.v3';
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  txId: string;
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  bundle: ControlPlanePromotionBundleV3;
  createdAt: string;
  recordDigest: Sha256Digest;
}

interface ControlPlaneApprovalSummaryBase {
  mandateBinding: ControlPlaneTaskMandateBinding;
  candidateId: Sha256Digest;
  candidateRecordDigest: Sha256Digest;
  repositoryId: string;
  frozenCandidateBundleDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  promotionMaterialDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  exactChanges: ExactControlPlaneChangeV2[];
  affectedCapabilities: ProtectedCandidateImpact['affectedCapabilities'];
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  rollbackTestReportDigest: Sha256Digest;
  independentReview: {
    attestationDigest: Sha256Digest;
    reviewer: string;
    reviewedAt: string;
    verdict: 'approved';
    reviewSummary: string;
  };
  behaviorChangeSummary: string;
  humanReadable: string;
}

export interface ControlPlaneApprovalSummaryV3 extends Omit<
  ControlPlaneApprovalSummaryBase,
  'humanReadable'
> {
  kind: 'control-plane-approval-summary.v3';
  promotionLineageDigest: Sha256Digest;
  previousGeneration: number;
  candidateGeneration: number;
  rollbackGeneration: number;
  previousSupervisorRecordDigest: Sha256Digest;
  previousTerminalRecordDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlaneApprovalPreflightV3 {
  candidate: PersistedControlPlaneApprovalCandidateV3;
  summary: ControlPlaneApprovalSummaryV3;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneSupervisorState {
  kind: 'control-plane-supervisor-state.v1';
  repositoryId: string;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
    executablePath: string;
  };
  generation: number;
  transition: {
    grantId: string;
    txId: string;
    phase: 'candidate-selected' | 'rollback-restored';
  } | null;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export type ControlPlaneUpdaterAuditEvent =
  | 'prepared'
  | 'old-closure-verified'
  | 'candidate-verified'
  | 'recovery-verified'
  | 'switched'
  | 'self-tested'
  | 'rollback-required'
  | 'finalized'
  | 'rolled-back';

export interface ControlPlaneUpdaterAuditRecord {
  kind: 'control-plane-updater-audit.v1';
  recordId: Sha256Digest;
  repositoryId: string;
  mandateBinding: ControlPlaneTaskMandateBinding;
  parentTaskId: string;
  changeId: string;
  externalAuditRoot: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  sequence: number;
  event: ControlPlaneUpdaterAuditEvent;
  fromState: string;
  toState: string;
  evidenceDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export interface ControlPlaneUpdaterDependencies {
  now?: () => Date;
  consumedGrantIds: ReadonlySet<string>;
  verifyHumanSignature: PersistenceHumanSignatureVerifier;
  auditSink: {
    /** Implementations must make append idempotent by recordId. */
    append(record: ControlPlaneUpdaterAuditRecord): void;
  };
  revalidateTaskMandateBinding?: (
    binding: ControlPlaneTaskMandateBinding,
    phase: ControlPlaneTaskMandateValidationPhase,
  ) => void;
  testHooks?: {
    afterAtomicSwitch?: () => void;
    /** Test-only hard-crash seam after the V3 transition is durable. */
    afterSupervisorHistoryTransition?: () => void;
    /** Test-only hard-crash seam after a terminal transaction, before its seal. */
    beforeTerminalHistorySeal?: () => void;
  };
}

export type ControlPlaneTaskMandateValidationPhase =
  | 'approval-preflight'
  | 'before-persistence'
  | 'before-forward-effect'
  | 'before-atomic-switch';

export interface ControlPlanePromotionResult {
  record: PersistedControlPlaneUpdateRecord;
  supervisor: ControlPlaneSupervisorState;
}

export interface ControlPlaneRecoveryApprovalSummary {
  kind: 'control-plane-recovery-approval-summary.v1';
  recoveryGrantId: string;
  sourceControlPlaneGrantId: string;
  repositoryId: string;
  operation: 'rollback-control-plane';
  previousClosureDigest: Sha256Digest;
  currentClosureDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recoveryBundleDigest: Sha256Digest;
  controlPlaneUpdateRecordDigest: Sha256Digest;
  controlPlaneJournalDigest: Sha256Digest;
  supervisorStateDigest: Sha256Digest;
  supervisorGeneration: number;
  sourceTransactionState: ControlPlaneRecoveryGrantPayload['sourceTransactionState'];
  externalAuditRoot: string;
  humanSigner: string;
  issuedAt: string;
  expiresAt: string;
  approvalDigest: Sha256Digest;
  humanReadable: string;
}

export interface ControlPlaneRecoveryPreflight {
  payload: ControlPlaneRecoveryGrantPayload;
  summary: ControlPlaneRecoveryApprovalSummary;
}

export interface ControlPlaneRecoveryExecutorDependencies extends ControlPlaneUpdaterDependencies {
  recoveryAuditSink: {
    /** Implementations must make append idempotent by recordId. */
    append(record: ControlPlaneRecoveryAuditRecord): void;
  };
}

export interface ControlPlaneRecoveryRollbackResult {
  kind: 'control-plane-recovery-rollback-result.v1';
  action: 'rollback-control-plane';
  sourceControlPlaneGrantId: string;
  recoveryGrantId: string;
  record: PersistedControlPlaneRecoveryGrant;
  receipt: ControlPlaneRecoveryReceipt;
  controlPlaneUpdate: PersistedControlPlaneUpdateRecord;
  supervisor: ControlPlaneSupervisorState;
  effectsPerformed: boolean;
}

interface UpdaterPaths {
  root: string;
  supervisor: string;
  approvalCandidates: string;
  bundles: string;
  artifacts: string;
  operations: string;
  lock: string;
}

interface ProcessEvidence {
  closureDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
}

interface SelfTestEvidence extends ProcessEvidence {
  healthy: boolean;
}

interface ControlPlaneRecoveryContext {
  record: PersistedControlPlaneUpdateRecord;
  bundle: RuntimeControlPlanePromotionBundle;
  supervisor: ControlPlaneSupervisorState;
}

type StoredControlPlanePromotionBundle = ControlPlanePromotionBundleV3;

interface RuntimeControlPlanePromotionBundle {
  version: 3;
  storedBundle: StoredControlPlanePromotionBundle;
  mandateBinding: ControlPlaneTaskMandateBinding;
  repositoryId: string;
  candidateDigest: Sha256Digest;
  beforeClosureDigest: Sha256Digest;
  afterClosureDigest: Sha256Digest;
  candidateArtifact: EngineArtifact;
  candidateExecutableProvenanceDigest: Sha256Digest;
  candidateExecutableBase64: string;
  recoveryBundle: {
    bundleDigest: Sha256Digest;
    previousClosureDigest: Sha256Digest;
    restartArtifact: EngineArtifact;
    restartExecutableBase64: string;
    rollbackTestReportDigest: Sha256Digest;
  };
  bundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
}

export function assertSameControlPlaneTaskMandateBinding(
  expected: ControlPlaneTaskMandateBinding,
  observed: ControlPlaneTaskMandateBinding,
): ControlPlaneTaskMandateBinding {
  const exactExpected = normalizeControlPlaneTaskMandateBinding(expected);
  const exactObserved = normalizeControlPlaneTaskMandateBinding(observed);
  if (canonicalJson(exactExpected) !== canonicalJson(exactObserved)) {
    throw workflowError(
      'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
      'Control-plane authority does not match the exact parent Task Mandate binding.',
      ExitCode.staleState,
    );
  }
  return exactExpected;
}

export function prepareControlPlanePromotionV3(
  storageRoot: string,
  input: {
    txId: string;
    envelope: ControlPlaneGrantEnvelopeV3;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV3;
  },
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, 'prepare-promotion-v3', () => {
    requireUpdaterDependencies(dependencies);
    const now = updaterNow(dependencies);
    if (input.envelope?.payload?.kind !== 'control-plane-grant.v3') {
      throw workflowError(
        'CONTROL_PLANE_GRANT_INVALID',
        'The successor updater accepts only a Control-Plane Grant v3.',
        ExitCode.guard,
      );
    }
    controlPlanePromotionBundleDigestV3(input.bundle);
    assertApprovalCandidateBindingsV3(
      input.beforeManifest,
      input.afterManifest,
      input.bundle,
    );
    if (
      input.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION_V3
    ) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
        'This updater cannot execute the requested successor version.',
        ExitCode.guard,
      );
    }
    if (
      fs.existsSync(
        controlPlaneUpdateRecordPath(
          storageRoot,
          input.envelope.payload.grantId,
        ),
      )
    ) {
      readPersistedControlPlaneUpdate(
        storageRoot,
        input.envelope.payload.grantId,
      );
      throw workflowError(
        'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
        'Control-Plane Grant already has a durable transaction.',
        ExitCode.conflict,
      );
    }
    verifyControlPlaneGrantV3(input.envelope, {
      now,
      beforeManifest: input.beforeManifest,
      afterManifest: input.afterManifest,
      bundle: input.bundle,
      consumedGrantIds: dependencies.consumedGrantIds,
      verifyHumanSignature: dependencies.verifyHumanSignature,
    });
    revalidateControlPlaneTaskMandate(
      input.envelope.payload.mandateBinding,
      dependencies,
      'before-persistence',
    );
    const supervisor = readControlPlaneSupervisorState(storageRoot);
    const history = readControlPlaneSupervisorHistory(storageRoot);
    assertSupervisorMatchesOldClosureV2(supervisor, input.bundle.material);
    if (
      history.leaf.recordDigest !==
        input.bundle.lineage.previousTerminalRecordDigest ||
      history.anchor.recordDigest !==
        input.bundle.lineage.historyAnchorDigest ||
      history.generation !== input.bundle.lineage.previousGeneration ||
      history.supervisorRecordDigest !==
        input.bundle.lineage.previousSupervisorRecordDigest ||
      history.activeTrustCommit !==
        input.bundle.lineage.previousActiveTrustCommit ||
      supervisor.generation !== input.bundle.lineage.previousGeneration ||
      supervisor.recordDigest !==
        input.bundle.lineage.previousSupervisorRecordDigest
    ) {
      throw workflowError(
        'CONTROL_PLANE_PROMOTION_LINEAGE_STALE',
        'The signed successor lineage does not extend the unique terminal history leaf.',
        ExitCode.staleState,
      );
    }
    const paths = ensureUpdaterDirectories(storageRoot);
    persistPromotionBundle(paths, input.envelope.payload.grantId, input.bundle);
    const runtimeBundle = runtimePromotionBundle(input.bundle);
    materializeBundleExecutables(paths, runtimeBundle);
    const record = preparePersistedControlPlaneUpdateV3(
      storageRoot,
      {
        txId: input.txId,
        envelope: input.envelope,
        beforeManifest: input.beforeManifest,
        afterManifest: input.afterManifest,
        bundle: input.bundle,
      },
      {
        now: () => now,
        consumedGrantIds: dependencies.consumedGrantIds,
        verifyHumanSignature: dependencies.verifyHumanSignature,
      },
    );
    emitAuditHistory(record, runtimeBundle, dependencies);
    return { record, supervisor };
  });
}

export function executeControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, `execute:${grantId}`, () =>
    driveControlPlanePromotion(storageRoot, grantId, dependencies),
  );
}

export function recoverControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  return withUpdaterLock(storageRoot, `recover:${grantId}`, () =>
    driveControlPlanePromotion(storageRoot, grantId, dependencies),
  );
}

function driveControlPlanePromotion(
  storageRoot: string,
  grantId: string,
  dependencies: ControlPlaneUpdaterDependencies,
): ControlPlanePromotionResult {
  requireUpdaterDependencies(dependencies);
  const paths = ensureUpdaterDirectories(storageRoot);
  let record = readPersistedControlPlaneUpdate(storageRoot, grantId);
  const bundle = readPromotionBundle(paths, grantId);
  verifyPersistedPromotion(record, bundle, dependencies);
  materializeBundleExecutables(paths, bundle);
  let supervisor = readControlPlaneSupervisorState(storageRoot);
  if (supervisor.repositoryId !== bundle.repositoryId) {
    throw supervisorCorrupt();
  }
  let switchedInThisInvocation = false;
  let conservativeRollback =
    record.transaction.state === 'SWITCHED' ||
    (record.transaction.state === 'RECOVERY_VERIFIED' &&
      supervisor.activeArtifact.artifactId ===
        bundle.candidateArtifact.artifactId);

  emitAuditHistory(record, bundle, dependencies);
  for (;;) {
    switch (record.transaction.state) {
      case 'PREPARED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        const evidence = canonicalDigest({
          kind: 'old-closure-evidence.v1',
          supervisorDigest: supervisor.recordDigest,
          closureDigest: supervisor.activeArtifact.closureDigest,
        });
        record = advanceRecord(record, storageRoot, {
          kind: 'old-closure-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: evidence,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'OLD_CLOSURE_VERIFIED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        runtimePromotionBundle(bundle.storedBundle);
        const executablePath = materializedExecutablePath(
          paths,
          bundle.candidateArtifact,
        );
        assertConfinedExecutable(
          paths,
          executablePath,
          bundle.candidateArtifact.executableDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'candidate-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'candidate-verification-evidence.v1',
            promotionBundleDigest: bundle.bundleDigest,
            artifactId: bundle.candidateArtifact.artifactId,
            executableDigest: bundle.candidateArtifact.executableDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'CANDIDATE_VERIFIED': {
        revalidateControlPlaneTaskMandate(
          record.envelope.payload.mandateBinding,
          dependencies,
          'before-forward-effect',
        );
        assertGrantLiveForForwardEffect(record, dependencies);
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        const restartPath = materializedExecutablePath(
          paths,
          bundle.recoveryBundle.restartArtifact,
        );
        const restart = runRestartProbe(
          paths,
          restartPath,
          bundle.recoveryBundle.restartArtifact.executableDigest,
          bundle.beforeClosureDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'recovery-bundle-verified',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'recovery-verification-evidence.v1',
            bundleDigest: bundle.recoveryBundle.bundleDigest,
            restartEvidenceDigest: restart.evidenceDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'RECOVERY_VERIFIED': {
        if (
          supervisor.activeArtifact.artifactId ===
            bundle.candidateArtifact.artifactId &&
          supervisor.activeArtifact.closureDigest === bundle.afterClosureDigest
        ) {
          assertV3SupervisorTransition(
            storageRoot,
            record,
            bundle,
            supervisor,
            'candidate-selected',
          );
          conservativeRollback = true;
        } else {
          const promotionPin = reserveBootstrapSidecarPromotion(storageRoot, {
            interventionChangeId: bundle.candidateArtifact.sourceChangeId,
            grantId,
            txId: record.transaction.txId,
            artifact: bundle.candidateArtifact,
            candidateExecutableProvenanceDigest:
              requiredV2CandidateExecutableProvenanceDigest(bundle),
            closureDigest: bundle.afterClosureDigest,
            at: record.updatedAt,
          });
          requireV2SidecarAuthority(record, promotionPin, 'pre-switch pin');
          revalidateControlPlaneTaskMandate(
            record.envelope.payload.mandateBinding,
            dependencies,
            'before-atomic-switch',
          );
          assertGrantLiveForForwardEffect(record, dependencies);
          assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
          supervisor = selectV3SupervisorArtifactWithHistory(
            storageRoot,
            supervisor,
            bundle.candidateArtifact,
            bundle.afterClosureDigest,
            record,
            bundle,
            'candidate-selected',
            updaterNow(dependencies),
            dependencies.testHooks,
          );
          switchedInThisInvocation = true;
          dependencies.testHooks?.afterAtomicSwitch?.();
        }
        record = advanceRecord(record, storageRoot, {
          kind: 'atomic-switch-completed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: supervisor.recordDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'SWITCHED': {
        assertSupervisorIsCandidate(supervisor, bundle);
        if (conservativeRollback || !switchedInThisInvocation) {
          record = advanceRecord(record, storageRoot, {
            kind: 'self-tests-failed',
            at: nextTransitionTime(record, dependencies),
            evidenceDigest: canonicalDigest({
              kind: 'conservative-crash-recovery.v1',
              supervisorDigest: supervisor.recordDigest,
            }),
          });
          emitAuditHistory(record, bundle, dependencies);
          continue;
        }
        const candidatePath = materializedExecutablePath(
          paths,
          bundle.candidateArtifact,
        );
        let selfTest: SelfTestEvidence;
        try {
          selfTest = runSelfTest(
            paths,
            candidatePath,
            bundle.candidateArtifact.executableDigest,
            bundle.afterClosureDigest,
          );
        } catch (error) {
          selfTest = {
            healthy: false,
            closureDigest: bundle.afterClosureDigest,
            evidenceDigest: canonicalDigest({
              kind: 'control-plane-self-test-failure.v1',
              failureCode: workflowFailureCode(error),
            }),
          };
        }
        record = advanceRecord(record, storageRoot, {
          kind: selfTest.healthy ? 'self-tests-passed' : 'self-tests-failed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: selfTest.evidenceDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'SELF_TESTED': {
        assertSupervisorIsCandidate(supervisor, bundle);
        const finalizedAt = nextTransitionTime(record, dependencies);
        const commitIntent = advanceBootstrapSidecarPromotionPin(storageRoot, {
          txId: record.transaction.txId,
          expectedState: 'reserved',
          state: 'commit-intent',
          at: finalizedAt,
        });
        requireV2SidecarAuthority(record, commitIntent, 'commit-intent pin');
        record = advanceRecord(record, storageRoot, {
          kind: 'finalize',
          at: finalizedAt,
          evidenceDigest: supervisor.recordDigest,
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'ROLLBACK_REQUIRED': {
        if (
          supervisor.activeArtifact.artifactId ===
          bundle.candidateArtifact.artifactId
        ) {
          assertSupervisorIsCandidate(supervisor, bundle);
          supervisor = selectV3SupervisorArtifactWithHistory(
            storageRoot,
            supervisor,
            bundle.recoveryBundle.restartArtifact,
            bundle.beforeClosureDigest,
            record,
            bundle,
            'rollback-restored',
            updaterNow(dependencies),
            dependencies.testHooks,
          );
        } else {
          assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
          assertV3SupervisorTransition(
            storageRoot,
            record,
            bundle,
            supervisor,
            'rollback-restored',
          );
        }
        const restartPath = materializedExecutablePath(
          paths,
          bundle.recoveryBundle.restartArtifact,
        );
        const restart = runRestartProbe(
          paths,
          restartPath,
          bundle.recoveryBundle.restartArtifact.executableDigest,
          bundle.beforeClosureDigest,
        );
        record = advanceRecord(record, storageRoot, {
          kind: 'rollback-completed',
          at: nextTransitionTime(record, dependencies),
          evidenceDigest: canonicalDigest({
            kind: 'rollback-completion-evidence.v1',
            supervisorDigest: supervisor.recordDigest,
            restartEvidenceDigest: restart.evidenceDigest,
          }),
        });
        emitAuditHistory(record, bundle, dependencies);
        continue;
      }
      case 'FINALIZED':
        assertSupervisorIsCandidate(supervisor, bundle);
        emitAuditHistory(record, bundle, dependencies);
        dependencies.testHooks?.beforeTerminalHistorySeal?.();
        sealV3SupervisorHistory(storageRoot, record, supervisor);
        const projection = recordBootstrapSidecarPromotionIfPresent(
          storageRoot,
          {
            interventionChangeId: bundle.candidateArtifact.sourceChangeId,
            grantId,
            txId: record.transaction.txId,
            artifact: bundle.candidateArtifact,
            closureDigest: bundle.afterClosureDigest,
            evidenceDigest: record.transaction.journalDigest,
            at: record.updatedAt,
          },
        );
        requireV2SidecarAuthority(record, projection, 'final projection');
        const finalizedPin = advanceBootstrapSidecarPromotionPin(storageRoot, {
          txId: record.transaction.txId,
          expectedState: 'commit-intent',
          state: 'finalized',
          at: record.updatedAt,
        });
        requireV2SidecarAuthority(record, finalizedPin, 'finalized pin');
        return { record, supervisor };
      case 'ROLLED_BACK':
        assertSupervisorIsOldClosure(supervisor, record.envelope, bundle);
        emitAuditHistory(record, bundle, dependencies);
        dependencies.testHooks?.beforeTerminalHistorySeal?.();
        sealV3SupervisorHistory(storageRoot, record, supervisor);
        let rolledBackPin = null;
        if (
          fs.existsSync(
            bootstrapSidecarPromotionPinPath(
              storageRoot,
              record.transaction.txId,
            ),
          )
        ) {
          const pin = readBootstrapSidecarPromotionPin(
            storageRoot,
            record.transaction.txId,
          );
          rolledBackPin = advanceBootstrapSidecarPromotionPin(storageRoot, {
            txId: record.transaction.txId,
            expectedState: pin.state,
            state: 'rolled-back',
            at: record.updatedAt,
          });
        }
        // A crash can leave a supervisor effect ahead of its
        // pin. Missing authority must never permit forward progress, but it
        // also must not strand the candidate during conservative rollback.
        if (rolledBackPin !== null) {
          requireV2SidecarAuthority(record, rolledBackPin, 'rollback pin');
        }
        return { record, supervisor };
    }
  }
}

function requiredV2CandidateExecutableProvenanceDigest(
  bundle: RuntimeControlPlanePromotionBundle,
): Sha256Digest {
  return bundle.candidateExecutableProvenanceDigest;
}

function requireV2SidecarAuthority<T>(
  _record: PersistedControlPlaneUpdateRecord,
  value: T | null,
  phase: string,
): T | null {
  if (value === null) {
    throw workflowError(
      'CONTROL_PLANE_V2_SIDECAR_AUTHORITY_REQUIRED',
      `Control-plane update v2 is missing its exact sidecar authority during ${phase}.`,
      ExitCode.verification,
    );
  }
  return value;
}

function verifyPersistedPromotion(
  record: PersistedControlPlaneUpdateRecord,
  bundle: RuntimeControlPlanePromotionBundle,
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  // Recheck the persisted human signature and every exact binding. Expiry is
  // intentionally checked separately before forward effects: once switched,
  // rollback/finalization must remain possible after expiry.
  if (
    bundle.version !== 3 ||
    bundle.storedBundle.kind !== 'control-plane-promotion-bundle.v3' ||
    record.transaction.updaterVersion !== SUPPORTED_UPDATER_VERSION_V3 ||
    record.envelope.payload.updaterVersion !== SUPPORTED_UPDATER_VERSION_V3
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATER_VERSION_UNSUPPORTED',
      'Persisted successor promotion requires updater v3.',
      ExitCode.guard,
    );
  }
  verifyControlPlaneGrantV3(record.envelope, {
    now: new Date(record.envelope.payload.issuedAt),
    beforeManifest: record.beforeManifest,
    afterManifest: record.afterManifest,
    bundle: bundle.storedBundle,
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature: dependencies.verifyHumanSignature,
  });
}

function revalidateControlPlaneTaskMandate(
  binding: ControlPlaneTaskMandateBinding,
  dependencies: ControlPlaneUpdaterDependencies,
  phase: ControlPlaneTaskMandateValidationPhase,
): void {
  dependencies.revalidateTaskMandateBinding?.(
    normalizeControlPlaneTaskMandateBinding(binding),
    phase,
  );
}

function runtimePromotionBundle(
  value: StoredControlPlanePromotionBundle,
): RuntimeControlPlanePromotionBundle {
  controlPlanePromotionBundleDigestV3(value);
  const { material } = value;
  return deepFreeze({
    version: 3 as const,
    storedBundle: structuredClone(value),
    mandateBinding: structuredClone(material.mandateBinding),
    repositoryId: material.repositoryId,
    candidateDigest: material.candidateDigest,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    candidateArtifact: structuredClone(material.candidateArtifact),
    candidateExecutableProvenanceDigest:
      material.candidateExecutableProvenanceDigest,
    candidateExecutableBase64: material.candidateExecutableBase64,
    recoveryBundle: {
      bundleDigest: material.recoveryBundle.bundleDigest,
      previousClosureDigest: material.recoveryBundle.previousClosureDigest,
      restartArtifact: structuredClone(material.recoveryBundle.restartArtifact),
      restartExecutableBase64: material.recoveryBundle.restartExecutableBase64,
      rollbackTestReportDigest:
        material.recoveryBundle.rollbackTestReportDigest,
    },
    bundleDigest: value.bundleDigest,
    promotionLineageDigest: value.promotionLineageDigest,
  });
}

function advanceRecord(
  current: PersistedControlPlaneUpdateRecord,
  storageRoot: string,
  input: {
    kind:
      | 'old-closure-verified'
      | 'candidate-verified'
      | 'recovery-bundle-verified'
      | 'atomic-switch-completed'
      | 'self-tests-passed'
      | 'self-tests-failed'
      | 'finalize'
      | 'rollback-completed';
    at: string;
    evidenceDigest: Sha256Digest;
  },
): PersistedControlPlaneUpdateRecord {
  return advancePersistedControlPlaneUpdate(storageRoot, {
    grantId: current.envelope.payload.grantId,
    expectedJournalDigest: current.transaction.journalDigest,
    event: { kind: input.kind, at: input.at },
    evidenceDigest: input.evidenceDigest,
  });
}

function assertGrantLiveForForwardEffect(
  record: PersistedControlPlaneUpdateRecord,
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  if (
    updaterNow(dependencies).getTime() >=
    Date.parse(record.envelope.payload.expiresAt)
  ) {
    throw workflowError(
      'CONTROL_PLANE_GRANT_EXPIRED',
      'Control-Plane Grant expired before the atomic switch.',
      ExitCode.staleState,
    );
  }
}

function nextTransitionTime(
  record: PersistedControlPlaneUpdateRecord,
  dependencies: ControlPlaneUpdaterDependencies,
): string {
  const now = updaterNow(dependencies).getTime();
  const previous = Date.parse(record.transaction.history.at(-1)!.at);
  return new Date(Math.max(now, previous + 1)).toISOString();
}

function persistPromotionBundle(
  paths: UpdaterPaths,
  grantId: string,
  bundle: StoredControlPlanePromotionBundle,
): void {
  const target = promotionBundlePath(paths, grantId);
  const content = serializeCanonical(bundle);
  if (fs.existsSync(target)) {
    if (
      readPrivateText(target, 'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND') !==
      content
    ) {
      throw workflowError(
        'CONTROL_PLANE_PROMOTION_BUNDLE_CONFLICT',
        'Grant id is already bound to a different promotion bundle.',
        ExitCode.conflict,
      );
    }
    return;
  }
  createPrivateFileExclusive(target, content);
}

function readPromotionBundle(
  paths: UpdaterPaths,
  grantId: string,
): RuntimeControlPlanePromotionBundle {
  const value = readCanonicalPrivateRecord(
    promotionBundlePath(paths, grantId),
    'CONTROL_PLANE_PROMOTION_BUNDLE_NOT_FOUND',
  );
  if (!isRecord(value) || value.kind !== 'control-plane-promotion-bundle.v3') {
    throw workflowError(
      'CONTROL_PLANE_PROMOTION_BUNDLE_UNSUPPORTED_SCHEMA',
      'Current control-plane recovery accepts only promotion bundle schema v3.',
      ExitCode.guard,
    );
  }
  const bundle = value as unknown as ControlPlanePromotionBundleV3;
  controlPlanePromotionBundleDigestV3(bundle);
  return runtimePromotionBundle(bundle);
}

function promotionBundlePath(paths: UpdaterPaths, grantId: string): string {
  assertNonEmpty(grantId, 'CONTROL_PLANE_GRANT_INVALID');
  const name = crypto
    .createHash('sha256')
    .update(`control-plane-promotion\0${grantId}`)
    .digest('hex');
  return path.join(paths.bundles, `${name}.json`);
}

function verifyEngineArtifact(artifact: EngineArtifact): EngineArtifact {
  const artifactKeys = [
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
  ];
  if (
    !isRecord(artifact) ||
    !hasExactKeys(
      artifact,
      'workflowBindingDigest' in artifact
        ? [...artifactKeys, 'workflowBindingDigest']
        : artifactKeys,
    ) ||
    artifact.kind !== 'engine-artifact.v1'
  ) {
    throw promotionBundleCorrupt('Engine artifact schema is invalid.');
  }
  const rebuilt = createEngineArtifact({
    sourceChangeId: artifact.sourceChangeId,
    sourceDigest: artifact.sourceDigest,
    executableDigest: artifact.executableDigest,
    protocolVersion: artifact.protocolVersion,
    canReadSessionSchemas: artifact.canReadSessionSchemas,
    writesSessionSchema: artifact.writesSessionSchema,
    policySchemaVersion: artifact.policySchemaVersion,
    smokeReportDigest: artifact.smokeReportDigest,
    ...(artifact.workflowBindingDigest === undefined
      ? {}
      : { workflowBindingDigest: artifact.workflowBindingDigest }),
  });
  if (rebuilt.artifactId !== artifact.artifactId) {
    throw promotionBundleCorrupt('Engine artifact digest mismatch.');
  }
  return rebuilt;
}

function decodeCanonicalBase64(value: string, code: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw workflowError(
      code,
      'Expected non-empty base64 bytes.',
      ExitCode.guard,
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > MAX_BUNDLE_BYTES) {
    throw workflowError(
      code,
      'Base64 bytes are non-canonical or too large.',
      ExitCode.guard,
    );
  }
  return bytes;
}

function requireUpdaterDependencies(
  dependencies: ControlPlaneUpdaterDependencies,
): void {
  if (
    dependencies?.consumedGrantIds === undefined ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.auditSink?.append !== 'function'
  ) {
    throw workflowError(
      'CONTROL_PLANE_UPDATER_DEPENDENCY_REQUIRED',
      'Minimal updater requires trusted consumption, signature, and audit dependencies.',
      ExitCode.guard,
    );
  }
}

function requireRecoveryDependencies(
  dependencies: ControlPlaneRecoveryExecutorDependencies,
): void {
  requireUpdaterDependencies(dependencies);
  if (typeof dependencies.recoveryAuditSink?.append !== 'function') {
    throw workflowError(
      'HARNESS_RECOVERY_AUDIT_DEPENDENCY_REQUIRED',
      'Recovery executor requires an idempotent external audit sink.',
      ExitCode.guard,
    );
  }
}

function laterIso(...values: string[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
      throw workflowError(
        'HARNESS_RECOVERY_GRANT_CLOCK_INVALID',
        'Recovery transition timestamp is invalid.',
        ExitCode.verification,
      );
    }
    latest = Math.max(latest, time);
  }
  return new Date(latest).toISOString();
}

function updaterNow(dependencies: ControlPlaneUpdaterDependencies): Date {
  return exactDate(
    dependencies.now?.() ?? new Date(),
    'CONTROL_PLANE_UPDATER_CLOCK_INVALID',
  );
}

function exactDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      code,
      'Expected a valid updater clock.',
      ExitCode.usage,
    );
  }
  return new Date(value.getTime());
}

function validTransition(
  value: ControlPlaneSupervisorState['transition'],
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['grantId', 'phase', 'txId']) &&
      typeof value.grantId === 'string' &&
      value.grantId.length > 0 &&
      typeof value.txId === 'string' &&
      value.txId.length > 0 &&
      (value.phase === 'candidate-selected' ||
        value.phase === 'rollback-restored'))
  );
}

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(code, 'Expected a non-empty value.', ExitCode.usage);
  }
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.usage);
  }
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

function withRecordDigest<T extends Record<string, unknown>>(
  payload: T,
): T & { recordDigest: Sha256Digest } {
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function verifyRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) return false;
  const { recordDigest, ...payload } = value;
  return canonicalDigest(payload) === recordDigest;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function promotionBundleCorrupt(message: string) {
  return workflowError(
    'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function approvalCandidateCorrupt(
  message = 'Persisted control-plane approval candidate failed integrity verification.',
) {
  return workflowError(
    'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
    message,
    ExitCode.verification,
  );
}

function supervisorCorrupt() {
  return workflowError(
    'CONTROL_PLANE_SUPERVISOR_CORRUPT',
    'Control-plane supervisor state failed integrity verification.',
    ExitCode.verification,
  );
}

function processVerificationFailed(message: string) {
  return workflowError(
    'CONTROL_PLANE_PROCESS_VERIFICATION_FAILED',
    message,
    ExitCode.verification,
  );
}

function workflowFailureCode(error: unknown): string {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'CONTROL_PLANE_PROCESS_FAILURE';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export type ControlPlaneUpdaterStorageBindings = {
  interventionControlPersistencePaths: typeof interventionControlPersistencePaths;
  path: typeof path;
  ensurePlainDirectory: typeof ensurePlainDirectory;
  fs: typeof fs;
  PRIVATE_DIRECTORY_MODE: typeof PRIVATE_DIRECTORY_MODE;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  crypto: typeof crypto;
  canonicalJson: typeof canonicalJson;
  publishPreparedExclusiveLock: typeof publishPreparedExclusiveLock;
  isNodeError: typeof isNodeError;
  reclaimDeadPreparedLock: typeof reclaimDeadPreparedLock;
  supervisorCorrupt: typeof supervisorCorrupt;
  PRIVATE_EXECUTABLE_MODE: typeof PRIVATE_EXECUTABLE_MODE;
  MAX_EXECUTABLE_BYTES: typeof MAX_EXECUTABLE_BYTES;
  rawDigest: typeof rawDigest;
  PRIVATE_FILE_MODE: typeof PRIVATE_FILE_MODE;
  isRecord: typeof isRecord;
  MAX_BUNDLE_BYTES: typeof MAX_BUNDLE_BYTES;
};
export type ControlPlaneUpdaterStorageBindingsTypes = {
  UpdaterPaths: UpdaterPaths;
  EngineArtifact: EngineArtifact;
  Sha256Digest: Sha256Digest;
};

const {
  updaterPaths,
  ensureUpdaterDirectories,
  ensurePrivateDirectory,
  withUpdaterLock,
  materializedExecutablePath,
  assertConfinedExecutable,
  assertPrivateExecutable,
  createPrivateExecutableExclusive,
  createPrivateFileExclusive,
  replacePrivateFileAtomicCas,
  readCanonicalPrivateRecord,
  readPrivateText,
  serializeCanonical,
} = createControlPlaneUpdaterStorage(() => ({
  interventionControlPersistencePaths,
  path,
  ensurePlainDirectory,
  fs,
  PRIVATE_DIRECTORY_MODE,
  workflowError,
  ExitCode,
  crypto,
  canonicalJson,
  publishPreparedExclusiveLock,
  isNodeError,
  reclaimDeadPreparedLock,
  supervisorCorrupt,
  PRIVATE_EXECUTABLE_MODE,
  MAX_EXECUTABLE_BYTES,
  rawDigest,
  PRIVATE_FILE_MODE,
  isRecord,
  MAX_BUNDLE_BYTES,
}));

export type ControlPlaneUpdaterSupervisorBindings = {
  withUpdaterLock: typeof withUpdaterLock;
  ensureUpdaterDirectories: typeof ensureUpdaterDirectories;
  assertNonEmpty: typeof assertNonEmpty;
  assertDigest: typeof assertDigest;
  verifyEngineArtifact: typeof verifyEngineArtifact;
  decodeCanonicalBase64: typeof decodeCanonicalBase64;
  rawDigest: typeof rawDigest;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  exactDate: typeof exactDate;
  withRecordDigest: typeof withRecordDigest;
  fs: typeof fs;
  canonicalJson: typeof canonicalJson;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  serializeCanonical: typeof serializeCanonical;
  updaterPaths: typeof updaterPaths;
  readCanonicalPrivateRecord: typeof readCanonicalPrivateRecord;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  verifyRecordDigest: typeof verifyRecordDigest;
  supervisorCorrupt: typeof supervisorCorrupt;
  isDigest: typeof isDigest;
  validTransition: typeof validTransition;
  isCanonicalIso: typeof isCanonicalIso;
  assertConfinedExecutable: typeof assertConfinedExecutable;
  deepFreeze: typeof deepFreeze;
  MAX_EXECUTABLE_BYTES: typeof MAX_EXECUTABLE_BYTES;
  path: typeof path;
  ensurePrivateDirectory: typeof ensurePrivateDirectory;
  assertPrivateExecutable: typeof assertPrivateExecutable;
  createPrivateExecutableExclusive: typeof createPrivateExecutableExclusive;
  materializedExecutablePath: typeof materializedExecutablePath;
  replacePrivateFileAtomicCas: typeof replacePrivateFileAtomicCas;
  readControlPlaneSupervisorHistoryProgress: typeof readControlPlaneSupervisorHistoryProgress;
  createControlPlaneSupervisorHistoryTransition: typeof createControlPlaneSupervisorHistoryTransition;
  canonicalDigest: typeof canonicalDigest;
  appendControlPlaneSupervisorHistoryRecord: typeof appendControlPlaneSupervisorHistoryRecord;
  createControlPlaneSupervisorHistoryTerminal: typeof createControlPlaneSupervisorHistoryTerminal;
  processVerificationFailed: typeof processVerificationFailed;
  childProcess: typeof childProcess;
  PROCESS_TIMEOUT_MS: typeof PROCESS_TIMEOUT_MS;
  PROCESS_MAX_BUFFER_BYTES: typeof PROCESS_MAX_BUFFER_BYTES;
};
export type ControlPlaneUpdaterSupervisorBindingsTypes = {
  Sha256Digest: Sha256Digest;
  EngineArtifact: EngineArtifact;
  ControlPlaneSupervisorState: ControlPlaneSupervisorState;
  UpdaterPaths: UpdaterPaths;
  RuntimeControlPlanePromotionBundle: RuntimeControlPlanePromotionBundle;
  PersistedControlPlaneUpdateRecord: PersistedControlPlaneUpdateRecord;
  ControlPlaneUpdaterDependencies: ControlPlaneUpdaterDependencies;
  ControlPlaneSupervisorHistoryTransition: ControlPlaneSupervisorHistoryTransition;
  ControlPlaneGrantEnvelopeV3: ControlPlaneGrantEnvelopeV3;
  ControlPlanePromotionMaterial: ControlPlanePromotionMaterial;
  SelfTestEvidence: SelfTestEvidence;
  ProcessEvidence: ProcessEvidence;
};

const {
  initializeControlPlaneSupervisorState,
  readControlPlaneSupervisorState,
  materializeBundleExecutables,
  selectV3SupervisorArtifactWithHistory,
  assertV3SupervisorTransition,
  sealV3SupervisorHistory,
  assertSupervisorIsOldClosure,
  assertSupervisorMatchesOldClosureV2,
  assertSupervisorIsCandidate,
  runSelfTest,
  runRestartProbe,
} = createControlPlaneUpdaterSupervisor(() => ({
  withUpdaterLock,
  ensureUpdaterDirectories,
  assertNonEmpty,
  assertDigest,
  verifyEngineArtifact,
  decodeCanonicalBase64,
  rawDigest,
  workflowError,
  ExitCode,
  exactDate,
  withRecordDigest,
  fs,
  canonicalJson,
  createPrivateFileExclusive,
  serializeCanonical,
  updaterPaths,
  readCanonicalPrivateRecord,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  supervisorCorrupt,
  isDigest,
  validTransition,
  isCanonicalIso,
  assertConfinedExecutable,
  deepFreeze,
  MAX_EXECUTABLE_BYTES,
  path,
  ensurePrivateDirectory,
  assertPrivateExecutable,
  createPrivateExecutableExclusive,
  materializedExecutablePath,
  replacePrivateFileAtomicCas,
  readControlPlaneSupervisorHistoryProgress,
  createControlPlaneSupervisorHistoryTransition,
  canonicalDigest,
  appendControlPlaneSupervisorHistoryRecord,
  createControlPlaneSupervisorHistoryTerminal,
  processVerificationFailed,
  childProcess,
  PROCESS_TIMEOUT_MS,
  PROCESS_MAX_BUFFER_BYTES,
}));
export {
  initializeControlPlaneSupervisorState,
  readControlPlaneSupervisorState,
};

export type ControlPlaneUpdaterApprovalBindings = {
  controlPlanePromotionBundleDigestV3: typeof controlPlanePromotionBundleDigestV3;
  normalizeControlPlaneTaskMandateBinding: typeof normalizeControlPlaneTaskMandateBinding;
  assertSameControlPlaneTaskMandateBinding: typeof assertSameControlPlaneTaskMandateBinding;
  approvalCandidateCorrupt: typeof approvalCandidateCorrupt;
  assertNonEmpty: typeof assertNonEmpty;
  exactDate: typeof exactDate;
  withRecordDigest: typeof withRecordDigest;
  withUpdaterLock: typeof withUpdaterLock;
  ensureUpdaterDirectories: typeof ensureUpdaterDirectories;
  serializeCanonical: typeof serializeCanonical;
  fs: typeof fs;
  canonicalJson: typeof canonicalJson;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  ensurePrivateDirectory: typeof ensurePrivateDirectory;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  deepFreeze: typeof deepFreeze;
  assertDigest: typeof assertDigest;
  path: typeof path;
  updaterPaths: typeof updaterPaths;
  readCanonicalPrivateRecord: typeof readCanonicalPrivateRecord;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  verifyRecordDigest: typeof verifyRecordDigest;
  isCanonicalIso: typeof isCanonicalIso;
  controlPlaneUpdateRecordPath: typeof controlPlaneUpdateRecordPath;
  readPersistedControlPlaneUpdate: typeof readPersistedControlPlaneUpdate;
  controlPlaneIndependentReviewAttestationDigestV3: typeof controlPlaneIndependentReviewAttestationDigestV3;
  verifyControlPlaneIndependentReviewAttestationV3: typeof verifyControlPlaneIndependentReviewAttestationV3;
  readControlPlaneSupervisorState: typeof readControlPlaneSupervisorState;
  assertSupervisorMatchesOldClosureV2: typeof assertSupervisorMatchesOldClosureV2;
  classifyProtectedCandidateImpactV2: typeof classifyProtectedCandidateImpactV2;
  controlPlaneCandidateDigestV2: typeof controlPlaneCandidateDigestV2;
};
export type ControlPlaneUpdaterApprovalBindingsTypes = {
  ControlPlaneTaskMandateBinding: ControlPlaneTaskMandateBinding;
  ProtectedCapabilityManifest: ProtectedCapabilityManifest;
  ControlPlanePromotionBundleV3: ControlPlanePromotionBundleV3;
  PersistedControlPlaneApprovalCandidateV3: PersistedControlPlaneApprovalCandidateV3;
  Sha256Digest: Sha256Digest;
  PersistenceHumanSignatureVerifier: PersistenceHumanSignatureVerifier;
  ControlPlaneApprovalPreflightV3: ControlPlaneApprovalPreflightV3;
  ProtectedCandidateImpact: ProtectedCandidateImpact;
  ControlPlaneApprovalSummaryV3: ControlPlaneApprovalSummaryV3;
};

const {
  persistControlPlaneApprovalCandidateV3,
  controlPlaneApprovalCandidatePath,
  readPersistedControlPlaneApprovalCandidateV3,
  readPersistedControlPlaneApprovalCandidateCurrent,
  findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer,
  preflightControlPlaneApprovalCandidateV3,
  assertApprovalCandidateBindingsV3,
} = createControlPlaneUpdaterApproval(() => ({
  controlPlanePromotionBundleDigestV3,
  normalizeControlPlaneTaskMandateBinding,
  assertSameControlPlaneTaskMandateBinding,
  approvalCandidateCorrupt,
  assertNonEmpty,
  exactDate,
  withRecordDigest,
  withUpdaterLock,
  ensureUpdaterDirectories,
  serializeCanonical,
  fs,
  canonicalJson,
  workflowError,
  ExitCode,
  ensurePrivateDirectory,
  createPrivateFileExclusive,
  deepFreeze,
  assertDigest,
  path,
  updaterPaths,
  readCanonicalPrivateRecord,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  isCanonicalIso,
  controlPlaneUpdateRecordPath,
  readPersistedControlPlaneUpdate,
  controlPlaneIndependentReviewAttestationDigestV3,
  verifyControlPlaneIndependentReviewAttestationV3,
  readControlPlaneSupervisorState,
  assertSupervisorMatchesOldClosureV2,
  classifyProtectedCandidateImpactV2,
  controlPlaneCandidateDigestV2,
}));
export {
  persistControlPlaneApprovalCandidateV3,
  controlPlaneApprovalCandidatePath,
  readPersistedControlPlaneApprovalCandidateV3,
  readPersistedControlPlaneApprovalCandidateCurrent,
  findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer,
  preflightControlPlaneApprovalCandidateV3,
};

export type ControlPlaneUpdaterRecoveryBindings = {
  withUpdaterLock: typeof withUpdaterLock;
  requireRecoveryDependencies: typeof requireRecoveryDependencies;
  updaterNow: typeof updaterNow;
  exactDate: typeof exactDate;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  findPersistedControlPlaneRecoveryGrantForSource: typeof findPersistedControlPlaneRecoveryGrantForSource;
  throwControlPlaneRecoveryAlreadyConsumed: typeof throwControlPlaneRecoveryAlreadyConsumed;
  createControlPlaneRecoveryGrantPayload: typeof createControlPlaneRecoveryGrantPayload;
  deepFreeze: typeof deepFreeze;
  isRecord: typeof isRecord;
  throwControlPlaneRecoveryFailed: typeof throwControlPlaneRecoveryFailed;
  canonicalJson: typeof canonicalJson;
  verifyControlPlaneRecoveryGrant: typeof verifyControlPlaneRecoveryGrant;
  canonicalDigest: typeof canonicalDigest;
  createControlPlaneRecoveryAuditRecord: typeof createControlPlaneRecoveryAuditRecord;
  expirePersistedControlPlaneRecoveryGrant: typeof expirePersistedControlPlaneRecoveryGrant;
  reservePersistedControlPlaneRecoveryGrant: typeof reservePersistedControlPlaneRecoveryGrant;
  driveControlPlanePromotion: typeof driveControlPlanePromotion;
  createControlPlaneRecoveryFailure: typeof createControlPlaneRecoveryFailure;
  workflowFailureCode: typeof workflowFailureCode;
  laterIso: typeof laterIso;
  failPersistedControlPlaneRecoveryGrant: typeof failPersistedControlPlaneRecoveryGrant;
  createControlPlaneRecoveryReceipt: typeof createControlPlaneRecoveryReceipt;
  preparePersistedControlPlaneRecoveryGrantConsumption: typeof preparePersistedControlPlaneRecoveryGrantConsumption;
  consumePersistedControlPlaneRecoveryGrant: typeof consumePersistedControlPlaneRecoveryGrant;
  ensureUpdaterDirectories: typeof ensureUpdaterDirectories;
  readPersistedControlPlaneUpdate: typeof readPersistedControlPlaneUpdate;
  readPromotionBundle: typeof readPromotionBundle;
  verifyPersistedPromotion: typeof verifyPersistedPromotion;
  readControlPlaneSupervisorState: typeof readControlPlaneSupervisorState;
};
export type ControlPlaneUpdaterRecoveryBindingsTypes = {
  ControlPlaneRecoveryExecutorDependencies: ControlPlaneRecoveryExecutorDependencies;
  ControlPlaneRecoveryPreflight: ControlPlaneRecoveryPreflight;
  ControlPlaneRecoveryGrantEnvelope: ControlPlaneRecoveryGrantEnvelope;
  ControlPlaneRecoveryRollbackResult: ControlPlaneRecoveryRollbackResult;
  ControlPlanePromotionResult: ControlPlanePromotionResult;
  ControlPlaneRecoveryContext: ControlPlaneRecoveryContext;
  ControlPlaneRecoveryStateBinding: ControlPlaneRecoveryStateBinding;
  ControlPlaneRecoveryGrantPayload: ControlPlaneRecoveryGrantPayload;
  ControlPlaneRecoveryApprovalSummary: ControlPlaneRecoveryApprovalSummary;
  workflowError: typeof workflowError;
};

const {
  preflightControlPlaneRecoveryRollback,
  executeControlPlaneRecoveryRollback,
} = createControlPlaneUpdaterRecovery(() => ({
  withUpdaterLock,
  requireRecoveryDependencies,
  updaterNow,
  exactDate,
  workflowError,
  ExitCode,
  findPersistedControlPlaneRecoveryGrantForSource,
  throwControlPlaneRecoveryAlreadyConsumed,
  createControlPlaneRecoveryGrantPayload,
  deepFreeze,
  isRecord,
  throwControlPlaneRecoveryFailed,
  canonicalJson,
  verifyControlPlaneRecoveryGrant,
  canonicalDigest,
  createControlPlaneRecoveryAuditRecord,
  expirePersistedControlPlaneRecoveryGrant,
  reservePersistedControlPlaneRecoveryGrant,
  driveControlPlanePromotion,
  createControlPlaneRecoveryFailure,
  workflowFailureCode,
  laterIso,
  failPersistedControlPlaneRecoveryGrant,
  createControlPlaneRecoveryReceipt,
  preparePersistedControlPlaneRecoveryGrantConsumption,
  consumePersistedControlPlaneRecoveryGrant,
  ensureUpdaterDirectories,
  readPersistedControlPlaneUpdate,
  readPromotionBundle,
  verifyPersistedPromotion,
  readControlPlaneSupervisorState,
}));
export {
  preflightControlPlaneRecoveryRollback,
  executeControlPlaneRecoveryRollback,
};

export type ControlPlaneUpdaterAuditBindings = {
  canonicalDigest: typeof canonicalDigest;
  deepFreeze: typeof deepFreeze;
  normalizeControlPlaneTaskMandateBinding: typeof normalizeControlPlaneTaskMandateBinding;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
};
export type ControlPlaneUpdaterAuditBindingsTypes = {
  PersistedControlPlaneUpdateRecord: PersistedControlPlaneUpdateRecord;
  RuntimeControlPlanePromotionBundle: RuntimeControlPlanePromotionBundle;
  ControlPlaneUpdaterDependencies: ControlPlaneUpdaterDependencies;
  ControlPlaneUpdaterAuditRecord: ControlPlaneUpdaterAuditRecord;
  ControlPlaneTaskMandateBinding: ControlPlaneTaskMandateBinding;
  ControlPlaneUpdaterAuditEvent: ControlPlaneUpdaterAuditEvent;
};

const { emitAuditHistory } = createControlPlaneUpdaterAudit(() => ({
  canonicalDigest,
  deepFreeze,
  normalizeControlPlaneTaskMandateBinding,
  workflowError,
  ExitCode,
}));
