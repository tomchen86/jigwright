/**
 * Validates and reads protected audit anchor receipts and their canonical payloads.
 *
 * Invariants:
 * - Receipts retain exact backend, repository, head, profile, and policy bindings.
 * - Anchor publication filenames and stored content agree on their cryptographic digest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ANCHOR_RECEIPT_KEYS, MAX_ANCHOR_BACKEND_RECEIPT_BYTES, deepFreeze, MAX_METADATA_BYTES, } from "./authority-audit-contracts.js";
import { isPlainRecord, anchorBackendInvalid, hasExactKeys, isCanonicalTimestamp, anchorInvalid, assertDigest, parseJson, sha256Digest, } from "./authority-audit-values.js";
import { readExactPrivateFile } from "./authority-audit-private-files.js";
export function assertAnchorBackend(raw) {
    if (!isPlainRecord(raw) ||
        typeof raw.backendId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.backendId) ||
        typeof raw.publish !== 'function' ||
        typeof raw.verify !== 'function') {
        throw anchorBackendInvalid();
    }
    return raw;
}
export function canonicalAnchorPayload(input) {
    return `${canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-anchor-payload.v1',
        repositoryId: input.repositoryId,
        profile: 'protected',
        policyDigest: input.policyDigest,
        headSequence: input.headSequence,
        headRecordDigest: input.headRecordDigest,
        anchoredAt: input.anchoredAt,
        backendId: input.backendId,
    })}\n`;
}
export function canonicalAnchorReceipt(receipt) {
    return `${canonicalJson(assertAnchorReceipt(receipt))}\n`;
}
function assertAnchorReceipt(raw) {
    if (!isPlainRecord(raw) ||
        !hasExactKeys(raw, ANCHOR_RECEIPT_KEYS) ||
        raw.schemaVersion !== 1 ||
        raw.kind !== 'authority-audit-anchor-receipt.v1' ||
        raw.profile !== 'protected' ||
        !Number.isSafeInteger(raw.headSequence) ||
        typeof raw.headSequence !== 'number' ||
        raw.headSequence < 1 ||
        !isCanonicalTimestamp(raw.anchoredAt) ||
        typeof raw.backendId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.backendId) ||
        typeof raw.backendReceipt !== 'string' ||
        raw.backendReceipt.length === 0 ||
        raw.backendReceipt.trim() !== raw.backendReceipt ||
        raw.backendReceipt.includes('\0') ||
        Buffer.byteLength(raw.backendReceipt) > MAX_ANCHOR_BACKEND_RECEIPT_BYTES) {
        throw anchorInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: 'authority-audit-anchor-receipt.v1',
        repositoryId: assertDigest(raw.repositoryId, anchorInvalid),
        profile: 'protected',
        policyDigest: assertDigest(raw.policyDigest, anchorInvalid),
        headSequence: raw.headSequence,
        headRecordDigest: assertDigest(raw.headRecordDigest, anchorInvalid),
        anchoredAt: raw.anchoredAt,
        backendId: raw.backendId,
        backendReceipt: raw.backendReceipt,
    });
}
function parseAnchorReceipt(raw) {
    const receipt = assertAnchorReceipt(parseJson(raw, anchorInvalid));
    if (raw !== canonicalAnchorReceipt(receipt))
        throw anchorInvalid();
    return receipt;
}
export function readAnchorPublications(paths) {
    const result = [];
    for (const name of fs.readdirSync(paths.anchors).sort()) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined)
            throw anchorInvalid();
        const receiptPath = path.join(paths.anchors, name);
        const bytes = readExactPrivateFile(receiptPath, MAX_METADATA_BYTES, anchorInvalid);
        const receiptDigest = sha256Digest(bytes);
        if (receiptDigest.slice('sha256:'.length) !== match[1]) {
            throw anchorInvalid();
        }
        result.push(deepFreeze({
            receiptDigest,
            receiptPath,
            receipt: parseAnchorReceipt(bytes),
        }));
    }
    return result;
}
export function assertAnchorDirectoryLocal(directory) {
    for (const name of fs.readdirSync(directory)) {
        const match = /^([0-9a-f]{64})\.json$/.exec(name);
        if (match === null || match[1] === undefined)
            throw anchorInvalid();
        const bytes = readExactPrivateFile(path.join(directory, name), MAX_METADATA_BYTES, anchorInvalid);
        if (sha256Digest(bytes).slice('sha256:'.length) !== match[1]) {
            throw anchorInvalid();
        }
        parseAnchorReceipt(bytes);
    }
}
