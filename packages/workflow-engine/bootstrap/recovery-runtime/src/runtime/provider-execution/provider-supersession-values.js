/**
 * Share supersession digest, timestamp, record, and immutable value helpers.
 *
 * Invariants:
 * - Digest bytes and value acceptance stay unchanged.
 * - Helpers perform no durable reads or writes.
 *
 * Depends on: SHA-256 and plain JavaScript values.
 * Failure modes: Evidence identities drift or malformed transaction values are accepted.
 */
import crypto from 'node:crypto';
export function digestBuffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
export function digestText(value) {
    return digestBuffer(Buffer.from(value, 'utf8'));
}
export function isTimestamp(value) {
    return (Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value))
        deepFreeze(child);
    return value;
}
