/**
 * Supplies supervisor history bounds, scalar validators, and error identities.
 *
 * Invariants:
 * - History digests, Git identifiers, timestamps, and exact-key checks retain their contracts.
 * - Errors continue to distinguish malformed records, forks, gaps, and unsafe storage.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_HISTORY_RECORD_BYTES = 1024 * 1024;
export const HISTORY_DIRECTORY_NAME = 'control-plane-supervisor-history';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
export function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw recordInvalid('Supervisor history expected a canonical sha256 digest.');
    }
}
export function assertGitOid(value) {
    if (typeof value !== 'string' || !GIT_OID.test(value)) {
        throw recordInvalid('Supervisor history trust commit is not a full Git object id.');
    }
}
export function assertNonEmpty(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value) {
        throw recordInvalid('Supervisor history identifier is not a non-empty trimmed string.');
    }
}
export function assertIso(value) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw recordInvalid('Supervisor history timestamp is not canonical ISO-8601.');
    }
}
export function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 1;
}
export function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
export function recordInvalid(message) {
    return workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_RECORD_INVALID', message, ExitCode.verification);
}
export function transitionInvalid(message) {
    return workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_TRANSITION_INVALID', message, ExitCode.verification);
}
export function historyGap(message) {
    return workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_GAP', message, ExitCode.verification);
}
export function historyFork(message) {
    return workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_FORK', message, ExitCode.verification);
}
export function storageUnsafe(message) {
    return workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_STORAGE_UNSAFE', message, ExitCode.unsafeEnvironment);
}
