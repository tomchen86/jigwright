import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { agentRolePlanV2Digest, } from "./agent-role-plan.js";
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'];
const ROLE_PAIR_ORDER = [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
];
const ROLE_PAIR_MEMBERS = Object.freeze({
    'author-builder': Object.freeze(['author', 'builder']),
    'author-reviewer': Object.freeze(['author', 'reviewer']),
    'builder-reviewer': Object.freeze(['builder', 'reviewer']),
});
const INDEPENDENCE_RANK = Object.freeze({
    none: 0,
    'session-independent': 1,
    'provider-independent': 2,
});
/**
 * The current landed scheduler requires provider independence for every
 * ordinary Author/Builder/Reviewer boundary. This code-owned value records that
 * behavior as the compatibility floor; a per-change plan cannot mutate it.
 */
export const CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1 = deepFreeze({
    schemaVersion: 1,
    configurationId: 'workflow.central-role-topology.v1',
    pairwiseRequirements: [
        {
            pair: 'author-builder',
            required: 'provider-independent',
        },
        {
            pair: 'author-reviewer',
            required: 'provider-independent',
        },
        {
            pair: 'builder-reviewer',
            required: 'provider-independent',
        },
    ],
});
const ROLE_TOPOLOGY_ELIGIBILITY_POLICY_V1 = deepFreeze({
    schemaVersion: 1,
    policyId: 'workflow.role-topology-eligibility.v1',
    defaultEligibility: 'deny-unless-explicitly-listed',
    listingSource: 'agent-role-plan.grantReferences',
    authorityEffect: 'none',
    grantScope: 'exact-active-role-pair-set',
});
export const ROLE_TOPOLOGY_ELIGIBILITY_POLICY_DIGEST_V1 = sha256(canonicalJson(ROLE_TOPOLOGY_ELIGIBILITY_POLICY_V1));
/**
 * Resolve one observed role topology against the immutable central floor and
 * an optional per-change declaration. The result identifies grant scope and
 * eligibility evidence only; it never verifies, reserves, consumes, or grants
 * authority.
 */
export function resolveRoleTopologyV1(input) {
    if (!SAFE_ID.test(input.changeId) ||
        input.changeId === 'archive' ||
        !DIGEST.test(input.planningGeneration)) {
        throw topologyInvalid('Role-topology identity is invalid.');
    }
    const centralConfiguration = assertCentralConfiguration(input.centralConfiguration);
    const providerRegistry = assertProviderRegistry(input.providerRegistry);
    const actualPlacements = assertActualPlacements(input.actualPlacements, providerRegistry);
    const changeOverride = assertChangeOverride(input.changeOverride, input.changeId, input.baseCentralConfigurationDigest);
    const centralByPair = new Map(centralConfiguration.pairwiseRequirements.map((entry) => [
        entry.pair,
        entry.required,
    ]));
    const overrideByPair = new Map((changeOverride?.pairwiseRequirements ?? []).map((entry) => [
        entry.pair,
        entry.required,
    ]));
    const configuredRolePairs = Object.freeze(ROLE_PAIR_ORDER.map((pair) => Object.freeze({
        pair,
        required: overrideByPair.get(pair) ?? centralByPair.get(pair),
    })));
    const configuredByPair = new Map(configuredRolePairs.map((entry) => [entry.pair, entry.required]));
    const placementByRole = new Map(actualPlacements.map((placement) => [placement.role, placement]));
    const providerFamilyByLogicalId = new Map(providerRegistry.providers.map((entry) => [
        entry.logicalProviderId,
        entry.providerFamily,
    ]));
    const actualRolePairs = [];
    const exactGrantRolePairs = [];
    for (const pair of ROLE_PAIR_ORDER) {
        const [leftRole, rightRole] = ROLE_PAIR_MEMBERS[pair];
        const left = placementByRole.get(leftRole);
        const right = placementByRole.get(rightRole);
        if (left === undefined || right === undefined)
            continue;
        const centralRequired = centralByPair.get(pair);
        const required = configuredByPair.get(pair);
        const achieved = achievedIndependence(left, right, providerFamilyByLogicalId);
        if (INDEPENDENCE_RANK[achieved] < INDEPENDENCE_RANK[centralRequired]) {
            exactGrantRolePairs.push(pair);
        }
        actualRolePairs.push(Object.freeze({
            pair,
            required,
            achieved,
            left,
            right,
            meetsOrExceedsConfiguredTopology: INDEPENDENCE_RANK[achieved] >= INDEPENDENCE_RANK[required],
        }));
    }
    const grantReferences = Object.freeze([
        ...(changeOverride?.grantReferences ?? []),
    ]);
    const grantPairsAreExplicitlyAllowed = exactGrantRolePairs.every((pair) => {
        const overrideRequired = overrideByPair.get(pair);
        const actual = actualRolePairs.find((entry) => entry.pair === pair);
        return (overrideRequired !== undefined &&
            actual !== undefined &&
            INDEPENDENCE_RANK[actual.achieved] >= INDEPENDENCE_RANK[overrideRequired]);
    });
    const explicitEligibility = exactGrantRolePairs.length === 0
        ? Object.freeze({
            status: 'not-required',
            explicitlyListed: false,
            grantReferences: Object.freeze([]),
        })
        : grantPairsAreExplicitlyAllowed && grantReferences.length > 0
            ? Object.freeze({
                status: 'listed',
                explicitlyListed: true,
                grantReferences,
            })
            : Object.freeze({
                status: 'unlisted',
                explicitlyListed: false,
                grantReferences,
            });
    const hasTopologyMismatch = actualRolePairs.some(({ meetsOrExceedsConfiguredTopology }) => !meetsOrExceedsConfiguredTopology);
    const disposition = hasTopologyMismatch
        ? 'topology-unsatisfied'
        : exactGrantRolePairs.length > 0
            ? 'exact-grant-required'
            : 'satisfied';
    return deepFreeze({
        schemaVersion: 1,
        changeId: input.changeId,
        planningGeneration: input.planningGeneration,
        centralRoleConfigurationDigest: sha256(canonicalJson(centralConfiguration)),
        changeOverrideDigest: changeOverride?.planDigest ??
            sha256(canonicalJson({
                schemaVersion: 1,
                kind: 'no-agent-role-plan',
                changeId: input.changeId,
                planningGeneration: input.planningGeneration,
            })),
        providerRegistryDigest: sha256(canonicalJson(providerRegistry)),
        eligibilityPolicyDigest: ROLE_TOPOLOGY_ELIGIBILITY_POLICY_DIGEST_V1,
        configuredRolePairs,
        actualPlacements,
        actualRolePairs: Object.freeze(actualRolePairs),
        exactGrantRolePairs: Object.freeze(exactGrantRolePairs),
        explicitEligibility,
        disposition,
    });
}
function assertCentralConfiguration(value) {
    if (value?.schemaVersion !== 1 ||
        !SAFE_ID.test(value.configurationId) ||
        !Array.isArray(value.pairwiseRequirements) ||
        value.pairwiseRequirements.length !== ROLE_PAIR_ORDER.length) {
        throw topologyInvalid('Central role-topology configuration is invalid.');
    }
    const pairwiseRequirements = value.pairwiseRequirements.map((entry, index) => {
        if (entry?.pair !== ROLE_PAIR_ORDER[index] ||
            !isIndependenceRequirement(entry.required)) {
            throw topologyInvalid('Central role-topology pairs must be complete and canonical.');
        }
        return Object.freeze({ pair: entry.pair, required: entry.required });
    });
    return deepFreeze({
        schemaVersion: 1,
        configurationId: value.configurationId,
        pairwiseRequirements,
    });
}
function assertProviderRegistry(value) {
    if (value?.schemaVersion !== 1 ||
        !DIGEST.test(value.policyDigest) ||
        !Array.isArray(value.providers) ||
        value.providers.length === 0) {
        throw topologyInvalid('Role-topology provider registry is invalid.');
    }
    let previous = '';
    const providers = value.providers.map((entry) => {
        if (!SAFE_ID.test(entry?.logicalProviderId) ||
            !SAFE_ID.test(entry.providerFamily) ||
            typeof entry.enabled !== 'boolean' ||
            (entry.definitionDigest !== null &&
                !DIGEST.test(entry.definitionDigest)) ||
            entry.logicalProviderId <= previous) {
            throw topologyInvalid('Role-topology provider registry must be canonical and exact.');
        }
        previous = entry.logicalProviderId;
        return Object.freeze({
            logicalProviderId: entry.logicalProviderId,
            providerFamily: entry.providerFamily,
            enabled: entry.enabled,
            definitionDigest: entry.definitionDigest,
        });
    });
    return deepFreeze({
        schemaVersion: 1,
        policyDigest: value.policyDigest,
        providers,
    });
}
function assertActualPlacements(values, providerRegistry) {
    if (!Array.isArray(values) || values.length < 2 || values.length > 3) {
        throw topologyInvalid('Role topology requires two or three actual roles.');
    }
    const registryById = new Map(providerRegistry.providers.map((entry) => [entry.logicalProviderId, entry]));
    let previousRoleIndex = -1;
    const placements = values.map((value) => {
        const registryEntry = registryById.get(value?.logicalProviderId);
        const roleIndex = ROLE_ORDER.indexOf(value?.role);
        if (roleIndex <= previousRoleIndex ||
            !SAFE_ID.test(value.logicalProviderId) ||
            !DIGEST.test(value.providerDefinitionDigest) ||
            !isSafeSessionId(value.sessionId) ||
            registryEntry?.enabled !== true ||
            registryEntry?.definitionDigest !== value.providerDefinitionDigest) {
            throw topologyInvalid('Actual role placements must be canonical and registry-bound.');
        }
        previousRoleIndex = roleIndex;
        return Object.freeze({
            role: value.role,
            logicalProviderId: value.logicalProviderId,
            providerDefinitionDigest: value.providerDefinitionDigest,
            sessionId: value.sessionId,
        });
    });
    return Object.freeze(placements);
}
function assertChangeOverride(value, changeId, baseCentralConfigurationDigest) {
    if (value === null) {
        if (baseCentralConfigurationDigest !== null) {
            throw topologyInvalid('Per-change role-topology override identity is stale or invalid.');
        }
        return null;
    }
    const body = {
        schemaVersion: value.schemaVersion,
        changeId: value.changeId,
        baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
        roleLanes: value.roleLanes,
        pairwiseRequirements: value.pairwiseRequirements,
        customWrapperPolicy: value.customWrapperPolicy,
        grantReferences: value.grantReferences,
    };
    if (baseCentralConfigurationDigest === null ||
        !DIGEST.test(baseCentralConfigurationDigest) ||
        value.changeId !== changeId ||
        value.baseCentralConfigurationDigest !== baseCentralConfigurationDigest ||
        value.planDigest !== agentRolePlanV2Digest(body)) {
        throw topologyInvalid('Per-change role-topology override identity is stale or invalid.');
    }
    return value;
}
function achievedIndependence(left, right, providerFamilyByLogicalId) {
    const leftFamily = providerFamilyByLogicalId.get(left.logicalProviderId);
    const rightFamily = providerFamilyByLogicalId.get(right.logicalProviderId);
    if (leftFamily === undefined || rightFamily === undefined) {
        throw topologyInvalid('Actual role placement refers to an unknown provider family.');
    }
    if (leftFamily !== rightFamily) {
        return 'provider-independent';
    }
    if (left.sessionId !== right.sessionId)
        return 'session-independent';
    return 'none';
}
function isIndependenceRequirement(value) {
    return (value === 'provider-independent' ||
        value === 'session-independent' ||
        value === 'none');
}
function isSafeSessionId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\0\r\n]/u.test(value));
}
function topologyInvalid(message) {
    return workflowError('ROLE_TOPOLOGY_INVALID', message, ExitCode.verification);
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value))
            deepFreeze(nested);
    }
    return value;
}
