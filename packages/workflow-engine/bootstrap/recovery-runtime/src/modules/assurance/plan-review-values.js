/** Shared exact value guards for PlanReview reports and immutable target snapshots. */
import crypto from 'node:crypto';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export function isRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function isDigest(value) {
    return typeof value === 'string' && DIGEST_PATTERN.test(value);
}
export function hasExactKeys(value, keys) {
    const own = Reflect.ownKeys(value);
    return (own.length === keys.length &&
        own.every((key) => typeof key === 'string') &&
        keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return Boolean(descriptor && descriptor.enumerable && 'value' in descriptor);
        }));
}
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
export function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
