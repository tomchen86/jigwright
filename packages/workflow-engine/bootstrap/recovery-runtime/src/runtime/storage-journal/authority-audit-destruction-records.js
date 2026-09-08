/**
 * Validates destruction grants and reads the canonical tombstones they authorize.
 *
 * Invariants:
 * - Grant lifetime, single-use intent, target prefix, and signed payload bytes remain exact.
 * - Tombstones retain the full grant and predecessor checkpoint needed for replay and recovery.
 *
 * Depends on: audit contracts, digest validation, and private tombstone files.
 * Failure modes: expired or replayed authority accepted, or unverifiable audit destruction history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { DESTRUCTION_PAYLOAD_KEYS, UUID_V4, AUDIT_DESTRUCTION_GRANT_MAX_TTL_MS, deepFreeze, DESTRUCTION_ENVELOPE_KEYS, MAX_DESTRUCTION_SIGNATURE_BYTES, DESTRUCTION_TOMBSTONE_KEYS, MAX_METADATA_BYTES, } from "./authority-audit-contracts.js";
import { isPlainRecord, hasExactKeys, isCanonicalTimestamp, destructionGrantInvalid, assertDigest, destructionGrantExpired, destructionTombstoneInvalid, assertNullableDigest, sha256Digest, parseJson, } from "./authority-audit-values.js";
import { readExactPrivateFile } from "./authority-audit-private-files.js";
export function canonicalAuditDestructionGrantPayload(rawPayload) {
    return `${canonicalJson(assertAuditDestructionGrantPayload(rawPayload))}\n`;
}
export function canonicalAuditDestructionGrantEnvelope(rawEnvelope) {
    return `${canonicalJson(assertAuditDestructionGrantEnvelope(rawEnvelope))}\n`;
}
function assertAuditDestructionGrantPayload(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_PAYLOAD_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'audit-destruction-grant.v1' ||
        raw.domain !== 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1' ||
        typeof raw.grantId !== 'string' ||
        !UUID_V4.test(raw.grantId) ||
        raw.profile !== 'protected' ||
        !Number.isSafeInteger(raw.expectedHeadSequence) ||
        typeof raw.expectedHeadSequence !== 'number' ||
        raw.expectedHeadSequence < 1 ||
        !Number.isSafeInteger(raw.throughSequence) ||
        typeof raw.throughSequence !== 'number' ||
        raw.throughSequence < 1 ||
        raw.throughSequence > raw.expectedHeadSequence ||
        !isCanonicalTimestamp(raw.issuedAt) ||
        !isCanonicalTimestamp(raw.expiresAt) ||
        Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt) ||
        Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) >
            AUDIT_DESTRUCTION_GRANT_MAX_TTL_MS ||
        raw.uses !== 1 ||
        typeof raw.signerIdentity !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(raw.signerIdentity) ||
        (raw.remoteAnchorDisposition !== 'retain' &&
            raw.remoteAnchorDisposition !== 'deletion-authorized')) {
        throw destructionGrantInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'audit-destruction-grant.v1',
        domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
        grantId: raw.grantId,
        repositoryId: assertDigest(raw.repositoryId, destructionGrantInvalid),
        profile: 'protected',
        expectedHeadSequence: raw.expectedHeadSequence,
        expectedHeadRecordDigest: assertDigest(raw.expectedHeadRecordDigest, destructionGrantInvalid),
        throughSequence: raw.throughSequence,
        throughRecordDigest: assertDigest(raw.throughRecordDigest, destructionGrantInvalid),
        issuedAt: raw.issuedAt,
        expiresAt: raw.expiresAt,
        uses: 1,
        signerIdentity: raw.signerIdentity,
        reasonDigest: assertDigest(raw.reasonDigest, destructionGrantInvalid),
        remoteAnchorDisposition: raw.remoteAnchorDisposition,
    });
}
export function assertAuditDestructionGrantEnvelope(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_ENVELOPE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'audit-destruction-grant-envelope.v1' ||
        typeof raw.signature !== 'string' ||
        raw.signature.length === 0 ||
        raw.signature.trim() !== raw.signature ||
        raw.signature.includes('\0') ||
        Buffer.byteLength(raw.signature) > MAX_DESTRUCTION_SIGNATURE_BYTES) {
        throw destructionGrantInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'audit-destruction-grant-envelope.v1',
        payload: assertAuditDestructionGrantPayload(raw.payload),
        signature: raw.signature,
    });
}
export function assertDestructionGrantTime(payload, now) {
    const observed = Date.parse(now);
    if (observed < Date.parse(payload.issuedAt) ||
        observed >= Date.parse(payload.expiresAt)) {
        throw destructionGrantExpired();
    }
}
export function assertDestructionTombstone(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, DESTRUCTION_TOMBSTONE_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-destruction-tombstone.v1' ||
        !Number.isSafeInteger(raw.expectedHeadSequence) ||
        typeof raw.expectedHeadSequence !== 'number' ||
        raw.expectedHeadSequence < 1 ||
        !Number.isSafeInteger(raw.destroyedThroughSequence) ||
        typeof raw.destroyedThroughSequence !== 'number' ||
        raw.destroyedThroughSequence < 1 ||
        raw.destroyedThroughSequence > raw.expectedHeadSequence ||
        !isCanonicalTimestamp(raw.destroyedAt) ||
        typeof raw.signerIdentity !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(raw.signerIdentity) ||
        (raw.remoteAnchorDisposition !== 'retain' &&
            raw.remoteAnchorDisposition !== 'deletion-authorized')) {
        throw destructionTombstoneInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-destruction-tombstone.v1',
        repositoryId: assertDigest(raw.repositoryId, destructionTombstoneInvalid),
        grantDigest: assertDigest(raw.grantDigest, destructionTombstoneInvalid),
        grantEnvelope: assertAuditDestructionGrantEnvelope(raw.grantEnvelope),
        signerIdentity: raw.signerIdentity,
        expectedHeadSequence: raw.expectedHeadSequence,
        expectedHeadRecordDigest: assertDigest(raw.expectedHeadRecordDigest, destructionTombstoneInvalid),
        destroyedThroughSequence: raw.destroyedThroughSequence,
        destroyedThroughRecordDigest: assertDigest(raw.destroyedThroughRecordDigest, destructionTombstoneInvalid),
        destroyedAt: raw.destroyedAt,
        reasonDigest: assertDigest(raw.reasonDigest, destructionTombstoneInvalid),
        remoteAnchorDisposition: raw.remoteAnchorDisposition,
        previousCheckpointDigest: assertNullableDigest(raw.previousCheckpointDigest, destructionTombstoneInvalid),
    });
}
export function canonicalTombstone(tombstone) {
    const checked = assertDestructionTombstone(tombstone);
    if (checked.grantDigest !==
        sha256Digest(`${canonicalJson(checked.grantEnvelope)}\n`) ||
        checked.grantEnvelope.payload.repositoryId !== checked.repositoryId ||
        checked.grantEnvelope.payload.signerIdentity !== checked.signerIdentity ||
        checked.grantEnvelope.payload.expectedHeadSequence !==
            checked.expectedHeadSequence ||
        checked.grantEnvelope.payload.expectedHeadRecordDigest !==
            checked.expectedHeadRecordDigest ||
        checked.grantEnvelope.payload.throughSequence !==
            checked.destroyedThroughSequence ||
        checked.grantEnvelope.payload.throughRecordDigest !==
            checked.destroyedThroughRecordDigest ||
        checked.grantEnvelope.payload.reasonDigest !== checked.reasonDigest ||
        checked.grantEnvelope.payload.remoteAnchorDisposition !==
            checked.remoteAnchorDisposition ||
        Date.parse(checked.destroyedAt) <
            Date.parse(checked.grantEnvelope.payload.issuedAt) ||
        Date.parse(checked.destroyedAt) >=
            Date.parse(checked.grantEnvelope.payload.expiresAt)) {
        throw destructionTombstoneInvalid();
    }
    return `${canonicalJson(checked)}\n`;
}
export function parseDestructionTombstone(raw) {
    const tombstone = assertDestructionTombstone(parseJson(raw, destructionTombstoneInvalid));
    if (raw !== canonicalTombstone(tombstone)) {
        throw destructionTombstoneInvalid();
    }
    return tombstone;
}
export function assertTombstoneDirectoryLocal(directory) {
    for (const name of fs.readdirSync(directory)) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined) {
            throw destructionTombstoneInvalid();
        }
        const tombstone = parseDestructionTombstone(readExactPrivateFile(path.join(directory, name), MAX_METADATA_BYTES, destructionTombstoneInvalid));
        if (tombstone.grantDigest.slice('sha256:'.length) !== match[1]) {
            throw destructionTombstoneInvalid();
        }
    }
}
export function readDestructionTombstones(paths) {
    return fs.readdirSync(paths.tombstones).map((name) => {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined) {
            throw destructionTombstoneInvalid();
        }
        const tombstone = parseDestructionTombstone(readExactPrivateFile(path.join(paths.tombstones, name), MAX_METADATA_BYTES, destructionTombstoneInvalid));
        if (tombstone.grantDigest.slice('sha256:'.length) !== match[1]) {
            throw destructionTombstoneInvalid();
        }
        return tombstone;
    });
}
