/**
 * Defines exact publication path, digest, and internal error primitives.
 *
 * Invariants:
 * - Canonical path spelling, digest bytes, and failure identity remain stable.
 * - Shared helpers perform no publication or recovery transition.
 */
import { workflowError, ExitCode } from "../../../foundation/errors/errors.js";
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
export const DIGEST = /^[0-9a-f]{64}$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Publication roles are engine-owned lowercase-ASCII POSIX paths.
const PUBLICATION_PATH = /^[a-z0-9._/-]+$/u;
export function isBoundedPublicationPath(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 4_096 &&
        !/[\0\r\n]/.test(value));
}
export function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return (keys.length === expected.length &&
        keys.every((key) => expected.includes(key)));
}
export function publicationFailureSourceInvalid(message) {
    return workflowError('INVESTIGATION_V3_FAILURE_SOURCE_INVALID', message, ExitCode.guard);
}
export function isCanonicalPublicationRelativePath(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        !PUBLICATION_PATH.test(value) ||
        value.includes('\0') ||
        value.includes('\\') ||
        path.posix.isAbsolute(value) ||
        path.posix.normalize(value) !== value) {
        return false;
    }
    return !value
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}
export class PublicationFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'PublicationFailure';
        this.code = code;
    }
}
export function publicationFailure(code, message) {
    return new PublicationFailure(code, message);
}
export function prefixedDigest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
