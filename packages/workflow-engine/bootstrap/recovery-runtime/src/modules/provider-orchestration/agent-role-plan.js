/**
 * Defines canonical agent role plans and their pinned snapshots.
 *
 * Invariants:
 * - Parsed role plans must use the canonical JSON encoding.
 */
import crypto from 'node:crypto';
import { canonicalJson, compareCanonicalStrings, } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { agentRolePlanV2Path } from "../source/planning-role-policy-paths.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_LOGICAL_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'];
const ROLE_PAIR_ORDER = [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
];
export function agentRolePlanV2Digest(value) {
    const body = assertAgentRolePlanBodyV2(value, value.changeId, value.baseCentralConfigurationDigest);
    return digestBodyV2(body);
}
export function renderAgentRolePlanV2(value) {
    const plan = assertAgentRolePlanV2(value, value.changeId, value.baseCentralConfigurationDigest);
    return `${JSON.stringify(plan, null, 2)}\n`;
}
export function parseAgentRolePlanV2(source, expectedChangeId, expectedBaseCentralConfigurationDigest) {
    let value;
    try {
        value = JSON.parse(source);
    }
    catch {
        throw planInvalid('Agent-role plan must be valid JSON.');
    }
    if (isRecord(value) &&
        Object.hasOwn(value, 'schemaVersion') &&
        value.schemaVersion !== 2) {
        throw workflowError('AGENT_ROLE_PLAN_VERSION_UNSUPPORTED', 'Agent-role plan schema version is not supported.', ExitCode.verification);
    }
    const plan = assertAgentRolePlanV2(value, expectedChangeId, expectedBaseCentralConfigurationDigest);
    if (source !== renderAgentRolePlanV2(plan)) {
        throw planInvalid('Agent-role plan must use the canonical JSON encoding.');
    }
    return plan;
}
/**
 * Bind canonical V2 plan bytes to their claimed commit/blob identities. This
 * constructor proves the cryptographic fields only; production membership is
 * established by the pinned repository reader and its revalidation port.
 */
export function createAgentRolePlanV2Snapshot(value) {
    return materializeAgentRolePlanV2Snapshot(value);
}
/** Validate snapshot binding only; repository membership requires its verifier. */
export function assertAgentRolePlanV2Snapshot(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'artifactPath',
            'blobObjectId',
            'kind',
            'pinnedCommit',
            'plan',
            'planDigest',
            'schemaVersion',
            'snapshotDigest',
            'sourceDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'agent-role-plan-v2-snapshot' ||
        typeof value.pinnedCommit !== 'string' ||
        !FULL_OBJECT_ID.test(value.pinnedCommit) ||
        typeof value.blobObjectId !== 'string' ||
        typeof value.sourceDigest !== 'string' ||
        !DIGEST.test(value.sourceDigest) ||
        typeof value.planDigest !== 'string' ||
        !DIGEST.test(value.planDigest) ||
        typeof value.snapshotDigest !== 'string' ||
        !DIGEST.test(value.snapshotDigest) ||
        !isRecord(value.plan)) {
        throw planInvalid('Agent-role plan snapshot is invalid.');
    }
    const expected = materializeAgentRolePlanV2Snapshot({
        pinnedCommit: value.pinnedCommit,
        blobObjectId: value.blobObjectId,
        plan: value.plan,
    });
    if (canonicalJson(value) !== canonicalJson(expected)) {
        throw planInvalid('Agent-role plan snapshot binding does not match.');
    }
    return expected;
}
function materializeAgentRolePlanV2Snapshot(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['blobObjectId', 'pinnedCommit', 'plan']) ||
        typeof value.pinnedCommit !== 'string' ||
        !FULL_OBJECT_ID.test(value.pinnedCommit) ||
        typeof value.blobObjectId !== 'string' ||
        !isRecord(value.plan)) {
        throw planInvalid('Agent-role plan snapshot identity is invalid.');
    }
    const plan = assertAgentRolePlanV2(value.plan, String(value.plan.changeId), String(value.plan.baseCentralConfigurationDigest));
    const source = renderAgentRolePlanV2(plan);
    const objectFormat = value.pinnedCommit.length === 40 ? 'sha1' : 'sha256';
    const blobObjectId = crypto
        .createHash(objectFormat)
        .update(`blob ${Buffer.byteLength(source)}\0`)
        .update(source)
        .digest('hex');
    if (value.blobObjectId !== blobObjectId) {
        throw planInvalid('Agent-role plan snapshot blob does not match.');
    }
    const body = {
        schemaVersion: 1,
        kind: 'agent-role-plan-v2-snapshot',
        pinnedCommit: value.pinnedCommit,
        artifactPath: agentRolePlanV2Path(plan.changeId),
        blobObjectId,
        sourceDigest: crypto.createHash('sha256').update(source).digest('hex'),
        planDigest: plan.planDigest,
        plan,
    };
    return deepFreeze({
        ...body,
        snapshotDigest: crypto
            .createHash('sha256')
            .update(`workflow.agent-role-plan-v2-snapshot.v1\n${canonicalJson(body)}`)
            .digest('hex'),
    });
}
function assertAgentRolePlanV2(value, expectedChangeId, expectedBaseCentralConfigurationDigest) {
    if (!isRecord(value)) {
        throw planInvalid('Agent-role plan must be one object.');
    }
    assertExactKeys(value, [
        'baseCentralConfigurationDigest',
        'changeId',
        'customWrapperPolicy',
        'grantReferences',
        'pairwiseRequirements',
        'planDigest',
        'roleLanes',
        'schemaVersion',
    ]);
    const body = assertAgentRolePlanBodyV2({
        schemaVersion: value.schemaVersion,
        changeId: value.changeId,
        baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
        roleLanes: value.roleLanes,
        pairwiseRequirements: value.pairwiseRequirements,
        customWrapperPolicy: value.customWrapperPolicy,
        grantReferences: value.grantReferences,
    }, expectedChangeId, expectedBaseCentralConfigurationDigest);
    if (typeof value.planDigest !== 'string' ||
        !DIGEST.test(value.planDigest) ||
        value.planDigest !== digestBodyV2(body)) {
        throw planInvalid('Agent-role plan digest does not match its exact body.');
    }
    return Object.freeze({ ...body, planDigest: value.planDigest });
}
function assertAgentRolePlanBodyV2(value, expectedChangeId, expectedBaseCentralConfigurationDigest) {
    if (!CHANGE_ID.test(expectedChangeId) ||
        expectedChangeId === 'archive' ||
        !DIGEST.test(expectedBaseCentralConfigurationDigest) ||
        !isRecord(value)) {
        throw planInvalid('Agent-role plan identity is invalid.');
    }
    assertExactKeys(value, [
        'baseCentralConfigurationDigest',
        'changeId',
        'customWrapperPolicy',
        'grantReferences',
        'pairwiseRequirements',
        'roleLanes',
        'schemaVersion',
    ]);
    if (value.schemaVersion !== 2 ||
        value.changeId !== expectedChangeId ||
        value.baseCentralConfigurationDigest !==
            expectedBaseCentralConfigurationDigest ||
        !Array.isArray(value.roleLanes) ||
        value.roleLanes.length > ROLE_ORDER.length ||
        !Array.isArray(value.pairwiseRequirements) ||
        value.pairwiseRequirements.length > ROLE_PAIR_ORDER.length ||
        !isCustomWrapperPolicy(value.customWrapperPolicy)) {
        throw planInvalid('Agent-role plan fields are invalid.');
    }
    const roleLanes = value.roleLanes.map(assertRoleLane);
    assertCanonicalEnumOrder(roleLanes.map(({ role }) => role), ROLE_ORDER);
    const pairwiseRequirements = value.pairwiseRequirements.map(assertPairwiseRequirement);
    assertCanonicalEnumOrder(pairwiseRequirements.map(({ pair }) => pair), ROLE_PAIR_ORDER);
    const grantReferences = assertCanonicalLogicalIds(value.grantReferences);
    return Object.freeze({
        schemaVersion: 2,
        changeId: value.changeId,
        baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
        roleLanes: Object.freeze(roleLanes),
        pairwiseRequirements: Object.freeze(pairwiseRequirements),
        customWrapperPolicy: value.customWrapperPolicy,
        grantReferences,
    });
}
function assertRoleLane(value) {
    if (!isRecord(value)) {
        throw planInvalid('Agent-role lane must be one object.');
    }
    assertExactKeys(value, [
        'allowedProviderFamilies',
        'preferredLogicalProviderIds',
        'role',
        'scopeRule',
    ]);
    if (!isAgentRole(value.role) || !isScopeRule(value.scopeRule)) {
        throw planInvalid('Agent-role lane fields are invalid.');
    }
    return Object.freeze({
        role: value.role,
        scopeRule: value.scopeRule,
        allowedProviderFamilies: assertCanonicalLogicalIds(value.allowedProviderFamilies),
        preferredLogicalProviderIds: assertCanonicalLogicalIds(value.preferredLogicalProviderIds),
    });
}
function assertPairwiseRequirement(value) {
    if (!isRecord(value)) {
        throw planInvalid('Agent-role pairwise requirement must be one object.');
    }
    assertExactKeys(value, ['pair', 'required']);
    if (!isAgentRolePair(value.pair) || !isRequirement(value.required)) {
        throw planInvalid('Agent-role pairwise requirement fields are invalid.');
    }
    return Object.freeze({ pair: value.pair, required: value.required });
}
function assertCanonicalLogicalIds(value) {
    if (!Array.isArray(value)) {
        throw planInvalid('Agent-role logical identifiers must be one array.');
    }
    const identifiers = value.map((candidate) => {
        if (typeof candidate !== 'string' ||
            !SAFE_LOGICAL_ID.test(candidate) ||
            candidate.includes('..')) {
            throw planInvalid('Agent-role logical identifier is unsafe.');
        }
        return candidate;
    });
    for (let index = 1; index < identifiers.length; index += 1) {
        if (compareCanonicalStrings(identifiers[index - 1], identifiers[index]) >= 0) {
            throw planInvalid('Agent-role logical identifiers must be unique and canonically sorted.');
        }
    }
    return Object.freeze(identifiers);
}
function assertCanonicalEnumOrder(values, canonicalOrder) {
    let previous = -1;
    for (const value of values) {
        const current = canonicalOrder.indexOf(value);
        if (current <= previous) {
            throw planInvalid('Agent-role entries must be unique and in canonical order.');
        }
        previous = current;
    }
}
function digestBodyV2(value) {
    return crypto
        .createHash('sha256')
        .update('agent-role-plan-v2\0')
        .update(canonicalJson(value))
        .digest('hex');
}
function assertExactKeys(value, expected) {
    const actual = Object.keys(value).sort(compareCanonicalStrings);
    const required = [...expected].sort(compareCanonicalStrings);
    if (actual.length !== required.length ||
        actual.some((key, index) => key !== required[index])) {
        throw planInvalid('Agent-role plan fields are not exact.');
    }
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort(compareCanonicalStrings);
    const required = [...expected].sort(compareCanonicalStrings);
    return (actual.length === required.length &&
        actual.every((key, index) => key === required[index]));
}
function isAgentRole(value) {
    return ROLE_ORDER.some((role) => role === value);
}
function isAgentRolePair(value) {
    return ROLE_PAIR_ORDER.some((pair) => pair === value);
}
function isScopeRule(value) {
    return (value === 'planning-generation' || value === 'task' || value === 'candidate');
}
function isRequirement(value) {
    return (value === 'provider-independent' ||
        value === 'session-independent' ||
        value === 'none');
}
function isCustomWrapperPolicy(value) {
    return (value === 'forbidden' ||
        value === 'allowed-non-protected' ||
        value === 'allowed');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
function planInvalid(message) {
    return workflowError('AGENT_ROLE_PLAN_INVALID', message, ExitCode.verification);
}
