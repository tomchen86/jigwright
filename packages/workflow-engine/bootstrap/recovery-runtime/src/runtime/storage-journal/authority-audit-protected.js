/**
 * Configures protected audit storage and performs anchored publication or authorized destruction.
 *
 * Invariants:
 * - Anchor and destruction operations retain exact current-head, backend, and grant bindings.
 * - Destruction publishes its tombstone before pruning and preserves grant replay detection.
 *
 * Depends on: audit layout, anchor and destruction records, maintenance, and ledger locks.
 * Failure modes: unverifiable anchors, replayed destruction grants, or deletion without a durable tombstone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { deepFreeze, FILESYSTEM_WORM_RECEIPT_KEYS, MAX_METADATA_BYTES, MAX_ANCHOR_BACKEND_RECEIPT_BYTES, } from "./authority-audit-contracts.js";
import { prepareLedger, assertProtectedBackendRoot, canonicalDestructionPublicKey, canonicalProtectedConfiguration, readProtectedConfiguration, ensureFilesystemWormBackend, authorityAuditPolicyDigest, } from "./authority-audit-layout.js";
import { developmentProfile, sha256Digest, protectedConfigurationMismatch, protectedConfigurationInvalid, anchorBackendInvalid, isPlainRecord, hasExactKeys, assertDigest, anchorInvalid, assertMaintenanceTimestamp, anchorBackendRequired, destructionGrantInvalid, destructionGrantConsumed, destructionTombstoneInvalid, destructionGrantBindingInvalid, } from "./authority-audit-values.js";
import { writeExclusivePrivateFile, fsyncDirectory, recoverPrivateFilePublications, publishImmutableObject, readExactPrivateFile, } from "./authority-audit-private-files.js";
import { assertAnchorBackend, canonicalAnchorPayload, canonicalAnchorReceipt, readAnchorPublications, } from "./authority-audit-anchor-records.js";
import { withLedgerLock } from "./authority-audit-locks.js";
import { recoverAuditMaintenance, protectedCheckpointDigestHistory, readRetentionCheckpoint, checkpointDigest, createRetentionCheckpoint, executeAuditMaintenance, createMaintenanceJournal, compactionResult, } from "./authority-audit-maintenance.js";
import { recoverRecordPublications, scanLedgerUnderLock, } from "./authority-audit-record-publication.js";
import { assertAuditDestructionGrantEnvelope, canonicalAuditDestructionGrantPayload, assertDestructionGrantTime, readDestructionTombstones, parseDestructionTombstone, canonicalTombstone, } from "./authority-audit-destruction-records.js";
export function configureProtectedAuthorityAuditLedger(scope, input) {
    const prepared = prepareLedger({ ...scope, profile: 'protected' });
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    const backendRoot = assertProtectedBackendRoot(input.backendRoot, prepared.scope);
    const destructionPublicKeyPem = canonicalDestructionPublicKey(input.destructionPublicKeyPem);
    const core = {
        schemaVersion: 1,
        kind: 'authority-audit-protected-configuration.v1',
        repositoryId: prepared.scope.repositoryId,
        backendId: 'filesystem-worm.v1',
        backendRoot,
        destructionPublicKeyPem,
        destructionPublicKeyDigest: sha256Digest(destructionPublicKeyPem),
    };
    const configuration = deepFreeze({
        ...core,
        configurationDigest: sha256Digest(canonicalJson(core)),
    });
    const bytes = canonicalProtectedConfiguration(configuration);
    const existing = fs.lstatSync(prepared.paths.protectedConfiguration, {
        throwIfNoEntry: false,
    });
    if (existing !== undefined) {
        const stored = readProtectedConfiguration(prepared.paths);
        if (canonicalProtectedConfiguration(stored) !== bytes) {
            throw protectedConfigurationMismatch();
        }
        return stored;
    }
    if (fs.readdirSync(prepared.paths.events).length > 0 ||
        fs.readdirSync(prepared.paths.records).length > 0 ||
        fs.readdirSync(prepared.paths.anchors).length > 0 ||
        fs.readdirSync(prepared.paths.tombstones).length > 0 ||
        fs.lstatSync(prepared.paths.retentionCheckpoint, {
            throwIfNoEntry: false,
        }) ||
        fs.lstatSync(prepared.paths.maintenanceJournal, { throwIfNoEntry: false })) {
        throw protectedConfigurationMismatch();
    }
    writeExclusivePrivateFile(prepared.paths.protectedConfiguration, bytes, protectedConfigurationInvalid);
    fsyncDirectory(prepared.paths.metadata);
    return readProtectedConfiguration(prepared.paths);
}
export function readProtectedAuthorityAuditConfiguration(scope) {
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return readProtectedConfiguration(prepared.paths);
}
export function createPinnedAuthorityAuditAnchorBackend(scope) {
    const configuration = readProtectedAuthorityAuditConfiguration(scope);
    const backendPaths = ensureFilesystemWormBackend(configuration);
    return Object.freeze({
        backendId: configuration.backendId,
        publish(canonicalPayload) {
            const payloadDigest = sha256Digest(canonicalPayload);
            const objectName = `${payloadDigest.slice('sha256:'.length)}.anchor`;
            recoverPrivateFilePublications(backendPaths.anchors, (name) => /^[0-9a-f]{64}\.anchor$/.test(name), anchorBackendInvalid);
            publishImmutableObject(path.join(backendPaths.anchors, objectName), canonicalPayload, anchorBackendInvalid);
            fsyncDirectory(backendPaths.anchors);
            return canonicalJson({
                schemaVersion: 1,
                kind: 'authority-audit-filesystem-worm-receipt.v1',
                repositoryId: configuration.repositoryId,
                backendId: configuration.backendId,
                payloadDigest,
                objectName,
            });
        },
        verify(canonicalPayload, backendReceipt) {
            try {
                recoverPrivateFilePublications(backendPaths.anchors, (name) => /^[0-9a-f]{64}\.anchor$/.test(name), anchorBackendInvalid);
                const raw = JSON.parse(backendReceipt);
                if (!isPlainRecord(raw) ||
                    !hasExactKeys(raw, FILESYSTEM_WORM_RECEIPT_KEYS) ||
                    raw.schemaVersion !== 1 ||
                    raw.kind !== 'authority-audit-filesystem-worm-receipt.v1' ||
                    raw.repositoryId !== configuration.repositoryId ||
                    raw.backendId !== configuration.backendId ||
                    typeof raw.objectName !== 'string' ||
                    !/^[0-9a-f]{64}\.anchor$/.test(raw.objectName) ||
                    backendReceipt !== canonicalJson(raw)) {
                    return false;
                }
                const payloadDigest = assertDigest(raw.payloadDigest, anchorInvalid);
                if (payloadDigest !== sha256Digest(canonicalPayload) ||
                    raw.objectName !== `${payloadDigest.slice('sha256:'.length)}.anchor`) {
                    return false;
                }
                return (readExactPrivateFile(path.join(backendPaths.anchors, raw.objectName), MAX_METADATA_BYTES, anchorBackendInvalid) === canonicalPayload);
            }
            catch {
                return false;
            }
        },
    });
}
export function createPinnedAuditDestructionSignatureVerifier(scope) {
    const configuration = readProtectedAuthorityAuditConfiguration(scope);
    const publicKey = crypto.createPublicKey(configuration.destructionPublicKeyPem);
    return (input) => {
        try {
            return crypto.verify(null, Buffer.from(input.payload), publicKey, Buffer.from(input.signature, 'base64'));
        }
        catch {
            return false;
        }
    };
}
export function anchorProtectedAuthorityAuditLedger(scope, input) {
    const anchoredAt = assertMaintenanceTimestamp(input.anchoredAt);
    const backend = assertAnchorBackend(input.backend);
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const scan = scanLedgerUnderLock(prepared);
        if (scan.headRecordDigest === null || scan.headSequence < 1) {
            throw anchorInvalid();
        }
        const payload = canonicalAnchorPayload({
            repositoryId: prepared.scope.repositoryId,
            policyDigest: authorityAuditPolicyDigest('protected'),
            headSequence: scan.headSequence,
            headRecordDigest: scan.headRecordDigest,
            anchoredAt,
            backendId: backend.backendId,
        });
        const backendReceipt = backend.publish(payload);
        if (typeof backendReceipt !== 'string' ||
            backendReceipt.length === 0 ||
            Buffer.byteLength(backendReceipt) > MAX_ANCHOR_BACKEND_RECEIPT_BYTES ||
            !backend.verify(payload, backendReceipt)) {
            throw anchorBackendInvalid();
        }
        const receipt = deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-anchor-receipt.v1',
            repositoryId: prepared.scope.repositoryId,
            profile: 'protected',
            policyDigest: authorityAuditPolicyDigest('protected'),
            headSequence: scan.headSequence,
            headRecordDigest: scan.headRecordDigest,
            anchoredAt,
            backendId: backend.backendId,
            backendReceipt,
        });
        const bytes = canonicalAnchorReceipt(receipt);
        const receiptDigest = sha256Digest(bytes);
        const receiptPath = path.join(prepared.paths.anchors, `${receiptDigest.slice('sha256:'.length)}.json`);
        publishImmutableObject(receiptPath, bytes, anchorInvalid);
        fsyncDirectory(prepared.paths.anchors);
        return deepFreeze({ receiptDigest, receiptPath, receipt });
    });
}
export function verifyProtectedAuthorityAuditAnchors(scope, rawBackends) {
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    const backends = new Map();
    for (const rawBackend of rawBackends) {
        const backend = assertAnchorBackend(rawBackend);
        if (backends.has(backend.backendId))
            throw anchorBackendInvalid();
        backends.set(backend.backendId, backend);
    }
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const scan = scanLedgerUnderLock(prepared);
        const bySequence = new Map(scan.records.map((entry) => [entry.record.sequence, entry.recordDigest]));
        const prunedBySequence = protectedCheckpointDigestHistory(prepared.paths);
        const receipts = readAnchorPublications(prepared.paths);
        for (const publication of receipts) {
            const backend = backends.get(publication.receipt.backendId);
            if (backend === undefined)
                throw anchorBackendRequired();
            const payload = canonicalAnchorPayload({
                repositoryId: publication.receipt.repositoryId,
                policyDigest: publication.receipt.policyDigest,
                headSequence: publication.receipt.headSequence,
                headRecordDigest: publication.receipt.headRecordDigest,
                anchoredAt: publication.receipt.anchoredAt,
                backendId: publication.receipt.backendId,
            });
            if (!backend.verify(payload, publication.receipt.backendReceipt)) {
                throw anchorInvalid();
            }
            const retainedDigest = bySequence.get(publication.receipt.headSequence);
            if (publication.receipt.repositoryId !== prepared.scope.repositoryId ||
                publication.receipt.policyDigest !==
                    authorityAuditPolicyDigest('protected') ||
                publication.receipt.headSequence > scan.headSequence ||
                (retainedDigest !== undefined &&
                    retainedDigest !== publication.receipt.headRecordDigest) ||
                (retainedDigest === undefined &&
                    prunedBySequence.get(publication.receipt.headSequence) !==
                        publication.receipt.headRecordDigest)) {
                throw anchorInvalid();
            }
        }
        return deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-anchor-verification.v1',
            repositoryId: prepared.scope.repositoryId,
            ok: true,
            currentHeadAnchored: receipts.some(({ receipt }) => receipt.headSequence === scan.headSequence &&
                receipt.headRecordDigest === scan.headRecordDigest),
            receipts,
        });
    });
}
export function destroyProtectedAuthorityAuditLedger(scope, rawEnvelope, input, hooks = {}) {
    const now = assertMaintenanceTimestamp(input.now);
    const envelope = assertAuditDestructionGrantEnvelope(rawEnvelope);
    if (typeof input.verifyHumanSignature !== 'function') {
        throw destructionGrantInvalid();
    }
    const canonicalPayload = canonicalAuditDestructionGrantPayload(envelope.payload);
    if (!input.verifyHumanSignature({
        domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
        payload: canonicalPayload,
        signerIdentity: envelope.payload.signerIdentity,
        signature: envelope.signature,
    })) {
        throw destructionGrantInvalid();
    }
    assertDestructionGrantTime(envelope.payload, now);
    const prepared = prepareLedger(scope);
    if (prepared.profile !== 'protected')
        throw developmentProfile();
    return withLedgerLock(prepared.paths, prepared.scope.repositoryId, () => {
        recoverAuditMaintenance(prepared.paths, prepared.profile);
        recoverRecordPublications(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const payload = envelope.payload;
        const priorGrantUse = readDestructionTombstones(prepared.paths).find(({ grantEnvelope }) => grantEnvelope.payload.grantId === payload.grantId);
        if (priorGrantUse !== undefined) {
            throw destructionGrantConsumed();
        }
        const grantDigest = sha256Digest(`${canonicalJson(envelope)}\n`);
        const tombstonePath = path.join(prepared.paths.tombstones, `${grantDigest.slice('sha256:'.length)}.json`);
        if (fs.lstatSync(tombstonePath, { throwIfNoEntry: false })) {
            // Validate before reporting consumption so a forged/tampered marker can
            // never turn into a benign replay response.
            const tombstone = parseDestructionTombstone(readExactPrivateFile(tombstonePath, MAX_METADATA_BYTES, destructionTombstoneInvalid));
            if (tombstone.grantDigest !== grantDigest) {
                throw destructionTombstoneInvalid();
            }
            throw destructionGrantConsumed();
        }
        const scan = scanLedgerUnderLock(prepared);
        if (payload.repositoryId !== prepared.scope.repositoryId ||
            payload.expectedHeadSequence !== scan.headSequence ||
            payload.expectedHeadRecordDigest !== scan.headRecordDigest ||
            payload.throughSequence <= scan.prunedRecordCount ||
            payload.throughSequence > scan.headSequence) {
            throw destructionGrantBindingInvalid();
        }
        const target = scan.records.find(({ record }) => record.sequence === payload.throughSequence);
        if (target === undefined ||
            target.recordDigest !== payload.throughRecordDigest) {
            throw destructionGrantBindingInvalid();
        }
        const previousCheckpoint = readRetentionCheckpoint(prepared.paths, prepared.scope.repositoryId, prepared.profile);
        const previousCheckpointDigest = checkpointDigest(previousCheckpoint);
        const tombstone = deepFreeze({
            schemaVersion: 1,
            kind: 'authority-audit-destruction-tombstone.v1',
            repositoryId: prepared.scope.repositoryId,
            grantDigest,
            grantEnvelope: envelope,
            signerIdentity: payload.signerIdentity,
            expectedHeadSequence: payload.expectedHeadSequence,
            expectedHeadRecordDigest: payload.expectedHeadRecordDigest,
            destroyedThroughSequence: payload.throughSequence,
            destroyedThroughRecordDigest: payload.throughRecordDigest,
            destroyedAt: now,
            reasonDigest: payload.reasonDigest,
            remoteAnchorDisposition: payload.remoteAnchorDisposition,
            previousCheckpointDigest,
        });
        const tombstoneDigest = sha256Digest(canonicalTombstone(tombstone));
        const checkpoint = createRetentionCheckpoint({
            repositoryId: prepared.scope.repositoryId,
            profile: 'protected',
            prunedThroughSequence: target.record.sequence,
            prunedThroughRecordDigest: target.recordDigest,
            prunedAt: now,
            reason: 'protected-destruction',
            grantDigest,
            tombstoneDigest,
            previousCheckpoint,
        });
        executeAuditMaintenance(prepared.paths, createMaintenanceJournal(checkpoint, tombstone), hooks);
        return compactionResult('protected', payload.throughSequence -
            (previousCheckpoint?.prunedThroughSequence ?? 0), scan.recordCount -
            (payload.throughSequence -
                (previousCheckpoint?.prunedThroughSequence ?? 0)), checkpoint);
    });
}
