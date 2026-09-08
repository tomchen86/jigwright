/**
 * Reserves and advances parent-bound bootstrap sidecar promotion pins.
 *
 * Invariants:
 * - Promotion pins retain exact transaction, artifact, source workflow, and parent authority bindings.
 * - Reservation and promotion projection preserve their parent lock and CAS checks.
 *
 * Depends on: sidecar records and storage, private persistence, and parent operation locks.
 * Failure modes: competing promotions, stale pin adoption, or promotion state detached from its sidecar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  interventionEngineArtifactRecordPath,
  readStoredInterventionEngineArtifact,
} from './intervention-engine-artifact-store.ts';
import type {
  EngineArtifact,
  Sha256Digest,
} from '../../modules/authority/intervention-control.ts';
import type {
  PersistedBootstrapSidecarPromotionPin,
  PersistedBootstrapSidecarSessionV2,
} from './intervention-persistence-contracts.ts';
import {
  assertSidecarIdentityText,
  sidecarProjectionConflict,
  activeBootstrapMaintenanceWorkflowBindingDigest,
  assertSidecarArtifactSource,
  ensureBootstrapSidecarArtifact,
  appendBootstrapSidecarEvent,
} from './intervention-sidecar-records.ts';
import {
  assertDigest,
  exactIso,
  withRecordDigest,
  serializeRecord,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  isDigest,
  isCanonicalIso,
} from './intervention-persistence-values.ts';
import {
  ensurePersistenceDirectories,
  bootstrapSidecarPromotionPinPath,
  interventionControlPersistencePaths,
} from './intervention-persistence-paths.ts';
import { withInterventionParentOperation } from './intervention-persistence-locks.ts';
import {
  readPersistedBootstrapSidecarWorkflow,
  updateBootstrapSidecarSession,
} from './intervention-sidecar-store.ts';
import {
  createPrivateFileExclusive,
  replacePrivateFileAtomic,
  readCanonicalRecord,
} from './intervention-persistence-files.ts';

export function reserveBootstrapSidecarPromotion(
  storageRoot: string,
  input: {
    interventionChangeId: string;
    grantId: string;
    txId: string;
    artifact: EngineArtifact;
    candidateExecutableProvenanceDigest: Sha256Digest;
    closureDigest: Sha256Digest;
    at: string;
  },
): PersistedBootstrapSidecarPromotionPin | null {
  assertSidecarIdentityText(input.interventionChangeId);
  assertSidecarIdentityText(input.grantId);
  assertSidecarIdentityText(input.txId);
  assertDigest(
    input.candidateExecutableProvenanceDigest,
    'INTERVENTION_SIDECAR_SESSION_INVALID',
  );
  assertDigest(input.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  ensurePersistenceDirectories(storageRoot);
  const artifactPath = interventionEngineArtifactRecordPath(
    storageRoot,
    input.artifact.artifactId,
  );
  if (!fs.existsSync(artifactPath)) return null;
  const artifactRecord = readStoredInterventionEngineArtifact(
    storageRoot,
    input.artifact.artifactId,
  );
  if (
    artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
    artifactRecord.recordDigest !== input.candidateExecutableProvenanceDigest ||
    artifactRecord.interventionChangeId !== input.interventionChangeId ||
    canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)
  ) {
    throw sidecarProjectionConflict(
      'Promotion reservation differs from the exact persisted v2 artifact record.',
    );
  }
  return withInterventionParentOperation(
    storageRoot,
    artifactRecord.parentChangeId,
    () => {
      const sidecar = readPersistedBootstrapSidecarWorkflow(
        storageRoot,
        artifactRecord.parentChangeId,
      );
      const workflowBindingDigest =
        activeBootstrapMaintenanceWorkflowBindingDigest(
          sidecar.workflowBinding,
        );
      const matchingArtifact = sidecar.artifacts.filter(
        (artifact) =>
          artifact.artifactId === input.artifact.artifactId &&
          artifact.evidenceDigest === artifactRecord.recordDigest &&
          artifact.readyAt === artifactRecord.createdAt,
      );
      if (
        !['repair-active', 'adopted'].includes(sidecar.state) ||
        artifactRecord.workflowBindingDigest !== workflowBindingDigest ||
        matchingArtifact.length !== 1
      ) {
        throw sidecarProjectionConflict(
          'Promotion reservation requires the exact current sidecar generation and artifact projection.',
        );
      }
      const candidate = withRecordDigest({
        kind: 'bootstrap-sidecar-promotion-pin.v1' as const,
        parentChangeId: artifactRecord.parentChangeId,
        interventionChangeId: input.interventionChangeId,
        sidecarSessionId: sidecar.sidecarSessionId,
        workflowBindingDigest,
        artifactId: input.artifact.artifactId,
        artifactRecordDigest: artifactRecord.recordDigest,
        sourceDigest: input.artifact.sourceDigest,
        executableDigest: input.artifact.executableDigest,
        closureDigest: input.closureDigest,
        grantId: input.grantId,
        txId: input.txId,
        state: 'reserved' as const,
        createdAt: input.at,
        updatedAt: input.at,
      });
      const target = bootstrapSidecarPromotionPinPath(storageRoot, input.txId);
      if (fs.existsSync(target)) {
        const existing = readBootstrapSidecarPromotionPin(
          storageRoot,
          input.txId,
        );
        const {
          state: _existingState,
          updatedAt: _existingUpdatedAt,
          recordDigest: _existingDigest,
          ...existingIdentity
        } = existing;
        const {
          state: _candidateState,
          updatedAt: _candidateUpdatedAt,
          recordDigest: _candidateDigest,
          ...candidateIdentity
        } = candidate;
        if (
          canonicalJson(existingIdentity) !== canonicalJson(candidateIdentity)
        ) {
          throw sidecarProjectionConflict(
            'Promotion transaction is already pinned to a different sidecar generation.',
          );
        }
        return existing;
      }
      createPrivateFileExclusive(target, serializeRecord(candidate));
      return candidate;
    },
  );
}

export function advanceBootstrapSidecarPromotionPin(
  storageRoot: string,
  input: {
    txId: string;
    expectedState: PersistedBootstrapSidecarPromotionPin['state'];
    state: PersistedBootstrapSidecarPromotionPin['state'];
    at: string;
  },
): PersistedBootstrapSidecarPromotionPin | null {
  exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  const target = bootstrapSidecarPromotionPinPath(storageRoot, input.txId);
  if (!fs.existsSync(target)) return null;
  const observed = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
  return withInterventionParentOperation(
    storageRoot,
    observed.parentChangeId,
    () => {
      const current = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
      if (current.state === input.state) return current;
      if (current.state !== input.expectedState) {
        throw sidecarProjectionConflict(
          'Promotion pin state changed before the requested transition.',
        );
      }
      const sidecar = readPersistedBootstrapSidecarWorkflow(
        storageRoot,
        current.parentChangeId,
      );
      if (
        sidecar.sidecarSessionId !== current.sidecarSessionId ||
        activeBootstrapMaintenanceWorkflowBindingDigest(
          sidecar.workflowBinding,
        ) !== current.workflowBindingDigest
      ) {
        throw sidecarProjectionConflict(
          'Promotion pin no longer matches the exact current sidecar generation.',
        );
      }
      const { recordDigest: _recordDigest, ...payload } = current;
      const next = withRecordDigest({
        ...payload,
        state: input.state,
        updatedAt: input.at,
      });
      replacePrivateFileAtomic(target, serializeRecord(next));
      return next;
    },
  );
}

export function readBootstrapSidecarPromotionPin(
  storageRoot: string,
  txId: string,
): PersistedBootstrapSidecarPromotionPin {
  const value = readCanonicalRecord(
    bootstrapSidecarPromotionPinPath(storageRoot, txId),
    'INTERVENTION_SIDECAR_PROMOTION_PIN_NOT_FOUND',
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'artifactRecordDigest',
      'closureDigest',
      'createdAt',
      'executableDigest',
      'grantId',
      'interventionChangeId',
      'kind',
      'parentChangeId',
      'recordDigest',
      'sidecarSessionId',
      'sourceDigest',
      'state',
      'txId',
      'updatedAt',
      'workflowBindingDigest',
    ]) ||
    value.kind !== 'bootstrap-sidecar-promotion-pin.v1' ||
    !verifyRecordDigest(value) ||
    ![
      value.artifactId,
      value.artifactRecordDigest,
      value.closureDigest,
      value.executableDigest,
      value.recordDigest,
      value.sidecarSessionId,
      value.sourceDigest,
      value.workflowBindingDigest,
    ].every(isDigest) ||
    !['reserved', 'commit-intent', 'finalized', 'rolled-back'].includes(
      String(value.state),
    ) ||
    ![
      value.grantId,
      value.interventionChangeId,
      value.parentChangeId,
      value.txId,
    ].every(
      (entry) =>
        typeof entry === 'string' && entry.length > 0 && entry.trim() === entry,
    ) ||
    !isCanonicalIso(value.createdAt) ||
    !isCanonicalIso(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    throw sidecarProjectionConflict(
      'Promotion pin failed integrity verification.',
    );
  }
  return value as unknown as PersistedBootstrapSidecarPromotionPin;
}

export function activeBootstrapSidecarPromotionPinTxIds(
  storageRoot: string,
  parentChangeId: string,
): string[] {
  const directory =
    interventionControlPersistencePaths(storageRoot).sidecarPromotionPins;
  if (!fs.existsSync(directory)) return [];
  const txIds: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      throw sidecarProjectionConflict(
        'Promotion pin store contains an unexpected entry.',
      );
    }
    const raw = readCanonicalRecord(
      path.join(directory, name),
      'INTERVENTION_SIDECAR_PROMOTION_PIN_NOT_FOUND',
    );
    if (!isRecord(raw) || typeof raw.txId !== 'string') {
      throw sidecarProjectionConflict(
        'Promotion pin store contains an invalid identity.',
      );
    }
    const pin = readBootstrapSidecarPromotionPin(storageRoot, raw.txId);
    if (
      pin.parentChangeId === parentChangeId &&
      ['reserved', 'commit-intent'].includes(pin.state)
    ) {
      txIds.push(pin.txId);
    }
  }
  return txIds;
}

export function recordBootstrapSidecarPromotionIfPresent(
  storageRoot: string,
  input: {
    interventionChangeId: string;
    grantId: string;
    txId: string;
    artifact: EngineArtifact;
    closureDigest: Sha256Digest;
    evidenceDigest: Sha256Digest;
    at: string;
  },
): PersistedBootstrapSidecarSessionV2 | null {
  assertSidecarIdentityText(input.interventionChangeId);
  assertSidecarIdentityText(input.grantId);
  assertSidecarIdentityText(input.txId);
  assertDigest(input.closureDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.at, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  ensurePersistenceDirectories(storageRoot);
  const artifactPath = interventionEngineArtifactRecordPath(
    storageRoot,
    input.artifact.artifactId,
  );
  if (!fs.existsSync(artifactPath)) return null;
  const artifactRecord = readStoredInterventionEngineArtifact(
    storageRoot,
    input.artifact.artifactId,
  );
  if (
    artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
    artifactRecord.interventionChangeId !== input.interventionChangeId ||
    canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)
  ) {
    throw sidecarProjectionConflict(
      'Repository promotion differs from the exact persisted v2 artifact record.',
    );
  }
  const pin = readBootstrapSidecarPromotionPin(storageRoot, input.txId);
  if (
    !['commit-intent', 'finalized'].includes(pin.state) ||
    pin.parentChangeId !== artifactRecord.parentChangeId ||
    pin.interventionChangeId !== input.interventionChangeId ||
    pin.grantId !== input.grantId ||
    pin.artifactId !== input.artifact.artifactId ||
    pin.artifactRecordDigest !== artifactRecord.recordDigest ||
    pin.closureDigest !== input.closureDigest
  ) {
    throw sidecarProjectionConflict(
      'Repository promotion is missing the exact pre-effect sidecar pin.',
    );
  }
  return withInterventionParentOperation(
    storageRoot,
    artifactRecord.parentChangeId,
    () =>
      updateBootstrapSidecarSession(
        storageRoot,
        artifactRecord.parentChangeId,
        (observed) => {
          if (!['repair-active', 'adopted'].includes(observed.state)) {
            throw sidecarProjectionConflict(
              'An abandoned workflow cannot accept repository promotion evidence.',
            );
          }
          assertSidecarArtifactSource(observed, input.artifact);
          if (
            artifactRecord.workflowBindingDigest !==
            activeBootstrapMaintenanceWorkflowBindingDigest(
              observed.workflowBinding,
            )
          ) {
            throw sidecarProjectionConflict(
              'Repository promotion artifact belongs to a different Workflow generation.',
            );
          }
          let current = ensureBootstrapSidecarArtifact(observed, {
            artifact: input.artifact,
            evidenceDigest: artifactRecord.recordDigest,
            readyAt: artifactRecord.createdAt,
          });
          const promotion = {
            grantId: input.grantId,
            txId: input.txId,
            artifactId: input.artifact.artifactId,
            closureDigest: input.closureDigest,
            evidenceDigest: input.evidenceDigest,
            promotedAt: input.at,
          };
          if (current.promotion !== null) {
            if (canonicalJson(current.promotion) !== canonicalJson(promotion)) {
              throw sidecarProjectionConflict(
                'Sidecar already belongs to a different repository promotion.',
              );
            }
            return current;
          }
          current = appendBootstrapSidecarEvent(
            current,
            { promotion },
            {
              eventKind: 'repository-default-promoted',
              evidenceDigest: input.evidenceDigest,
              recordedAt: input.at,
            },
          );
          return current;
        },
      ),
  );
}
