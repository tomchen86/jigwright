import {
  loadCurrentPolicy,
  readRepositoryOrigin,
} from '../runtime/repository-observation/human-revocation.ts';
/** Binds real human presence, current Git identity and durable audit/preparation. */
import { createHumanRevocationAuthorizer } from '../application/control-plane/human-revocation.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  readOptionalPreparation,
  persistExactPreparation,
} from '../runtime/storage-journal/human-revocation-preparation.ts';
import {
  verifyAuthorityAuditEvents,
  recordAuthorityAuditEvent,
} from '../runtime/storage-journal/authority-audit-service.ts';
export const authorizeHumanRevocation = createHumanRevocationAuthorizer({
  now: () => new Date(),
  discoverRepository,
  loadCurrentPolicy,
  readRepositoryOrigin,
  createSigner: createInteractiveSshSigner,
  readOptionalPreparation,
  persistExactPreparation,
  verifyAuthorityAuditEvents,
  recordAuthorityAuditEvent,
});

import { createHumanResolutionGrantRevoker } from '../application/control-plane/human-resolution-grant-revocation.ts';
import { openHumanResolutionRevocationStore } from '../runtime/storage-journal/human-resolution-revocation-store.ts';
export const revokeStoredHumanResolutionGrant =
  createHumanResolutionGrantRevoker(
    authorizeHumanRevocation,
    openHumanResolutionRevocationStore,
  );
import {
  readMaintenanceGrantForParent,
  revokeMaintenanceGrantForParent as revokeMaintenance,
} from '../application/control-plane/intervention-maintenance.ts';
export const revokeMaintenanceGrantForParent = revokeMaintenance.bind(
  undefined,
  authorizeHumanRevocation,
);

import { createInterventionMetadataDisposition } from '../application/control-plane/intervention-metadata-disposition.ts';
import { runtimePaths } from '../runtime/session-workspace/workflow-session-records.ts';
import {
  abandonPersistedIntervention,
  assertPersistedInterventionAbandonable,
} from '../runtime/storage-journal/intervention-abandonment.ts';
import { readLocalEngineBinding } from '../runtime/storage-journal/intervention-parent-binding.ts';
import { readPersistedIntervention } from '../runtime/storage-journal/intervention-plan-store.ts';
export const interventionMetadataDisposition =
  createInterventionMetadataDisposition({
    discoverRepository,
    runtimePaths,
    readMaintenanceGrantForParent,
    assertPersistedInterventionAbandonable,
    verifyAuthorityAuditEvents,
    revokeMaintenanceGrantForParent: revokeMaintenance,
    authorizeHumanRevocation,
    abandonPersistedIntervention,
    readPersistedIntervention,
    readLocalEngineBinding,
  });

import { createHumanResolutionGrantVerification } from '../runtime/grants/human-resolution-grant-verification.ts';
import { loadMaintainerPolicyForResolution } from '../runtime/repository-observation/human-resolution-grants.ts';
export const {
  verifyHumanResolutionGrantEnvelope,
  verifyHumanResolutionGrantForRevocation,
} = createHumanResolutionGrantVerification({
  createSigner: createInteractiveSshSigner,
  loadMaintainerPolicyForResolution,
});
