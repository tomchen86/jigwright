/** Shared exact recovery values, canonical encoding, protocol constants, and error construction. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
/**
 * Recovery substrate only. This module does not inspect HEAD, load the tracked
 * maintainer policy, replace repository files, or wire the operational root
 * into a launcher. A future sealed bootstrap may consume the verified active
 * root returned by readRecoveryOperationalTrustRootActive().
 */
export const RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE = 'HARNESS_RECOVERY_RESTORE_OPERATIONAL_TRUST_ROOT_V1';
export const RECOVERY_TRUST_ROOT_RESTORE_TTL_MS = 5 * 60 * 1000;
export const MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES = 1024 * 1024;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const GRANT_ID = /^trust-root-restore-[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@+:/-]{0,511}$/;
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const SSH_PUBLIC_KEY = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
export const POINTER_FILE = /^[0-9]{20}\.json$/;
export const ROOT_FILE = /^[0-9a-f]{64}\.json$/;
export const OPERATION_DIRECTORY = /^[0-9a-f]{64}$/;
export const PREPARATION = /^\.([a-z0-9][a-z0-9.-]*\.json)\.([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.prepare$/;
export const UNSIGNED_GRANT_KEYS = [
    'authorityDescriptorDigest',
    'authorityGeneration',
    'expectedActivePointerDigest',
    'expectedGeneration',
    'expiresAt',
    'externalAuditRoot',
    'humanSigner',
    'issuedAt',
    'kind',
    'oneShot',
    'operation',
    'recoveryRuntimeDigest',
    'replacementGeneration',
    'replacementRootDigest',
    'repositoryId',
    'signerFingerprint',
    'uses',
];
export const GRANT_KEYS = [...UNSIGNED_GRANT_KEYS, 'grantId'];
export const ENVELOPE_KEYS = ['payload', 'replacement', 'signature'];
export const POINTER_KEYS = [
    'activatedAt',
    'authorityDescriptorDigest',
    'authorityGeneration',
    'envelopeDigest',
    'generation',
    'grantId',
    'kind',
    'pointerDigest',
    'previousPointerDigest',
    'repositoryId',
    'rootDigest',
];
export const RESERVATION_KEYS = [
    'envelope',
    'envelopeDigest',
    'grantId',
    'kind',
    'reservationDigest',
    'reservedAt',
];
export const RECEIPT_KEYS = [
    'completedAt',
    'generation',
    'grantId',
    'kind',
    'newPointerDigest',
    'previousPointerDigest',
    'receiptDigest',
    'repositoryId',
    'rootDigest',
];
export const TERMINAL_KEYS = [
    'consumedAt',
    'envelopeDigest',
    'grantId',
    'kind',
    'receiptDigest',
    'state',
    'terminalDigest',
];
export const AUDIT_KEYS = [
    'authorityDescriptorDigest',
    'authorityGeneration',
    'envelopeDigest',
    'externalAuditRoot',
    'generation',
    'grantId',
    'humanSigner',
    'kind',
    'newPointerDigest',
    'previousPointerDigest',
    'recordDigest',
    'recordId',
    'recordedAt',
    'recoveryRuntimeDigest',
    'repositoryId',
    'rootDigest',
    'signerFingerprint',
    'terminalDigest',
];
export const AUDIT_ACK_KEYS = [
    'acknowledgedAt',
    'acknowledgementDigest',
    'grantId',
    'kind',
    'recordDigest',
    'recordId',
];
export function parseCanonicalBytes(bytes, malformed = stateCorrupt) {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.endsWith('\n'))
            throw malformed();
        const value = JSON.parse(text);
        if (`${canonicalJson(value)}\n` !== text)
            throw malformed();
        return value;
    }
    catch (error) {
        if (hasWorkflowCode(error))
            throw error;
        throw malformed();
    }
}
export function assertCanonicalEqual(observed, expected) {
    if (canonicalJson(observed) !== canonicalJson(expected))
        throw stateCorrupt();
}
export function canonicalDigest(value) {
    return `sha256:${digestHex(canonicalJson(value))}`;
}
export function digestHex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
export function exactIso(value) {
    if (typeof value !== 'string')
        throw grantInvalid();
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== value) {
        throw grantInvalid();
    }
    return value;
}
export function exactDate(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw restoreError('RECOVERY_TRUST_ROOT_TIME_INVALID', 'Trust-root restore requires a valid injected time.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
export function isBufferPrefix(prefix, value) {
    return (prefix.length <= value.length &&
        value.subarray(0, prefix.length).equals(prefix));
}
export function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
export function isIdentifier(value) {
    return typeof value === 'string' && IDENTIFIER.test(value);
}
export function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}
export function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}
export function isExactAbsolutePath(value) {
    return (typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.resolve(value) === value);
}
export function pathIsWithin(root, target) {
    const relative = path.relative(root, target);
    return (relative.length === 0 ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative)));
}
export function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null));
}
export function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return (actual.length === sorted.length &&
        actual.every((key, index) => key === sorted[index]));
}
export function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        deepFreeze(nested);
    }
    return Object.freeze(value);
}
export function restoreError(code, message, exitCode) {
    return workflowError(code, message, exitCode);
}
export function grantInvalid() {
    return restoreError('RECOVERY_TRUST_ROOT_GRANT_INVALID', 'Trust-root restore Grant or canonical replacement bundle is malformed.', ExitCode.guard);
}
export function stateCorrupt() {
    return restoreError('RECOVERY_TRUST_ROOT_STATE_CORRUPT', 'Trust-root restore durable state failed integrity verification.', ExitCode.verification);
}
export function storeUnsafe() {
    return restoreError('RECOVERY_TRUST_ROOT_STORE_UNSAFE', 'Trust-root restore durable store is unavailable or unsafe.', ExitCode.unsafeEnvironment);
}
export function externalFileUnsafe() {
    return restoreError('RECOVERY_TRUST_ROOT_EXTERNAL_FILE_UNSAFE', 'Pre-signed trust-root replacement must be one exact private regular file.', ExitCode.unsafeEnvironment);
}
export function boundaryInvalid() {
    return restoreError('RECOVERY_TRUST_ROOT_BOUNDARY_INVALID', 'Trust-root restore requires exact repository and Git common boundaries.', ExitCode.unsafeEnvironment);
}
export function auditRootUnsafe() {
    return restoreError('RECOVERY_TRUST_ROOT_AUDIT_ROOT_UNSAFE', 'Trust-root restore external audit root must be an exact private directory.', ExitCode.unsafeEnvironment);
}
export function alreadyConsumed() {
    return restoreError('RECOVERY_TRUST_ROOT_GRANT_ALREADY_CONSUMED', 'Trust-root restore Grant is one-shot and has already been consumed.', ExitCode.conflict);
}
export function transitionIncomplete() {
    return restoreError('RECOVERY_TRUST_ROOT_TRANSITION_INCOMPLETE', 'Operational trust-root transition is not durably consumed and audited.', ExitCode.conflict);
}
export function hasWorkflowCode(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string');
}
export function isNodeCode(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code);
}
