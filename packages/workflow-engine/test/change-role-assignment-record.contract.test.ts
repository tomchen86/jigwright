import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  parseAgentProviderConfigToml,
  type AgentProviderConfigSnapshot,
} from '@jigwright/core/agent-provider-config';

import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
  type CurrentAgentRolePlan,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  assertChangeRoleAssignmentRecordV1,
  createChangeRoleAssignmentRecordV1,
} from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
  type ResolveChangeRoleAssignmentInputV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';

const CHANGE_ID = 'durable-role-assignment';
const PLANNING_GENERATION = 'a'.repeat(64);
const CENTRAL_COMMIT = 'b'.repeat(40);
const DATA_POLICY_DIGEST = 'c'.repeat(64);
const REGISTRY_POLICY_DIGEST = 'd'.repeat(64);
const SOURCE_DIGEST = 'e'.repeat(64);
const INPUT_MANIFEST_DIGEST = '6'.repeat(64);
const RELEVANT_TARGET_DIGEST = '7'.repeat(64);
const PATH_ROLE_SOURCE_DIGEST = '8'.repeat(64);
const PROTECTED_POLICY_SOURCE_DIGEST = '9'.repeat(64);

function providerConfiguration(
  logicalProviderIds: readonly string[],
): AgentProviderConfigSnapshot {
  const profileIds = logicalProviderIds.map((id) => `${id}-primary`);
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = [${profileIds.map((id) => `"${id}"`).join(', ')}]

${logicalProviderIds
  .map(
    (logicalProviderId) => `[[providers]]
id = "${logicalProviderId}-primary"
logical_provider_id = "${logicalProviderId}"
family = "${logicalProviderId}"
capabilities = ["fresh-session", "plan-review", "resumable-session", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${logicalProviderId}-jsonl-v1"
executable = "/opt/providers/${logicalProviderId}"`,
  )
  .join('\n\n')}

[provider_preferences]
author = [${profileIds.map((id) => `"${id}"`).join(', ')}]
builder = [${profileIds.map((id) => `"${id}"`).join(', ')}]
reviewer = [${profileIds.map((id) => `"${id}"`).join(', ')}]
`,
    { platform: 'linux' },
  );
}

function splitCentral(
  logicalProviderIds: readonly string[],
): CentralRoleProviderDefaultV1 {
  return createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
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
          preferredLogicalProviderId: null,
        },
      },
    ],
    globalProviderRanking: logicalProviderIds,
  });
}

function centralSnapshot(
  pinnedCommit: string,
  configuration: CentralRoleProviderDefaultV1,
) {
  const source = renderCentralRoleProviderDefault(configuration);
  const objectFormat = pinnedCommit.length === 40 ? 'sha1' : 'sha256';
  return createCentralRoleProviderDefaultSnapshotV1({
    pinnedCommit,
    blobObjectId: crypto
      .createHash(objectFormat)
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest('hex'),
    configuration,
  });
}

function rolePlan(
  central: CentralRoleProviderDefaultV1,
  overrides: Partial<AgentRolePlanBodyV2> = {},
): CurrentAgentRolePlan {
  const body: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: [],
    customWrapperPolicy: 'forbidden',
    grantReferences: [],
    ...overrides,
  };
  return { ...body, planDigest: agentRolePlanV2Digest(body) };
}

function rolePlanSnapshot(plan: CurrentAgentRolePlan, pinnedCommit: string) {
  const source = renderAgentRolePlanV2(plan);
  const objectFormat = pinnedCommit.length === 40 ? 'sha1' : 'sha256';
  return createAgentRolePlanV2Snapshot({
    pinnedCommit,
    blobObjectId: crypto
      .createHash(objectFormat)
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest('hex'),
    plan,
  });
}

function fixture(
  options: Readonly<{
    commit?: string;
    changeOverride?: (
      central: CentralRoleProviderDefaultV1,
    ) => CurrentAgentRolePlan;
    inputManifestDigest?: string | null;
    relevantTargetDigest?: string | null;
  }> = {},
) {
  const logicalProviderIds = ['alpha', 'beta', 'gamma'] as const;
  const configuration = providerConfiguration(logicalProviderIds);
  const central = splitCentral(logicalProviderIds);
  const changeOverridePlan = options.changeOverride?.(central) ?? null;
  const inputManifestDigest =
    options.inputManifestDigest === undefined
      ? INPUT_MANIFEST_DIGEST
      : options.inputManifestDigest;
  const relevantTargetDigest =
    options.relevantTargetDigest === undefined
      ? RELEVANT_TARGET_DIGEST
      : options.relevantTargetDigest;
  const caller = {
    logicalProviderId: 'alpha',
    profileId: 'alpha-primary',
    engineSessionId: 'caller-session-alpha',
    adoptableRoles: ['author'] as const,
  };
  const dataAuthorization = {
    policyDigest: DATA_POLICY_DIGEST,
    inputManifestDigest,
    relevantTargetDigest,
    profiles: configuration.providers.map(({ id }) => ({
      profileId: id,
      allowed: true,
      reason: 'AUTHORIZED',
    })),
  };
  const sessionCapabilities = configuration.providers.map(({ id }) => ({
    profileId: id,
    canStartFresh: true,
    canResume: false,
  }));
  const providerRegistry = {
    schemaVersion: 1 as const,
    policyDigest: REGISTRY_POLICY_DIGEST,
    providers: logicalProviderIds.map((logicalProviderId, index) => ({
      logicalProviderId,
      providerFamily: logicalProviderId,
      enabled: true,
      definitionDigest: String(index + 1).repeat(64),
    })),
  };
  const providerRegistryDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(providerRegistry))
    .digest('hex');
  const resolverInput: ResolveChangeRoleAssignmentInputV1 = {
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverridePlan,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext:
      inputManifestDigest === null || relevantTargetDigest === null
        ? undefined
        : createChangeRoleAssignmentProtectedContextV1({
            classification: 'ordinary',
            pathRoleSourceDigest: PATH_ROLE_SOURCE_DIGEST,
            policySourceDigest: PROTECTED_POLICY_SOURCE_DIGEST,
            inputManifestDigest,
            relevantTargetDigest,
          }),
  };
  const result = resolveChangeRoleAssignmentV1(resolverInput);
  assert.notEqual(result.outcome, 'unsatisfied');
  const resolution = (
    result as Exclude<typeof result, { outcome: 'unsatisfied' }>
  ).resolution;
  return {
    input: {
      central: centralSnapshot(options.commit ?? CENTRAL_COMMIT, central),
      host: { sourceDigest: SOURCE_DIGEST, configuration },
      changeOverride:
        changeOverridePlan === null
          ? null
          : rolePlanSnapshot(
              changeOverridePlan,
              options.commit ?? CENTRAL_COMMIT,
            ),
      caller,
      dataAuthorization,
      sessionCapabilities,
      providerRegistry,
      resolution,
    },
  };
}

test('record creation binds the complete replay snapshot and deterministic session slots', () => {
  const { input } = fixture();
  const first = createChangeRoleAssignmentRecordV1(input);
  const replay = createChangeRoleAssignmentRecordV1(input);

  assert.deepEqual(first, replay);
  assert.match(first.assignmentDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.grantRequirement, null);
  assert.equal(first.central.pinnedCommit, CENTRAL_COMMIT);
  const centralSource = renderCentralRoleProviderDefault(
    first.central.configuration,
  );
  assert.equal(
    first.central.blobObjectId,
    crypto
      .createHash('sha1')
      .update(`blob ${Buffer.byteLength(centralSource)}\0`)
      .update(centralSource)
      .digest('hex'),
  );
  assert.equal(
    first.central.sourceDigest,
    crypto.createHash('sha256').update(centralSource).digest('hex'),
  );
  assert.equal(
    first.central.artifactPath,
    'workflow/role-provider-default.json',
  );
  assert.match(first.central.snapshotDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    first.central.configuration.configurationDigest,
    first.resolution.centralConfigurationDigest,
  );
  assert.equal(
    first.host.configuration.configDigest,
    first.resolution.providerConfigurationDigest,
  );
  assert.match(first.host.globalRankingDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    first.providerRegistry.registryDigest,
    first.resolution.providerRegistryDigest,
  );
  assert.match(
    first.dataAuthorization.decisionSnapshotDigest,
    /^[0-9a-f]{64}$/u,
  );
  assert.equal(
    first.dataAuthorization.snapshot.inputManifestDigest,
    INPUT_MANIFEST_DIGEST,
  );
  assert.equal(
    first.dataAuthorization.snapshot.relevantTargetDigest,
    RELEVANT_TARGET_DIGEST,
  );
  assert.equal(
    first.resolution.dataAuthorizationDecisionDigest,
    first.dataAuthorization.decisionSnapshotDigest,
  );
  assert.match(
    first.sessionCapabilities.capabilitySnapshotDigest,
    /^[0-9a-f]{64}$/u,
  );
  assert.deepEqual(
    first.sessionSlots.flatMap(({ roles }) => roles),
    ['author', 'builder', 'reviewer'],
  );
  assert.ok(
    first.sessionSlots.every(({ sessionSlotId }) =>
      /^role-assignment-session-[0-9a-f]{64}$/u.test(sessionSlotId),
    ),
  );
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(
    assertChangeRoleAssignmentRecordV1(first, {
      changeId: CHANGE_ID,
      planningGeneration: PLANNING_GENERATION,
      recordDigest: first.recordDigest,
    }),
    first,
  );
});

test('durable creation rejects simulation-only null evidence and assignment identity rebinds either exact input', () => {
  const baseline = createChangeRoleAssignmentRecordV1(fixture().input);
  const changedManifest = createChangeRoleAssignmentRecordV1(
    fixture({ inputManifestDigest: '1'.repeat(64) }).input,
  );
  const changedTarget = createChangeRoleAssignmentRecordV1(
    fixture({ relevantTargetDigest: '2'.repeat(64) }).input,
  );

  assert.notEqual(baseline.assignmentDigest, changedManifest.assignmentDigest);
  assert.notEqual(baseline.assignmentDigest, changedTarget.assignmentDigest);
  assert.throws(
    () =>
      createChangeRoleAssignmentRecordV1(
        fixture({
          inputManifestDigest: null,
          relevantTargetDigest: null,
        }).input,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
  );
});

test('record creation rejects an unverified commit and configuration pair without the full pinned DTO', () => {
  const { input } = fixture();
  assert.throws(
    () =>
      createChangeRoleAssignmentRecordV1({
        ...input,
        central: {
          pinnedCommit: input.central.pinnedCommit,
          configuration: input.central.configuration,
        } as any,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
  );
});

test('record replay rejects independently stale snapshots, derived digests, slots, and resolution', () => {
  const record = createChangeRoleAssignmentRecordV1(fixture().input);
  const mutations: Array<(value: any) => void> = [
    (value) => {
      value.central.pinnedCommit = 'f'.repeat(40);
    },
    (value) => {
      value.central.blobObjectId = 'f'.repeat(40);
    },
    (value) => {
      value.central.sourceDigest = 'f'.repeat(64);
    },
    (value) => {
      value.central.snapshotDigest = 'f'.repeat(64);
    },
    (value) => {
      value.resolution.protectedContext.pathRoleSourceDigest = 'f'.repeat(64);
    },
    (value) => {
      value.central.configuration.configurationDigest = 'f'.repeat(64);
    },
    (value) => {
      value.host.configuration.configDigest = 'f'.repeat(64);
    },
    (value) => {
      value.host.globalRankingDigest = 'f'.repeat(64);
    },
    (value) => {
      value.caller.logicalProviderId = 'gamma';
    },
    (value) => {
      value.dataAuthorization.snapshot.profiles[0].allowed = false;
    },
    (value) => {
      value.sessionCapabilities.snapshot[0].canStartFresh = false;
    },
    (value) => {
      value.providerRegistry.snapshot.providers[0].definitionDigest =
        'f'.repeat(64);
    },
    (value) => {
      value.resolution.resolutionDigest = 'f'.repeat(64);
    },
    (value) => {
      value.sessionSlots[0].sessionSlotId = `role-assignment-session-${'f'.repeat(64)}`;
    },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(record) as any;
    mutate(changed);
    assert.throws(
      () => assertChangeRoleAssignmentRecordV1(changed),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
    );
  }
});

test('a non-null v2 override is stored and fully replayed without translating to v1', () => {
  const { input } = fixture({
    changeOverride: (central) =>
      rolePlan(central, {
        roleLanes: [
          {
            role: 'builder',
            scopeRule: 'task',
            allowedProviderFamilies: [],
            preferredLogicalProviderIds: ['gamma'],
          },
        ],
      }),
  });
  const record = createChangeRoleAssignmentRecordV1(input);

  assert.equal(record.changeOverride?.plan.schemaVersion, 2);
  assert.equal(
    record.changeOverride?.plan.baseCentralConfigurationDigest,
    record.central.configuration.configurationDigest,
  );
  assert.equal(
    record.resolution.changeOverrideDigest,
    record.changeOverride?.planDigest,
  );
  assert.deepEqual(
    Object.fromEntries(
      record.resolution.placements.map(({ role, logicalProviderId }) => [
        role,
        logicalProviderId,
      ]),
    ),
    { author: 'alpha', builder: 'gamma', reviewer: 'beta' },
  );
  assert.deepEqual(assertChangeRoleAssignmentRecordV1(record), record);

  const tampered = structuredClone(record) as any;
  tampered.changeOverride.plan.planDigest = 'f'.repeat(64);
  assert.throws(
    () => assertChangeRoleAssignmentRecordV1(tampered),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
  );

  assert.throws(
    () =>
      createChangeRoleAssignmentRecordV1({
        ...input,
        changeOverride: {
          ...input.changeOverride!,
          planDigest: 'f'.repeat(64),
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
  );
});

test('the assignment record implementation has no legacy R007 authority dependency or receipt projection', () => {
  const source = fs.readFileSync(
    new URL(
      '../src/modules/provider-orchestration/change-role-assignment-record.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /@jigwright\/grants/u);
  assert.doesNotMatch(source, /R007|r007Reservation|expectedBinding/u);
  assert.doesNotMatch(source, /reservationReceipt|reservationRecord/u);
});

test('a below-floor candidate stores canonical central Grant requirement facts without proof or receipt authority', () => {
  const { input } = fixture({
    changeOverride: (central) =>
      rolePlan(central, {
        pairwiseRequirements: [
          { pair: 'author-builder', required: 'session-independent' },
          { pair: 'author-reviewer', required: 'session-independent' },
          { pair: 'builder-reviewer', required: 'session-independent' },
        ],
      }),
  });
  assert.deepEqual(input.resolution.exactGrantRolePairs, [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ]);
  const record = createChangeRoleAssignmentRecordV1(input);
  assert.deepEqual(record.grantRequirement?.exactRolePairs, [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ]);
  assert.deepEqual(Object.keys(record.grantRequirement!).sort(), [
    'assignmentDigest',
    'centralConfigurationDigest',
    'changeOverrideDigest',
    'dataAuthorizationDigest',
    'exactRolePairs',
    'hostConfigurationDigest',
    'kind',
    'providerRegistryDigest',
    'resolutionDigest',
    'schemaVersion',
    'sessionCapabilityDigest',
  ]);
  assert.equal(
    record.grantRequirement?.assignmentDigest,
    record.assignmentDigest,
  );
  assert.equal(
    record.grantRequirement?.resolutionDigest,
    record.resolution.resolutionDigest,
  );
  assert.equal(
    record.grantRequirement?.centralConfigurationDigest,
    record.resolution.centralConfigurationDigest,
  );
  assert.equal(
    record.grantRequirement?.changeOverrideDigest,
    record.resolution.changeOverrideDigest,
  );
  assert.equal(
    record.grantRequirement?.hostConfigurationDigest,
    record.host.configuration.configDigest,
  );
  assert.equal(
    record.grantRequirement?.providerRegistryDigest,
    record.providerRegistry.registryDigest,
  );
  assert.equal(
    record.grantRequirement?.dataAuthorizationDigest,
    record.dataAuthorization.decisionSnapshotDigest,
  );
  assert.equal(
    record.grantRequirement?.sessionCapabilityDigest,
    record.sessionCapabilities.capabilitySnapshotDigest,
  );
  for (const forbidden of [
    'grantId',
    'proofMethod',
    'reservationReceiptDigest',
    'consumeReceiptDigest',
  ]) {
    assert.equal(Object.hasOwn(record.grantRequirement!, forbidden), false);
  }
  assert.deepEqual(assertChangeRoleAssignmentRecordV1(record), record);

  const mutations: Array<(value: any) => void> = [
    (value: any) => {
      value.grantRequirement.exactRolePairs = ['author-builder'];
    },
    (value: any) => {
      value.grantRequirement.assignmentDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.resolutionDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.centralConfigurationDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.changeOverrideDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.hostConfigurationDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.providerRegistryDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.dataAuthorizationDigest = 'f'.repeat(64);
    },
    (value: any) => {
      value.grantRequirement.sessionCapabilityDigest = 'f'.repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(record) as any;
    mutate(changed);
    assert.throws(
      () => assertChangeRoleAssignmentRecordV1(changed),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_RECORD_INVALID',
    );
  }
});
