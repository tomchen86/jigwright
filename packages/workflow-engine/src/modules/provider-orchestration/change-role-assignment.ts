import crypto from 'node:crypto';

import {
  assertAgentProviderConfigSnapshot,
  type AgentProviderCapability,
  type AgentProviderConfigSnapshot,
  type AgentProviderProfileSnapshot,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  agentRolePlanV2Digest,
  type AgentRole,
  type AgentRoleIndependenceRequirement,
  type AgentRoleLaneV1,
  type AgentRolePair,
  type AgentRolePlanBodyV2,
  type CurrentAgentRolePlan,
} from './agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  type CentralProviderRuleV1,
  type CentralRoleProviderDefaultV1,
} from './central-role-provider-default.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const LOGICAL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'] as const;
const ROLE_PAIR_ORDER = [
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const;
const ROLE_PAIR_MEMBERS: Readonly<
  Record<AgentRolePair, readonly [AgentRole, AgentRole]>
> = Object.freeze({
  'author-builder': Object.freeze(['author', 'builder'] as const),
  'author-reviewer': Object.freeze(['author', 'reviewer'] as const),
  'builder-reviewer': Object.freeze(['builder', 'reviewer'] as const),
});
const INDEPENDENCE_RANK: Readonly<
  Record<AgentRoleIndependenceRequirement, number>
> = Object.freeze({
  none: 0,
  'session-independent': 1,
  'provider-independent': 2,
});
const ROLE_CAPABILITIES: Readonly<
  Record<AgentRole, readonly AgentProviderCapability[]>
> = Object.freeze({
  author: Object.freeze([] as AgentProviderCapability[]),
  builder: Object.freeze(['task-implementation'] as AgentProviderCapability[]),
  reviewer: Object.freeze([
    'plan-review',
    'task-diff-review',
  ] as AgentProviderCapability[]),
});

export type ChangeRoleAssignmentDataAuthorizationV1 = Readonly<{
  policyDigest: string;
  inputManifestDigest: string | null;
  relevantTargetDigest: string | null;
  profiles: readonly Readonly<{
    profileId: string;
    allowed: boolean;
    reason: string;
  }>[];
}>;

export type ChangeRoleAssignmentSessionCapabilityV1 = Readonly<{
  profileId: string;
  canStartFresh: boolean;
  canResume: boolean;
}>;

export type ChangeRoleAssignmentCallerV1 = Readonly<{
  logicalProviderId: string;
  profileId: string | null;
  engineSessionId: string | null;
  adoptableRoles: readonly AgentRole[];
}>;

export type ChangeRoleAssignmentProtectedContextV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-protected-context';
  classification: 'ordinary' | 'protected';
  pathRoleSourceDigest: string;
  policySourceDigest: string;
  inputManifestDigest: string;
  relevantTargetDigest: string;
  contextDigest: string;
}>;

export type ChangeRoleAssignmentDataAuthorizationVerifierPort = (
  snapshot: ChangeRoleAssignmentDataAuthorizationV1,
) => ChangeRoleAssignmentDataAuthorizationV1;

export type ChangeRoleAssignmentProtectedContextVerifierPort = (
  context: ChangeRoleAssignmentProtectedContextV1,
) => ChangeRoleAssignmentProtectedContextV1;

export type ResolveChangeRoleAssignmentInputV1 = Readonly<{
  changeId: string;
  planningGeneration: string;
  providerRegistryDigest: string;
  centralDefault: CentralRoleProviderDefaultV1;
  changeOverride: CurrentAgentRolePlan | null;
  providerConfiguration: AgentProviderConfigSnapshot;
  caller: ChangeRoleAssignmentCallerV1;
  dataAuthorization: ChangeRoleAssignmentDataAuthorizationV1;
  sessionCapabilities: readonly ChangeRoleAssignmentSessionCapabilityV1[];
  protectedContext?: ChangeRoleAssignmentProtectedContextV1;
}>;

export type ChangeRoleAssignmentDiagnosticReasonV1 =
  | 'ADAPTIVE_CALLER_UNAVAILABLE'
  | 'CALLER_SESSION_NOT_ADOPTABLE'
  | 'CALLER_SESSION_UNAVAILABLE'
  | 'CUSTOM_WRAPPER_FORBIDDEN'
  | 'DATA_AUTHORIZATION_DENIED'
  | 'FRESH_SESSION_UNSUPPORTED'
  | 'LOGICAL_PROVIDER_UNAVAILABLE'
  | 'PROFILE_DISABLED'
  | 'PROVIDER_BOUNDARY_CONFLICT'
  | 'PROVIDER_FAMILY_NOT_ALLOWED'
  | 'RESUME_UNSUPPORTED'
  | 'ROLE_CAPABILITY_UNSUPPORTED';

export type ChangeRoleAssignmentDiagnosticV1 = Readonly<{
  providerGroup: string;
  sessionSlotId: string | null;
  logicalProviderId: string | null;
  profileId: string | null;
  reason: ChangeRoleAssignmentDiagnosticReasonV1;
  detail: string;
  dataAuthorizationReason: string | null;
}>;

export type ResolvedRolePlacementV1 = Readonly<{
  role: AgentRole;
  logicalProviderId: string;
  profileId: string | null;
  sessionSlotId: string;
  sessionMode: 'caller-existing' | 'fresh';
  selectionReason: 'adaptive-caller' | 'named-preference' | 'global-fallback';
  effectiveLogicalProviderRank: number;
  profileSelectionReason: 'caller-session' | 'host-global-ranking';
  effectiveProfileRank: number | null;
}>;

export type ResolvedChangeRoleAssignmentV1 = Readonly<{
  schemaVersion: 1;
  kind: 'resolved-change-role-assignment';
  changeId: string;
  planningGeneration: string;
  providerRegistryDigest: string;
  centralConfigurationDigest: string;
  providerConfigurationDigest: string;
  changeOverrideDigest: string;
  dataAuthorizationPolicyDigest: string;
  dataAuthorizationInputManifestDigest: string | null;
  dataAuthorizationRelevantTargetDigest: string | null;
  dataAuthorizationDecisionDigest: string;
  protectedContext: ChangeRoleAssignmentProtectedContextV1 | null;
  configuredPairwiseRequirements: readonly Readonly<{
    pair: AgentRolePair;
    required: AgentRoleIndependenceRequirement;
  }>[];
  placements: readonly ResolvedRolePlacementV1[];
  exactGrantRolePairs: readonly AgentRolePair[];
  diagnostics: readonly ChangeRoleAssignmentDiagnosticV1[];
  resolutionDigest: string;
}>;

export type ResolveChangeRoleAssignmentResultV1 =
  | Readonly<{
      outcome: 'resolved';
      resolution: ResolvedChangeRoleAssignmentV1;
    }>
  | Readonly<{
      outcome: 'exact-grant-required';
      resolution: ResolvedChangeRoleAssignmentV1;
      exactRolePairs: readonly AgentRolePair[];
    }>
  | Readonly<{
      outcome: 'unsatisfied';
      code:
        | 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE'
        | 'ROLE_PROVIDER_OVERRIDE_AMBIGUOUS'
        | 'ROLE_PROVIDER_TOPOLOGY_INVALID'
        | 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED';
      diagnostics: readonly ChangeRoleAssignmentDiagnosticV1[];
    }>;

type PairwiseTable = Readonly<
  Record<AgentRolePair, AgentRoleIndependenceRequirement>
>;

type EffectiveProviderGroup = Readonly<{
  roles: readonly AgentRole[];
  sessionGroups: readonly (readonly AgentRole[])[];
  providerRule: CentralProviderRuleV1;
  preferredLogicalProviderIds: readonly string[];
  allowedProviderFamilies: readonly string[] | null;
}>;

type SelectedSessionSlot = Readonly<{
  roles: readonly AgentRole[];
  sessionSlotId: string;
  sessionMode: 'caller-existing' | 'fresh';
  profileIdByRole: Readonly<Record<AgentRole, string | null>>;
}>;

type GroupCandidate = Readonly<{
  logicalProviderId: string;
  selectionReason: 'adaptive-caller' | 'named-preference' | 'global-fallback';
  effectiveLogicalProviderRank: number;
  sessions: readonly SelectedSessionSlot[];
}>;

type GroupDomain = Readonly<{
  group: EffectiveProviderGroup;
  candidates: readonly GroupCandidate[];
}>;

type ValidatedFacts = Readonly<{
  providerConfiguration: AgentProviderConfigSnapshot;
  dataAuthorization: ChangeRoleAssignmentDataAuthorizationV1;
  dataAuthorizationDecisionDigest: string;
  authorizationByProfile: ReadonlyMap<
    string,
    ChangeRoleAssignmentDataAuthorizationV1['profiles'][number]
  >;
  sessionCapabilityByProfile: ReadonlyMap<
    string,
    ChangeRoleAssignmentSessionCapabilityV1
  >;
  callerProfile: AgentProviderProfileSnapshot | null;
  protectedContext: ChangeRoleAssignmentProtectedContextV1 | null;
}>;

export function createChangeRoleAssignmentProtectedContextV1(
  value: Readonly<{
    classification: 'ordinary' | 'protected';
    pathRoleSourceDigest: string;
    policySourceDigest: string;
    inputManifestDigest: string;
    relevantTargetDigest: string;
  }>,
): ChangeRoleAssignmentProtectedContextV1 {
  if (
    !isRecord(value) ||
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
    !isDigest(value.relevantTargetDigest)
  ) {
    throw new TypeError('Role-assignment protected context fact is invalid.');
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'change-role-assignment-protected-context' as const,
    classification: value.classification,
    pathRoleSourceDigest: value.pathRoleSourceDigest,
    policySourceDigest: value.policySourceDigest,
    inputManifestDigest: value.inputManifestDigest,
    relevantTargetDigest: value.relevantTargetDigest,
  };
  return deepFreeze({
    ...body,
    contextDigest: sha256(
      `workflow.change-role-assignment-protected-context.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function changeRoleAssignmentDataAuthorizationDigestV1(
  value: ChangeRoleAssignmentDataAuthorizationV1,
): string {
  return sha256(
    `workflow.change-role-assignment-data-authorization.v1\n${canonicalJson(value)}`,
  );
}

/**
 * Resolve one exact Author/Builder/Reviewer topology without creating a native
 * provider session or conferring launch/grant authority. Eligibility is a hard
 * domain filter. Explicit logical-provider preference and central logical rank
 * are considered only after every provider, data, and session fact is admitted.
 */
export function resolveChangeRoleAssignmentV1(
  input: ResolveChangeRoleAssignmentInputV1,
): ResolveChangeRoleAssignmentResultV1 {
  assertIdentity(input);
  const central = assertCentralDefault(input.centralDefault);
  const providerConfiguration = assertAgentProviderConfigSnapshot(
    input.providerConfiguration,
  );
  const override = assertChangeOverride(
    input.changeOverride,
    input.changeId,
    central.configurationDigest,
  );
  const facts = assertFacts(
    input,
    providerConfiguration,
    override?.customWrapperPolicy ?? 'forbidden',
  );
  const centralPairs = pairwiseFromCentral(central);
  const effectivePairs: PairwiseTable = Object.freeze({
    ...centralPairs,
    ...Object.fromEntries(
      (override?.pairwiseRequirements ?? []).map(({ pair, required }) => [
        pair,
        required,
      ]),
    ),
  }) as PairwiseTable;
  const topology = exactGroupsFromPairwise(effectivePairs);
  if (topology === null) {
    return unsatisfied('ROLE_PROVIDER_TOPOLOGY_INVALID', []);
  }

  const effectiveGroups = applySelectionRules(
    topology,
    central,
    override?.roleLanes ?? [],
  );
  if (effectiveGroups === null) {
    return unsatisfied('ROLE_PROVIDER_OVERRIDE_AMBIGUOUS', []);
  }

  const diagnostics: ChangeRoleAssignmentDiagnosticV1[] = [];
  const domains = effectiveGroups.map((group) =>
    createGroupDomain(group, input, facts, diagnostics),
  );
  if (domains.some(({ candidates }) => candidates.length === 0)) {
    return unsatisfied(
      sessionFailure(diagnostics)
        ? 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED'
        : 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE',
      diagnostics,
    );
  }

  const selected = solveDomains(domains, diagnostics);
  if (selected === null) {
    return unsatisfied(
      sessionFailure(diagnostics)
        ? 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED'
        : 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE',
      diagnostics,
    );
  }

  const candidateByGroup = new Map(
    selected.map(({ group, candidate }) => [groupKey(group.roles), candidate]),
  );
  const placements = ROLE_ORDER.map((role) => {
    const group = effectiveGroups.find(({ roles }) => roles.includes(role))!;
    const candidate = candidateByGroup.get(groupKey(group.roles))!;
    const session = candidate.sessions.find(({ roles }) =>
      roles.includes(role),
    )!;
    return Object.freeze({
      role,
      logicalProviderId: candidate.logicalProviderId,
      profileId: session.profileIdByRole[role],
      sessionSlotId: session.sessionSlotId,
      sessionMode: session.sessionMode,
      selectionReason: candidate.selectionReason,
      effectiveLogicalProviderRank: candidate.effectiveLogicalProviderRank,
      profileSelectionReason:
        session.sessionMode === 'caller-existing'
          ? ('caller-session' as const)
          : ('host-global-ranking' as const),
      effectiveProfileRank: effectiveProfileRank(
        providerConfiguration,
        candidate.logicalProviderId,
        session.profileIdByRole[role],
      ),
    });
  });
  const exactGrantRolePairs = ROLE_PAIR_ORDER.filter(
    (pair) =>
      INDEPENDENCE_RANK[effectivePairs[pair]] <
      INDEPENDENCE_RANK[centralPairs[pair]],
  );
  const configuredPairwiseRequirements = ROLE_PAIR_ORDER.map((pair) =>
    Object.freeze({ pair, required: effectivePairs[pair] }),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'resolved-change-role-assignment' as const,
    changeId: input.changeId,
    planningGeneration: input.planningGeneration,
    providerRegistryDigest: input.providerRegistryDigest,
    centralConfigurationDigest: central.configurationDigest,
    providerConfigurationDigest: providerConfiguration.configDigest,
    changeOverrideDigest:
      override?.planDigest ??
      sha256(
        `workflow.no-agent-role-plan.v1\n${canonicalJson({
          changeId: input.changeId,
          planningGeneration: input.planningGeneration,
        })}`,
      ),
    dataAuthorizationPolicyDigest: facts.dataAuthorization.policyDigest,
    dataAuthorizationInputManifestDigest:
      facts.dataAuthorization.inputManifestDigest,
    dataAuthorizationRelevantTargetDigest:
      facts.dataAuthorization.relevantTargetDigest,
    dataAuthorizationDecisionDigest: facts.dataAuthorizationDecisionDigest,
    protectedContext: facts.protectedContext,
    configuredPairwiseRequirements: Object.freeze(
      configuredPairwiseRequirements,
    ),
    placements: Object.freeze(placements),
    exactGrantRolePairs: Object.freeze(exactGrantRolePairs),
    diagnostics: normalizeDiagnostics(diagnostics),
  };
  const resolution = deepFreeze({
    ...body,
    resolutionDigest: sha256(
      `workflow.resolved-change-role-assignment.v1\n${canonicalJson(body)}`,
    ),
  });
  return exactGrantRolePairs.length === 0
    ? deepFreeze({ outcome: 'resolved' as const, resolution })
    : deepFreeze({
        outcome: 'exact-grant-required' as const,
        resolution,
        exactRolePairs: Object.freeze([...exactGrantRolePairs]),
      });
}

function assertIdentity(input: ResolveChangeRoleAssignmentInputV1): void {
  if (
    !input ||
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
    !isCanonicalRoles(input.caller.adoptableRoles)
  ) {
    throw new TypeError('Change role-assignment input is invalid.');
  }
}

function assertCentralDefault(
  value: CentralRoleProviderDefaultV1,
): CentralRoleProviderDefaultV1 {
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

function assertFacts(
  input: ResolveChangeRoleAssignmentInputV1,
  providerConfiguration: AgentProviderConfigSnapshot,
  customWrapperPolicy: CurrentAgentRolePlan['customWrapperPolicy'],
): ValidatedFacts {
  const profileIds = providerConfiguration.providers.map(({ id }) => id);
  const dataAuthorization = assertDataAuthorization(
    input.dataAuthorization,
    providerConfiguration,
  );
  const authorizationByProfile = exactProfileMap(
    dataAuthorization.profiles,
    profileIds,
    (entry) =>
      typeof entry?.profileId === 'string' &&
      typeof entry.allowed === 'boolean' &&
      typeof entry.reason === 'string' &&
      entry.reason.length > 0,
  );
  const sessionCapabilityByProfile = exactProfileMap(
    input.sessionCapabilities,
    profileIds,
    (entry) =>
      typeof entry?.profileId === 'string' &&
      typeof entry.canStartFresh === 'boolean' &&
      typeof entry.canResume === 'boolean',
  );
  const callerProfile =
    input.caller.profileId === null
      ? null
      : (providerConfiguration.providers.find(
          ({ id }) => id === input.caller.profileId,
        ) ?? null);
  if (
    callerProfile !== null &&
    callerProfile.logicalProviderId !== input.caller.logicalProviderId
  ) {
    throw new TypeError('Caller profile does not match its logical provider.');
  }
  const protectedContext = assertProtectedContext(
    input.protectedContext,
    customWrapperPolicy,
    dataAuthorization,
  );
  return Object.freeze({
    providerConfiguration,
    dataAuthorization,
    dataAuthorizationDecisionDigest:
      changeRoleAssignmentDataAuthorizationDigestV1(dataAuthorization),
    authorizationByProfile,
    sessionCapabilityByProfile,
    callerProfile,
    protectedContext,
  });
}

function assertProtectedContext(
  value: ChangeRoleAssignmentProtectedContextV1 | undefined,
  customWrapperPolicy: CurrentAgentRolePlan['customWrapperPolicy'],
  dataAuthorization: ChangeRoleAssignmentDataAuthorizationV1,
): ChangeRoleAssignmentProtectedContextV1 | null {
  if (value === undefined) {
    if (customWrapperPolicy === 'allowed-non-protected') {
      throw new TypeError(
        'An exact protected context fact is required for this wrapper policy.',
      );
    }
    return null;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      'schemaVersion',
      'kind',
      'classification',
      'pathRoleSourceDigest',
      'policySourceDigest',
      'inputManifestDigest',
      'relevantTargetDigest',
      'contextDigest',
    ])
  ) {
    throw new TypeError('Role-assignment protected context fact is invalid.');
  }
  let admitted: ChangeRoleAssignmentProtectedContextV1;
  try {
    admitted = createChangeRoleAssignmentProtectedContextV1({
      classification: value.classification,
      pathRoleSourceDigest: value.pathRoleSourceDigest,
      policySourceDigest: value.policySourceDigest,
      inputManifestDigest: value.inputManifestDigest,
      relevantTargetDigest: value.relevantTargetDigest,
    });
  } catch {
    throw new TypeError('Role-assignment protected context fact is invalid.');
  }
  if (
    admitted.contextDigest !== value.contextDigest ||
    admitted.inputManifestDigest !== dataAuthorization.inputManifestDigest ||
    admitted.relevantTargetDigest !== dataAuthorization.relevantTargetDigest
  ) {
    throw new TypeError('Role-assignment protected context fact is invalid.');
  }
  return admitted;
}

function assertDataAuthorization(
  value: unknown,
  providerConfiguration: AgentProviderConfigSnapshot,
): ChangeRoleAssignmentDataAuthorizationV1 {
  if (
    !isRecord(value) ||
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
    !Array.isArray(value.profiles)
  ) {
    throw new TypeError('Role-assignment data authorization is invalid.');
  }
  const profileIds = providerConfiguration.providers.map(({ id }) => id);
  const byProfile = exactProfileMap(
    value.profiles as ChangeRoleAssignmentDataAuthorizationV1['profiles'],
    profileIds,
    (entry) =>
      typeof entry?.profileId === 'string' &&
      typeof entry.allowed === 'boolean' &&
      typeof entry.reason === 'string' &&
      entry.reason.length > 0,
  );
  return deepFreeze({
    policyDigest: value.policyDigest,
    inputManifestDigest: value.inputManifestDigest,
    relevantTargetDigest: value.relevantTargetDigest,
    profiles: providerConfiguration.providers.map(({ id }) => {
      const entry = byProfile.get(id)!;
      return {
        profileId: id,
        allowed: entry.allowed,
        reason: entry.reason,
      };
    }),
  });
}

function exactProfileMap<T extends Readonly<{ profileId: string }>>(
  values: readonly T[],
  expectedIds: readonly string[],
  validate: (value: T) => boolean,
): ReadonlyMap<string, T> {
  if (!Array.isArray(values) || values.some((entry) => !validate(entry))) {
    throw new TypeError('Role-assignment provider facts are malformed.');
  }
  const map = new Map(values.map((entry) => [entry.profileId, entry]));
  if (
    map.size !== values.length ||
    canonicalJson([...map.keys()].sort()) !==
      canonicalJson([...expectedIds].sort())
  ) {
    throw new TypeError('Role-assignment provider facts are incomplete.');
  }
  return map;
}

function assertChangeOverride(
  value: CurrentAgentRolePlan | null,
  changeId: string,
  centralConfigurationDigest: string,
): CurrentAgentRolePlan | null {
  if (value === null) return null;
  if (
    typeof value !== 'object' ||
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
    ].every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError('Agent-role plan is stale.');
  }
  const body: AgentRolePlanBodyV2 = {
    schemaVersion: value.schemaVersion,
    changeId: value.changeId,
    baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
    roleLanes: value.roleLanes,
    pairwiseRequirements: value.pairwiseRequirements,
    customWrapperPolicy: value.customWrapperPolicy,
    grantReferences: value.grantReferences,
  };
  let expectedDigest: string;
  try {
    expectedDigest = agentRolePlanV2Digest(body);
  } catch {
    throw new TypeError('Agent-role plan is stale.');
  }
  if (
    value.changeId !== changeId ||
    value.baseCentralConfigurationDigest !== centralConfigurationDigest ||
    value.planDigest !== expectedDigest
  ) {
    throw new TypeError('Agent-role plan is stale.');
  }
  return deepFreeze(structuredClone({ ...body, planDigest: value.planDigest }));
}

function pairwiseFromCentral(
  central: CentralRoleProviderDefaultV1,
): PairwiseTable {
  return Object.freeze(
    Object.fromEntries(
      ROLE_PAIR_ORDER.map((pair) => {
        const [left, right] = ROLE_PAIR_MEMBERS[pair];
        const leftProviderGroup = central.providerGroups.findIndex(
          ({ roles }) => roles.includes(left),
        );
        const rightProviderGroup = central.providerGroups.findIndex(
          ({ roles }) => roles.includes(right),
        );
        if (leftProviderGroup !== rightProviderGroup) {
          return [pair, 'provider-independent'];
        }
        const providerGroup = central.providerGroups[leftProviderGroup]!;
        const leftSessionGroup = providerGroup.sessionGroups.findIndex(
          (roles) => roles.includes(left),
        );
        const rightSessionGroup = providerGroup.sessionGroups.findIndex(
          (roles) => roles.includes(right),
        );
        return [
          pair,
          leftSessionGroup === rightSessionGroup
            ? 'none'
            : 'session-independent',
        ];
      }),
    ),
  ) as PairwiseTable;
}

function exactGroupsFromPairwise(pairs: PairwiseTable):
  | readonly Readonly<{
      roles: readonly AgentRole[];
      sessionGroups: readonly (readonly AgentRole[])[];
    }>[]
  | null {
  const sameProvider = (left: AgentRole, right: AgentRole) =>
    left === right ||
    requirementForRoles(pairs, left, right) !== 'provider-independent';
  const sameSession = (left: AgentRole, right: AgentRole) =>
    left === right || requirementForRoles(pairs, left, right) === 'none';
  if (!isEquivalence(sameProvider) || !isEquivalence(sameSession)) return null;
  for (const left of ROLE_ORDER) {
    for (const right of ROLE_ORDER) {
      if (sameSession(left, right) && !sameProvider(left, right)) return null;
    }
  }
  const providerGroups = equivalenceGroups(ROLE_ORDER, sameProvider);
  return Object.freeze(
    providerGroups.map((roles) =>
      Object.freeze({
        roles,
        sessionGroups: Object.freeze(
          equivalenceGroups(roles, (left, right) => sameSession(left, right)),
        ),
      }),
    ),
  );
}

function requirementForRoles(
  pairs: PairwiseTable,
  left: AgentRole,
  right: AgentRole,
): AgentRoleIndependenceRequirement {
  const pair = ROLE_PAIR_ORDER.find((candidate) => {
    const members = ROLE_PAIR_MEMBERS[candidate];
    return members.includes(left) && members.includes(right);
  });
  if (pair === undefined) return 'none';
  return pairs[pair];
}

function isEquivalence(
  related: (left: AgentRole, right: AgentRole) => boolean,
): boolean {
  for (const left of ROLE_ORDER) {
    for (const middle of ROLE_ORDER) {
      for (const right of ROLE_ORDER) {
        if (
          related(left, middle) &&
          related(middle, right) &&
          !related(left, right)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function equivalenceGroups(
  domain: readonly AgentRole[],
  related: (left: AgentRole, right: AgentRole) => boolean,
): readonly (readonly AgentRole[])[] {
  const remaining = new Set<AgentRole>(domain);
  const groups: AgentRole[][] = [];
  for (const role of domain) {
    if (!remaining.has(role)) continue;
    const group = domain.filter(
      (candidate) => remaining.has(candidate) && related(role, candidate),
    );
    group.forEach((candidate) => remaining.delete(candidate));
    groups.push(group);
  }
  return Object.freeze(groups.map((group) => Object.freeze(group)));
}

function applySelectionRules(
  topology: NonNullable<ReturnType<typeof exactGroupsFromPairwise>>,
  central: CentralRoleProviderDefaultV1,
  lanes: readonly AgentRoleLaneV1[],
): readonly EffectiveProviderGroup[] | null {
  const laneByRole = new Map(lanes.map((lane) => [lane.role, lane]));
  const rankingIndex = new Map(
    central.globalProviderRanking.map((logicalProviderId, index) => [
      logicalProviderId,
      index,
    ]),
  );
  const groups: EffectiveProviderGroup[] = [];
  for (const topologyGroup of topology) {
    const selectedLanes = topologyGroup.roles
      .map((role) => laneByRole.get(role))
      .filter((lane): lane is AgentRoleLaneV1 => lane !== undefined);
    const scopeRules = selectedLanes.map(({ scopeRule }) => scopeRule);
    if (scopeRules.some((scopeRule) => scopeRule !== scopeRules[0])) {
      return null;
    }
    const preferredSets = selectedLanes
      .map(({ preferredLogicalProviderIds }) => preferredLogicalProviderIds)
      .filter((preferred) => preferred.length > 0);
    if (
      preferredSets.some(
        (preferred) =>
          canonicalJson(preferred) !== canonicalJson(preferredSets[0]),
      ) ||
      preferredSets.some((preferred) =>
        preferred.some(
          (logicalProviderId) => !rankingIndex.has(logicalProviderId),
        ),
      )
    ) {
      return null;
    }
    const preferredLogicalProviderIds = preferredSets[0]
      ? [...preferredSets[0]].sort(
          (left, right) => rankingIndex.get(left)! - rankingIndex.get(right)!,
        )
      : [];
    const centralRules = central.providerGroups
      .filter(({ roles }) =>
        roles.some((role) => topologyGroup.roles.includes(role)),
      )
      .map(({ providerRule }) => providerRule);
    let providerRule: CentralProviderRuleV1;
    if (preferredLogicalProviderIds.length > 0) {
      providerRule = Object.freeze({
        kind: 'ranked-fallback' as const,
        preferredLogicalProviderId: preferredLogicalProviderIds[0]!,
      });
    } else {
      const adaptive = centralRules.some(
        ({ kind }) => kind === 'adaptive-author',
      );
      if (adaptive && topologyGroup.roles.includes('author')) {
        providerRule = Object.freeze({ kind: 'adaptive-author' as const });
      } else if (adaptive) {
        return null;
      } else if (
        centralRules.some(
          (rule) => canonicalJson(rule) !== canonicalJson(centralRules[0]),
        )
      ) {
        return null;
      } else {
        providerRule = centralRules[0]!;
      }
    }

    const familyLists = selectedLanes
      .map(({ allowedProviderFamilies }) => allowedProviderFamilies)
      .filter((families) => families.length > 0);
    const allowedProviderFamilies =
      familyLists.length === 0
        ? null
        : familyLists.reduce<readonly string[]>(
            (intersection, families) =>
              intersection.filter((family) => families.includes(family)),
            familyLists[0]!,
          );
    if (allowedProviderFamilies?.length === 0) return null;
    groups.push(
      Object.freeze({
        roles: topologyGroup.roles,
        sessionGroups: topologyGroup.sessionGroups,
        providerRule,
        preferredLogicalProviderIds: Object.freeze(
          preferredLogicalProviderIds.length > 0
            ? preferredLogicalProviderIds
            : providerRule.kind === 'ranked-fallback' &&
                providerRule.preferredLogicalProviderId !== null
              ? [providerRule.preferredLogicalProviderId]
              : [],
        ),
        allowedProviderFamilies:
          allowedProviderFamilies === null
            ? null
            : Object.freeze([...allowedProviderFamilies]),
      }),
    );
  }
  return Object.freeze(groups);
}

function createGroupDomain(
  group: EffectiveProviderGroup,
  input: ResolveChangeRoleAssignmentInputV1,
  facts: ValidatedFacts,
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
): GroupDomain {
  const rankedLogicalProviders =
    group.providerRule.kind === 'adaptive-author'
      ? [input.caller.logicalProviderId]
      : [
          ...group.preferredLogicalProviderIds,
          ...input.centralDefault.globalProviderRanking,
        ].filter((value, index, values) => values.indexOf(value) === index);
  const candidates = rankedLogicalProviders
    .map((logicalProviderId, effectiveLogicalProviderRank) =>
      createGroupCandidate(
        group,
        logicalProviderId,
        group.providerRule.kind === 'adaptive-author'
          ? 'adaptive-caller'
          : group.preferredLogicalProviderIds.includes(logicalProviderId)
            ? 'named-preference'
            : 'global-fallback',
        effectiveLogicalProviderRank,
        input,
        facts,
        diagnostics,
      ),
    )
    .filter((candidate): candidate is GroupCandidate => candidate !== null);
  return Object.freeze({ group, candidates: Object.freeze(candidates) });
}

function createGroupCandidate(
  group: EffectiveProviderGroup,
  logicalProviderId: string,
  selectionReason: GroupCandidate['selectionReason'],
  effectiveLogicalProviderRank: number,
  input: ResolveChangeRoleAssignmentInputV1,
  facts: ValidatedFacts,
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
): GroupCandidate | null {
  if (
    group.providerRule.kind === 'adaptive-author' &&
    logicalProviderId !== input.caller.logicalProviderId
  ) {
    addDiagnostic(
      diagnostics,
      group,
      null,
      logicalProviderId,
      null,
      'ADAPTIVE_CALLER_UNAVAILABLE',
    );
    return null;
  }
  const profiles = facts.providerConfiguration.providers.filter(
    (profile) => profile.logicalProviderId === logicalProviderId,
  );
  const sessions: SelectedSessionSlot[] = [];
  for (const roles of group.sessionGroups) {
    const sessionSlotId = `role-session-slot-${roles.join('-')}`;
    const callerExisting =
      group.providerRule.kind === 'adaptive-author' && roles.includes('author');
    if (callerExisting) {
      const session = callerSession(
        group,
        roles,
        sessionSlotId,
        input,
        facts,
        diagnostics,
      );
      if (session === null) return null;
      sessions.push(session);
      continue;
    }
    const selectedProfile = selectFreshProfile(
      group,
      roles,
      sessionSlotId,
      logicalProviderId,
      profiles,
      input,
      facts,
      diagnostics,
    );
    if (selectedProfile === null) return null;
    sessions.push(
      Object.freeze({
        roles,
        sessionSlotId,
        sessionMode: 'fresh' as const,
        profileIdByRole: profileIdsByRole(roles, selectedProfile.id),
      }),
    );
  }
  return Object.freeze({
    logicalProviderId,
    selectionReason,
    effectiveLogicalProviderRank,
    sessions: Object.freeze(sessions),
  });
}

function callerSession(
  group: EffectiveProviderGroup,
  roles: readonly AgentRole[],
  sessionSlotId: string,
  input: ResolveChangeRoleAssignmentInputV1,
  facts: ValidatedFacts,
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
): SelectedSessionSlot | null {
  if (input.caller.engineSessionId === null) {
    addDiagnostic(
      diagnostics,
      group,
      sessionSlotId,
      input.caller.logicalProviderId,
      input.caller.profileId,
      'CALLER_SESSION_UNAVAILABLE',
    );
    return null;
  }
  const profile = facts.callerProfile;
  if (profile === null) {
    addDiagnostic(
      diagnostics,
      group,
      sessionSlotId,
      input.caller.logicalProviderId,
      input.caller.profileId,
      'ADAPTIVE_CALLER_UNAVAILABLE',
    );
    return null;
  }
  const additionalRoles = roles.filter((role) => role !== 'author');
  if (
    additionalRoles.some((role) => !input.caller.adoptableRoles.includes(role))
  ) {
    addDiagnostic(
      diagnostics,
      group,
      sessionSlotId,
      input.caller.logicalProviderId,
      input.caller.profileId,
      'CALLER_SESSION_NOT_ADOPTABLE',
    );
    return null;
  }
  const rejection = rejectProfile(
    profile,
    group,
    roles,
    false,
    additionalRoles.length > 0,
    input,
    facts,
  );
  if (rejection !== null) {
    addDiagnostic(
      diagnostics,
      group,
      sessionSlotId,
      input.caller.logicalProviderId,
      profile.id,
      rejection,
      rejection === 'DATA_AUTHORIZATION_DENIED'
        ? (facts.authorizationByProfile.get(profile.id)?.reason ?? null)
        : null,
    );
    return null;
  }
  return Object.freeze({
    roles,
    sessionSlotId,
    sessionMode: 'caller-existing' as const,
    profileIdByRole: profileIdsByRole(roles, profile.id),
  });
}

function selectFreshProfile(
  group: EffectiveProviderGroup,
  roles: readonly AgentRole[],
  sessionSlotId: string,
  logicalProviderId: string,
  profiles: readonly AgentProviderProfileSnapshot[],
  input: ResolveChangeRoleAssignmentInputV1,
  facts: ValidatedFacts,
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
): AgentProviderProfileSnapshot | null {
  if (profiles.length === 0) {
    addDiagnostic(
      diagnostics,
      group,
      sessionSlotId,
      logicalProviderId,
      null,
      'LOGICAL_PROVIDER_UNAVAILABLE',
    );
    return null;
  }
  const rank = new Map(
    facts.providerConfiguration.globalRanking.map((profileId, index) => [
      profileId,
      index,
    ]),
  );
  const admitted: AgentProviderProfileSnapshot[] = [];
  for (const profile of profiles) {
    const rejection = rejectProfile(
      profile,
      group,
      roles,
      true,
      roles.length > 1,
      input,
      facts,
    );
    if (rejection === null) admitted.push(profile);
    else
      addDiagnostic(
        diagnostics,
        group,
        sessionSlotId,
        logicalProviderId,
        profile.id,
        rejection,
        rejection === 'DATA_AUTHORIZATION_DENIED'
          ? (facts.authorizationByProfile.get(profile.id)?.reason ?? null)
          : null,
      );
  }
  admitted.sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
  return admitted[0] ?? null;
}

function rejectProfile(
  profile: AgentProviderProfileSnapshot,
  group: EffectiveProviderGroup,
  roles: readonly AgentRole[],
  requireFresh: boolean,
  requireResume: boolean,
  input: ResolveChangeRoleAssignmentInputV1,
  facts: ValidatedFacts,
): ChangeRoleAssignmentDiagnosticReasonV1 | null {
  if (!profile.enabled) return 'PROFILE_DISABLED';
  if (
    group.allowedProviderFamilies !== null &&
    !group.allowedProviderFamilies.includes(profile.family)
  ) {
    return 'PROVIDER_FAMILY_NOT_ALLOWED';
  }
  if (
    profile.trustTier === 'host-wrapper' &&
    !customWrapperAdmitted(
      input.changeOverride?.customWrapperPolicy ?? 'forbidden',
      facts.protectedContext,
    )
  ) {
    return 'CUSTOM_WRAPPER_FORBIDDEN';
  }
  if (facts.authorizationByProfile.get(profile.id)?.allowed !== true) {
    return 'DATA_AUTHORIZATION_DENIED';
  }
  const requiredCapabilities = new Set(
    roles.flatMap((role) => ROLE_CAPABILITIES[role]),
  );
  if (
    [...requiredCapabilities].some(
      (capability) => !profile.capabilities.includes(capability),
    )
  ) {
    return 'ROLE_CAPABILITY_UNSUPPORTED';
  }
  const sessionCapability = facts.sessionCapabilityByProfile.get(profile.id)!;
  if (
    requireFresh &&
    (!profile.capabilities.includes('fresh-session') ||
      !sessionCapability.canStartFresh)
  ) {
    return 'FRESH_SESSION_UNSUPPORTED';
  }
  if (
    requireResume &&
    (!profile.capabilities.includes('resumable-session') ||
      !sessionCapability.canResume)
  ) {
    return 'RESUME_UNSUPPORTED';
  }
  return null;
}

function customWrapperAdmitted(
  policy: CurrentAgentRolePlan['customWrapperPolicy'],
  protectedContext: ChangeRoleAssignmentProtectedContextV1 | null,
): boolean {
  if (policy === 'allowed') return true;
  if (policy === 'forbidden') return false;
  return protectedContext?.classification === 'ordinary';
}

function solveDomains(
  domains: readonly GroupDomain[],
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
):
  | readonly Readonly<{
      group: EffectiveProviderGroup;
      candidate: GroupCandidate;
    }>[]
  | null {
  const ordered = [...domains].sort((left, right) => {
    const leftAdaptive = left.group.providerRule.kind === 'adaptive-author';
    const rightAdaptive = right.group.providerRule.kind === 'adaptive-author';
    if (leftAdaptive !== rightAdaptive) return leftAdaptive ? -1 : 1;
    return (
      ROLE_ORDER.indexOf(left.group.roles[0]!) -
      ROLE_ORDER.indexOf(right.group.roles[0]!)
    );
  });
  const selected: Array<{
    group: EffectiveProviderGroup;
    candidate: GroupCandidate;
  }> = [];
  const completeAssignments: Array<
    readonly Readonly<{
      group: EffectiveProviderGroup;
      candidate: GroupCandidate;
    }>[]
  > = [];
  const used = new Set<string>();
  const visit = (index: number): void => {
    if (index === ordered.length) {
      completeAssignments.push(
        Object.freeze(
          selected.map(({ group, candidate }) =>
            Object.freeze({ group, candidate }),
          ),
        ),
      );
      return;
    }
    const domain = ordered[index]!;
    for (const candidate of domain.candidates) {
      if (used.has(candidate.logicalProviderId)) {
        addDiagnostic(
          diagnostics,
          domain.group,
          null,
          candidate.logicalProviderId,
          null,
          'PROVIDER_BOUNDARY_CONFLICT',
        );
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

function compareCompleteAssignments(
  left: readonly Readonly<{
    group: EffectiveProviderGroup;
    candidate: GroupCandidate;
  }>[],
  right: readonly Readonly<{
    group: EffectiveProviderGroup;
    candidate: GroupCandidate;
  }>[],
): number {
  const rankDifference =
    completeAssignmentRank(left) - completeAssignmentRank(right);
  if (rankDifference !== 0) return rankDifference;
  const leftTieBreak = completeAssignmentTieBreak(left);
  const rightTieBreak = completeAssignmentTieBreak(right);
  return leftTieBreak < rightTieBreak
    ? -1
    : leftTieBreak > rightTieBreak
      ? 1
      : 0;
}

function completeAssignmentRank(
  selected: readonly Readonly<{
    group: EffectiveProviderGroup;
    candidate: GroupCandidate;
  }>[],
): number {
  return selected.reduce(
    (sum, { group, candidate }) =>
      sum + candidate.effectiveLogicalProviderRank * group.roles.length,
    0,
  );
}

function completeAssignmentTieBreak(
  selected: readonly Readonly<{
    group: EffectiveProviderGroup;
    candidate: GroupCandidate;
  }>[],
): string {
  const candidateByRole = new Map<
    AgentRole,
    Readonly<{ candidate: GroupCandidate; session: SelectedSessionSlot }>
  >();
  for (const { group, candidate } of selected) {
    for (const role of group.roles) {
      candidateByRole.set(
        role,
        Object.freeze({
          candidate,
          session: candidate.sessions.find(({ roles }) =>
            roles.includes(role),
          )!,
        }),
      );
    }
  }
  return canonicalJson(
    ROLE_ORDER.map((role) => {
      const placement = candidateByRole.get(role)!;
      return {
        role,
        logicalProviderId: placement.candidate.logicalProviderId,
        profileId: placement.session.profileIdByRole[role],
        sessionSlotId: placement.session.sessionSlotId,
      };
    }),
  );
}

function profileIdsByRole(
  roles: readonly AgentRole[],
  profileId: string | null,
): Readonly<Record<AgentRole, string | null>> {
  return Object.freeze({
    author: roles.includes('author') ? profileId : null,
    builder: roles.includes('builder') ? profileId : null,
    reviewer: roles.includes('reviewer') ? profileId : null,
  });
}

function effectiveProfileRank(
  providerConfiguration: AgentProviderConfigSnapshot,
  logicalProviderId: string,
  profileId: string | null,
): number | null {
  if (profileId === null) return null;
  const profileRank = new Map(
    providerConfiguration.globalRanking.map((id, index) => [id, index]),
  );
  const logicalProfiles = providerConfiguration.providers
    .filter((profile) => profile.logicalProviderId === logicalProviderId)
    .sort(
      (left, right) => profileRank.get(left.id)! - profileRank.get(right.id)!,
    );
  const rank = logicalProfiles.findIndex((profile) => profile.id === profileId);
  if (rank < 0) {
    throw new TypeError('Selected role-assignment profile is unavailable.');
  }
  return rank;
}

function addDiagnostic(
  diagnostics: ChangeRoleAssignmentDiagnosticV1[],
  group: EffectiveProviderGroup,
  sessionSlotId: string | null,
  logicalProviderId: string | null,
  profileId: string | null,
  reason: ChangeRoleAssignmentDiagnosticReasonV1,
  dataAuthorizationReason: string | null = null,
): void {
  diagnostics.push(
    Object.freeze({
      providerGroup: groupKey(group.roles),
      sessionSlotId,
      logicalProviderId,
      profileId,
      reason,
      detail: diagnosticDetail(reason),
      dataAuthorizationReason,
    }),
  );
}

function diagnosticDetail(
  reason: ChangeRoleAssignmentDiagnosticReasonV1,
): string {
  const details: Readonly<
    Record<ChangeRoleAssignmentDiagnosticReasonV1, string>
  > = {
    ADAPTIVE_CALLER_UNAVAILABLE:
      'Adaptive has no fallback outside the current caller.',
    CALLER_SESSION_NOT_ADOPTABLE:
      'The caller session cannot adopt every configured role.',
    CALLER_SESSION_UNAVAILABLE:
      'The caller has no engine-owned session handle.',
    CUSTOM_WRAPPER_FORBIDDEN:
      'The per-change custom-wrapper policy rejects this profile.',
    DATA_AUTHORIZATION_DENIED:
      'Repository data authorization rejects this profile.',
    FRESH_SESSION_UNSUPPORTED:
      'A required additional fresh session is not proven.',
    LOGICAL_PROVIDER_UNAVAILABLE:
      'No registered profile has this logical provider identity.',
    PROFILE_DISABLED: 'The host profile is disabled.',
    PROVIDER_BOUNDARY_CONFLICT:
      'The logical provider is already used across a provider boundary.',
    PROVIDER_FAMILY_NOT_ALLOWED:
      'The role-lane provider-family allowlist rejects this profile.',
    RESUME_UNSUPPORTED:
      'Same-session role reuse has no proven resumable-session capability.',
    ROLE_CAPABILITY_UNSUPPORTED:
      'The profile lacks one or more required role capabilities.',
  };
  return details[reason];
}

function normalizeDiagnostics(
  diagnostics: readonly ChangeRoleAssignmentDiagnosticV1[],
): readonly ChangeRoleAssignmentDiagnosticV1[] {
  const byCanonical = new Map(
    diagnostics.map((diagnostic) => [canonicalJson(diagnostic), diagnostic]),
  );
  return Object.freeze(
    [...byCanonical.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, diagnostic]) => diagnostic),
  );
}

function sessionFailure(
  diagnostics: readonly ChangeRoleAssignmentDiagnosticV1[],
): boolean {
  return diagnostics.some(({ reason }) =>
    [
      'CALLER_SESSION_NOT_ADOPTABLE',
      'CALLER_SESSION_UNAVAILABLE',
      'FRESH_SESSION_UNSUPPORTED',
      'RESUME_UNSUPPORTED',
    ].includes(reason),
  );
}

function unsatisfied(
  code: Extract<
    ResolveChangeRoleAssignmentResultV1,
    { outcome: 'unsatisfied' }
  >['code'],
  diagnostics: readonly ChangeRoleAssignmentDiagnosticV1[],
): Extract<ResolveChangeRoleAssignmentResultV1, { outcome: 'unsatisfied' }> {
  return deepFreeze({
    outcome: 'unsatisfied' as const,
    code,
    diagnostics: normalizeDiagnostics(diagnostics),
  });
}

function groupKey(roles: readonly AgentRole[]): string {
  return roles.join('-');
}

function isCanonicalRoles(value: readonly AgentRole[]): boolean {
  return (
    value.every((role) => ROLE_ORDER.includes(role)) &&
    new Set(value).size === value.length &&
    value.every(
      (role, index) =>
        index === 0 ||
        ROLE_ORDER.indexOf(value[index - 1]!) < ROLE_ORDER.indexOf(role),
    )
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
