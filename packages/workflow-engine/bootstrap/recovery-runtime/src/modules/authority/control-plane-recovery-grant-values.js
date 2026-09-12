/** Canonical recovery Grant values, pure checks and the required persistence contract. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
export const HARNESS_RECOVERY_SIGNATURE_NAMESPACE = 'HARNESS_RECOVERY_GRANT_V1';
export const CONTROL_PLANE_RECOVERY_GRANT_TTL_MS = 5 * 60 * 1000;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const RECOVERY_GRANT_ID = /^recovery-[0-9a-f]{64}$/;
export const PAYLOAD_KEYS = [
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
export function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest))
        return false;
    const { recordDigest, ...payload } = value;
    return recordDigest === canonicalDigest(payload);
}
export function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
export function exactIso(value, code) {
    if (typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw recoveryError(code, 'Recovery timestamp is not canonical UTC.');
    }
    return value;
}
export function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw recoveryError(code, 'Recovery clock is invalid.');
    }
    return new Date(value.getTime());
}
export function assertDigest(value, code) {
    if (!isDigest(value))
        throw recoveryError(code, 'Expected a SHA-256 digest.');
}
export function assertIdentifier(value, code) {
    if (!isNonEmpty(value)) {
        throw recoveryError(code, 'Recovery identity is invalid.');
    }
}
export function isNonEmpty(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 255 &&
        value.trim() === value &&
        !value.includes('\0') &&
        !value.includes('\n') &&
        !value.includes('\r'));
}
export function isExactAbsolutePath(value) {
    return (typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        !value.includes('\0'));
}
export function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
export function canonicalDigest(value) {
    return rawDigest(canonicalJson(value));
}
export function rawDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return value;
}
export function recoveryAlreadyConsumed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED', 'Recovery Grant is a consumed one-shot tombstone and cannot replay.', ExitCode.conflict);
}
export function recoveryAlreadyFailed() {
    return recoveryError('HARNESS_RECOVERY_GRANT_FAILED', 'Recovery Grant terminalized after restart verification failed and cannot replay.', ExitCode.conflict);
}
export function recoveryRecordCorrupt() {
    return recoveryError('HARNESS_RECOVERY_RECORD_CORRUPT', 'Persisted Recovery Grant or receipt failed canonical integrity verification.', ExitCode.verification);
}
export function recoveryError(code, message, exitCode = ExitCode.guard) {
    return workflowError(code, message, exitCode);
}
