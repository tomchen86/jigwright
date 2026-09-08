/**
 * Supplies investigation resolution paths, scalar checks, observations, and stable errors.
 *
 * Invariants:
 * - Path construction and identifier validation keep their existing accepted values.
 * - Unsafe observations, canonical envelope checks, and error codes remain byte-compatible.
 *
 * Depends on: runtime paths, private readers, canonical JSON, and workflow errors.
 * Failure modes: records resolve to different paths or identical failures produce incompatible evidence.
 */
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { exactUnsafePathObservationDigest } from "./evidence-unsafe-observation.js";
import { hasExactKeys, isRecord } from "./investigation-store-values.js";
export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function investigationSessionPath(paths, investigationId) {
    return path.join(paths.sessions, `${investigationId}.json`);
}
export function currentInvestigationRefPath(paths, changeId) {
    return path.join(paths.refs, `${changeId}.investigation-session.json`);
}
export function investigationStartReservationPath(paths, changeId) {
    return path.join(paths.refs, `${changeId}.investigation-start.json`);
}
export function humanResolutionPaths(paths) {
    const root = path.join(paths.root, 'human-resolutions');
    return {
        root,
        nodes: path.join(root, 'nodes'),
        refs: path.join(root, 'refs'),
        available: path.join(root, 'grants', 'available'),
        reserved: path.join(root, 'grants', 'reserved'),
        terminal: path.join(root, 'grants', 'terminal'),
        publicationRecoveries: path.join(root, 'grants', 'publication-recoveries'),
        active: path.join(root, 'active'),
        journals: path.join(root, 'journals'),
        receipts: path.join(root, 'receipts'),
        archives: path.join(root, 'archives'),
        retiredRefs: path.join(root, 'retired-refs'),
        quarantine: path.join(root, 'quarantine'),
        locks: path.join(root, 'locks'),
    };
}
export function humanResolutionGrantPublicationRecoveryRequired() {
    return workflowError('HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_REQUIRED', 'An interrupted human resolution grant publication requires explicit reconciliation through maintainer resolution-inspect and resolution-publication-discard.', ExitCode.unsafeEnvironment);
}
export function humanResolutionGrantPublicationRecoveryInvalid() {
    return workflowError('HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_INVALID', 'Interrupted human resolution grant publication recovery input is malformed.', ExitCode.guard);
}
export function humanResolutionGrantPublicationRecoveryStale() {
    return workflowError('HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE', 'Interrupted human resolution grant publication no longer matches the inspected bytes.', ExitCode.staleState);
}
export function humanResolutionGrantPublicationRecoveryAmbiguous() {
    return workflowError('HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS', 'Interrupted human resolution grant publication state is not a unique temp-only prefix.', ExitCode.unsafeEnvironment);
}
export function humanResolutionNodePath(paths, nodeId) {
    return path.join(humanResolutionPaths(paths).nodes, `${nodeId}.json`);
}
export function humanResolutionRefPath(paths, investigationId) {
    return path.join(humanResolutionPaths(paths).refs, `${investigationId}.json`);
}
export function humanResolutionJournalPath(paths, grantId) {
    return path.join(humanResolutionPaths(paths).journals, `${grantId}.json`);
}
export function activeHumanResolutionJournalPath(paths, changeId) {
    return path.join(humanResolutionPaths(paths).active, `${changeId}.json`);
}
export function observeUnsafePath(filePath, object, observations) {
    let observationDigest;
    try {
        observationDigest = exactUnsafePathObservationDigest(filePath, object);
    }
    catch {
        throw humanResolutionStateInvalid();
    }
    observations.push({ object, observationDigest });
    return observationDigest;
}
export function normalizeAmbiguityObservations(observations) {
    const normalized = new Map();
    for (const { object, observationDigest } of observations) {
        const existing = normalized.get(object);
        if (existing !== undefined && existing !== observationDigest) {
            throw humanResolutionStateInvalid();
        }
        normalized.set(object, observationDigest);
    }
    return [...normalized]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([object, observationDigest]) => ({ object, observationDigest }));
}
export function assertCanonicalResolutionEnvelopeBytes(content) {
    if (typeof content !== 'string' ||
        Buffer.byteLength(content, 'utf8') > 65_536) {
        throw humanResolutionGrantUnsafe();
    }
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        throw humanResolutionGrantUnsafe();
    }
    if (`${JSON.stringify(value)}\n` !== content) {
        throw humanResolutionGrantUnsafe();
    }
}
export function assertHumanResolutionGrantId(value) {
    if (typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw humanResolutionGrantUnsafe();
    }
    return value;
}
export function exactResolutionTimestamp(value) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
        throw humanResolutionInvalid('Human resolution timestamp is invalid.');
    }
    return new Date(time).toISOString();
}
export function isBoundedResolutionText(value, maxBytes) {
    return (typeof value === 'string' &&
        value.trim() === value &&
        value.length > 0 &&
        Buffer.byteLength(value, 'utf8') <= maxBytes &&
        ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || (code >= 127 && code <= 159);
        }));
}
export function isEmptyRecord(value) {
    return isRecord(value) && Object.keys(value).length === 0;
}
export function isSortedUniqueStrings(values) {
    const sorted = [...new Set(values)].sort();
    return (values.length === sorted.length &&
        values.every((value, index) => value === sorted[index]));
}
export function isBaseline(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['head', 'tree']) &&
        typeof value.head === 'string' &&
        GIT_OBJECT_ID.test(value.head) &&
        typeof value.tree === 'string' &&
        GIT_OBJECT_ID.test(value.tree));
}
export function sessionUnsafe() {
    return workflowError('INVESTIGATION_SESSION_UNSAFE', 'Investigation session storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function sessionInvalid() {
    return workflowError('INVESTIGATION_SESSION_INVALID', 'Investigation session is malformed or internally inconsistent.', ExitCode.staleState);
}
export function sessionTransitionInvalid() {
    return workflowError('INVESTIGATION_SESSION_TRANSITION_INVALID', 'Investigation session transition is not monotonic.', ExitCode.staleState);
}
export function investigationCasMismatch(expected, observed) {
    return workflowError('INVESTIGATION_CAS_MISMATCH', 'Investigation session changed during compare-and-swap.', ExitCode.conflict, { details: { expectedRevision: expected, observedRevision: observed } });
}
export function refUnsafe() {
    return workflowError('CURRENT_INVESTIGATION_REF_UNSAFE', 'Current investigation reference is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionInvalid(message) {
    return workflowError('HUMAN_RESOLUTION_INVALID', message, ExitCode.guard);
}
export function humanResolutionStateInvalid() {
    return workflowError('HUMAN_RESOLUTION_STATE_UNSAFE', 'The workflow state cannot be uniquely bound for human resolution.', ExitCode.unsafeEnvironment);
}
export function humanResolutionRecoveryAmbiguous() {
    return workflowError('HUMAN_RESOLUTION_RECOVERY_AMBIGUOUS', 'Human resolution recovery observed state outside the exact journal.', ExitCode.staleState);
}
export function startReservationUnsafe() {
    return workflowError('HUMAN_RESOLUTION_START_RESERVATION_UNSAFE', 'Referenced investigation start reservation is unsafe or non-canonical.', ExitCode.unsafeEnvironment);
}
export function humanResolutionObjectUnsafe() {
    return workflowError('HUMAN_RESOLUTION_NODE_UNSAFE', 'Human resolution overlay storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionRefUnsafe() {
    return workflowError('HUMAN_RESOLUTION_REF_UNSAFE', 'Human resolution ref storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionGrantUnsafe() {
    return workflowError('HUMAN_RESOLUTION_GRANT_UNSAFE', 'Human resolution grant storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionGrantUnavailable(grantId) {
    return workflowError('HUMAN_RESOLUTION_GRANT_UNAVAILABLE', `Human resolution grant ${grantId} is unavailable or already terminal.`, ExitCode.conflict);
}
export function humanResolutionGrantNotFound(grantId) {
    return workflowError('HUMAN_RESOLUTION_GRANT_NOT_FOUND', `Human resolution grant ${grantId} does not exist.`, ExitCode.conflict);
}
export function humanResolutionJournalUnsafe() {
    return workflowError('HUMAN_RESOLUTION_JOURNAL_UNSAFE', 'Human resolution journal is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionArchiveUnsafe() {
    return workflowError('HUMAN_RESOLUTION_ARCHIVE_UNSAFE', 'Human resolution evidence archive is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function humanResolutionReceiptUnsafe() {
    return workflowError('HUMAN_RESOLUTION_RECEIPT_UNSAFE', 'Human resolution receipt is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
export function sessionLockInvalid() {
    return workflowError('INVESTIGATION_SESSION_LOCK_INVALID', 'Investigation session lock ownership changed during the transition.', ExitCode.staleState);
}
