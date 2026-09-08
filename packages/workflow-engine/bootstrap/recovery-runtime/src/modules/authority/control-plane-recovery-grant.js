import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
import { createControlPlaneRecoveryGrantRecords } from "./control-plane-recovery-grant-records.js";
function boundControlPlaneRecoveryGrantRecords() {
    return createControlPlaneRecoveryGrantRecords({
        exactIso,
        CONTROL_PLANE_RECOVERY_GRANT_TTL_MS,
        isRecord,
        hasExactKeys,
        isNonEmpty,
        recoveryError,
        HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
        exactDate,
        deepFreeze,
        canonicalDigest,
        assertDigest,
        assertIdentifier,
        PAYLOAD_KEYS,
        RECOVERY_GRANT_ID,
        isDigest,
        isExactAbsolutePath,
    });
}
import { createControlPlaneRecoveryGrantStorage } from "./control-plane-recovery-grant-storage.js";
function boundControlPlaneRecoveryGrantStorage() {
    return createControlPlaneRecoveryGrantStorage({
        recoveryError,
        PRIVATE_DIRECTORY_MODE,
        recoveryStateUnsafe,
        isNodeCode,
        RECOVERY_GRANT_ID,
        rawDigest,
        isRecord,
        recoveryRecordCorrupt,
        PRIVATE_FILE_MODE,
        MAX_RECORD_BYTES,
        isWorkflowCode,
        serializeRecord,
        RECOVERY_RECORD_TEMPORARY,
        RECOVERY_RECORD_NAME,
        verifyRecordDigest,
    });
}
export const HARNESS_RECOVERY_SIGNATURE_NAMESPACE = 'HARNESS_RECOVERY_GRANT_V1';
export const CONTROL_PLANE_RECOVERY_GRANT_TTL_MS = 5 * 60 * 1000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECOVERY_GRANT_ID = /^recovery-[0-9a-f]{64}$/;
const RECOVERY_RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const RECOVERY_RECORD_TEMPORARY = /^\.([0-9a-f]{64}\.json)\.(absent|[0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const PAYLOAD_KEYS = [
    'controlPlaneJournalDigest',
    'controlPlaneUpdateRecordDigest',
    'currentClosureDigest',
    'expiresAt',
    'externalAuditRoot',
    'grantId',
    'humanSigner',
    'issuedAt',
    'kind',
    'oneShot',
    'operation',
    'previousClosureDigest',
    'promotionBundleDigest',
    'recoveryBundleDigest',
    'repositoryId',
    'sourceControlPlaneGrantId',
    'sourceTransactionState',
    'supervisorGeneration',
    'supervisorStateDigest',
    'uses',
];
export function createControlPlaneRecoveryGrantPayload(binding) {
    return boundControlPlaneRecoveryGrantRecords().createControlPlaneRecoveryGrantPayload(binding);
}
export function canonicalControlPlaneRecoveryGrantPayload(payload) {
    return boundControlPlaneRecoveryGrantRecords().canonicalControlPlaneRecoveryGrantPayload(payload);
}
export function verifyControlPlaneRecoveryGrant(envelope, input) {
    return boundControlPlaneRecoveryGrantRecords().verifyControlPlaneRecoveryGrant(envelope, input);
}
export function controlPlaneRecoveryPrestateDigest(payload) {
    return boundControlPlaneRecoveryGrantRecords().controlPlaneRecoveryPrestateDigest(payload);
}
export function createControlPlaneRecoveryReceipt(input) {
    return boundControlPlaneRecoveryGrantRecords().createControlPlaneRecoveryReceipt(input);
}
export function createControlPlaneRecoveryFailure(input) {
    return boundControlPlaneRecoveryGrantRecords().createControlPlaneRecoveryFailure(input);
}
export function createControlPlaneRecoveryAuditRecord(input) {
    return boundControlPlaneRecoveryGrantRecords().createControlPlaneRecoveryAuditRecord(input);
}
export function reservePersistedControlPlaneRecoveryGrant(storageRoot, envelope, at) {
    const payload = normalizePayload(envelope.payload);
    exactIso(at, 'HARNESS_RECOVERY_RECORD_INVALID');
    const createdAt = payload.issuedAt;
    const target = recoveryRecordPath(storageRoot, payload.grantId, true);
    const envelopeDigest = canonicalDigest(envelope);
    const recordPayload = {
        kind: 'persisted-control-plane-recovery-grant.v1',
        state: 'reserved',
        envelope: structuredClone(envelope),
        envelopeDigest,
        prestateDigest: controlPlaneRecoveryPrestateDigest(payload),
        receipt: null,
        failure: null,
        createdAt,
        updatedAt: createdAt,
    };
    const record = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    const bytes = serializeRecord(record);
    reconcileRecoveryRecordTemporaries(path.dirname(target), {
        targetName: path.basename(target),
        expectedOldRecordDigest: null,
        nextRecordDigest: record.recordDigest,
        bytes,
    });
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        const existing = readPersistedControlPlaneRecoveryGrant(storageRoot, payload.grantId);
        if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
            throw recoveryRecordCorrupt();
        }
        if (existing.state === 'consumed')
            throw recoveryAlreadyConsumed();
        if (existing.state === 'failed')
            throw recoveryAlreadyFailed();
        if (existing.state === 'expired') {
            throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Recovery Grant is an expired one-shot tombstone.', ExitCode.staleState);
        }
        return existing;
    }
    replaceAtomic(target, bytes, null, record.recordDigest);
    return deepFreeze(record);
}
export function consumePersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot be consumed.', ExitCode.staleState);
    }
    if (current.state !== 'completion-pending' || current.receipt === null) {
        throw recoveryError('HARNESS_RECOVERY_CONSUMPTION_NOT_PREPARED', 'Recovery Grant consumption requires a durable completion receipt before terminalization.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before consumption.', ExitCode.staleState);
    }
    const receipt = current.receipt;
    const recordPayload = {
        kind: current.kind,
        state: 'consumed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function preparePersistedControlPlaneRecoveryGrantConsumption(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        throw recoveryAlreadyFailed();
    if (current.state === 'expired') {
        throw recoveryError('HARNESS_RECOVERY_GRANT_EXPIRED', 'Expired Recovery Grant cannot prepare consumption.', ExitCode.staleState);
    }
    const receipt = normalizeReceipt(input.receipt);
    if (receipt.recoveryGrantId !== current.envelope.payload.grantId ||
        receipt.prestateDigest !== current.prestateDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Recovery receipt does not consume the exact reserved prestate.');
    }
    if (current.state === 'completion-pending') {
        if (canonicalJson(current.receipt) !== canonicalJson(receipt)) {
            throw recoveryError('HARNESS_RECOVERY_RECEIPT_INVALID', 'Prepared Recovery Grant completion differs from the exact durable receipt.');
        }
        return current;
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before completion preparation.', ExitCode.staleState);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'completion-pending',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: receipt.completedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function failPersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'failed')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_STATE_INVALID', 'Only a reserved Recovery Grant can terminalize after restart verification failure.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before failure terminalization.', ExitCode.staleState);
    }
    const failure = normalizeFailure(input.failure);
    if (failure.recoveryGrantId !== current.envelope.payload.grantId ||
        failure.sourceControlPlaneGrantId !==
            current.envelope.payload.sourceControlPlaneGrantId) {
        throw recoveryError('HARNESS_RECOVERY_FAILURE_INVALID', 'Recovery failure does not bind the exact reserved Grant.');
    }
    const recordPayload = {
        kind: current.kind,
        state: 'failed',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure,
        createdAt: current.createdAt,
        updatedAt: failure.failedAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function expirePersistedControlPlaneRecoveryGrant(storageRoot, input) {
    const current = readPersistedControlPlaneRecoveryGrant(storageRoot, input.recoveryGrantId);
    if (current.state === 'consumed')
        throw recoveryAlreadyConsumed();
    if (current.state === 'expired')
        return current;
    if (current.state !== 'reserved') {
        throw recoveryError('HARNESS_RECOVERY_COMPLETION_OBLIGATORY', 'A Recovery Grant with a durable completion receipt cannot expire before terminal audit completion.', ExitCode.conflict);
    }
    if (current.recordDigest !== input.expectedRecordDigest) {
        throw recoveryError('HARNESS_RECOVERY_RECORD_CAS_MISMATCH', 'Recovery Grant reservation changed before expiry terminalization.', ExitCode.staleState);
    }
    const expiredAt = exactIso(input.expiredAt, 'HARNESS_RECOVERY_RECORD_INVALID');
    if (Date.parse(expiredAt) < Date.parse(current.envelope.payload.expiresAt)) {
        throw recoveryError('HARNESS_RECOVERY_GRANT_NOT_EXPIRED', 'Recovery Grant cannot terminalize before its activation window ends.', ExitCode.conflict);
    }
    const recordPayload = {
        kind: current.kind,
        state: 'expired',
        envelope: current.envelope,
        envelopeDigest: current.envelopeDigest,
        prestateDigest: current.prestateDigest,
        receipt: null,
        failure: null,
        createdAt: current.createdAt,
        updatedAt: expiredAt,
    };
    const next = {
        ...recordPayload,
        recordDigest: canonicalDigest(recordPayload),
    };
    replaceAtomic(recoveryRecordPath(storageRoot, input.recoveryGrantId, false), serializeRecord(next), current.recordDigest, next.recordDigest);
    return deepFreeze(next);
}
export function readPersistedControlPlaneRecoveryGrant(storageRoot, recoveryGrantId) {
    const value = readCanonicalRecord(recoveryRecordPath(storageRoot, recoveryGrantId, false));
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'createdAt',
            'envelope',
            'envelopeDigest',
            'failure',
            'kind',
            'prestateDigest',
            'receipt',
            'recordDigest',
            'state',
            'updatedAt',
        ]) ||
        value.kind !== 'persisted-control-plane-recovery-grant.v1' ||
        !verifyRecordDigest(value) ||
        !isRecord(value.envelope) ||
        !hasExactKeys(value.envelope, ['payload', 'signature']) ||
        !isRecord(value.envelope.payload) ||
        !isNonEmpty(value.envelope.signature) ||
        !isDigest(value.envelopeDigest) ||
        canonicalDigest(value.envelope) !== value.envelopeDigest ||
        !isDigest(value.prestateDigest) ||
        ![
            'reserved',
            'completion-pending',
            'consumed',
            'expired',
            'failed',
        ].includes(String(value.state))) {
        throw recoveryRecordCorrupt();
    }
    const payload = normalizePayload(value.envelope.payload);
    if (payload.grantId !== recoveryGrantId ||
        value.prestateDigest !== controlPlaneRecoveryPrestateDigest(payload)) {
        throw recoveryRecordCorrupt();
    }
    const createdAt = exactIso(value.createdAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    const updatedAt = exactIso(value.updatedAt, 'HARNESS_RECOVERY_RECORD_CORRUPT');
    if (Date.parse(updatedAt) < Date.parse(createdAt))
        throw recoveryRecordCorrupt();
    const receipt = value.receipt === null ? null : normalizeReceipt(value.receipt);
    const failure = value.failure === null ? null : normalizeFailure(value.failure);
    if (((value.state === 'reserved' || value.state === 'expired') &&
        (receipt !== null || failure !== null)) ||
        ((value.state === 'completion-pending' || value.state === 'consumed') &&
            (receipt === null || failure !== null)) ||
        (value.state === 'failed' && (receipt !== null || failure === null)) ||
        (receipt !== null &&
            (receipt.recoveryGrantId !== payload.grantId ||
                receipt.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                receipt.repositoryId !== payload.repositoryId ||
                receipt.operation !== payload.operation ||
                receipt.previousClosureDigest !== payload.previousClosureDigest ||
                receipt.currentClosureDigest !== payload.currentClosureDigest ||
                receipt.controlPlaneJournalDigestBefore !==
                    payload.controlPlaneJournalDigest ||
                receipt.supervisorStateDigestBefore !== payload.supervisorStateDigest ||
                receipt.prestateDigest !== value.prestateDigest)) ||
        (failure !== null &&
            (failure.recoveryGrantId !== payload.grantId ||
                failure.sourceControlPlaneGrantId !==
                    payload.sourceControlPlaneGrantId ||
                failure.selectedClosureDigest !== payload.previousClosureDigest ||
                Date.parse(failure.failedAt) < Date.parse(createdAt)))) {
        throw recoveryRecordCorrupt();
    }
    return deepFreeze(structuredClone(value));
}
export function findPersistedControlPlaneRecoveryGrantForSource(storageRoot, sourceControlPlaneGrantId) {
    assertIdentifier(sourceControlPlaneGrantId, 'HARNESS_RECOVERY_GRANT_INVALID');
    const directory = recoveryRecordsDirectory(storageRoot, false);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false }))
        return null;
    assertPrivateDirectory(directory);
    reconcileRecoveryRecordTemporaries(directory);
    const entries = fs.readdirSync(directory).sort();
    if (entries.some((entry) => !RECOVERY_RECORD_NAME.test(entry) &&
        !RECOVERY_RECORD_TEMPORARY.test(entry))) {
        throw recoveryRecordCorrupt();
    }
    const matches = entries
        .filter((entry) => RECOVERY_RECORD_NAME.test(entry))
        .map((entry) => readPersistedControlPlaneRecoveryGrant(storageRoot, recoveryGrantIdFromRecordPath(directory, entry)))
        .filter((record) => record.envelope.payload.sourceControlPlaneGrantId ===
        sourceControlPlaneGrantId);
    const active = matches.filter(({ state }) => state !== 'expired' && state !== 'failed');
    if (active.length > 1)
        throw recoveryRecordCorrupt();
    if (active.length === 1)
        return active[0];
    return (matches.sort((left, right) => left.updatedAt < right.updatedAt
        ? 1
        : left.updatedAt > right.updatedAt
            ? -1
            : left.envelope.payload.grantId < right.envelope.payload.grantId
                ? 1
                : left.envelope.payload.grantId > right.envelope.payload.grantId
                    ? -1
                    : 0)[0] ?? null);
}
export function throwControlPlaneRecoveryAlreadyConsumed() {
    throw recoveryAlreadyConsumed();
}
export function throwControlPlaneRecoveryFailed() {
    throw recoveryAlreadyFailed();
}
function normalizePayload(raw) {
    return boundControlPlaneRecoveryGrantRecords().normalizePayload(raw);
}
function normalizeReceipt(raw) {
    return boundControlPlaneRecoveryGrantRecords().normalizeReceipt(raw);
}
function normalizeFailure(raw) {
    return boundControlPlaneRecoveryGrantRecords().normalizeFailure(raw);
}
function recoveryRecordsDirectory(storageRoot, create) {
    return boundControlPlaneRecoveryGrantStorage().recoveryRecordsDirectory(storageRoot, create);
}
function recoveryRecordPath(storageRoot, recoveryGrantId, createDirectory) {
    return boundControlPlaneRecoveryGrantStorage().recoveryRecordPath(storageRoot, recoveryGrantId, createDirectory);
}
function recoveryGrantIdFromRecordPath(directory, entry) {
    return boundControlPlaneRecoveryGrantStorage().recoveryGrantIdFromRecordPath(directory, entry);
}
function assertPrivateDirectory(directory) {
    return boundControlPlaneRecoveryGrantStorage().assertPrivateDirectory(directory);
}
function readCanonicalRecord(filePath, allowedLinkCounts = [1]) {
    return boundControlPlaneRecoveryGrantStorage().readCanonicalRecord(filePath, allowedLinkCounts);
}
function replaceAtomic(filePath, bytes, expectedOldRecordDigest, nextRecordDigest) {
    return boundControlPlaneRecoveryGrantStorage().replaceAtomic(filePath, bytes, expectedOldRecordDigest, nextRecordDigest);
}
function reconcileRecoveryRecordTemporaries(directory, expectation) {
    return boundControlPlaneRecoveryGrantStorage().reconcileRecoveryRecordTemporaries(directory, expectation);
}
function serializeRecord(value) {
    const bytes = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
        throw recoveryRecordCorrupt();
    return bytes;
}
function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest))
        return false;
    const { recordDigest, ...payload } = value;
    return recordDigest === canonicalDigest(payload);
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function exactIso(value, code) {
    if (typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw recoveryError(code, 'Recovery timestamp is not canonical UTC.');
    }
    return value;
}
function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw recoveryError(code, 'Recovery clock is invalid.');
    }
    return new Date(value.getTime());
}
function assertDigest(value, code) {
    if (!isDigest(value))
        throw recoveryError(code, 'Expected a SHA-256 digest.');
}
function assertIdentifier(value, code) {
    if (!isNonEmpty(value)) {
        throw recoveryError(code, 'Recovery identity is invalid.');
    }
}
function isNonEmpty(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 255 &&
        value.trim() === value &&
        !value.includes('\0') &&
        !value.includes('\n') &&
        !value.includes('\r'));
}
function isExactAbsolutePath(value) {
    return (typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        !value.includes('\0'));
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function canonicalDigest(value) {
    return rawDigest(canonicalJson(value));
}
function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return value;
}
function recoveryAlreadyConsumed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED', 'Recovery Grant is a consumed one-shot tombstone and cannot replay.', ExitCode.conflict);
}
function recoveryAlreadyFailed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_FAILED', 'Recovery Grant terminalized after restart verification failed and cannot replay.', ExitCode.conflict);
}
function recoveryRecordCorrupt() {
    return recoveryError('HARNESS_RECOVERY_RECORD_CORRUPT', 'Persisted Recovery Grant or receipt failed canonical integrity verification.', ExitCode.verification);
}
function recoveryStateUnsafe() {
    return recoveryError('HARNESS_RECOVERY_STATE_UNSAFE', 'Recovery state must remain in exact private non-symlink storage.', ExitCode.unsafeEnvironment);
}
function recoveryError(code, message, exitCode = ExitCode.guard) {
    return workflowError(code, message, exitCode);
}
function isWorkflowCode(error) {
    return error instanceof Error && 'code' in error;
}
function isNodeCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code);
}
