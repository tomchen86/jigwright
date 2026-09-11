import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAgentProviderConfigToml,
  type AgentProviderCapability,
  type AgentProviderConfigSnapshot,
} from '@jigwright/core/agent-provider-config';

import {
  agentRolePlanV2Digest,
  type AgentPairwiseRequirementV1,
  type AgentRoleLaneV1,
  type AgentRolePlanBodyV2,
  type CurrentAgentRolePlan,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  type CentralProviderGroupRuleV1,
  type CentralRoleProviderDefaultV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
  type ResolveChangeRoleAssignmentInputV1,
  type ResolvedChangeRoleAssignmentV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';

const CHANGE_ID = 'role-assignment-change';
const PLANNING_GENERATION = 'a'.repeat(64);
const DATA_POLICY_DIGEST = 'b'.repeat(64);
const PROVIDER_REGISTRY_DIGEST = 'c'.repeat(64);
const INPUT_MANIFEST_DIGEST = 'd'.repeat(64);
const RELEVANT_TARGET_DIGEST = 'e'.repeat(64);
const PATH_ROLE_SOURCE_DIGEST = 'f'.repeat(64);
const PROTECTED_POLICY_SOURCE_DIGEST = '1'.repeat(64);
const ALL_CAPABILITIES = [
  'fresh-session',
  'plan-review',
  'resumable-session',
  'survey',
  'task-diff-review',
  'task-implementation',
] as const satisfies readonly AgentProviderCapability[];

type ProviderFixture = Readonly<{
  profileId: string;
  logicalProviderId: string;
  family?: string;
  capabilities?: readonly AgentProviderCapability[];
  enabled?: boolean;
  trustTier?: 'built-in-reviewed' | 'host-wrapper';
}>;

function providerConfiguration(
  providers: readonly ProviderFixture[],
  registrationOrder: readonly string[] = providers.map(
    ({ profileId }) => profileId,
  ),
): AgentProviderConfigSnapshot {
  const byId = new Map(
    providers.map((provider) => [provider.profileId, provider]),
  );
  const blocks = registrationOrder.map((profileId) => {
    const provider = byId.get(profileId)!;
    const capabilities = provider.capabilities ?? ALL_CAPABILITIES;
    const trustTier = provider.trustTier ?? 'built-in-reviewed';
    return `[[providers]]
id = "${provider.profileId}"
logical_provider_id = "${provider.logicalProviderId}"
family = "${provider.family ?? provider.logicalProviderId}"
capabilities = [${capabilities.map((capability) => `"${capability}"`).join(', ')}]
trust_tier = "${trustTier}"
enabled = ${provider.enabled ?? true}
protocol = "${trustTier === 'host-wrapper' ? 'harness-jsonl-v2' : `${provider.profileId}-jsonl-v1`}"
executable = "/opt/providers/${provider.profileId}"${
      trustTier === 'host-wrapper'
        ? `
start_args = ["run", "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"`
        : ''
    }`;
  });
  const profileRanking = providers.map(({ profileId }) => profileId);
  const enabledProfileRanking = providers
    .filter(({ enabled }) => enabled ?? true)
    .map(({ profileId }) => profileId);
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = [${profileRanking.map((id) => `"${id}"`).join(', ')}]

${blocks.join('\n\n')}

[provider_preferences]
author = [${enabledProfileRanking.map((id) => `"${id}"`).join(', ')}]
builder = [${enabledProfileRanking.map((id) => `"${id}"`).join(', ')}]
reviewer = [${enabledProfileRanking.map((id) => `"${id}"`).join(', ')}]
`,
    { platform: 'linux' },
  );
}

function centralDefault(
  providerGroups: readonly CentralProviderGroupRuleV1[],
  ranking: readonly string[],
): CentralRoleProviderDefaultV1 {
  return createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups,
    globalProviderRanking: ranking,
  });
}

function splitCentral(
  ranking: readonly string[],
  reviewerPreference: string | null = null,
): CentralRoleProviderDefaultV1 {
  return centralDefault(
    [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: null,
        },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: reviewerPreference,
        },
      },
    ],
    ranking,
  );
}

function rolePlan(input: {
  central: CentralRoleProviderDefaultV1;
  pairwiseRequirements?: readonly AgentPairwiseRequirementV1[];
  roleLanes?: readonly AgentRoleLaneV1[];
  customWrapperPolicy?: 'forbidden' | 'allowed-non-protected' | 'allowed';
}): CurrentAgentRolePlan {
  const body: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: input.central.configurationDigest,
    roleLanes: input.roleLanes ?? [],
    pairwiseRequirements: input.pairwiseRequirements ?? [],
    customWrapperPolicy: input.customWrapperPolicy ?? 'forbidden',
    grantReferences: [],
  };
  return { ...body, planDigest: agentRolePlanV2Digest(body) };
}

function input(
  central: CentralRoleProviderDefaultV1,
  providerConfiguration: AgentProviderConfigSnapshot,
  options: Readonly<{
    changeOverride?: CurrentAgentRolePlan | null;
    callerLogicalProviderId?: string;
    callerProfileId?: string | null;
    callerEngineSessionId?: string | null;
    adoptableRoles?: readonly ('author' | 'builder' | 'reviewer')[];
    deniedProfileIds?: readonly string[];
    resumableProfileIds?: readonly string[];
    nonFreshProfileIds?: readonly string[];
    protectedContext?: Readonly<{
      schemaVersion: 1;
      kind: 'change-role-assignment-protected-context';
      classification: 'ordinary' | 'protected';
      pathRoleSourceDigest: string;
      policySourceDigest: string;
      inputManifestDigest: string;
      relevantTargetDigest: string;
      contextDigest: string;
    }>;
    inputManifestDigest?: string | null;
    relevantTargetDigest?: string | null;
  }> = {},
): ResolveChangeRoleAssignmentInputV1 {
  const denied = new Set(options.deniedProfileIds ?? []);
  const resumable = new Set(options.resumableProfileIds ?? []);
  const nonFresh = new Set(options.nonFreshProfileIds ?? []);
  return {
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    providerRegistryDigest: PROVIDER_REGISTRY_DIGEST,
    centralDefault: central,
    changeOverride: options.changeOverride ?? null,
    providerConfiguration,
    caller: {
      logicalProviderId: options.callerLogicalProviderId ?? 'alpha',
      profileId:
        options.callerProfileId === undefined
          ? 'alpha-primary'
          : options.callerProfileId,
      engineSessionId:
        options.callerEngineSessionId === undefined
          ? 'caller-session-alpha'
          : options.callerEngineSessionId,
      adoptableRoles: options.adoptableRoles ?? ['author'],
    },
    dataAuthorization: {
      policyDigest: DATA_POLICY_DIGEST,
      inputManifestDigest:
        options.inputManifestDigest === undefined
          ? INPUT_MANIFEST_DIGEST
          : options.inputManifestDigest,
      relevantTargetDigest:
        options.relevantTargetDigest === undefined
          ? RELEVANT_TARGET_DIGEST
          : options.relevantTargetDigest,
      profiles: providerConfiguration.providers.map(({ id }) => ({
        profileId: id,
        allowed: !denied.has(id),
        reason: denied.has(id) ? 'REPOSITORY_DENIED' : 'AUTHORIZED',
      })),
    },
    sessionCapabilities: providerConfiguration.providers.map((profile) => ({
      profileId: profile.id,
      canStartFresh:
        profile.capabilities.includes('fresh-session') &&
        !nonFresh.has(profile.id),
      canResume: resumable.has(profile.id),
    })),
    protectedContext: options.protectedContext,
  };
}

function resolved(
  result: ReturnType<typeof resolveChangeRoleAssignmentV1>,
): ResolvedChangeRoleAssignmentV1 {
  assert.notEqual(result.outcome, 'unsatisfied');
  return (result as Exclude<typeof result, { outcome: 'unsatisfied' }>)
    .resolution;
}

function providersByRole(resolution: ResolvedChangeRoleAssignmentV1) {
  return Object.fromEntries(
    resolution.placements.map(({ role, logicalProviderId }) => [
      role,
      logicalProviderId,
    ]),
  );
}

function protectedContextFact(
  classification: 'ordinary' | 'protected',
  overrides: Partial<{
    pathRoleSourceDigest: string;
    policySourceDigest: string;
    inputManifestDigest: string;
    relevantTargetDigest: string;
  }> = {},
) {
  return createChangeRoleAssignmentProtectedContextV1({
    classification,
    pathRoleSourceDigest:
      overrides.pathRoleSourceDigest ?? PATH_ROLE_SOURCE_DIGEST,
    policySourceDigest:
      overrides.policySourceDigest ?? PROTECTED_POLICY_SOURCE_DIGEST,
    inputManifestDigest: overrides.inputManifestDigest ?? INPUT_MANIFEST_DIGEST,
    relevantTargetDigest:
      overrides.relevantTargetDigest ?? RELEVANT_TARGET_DIGEST,
  });
}

function assertUnsatisfiedWithReason(
  result: ReturnType<typeof resolveChangeRoleAssignmentV1>,
  reason: string,
): void {
  assert.equal(result.outcome, 'unsatisfied');
  if (result.outcome !== 'unsatisfied') throw new Error('expected rejection');
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.reason === reason),
  );
}

test('hard authorization and provider inequality filter before preference and central rank', () => {
  const configuration = providerConfiguration(
    ['alpha', 'beta', 'gamma', 'delta'].map((logicalProviderId) => ({
      profileId: `${logicalProviderId}-primary`,
      logicalProviderId,
    })),
  );
  const result = resolveChangeRoleAssignmentV1(
    input(
      splitCentral(['alpha', 'beta', 'gamma', 'delta'], 'gamma'),
      configuration,
      {
        deniedProfileIds: ['beta-primary'],
      },
    ),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'alpha',
    builder: 'delta',
    reviewer: 'gamma',
  });
  assert.ok(
    resolved(result).diagnostics.some(
      ({ logicalProviderId, reason, dataAuthorizationReason }) =>
        logicalProviderId === 'beta' &&
        reason === 'DATA_AUTHORIZATION_DENIED' &&
        dataAuthorizationReason === 'REPOSITORY_DENIED',
    ),
  );
});

test('four-provider resolution and explanation are independent of registration order', () => {
  const providers = ['alpha', 'beta', 'gamma', 'delta'].map(
    (logicalProviderId) => ({
      profileId: `${logicalProviderId}-primary`,
      logicalProviderId,
    }),
  );
  const first = providerConfiguration(providers);
  const shuffled = providerConfiguration(providers, [
    'delta-primary',
    'beta-primary',
    'alpha-primary',
    'gamma-primary',
  ]);
  const central = splitCentral(['delta', 'gamma', 'beta', 'alpha']);

  const left = resolveChangeRoleAssignmentV1(input(central, first));
  const right = resolveChangeRoleAssignmentV1(input(central, shuffled));

  assert.equal(left.outcome, 'resolved');
  assert.equal(right.outcome, 'resolved');
  assert.equal(first.configDigest, shuffled.configDigest);
  assert.deepEqual(left, right);
  assert.deepEqual(
    resolved(left).placements.map(
      ({
        role,
        selectionReason,
        effectiveLogicalProviderRank,
        profileSelectionReason,
        effectiveProfileRank,
      }) => ({
        role,
        selectionReason,
        effectiveLogicalProviderRank,
        profileSelectionReason,
        effectiveProfileRank,
      }),
    ),
    [
      {
        role: 'author',
        selectionReason: 'adaptive-caller',
        effectiveLogicalProviderRank: 0,
        profileSelectionReason: 'caller-session',
        effectiveProfileRank: 0,
      },
      {
        role: 'builder',
        selectionReason: 'global-fallback',
        effectiveLogicalProviderRank: 0,
        profileSelectionReason: 'host-global-ranking',
        effectiveProfileRank: 0,
      },
      {
        role: 'reviewer',
        selectionReason: 'global-fallback',
        effectiveLogicalProviderRank: 1,
        profileSelectionReason: 'host-global-ranking',
        effectiveProfileRank: 0,
      },
    ],
  );
});

test('registry evidence is required, output-bound, and deterministic under exact replay', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ]);
  const exactInput = input(
    splitCentral(['alpha', 'beta', 'gamma']),
    configuration,
  );

  const first = resolved(resolveChangeRoleAssignmentV1(exactInput));
  const replay = resolved(resolveChangeRoleAssignmentV1(exactInput));
  const changedRegistry = resolved(
    resolveChangeRoleAssignmentV1({
      ...exactInput,
      providerRegistryDigest: 'd'.repeat(64),
    }),
  );

  assert.deepEqual(first, replay);
  assert.equal(first.providerRegistryDigest, PROVIDER_REGISTRY_DIGEST);
  assert.equal(changedRegistry.providerRegistryDigest, 'd'.repeat(64));
  assert.notEqual(first.resolutionDigest, changedRegistry.resolutionDigest);
  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1({
        ...exactInput,
        providerRegistryDigest: 'not-a-sha256',
      }),
    /input is invalid/u,
  );
});

test('profiles that alias one logical provider cannot satisfy a provider boundary', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'alpha-secondary', logicalProviderId: 'alpha' },
  ]);
  const result = resolveChangeRoleAssignmentV1(
    input(splitCentral(['alpha']), configuration),
  );

  assert.equal(result.outcome, 'unsatisfied');
  if (result.outcome !== 'unsatisfied') throw new Error('expected rejection');
  assert.equal(result.code, 'ROLE_PROVIDER_ASSIGNMENT_UNSATISFIABLE');
});

test('Adaptive fixes the Author group to the caller and never falls back when its fresh session is unavailable', () => {
  const configuration = providerConfiguration([
    {
      profileId: 'alpha-primary',
      logicalProviderId: 'alpha',
      capabilities: [
        'plan-review',
        'survey',
        'task-diff-review',
        'task-implementation',
      ],
    },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author', 'builder'],
        sessionGroups: [['author'], ['builder']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: null,
        },
      },
    ],
    ['beta', 'alpha'],
  );
  const result = resolveChangeRoleAssignmentV1(input(central, configuration));

  assert.equal(result.outcome, 'unsatisfied');
  assert.equal(result.code, 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED');
  assert.ok(
    result.diagnostics.some(
      ({ logicalProviderId, reason }) =>
        logicalProviderId === 'alpha' && reason === 'FRESH_SESSION_UNSUPPORTED',
    ),
  );
  assert.ok(
    result.diagnostics
      .filter(({ providerGroup }) => providerGroup === 'author-builder')
      .every(({ logicalProviderId }) => logicalProviderId === 'alpha'),
  );
});

test('fresh-session is a hard capability and a lower-ranked capable provider wins', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    {
      profileId: 'beta-primary',
      logicalProviderId: 'beta',
      capabilities: [
        'fresh-session',
        'plan-review',
        'survey',
        'task-diff-review',
      ],
    },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ]);
  const result = resolveChangeRoleAssignmentV1(
    input(splitCentral(['alpha', 'beta', 'gamma']), configuration),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'alpha',
    builder: 'gamma',
    reviewer: 'beta',
  });
});

test('an Adaptive Author-only group does not manufacture an additional fresh session', () => {
  const configuration = providerConfiguration([
    {
      profileId: 'alpha-primary',
      logicalProviderId: 'alpha',
      capabilities: ['survey'],
    },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder', 'reviewer'],
        sessionGroups: [['builder'], ['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'beta',
        },
      },
    ],
    ['alpha', 'beta'],
  );

  const result = resolveChangeRoleAssignmentV1(input(central, configuration));

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'alpha',
    builder: 'beta',
    reviewer: 'beta',
  });
});

test('a singleton Adaptive Author requires its exact admitted registered caller profile', () => {
  const baseProviders: readonly ProviderFixture[] = [
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ];
  const central = splitCentral(['alpha', 'beta', 'gamma']);

  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(central, providerConfiguration(baseProviders), {
        callerProfileId: null,
      }),
    ),
    'ADAPTIVE_CALLER_UNAVAILABLE',
  );
  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(central, providerConfiguration(baseProviders), {
        callerProfileId: 'unknown-profile',
      }),
    ),
    'ADAPTIVE_CALLER_UNAVAILABLE',
  );
  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(
        central,
        providerConfiguration([
          { ...baseProviders[0]!, enabled: false },
          ...baseProviders.slice(1),
        ]),
      ),
    ),
    'PROFILE_DISABLED',
  );
  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(central, providerConfiguration(baseProviders), {
        deniedProfileIds: ['alpha-primary'],
      }),
    ),
    'DATA_AUTHORIZATION_DENIED',
  );
  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(
        central,
        providerConfiguration([
          { ...baseProviders[0]!, trustTier: 'host-wrapper' },
          ...baseProviders.slice(1),
        ]),
      ),
    ),
    'CUSTOM_WRAPPER_FORBIDDEN',
  );

  const familyRestrictedPlan = rolePlan({
    central,
    roleLanes: [
      {
        role: 'author',
        scopeRule: 'planning-generation',
        allowedProviderFamilies: ['approved-family'],
        preferredLogicalProviderIds: [],
      },
    ],
  });
  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(central, providerConfiguration(baseProviders), {
        changeOverride: familyRestrictedPlan,
      }),
    ),
    'PROVIDER_FAMILY_NOT_ALLOWED',
  );
});

test('allowed-non-protected admits a wrapper only from an exact ordinary context fact and binds that fact', () => {
  const configuration = providerConfiguration([
    {
      profileId: 'alpha-primary',
      logicalProviderId: 'alpha',
      trustTier: 'host-wrapper',
    },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ]);
  const central = splitCentral(['alpha', 'beta', 'gamma']);
  const changeOverride = rolePlan({
    central,
    customWrapperPolicy: 'allowed-non-protected',
  });
  const ordinary = protectedContextFact('ordinary');
  const changedSource = protectedContextFact('ordinary', {
    pathRoleSourceDigest: '2'.repeat(64),
  });

  const admitted = resolveChangeRoleAssignmentV1(
    input(central, configuration, {
      changeOverride,
      protectedContext: ordinary,
    }),
  );
  const rebound = resolveChangeRoleAssignmentV1(
    input(central, configuration, {
      changeOverride,
      protectedContext: changedSource,
    }),
  );

  assert.equal(admitted.outcome, 'resolved');
  assert.equal(rebound.outcome, 'resolved');
  assert.deepEqual(resolved(admitted).protectedContext, ordinary);
  assert.deepEqual(resolved(rebound).protectedContext, changedSource);
  assert.notEqual(
    resolved(admitted).resolutionDigest,
    resolved(rebound).resolutionDigest,
  );
  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(central, configuration, { changeOverride }),
      ),
    /protected context/u,
  );

  assertUnsatisfiedWithReason(
    resolveChangeRoleAssignmentV1(
      input(central, configuration, {
        changeOverride,
        protectedContext: protectedContextFact('protected'),
      }),
    ),
    'CUSTOM_WRAPPER_FORBIDDEN',
  );

  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(central, configuration, {
          changeOverride,
          protectedContext: protectedContextFact('ordinary', {
            relevantTargetDigest: '3'.repeat(64),
          }),
        }),
      ),
    /protected context/u,
  );

  const staleContext = structuredClone(ordinary) as any;
  staleContext.contextDigest = '4'.repeat(64);
  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(central, configuration, {
          changeOverride,
          protectedContext: staleContext,
        }),
      ),
    /protected context/u,
  );
});

test('resolution binds the exact data-authorization policy, Manifest, and relevant target identity', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ]);
  const central = splitCentral(['alpha', 'beta', 'gamma']);
  const baseline = resolved(
    resolveChangeRoleAssignmentV1(input(central, configuration)),
  );
  const changedManifest = resolved(
    resolveChangeRoleAssignmentV1(
      input(central, configuration, {
        inputManifestDigest: '5'.repeat(64),
      }),
    ),
  );
  const changedTarget = resolved(
    resolveChangeRoleAssignmentV1(
      input(central, configuration, {
        relevantTargetDigest: '6'.repeat(64),
      }),
    ),
  );

  assert.equal(baseline.dataAuthorizationPolicyDigest, DATA_POLICY_DIGEST);
  assert.equal(
    baseline.dataAuthorizationInputManifestDigest,
    INPUT_MANIFEST_DIGEST,
  );
  assert.equal(
    baseline.dataAuthorizationRelevantTargetDigest,
    RELEVANT_TARGET_DIGEST,
  );
  assert.match(baseline.dataAuthorizationDecisionDigest, /^[0-9a-f]{64}$/u);
  assert.notEqual(baseline.resolutionDigest, changedManifest.resolutionDigest);
  assert.notEqual(baseline.resolutionDigest, changedTarget.resolutionDigest);

  const simulation = resolved(
    resolveChangeRoleAssignmentV1(
      input(central, configuration, {
        inputManifestDigest: null,
        relevantTargetDigest: null,
      }),
    ),
  );
  assert.equal(simulation.dataAuthorizationInputManifestDigest, null);
  assert.equal(simulation.dataAuthorizationRelevantTargetDigest, null);

  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(central, configuration, {
          inputManifestDigest: null,
          relevantTargetDigest: RELEVANT_TARGET_DIGEST,
        }),
      ),
    /data authorization/u,
  );
});

test('complete-assignment rank optimization does not keep a first feasible locally top-ranked provider', () => {
  const configuration = providerConfiguration([
    { profileId: 'caller-primary', logicalProviderId: 'caller' },
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    {
      profileId: 'beta-primary',
      logicalProviderId: 'beta',
      capabilities: ['fresh-session', 'survey', 'task-implementation'],
    },
    {
      profileId: 'gamma-primary',
      logicalProviderId: 'gamma',
      capabilities: ['fresh-session', 'survey'],
    },
    {
      profileId: 'delta-primary',
      logicalProviderId: 'delta',
      capabilities: [
        'fresh-session',
        'plan-review',
        'survey',
        'task-diff-review',
      ],
    },
  ]);
  const result = resolveChangeRoleAssignmentV1(
    input(
      splitCentral(['alpha', 'beta', 'gamma', 'delta', 'caller']),
      configuration,
      {
        callerLogicalProviderId: 'caller',
        callerProfileId: 'caller-primary',
      },
    ),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'caller',
    builder: 'beta',
    reviewer: 'alpha',
  });
});

test('equal complete-assignment rank uses the canonical role-placement key as the exact tie-break', () => {
  const configuration = providerConfiguration([
    { profileId: 'caller-primary', logicalProviderId: 'caller' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
  ]);
  const result = resolveChangeRoleAssignmentV1(
    input(splitCentral(['beta', 'alpha', 'caller']), configuration, {
      callerLogicalProviderId: 'caller',
      callerProfileId: 'caller-primary',
    }),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'caller',
    builder: 'alpha',
    reviewer: 'beta',
  });
});

test('same-session roles fail closed when no resumable session fact exists', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder', 'reviewer'],
        sessionGroups: [['builder', 'reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'beta',
        },
      },
    ],
    ['alpha', 'beta'],
  );

  const result = resolveChangeRoleAssignmentV1(input(central, configuration));

  assert.equal(result.outcome, 'unsatisfied');
  assert.equal(result.code, 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED');
  assert.ok(
    result.diagnostics.some(({ reason }) => reason === 'RESUME_UNSUPPORTED'),
  );
});

test('a resume boolean cannot replace the registered resumable-session capability', () => {
  const configuration = providerConfiguration([
    {
      profileId: 'alpha-primary',
      logicalProviderId: 'alpha',
      capabilities: [
        'fresh-session',
        'plan-review',
        'survey',
        'task-diff-review',
        'task-implementation',
      ],
    },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder', 'reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    ['alpha'],
  );

  const result = resolveChangeRoleAssignmentV1(
    input(central, configuration, {
      resumableProfileIds: ['alpha-primary'],
    }),
  );

  assert.equal(result.outcome, 'unsatisfied');
  assert.equal(result.code, 'ROLE_SESSION_TOPOLOGY_UNSUPPORTED');
  assert.ok(
    result.diagnostics.some(({ reason }) => reason === 'RESUME_UNSUPPORTED'),
  );
});

test('a proven resumable profile supports a three-role partial session partition with deterministic slots', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder', 'reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    ['alpha'],
  );
  const result = resolveChangeRoleAssignmentV1(
    input(central, configuration, {
      resumableProfileIds: ['alpha-primary'],
    }),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(
    resolved(result).placements.map(
      ({ role, logicalProviderId, profileId, sessionSlotId, sessionMode }) => ({
        role,
        logicalProviderId,
        profileId,
        sessionSlotId,
        sessionMode,
      }),
    ),
    [
      {
        role: 'author',
        logicalProviderId: 'alpha',
        profileId: 'alpha-primary',
        sessionSlotId: 'role-session-slot-author',
        sessionMode: 'caller-existing',
      },
      {
        role: 'builder',
        logicalProviderId: 'alpha',
        profileId: 'alpha-primary',
        sessionSlotId: 'role-session-slot-builder-reviewer',
        sessionMode: 'fresh',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'alpha',
        profileId: 'alpha-primary',
        sessionSlotId: 'role-session-slot-builder-reviewer',
        sessionMode: 'fresh',
      },
    ],
  );
});

test('an explicit stronger provider split is grant-free', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder'], ['reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    ['alpha', 'beta'],
  );
  const override = rolePlan({
    central,
    pairwiseRequirements: [
      { pair: 'author-builder', required: 'provider-independent' },
      { pair: 'author-reviewer', required: 'provider-independent' },
    ],
    roleLanes: [
      {
        role: 'builder',
        scopeRule: 'task',
        allowedProviderFamilies: [],
        preferredLogicalProviderIds: ['beta'],
      },
      {
        role: 'reviewer',
        scopeRule: 'task',
        allowedProviderFamilies: [],
        preferredLogicalProviderIds: ['beta'],
      },
    ],
  });
  const result = resolveChangeRoleAssignmentV1(
    input(central, configuration, { changeOverride: override }),
  );

  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(resolved(result).exactGrantRolePairs, []);
  assert.deepEqual(providersByRole(resolved(result)), {
    author: 'alpha',
    builder: 'beta',
    reviewer: 'beta',
  });
});

test('a valid v2 override can lower the central floor and returns the exact canonical role-pair set', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
  ]);
  const central = splitCentral(['alpha']);
  const override = rolePlan({
    central,
    pairwiseRequirements: [
      { pair: 'author-builder', required: 'session-independent' },
      { pair: 'author-reviewer', required: 'session-independent' },
      { pair: 'builder-reviewer', required: 'none' },
    ],
  });
  const result = resolveChangeRoleAssignmentV1(
    input(central, configuration, {
      changeOverride: override,
      resumableProfileIds: ['alpha-primary'],
    }),
  );

  assert.equal(result.outcome, 'exact-grant-required');
  assert.deepEqual(result.exactRolePairs, [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ]);
  assert.deepEqual(resolved(result).exactGrantRolePairs, result.exactRolePairs);
});

test('v2 overrides reject central drift and forged plan digests', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
    { profileId: 'gamma-primary', logicalProviderId: 'gamma' },
  ]);
  const central = splitCentral(['alpha', 'beta', 'gamma']);
  const override = rolePlan({
    central,
    roleLanes: [
      {
        role: 'reviewer',
        scopeRule: 'candidate',
        allowedProviderFamilies: [],
        preferredLogicalProviderIds: ['gamma'],
      },
    ],
  });
  const driftedCentral = splitCentral(['alpha', 'beta', 'gamma'], 'gamma');

  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(driftedCentral, configuration, { changeOverride: override }),
      ),
    /stale/u,
  );
  assert.throws(
    () =>
      resolveChangeRoleAssignmentV1(
        input(central, configuration, {
          changeOverride: { ...override, planDigest: 'f'.repeat(64) },
        }),
      ),
    /stale/u,
  );
});

test('same provider-group conflicting v2 scope or preference intent fails closed', () => {
  const configuration = providerConfiguration([
    { profileId: 'alpha-primary', logicalProviderId: 'alpha' },
    { profileId: 'beta-primary', logicalProviderId: 'beta' },
  ]);
  const central = centralDefault(
    [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author'], ['builder'], ['reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    ['alpha', 'beta'],
  );
  const lane = (
    role: 'builder' | 'reviewer',
    scopeRule: 'task' | 'candidate',
    preferredLogicalProviderIds: readonly string[],
  ): AgentRoleLaneV1 => ({
    role,
    scopeRule,
    allowedProviderFamilies: [],
    preferredLogicalProviderIds,
  });
  const scopeConflict = rolePlan({
    central,
    roleLanes: [
      lane('builder', 'task', ['beta']),
      lane('reviewer', 'candidate', ['beta']),
    ],
  });
  const preferenceConflict = rolePlan({
    central,
    roleLanes: [
      lane('builder', 'task', ['alpha']),
      lane('reviewer', 'task', ['beta']),
    ],
  });

  for (const changeOverride of [scopeConflict, preferenceConflict]) {
    assert.deepEqual(
      resolveChangeRoleAssignmentV1(
        input(central, configuration, { changeOverride }),
      ),
      {
        outcome: 'unsatisfied',
        code: 'ROLE_PROVIDER_OVERRIDE_AMBIGUOUS',
        diagnostics: [],
      },
    );
  }
});
