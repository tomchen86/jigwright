/**
 * Publishes bootstrap sidecar creation and lifecycle updates under their current workflow binding.
 *
 * Invariants:
 * - Updates validate the current record and publish the next record inside one operation lock.
 * - Artifact readiness, adoption, abandonment, and history preserve exact workflow identity.
 * - Archived sidecar records and new sessions retain their existing replay and publication order.
 *
 * Depends on: sidecar record codecs, private persistence, and operation locks.
 * Failure modes: lost lifecycle events, overwritten sidecar revisions, or reuse of a stale artifact binding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { readStoredInterventionEngineArtifact } from './intervention-engine-artifact-store.ts';
import type {
  Sha256Digest,
  EngineArtifact,
} from '../../modules/authority/intervention-control.ts';
import type {
  PersistedBootstrapSidecarSessionV2,
  PersistedInterventionRecord,
} from './intervention-persistence-contracts.ts';
import {
  parseBootstrapSidecarWorkflow,
  assertSidecarIdentityText,
  assertSidecarActive,
  sidecarProjectionConflict,
  appendBootstrapSidecarEvent,
  assertSidecarArtifactSource,
  ensureBootstrapSidecarArtifact,
  transitionBootstrapMaintenanceWorkflow,
  createBootstrapMaintenanceWorkflow,
  sidecarMatchesIntervention,
} from './intervention-sidecar-records.ts';
import {
  readCanonicalRecord,
  createPrivateFileExclusive,
  replacePrivateFileAtomic,
} from './intervention-persistence-files.ts';
import {
  persistedBootstrapSidecarSessionPath,
  interventionControlPersistencePaths,
} from './intervention-persistence-paths.ts';
import {
  assertDigest,
  exactIso,
  canonicalDigest,
  withRecordDigest,
  identityFileName,
  serializeRecord,
} from './intervention-persistence-values.ts';
import { withPersistenceOperation } from './intervention-persistence-locks.ts';

export function readPersistedBootstrapSidecarWorkflow(
  storageRoot: string,
  parentChangeId: string,
): PersistedBootstrapSidecarSessionV2 {
  return parseBootstrapSidecarWorkflow(
    readCanonicalRecord(
      persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId),
      'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
    ),
    parentChangeId,
  );
}

export function findPersistedBootstrapSidecarSessionForIntervention(
  storageRoot: string,
  interventionChangeId: string,
): PersistedBootstrapSidecarSessionV2 {
  assertSidecarIdentityText(interventionChangeId);
  const directory =
    interventionControlPersistencePaths(storageRoot).sidecarSessions;
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
      'No durable bootstrap sidecar session exists for the intervention.',
      ExitCode.conflict,
    );
  }
  const matches = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      parseBootstrapSidecarWorkflow(
        readCanonicalRecord(
          path.join(directory, name),
          'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
        ),
      ),
    )
    .filter(
      (record) =>
        record.identity.interventionChangeId === interventionChangeId &&
        record.state === 'repair-active',
    );
  if (matches.length !== 1) {
    throw workflowError(
      matches.length === 0
        ? 'INTERVENTION_SIDECAR_SESSION_NOT_FOUND'
        : 'INTERVENTION_SIDECAR_SESSION_CONFLICT',
      matches.length === 0
        ? 'No active bootstrap sidecar session matches the intervention.'
        : 'Multiple active bootstrap sidecar sessions match the intervention.',
      ExitCode.conflict,
    );
  }
  return matches[0];
}

export function recordBootstrapSidecarWorkspaceMaterialized(
  storageRoot: string,
  input: {
    parentChangeId: string;
    workspaceId: Sha256Digest;
    receiptDigest: Sha256Digest;
    materializedAt: string;
  },
): PersistedBootstrapSidecarSessionV2 {
  assertDigest(input.workspaceId, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  assertDigest(input.receiptDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.materializedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  return updateBootstrapSidecarSession(
    storageRoot,
    input.parentChangeId,
    (current) => {
      assertSidecarActive(current);
      if (current.identity.workspaceId !== input.workspaceId) {
        throw sidecarProjectionConflict(
          'Materialized workspace differs from the sidecar identity.',
        );
      }
      if (current.workspace.state === 'materialized') {
        if (
          current.workspace.receiptDigest !== input.receiptDigest ||
          current.workspace.materializedAt !== input.materializedAt
        ) {
          throw sidecarProjectionConflict(
            'Sidecar workspace already has different materialization evidence.',
          );
        }
        return current;
      }
      return appendBootstrapSidecarEvent(
        current,
        {
          workspace: {
            ...current.workspace,
            state: 'materialized' as const,
            receiptDigest: input.receiptDigest,
            materializedAt: input.materializedAt,
          },
        },
        {
          eventKind: 'workspace-materialized',
          evidenceDigest: input.receiptDigest,
          recordedAt: input.materializedAt,
        },
      );
    },
  );
}

export function recordBootstrapSidecarArtifactReady(
  storageRoot: string,
  input: {
    parentChangeId: string;
    artifact: EngineArtifact;
    evidenceDigest: Sha256Digest;
    readyAt: string;
  },
): PersistedBootstrapSidecarSessionV2 {
  assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.readyAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  return updateBootstrapSidecarSession(
    storageRoot,
    input.parentChangeId,
    (current) => {
      assertSidecarActive(current);
      assertSidecarArtifactSource(current, input.artifact);
      return ensureBootstrapSidecarArtifact(current, {
        artifact: input.artifact,
        evidenceDigest: input.evidenceDigest,
        readyAt: input.readyAt,
      });
    },
  );
}

export function recordBootstrapSidecarAdopted(
  storageRoot: string,
  input: {
    parentChangeId: string;
    txId: string;
    artifact: EngineArtifact;
    journalDigest: Sha256Digest;
    adoptedAt: string;
  },
): PersistedBootstrapSidecarSessionV2 {
  assertSidecarIdentityText(input.txId);
  assertDigest(input.journalDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.adoptedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  const artifactRecord = readStoredInterventionEngineArtifact(
    storageRoot,
    input.artifact.artifactId,
  );
  if (
    artifactRecord.kind !== 'persisted-intervention-engine-artifact.v2' ||
    artifactRecord.parentChangeId !== input.parentChangeId ||
    canonicalJson(artifactRecord.artifact) !== canonicalJson(input.artifact)
  ) {
    throw sidecarProjectionConflict(
      'Successful adoption must project the exact persisted v2 artifact record.',
    );
  }
  return updateBootstrapSidecarSession(
    storageRoot,
    input.parentChangeId,
    (observed) => {
      assertSidecarArtifactSource(observed, input.artifact);
      if (observed.state === 'adopted') {
        if (
          observed.adoption?.txId !== input.txId ||
          observed.adoption.artifactId !== input.artifact.artifactId ||
          observed.adoption.journalDigest !== input.journalDigest ||
          observed.adoption.adoptedAt !== input.adoptedAt
        ) {
          throw sidecarProjectionConflict(
            'Adopted workflow differs from the successful adoption replay.',
          );
        }
        return observed;
      }
      assertSidecarActive(observed);
      if (
        artifactRecord.workflowBindingDigest !==
        observed.workflowBinding.workflowBindingDigest
      ) {
        throw sidecarProjectionConflict(
          'Persisted artifact record belongs to a different Workflow binding.',
        );
      }
      let current = ensureBootstrapSidecarArtifact(observed, {
        artifact: input.artifact,
        evidenceDigest: artifactRecord.recordDigest,
        readyAt: artifactRecord.createdAt,
      });
      const adoption = {
        txId: input.txId,
        artifactId: input.artifact.artifactId,
        journalDigest: input.journalDigest,
        adoptedAt: input.adoptedAt,
        workflowBindingDigest: current.workflowBinding.workflowBindingDigest,
        workflowStatus: 'repair-active' as const,
      };
      if (current.adoption !== null) {
        if (canonicalJson(current.adoption) !== canonicalJson(adoption)) {
          throw sidecarProjectionConflict(
            'Sidecar already belongs to a different successful local adoption.',
          );
        }
        return current;
      }
      if (current.parentUnblock.state !== 'blocking') {
        throw sidecarProjectionConflict(
          'Sidecar parent relation was resolved before local adoption.',
        );
      }
      current = appendBootstrapSidecarEvent(
        current,
        {
          adoption,
          state: 'adopted' as const,
          workflowBinding: transitionBootstrapMaintenanceWorkflow(
            current.workflowBinding,
            'adopted',
          ),
          parentUnblock: {
            kind: 'sidecar-unblocks-parent.v1' as const,
            parentChangeId: current.identity.parentChangeId,
            state: 'unblocked' as const,
            resolution: 'local-adoption' as const,
            resolvedByTxId: input.txId,
            resolvedAt: input.adoptedAt,
          },
        },
        {
          eventKind: 'adopted-by-parent',
          evidenceDigest: input.journalDigest,
          recordedAt: input.adoptedAt,
        },
      );
      return current;
    },
  );
}

export function recordBootstrapSidecarAbandoned(
  storageRoot: string,
  input: {
    parentChangeId: string;
    intervention: PersistedInterventionRecord;
    evidenceDigest: Sha256Digest;
    abandonedAt: string;
  },
): PersistedBootstrapSidecarSessionV2 {
  assertDigest(input.evidenceDigest, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  exactIso(input.abandonedAt, 'INTERVENTION_SIDECAR_SESSION_INVALID');
  if (
    !fs.existsSync(
      persistedBootstrapSidecarSessionPath(storageRoot, input.parentChangeId),
    )
  ) {
    ensureBootstrapSidecarSession(storageRoot, input.intervention);
  }
  return updateBootstrapSidecarSession(
    storageRoot,
    input.parentChangeId,
    (current) => {
      if (current.state === 'abandoned') return current;
      if (
        current.adoption !== null ||
        current.parentUnblock.state !== 'blocking'
      ) {
        throw sidecarProjectionConflict(
          'An adopted sidecar cannot be abandoned as a pre-adoption repair.',
        );
      }
      return appendBootstrapSidecarEvent(
        current,
        {
          state: 'abandoned' as const,
          workflowBinding: transitionBootstrapMaintenanceWorkflow(
            current.workflowBinding,
            'abandoned',
          ),
          parentUnblock: {
            kind: 'sidecar-unblocks-parent.v1' as const,
            parentChangeId: current.identity.parentChangeId,
            state: 'unblocked' as const,
            resolution: 'abandonment' as const,
            resolvedByTxId: null,
            resolvedAt: input.abandonedAt,
          },
        },
        {
          eventKind: 'intervention-abandoned',
          evidenceDigest: input.evidenceDigest,
          recordedAt: input.abandonedAt,
        },
      );
    },
  );
}

export function ensureBootstrapSidecarSession(
  storageRoot: string,
  intervention: PersistedInterventionRecord,
): PersistedBootstrapSidecarSessionV2 {
  const target = persistedBootstrapSidecarSessionPath(
    storageRoot,
    intervention.parent.changeId,
  );
  const identity = {
    parentChangeId: intervention.parent.changeId,
    interventionChangeId: intervention.relationship.interventionChangeId,
    checkpointId: intervention.checkpoint.checkpointId,
    workspaceId: intervention.childWorkspace.workspaceId,
  };
  const createdAt = intervention.createdAt;
  const workflowBinding = createBootstrapMaintenanceWorkflow(
    intervention,
    'repair-active',
  );
  const payload = {
    kind: 'bootstrap-sidecar-session.v2' as const,
    sidecarSessionId: canonicalDigest({
      kind: 'bootstrap-sidecar-session-identity.v2',
      ...identity,
      workflowId: workflowBinding.workflowId,
    }),
    identity,
    workflowBinding,
    state: 'repair-active' as const,
    parentUnblock: {
      kind: 'sidecar-unblocks-parent.v1' as const,
      parentChangeId: intervention.parent.changeId,
      state: 'blocking' as const,
      resolution: null,
      resolvedByTxId: null,
      resolvedAt: null,
    },
    workspace: {
      childWorkspacePath: intervention.childWorkspace.childWorkspacePath,
      changeRef: intervention.childWorkspace.changeRef,
      state: 'planned' as const,
      receiptDigest: null,
      materializedAt: null,
    },
    artifacts: [] as PersistedBootstrapSidecarSessionV2['artifacts'],
    adoption: null,
    promotion: null,
    history: [
      {
        sequence: 1,
        eventKind: 'sidecar-created' as const,
        evidenceDigest: intervention.recordDigest,
        recordedAt: createdAt,
      },
    ],
    createdAt,
    updatedAt: createdAt,
  };
  const record = withRecordDigest(payload);
  if (fs.existsSync(target)) {
    const existing = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      intervention.parent.changeId,
    );
    if (sidecarMatchesIntervention(existing, intervention)) return existing;
    if (existing.state !== 'abandoned') {
      throw sidecarProjectionConflict(
        'Persisted intervention differs from its active bootstrap sidecar identity.',
      );
    }
    const archivePath = path.join(
      interventionControlPersistencePaths(storageRoot).sidecarHistory,
      `${identityFileName('sidecar-session-history', existing.sidecarSessionId)}.json`,
    );
    if (fs.existsSync(archivePath)) {
      const archived = parseBootstrapSidecarWorkflow(
        readCanonicalRecord(
          archivePath,
          'INTERVENTION_SIDECAR_SESSION_NOT_FOUND',
        ),
      );
      if (canonicalJson(archived) !== canonicalJson(existing)) {
        throw sidecarProjectionConflict(
          'Archived sidecar generation differs from the current tombstone.',
        );
      }
    } else {
      createPrivateFileExclusive(archivePath, serializeRecord(existing));
    }
    replacePrivateFileAtomic(target, serializeRecord(record));
    return record;
  }
  createPrivateFileExclusive(target, serializeRecord(record));
  return record;
}

export function updateBootstrapSidecarSession(
  storageRoot: string,
  parentChangeId: string,
  update: (
    current: PersistedBootstrapSidecarSessionV2,
  ) => PersistedBootstrapSidecarSessionV2,
): PersistedBootstrapSidecarSessionV2 {
  return withPersistenceOperation(
    storageRoot,
    `sidecar-session:${parentChangeId}`,
    () => {
      const current = readPersistedBootstrapSidecarWorkflow(
        storageRoot,
        parentChangeId,
      );
      const next = update(current);
      if (next.recordDigest === current.recordDigest) return current;
      parseBootstrapSidecarWorkflow(next, parentChangeId);
      replacePrivateFileAtomic(
        persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId),
        serializeRecord(next),
      );
      return next;
    },
  );
}
