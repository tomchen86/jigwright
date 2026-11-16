/** Read sidecar metadata and append authorized abandonment without altering historical evidence. */
import fs from 'node:fs';

import type { Sha256Digest } from '../../modules/authority/intervention-control.ts';
import type {
  PersistedBootstrapSidecarSessionV2,
  PersistedInterventionRecord,
} from './intervention-persistence-contracts.ts';
import {
  parseBootstrapSidecarWorkflow,
  sidecarProjectionConflict,
  appendBootstrapSidecarEvent,
  transitionBootstrapMaintenanceWorkflow,
  createBootstrapMaintenanceWorkflow,
  sidecarMatchesIntervention,
} from './intervention-sidecar-records.ts';
import {
  readCanonicalRecord,
  createPrivateFileExclusive,
  replacePrivateFileAtomic,
} from './intervention-persistence-files.ts';
import { persistedBootstrapSidecarSessionPath } from './intervention-persistence-paths.ts';
import {
  assertDigest,
  exactIso,
  canonicalDigest,
  withRecordDigest,
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
    createMissingBootstrapSidecar(storageRoot, input.intervention);
  }
  return updateBootstrapSidecarSession(
    storageRoot,
    input.parentChangeId,
    (current) => {
      if (!sidecarMatchesIntervention(current, input.intervention)) {
        throw sidecarProjectionConflict(
          'Sidecar identity differs from the intervention being abandoned.',
        );
      }
      if (current.state === 'abandoned') return current;
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

function createMissingBootstrapSidecar(
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
  createPrivateFileExclusive(target, serializeRecord(record));
  return record;
}

function updateBootstrapSidecarSession(
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
