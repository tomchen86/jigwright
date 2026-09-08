/**
 * Exposes investigation storage APIs and authorizes durable human-resolution grant revocation.
 *
 * Invariants:
 * - Public entry points retain the same types, errors, and durable record identities.
 * - Revocation binds the exact grant and session before its audited terminal transition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { authorizeHumanRevocation, canonicalHumanRevocationAuthorization, digestHumanRevocationSubject, } from "../../application/control-plane/human-revocation.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { deriveAuthorityAuditRepositoryId } from "./authority-audit-ledger.js";
import { withHumanResolutionGrantStoreLock } from "./human-resolution-grant-lock.js";
import { inspectStoredHumanResolutionGrant, reconcileTerminalHumanResolutionGrantResidual, } from "./human-resolution-grant-store.js";
import { readHumanResolutionJournal } from "./human-resolution-journal.js";
import { createPrivateCanonicalJson, fsyncDirectory, privatePathExists, readPrivateCanonicalJson, } from "./investigation-private-files.js";
import { assertHumanResolutionGrantId, humanResolutionGrantNotFound, humanResolutionGrantUnsafe, humanResolutionPaths, } from "./investigation-resolution-values.js";
import { readInvestigationSession } from "./investigation-session-records.js";
import { isRecord } from "./investigation-store-values.js";
export { archiveHumanResolutionSingleton, quarantineUnsafeCurrentInvestigationRef, quarantineUnsafeHumanResolutionRef, quarantineUnsafeInvestigationStartReservation, } from "./human-resolution-archive.js";
export { advertisedHumanResolutions, assertHumanResolutionConsequences, assertHumanResolutionDecision, createHumanResolutionNode, createInvestigationHumanActionBlocker, humanResolutionDecisionSchemaDigest, investigationCurrentRefDigest, investigationResolutionStateDigest, } from "./human-resolution-contract.js";
export { inspectInterruptedHumanResolutionGrantPublications, quarantineInterruptedHumanResolutionGrantPublication, } from "./human-resolution-grant-publication.js";
export { inspectStoredHumanResolutionGrants, readAvailableHumanResolutionGrant, readReservedHumanResolutionGrant, readTerminalHumanResolutionGrant, reserveHumanResolutionGrant, rollbackAvailableHumanResolutionGrant, storeAvailableHumanResolutionGrant, terminalizeHumanResolutionGrant, withHumanResolutionGrantExecution, } from "./human-resolution-grant-store.js";
export { createHumanResolutionJournal } from "./human-resolution-journal-contract.js";
export { assertHumanResolutionLifecycleBarrier, readActiveHumanResolutionJournal, readHumanResolutionArchive, readHumanResolutionJournal, reclaimHumanResolutionJournalTemporaries, writeHumanResolutionArchive, writeHumanResolutionJournal, writeHumanResolutionReceipt, } from "./human-resolution-journal.js";
export { compareAndSwapHumanResolutionHead, readHumanResolutionHead, readHumanResolutionNode, writeHumanResolutionNode, } from "./human-resolution-nodes.js";
export { inspectInvestigationQuarantineState, inspectInvestigationResolutionState, } from "./human-resolution-state.js";
export { assertInvestigationCheckpointEnvelope, assertInvestigationScanSaturationAcceptanceEnvelope, checkpointContributionDigest, checkpointEnvelopeDigest, scanSaturationAcceptanceEnvelopeDigest, } from "./investigation-checkpoint-contract.js";
export { assertPrivateInvestigationDirectory, createPrivateCanonicalJson, ensurePrivateInvestigationDirectory, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
export { deriveInvestigationSessionState, investigationCheckpointId, } from "./investigation-session-contract.js";
export { compareAndSwapCurrentInvestigationRef, compareAndSwapInvestigationSession, createCurrentInvestigationRef, createInvestigationId, createInvestigationSessionRecord, investigationSessionExists, readCurrentInvestigationRef, readInvestigationSession, } from "./investigation-session-records.js";
export { listProviderInvocationLifecycleProjections, readProviderInvocationLifecycleProjection, scanProviderInvocationLifecycles, } from "./provider-invocation-lifecycle.js";
export { assertProviderRuntimeDurableAuthorities, assertProviderRuntimeTerminalAuthorityPreflight, readAcceptedProviderInvocationRuntimeReceiptAuthority, } from "./provider-runtime-authority.js";
export function revokeStoredHumanResolutionGrant(paths, cwd, requestedGrantId, options) {
    const grantId = assertHumanResolutionGrantId(requestedGrantId);
    const current = inspectStoredHumanResolutionGrant(paths, grantId);
    if (current === null)
        throw humanResolutionGrantNotFound(grantId);
    if (current.state === 'consumed') {
        throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Consumed human-resolution authority cannot be revoked.', ExitCode.guard);
    }
    if (current.state === 'reserved' &&
        readHumanResolutionJournal(paths, grantId) !== null) {
        throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'A prepared human-resolution transaction must be recovered instead of revoked.', ExitCode.conflict);
    }
    const binding = humanResolutionRevocationBinding(paths, current.envelopeBytes, grantId);
    const authorization = authorizeHumanRevocation(cwd, binding, options, humanResolutionRevocationAuthorizationPath(paths, grantId), current.revocationAuthorization ?? null);
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
function humanResolutionRevocationBinding(paths, envelopeBytes, grantId) {
    let envelope;
    try {
        envelope = JSON.parse(envelopeBytes);
    }
    catch {
        throw humanResolutionGrantUnsafe();
    }
    if (!isRecord(envelope) || !isRecord(envelope.payload)) {
        throw humanResolutionGrantUnsafe();
    }
    const payload = envelope.payload;
    if (payload.grantId !== grantId ||
        typeof payload.repositoryId !== 'string' ||
        typeof payload.repositoryOrigin !== 'string' ||
        !isRecord(payload.target) ||
        typeof payload.target.changeId !== 'string' ||
        typeof payload.target.workflowId !== 'string') {
        throw humanResolutionGrantUnsafe();
    }
    const session = readInvestigationSession(paths, payload.target.workflowId);
    if (session.changeId !== payload.target.changeId ||
        (session.mandateBinding !== undefined &&
            session.mandateBinding.changeId !== payload.target.changeId)) {
        throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Human-resolution revocation session binding is unavailable or different.', ExitCode.guard);
    }
    return {
        subjectKind: 'human-resolution-grant',
        grantId,
        grantDigest: digestHumanRevocationSubject(envelopeBytes),
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        changeId: payload.target.changeId,
        taskId: session.mandateBinding?.mandateTaskId ?? null,
        workflowId: payload.target.workflowId,
        audit: session.mandateBinding
            ? {
                externalAuditRoot: session.mandateBinding.externalAuditRoot,
                repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
            }
            : null,
    };
}
