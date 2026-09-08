/**
 * Share provider governance digests, value guards, and exact context and repair errors.
 *
 * Invariants:
 * - Canonical digest prefixes, accepted shapes, and error identities stay unchanged.
 * - Helpers remain free of durable state mutation.
 *
 * Depends on: canonical JSON and workflow error definitions.
 * Failure modes: Context identities drift or invalid repair data passes validation.
 */
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode, } from "../../foundation/errors/errors.js";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
export function digestCanonical(value) {
    return digestText(canonicalJson(value));
}
export function digestText(value) {
    return `sha256:${sha256Hex(value)}`;
}
export function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
export function isDigest(value) {
    return typeof value === 'string' && SHA256.test(value);
}
export function isTimestamp(value) {
    return (typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return canonicalJson(actual) === canonicalJson(expected);
}
export function providerContextInvalid(message) {
    return workflowError('PROVIDER_CONTEXT_INVALID', message, ExitCode.verification);
}
export function providerContextStale() {
    return workflowError('PROVIDER_CONTEXT_STALE_OR_WRONG', 'Durable provider context is no longer the exact current request manifest.', ExitCode.staleState);
}
export function providerRepairInvalid(message) {
    return workflowError('PROVIDER_REPAIR_INVALID', message, ExitCode.verification);
}
export function providerRepairUnsafe() {
    return workflowError('PROVIDER_REPAIR_ARTIFACT_UNSAFE', 'Provider repair artifact is missing, malformed, or not identity-bound.', ExitCode.unsafeEnvironment);
}
