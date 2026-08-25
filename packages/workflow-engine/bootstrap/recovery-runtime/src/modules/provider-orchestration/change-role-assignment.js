import crypto from 'node:crypto';
import { assertAgentProviderConfigSnapshot, } from '@jigwright/agent-runtime';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { agentRolePlanV2Digest, } from "./agent-role-plan.js";
import { createCentralRoleProviderDefault, } from "./central-role-provider-default.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const LOGICAL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
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
const ROLE_CAPABILITIES = Object.freeze({
    author: Object.freeze([]),
    builder: Object.freeze(['task-implementation']),
    reviewer: Object.freeze([
        'plan-review',
        'task-diff-review',
    ]),
});
export function createChangeRoleAssignmentProtectedContextV1(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'classification',
            'pathRoleSourceDigest',
            'policySourceDigest',
            'inputManifestDigest',
            'relevantTargetDigest',
        ]) ||
        (value.classification !== 'ordinary' &&
            value.classification !== 'protected') ||
        !isDigest(value.pathRoleSourceDigest) ||
        !isDigest(value.policySourceDigest) ||
        !isDigest(value.inputManifestDigest) ||
        !isDigest(value.relevantTargetDigest)) {
        throw new TypeError('Role-assignment protected context fact is invalid.');
    }
    const body = {
        schemaVersion: 1,
        kind: 'change-role-assignment-protected-context',
        classification: value.classification,
        pathRoleSourceDigest: value.pathRoleSourceDigest,
        policySourceDigest: value.policySourceDigest,
        inputManifestDigest: value.inputManifestDigest,
        relevantTargetDigest: value.relevantTargetDigest,
    };
    return deepFreeze({
        ...body,
        contextDigest: sha256(`workflow.change-role-assignment-protected-context.v1\n${canonicalJson(body)}`),
    });
}
export function changeRoleAssignmentDataAuthorizationDigestV1(value) {
    return sha256(`workflow.change-role-assignment-data-authorization.v1\n${canonicalJson(value)}`);
}
/**
 * Resolve one exact Author/Builder/Reviewer topology without creating a native
 * provider session or conferring launch/grant authority. Eligibility is a hard
 * domain filter. Explicit logical-provider preference and central logical rank
 * are considered only after every provider, data, and session fact is admitted.
 */
export function resolveChangeRoleAssignmentV1(input) {
    assertIdentity(input);
    const central = assertCentralDefault(input.centralDefault);
    const providerConfiguration = assertAgentProviderConfigSnapshot(input.providerConfiguration);
    const override = assertChangeOverride(input.changeOverride, input.changeId, central.configurationDigest);
    const facts = assertFacts(input, providerConfiguration, override?.customWrapperPolicy ?? 'forbidden');
    const centralPairs = pairwiseFromCentral(central);
    const effectivePairs = Object.freeze({
        ...centralPairs,
        ...Object.fromEntries((override?.pairwiseRequirements ?? []).map(({ pair, required }) => [
            pair,
            required,
        ])),
    });
    const topology = exactGroupsFromPairwise(effectivePairs);
    if (topology === null) {
        return unsatisfied('ROLE_PROVIDER_TOPOLOGY_INVALID', []);
    }
    const effectiveGroups = applySelectionRules(topology, central, override?.roleLanes ?? []);
    if (effectiveGroups === null) {
        return unsatisfied('ROLE_PROVIDER_OVERRIDE_AMBIGUOUS', []);
    }
    const diagnostics = [];
    const domains = effectiveGroups.map((group) => createGroupDomain(group, input, facts, diagnostics));
    if (domains.some(({ candidates }) => candidates.length === 0)) {
        return unsatisfied(sessionFailure(diagnostics)
            ? 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED'
            : 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE', diagnostics);
    }
    const selected = solveDomains(domains, diagnostics);
    if (selected === null) {
        return unsatisfied(sessionFailure(diagnostics)
            ? 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED'
            : 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE', diagnostics);
    }
    const candidateByGroup = new Map(selected.map(({ group, candidate }) => [groupKey(group.roles), candidate]));
    const placements = ROLE_ORDER.map((role) => {
        const group = effectiveGroups.find(({ roles }) => roles.includes(role));
        const candidate = candidateByGroup.get(groupKey(group.roles));
        const session = candidate.sessions.find(({ roles }) => roles.includes(role));
        return Object.freeze({
            role,
            logicalProviderId: candidate.logicalProviderId,
            profileId: session.profileIdByRole[role],
            sessionSlotId: session.sessionSlotId,
            sessionMode: session.sessionMode,
            selectionReason: candidate.selectionReason,
            effectiveLogicalProviderRank: candidate.effectiveLogicalProviderRank,
            profileSelectionReason: session.sessionMode === 'caller-existing'
                ? 'caller-session'
                : 'host-global-ranking',
            effectiveProfileRank: effectiveProfileRank(providerConfiguration, candidate.logicalProviderId, session.profileIdByRole[role]),
        });
    });
    const exactGrantRolePairs = ROLE_PAIR_ORDER.filter((pair) => INDEPENDENCE_RANK[effectivePairs[pair]] <
        INDEPENDENCE_RANK[centralPairs[pair]]);
    const configuredPairwiseRequirements = ROLE_PAIR_ORDER.map((pair) => Object.freeze({ pair, required: effectivePairs[pair] }));
    const body = {
        schemaVersion: 1,
        kind: 'resolved-change-role-assignment',
        changeId: input.changeId,
        planningGeneration: input.planningGeneration,
        providerRegistryDigest: input.providerRegistryDigest,
        centralConfigurationDigest: central.configurationDigest,
        providerConfigurationDigest: providerConfiguration.configDigest,
        changeOverrideDigest: override?.planDigest ??
            sha256(`workflow.no-agent-role-plan.v1\n${canonicalJson({
                changeId: input.changeId,
                planningGeneration: input.planningGeneration,
            })}`),
        dataAuthorizationPolicyDigest: facts.dataAuthorization.policyDigest,
        dataAuthorizationInputManifestDigest: facts.dataAuthorization.inputManifestDigest,
        dataAuthorizationRelevantTargetDigest: facts.dataAuthorization.relevantTargetDigest,
        dataAuthorizationDecisionDigest: facts.dataAuthorizationDecisionDigest,
        protectedContext: facts.protectedContext,
        configuredPairwiseRequirements: Object.freeze(configuredPairwiseRequirements),
        placements: Object.freeze(placements),
        exactGrantRolePairs: Object.freeze(exactGrantRolePairs),
        diagnostics: normalizeDiagnostics(diagnostics),
    };
    const resolution = deepFreeze({
        ...body,
        resolutionDigest: sha256(`workflow.resolved-change-role-assignment.v1\n${canonicalJson(body)}`),
    });
    return exactGrantRolePairs.length === 0
        ? deepFreeze({ outcome: 'resolved', resolution })
        : deepFreeze({
            outcome: 'exact-grant-required',
            resolution,
            exactRolePairs: Object.freeze([...exactGrantRolePairs]),
        });
}
function assertIdentity(input) {
    if (!input ||
        !CHANGE_ID.test(input.changeId) ||
        input.changeId === 'archive' ||
        !DIGEST.test(input.planningGeneration) ||
        !DIGEST.test(input.providerRegistryDigest) ||
        !LOGICAL_PROVIDER_ID.test(input.caller?.logicalProviderId) ||
        (input.caller.profileId !== null &&
            typeof input.caller.profileId !== 'string') ||
        (input.caller.engineSessionId !== null &&
            (!input.caller.engineSessionId ||
                /[\0\r\n]/u.test(input.caller.engineSessionId))) ||
        !Array.isArray(input.caller.adoptableRoles) ||
        !isCanonicalRoles(input.caller.adoptableRoles)) {
        throw new TypeError('Change role-assignment input is invalid.');
    }
}
function assertCentralDefault(value) {
    const admitted = createCentralRoleProviderDefault({
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        providerGroups: value.providerGroups,
        globalProviderRanking: value.globalProviderRanking,
    });
    if (admitted.configurationDigest !== value.configurationDigest) {
        throw new TypeError('Central role/provider default is stale.');
    }
    return admitted;
}
function assertFacts(input, providerConfiguration, customWrapperPolicy) {
    const profileIds = providerConfiguration.providers.map(({ id }) => id);
    const dataAuthorization = assertDataAuthorization(input.dataAuthorization, providerConfiguration);
    const authorizationByProfile = exactProfileMap(dataAuthorization.profiles, profileIds, (entry) => typeof entry?.profileId === 'string' &&
        typeof entry.allowed === 'boolean' &&
        typeof entry.reason === 'string' &&
        entry.reason.length > 0);
    const sessionCapabilityByProfile = exactProfileMap(input.sessionCapabilities, profileIds, (entry) => typeof entry?.profileId === 'string' &&
        typeof entry.canStartFresh === 'boolean' &&
        typeof entry.canResume === 'boolean');
    const callerProfile = input.caller.profileId === null
        ? null
        : (providerConfiguration.providers.find(({ id }) => id === input.caller.profileId) ?? null);
    if (callerProfile !== null &&
        callerProfile.logicalProviderId !== input.caller.logicalProviderId) {
        throw new TypeError('Caller profile does not match its logical provider.');
    }
    const protectedContext = assertProtectedContext(input.protectedContext, customWrapperPolicy, dataAuthorization);
    return Object.freeze({
        providerConfiguration,
        dataAuthorization,
        dataAuthorizationDecisionDigest: changeRoleAssignmentDataAuthorizationDigestV1(dataAuthorization),
        authorizationByProfile,
        sessionCapabilityByProfile,
        callerProfile,
        protectedContext,
    });
}
function assertProtectedContext(value, customWrapperPolicy, dataAuthorization) {
    if (value === undefined) {
        if (customWrapperPolicy === 'allowed-non-protected') {
            throw new TypeError('An exact protected context fact is required for this wrapper policy.');
        }
        return null;
    }
    if (value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'classification',
            'pathRoleSourceDigest',
            'policySourceDigest',
            'inputManifestDigest',
            'relevantTargetDigest',
            'contextDigest',
        ])) {
        throw new TypeError('Role-assignment protected context fact is invalid.');
    }
    let admitted;
    try {
        admitted = createChangeRoleAssignmentProtectedContextV1({
            classification: value.classification,
            pathRoleSourceDigest: value.pathRoleSourceDigest,
            policySourceDigest: value.policySourceDigest,
            inputManifestDigest: value.inputManifestDigest,
            relevantTargetDigest: value.relevantTargetDigest,
        });
    }
    catch {
        throw new TypeError('Role-assignment protected context fact is invalid.');
    }
    if (admitted.contextDigest !== value.contextDigest ||
        admitted.inputManifestDigest !== dataAuthorization.inputManifestDigest ||
        admitted.relevantTargetDigest !== dataAuthorization.relevantTargetDigest) {
        throw new TypeError('Role-assignment protected context fact is invalid.');
    }
    return admitted;
}
function assertDataAuthorization(value, providerConfiguration) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'policyDigest',
            'inputManifestDigest',
            'relevantTargetDigest',
            'profiles',
        ]) ||
        !isDigest(value.policyDigest) ||
        !isNullableDigest(value.inputManifestDigest) ||
        !isNullableDigest(value.relevantTargetDigest) ||
        (value.inputManifestDigest === null) !==
            (value.relevantTargetDigest === null) ||
        !Array.isArray(value.profiles)) {
        throw new TypeError('Role-assignment data authorization is invalid.');
    }
    const profileIds = providerConfiguration.providers.map(({ id }) => id);
    const byProfile = exactProfileMap(value.profiles, profileIds, (entry) => typeof entry?.profileId === 'string' &&
        typeof entry.allowed === 'boolean' &&
        typeof entry.reason === 'string' &&
        entry.reason.length > 0);
    return deepFreeze({
        policyDigest: value.policyDigest,
        inputManifestDigest: value.inputManifestDigest,
        relevantTargetDigest: value.relevantTargetDigest,
        profiles: providerConfiguration.providers.map(({ id }) => {
            const entry = byProfile.get(id);
            return {
                profileId: id,
                allowed: entry.allowed,
                reason: entry.reason,
            };
        }),
    });
}
function exactProfileMap(values, expectedIds, validate) {
    if (!Array.isArray(values) || values.some((entry) => !validate(entry))) {
        throw new TypeError('Role-assignment provider facts are malformed.');
    }
    const map = new Map(values.map((entry) => [entry.profileId, entry]));
    if (map.size !== values.length ||
        canonicalJson([...map.keys()].sort()) !==
            canonicalJson([...expectedIds].sort())) {
        throw new TypeError('Role-assignment provider facts are incomplete.');
    }
    return map;
}
function assertChangeOverride(value, changeId, centralConfigurationDigest) {
    if (value === null)
        return null;
    if (typeof value !== 'object' ||
        Object.keys(value).length !== 8 ||
        ![
            'baseCentralConfigurationDigest',
            'changeId',
            'customWrapperPolicy',
            'grantReferences',
            'pairwiseRequirements',
            'planDigest',
            'roleLanes',
            'schemaVersion',
        ].every((key) => Object.hasOwn(value, key))) {
        throw new TypeError('Agent-role plan is stale.');
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
    let expectedDigest;
    try {
        expectedDigest = agentRolePlanV2Digest(body);
    }
    catch {
        throw new TypeError('Agent-role plan is stale.');
    }
    if (value.changeId !== changeId ||
        value.baseCentralConfigurationDigest !== centralConfigurationDigest ||
        value.planDigest !== expectedDigest) {
        throw new TypeError('Agent-role plan is stale.');
    }
    return deepFreeze(structuredClone({ ...body, planDigest: value.planDigest }));
}
function pairwiseFromCentral(central) {
    return Object.freeze(Object.fromEntries(ROLE_PAIR_ORDER.map((pair) => {
        const [left, right] = ROLE_PAIR_MEMBERS[pair];
        const leftProviderGroup = central.providerGroups.findIndex(({ roles }) => roles.includes(left));
        const rightProviderGroup = central.providerGroups.findIndex(({ roles }) => roles.includes(right));
        if (leftProviderGroup !== rightProviderGroup) {
            return [pair, 'provider-independent'];
        }
        const providerGroup = central.providerGroups[leftProviderGroup];
        const leftSessionGroup = providerGroup.sessionGroups.findIndex((roles) => roles.includes(left));
        const rightSessionGroup = providerGroup.sessionGroups.findIndex((roles) => roles.includes(right));
        return [
            pair,
            leftSessionGroup === rightSessionGroup
                ? 'none'
                : 'session-independent',
        ];
    })));
}
function exactGroupsFromPairwise(pairs) {
    const sameProvider = (left, right) => left === right ||
        requirementForRoles(pairs, left, right) !== 'provider-independent';
    const sameSession = (left, right) => left === right || requirementForRoles(pairs, left, right) === 'none';
    if (!isEquivalence(sameProvider) || !isEquivalence(sameSession))
        return null;
    for (const left of ROLE_ORDER) {
        for (const right of ROLE_ORDER) {
            if (sameSession(left, right) && !sameProvider(left, right))
                return null;
        }
    }
    const providerGroups = equivalenceGroups(ROLE_ORDER, sameProvider);
    return Object.freeze(providerGroups.map((roles) => Object.freeze({
        roles,
        sessionGroups: Object.freeze(equivalenceGroups(roles, (left, right) => sameSession(left, right))),
    })));
}
function requirementForRoles(pairs, left, right) {
    const pair = ROLE_PAIR_ORDER.find((candidate) => {
        const members = ROLE_PAIR_MEMBERS[candidate];
        return members.includes(left) && members.includes(right);
    });
    if (pair === undefined)
        return 'none';
    return pairs[pair];
}
function isEquivalence(related) {
    for (const left of ROLE_ORDER) {
        for (const middle of ROLE_ORDER) {
            for (const right of ROLE_ORDER) {
                if (related(left, middle) &&
                    related(middle, right) &&
                    !related(left, right)) {
                    return false;
                }
            }
        }
    }
    return true;
}
function equivalenceGroups(domain, related) {
    const remaining = new Set(domain);
    const groups = [];
    for (const role of domain) {
        if (!remaining.has(role))
            continue;
        const group = domain.filter((candidate) => remaining.has(candidate) && related(role, candidate));
        group.forEach((candidate) => remaining.delete(candidate));
        groups.push(group);
    }
    return Object.freeze(groups.map((group) => Object.freeze(group)));
}
function applySelectionRules(topology, central, lanes) {
    const laneByRole = new Map(lanes.map((lane) => [lane.role, lane]));
    const rankingIndex = new Map(central.globalProviderRanking.map((logicalProviderId, index) => [
        logicalProviderId,
        index,
    ]));
    const groups = [];
    for (const topologyGroup of topology) {
        const selectedLanes = topologyGroup.roles
            .map((role) => laneByRole.get(role))
            .filter((lane) => lane !== undefined);
        const scopeRules = selectedLanes.map(({ scopeRule }) => scopeRule);
        if (scopeRules.some((scopeRule) => scopeRule !== scopeRules[0])) {
            return null;
        }
        const preferredSets = selectedLanes
            .map(({ preferredLogicalProviderIds }) => preferredLogicalProviderIds)
            .filter((preferred) => preferred.length > 0);
        if (preferredSets.some((preferred) => canonicalJson(preferred) !== canonicalJson(preferredSets[0])) ||
            preferredSets.some((preferred) => preferred.some((logicalProviderId) => !rankingIndex.has(logicalProviderId)))) {
            return null;
        }
        const preferredLogicalProviderIds = preferredSets[0]
            ? [...preferredSets[0]].sort((left, right) => rankingIndex.get(left) - rankingIndex.get(right))
            : [];
        const centralRules = central.providerGroups
            .filter(({ roles }) => roles.some((role) => topologyGroup.roles.includes(role)))
            .map(({ providerRule }) => providerRule);
        let providerRule;
        if (preferredLogicalProviderIds.length > 0) {
            providerRule = Object.freeze({
                kind: 'ranked-fallback',
                preferredLogicalProviderId: preferredLogicalProviderIds[0],
            });
        }
        else {
            const adaptive = centralRules.some(({ kind }) => kind === 'adaptive-author');
            if (adaptive && topologyGroup.roles.includes('author')) {
                providerRule = Object.freeze({ kind: 'adaptive-author' });
            }
            else if (adaptive) {
                return null;
            }
            else if (centralRules.some((rule) => canonicalJson(rule) !== canonicalJson(centralRules[0]))) {
                return null;
            }
            else {
                providerRule = centralRules[0];
            }
        }
        const familyLists = selectedLanes
            .map(({ allowedProviderFamilies }) => allowedProviderFamilies)
            .filter((families) => families.length > 0);
        const allowedProviderFamilies = familyLists.length === 0
            ? null
            : familyLists.reduce((intersection, families) => intersection.filter((family) => families.includes(family)), familyLists[0]);
        if (allowedProviderFamilies?.length === 0)
            return null;
        groups.push(Object.freeze({
            roles: topologyGroup.roles,
            sessionGroups: topologyGroup.sessionGroups,
            providerRule,
            preferredLogicalProviderIds: Object.freeze(preferredLogicalProviderIds.length > 0
                ? preferredLogicalProviderIds
                : providerRule.kind === 'ranked-fallback' &&
                    providerRule.preferredLogicalProviderId !== null
                    ? [providerRule.preferredLogicalProviderId]
                    : []),
            allowedProviderFamilies: allowedProviderFamilies === null
                ? null
                : Object.freeze([...allowedProviderFamilies]),
        }));
    }
    return Object.freeze(groups);
}
function createGroupDomain(group, input, facts, diagnostics) {
    const rankedLogicalProviders = group.providerRule.kind === 'adaptive-author'
        ? [input.caller.logicalProviderId]
        : [
            ...group.preferredLogicalProviderIds,
            ...input.centralDefault.globalProviderRanking,
        ].filter((value, index, values) => values.indexOf(value) === index);
    const candidates = rankedLogicalProviders
        .map((logicalProviderId, effectiveLogicalProviderRank) => createGroupCandidate(group, logicalProviderId, group.providerRule.kind === 'adaptive-author'
        ? 'adaptive-caller'
        : group.preferredLogicalProviderIds.includes(logicalProviderId)
            ? 'named-preference'
            : 'global-fallback', effectiveLogicalProviderRank, input, facts, diagnostics))
        .filter((candidate) => candidate !== null);
    return Object.freeze({ group, candidates: Object.freeze(candidates) });
}
function createGroupCandidate(group, logicalProviderId, selectionReason, effectiveLogicalProviderRank, input, facts, diagnostics) {
    if (group.providerRule.kind === 'adaptive-author' &&
        logicalProviderId !== input.caller.logicalProviderId) {
        addDiagnostic(diagnostics, group, null, logicalProviderId, null, 'ADAPTIVE_CALLER_UNAVAILABLE');
        return null;
    }
    const profiles = facts.providerConfiguration.providers.filter((profile) => profile.logicalProviderId === logicalProviderId);
    const sessions = [];
    for (const roles of group.sessionGroups) {
        const sessionSlotId = `role-session-slot-${roles.join('-')}`;
        const callerExisting = group.providerRule.kind === 'adaptive-author' && roles.includes('author');
        if (callerExisting) {
            const session = callerSession(group, roles, sessionSlotId, input, facts, diagnostics);
            if (session === null)
                return null;
            sessions.push(session);
            continue;
        }
        const selectedProfile = selectFreshProfile(group, roles, sessionSlotId, logicalProviderId, profiles, input, facts, diagnostics);
        if (selectedProfile === null)
            return null;
        sessions.push(Object.freeze({
            roles,
            sessionSlotId,
            sessionMode: 'fresh',
            profileIdByRole: profileIdsByRole(roles, selectedProfile.id),
        }));
    }
    return Object.freeze({
        logicalProviderId,
        selectionReason,
        effectiveLogicalProviderRank,
        sessions: Object.freeze(sessions),
    });
}
function callerSession(group, roles, sessionSlotId, input, facts, diagnostics) {
    if (input.caller.engineSessionId === null) {
        addDiagnostic(diagnostics, group, sessionSlotId, input.caller.logicalProviderId, input.caller.profileId, 'CALLER_SESSION_UNAVAILABLE');
        return null;
    }
    const profile = facts.callerProfile;
    if (profile === null) {
        addDiagnostic(diagnostics, group, sessionSlotId, input.caller.logicalProviderId, input.caller.profileId, 'ADAPTIVE_CALLER_UNAVAILABLE');
        return null;
    }
    const additionalRoles = roles.filter((role) => role !== 'author');
    if (additionalRoles.some((role) => !input.caller.adoptableRoles.includes(role))) {
        addDiagnostic(diagnostics, group, sessionSlotId, input.caller.logicalProviderId, input.caller.profileId, 'CALLER_SESSION_NOT_ADOPTABLE');
        return null;
    }
    const rejection = rejectProfile(profile, group, roles, false, additionalRoles.length > 0, input, facts);
    if (rejection !== null) {
        addDiagnostic(diagnostics, group, sessionSlotId, input.caller.logicalProviderId, profile.id, rejection, rejection === 'DATA_AUTHORIZATION_DENIED'
            ? (facts.authorizationByProfile.get(profile.id)?.reason ?? null)
            : null);
        return null;
    }
    return Object.freeze({
        roles,
        sessionSlotId,
        sessionMode: 'caller-existing',
        profileIdByRole: profileIdsByRole(roles, profile.id),
    });
}
function selectFreshProfile(group, roles, sessionSlotId, logicalProviderId, profiles, input, facts, diagnostics) {
    if (profiles.length === 0) {
        addDiagnostic(diagnostics, group, sessionSlotId, logicalProviderId, null, 'LOGICAL_PROVIDER_UNAVAILABLE');
        return null;
    }
    const rank = new Map(facts.providerConfiguration.globalRanking.map((profileId, index) => [
        profileId,
        index,
    ]));
    const admitted = [];
    for (const profile of profiles) {
        const rejection = rejectProfile(profile, group, roles, true, roles.length > 1, input, facts);
        if (rejection === null)
            admitted.push(profile);
        else
            addDiagnostic(diagnostics, group, sessionSlotId, logicalProviderId, profile.id, rejection, rejection === 'DATA_AUTHORIZATION_DENIED'
                ? (facts.authorizationByProfile.get(profile.id)?.reason ?? null)
                : null);
    }
    admitted.sort((left, right) => rank.get(left.id) - rank.get(right.id));
    return admitted[0] ?? null;
}
function rejectProfile(profile, group, roles, requireFresh, requireResume, input, facts) {
    if (!profile.enabled)
        return 'PROFILE_DISABLED';
    if (group.allowedProviderFamilies !== null &&
        !group.allowedProviderFamilies.includes(profile.family)) {
        return 'PROVIDER_FAMILY_NOT_ALLOWED';
    }
    if (profile.trustTier === 'host-wrapper' &&
        !customWrapperAdmitted(input.changeOverride?.customWrapperPolicy ?? 'forbidden', facts.protectedContext)) {
        return 'CUSTOM_WRAPPER_FORBIDDEN';
    }
    if (facts.authorizationByProfile.get(profile.id)?.allowed !== true) {
        return 'DATA_AUTHORIZATION_DENIED';
    }
    const requiredCapabilities = new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role]));
    if ([...requiredCapabilities].some((capability) => !profile.capabilities.includes(capability))) {
        return 'ROLE_CAPABILITY_UNSUPPORTED';
    }
    const sessionCapability = facts.sessionCapabilityByProfile.get(profile.id);
    if (requireFresh &&
        (!profile.capabilities.includes('fresh-session') ||
            !sessionCapability.canStartFresh)) {
        return 'FRESH_SESSION_UNSUPPORTED';
    }
    if (requireResume &&
        (!profile.capabilities.includes('resumable-session') ||
            !sessionCapability.canResume)) {
        return 'RESUME_UNSUPPORTED';
    }
    return null;
}
function customWrapperAdmitted(policy, protectedContext) {
    if (policy === 'allowed')
        return true;
    if (policy === 'forbidden')
        return false;
    return protectedContext?.classification === 'ordinary';
}
function solveDomains(domains, diagnostics) {
    const ordered = [...domains].sort((left, right) => {
        const leftAdaptive = left.group.providerRule.kind === 'adaptive-author';
        const rightAdaptive = right.group.providerRule.kind === 'adaptive-author';
        if (leftAdaptive !== rightAdaptive)
            return leftAdaptive ? -1 : 1;
        return (ROLE_ORDER.indexOf(left.group.roles[0]) -
            ROLE_ORDER.indexOf(right.group.roles[0]));
    });
    const selected = [];
    const completeAssignments = [];
    const used = new Set();
    const visit = (index) => {
        if (index === ordered.length) {
            completeAssignments.push(Object.freeze(selected.map(({ group, candidate }) => Object.freeze({ group, candidate }))));
            return;
        }
        const domain = ordered[index];
        for (const candidate of domain.candidates) {
            if (used.has(candidate.logicalProviderId)) {
                addDiagnostic(diagnostics, domain.group, null, candidate.logicalProviderId, null, 'PROVIDER_BOUNDARY_CONFLICT');
                continue;
            }
            used.add(candidate.logicalProviderId);
            selected.push({ group: domain.group, candidate });
            visit(index + 1);
            selected.pop();
            used.delete(candidate.logicalProviderId);
        }
    };
    visit(0);
    completeAssignments.sort(compareCompleteAssignments);
    return completeAssignments[0] ?? null;
}
function compareCompleteAssignments(left, right) {
    const rankDifference = completeAssignmentRank(left) - completeAssignmentRank(right);
    if (rankDifference !== 0)
        return rankDifference;
    const leftTieBreak = completeAssignmentTieBreak(left);
    const rightTieBreak = completeAssignmentTieBreak(right);
    return leftTieBreak < rightTieBreak
        ? -1
        : leftTieBreak > rightTieBreak
            ? 1
            : 0;
}
function completeAssignmentRank(selected) {
    return selected.reduce((sum, { group, candidate }) => sum + candidate.effectiveLogicalProviderRank * group.roles.length, 0);
}
function completeAssignmentTieBreak(selected) {
    const candidateByRole = new Map();
    for (const { group, candidate } of selected) {
        for (const role of group.roles) {
            candidateByRole.set(role, Object.freeze({
                candidate,
                session: candidate.sessions.find(({ roles }) => roles.includes(role)),
            }));
        }
    }
    return canonicalJson(ROLE_ORDER.map((role) => {
        const placement = candidateByRole.get(role);
        return {
            role,
            logicalProviderId: placement.candidate.logicalProviderId,
            profileId: placement.session.profileIdByRole[role],
            sessionSlotId: placement.session.sessionSlotId,
        };
    }));
}
function profileIdsByRole(roles, profileId) {
    return Object.freeze({
        author: roles.includes('author') ? profileId : null,
        builder: roles.includes('builder') ? profileId : null,
        reviewer: roles.includes('reviewer') ? profileId : null,
    });
}
function effectiveProfileRank(providerConfiguration, logicalProviderId, profileId) {
    if (profileId === null)
        return null;
    const profileRank = new Map(providerConfiguration.globalRanking.map((id, index) => [id, index]));
    const logicalProfiles = providerConfiguration.providers
        .filter((profile) => profile.logicalProviderId === logicalProviderId)
        .sort((left, right) => profileRank.get(left.id) - profileRank.get(right.id));
    const rank = logicalProfiles.findIndex((profile) => profile.id === profileId);
    if (rank < 0) {
        throw new TypeError('Selected role-assignment profile is unavailable.');
    }
    return rank;
}
function addDiagnostic(diagnostics, group, sessionSlotId, logicalProviderId, profileId, reason, dataAuthorizationReason = null) {
    diagnostics.push(Object.freeze({
        providerGroup: groupKey(group.roles),
        sessionSlotId,
        logicalProviderId,
        profileId,
        reason,
        detail: diagnosticDetail(reason),
        dataAuthorizationReason,
    }));
}
function diagnosticDetail(reason) {
    const details = {
        ADAPTIVE_CALLER_UNAVAILABLE: 'Adaptive has no fallback outside the current caller.',
        CALLER_SESSION_NOT_ADOPTABLE: 'The caller session cannot adopt every configured role.',
        CALLER_SESSION_UNAVAILABLE: 'The caller has no engine-owned session handle.',
        CUSTOM_WRAPPER_FORBIDDEN: 'The per-change custom-wrapper policy rejects this profile.',
        DATA_AUTHORIZATION_DENIED: 'Repository data authorization rejects this profile.',
        FRESH_SESSION_UNSUPPORTED: 'A required additional fresh session is not proven.',
        LOGICAL_PROVIDER_UNAVAILABLE: 'No registered profile has this logical provider identity.',
        PROFILE_DISABLED: 'The host profile is disabled.',
        PROVIDER_BOUNDARY_CONFLICT: 'The logical provider is already used across a provider boundary.',
        PROVIDER_FAMILY_NOT_ALLOWED: 'The role-lane provider-family allowlist rejects this profile.',
        RESUME_UNSUPPORTED: 'Same-session role reuse has no proven resumable-session capability.',
        ROLE_CAPABILITY_UNSUPPORTED: 'The profile lacks one or more required role capabilities.',
    };
    return details[reason];
}
function normalizeDiagnostics(diagnostics) {
    const byCanonical = new Map(diagnostics.map((diagnostic) => [canonicalJson(diagnostic), diagnostic]));
    return Object.freeze([...byCanonical.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, diagnostic]) => diagnostic));
}
function sessionFailure(diagnostics) {
    return diagnostics.some(({ reason }) => [
        'CALLER_SESSION_NOT_ADOPTABLE',
        'CALLER_SESSION_UNAVAILABLE',
        'FRESH_SESSION_UNSUPPORTED',
        'RESUME_UNSUPPORTED',
    ].includes(reason));
}
function unsatisfied(code, diagnostics) {
    return deepFreeze({
        outcome: 'unsatisfied',
        code,
        diagnostics: normalizeDiagnostics(diagnostics),
    });
}
function groupKey(roles) {
    return roles.join('-');
}
function isCanonicalRoles(value) {
    return (value.every((role) => ROLE_ORDER.includes(role)) &&
        new Set(value).size === value.length &&
        value.every((role, index) => index === 0 ||
            ROLE_ORDER.indexOf(value[index - 1]) < ROLE_ORDER.indexOf(role)));
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isNullableDigest(value) {
    return value === null || isDigest(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    return (actual.length === expected.size && actual.every((key) => expected.has(key)));
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
