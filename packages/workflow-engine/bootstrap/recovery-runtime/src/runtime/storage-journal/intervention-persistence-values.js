/**
 * Shares canonical record digests and bounded identity, observation, and authority-input checks.
 *
 * Invariants:
 * - Record payloads retain exact canonical digest bytes and their validation error codes.
 * - Human verifier and timestamp inputs retain their current requirements and invocation semantics.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { MAX_RECORD_BYTES, } from "./intervention-persistence-contracts.js";
export function validateObservations(observations, expectedCount, terminalState) {
    if (!Array.isArray(observations) || observations.length !== expectedCount) {
        throw new Error('Observation count mismatch.');
    }
    for (let index = 0; index < observations.length; index += 1) {
        const observation = observations[index];
        if (observation.sequence !== index + 1 ||
            typeof observation.eventKind !== 'string' ||
            observation.eventKind.length === 0 ||
            typeof observation.fromState !== 'string' ||
            typeof observation.toState !== 'string') {
            throw new Error('Observation is invalid.');
        }
        assertDigest(observation.evidenceDigest, 'OBSERVATION_INVALID');
        exactIso(observation.recordedAt, 'OBSERVATION_INVALID');
        if (index > 0 &&
            observations[index - 1].toState !== observation.fromState) {
            throw new Error('Observation chain is discontinuous.');
        }
    }
    if (observations.length > 0 &&
        observations.at(-1)?.toState !== terminalState) {
        throw new Error('Observation state does not match journal.');
    }
}
export function serializeRecord(value) {
    const serialized = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw workflowError('INTERVENTION_PERSISTENCE_RECORD_TOO_LARGE', 'Persistence record exceeds the four-megabyte limit.', ExitCode.guard);
    }
    return serialized;
}
export function withRecordDigest(payload) {
    return { ...payload, recordDigest: canonicalDigest(payload) };
}
export function verifyRecordDigest(value) {
    if (!isDigest(value.recordDigest)) {
        return false;
    }
    const { recordDigest, ...payload } = value;
    return canonicalDigest(payload) === recordDigest;
}
export function canonicalDigest(value) {
    return `sha256:${crypto
        .createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex')}`;
}
export function identityFileName(kind, identity) {
    if (typeof identity !== 'string' ||
        identity.trim() !== identity ||
        identity.length === 0) {
        throw workflowError('INTERVENTION_PERSISTENCE_ID_INVALID', 'Persistence identity must be a non-empty trimmed string.', ExitCode.usage);
    }
    return crypto
        .createHash('sha256')
        .update(`${kind}\0${identity}`)
        .digest('hex');
}
export function assertAbsoluteWorkspacePath(value) {
    if (typeof value !== 'string' ||
        !path.isAbsolute(value) ||
        path.resolve(value) !== value ||
        value === path.parse(value).root) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_PATH_INVALID', 'Workspace path must be an explicit normalized absolute path.', ExitCode.usage);
    }
    return value;
}
export function isPathInside(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return (relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative));
}
export function assertSafeChangeRef(value) {
    const hasControlOrSpace = typeof value === 'string' &&
        [...value].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x20 || codePoint === 0x7f;
        });
    if (typeof value !== 'string' ||
        !value.startsWith('refs/heads/') ||
        value.includes('..') ||
        value.includes('@{') ||
        value.includes('\\') ||
        value.includes('//') ||
        value.endsWith('/') ||
        value.endsWith('.lock') ||
        hasControlOrSpace ||
        /[~^:?*[\]]/.test(value)) {
        throw workflowError('INTERVENTION_CHILD_WORKSPACE_REF_INVALID', 'Child workspace metadata requires a safe branch ref.', ExitCode.usage);
    }
}
export function requireHumanVerifier(dependencies) {
    if (dependencies.verifyHumanSignature === undefined) {
        throw workflowError('INTERVENTION_PERSISTENCE_HUMAN_VERIFIER_REQUIRED', 'A trusted human signature verifier is required.', ExitCode.guard);
    }
    return dependencies.verifyHumanSignature;
}
export function persistenceNow(dependencies) {
    return exactDate(dependencies.now?.() ?? new Date(), 'INTERVENTION_PERSISTENCE_CLOCK_INVALID');
}
export function exactDate(value, code) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError(code, 'Persistence clock is invalid.', ExitCode.unsafeEnvironment);
    }
    return new Date(value.getTime());
}
export function exactIso(value, code) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value) {
        throw workflowError(code, 'Stored timestamp is invalid.', ExitCode.verification);
    }
}
export function assertDigest(value, code) {
    if (!isDigest(value)) {
        throw workflowError(code, 'Expected a canonical sha256 digest.', ExitCode.usage);
    }
}
export function isDigest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
export function isCanonicalIso(value) {
    return (typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
export function hasExactKeys(value, keys) {
    return (JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...keys].sort()));
}
export function isRecord(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
}
export function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
export function corruptPersistenceRecord() {
    return workflowError('INTERVENTION_PERSISTENCE_RECORD_CORRUPT', 'Persisted intervention record failed integrity verification.', ExitCode.verification);
}
export function adoptionRecordCorrupt() {
    return workflowError('INTERVENTION_ADOPTION_RECORD_CORRUPT', 'Persisted adoption record failed integrity verification.', ExitCode.verification);
}
export function controlUpdateRecordCorrupt() {
    return workflowError('INTERVENTION_CONTROL_UPDATE_RECORD_CORRUPT', 'Persisted minimal updater record failed integrity verification.', ExitCode.verification);
}
export function unsafePersistenceLock() {
    return workflowError('INTERVENTION_PERSISTENCE_LOCK_UNSAFE', 'Persistence operation lock is unsafe.', ExitCode.unsafeEnvironment);
}
