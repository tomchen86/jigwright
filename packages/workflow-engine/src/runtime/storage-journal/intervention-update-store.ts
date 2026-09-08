/**
 * Persists control-plane update preparation, advancement, and recovery decisions.
 *
 * Invariants:
 * - Control-update authority retains the exact transaction, artifact, capability, and review bindings.
 * - Transaction uniqueness, observation validation, and publication remain within the operation lock.
 *
 * Depends on: control-plane domain policy, current grant contracts, and private persistence primitives.
 * Failure modes: duplicate update transactions, stale authority, or corrupted control-update observations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type ControlPlaneGrantEnvelopeV3,
  type ProtectedCapabilityManifest,
  type ControlPlanePromotionBundleV3,
  verifyControlPlaneGrantV3,
  prepareMinimalUpdaterTransaction,
  type Sha256Digest,
  advanceMinimalUpdaterTransaction,
  type MinimalUpdaterTransaction,
  type ControlPlaneRecoveryDecision,
  decideControlPlaneRecovery,
} from '../../modules/authority/intervention-control.ts';
import type {
  PersistenceHumanDependencies,
  PersistedControlPlaneUpdateRecordV3,
  PersistedTransitionObservation,
  PersistedControlPlaneUpdateRecord,
} from './intervention-persistence-contracts.ts';
import {
  requireHumanVerifier,
  persistenceNow,
  withRecordDigest,
  serializeRecord,
  assertDigest,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  controlUpdateRecordCorrupt,
  validateObservations,
  exactIso,
  identityFileName,
} from './intervention-persistence-values.ts';
import { withPersistenceOperation } from './intervention-persistence-locks.ts';
import {
  ensurePersistenceDirectories,
  controlPlaneUpdateRecordPath,
  interventionControlPersistencePaths,
} from './intervention-persistence-paths.ts';
import {
  createPrivateFileExclusive,
  replacePrivateFileAtomic,
  readCanonicalRecord,
} from './intervention-persistence-files.ts';

export function preparePersistedControlPlaneUpdateV3(
  storageRoot: string,
  input: {
    txId: string;
    envelope: ControlPlaneGrantEnvelopeV3;
    beforeManifest: ProtectedCapabilityManifest;
    afterManifest: ProtectedCapabilityManifest;
    bundle: ControlPlanePromotionBundleV3;
  },
  dependencies: PersistenceHumanDependencies & {
    consumedGrantIds?: ReadonlySet<string>;
  },
): PersistedControlPlaneUpdateRecordV3 {
  const verifyHumanSignature = requireHumanVerifier(dependencies);
  if (dependencies.consumedGrantIds === undefined) {
    throw workflowError(
      'INTERVENTION_CONTROL_CONSUMPTION_STATE_REQUIRED',
      'Minimal updater v3 preparation requires trusted grant consumption state.',
      ExitCode.guard,
    );
  }
  const consumedGrantIds = dependencies.consumedGrantIds;
  const now = persistenceNow(dependencies);
  const grantId = input.envelope.payload.grantId;
  return withPersistenceOperation(
    storageRoot,
    'control-update-reservation',
    () => {
      ensurePersistenceDirectories(storageRoot);
      const target = controlPlaneUpdateRecordPath(storageRoot, grantId);
      if (fs.existsSync(target)) {
        readPersistedControlPlaneUpdate(storageRoot, grantId);
        throw workflowError(
          'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
          'Control-Plane Grant already has a durable transaction.',
          ExitCode.conflict,
        );
      }
      assertUniqueControlTransactionId(storageRoot, input.txId);
      const grant = verifyControlPlaneGrantV3(input.envelope, {
        now,
        beforeManifest: input.beforeManifest,
        afterManifest: input.afterManifest,
        bundle: input.bundle,
        consumedGrantIds,
        verifyHumanSignature,
      });
      const transaction = prepareMinimalUpdaterTransaction(grant, {
        txId: input.txId,
        now,
      });
      const record = withRecordDigest({
        kind: 'persisted-control-plane-update.v3' as const,
        grantState: 'reserved' as const,
        transaction,
        envelope: input.envelope,
        beforeManifest: input.beforeManifest,
        afterManifest: input.afterManifest,
        changes: input.bundle.material.exactChanges,
        observations: [] as PersistedTransitionObservation[],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        effectsPerformed: false as const,
      });
      createPrivateFileExclusive(target, serializeRecord(record));
      return record;
    },
  );
}

export function advancePersistedControlPlaneUpdate(
  storageRoot: string,
  input: {
    grantId: string;
    expectedJournalDigest: Sha256Digest;
    event: Parameters<typeof advanceMinimalUpdaterTransaction>[1];
    evidenceDigest: Sha256Digest;
  },
): PersistedControlPlaneUpdateRecord {
  assertDigest(
    input.evidenceDigest,
    'INTERVENTION_CONTROL_UPDATE_EVIDENCE_INVALID',
  );
  return withPersistenceOperation(
    storageRoot,
    `control-update:${input.grantId}`,
    () => {
      const current = readPersistedControlPlaneUpdate(
        storageRoot,
        input.grantId,
      );
      if (current.transaction.journalDigest !== input.expectedJournalDigest) {
        throw workflowError(
          'INTERVENTION_CONTROL_UPDATE_CAS_MISMATCH',
          'Minimal updater journal changed since it was read.',
          ExitCode.staleState,
        );
      }
      if (current.grantState === 'consumed') {
        throw workflowError(
          'INTERVENTION_CONTROL_GRANT_ALREADY_CONSUMED',
          'Control-Plane Grant transaction is terminal and cannot replay.',
          ExitCode.conflict,
        );
      }
      const fromState = current.transaction.state;
      const transaction = advanceMinimalUpdaterTransaction(
        current.transaction,
        input.event,
      );
      const observation: PersistedTransitionObservation = {
        sequence: current.observations.length + 1,
        eventKind: input.event.kind,
        fromState,
        toState: transaction.state,
        evidenceDigest: input.evidenceDigest,
        recordedAt: input.event.at,
      };
      const grantState: 'reserved' | 'consumed' =
        transaction.state === 'FINALIZED' || transaction.state === 'ROLLED_BACK'
          ? 'consumed'
          : 'reserved';
      const next = advanceControlPlaneUpdateRecord(
        current,
        transaction,
        observation,
        grantState,
        input.event.at,
      );
      replacePrivateFileAtomic(
        controlPlaneUpdateRecordPath(storageRoot, input.grantId),
        serializeRecord(next),
      );
      return next;
    },
  );
}

function advanceControlPlaneUpdateRecord(
  current: PersistedControlPlaneUpdateRecord,
  transaction: MinimalUpdaterTransaction,
  observation: PersistedTransitionObservation,
  grantState: 'reserved' | 'consumed',
  updatedAt: string,
): PersistedControlPlaneUpdateRecord {
  return withRecordDigest({
    grantState,
    transaction,
    beforeManifest: current.beforeManifest,
    afterManifest: current.afterManifest,
    kind: current.kind,
    envelope: current.envelope,
    changes: current.changes,
    observations: [...current.observations, observation],
    createdAt: current.createdAt,
    updatedAt,
    effectsPerformed: false as const,
  });
}

export function recoverPersistedControlPlaneUpdate(
  storageRoot: string,
  grantId: string,
): {
  record: PersistedControlPlaneUpdateRecord;
  decision: ControlPlaneRecoveryDecision;
} {
  const record = readPersistedControlPlaneUpdate(storageRoot, grantId);
  return {
    record,
    decision: decideControlPlaneRecovery(record.transaction),
  };
}

export function readPersistedControlPlaneUpdate(
  storageRoot: string,
  grantId: string,
): PersistedControlPlaneUpdateRecord {
  const value = readCanonicalRecord(
    controlPlaneUpdateRecordPath(storageRoot, grantId),
    'INTERVENTION_CONTROL_UPDATE_NOT_FOUND',
  );
  if (!isRecord(value) || value.kind !== 'persisted-control-plane-update.v3') {
    throw workflowError(
      'INTERVENTION_CONTROL_UPDATE_UNSUPPORTED_SCHEMA',
      'Current control-plane recovery accepts only persisted update schema v3.',
      ExitCode.guard,
    );
  }
  if (
    !hasExactKeys(value, [
      'afterManifest',
      'beforeManifest',
      'changes',
      'createdAt',
      'effectsPerformed',
      'envelope',
      'grantState',
      'kind',
      'observations',
      'recordDigest',
      'transaction',
      'updatedAt',
    ]) ||
    !verifyRecordDigest(value)
  ) {
    throw controlUpdateRecordCorrupt();
  }
  const record = value as unknown as PersistedControlPlaneUpdateRecord;
  try {
    if (
      record.envelope.payload.grantId !== grantId ||
      record.transaction.grantId !== grantId ||
      record.effectsPerformed !== false ||
      (record.grantState === 'consumed') !==
        (record.transaction.state === 'FINALIZED' ||
          record.transaction.state === 'ROLLED_BACK')
    ) {
      throw controlUpdateRecordCorrupt();
    }
    decideControlPlaneRecovery(record.transaction);
    validateObservations(
      record.observations,
      record.transaction.history.length - 1,
      record.transaction.state,
    );
    exactIso(record.createdAt, 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT');
    exactIso(record.updatedAt, 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT'
    ) {
      throw error;
    }
    throw controlUpdateRecordCorrupt();
  }
  return record;
}

function assertUniqueControlTransactionId(
  storageRoot: string,
  txId: string,
): void {
  const paths = interventionControlPersistencePaths(storageRoot);
  for (const name of fs.readdirSync(paths.controlUpdates).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw controlUpdateRecordCorrupt();
    }
    const value = readCanonicalRecord(
      path.join(paths.controlUpdates, name),
      'INTERVENTION_CONTROL_UPDATE_NOT_FOUND',
    );
    if (
      !isRecord(value) ||
      !isRecord(value.envelope) ||
      !isRecord(value.envelope.payload) ||
      typeof value.envelope.payload.grantId !== 'string'
    ) {
      throw controlUpdateRecordCorrupt();
    }
    const grantId = value.envelope.payload.grantId;
    if (name !== `${identityFileName('control-update', grantId)}.json`) {
      throw controlUpdateRecordCorrupt();
    }
    const record = readPersistedControlPlaneUpdate(storageRoot, grantId);
    if (record.transaction.txId === txId) {
      throw workflowError(
        'INTERVENTION_CONTROL_TRANSACTION_ID_CONFLICT',
        'Minimal updater transaction id already exists.',
        ExitCode.conflict,
      );
    }
  }
}
