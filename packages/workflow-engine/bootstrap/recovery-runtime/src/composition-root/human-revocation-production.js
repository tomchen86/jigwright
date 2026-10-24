import { loadCurrentPolicy, readRepositoryOrigin, } from "../runtime/repository-observation/human-revocation.js";
/** Binds real human presence, current Git identity and durable audit/preparation. */
import { createHumanRevocationAuthorizer } from "../application/control-plane/human-revocation.js";
import { discoverRepository } from "../runtime/repository-transaction/git.js";
import { createInteractiveSshSigner } from "../adapters/signing/ssh/maintainer-signer.js";
import { readOptionalPreparation, persistExactPreparation, } from "../runtime/storage-journal/human-revocation-preparation.js";
import { verifyAuthorityAuditEvents, recordAuthorityAuditEvent, } from "../runtime/storage-journal/authority-audit-service.js";
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
import { createHumanResolutionGrantRevoker } from "../application/control-plane/human-resolution-grant-revocation.js";
import { openHumanResolutionRevocationStore } from "../runtime/storage-journal/human-resolution-revocation-store.js";
export const revokeStoredHumanResolutionGrant = createHumanResolutionGrantRevoker(authorizeHumanRevocation, openHumanResolutionRevocationStore);
import { revokeMaintenanceGrantForParent as revokeMaintenance } from "../application/control-plane/intervention-maintenance.js";
export const revokeMaintenanceGrantForParent = revokeMaintenance.bind(undefined, authorizeHumanRevocation);
import { createHumanResolutionGrantVerification } from "../runtime/grants/human-resolution-grant-verification.js";
import { loadMaintainerPolicyForResolution } from "../runtime/repository-observation/human-resolution-grants.js";
export const { verifyHumanResolutionGrantEnvelope, verifyHumanResolutionGrantForRevocation, } = createHumanResolutionGrantVerification({
    createSigner: createInteractiveSshSigner,
    loadMaintainerPolicyForResolution,
});
