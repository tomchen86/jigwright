/**
 * Shares canonical value validation and error preservation across execution governance.
 *
 * Invariants:
 * - Digest prefixes, size bounds, canonical ordering, and error identities retain exact bytes.
 * - Validators reject malformed values without coercing their persisted representation.
 *
 * Depends on: canonical JSON, SHA-256, and the workflow error contract.
 * Failure modes: divergent evidence digests, accepted malformed records, or changed error codes.
 */
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
export const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/;
export const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
export const MAX_DOCUMENT_BYTES = 1_048_576;
export function cloneJson(value, invalid = invalidRepairContext) {
    assertJsonValue(value, invalid);
    return JSON.parse(canonicalJson(value));
}
export function assertJsonValue(value, invalid) {
    try {
        const encoded = canonicalJson(value);
        if (Buffer.byteLength(encoded) > 262_144) {
            throw invalid('JSON value exceeds its size bound.');
        }
    }
    catch (error) {
        if (isWorkflowError(error) && error.code !== 'CANONICAL_JSON_INVALID') {
            throw error;
        }
        throw invalid('Value is not finite JSON data.');
    }
}
export function sortedUniqueIdentities(value, invalid, label, assertAlreadySorted = false) {
    if (!Array.isArray(value) || value.length > 256) {
        throw invalid(`${label} list is invalid.`);
    }
    const identities = value.map((item) => {
        assertIdentity(item, invalid, label);
        return item;
    });
    const sorted = [...identities].sort();
    if (new Set(identities).size !== identities.length ||
        (assertAlreadySorted &&
            identities.some((identity, index) => identity !== sorted[index]))) {
        throw invalid(`${label} list must be sorted and unique.`);
    }
    return sorted;
}
export function isSorted(value, compare) {
    return value.every((item, index) => index === 0 || compare(value[index - 1], item) < 0);
}
export function parseDocument(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) {
        throw new Error('document size');
    }
    return JSON.parse(raw);
}
export function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function exactDate(value, errorCode) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(errorCode, 'Timestamp is invalid.', ExitCode.usage);
    }
    return value.toISOString();
}
export function assertTimestamp(value, invalid, label) {
    if (typeof value !== 'string')
        throw invalid(`${label} is invalid.`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw invalid(`${label} must be an exact ISO timestamp.`);
    }
    return value;
}
export function assertUuid(value, invalid) {
    if (typeof value !== 'string' || !UUID_V4.test(value)) {
        throw invalid('Identifier must be a lower-case UUID v4.');
    }
    return value;
}
export function assertIdentity(value, invalid, label) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw invalid(`${label} is invalid.`);
    }
}
export function assertDigest(value, invalid, label) {
    if (typeof value !== 'string' || !SHA256.test(value)) {
        throw invalid(`${label} is not a sha256 digest.`);
    }
}
export function assertPositiveInteger(value, invalid, label) {
    assertBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, invalid, label);
}
export function assertBoundedInteger(value, minimum, maximum, invalid, label) {
    if (!Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum) {
        throw invalid(`${label} is outside its bound.`);
    }
}
export function assertReason(value, invalid, label) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length < 16 ||
        value.length > 1_000 ||
        value.includes('\0')) {
        throw invalid(`${label} must be a concrete bounded explanation.`);
    }
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function hasExactKeys(value, keys) {
    const observed = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (observed.length === expected.length &&
        observed.every((key, index) => key === expected[index]));
}
export function hasKeysEither(value, variants) {
    return variants.some((keys) => hasExactKeys(value, keys));
}
export function isWorkflowError(error) {
    return (error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        'exitCode' in error);
}
export function normalizeInvalid(error, code, message) {
    if (isWorkflowError(error) && error.code === code)
        return error;
    return workflowError(code, message, ExitCode.usage);
}
export function invalidRepairContext(message) {
    return workflowError('REPAIR_CONTEXT_INVALID', message, ExitCode.usage);
}
