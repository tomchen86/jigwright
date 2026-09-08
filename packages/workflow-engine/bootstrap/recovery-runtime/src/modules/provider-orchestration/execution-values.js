/** Shared execution record value checks and canonical digest helpers. */
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import path from 'node:path';
import crypto from 'node:crypto';
import { JOB_STATUSES_V2, ATTEMPT_STATUSES_V2, } from '@jigwright/core/job-attempt-runtime';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UNPREFIXED_DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_STRING_BYTES = 16_384;
export function parseCanonicalRecord(raw, assertRecord) {
    if (typeof raw !== 'string' ||
        Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES ||
        !raw.endsWith('\n') ||
        raw.endsWith('\n\n')) {
        throw executionError('EXECUTION_RECORD_NONCANONICAL', 'Execution record bytes are not canonical.', ExitCode.guard);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw executionError('EXECUTION_RECORD_INVALID', 'Execution record JSON is invalid.', ExitCode.guard);
    }
    const record = assertRecord(parsed);
    if (`${canonicalJson(record)}\n` !== raw) {
        throw executionError('EXECUTION_RECORD_NONCANONICAL', 'Execution record bytes are not canonical.', ExitCode.guard);
    }
    return record;
}
export function diffJson(before, after, basePath = '', ignored = new Set()) {
    if (canonicalJson(before) === canonicalJson(after))
        return [];
    if (isJsonObject(before) && isJsonObject(after)) {
        const keys = [
            ...new Set([...Object.keys(before), ...Object.keys(after)]),
        ].sort();
        const changes = [];
        for (const key of keys) {
            const path = `${basePath}/${escapeJsonPointer(key)}`;
            if (ignored.has(path))
                continue;
            if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
                changes.push({
                    path,
                    from: Object.hasOwn(before, key) ? before[key] : null,
                    to: Object.hasOwn(after, key) ? after[key] : null,
                });
            }
            else {
                changes.push(...diffJson(before[key], after[key], path, ignored));
            }
        }
        return changes;
    }
    return [{ path: basePath || '/', from: before, to: after }];
}
export function normalizeUniqueStrings(value, label, requireCanonical = false) {
    if (!Array.isArray(value))
        throw executionInvalid(`${label} is invalid.`);
    for (const entry of value)
        assertBoundedString(entry, label);
    const normalized = [...new Set(value)].sort();
    if (requireCanonical && canonicalJson(normalized) !== canonicalJson(value)) {
        throw executionInvalid(`${label} is not sorted and unique.`);
    }
    return deepFreeze(normalized);
}
export function normalizeFailurePaths(value) {
    if (!Array.isArray(value))
        throw executionInvalid('Failure paths are invalid.');
    const normalized = value.map((entry) => {
        if (entry.startsWith('/'))
            return assertJsonPointer(entry, 'failure path');
        if (!isSafeFailureRepositoryRelativePath(entry)) {
            throw executionInvalid('Failure path is unsafe.');
        }
        return entry;
    });
    return deepFreeze([...new Set(normalized)].sort());
}
function isSafeFailureRepositoryRelativePath(value) {
    return (value === value.normalize('NFC') &&
        value.length > 0 &&
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value.includes('\0') &&
        !value
            .split('/')
            .some((part) => part === '' || part === '.' || part === '..'));
}
export function assertJsonPointer(value, label) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        !value.startsWith('/') ||
        /~(?![01])/.test(value) ||
        Buffer.byteLength(value, 'utf8') > 2_048) {
        throw executionInvalid(`${label} is not a canonical JSON pointer.`);
    }
    return value;
}
export function normalizeDigest(value) {
    if (DIGEST.test(value))
        return value;
    if (UNPREFIXED_DIGEST.test(value))
        return `sha256:${value}`;
    throw executionInvalid('Digest is invalid.');
}
export function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw executionInvalid('Digest is invalid.');
    }
    return value;
}
export function assertIdentifier(value, label) {
    if (typeof value !== 'string' ||
        !IDENTIFIER.test(value) ||
        value !== value.normalize('NFC')) {
        throw executionInvalid(`${label} is invalid.`);
    }
    return value;
}
export function assertExecutionJobMandateBinding(value) {
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'mandateTaskId',
            'mandateId',
            'mandateDigest',
            'changeId',
            'externalAuditRoot',
        ]) ||
        value.schemaVersion !== 1 ||
        typeof value.mandateTaskId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
        typeof value.mandateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.mandateId) ||
        typeof value.mandateDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
        typeof value.changeId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
        typeof value.externalAuditRoot !== 'string' ||
        !path.isAbsolute(value.externalAuditRoot) ||
        path.normalize(value.externalAuditRoot) !== value.externalAuditRoot) {
        throw executionInvalid('Execution Job Task Mandate binding is invalid.');
    }
    return deepFreeze(structuredClone(value));
}
export function assertErrorCode(value) {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) {
        throw executionInvalid('Failure code is invalid.');
    }
    return value;
}
export function assertTimestamp(value) {
    if (typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw executionInvalid('Timestamp is invalid.');
    }
    return value;
}
export function assertPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw executionInvalid(`${label} must be a positive integer.`);
    }
    return value;
}
export function assertNonnegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw executionInvalid(`${label} must be a nonnegative integer.`);
    }
    return value;
}
export function assertBoundedPositiveInteger(value, label, maximum) {
    const result = assertPositiveInteger(value, label);
    if (result > maximum)
        throw executionInvalid(`${label} exceeds its bound.`);
    return result;
}
function assertBoundedNonnegativeInteger(value, label, maximum) {
    const result = assertNonnegativeInteger(value, label);
    if (result > maximum)
        throw executionInvalid(`${label} exceeds its bound.`);
    return result;
}
export function assertBoundedString(value, label) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ||
        value !== value.normalize('NFC')) {
        throw executionInvalid(`${label} is invalid.`);
    }
    return value;
}
export function digestCanonical(value) {
    return digestText(canonicalJson(value));
}
export function digestText(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function constantTimeEqual(left, right) {
    const leftBytes = Buffer.from(left, 'utf8');
    const rightBytes = Buffer.from(right, 'utf8');
    return (leftBytes.length === rightBytes.length &&
        crypto.timingSafeEqual(leftBytes, rightBytes));
}
function escapeJsonPointer(value) {
    return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
function isJsonObject(value) {
    return isPlainObject(value);
}
export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return canonicalJson(actual) === canonicalJson(expected);
}
export function hasKeysEither(value, variants) {
    return variants.some((keys) => hasExactKeys(value, keys));
}
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
export function executionInvalid(message) {
    return executionError('EXECUTION_RECORD_INVALID', message, ExitCode.guard);
}
export function probeNotAllowed() {
    return executionError('EXECUTION_PROBE_NOT_ALLOWED', 'The requested environment probe is not on the read-only allowlist.', ExitCode.guard);
}
export function executionError(code, message, exitCode) {
    return workflowError(code, message, exitCode);
}
export const JOB_STATUSES = new Set(JOB_STATUSES_V2);
export const ATTEMPT_STATUSES = new Set(ATTEMPT_STATUSES_V2);
export const RETRY_MODES = new Set([
    'same-input',
    'execution-policy-change',
    'repair',
    'strategy-change',
    'new-context',
    'none',
]);
export const ATTEMPT_RETENTION = new Set([
    'active',
    'debug',
    'pinned',
]);
export const FAILURE_SOURCES = new Set([
    'provider',
    'network',
    'worker',
    'lease',
    'tool',
    'validator',
    'environment',
    'state',
    'effect',
    'policy',
]);
