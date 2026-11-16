import { invalidScope, } from "../../modules/authority/authority-audit-contract.js";
export { sha256Digest, invalidScope, } from "../../modules/authority/authority-audit-contract.js";
import path from 'node:path';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { MAX_PATH_BYTES, SHA256_DIGEST, CANONICAL_TIMESTAMP, } from "./authority-audit-contracts.js";
export function parseJson(raw, makeError) {
    try {
        return JSON.parse(raw);
    }
    catch {
        throw makeError();
    }
}
export function assertMaintenanceTimestamp(raw) {
    if (!isCanonicalTimestamp(raw))
        throw maintenanceInvalid();
    return raw;
}
export function assertAbsolutePath(raw) {
    if (typeof raw !== 'string' ||
        raw.length === 0 ||
        Buffer.byteLength(raw) > MAX_PATH_BYTES ||
        raw.includes('\0') ||
        !path.isAbsolute(raw) ||
        path.normalize(raw) !== raw) {
        throw invalidScope();
    }
    return raw;
}
export function assertDigest(raw, makeError) {
    if (typeof raw !== 'string' || !SHA256_DIGEST.test(raw)) {
        throw makeError();
    }
    return raw;
}
export function assertNullableDigest(raw, makeError) {
    return raw === null ? null : assertDigest(raw, makeError);
}
export function isCanonicalTimestamp(raw) {
    if (typeof raw !== 'string' || !CANONICAL_TIMESTAMP.test(raw)) {
        return false;
    }
    const timestamp = Date.parse(raw);
    return (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === raw);
}
export function hasExactKeys(record, expected) {
    const keys = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return (keys.length === sortedExpected.length &&
        keys.every((key, index) => key === sortedExpected[index]));
}
export function includes(values, raw) {
    return typeof raw === 'string' && values.includes(raw);
}
export function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function pathsOverlap(first, second) {
    return isWithin(first, second) || isWithin(second, first);
}
function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return (relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative)));
}
export function externalRootRequired() {
    return workflowError('AUTHORITY_AUDIT_EXTERNAL_ROOT_REQUIRED', 'Authority audit storage must be physically separate from the repository.', ExitCode.guard);
}
export function invalidRecord() {
    return workflowError('AUTHORITY_AUDIT_RECORD_INVALID', 'Authority audit input does not match the bounded canonical record schema.', ExitCode.usage);
}
export function invalidLedger() {
    return workflowError('AUTHORITY_AUDIT_LEDGER_INVALID', 'Authority audit ledger failed canonical, sequence, digest, or hash-chain verification.', ExitCode.staleState);
}
export function unsafeFilesystem() {
    return workflowError('AUTHORITY_AUDIT_FILESYSTEM_UNSAFE', 'Authority audit storage has unsafe paths, file types, links, or permissions.', ExitCode.unsafeEnvironment);
}
export function lockBusy() {
    return workflowError('AUTHORITY_AUDIT_LOCK_BUSY', 'Another authority audit append or verification operation owns the ledger lock.', ExitCode.conflict);
}
export function lockUnsafe() {
    return workflowError('AUTHORITY_AUDIT_LOCK_UNSAFE', 'Authority audit ledger lock state is unsafe or cannot be proven current.', ExitCode.staleState);
}
export function idempotencyConflict() {
    return workflowError('AUTHORITY_AUDIT_IDEMPOTENCY_CONFLICT', 'Authority audit idempotency key already identifies different record content.', ExitCode.conflict);
}
export function invalidProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_INVALID', 'Persisted authority audit profile or code-owned policy binding is invalid.', ExitCode.staleState);
}
export function profileMismatch() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_MISMATCH', 'Authority audit profile is already persisted and cannot be downgraded or mixed.', ExitCode.guard);
}
export function protectedProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_PROTECTED', 'Protected audit records cannot be pruned by development retention maintenance.', ExitCode.guard);
}
export function developmentProfile() {
    return workflowError('AUTHORITY_AUDIT_PROFILE_DEVELOPMENT', 'This authority audit operation requires the persisted protected profile.', ExitCode.guard);
}
export function protectedConfigurationInvalid() {
    return workflowError('AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID', 'Protected authority audit configuration is missing, malformed, unsafe, or no longer bound to its pinned backend and destruction key.', ExitCode.staleState);
}
export function protectedConfigurationMismatch() {
    return workflowError('AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_MISMATCH', 'Protected authority audit backend and destruction public key are already pinned and cannot be replaced.', ExitCode.guard);
}
export function maintenanceInvalid() {
    return workflowError('AUTHORITY_AUDIT_MAINTENANCE_INVALID', 'Authority audit retention checkpoint or maintenance journal is missing, malformed, or tampered.', ExitCode.staleState);
}
export function anchorInvalid() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_INVALID', 'Protected authority audit anchor receipt is malformed, tampered, or not bound to ledger history.', ExitCode.staleState);
}
export function anchorBackendInvalid() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_BACKEND_INVALID', 'Protected authority audit anchor backend did not produce a verifiable bounded receipt.', ExitCode.verification);
}
export function anchorBackendRequired() {
    return workflowError('AUTHORITY_AUDIT_ANCHOR_BACKEND_REQUIRED', 'Protected authority audit verification requires the exact backend verifier named by every receipt.', ExitCode.guard);
}
export function destructionGrantInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_INVALID', 'Audit destruction requires an exact domain-separated, human-verified, single-use grant.', ExitCode.verification);
}
export function destructionGrantExpired() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_EXPIRED', 'Audit-Destruction Grant is not currently valid.', ExitCode.staleState);
}
export function destructionGrantBindingInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_BINDING_INVALID', 'Audit-Destruction Grant does not bind the exact current ledger head and prefix.', ExitCode.staleState);
}
export function destructionGrantConsumed() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_GRANT_CONSUMED', 'Audit-Destruction Grant already has a durable tombstone and cannot replay.', ExitCode.conflict);
}
export function destructionTombstoneInvalid() {
    return workflowError('AUTHORITY_AUDIT_DESTRUCTION_TOMBSTONE_INVALID', 'Protected authority audit destruction tombstone is missing, malformed, or tampered.', ExitCode.staleState);
}
export function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
