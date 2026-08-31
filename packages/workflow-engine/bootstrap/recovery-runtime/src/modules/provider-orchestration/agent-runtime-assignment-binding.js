import crypto from 'node:crypto';
import { assertAgentProviderProfileSnapshot, } from '@jigwright/agent-runtime';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
const DIGEST = /^[0-9a-f]{64}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export function createAgentRuntimeAssignmentBindingV1(input) {
    const payload = structuredClone(input);
    return assertAgentRuntimeAssignmentBindingV1({
        ...payload,
        bindingDigest: digest(payload),
    });
}
export function assertAgentRuntimeAssignmentBindingV1(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            'planningGeneration',
            'recordDigest',
            'assignmentDigest',
            'role',
            'logicalProviderId',
            'providerProfileId',
            'providerProfileSnapshot',
            'definitionDigest',
            'dataAuthorizationPolicyDigest',
            'assignmentManifestDigest',
            'inputManifestDigest',
            'targetDigest',
            'bindingDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'agent-runtime-assignment-binding.v1' ||
        typeof value.changeId !== 'string' ||
        !CHANGE_ID.test(value.changeId) ||
        value.changeId === 'archive' ||
        !['author', 'builder', 'reviewer'].includes(String(value.role)) ||
        typeof value.logicalProviderId !== 'string' ||
        value.logicalProviderId.length === 0 ||
        typeof value.providerProfileId !== 'string' ||
        value.providerProfileId.length === 0 ||
        [
            value.planningGeneration,
            value.recordDigest,
            value.assignmentDigest,
            value.definitionDigest,
            value.dataAuthorizationPolicyDigest,
            value.assignmentManifestDigest,
            value.inputManifestDigest,
            value.targetDigest,
            value.bindingDigest,
        ].some((candidate) => !isDigest(candidate))) {
        throw new TypeError('Agent Runtime assignment binding is invalid.');
    }
    let providerProfileSnapshot;
    try {
        if (!isRecord(value.providerProfileSnapshot) ||
            typeof value.providerProfileSnapshot.platform !== 'string') {
            throw new TypeError();
        }
        providerProfileSnapshot = assertAgentProviderProfileSnapshot(value.providerProfileSnapshot, value.providerProfileSnapshot.platform);
    }
    catch {
        throw new TypeError('Agent Runtime assignment binding is invalid.');
    }
    const payload = {
        ...value,
        providerProfileSnapshot,
    };
    delete payload.bindingDigest;
    if (providerProfileSnapshot.id !== value.providerProfileId ||
        digest(payload) !== value.bindingDigest) {
        throw new TypeError('Agent Runtime assignment binding is invalid.');
    }
    return deepFreeze(structuredClone({
        ...value,
        providerProfileSnapshot,
    }));
}
function digest(value) {
    return crypto
        .createHash('sha256')
        .update(`workflow.agent-runtime-assignment-binding.v1\n${canonicalJson(value)}`)
        .digest('hex');
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
