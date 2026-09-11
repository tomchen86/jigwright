import type { LocalEngineBinding } from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { BootstrapDependencies } from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { BootstrapHumanSignatureVerifier } from '../../modules/authority/intervention-bootstrap-contract.ts';
export type { LocalEngineBinding } from '../../modules/authority/intervention-bootstrap-contract.ts';
export type { BootstrapDependencies } from '../../modules/authority/intervention-bootstrap-contract.ts';
export type { BootstrapHumanSignatureVerifier } from '../../modules/authority/intervention-bootstrap-contract.ts';
/**
 * Executes persisted engine adoption steps through intervention bootstrap
 * ports.
 *
 * Invariants:
 * - The executable and artifact must match the exact persisted adoption
 *   record.
 */
import { createInterventionBootstrapWorkspace } from './intervention-bootstrap-workspace.ts';
import { createInterventionBootstrapAbandonment } from './intervention-bootstrap-abandonment.ts';
import { createInterventionBootstrapStorage } from './intervention-bootstrap-storage.ts';
import { createInterventionBootstrapChildWorktree } from './intervention-bootstrap-child-worktree.ts';
import { createInterventionBootstrapEngine } from './intervention-bootstrap-engine.ts';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import { readStoredInterventionEngineArtifact } from '../../runtime/storage-journal/intervention-engine-artifact-store.ts';
import {
  createWipCheckpoint,
  verifyHarnessMaintenanceGrant,
  type EngineArtifact,
  type HarnessMaintenanceGrantEnvelope,
  type Sha256Digest,
} from '../../modules/authority/intervention-control.ts';
import {
  advancePersistedEngineAdoption,
  activeBootstrapSidecarPromotionPinTxIds,
  inFlightPersistedEngineAdoptionTxIds,
  interventionRecordPath,
  interventionControlPersistencePaths,
  persistInterventionPlan,
  recordBootstrapSidecarAbandoned,
  recordBootstrapSidecarAdopted,
  recordBootstrapSidecarWorkspaceMaterialized,
  readPersistedIntervention,
  recoverPersistedEngineAdoption,
  rollbackPersistedEngineAdoption,
  withInterventionParentOperation,
  type PersistedEngineAdoptionRecord,
  type PersistedInterventionRecord,
} from '../../runtime/storage-journal/intervention-control-persistence.ts';

const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const ENGINE_COMMAND_TIMEOUT_MS = 10_000;
const PRIVATE_EXECUTABLE_MODE = 0o500;

export interface PersistedUntrackedFile {
  path: string;
  mode: '100644' | '100755';
  contentBase64: string;
  contentDigest: Sha256Digest;
}

export interface PersistedWipBundle {
  kind: 'harness-wip-bundle.v1';
  checkpointId: Sha256Digest;
  parentChangeId: string;
  repositoryRoot: string;
  baseOid: string;
  tracked: {
    paths: string[];
    workingTreePatchBase64: string;
    stagedPatchBase64: string;
    workingTreePatchDigest: Sha256Digest;
    stagedPatchDigest: Sha256Digest;
  };
  untracked: PersistedUntrackedFile[];
  session: {
    snapshotPath: string;
    contentBase64: string;
    contentDigest: Sha256Digest;
  };
  pendingIntent: string;
  statusPorcelainBase64: string;
  capturedAt: string;
  bundleDigest: Sha256Digest;
}

export interface WipRestoreReceipt {
  kind: 'harness-wip-restore-receipt.v1';
  checkpointId: Sha256Digest;
  bundleDigest: Sha256Digest;
  parentChangeId: string;
  repositoryRoot: string;
  restoredAt: string;
  effectsPerformed: boolean;
  receiptDigest: Sha256Digest;
}

export interface ChildWorktreeMaterializationReceipt {
  kind: 'intervention-child-worktree-materialized.v1';
  workspaceId: Sha256Digest;
  checkpointId: Sha256Digest;
  parentChangeId: string;
  interventionChangeId: string;
  repositoryRoot: string;
  childWorkspacePath: string;
  changeRef: string;
  headOid: string;
  materializedAt: string;
  effectsPerformed: true;
  receiptDigest: Sha256Digest;
}

export interface BootstrapAdoptionStepReceipt {
  kind: 'bootstrap-adoption-step-receipt.v1';
  txId: string;
  action: string;
  beforeJournalDigest: Sha256Digest;
  afterJournalDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
  recordedAt: string;
  effectsPerformed: boolean;
  receiptDigest: Sha256Digest;
}

export interface InterventionAbandonmentIntent {
  kind: 'intervention-abandonment-intent.v1';
  parentChangeId: string;
  grantId: string;
  grantRecordDigest: Sha256Digest;
  reason: string;
  abandonedAt: string;
  intervention: PersistedInterventionRecord;
  localBinding: LocalEngineBinding | null;
  intentDigest: Sha256Digest;
}

export interface InterventionAbandonmentReceipt {
  kind: 'intervention-abandonment-receipt.v1';
  parentChangeId: string;
  grantId: string;
  intentDigest: Sha256Digest;
  completedAt: string;
  blockerCleared: true;
  bindingCleared: boolean;
  receiptDigest: Sha256Digest;
}

export function executePersistedAdoptionStep(
  storageRoot: string,
  input: {
    txId: string;
    expectedJournalDigest: Sha256Digest;
    bindingPath: string;
    artifact: EngineArtifact;
    artifactRecordDigest?: Sha256Digest;
    executablePath: string;
    at: string;
  },
  dependencies: BootstrapDependencies,
): {
  record: PersistedEngineAdoptionRecord;
  receipt: BootstrapAdoptionStepReceipt;
} {
  const verifier = requireHumanVerifier(dependencies);
  const now = bootstrapNow(dependencies);
  exactIso(input.at, 'BOOTSTRAP_ADOPTION_TIMESTAMP_INVALID');
  const recovered = recoverPersistedEngineAdoption(storageRoot, input.txId);
  const current = recovered.record;
  if (current.artifactRecordDigest !== undefined) {
    const storedArtifact = readStoredInterventionEngineArtifact(
      storageRoot,
      current.journal.artifactId,
    );
    if (
      storedArtifact.kind !== 'persisted-intervention-engine-artifact.v2' ||
      storedArtifact.recordDigest !== current.artifactRecordDigest ||
      (input.artifactRecordDigest !== undefined &&
        input.artifactRecordDigest !== storedArtifact.recordDigest) ||
      canonicalJson(storedArtifact.artifact) !==
        canonicalJson(input.artifact) ||
      storedArtifact.executablePath !== input.executablePath
    ) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_ARTIFACT_RECORD_MISMATCH',
        'Bootstrap execution requires the exact persisted artifact record bound by the adoption.',
        ExitCode.verification,
      );
    }
  }
  if (current.journal.journalDigest !== input.expectedJournalDigest) {
    throw workflowError(
      'BOOTSTRAP_ADOPTION_CAS_MISMATCH',
      'Adoption journal changed before bootstrap execution.',
      ExitCode.staleState,
    );
  }
  const intervention = readPersistedIntervention(
    storageRoot,
    current.journal.parentChangeId,
  );
  if (
    [
      'start-new-engine',
      'run-health-check',
      'finalize-commit',
      'rollback-engine-binding',
      'none',
    ].includes(recovered.decision.action)
  ) {
    verifyPersistedMaintenanceGrantForRecovery(
      current.maintenanceGrantEnvelope,
      intervention,
      current.journal,
      verifier,
    );
  } else {
    verifyHarnessMaintenanceGrant(current.maintenanceGrantEnvelope, {
      now,
      parent: intervention.parent,
      relationship: intervention.relationship,
      checkpoint: intervention.checkpoint,
      verifyHumanSignature: verifier,
    });
  }
  assertEngineArtifactIntegrity(input.artifact);
  if (
    input.artifact.artifactId !== current.journal.artifactId ||
    input.artifact.executableDigest !== current.journal.toEngineDigest ||
    input.artifact.writesSessionSchema !== current.journal.sessionSchema ||
    input.artifact.sourceChangeId !== current.journal.interventionChangeId ||
    (input.artifact.workflowBindingDigest !== undefined &&
      input.artifact.workflowBindingDigest !==
        current.journal.workflowBindingDigest)
  ) {
    throw workflowError(
      'BOOTSTRAP_ENGINE_ARTIFACT_MISMATCH',
      'Engine artifact differs from the persisted adoption journal.',
      ExitCode.verification,
    );
  }
  const bindingPath = assertPersistenceOwnedPath(
    storageRoot,
    input.bindingPath,
    'BOOTSTRAP_BINDING_OUTSIDE_STATE',
  );
  const binding = readLocalEngineBinding(bindingPath);
  if (
    binding.parentChangeId !== current.journal.parentChangeId ||
    binding.parentWorkspacePath !==
      intervention.childWorkspace.parentWorkspacePath ||
    binding.parentBranch !==
      `refs/heads/work/${current.journal.parentChangeId}` ||
    binding.interventionChangeId !== current.journal.interventionChangeId ||
    binding.txId !== current.journal.txId ||
    binding.checkpointId !== current.journal.checkpointId ||
    binding.sessionSchema !== current.journal.sessionSchema ||
    binding.activeArtifact.artifactId !== current.journal.artifactId ||
    binding.activeArtifact.executableDigest !==
      current.journal.toEngineDigest ||
    binding.activeArtifact.executablePath !==
      localEngineArtifactPath(storageRoot, current.journal.artifactId) ||
    (binding.interventionState === 'adopted' &&
      !['HEALTHY', 'COMMITTED'].includes(current.journal.state)) ||
    (current.journal.state === 'COMMITTED' &&
      binding.interventionState !== 'adopted')
  ) {
    throw workflowError(
      'BOOTSTRAP_BINDING_MISMATCH',
      'Local engine binding does not belong to this adoption transaction.',
      ExitCode.verification,
    );
  }
  const materializedExecutable = materializeLocalEngineExecutable(
    storageRoot,
    intervention,
    input.artifact,
    input.executablePath,
  );
  const beforeJournalDigest = current.journal.journalDigest;
  let next: PersistedEngineAdoptionRecord;
  let evidence: unknown;
  let effectsPerformed = false;
  switch (recovered.decision.action) {
    case 'checkpoint-parent': {
      const bundle = readPersistedWipBundle(
        storageRoot,
        current.journal.checkpointId,
      );
      assertCheckpointMatchesBundle(intervention, bundle);
      const restore = restorePersistedWipBundle(
        storageRoot,
        {
          parentChangeId: current.journal.parentChangeId,
          repositoryRoot: intervention.childWorkspace.parentWorkspacePath,
          sessionSnapshotPath: bundle.session.snapshotPath,
          maintenanceGrantEnvelope: current.maintenanceGrantEnvelope,
        },
        dependencies,
      );
      evidence = {
        action: 'checkpoint-parent',
        bundleDigest: bundle.bundleDigest,
        restoreReceiptDigest: restore.receiptDigest,
      };
      next = advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        event: { kind: 'parent-checkpointed', at: input.at },
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'update-engine-binding': {
      const updated = ensureBindingEngine(
        bindingPath,
        binding,
        current.journal.fromEngineDigest,
        current.journal.toEngineDigest,
        input.at,
      );
      effectsPerformed = updated.recordDigest !== binding.recordDigest;
      dependencies.testHooks?.afterBindingUpdatedBeforeJournal?.();
      evidence = {
        action: 'update-engine-binding',
        beforeBindingDigest: binding.recordDigest,
        afterBindingDigest: updated.recordDigest,
      };
      next = advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        event: { kind: 'engine-binding-updated', at: input.at },
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'start-new-engine': {
      assertBindingEngine(binding, current.journal.toEngineDigest);
      const probe = runEngineExecutable(
        materializedExecutable,
        input.artifact.executableDigest,
        '--bootstrap-probe',
      );
      if (
        probe.kind !== 'engine-bootstrap-probe.v1' ||
        probe.started !== true ||
        probe.sessionSchema !== current.journal.sessionSchema
      ) {
        throw workflowError(
          'BOOTSTRAP_ENGINE_START_FAILED',
          'New engine bootstrap probe did not report a compatible start.',
          ExitCode.verification,
        );
      }
      effectsPerformed = true;
      evidence = { action: 'start-new-engine', probe };
      next = advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        event: { kind: 'new-engine-started', at: input.at },
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'run-health-check': {
      assertBindingEngine(binding, current.journal.toEngineDigest);
      const health = runEngineExecutable(
        materializedExecutable,
        input.artifact.executableDigest,
        '--health-check',
      );
      if (
        health.kind !== 'engine-health.v1' ||
        typeof health.healthy !== 'boolean' ||
        health.sessionSchema !== current.journal.sessionSchema
      ) {
        throw workflowError(
          'BOOTSTRAP_ENGINE_HEALTH_INVALID',
          'Engine health check returned an invalid contract.',
          ExitCode.verification,
        );
      }
      effectsPerformed = true;
      evidence = { action: 'run-health-check', health };
      next = advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        event: {
          kind: health.healthy ? 'health-check-passed' : 'health-check-failed',
          at: input.at,
        },
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'finalize-commit': {
      assertBindingEngine(binding, current.journal.toEngineDigest);
      const finalized = ensureBindingAdoptionFinalized(
        bindingPath,
        binding,
        current.journal.checkpointId,
        current.journal.interventionChangeId,
        input.at,
      );
      effectsPerformed = finalized.recordDigest !== binding.recordDigest;
      evidence = {
        action: 'finalize-commit',
        beforeBindingDigest: binding.recordDigest,
        afterBindingDigest: finalized.recordDigest,
        blockerCleared: finalized.blocker === null,
      };
      next = advancePersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        event: { kind: 'commit', at: input.at },
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'rollback-engine-binding': {
      const rolledBack = ensureBindingEngine(
        bindingPath,
        binding,
        current.journal.toEngineDigest,
        current.journal.fromEngineDigest,
        input.at,
      );
      effectsPerformed = rolledBack.recordDigest !== binding.recordDigest;
      evidence = {
        action: 'rollback-engine-binding',
        beforeBindingDigest: binding.recordDigest,
        afterBindingDigest: rolledBack.recordDigest,
      };
      next = rollbackPersistedEngineAdoption(storageRoot, {
        txId: input.txId,
        expectedJournalDigest: beforeJournalDigest,
        at: input.at,
        evidenceDigest: canonicalDigest(evidence),
      });
      break;
    }
    case 'none': {
      assertBindingEngine(
        binding,
        recovered.decision.authoritativeEngineDigest,
      );
      evidence = { action: 'none', journalDigest: beforeJournalDigest };
      next = current;
      break;
    }
  }
  const evidenceDigest = canonicalDigest(evidence);
  const recordedAt =
    recovered.decision.action === 'none'
      ? (current.journal.history.at(-1)?.at ?? input.at)
      : input.at;
  const receiptPayload = {
    kind: 'bootstrap-adoption-step-receipt.v1' as const,
    txId: input.txId,
    action: recovered.decision.action,
    beforeJournalDigest,
    afterJournalDigest: next.journal.journalDigest,
    evidenceDigest,
    recordedAt,
    effectsPerformed,
  };
  const receipt: BootstrapAdoptionStepReceipt = {
    ...receiptPayload,
    receiptDigest: canonicalDigest(receiptPayload),
  };
  persistBootstrapReceipt(
    storageRoot,
    `adoption-${input.txId}-${beforeJournalDigest}-${recovered.decision.action}`,
    receipt,
  );
  if (
    next.journal.state === 'COMMITTED' &&
    recovered.decision.action !== 'none'
  ) {
    dependencies.testHooks?.afterAdoptionReceiptPersistedBeforeSidecar?.();
  }
  if (next.journal.state === 'COMMITTED') {
    recordBootstrapSidecarAdopted(storageRoot, {
      parentChangeId: next.journal.parentChangeId,
      txId: next.journal.txId,
      artifact: input.artifact,
      journalDigest: next.journal.journalDigest,
      adoptedAt: next.journal.history.at(-1)!.at,
    });
  }
  return { record: next, receipt };
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw corruptWipBundle();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw corruptWipBundle();
  }
  return decoded;
}

function rawDigest(value: Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(Buffer.from(canonicalJson(value)));
}

function verifyPersistedMaintenanceGrantForRecovery(
  envelope: HarnessMaintenanceGrantEnvelope,
  intervention: PersistedInterventionRecord,
  journal: PersistedEngineAdoptionRecord['journal'],
  verifier: BootstrapHumanSignatureVerifier,
): void {
  const payload = envelope.payload;
  if (
    payload.grantId !== journal.grantId ||
    payload.parentChangeId !== journal.parentChangeId ||
    payload.interventionChangeId !== journal.interventionChangeId ||
    payload.engineFromDigest !== journal.fromEngineDigest ||
    payload.sessionSchema !== journal.sessionSchema ||
    journal.checkpointId !== intervention.checkpoint.checkpointId
  ) {
    throw workflowError(
      'BOOTSTRAP_RECOVERY_GRANT_INVALID',
      'Persisted recovery grant no longer matches the adoption journal.',
      ExitCode.verification,
    );
  }

  try {
    const issuedAt = new Date(payload.issuedAt);
    if (!Number.isFinite(issuedAt.getTime())) {
      throw new Error('invalid issuedAt');
    }
    // An already-prepared transaction must remain safely recoverable after
    // expiry. Revalidate every grant binding and the human signature at its
    // original issue time, while deliberately omitting only the live TTL gate.
    verifyHarnessMaintenanceGrant(envelope, {
      now: issuedAt,
      parent: intervention.parent,
      relationship: intervention.relationship,
      checkpoint: intervention.checkpoint,
      verifyHumanSignature: verifier,
    });
  } catch {
    throw workflowError(
      'BOOTSTRAP_RECOVERY_GRANT_INVALID',
      'Persisted recovery grant failed binding or signature verification.',
      ExitCode.verification,
    );
  }
}

function requireHumanVerifier(
  dependencies: BootstrapDependencies,
): BootstrapHumanSignatureVerifier {
  if (dependencies.verifyHumanSignature === undefined) {
    throw workflowError(
      'BOOTSTRAP_HUMAN_VERIFIER_REQUIRED',
      'Bootstrap effect requires a trusted human grant verifier.',
      ExitCode.guard,
    );
  }
  return dependencies.verifyHumanSignature;
}

function bootstrapNow(dependencies: BootstrapDependencies): Date {
  return exactDate(
    dependencies.now?.() ?? new Date(),
    'BOOTSTRAP_CLOCK_INVALID',
  );
}

function exactDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      code,
      'Bootstrap clock is invalid.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(value.getTime());
}

function exactIso(value: string, code: string): void {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw workflowError(
      code,
      'Bootstrap timestamp is invalid.',
      ExitCode.verification,
    );
  }
}

function assertDigest(
  value: unknown,
  code: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw workflowError(
      code,
      'Expected a canonical sha256 digest.',
      ExitCode.usage,
    );
  }
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function assertGitOid(value: string, code: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw workflowError(
      code,
      'Expected a full Git object id.',
      ExitCode.verification,
    );
  }
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(
      code,
      'Expected a non-empty trimmed string.',
      ExitCode.usage,
    );
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function corruptWipBundle() {
  return workflowError(
    'BOOTSTRAP_WIP_BUNDLE_CORRUPT',
    'Persisted WIP bundle failed integrity verification.',
    ExitCode.verification,
  );
}

function corruptBinding() {
  return workflowError(
    'BOOTSTRAP_BINDING_CORRUPT',
    'Local engine binding failed integrity verification.',
    ExitCode.verification,
  );
}

export type InterventionBootstrapWorkspaceBindings = {
  canonicalRepositoryRoot: typeof canonicalRepositoryRoot;
  canonicalJson: typeof canonicalJson;
  MAX_SESSION_BYTES: typeof MAX_SESSION_BYTES;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  rawDigest: typeof rawDigest;
  path: typeof path;
  interventionControlPersistencePaths: typeof interventionControlPersistencePaths;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  isNodeError: typeof isNodeError;
  readPrivateBytes: typeof readPrivateBytes;
  exactDate: typeof exactDate;
  gitText: typeof gitText;
  assertGitOid: typeof assertGitOid;
  assertDigest: typeof assertDigest;
  assertNonEmpty: typeof assertNonEmpty;
  gitBuffer: typeof gitBuffer;
  MAX_PATCH_BYTES: typeof MAX_PATCH_BYTES;
  canonicalPlainFile: typeof canonicalPlainFile;
  assertPersistenceOwnedPath: typeof assertPersistenceOwnedPath;
  fs: typeof fs;
  canonicalDigest: typeof canonicalDigest;
  createWipCheckpoint: typeof createWipCheckpoint;
  persistInterventionPlan: typeof persistInterventionPlan;
  canonicalPlannedWorkspacePath: typeof canonicalPlannedWorkspacePath;
  readCanonicalPrivateJson: typeof readCanonicalPrivateJson;
  wipBundlePath: typeof wipBundlePath;
  MAX_BUNDLE_BYTES: typeof MAX_BUNDLE_BYTES;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  corruptWipBundle: typeof corruptWipBundle;
  decodeCanonicalBase64: typeof decodeCanonicalBase64;
  assertSafeRelativePath: typeof assertSafeRelativePath;
  exactIso: typeof exactIso;
  requireHumanVerifier: typeof requireHumanVerifier;
  bootstrapNow: typeof bootstrapNow;
  readPersistedIntervention: typeof readPersistedIntervention;
  verifyHarnessMaintenanceGrant: typeof verifyHarnessMaintenanceGrant;
  bootstrapReceiptPath: typeof bootstrapReceiptPath;
  readBootstrapReceipt: typeof readBootstrapReceipt;
  readOptionalPlainFile: typeof readOptionalPlainFile;
  writePrivateFileAtomic: typeof writePrivateFileAtomic;
  persistBootstrapReceipt: typeof persistBootstrapReceipt;
  safeRepositoryPath: typeof safeRepositoryPath;
  gitBufferNoThrow: typeof gitBufferNoThrow;
  ensureSafeParentDirectories: typeof ensureSafeParentDirectories;
  MAX_UNTRACKED_FILE_BYTES: typeof MAX_UNTRACKED_FILE_BYTES;
  MAX_UNTRACKED_TOTAL_BYTES: typeof MAX_UNTRACKED_TOTAL_BYTES;
  bootstrapBundleDirectory: typeof bootstrapBundleDirectory;
  ensurePrivateDirectory: typeof ensurePrivateDirectory;
  isPathInside: typeof isPathInside;
};
export type InterventionBootstrapWorkspaceBindingsTypes = {
  Sha256Digest: Sha256Digest;
  PersistedInterventionRecord: PersistedInterventionRecord;
  PersistedWipBundle: PersistedWipBundle;
  HarnessMaintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
  BootstrapDependencies: BootstrapDependencies;
  WipRestoreReceipt: WipRestoreReceipt;
  PersistedUntrackedFile: PersistedUntrackedFile;
  persistInterventionPlan: typeof persistInterventionPlan;
};

const {
  discoverBootstrapUntrackedAllowlist,
  persistTrustedBootstrapSessionSnapshot,
  capturePersistedWipIntervention,
  readPersistedWipBundle,
  restorePersistedWipBundle,
  assertCheckpointMatchesBundle,
} = createInterventionBootstrapWorkspace(() => ({
  canonicalRepositoryRoot,
  canonicalJson,
  MAX_SESSION_BYTES,
  workflowError,
  ExitCode,
  rawDigest,
  path,
  interventionControlPersistencePaths,
  createPrivateFileExclusive,
  isNodeError,
  readPrivateBytes,
  exactDate,
  gitText,
  assertGitOid,
  assertDigest,
  assertNonEmpty,
  gitBuffer,
  MAX_PATCH_BYTES,
  canonicalPlainFile,
  assertPersistenceOwnedPath,
  fs,
  canonicalDigest,
  createWipCheckpoint,
  persistInterventionPlan,
  canonicalPlannedWorkspacePath,
  readCanonicalPrivateJson,
  wipBundlePath,
  MAX_BUNDLE_BYTES,
  isRecord,
  hasExactKeys,
  corruptWipBundle,
  decodeCanonicalBase64,
  assertSafeRelativePath,
  exactIso,
  requireHumanVerifier,
  bootstrapNow,
  readPersistedIntervention,
  verifyHarnessMaintenanceGrant,
  bootstrapReceiptPath,
  readBootstrapReceipt,
  readOptionalPlainFile,
  writePrivateFileAtomic,
  persistBootstrapReceipt,
  safeRepositoryPath,
  gitBufferNoThrow,
  ensureSafeParentDirectories,
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_TOTAL_BYTES,
  bootstrapBundleDirectory,
  ensurePrivateDirectory,
  isPathInside,
}));
export {
  discoverBootstrapUntrackedAllowlist,
  persistTrustedBootstrapSessionSnapshot,
  capturePersistedWipIntervention,
  readPersistedWipBundle,
  restorePersistedWipBundle,
};

export type InterventionBootstrapAbandonmentBindings = {
  readPersistedIntervention: typeof readPersistedIntervention;
  withInterventionParentOperation: typeof withInterventionParentOperation;
  assertDigest: typeof assertDigest;
  assertNonEmpty: typeof assertNonEmpty;
  exactIso: typeof exactIso;
  assertPersistenceOwnedPath: typeof assertPersistenceOwnedPath;
  canonicalDigest: typeof canonicalDigest;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  canonicalJson: typeof canonicalJson;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  fs: typeof fs;
  fsyncDirectory: typeof fsyncDirectory;
  path: typeof path;
  interventionRecordPath: typeof interventionRecordPath;
  recordBootstrapSidecarAbandoned: typeof recordBootstrapSidecarAbandoned;
  inFlightPersistedEngineAdoptionTxIds: typeof inFlightPersistedEngineAdoptionTxIds;
  activeBootstrapSidecarPromotionPinTxIds: typeof activeBootstrapSidecarPromotionPinTxIds;
  isHarnessInterventionBlocker: typeof isHarnessInterventionBlocker;
  recoverPersistedEngineAdoption: typeof recoverPersistedEngineAdoption;
  readLocalEngineBinding: typeof readLocalEngineBinding;
  crypto: typeof crypto;
  interventionControlPersistencePaths: typeof interventionControlPersistencePaths;
  readCanonicalPrivateJson: typeof readCanonicalPrivateJson;
  MAX_BUNDLE_BYTES: typeof MAX_BUNDLE_BYTES;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  isDigest: typeof isDigest;
};
export type InterventionBootstrapAbandonmentBindingsTypes = {
  Sha256Digest: Sha256Digest;
  InterventionAbandonmentIntent: InterventionAbandonmentIntent;
  InterventionAbandonmentReceipt: InterventionAbandonmentReceipt;
  PersistedInterventionRecord: PersistedInterventionRecord;
  LocalEngineBinding: LocalEngineBinding;
  WorkflowError: WorkflowError;
};

const { assertPersistedInterventionAbandonable, abandonPersistedIntervention } =
  createInterventionBootstrapAbandonment(() => ({
    readPersistedIntervention,
    withInterventionParentOperation,
    assertDigest,
    assertNonEmpty,
    exactIso,
    assertPersistenceOwnedPath,
    canonicalDigest,
    createPrivateFileExclusive,
    canonicalJson,
    workflowError,
    ExitCode,
    fs,
    fsyncDirectory,
    path,
    interventionRecordPath,
    recordBootstrapSidecarAbandoned,
    inFlightPersistedEngineAdoptionTxIds,
    activeBootstrapSidecarPromotionPinTxIds,
    isHarnessInterventionBlocker,
    recoverPersistedEngineAdoption,
    readLocalEngineBinding,
    crypto,
    interventionControlPersistencePaths,
    readCanonicalPrivateJson,
    MAX_BUNDLE_BYTES,
    isRecord,
    hasExactKeys,
    isDigest,
  }));
export { assertPersistedInterventionAbandonable, abandonPersistedIntervention };

export type InterventionBootstrapStorageBindings = {
  assertDigest: typeof assertDigest;
  path: typeof path;
  interventionControlPersistencePaths: typeof interventionControlPersistencePaths;
  crypto: typeof crypto;
  canonicalJson: typeof canonicalJson;
  fs: typeof fs;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  isRecord: typeof isRecord;
  isDigest: typeof isDigest;
  canonicalDigest: typeof canonicalDigest;
  spawnSync: typeof spawnSync;
  MAX_BUNDLE_BYTES: typeof MAX_BUNDLE_BYTES;
  PRIVATE_EXECUTABLE_MODE: typeof PRIVATE_EXECUTABLE_MODE;
  MAX_UNTRACKED_FILE_BYTES: typeof MAX_UNTRACKED_FILE_BYTES;
  rawDigest: typeof rawDigest;
  readLocalEngineBinding: typeof readLocalEngineBinding;
  ensurePlainDirectory: typeof ensurePlainDirectory;
};
export type InterventionBootstrapStorageBindingsTypes = {
  Sha256Digest: Sha256Digest;
};

const {
  localEngineArtifactPath,
  bindingStateRoot,
  bootstrapBundleDirectory,
  wipBundlePath,
  bootstrapReceiptPath,
  persistBootstrapReceipt,
  readBootstrapReceipt,
  canonicalRepositoryRoot,
  canonicalPlannedWorkspacePath,
  canonicalPlainFile,
  canonicalAbsolutePath,
  assertPersistenceOwnedPath,
  assertSafeRelativePath,
  safeRepositoryPath,
  ensureSafeParentDirectories,
  isPathInside,
  gitBuffer,
  gitBufferNoThrow,
  gitText,
  gitRefExists,
  createPrivateFileExclusive,
  createPrivateExecutableExclusive,
  assertPrivateLocalEngineExecutable,
  writePrivateFileAtomic,
  replacePrivateFileAtomic,
  ensurePrivateDirectory,
  readCanonicalPrivateJson,
  readPrivateBytes,
  readOptionalPlainFile,
  fsyncDirectory,
} = createInterventionBootstrapStorage(() => ({
  assertDigest,
  path,
  interventionControlPersistencePaths,
  crypto,
  canonicalJson,
  fs,
  workflowError,
  ExitCode,
  isRecord,
  isDigest,
  canonicalDigest,
  spawnSync,
  MAX_BUNDLE_BYTES,
  PRIVATE_EXECUTABLE_MODE,
  MAX_UNTRACKED_FILE_BYTES,
  rawDigest,
  readLocalEngineBinding,
  ensurePlainDirectory,
}));
export { localEngineArtifactPath };

export type InterventionBootstrapChildWorktreeBindings = {
  requireHumanVerifier: typeof requireHumanVerifier;
  bootstrapNow: typeof bootstrapNow;
  readPersistedIntervention: typeof readPersistedIntervention;
  verifyHarnessMaintenanceGrant: typeof verifyHarnessMaintenanceGrant;
  canonicalRepositoryRoot: typeof canonicalRepositoryRoot;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  readPersistedWipBundle: typeof readPersistedWipBundle;
  bootstrapReceiptPath: typeof bootstrapReceiptPath;
  fs: typeof fs;
  readBootstrapReceipt: typeof readBootstrapReceipt;
  recordBootstrapSidecarWorkspaceMaterialized: typeof recordBootstrapSidecarWorkspaceMaterialized;
  gitRefExists: typeof gitRefExists;
  gitBuffer: typeof gitBuffer;
  gitBufferNoThrow: typeof gitBufferNoThrow;
  canonicalDigest: typeof canonicalDigest;
  persistBootstrapReceipt: typeof persistBootstrapReceipt;
  gitText: typeof gitText;
  path: typeof path;
  isPathInside: typeof isPathInside;
};
export type InterventionBootstrapChildWorktreeBindingsTypes = {
  HarnessMaintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
  BootstrapDependencies: BootstrapDependencies;
  ChildWorktreeMaterializationReceipt: ChildWorktreeMaterializationReceipt;
  PersistedInterventionRecord: PersistedInterventionRecord;
};

const { materializeInterventionChildWorktree } =
  createInterventionBootstrapChildWorktree(() => ({
    requireHumanVerifier,
    bootstrapNow,
    readPersistedIntervention,
    verifyHarnessMaintenanceGrant,
    canonicalRepositoryRoot,
    workflowError,
    ExitCode,
    readPersistedWipBundle,
    bootstrapReceiptPath,
    fs,
    readBootstrapReceipt,
    recordBootstrapSidecarWorkspaceMaterialized,
    gitRefExists,
    gitBuffer,
    gitBufferNoThrow,
    canonicalDigest,
    persistBootstrapReceipt,
    gitText,
    path,
    isPathInside,
  }));
export { materializeInterventionChildWorktree };

export type InterventionBootstrapEngineBindings = {
  assertNonEmpty: typeof assertNonEmpty;
  assertDigest: typeof assertDigest;
  canonicalRepositoryRoot: typeof canonicalRepositoryRoot;
  gitText: typeof gitText;
  localEngineArtifactPath: typeof localEngineArtifactPath;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  exactDate: typeof exactDate;
  canonicalDigest: typeof canonicalDigest;
  createPrivateFileExclusive: typeof createPrivateFileExclusive;
  assertPersistenceOwnedPath: typeof assertPersistenceOwnedPath;
  canonicalJson: typeof canonicalJson;
  readCanonicalPrivateJson: typeof readCanonicalPrivateJson;
  canonicalAbsolutePath: typeof canonicalAbsolutePath;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  corruptBinding: typeof corruptBinding;
  isDigest: typeof isDigest;
  bindingStateRoot: typeof bindingStateRoot;
  exactIso: typeof exactIso;
  replacePrivateFileAtomic: typeof replacePrivateFileAtomic;
  fs: typeof fs;
  assertPrivateLocalEngineExecutable: typeof assertPrivateLocalEngineExecutable;
  canonicalPlainFile: typeof canonicalPlainFile;
  MAX_UNTRACKED_FILE_BYTES: typeof MAX_UNTRACKED_FILE_BYTES;
  isPathInside: typeof isPathInside;
  rawDigest: typeof rawDigest;
  createPrivateExecutableExclusive: typeof createPrivateExecutableExclusive;
  path: typeof path;
  spawnSync: typeof spawnSync;
  ENGINE_COMMAND_TIMEOUT_MS: typeof ENGINE_COMMAND_TIMEOUT_MS;
};
export type InterventionBootstrapEngineBindingsTypes = {
  Sha256Digest: Sha256Digest;
  LocalEngineBinding: LocalEngineBinding;
  EngineArtifact: EngineArtifact;
  PersistedInterventionRecord: PersistedInterventionRecord;
};

const {
  initializeLocalEngineBinding,
  readLocalEngineBinding,
  rebindLocalEngineAfterRolledBackAdoption,
  assertEngineArtifactIntegrity,
  materializeLocalEngineExecutable,
  runEngineExecutable,
  ensureBindingEngine,
  ensureBindingAdoptionFinalized,
  assertBindingEngine,
  isHarnessInterventionBlocker,
} = createInterventionBootstrapEngine(() => ({
  assertNonEmpty,
  assertDigest,
  canonicalRepositoryRoot,
  gitText,
  localEngineArtifactPath,
  workflowError,
  ExitCode,
  exactDate,
  canonicalDigest,
  createPrivateFileExclusive,
  assertPersistenceOwnedPath,
  canonicalJson,
  readCanonicalPrivateJson,
  canonicalAbsolutePath,
  isRecord,
  hasExactKeys,
  corruptBinding,
  isDigest,
  bindingStateRoot,
  exactIso,
  replacePrivateFileAtomic,
  fs,
  assertPrivateLocalEngineExecutable,
  canonicalPlainFile,
  MAX_UNTRACKED_FILE_BYTES,
  isPathInside,
  rawDigest,
  createPrivateExecutableExclusive,
  path,
  spawnSync,
  ENGINE_COMMAND_TIMEOUT_MS,
}));
export {
  initializeLocalEngineBinding,
  readLocalEngineBinding,
  rebindLocalEngineAfterRolledBackAdoption,
};
