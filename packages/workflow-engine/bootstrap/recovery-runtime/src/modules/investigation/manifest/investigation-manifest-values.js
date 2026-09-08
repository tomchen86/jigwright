import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import crypto from 'node:crypto';
export const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const MAX_TEXT_BYTES = 16 * 1024;
export function normalizeSemanticAuthor(value) {
    const record = assertRecord(value);
    assertExactKeys(record, ['id', 'provenance']);
    return {
        id: boundedText(record.id, 'semantic author ID'),
        provenance: boundedText(record.provenance, 'semantic author provenance'),
    };
}
export function normalizeDigestArray(value, allowEmpty) {
    if (!Array.isArray(value) ||
        (!allowEmpty && value.length === 0) ||
        value.some((entry) => typeof entry !== 'string' || !DIGEST.test(entry))) {
        throw unrepresentable('Digest reference array is malformed.');
    }
    const sorted = [...value].sort();
    assertUnique(sorted, 'digest references');
    return sorted;
}
export function normalizeTextArray(value) {
    if (!Array.isArray(value)) {
        throw unrepresentable('Text array is malformed.');
    }
    const values = value.map((entry) => boundedText(entry, 'text value'));
    assertUnique(values, 'text values');
    return values;
}
export function nullableText(value, label) {
    return value === null ? null : boundedText(value, label);
}
export function boundedText(value, label) {
    if (typeof value !== 'string' ||
        value.trim().length === 0 ||
        Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
        throw unrepresentable(`${label} is malformed.`);
    }
    return value;
}
export function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw unrepresentable('Digest is malformed.');
    }
}
export function assertGitObjectId(value) {
    if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
        throw unrepresentable('Git object identity is malformed.');
    }
}
export function assertUnique(values, label) {
    if (new Set(values).size !== values.length) {
        throw unrepresentable(`${label} contain duplicates.`);
    }
}
export function assertRecord(value) {
    if (!isRecord(value)) {
        throw unrepresentable('Manifest object is malformed.');
    }
    return value;
}
export function assertExactKeys(value, expected) {
    const keys = Object.keys(value);
    if (keys.length !== expected.length ||
        !keys.every((key) => expected.includes(key))) {
        throw unrepresentable('Manifest object has unknown or missing properties.');
    }
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function sourceTupleKey(pathRawBase64, blobOid) {
    return canonicalJson([pathRawBase64, blobOid]);
}
export function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function rawSha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
export function digestWithDomain(domain, value) {
    return digest({ domain, value });
}
export function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
export class ManifestValidationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ManifestValidationError';
        this.code = code;
    }
}
export function unrepresentable(message) {
    return new ManifestValidationError('MANIFEST_UNREPRESENTABLE', message);
}
export const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified';
