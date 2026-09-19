/**
 * Supplies evidence path construction, exact value checks, digests, and errors.
 *
 * Invariants:
 * - Node and ref identifiers keep their current accepted syntax and paths.
 * - Canonical hashes and workflow error identities remain stable.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertInvestigationId } from "../../foundation/repository-path/repository-path.js";
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const REF_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export function isBaseline(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, ['head', 'tree']) &&
        typeof value.head === 'string' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) &&
        typeof value.tree === 'string' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree));
}
export function isDigestRecord(value) {
    return (isPlainRecord(value) &&
        Object.entries(value).every(([name, digest]) => name.length > 0 && typeof digest === 'string' && isDigest(digest)));
}
export function isInvestigationOwner(value) {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        return assertInvestigationId(value) === value;
    }
    catch {
        return false;
    }
}
export function evidenceObjectPath(paths, nodeId) {
    return path.join(paths.objects, nodeId.slice(0, 2), `${nodeId}.json`);
}
export function evidenceRefPath(paths, changeId) {
    return path.join(paths.refs, `${changeId}.json`);
}
export function assertNodeId(nodeId) {
    if (!DIGEST_PATTERN.test(nodeId)) {
        throw workflowError('EVIDENCE_OBJECT_ID_INVALID', `Invalid evidence node identifier: ${nodeId}`, ExitCode.usage);
    }
}
export function assertRefName(refName) {
    if (typeof refName !== 'string' || !REF_NAME_PATTERN.test(refName)) {
        throw workflowError('EVIDENCE_REF_NAME_INVALID', `Invalid evidence ref name: ${refName}`, ExitCode.usage);
    }
}
export function objectUnsafe() {
    return workflowError('EVIDENCE_OBJECT_UNSAFE', 'Evidence object path is not a canonical no-follow location.', ExitCode.unsafeEnvironment);
}
export function objectInvalid() {
    return workflowError('EVIDENCE_OBJECT_INVALID', 'Evidence object envelope is forged, tampered, or noncanonical.', ExitCode.staleState);
}
export function objectCollision(nodeId) {
    return workflowError('EVIDENCE_OBJECT_COLLISION', 'A different evidence envelope already exists for this node identifier.', ExitCode.conflict, { details: { nodeId } });
}
export function objectUnavailable(nodeId) {
    return workflowError('EVIDENCE_OBJECT_UNAVAILABLE', 'The next evidence node must already exist as a stored object.', ExitCode.staleState, { details: { nodeId } });
}
export function refUnsafe() {
    return workflowError('EVIDENCE_REF_UNSAFE', 'Evidence ref path is not a canonical no-follow location.', ExitCode.unsafeEnvironment);
}
export function refInvalid() {
    return workflowError('EVIDENCE_REF_INVALID', 'Evidence ref document is malformed or noncanonical.', ExitCode.staleState);
}
export function refCasMismatch(refName, expectedNodeId, observedNodeId) {
    return workflowError('EVIDENCE_REF_CAS_MISMATCH', 'Evidence ref changed during compare-and-swap.', ExitCode.conflict, { details: { refName, expectedNodeId, observedNodeId } });
}
export function refsDocumentCasMismatch(expectedDigest, observedDigest, nextDigest) {
    return workflowError('EVIDENCE_REFS_CAS_MISMATCH', 'Evidence ref document changed during compare-and-swap.', ExitCode.conflict, { details: { expectedDigest, observedDigest, nextDigest } });
}
export function refLocked(changeId) {
    return workflowError('EVIDENCE_REF_LOCKED', 'Evidence ref for this change is locked by another operation.', ExitCode.conflict, { details: { changeId } });
}
export function refLockInvalid() {
    return workflowError('EVIDENCE_REF_LOCK_INVALID', 'Evidence ref lock ownership changed during the operation.', ExitCode.staleState);
}
export function isDigest(value) {
    return typeof value === 'string' && DIGEST_PATTERN.test(value);
}
export function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
export function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
export function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
