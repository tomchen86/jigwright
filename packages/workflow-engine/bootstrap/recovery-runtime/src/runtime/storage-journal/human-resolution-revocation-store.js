import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { withHumanResolutionGrantStoreLock } from "./human-resolution-grant-lock.js";
import { humanResolutionRevocationBinding, } from "../../modules/investigation/domain/human-resolution-grant-contract.js";
import { inspectStoredHumanResolutionGrant, reconcileTerminalHumanResolutionGrantResidual, } from "./human-resolution-grant-store.js";
import { readHumanResolutionJournal } from "../lifecycle-ledgers/human-resolution-journal.js";
import { createPrivateCanonicalJson, fsyncDirectory, privatePathExists, readPrivateCanonicalJson, } from "../journal-primitives/investigation-private-files.js";
import { assertHumanResolutionGrantId, humanResolutionGrantUnsafe, } from "../../modules/investigation/domain/human-resolution-values.js";
import { humanResolutionGrantNotFound } from "../../modules/investigation/domain/human-resolution-values.js";
import { humanResolutionPaths } from "../journal-primitives/investigation-resolution-values.js";
import { readInvestigationSession } from "./investigation-session-records.js";
import { canonicalHumanRevocationAuthorization, } from "../../modules/authority/human-revocation-contract.js";
export const openHumanResolutionRevocationStore = (paths) => ({
    inspect: (grantId) => inspectStoredHumanResolutionGrant(paths, grantId),
    hasPreparedJournal: (grantId) => readHumanResolutionJournal(paths, grantId) !== null,
    binding: (envelopeBytes, grantId) => humanResolutionRevocationBinding(envelopeBytes, grantId, (investigationId) => readInvestigationSession(paths, investigationId)),
    authorizationPath: (grantId) => humanResolutionRevocationAuthorizationPath(paths, grantId),
    publish: (grantId, authorization) => terminallyRevokeHumanResolutionGrant(paths, grantId, authorization),
});
function terminallyRevokeHumanResolutionGrant(paths, grantId, authorization) {
    const stores = humanResolutionPaths(paths);
    return withHumanResolutionGrantStoreLock(paths, stores, () => {
        const terminalPath = path.join(stores.terminal, `${grantId}.json`);
        if (privatePathExists(paths, terminalPath, humanResolutionGrantUnsafe)) {
            const terminal = readPrivateCanonicalJson(paths, terminalPath, humanResolutionGrantUnsafe);
            reconcileTerminalHumanResolutionGrantResidual(paths, stores, grantId, terminal);
            const existing = inspectStoredHumanResolutionGrant(paths, grantId);
            if (existing.state !== 'revoked' ||
                existing.terminalReason !== authorization.payload.reason ||
                existing.revocationAuthorization === undefined ||
                canonicalHumanRevocationAuthorization(existing.revocationAuthorization) !== canonicalHumanRevocationAuthorization(authorization)) {
                throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Human-resolution grant already has a different terminal record.', ExitCode.conflict);
            }
            return existing;
        }
        const terminalEntry = inspectStoredHumanResolutionGrant(paths, grantId);
        if (terminalEntry === null) {
            throw humanResolutionGrantNotFound(grantId);
        }
        if (terminalEntry.state !== 'available' &&
            terminalEntry.state !== 'reserved') {
            throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Only active human-resolution authority can be revoked.', ExitCode.guard);
        }
        if (terminalEntry.state === 'reserved' &&
            readHumanResolutionJournal(paths, grantId) !== null) {
            throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'A prepared human-resolution transaction must be recovered instead of revoked.', ExitCode.conflict);
        }
        const sourceDirectory = terminalEntry.state === 'available'
            ? stores.available
            : stores.reserved;
        const sourcePath = path.join(sourceDirectory, `${grantId}.json`);
        const envelope = JSON.parse(terminalEntry.envelopeBytes);
        const record = {
            schemaVersion: 1,
            state: 'revoked',
            grantId,
            reason: authorization.payload.reason,
            recordedAt: authorization.payload.revokedAt,
            envelope,
            revocationAuthorization: authorization,
        };
        createPrivateCanonicalJson(paths, terminalPath, record, humanResolutionGrantUnsafe, 'HUMAN_RESOLUTION_GRANT_TERMINAL_CONFLICT');
        fs.unlinkSync(sourcePath);
        fsyncDirectory(sourceDirectory);
        return inspectStoredHumanResolutionGrant(paths, grantId);
    }, { targetGrantId: grantId });
}
function humanResolutionRevocationAuthorizationPath(paths, requestedGrantId) {
    const grantId = assertHumanResolutionGrantId(requestedGrantId);
    return path.join(humanResolutionPaths(paths).root, 'grants', 'revocation-authorizations', `${grantId}.json`);
}
