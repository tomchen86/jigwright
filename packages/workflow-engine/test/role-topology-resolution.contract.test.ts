/**
 * Checks topology resolution and exact-plan reviewer preparation against policy snapshots.
 *
 * Invariants:
 * - Candidate selection observes one snapshot and preserves the configured independence floor.
 * - Only explicitly eligible lowered placements produce exact grant requirements.
 *
 * Depends on: topology resolution, plan-review preparation, and the production snapshot port.
 * Failure modes: policy drift, incorrect reviewer assignments, or mismatched grant bindings.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
  type AgentRolePlanV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
  resolveRoleTopologyV1,
  type CentralRoleTopologyConfigurationV1,
  type RoleTopologyResolutionDependencyPortV1,
  type RoleTopologyProviderRegistryV1,
} from '../src/modules/provider-orchestration/role-topology-resolution.ts';
import {
  resolvePlanReviewRoleTopology,
  preparePlanReviewRoleTopology,
} from '../src/runtime/proposal/plan-review-role-topology.ts';
import { type PreparePlanReviewRoleTopologyInput } from '../src/modules/proposal/plan-review-role-topology.ts';
import { createProductionRoleTopologyResolutionPort } from '../src/composition-root/role-topology-resolution-production.ts';
import { isWorkflowError } from './fixture.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const CHANGE_ID = 'topology-change';
const PLANNING_GENERATION = 'a'.repeat(64);
const PROVIDER_POLICY_DIGEST = 'b'.repeat(64);
const GRANT_REFERENCE = '12345678-1234-4123-8123-123456789abc';

const CENTRAL_PROVIDER_CONFIGURATION = createCentralRoleProviderDefault({
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
        preferredLogicalProviderId: 'claude',
      },
    },
  ],
  globalProviderRanking: ['claude', 'codex'],
});
const CENTRAL_CONFIGURATION_DIGEST =
  CENTRAL_PROVIDER_CONFIGURATION.configurationDigest;

function centralConfiguration(
  required: 'provider-independent' | 'session-independent' | 'none',
): CentralRoleTopologyConfigurationV1 {
  return {
    schemaVersion: 1,
    configurationId: `fixture-${required}`,
    pairwiseRequirements: [
      { pair: 'author-builder', required },
      { pair: 'author-reviewer', required },
      { pair: 'builder-reviewer', required },
    ],
  };
}

function registry(
  logicalProviderIds: readonly string[],
): RoleTopologyProviderRegistryV1 {
  return {
    schemaVersion: 1,
    policyDigest: PROVIDER_POLICY_DIGEST,
    providers: logicalProviderIds.map((logicalProviderId, index) => ({
      logicalProviderId,
      providerFamily: logicalProviderId,
      enabled: true,
      definitionDigest: String(index + 1).repeat(64),
    })),
  };
}

function rolePlan(
  pairwiseRequirements: AgentRolePlanBodyV2['pairwiseRequirements'],
  grantReferences: readonly string[] = [],
  baseCentralConfigurationDigest = CENTRAL_CONFIGURATION_DIGEST,
): AgentRolePlanV2 {
  const body: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest,
    roleLanes: [],
    pairwiseRequirements,
    customWrapperPolicy: 'forbidden',
    grantReferences,
  };
  return { ...body, planDigest: agentRolePlanV2Digest(body) };
}

function writeCentralProviderConfiguration(repository: string): void {
  const destination = path.join(
    repository,
    'workflow/role-provider-default.json',
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    renderCentralRoleProviderDefault(CENTRAL_PROVIDER_CONFIGURATION),
  );
}

function writeRolePlan(repository: string, plan: AgentRolePlanV2): string {
  const destination = path.join(
    repository,
    'workflow',
    'agent-plans',
    `${CHANGE_ID}.json`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderAgentRolePlanV2(plan));
  return destination;
}

test('current central floor records stronger provider independence and emits four bound digests', () => {
  const resolution = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: null,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    changeOverride: null,
    providerRegistry: registry(['claude', 'codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '2'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'claude',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });

  assert.equal(resolution.disposition, 'satisfied');
  assert.deepEqual(resolution.exactGrantRolePairs, []);
  assert.deepEqual(resolution.actualRolePairs, [
    {
      pair: 'author-reviewer',
      required: 'session-independent',
      achieved: 'provider-independent',
      left: resolution.actualPlacements[0],
      right: resolution.actualPlacements[1],
      meetsOrExceedsConfiguredTopology: true,
    },
  ]);
  assert.deepEqual(resolution.explicitEligibility, {
    status: 'not-required',
    explicitlyListed: false,
    grantReferences: [],
  });
  for (const digest of [
    resolution.centralRoleConfigurationDigest,
    resolution.changeOverrideDigest,
    resolution.providerRegistryDigest,
    resolution.eligibilityPolicyDigest,
  ]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test('session-independent resolution digests are directly compatible with role-context binding fields', () => {
  const resolution = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    changeOverride: rolePlan(
      [{ pair: 'author-reviewer', required: 'session-independent' }],
      [GRANT_REFERENCE],
    ),
    providerRegistry: registry(['codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });

  assert.equal(resolution.disposition, 'satisfied');
  assert.deepEqual(resolution.exactGrantRolePairs, []);
  assert.equal(resolution.centralRoleConfigurationDigest.length, 64);
  assert.equal(resolution.changeOverrideDigest.length, 64);
  assert.equal(resolution.providerRegistryDigest.length, 64);
  assert.equal(resolution.eligibilityPolicyDigest.length, 64);
  assert.deepEqual(
    {
      centralRoleConfigurationDigest: resolution.centralRoleConfigurationDigest,
      changeOverrideDigest: resolution.changeOverrideDigest,
      providerRegistryDigest: resolution.providerRegistryDigest,
      eligibilityPolicyDigest: resolution.eligibilityPolicyDigest,
      rolePairs: resolution.exactGrantRolePairs,
    },
    {
      centralRoleConfigurationDigest: resolution.centralRoleConfigurationDigest,
      changeOverrideDigest: resolution.changeOverrideDigest,
      providerRegistryDigest: resolution.providerRegistryDigest,
      eligibilityPolicyDigest: resolution.eligibilityPolicyDigest,
      rolePairs: [],
    },
  );
});

test('logical aliases in one provider family satisfy the ordinary fresh-session floor', () => {
  const resolution = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
    changeOverride: rolePlan(
      [{ pair: 'author-reviewer', required: 'session-independent' }],
      [GRANT_REFERENCE],
    ),
    providerRegistry: {
      schemaVersion: 1,
      policyDigest: PROVIDER_POLICY_DIGEST,
      providers: [
        {
          logicalProviderId: 'codex-primary',
          providerFamily: 'codex',
          enabled: true,
          definitionDigest: '1'.repeat(64),
        },
        {
          logicalProviderId: 'codex-secondary',
          providerFamily: 'codex',
          enabled: true,
          definitionDigest: '2'.repeat(64),
        },
      ],
    },
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex-primary',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex-secondary',
        providerDefinitionDigest: '2'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });

  assert.equal(resolution.actualRolePairs[0]?.achieved, 'session-independent');
  assert.deepEqual(resolution.exactGrantRolePairs, []);
  assert.equal(resolution.disposition, 'satisfied');
});

test('proposal topology owners preserve the injected snapshot boundary', () => {
  for (const owner of ['runtime', 'modules']) {
    const file = path.resolve(
      import.meta.dirname,
      `../src/${owner}/proposal/plan-review-role-topology.ts`,
    );
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"][^'"]*(?:adapters|runtime|composition-root)\//u,
    );
  }
  assert.ok(
    assertPureDependencyClosure(
      path.resolve(
        import.meta.dirname,
        '../src/modules/proposal/plan-review-role-topology.ts',
      ),
    ).size >= 1,
  );
});

test('provider registry ordering is canonical rather than caller-order dependent', () => {
  assert.throws(
    () =>
      resolveRoleTopologyV1({
        changeId: CHANGE_ID,
        planningGeneration: PLANNING_GENERATION,
        baseCentralConfigurationDigest: null,
        centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
        changeOverride: null,
        providerRegistry: registry(['codex', 'claude']),
        actualPlacements: [
          {
            role: 'author',
            logicalProviderId: 'codex',
            providerDefinitionDigest: '1'.repeat(64),
            sessionId: 'author-session',
          },
          {
            role: 'reviewer',
            logicalProviderId: 'claude',
            providerDefinitionDigest: '2'.repeat(64),
            sessionId: 'reviewer-session',
          },
        ],
      }),
    (error) => isWorkflowError(error, 'ROLE_TOPOLOGY_INVALID'),
  );
});

test('one fully collapsed override returns the canonical exact three-pair grant set without authorizing it', () => {
  const resolution = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: centralConfiguration('provider-independent'),
    changeOverride: rolePlan(
      [
        { pair: 'author-builder', required: 'none' },
        { pair: 'author-reviewer', required: 'none' },
        { pair: 'builder-reviewer', required: 'none' },
      ],
      [GRANT_REFERENCE],
    ),
    providerRegistry: registry(['codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'shared-session',
      },
      {
        role: 'builder',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'shared-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'shared-session',
      },
    ],
  });

  assert.equal(resolution.disposition, 'exact-grant-required');
  assert.deepEqual(resolution.exactGrantRolePairs, [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ]);
  assert.equal(
    resolution.actualRolePairs.every(
      ({ achieved, meetsOrExceedsConfiguredTopology }) =>
        achieved === 'none' && meetsOrExceedsConfiguredTopology,
    ),
    true,
  );
  assert.deepEqual(resolution.explicitEligibility, {
    status: 'listed',
    explicitlyListed: true,
    grantReferences: [GRANT_REFERENCE],
  });
});

test('a stronger override is grant-free while an unlisted weakening fails closed with its exact pair set', () => {
  const stronger = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: centralConfiguration('none'),
    changeOverride: rolePlan([
      { pair: 'author-builder', required: 'provider-independent' },
      { pair: 'author-reviewer', required: 'provider-independent' },
      { pair: 'builder-reviewer', required: 'provider-independent' },
    ]),
    providerRegistry: registry(['alpha', 'bravo', 'charlie']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'alpha',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'builder',
        logicalProviderId: 'bravo',
        providerDefinitionDigest: '2'.repeat(64),
        sessionId: 'builder-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'charlie',
        providerDefinitionDigest: '3'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });
  assert.equal(stronger.disposition, 'satisfied');
  assert.deepEqual(stronger.exactGrantRolePairs, []);

  const weakening = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: centralConfiguration('provider-independent'),
    changeOverride: rolePlan([
      { pair: 'author-reviewer', required: 'session-independent' },
    ]),
    providerRegistry: registry(['codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });
  assert.equal(weakening.disposition, 'exact-grant-required');
  assert.deepEqual(weakening.exactGrantRolePairs, ['author-reviewer']);
  assert.deepEqual(weakening.explicitEligibility, {
    status: 'unlisted',
    explicitlyListed: false,
    grantReferences: [],
  });
});

test('an actual stronger split is accepted but cannot mask a stronger requested override', () => {
  const resolution = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: null,
    centralConfiguration: centralConfiguration('none'),
    changeOverride: null,
    providerRegistry: registry(['claude', 'codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '2'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'claude',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });

  assert.equal(resolution.disposition, 'satisfied');
  assert.equal(
    resolution.actualRolePairs[0]?.meetsOrExceedsConfiguredTopology,
    true,
  );
  assert.deepEqual(resolution.exactGrantRolePairs, []);

  const underRequestedOverride = resolveRoleTopologyV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    centralConfiguration: centralConfiguration('none'),
    changeOverride: rolePlan([
      { pair: 'author-reviewer', required: 'provider-independent' },
    ]),
    providerRegistry: registry(['codex']),
    actualPlacements: [
      {
        role: 'author',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'author-session',
      },
      {
        role: 'reviewer',
        logicalProviderId: 'codex',
        providerDefinitionDigest: '1'.repeat(64),
        sessionId: 'reviewer-session',
      },
    ],
  });
  assert.equal(underRequestedOverride.disposition, 'topology-unsatisfied');
  assert.equal(
    underRequestedOverride.actualRolePairs[0]?.meetsOrExceedsConfiguredTopology,
    false,
  );
  assert.deepEqual(underRequestedOverride.exactGrantRolePairs, []);
});

test('a policy-disabled provider cannot form an admitted actual topology', () => {
  const providerRegistry = registry(['claude', 'codex']);
  assert.throws(
    () =>
      resolveRoleTopologyV1({
        changeId: CHANGE_ID,
        planningGeneration: PLANNING_GENERATION,
        baseCentralConfigurationDigest: null,
        centralConfiguration: CURRENT_CENTRAL_ROLE_TOPOLOGY_CONFIGURATION_V1,
        changeOverride: null,
        providerRegistry: {
          ...providerRegistry,
          providers: providerRegistry.providers.map((entry) =>
            entry.logicalProviderId === 'codex'
              ? { ...entry, enabled: false }
              : entry,
          ),
        },
        actualPlacements: [
          {
            role: 'author',
            logicalProviderId: 'codex',
            providerDefinitionDigest: '2'.repeat(64),
            sessionId: 'author-session',
          },
          {
            role: 'reviewer',
            logicalProviderId: 'claude',
            providerDefinitionDigest: '1'.repeat(64),
            sessionId: 'reviewer-session',
          },
        ],
      }),
    (error) => isWorkflowError(error, 'ROLE_TOPOLOGY_INVALID'),
  );
});

test('plan-review resolver uses its required snapshot port and accepts a fresh same-provider session', () => {
  const providerRegistry = registry(['claude', 'codex']);
  let changeOverride: AgentRolePlanV2 | null = null;
  const requests: Parameters<
    RoleTopologyResolutionDependencyPortV1['readResolutionSnapshot']
  >[0][] = [];
  const dependencies: RoleTopologyResolutionDependencyPortV1 = {
    readResolutionSnapshot(request) {
      requests.push(request);
      return {
        baseCentralConfigurationDigest:
          changeOverride?.baseCentralConfigurationDigest ?? null,
        changeOverride,
        providerRegistry,
      };
    },
  };
  const common = {
    repositoryRoot: '/fixture/repository',
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    author: { providerId: 'codex', sessionId: 'author-session' },
    reviewer: {
      providerId: 'claude',
      sessionId: 'reviewer-session',
    },
    providerPolicyDigest: PROVIDER_POLICY_DIGEST,
    providerEnabled: { claude: true, codex: true },
  };
  assert.equal(
    resolvePlanReviewRoleTopology(common, dependencies).disposition,
    'satisfied',
  );
  assert.deepEqual(requests[0], {
    repositoryRoot: common.repositoryRoot,
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    providerPolicyDigest: PROVIDER_POLICY_DIGEST,
    providerEnabled: common.providerEnabled,
  });

  const plan = rolePlan(
    [{ pair: 'author-reviewer', required: 'session-independent' }],
    [GRANT_REFERENCE],
  );
  changeOverride = plan;

  const strongerResolution = resolvePlanReviewRoleTopology(
    common,
    dependencies,
  );
  assert.equal(strongerResolution.disposition, 'satisfied');
  assert.equal(strongerResolution.planningGeneration, PLANNING_GENERATION);
  assert.equal(strongerResolution.changeOverrideDigest, plan.planDigest);
  assert.deepEqual(strongerResolution.exactGrantRolePairs, []);
  assert.equal(
    strongerResolution.actualRolePairs[0]?.achieved,
    'provider-independent',
  );
  assert.equal(
    strongerResolution.actualRolePairs[0]?.meetsOrExceedsConfiguredTopology,
    true,
  );

  const weakenedResolution = resolvePlanReviewRoleTopology(
    {
      ...common,
      reviewer: {
        providerId: 'codex',
        sessionId: 'reviewer-session',
      },
    },
    dependencies,
  );
  assert.equal(weakenedResolution.disposition, 'satisfied');
  assert.deepEqual(weakenedResolution.exactGrantRolePairs, []);
  assert.equal(
    weakenedResolution.actualRolePairs[0]?.achieved,
    'session-independent',
  );
});

test('plan-review preparation satisfies strengthened topology before returning an exact R-007 requirement', () => {
  const providerRegistry = registry(['claude', 'codex']);
  const changeOverride = rolePlan(
    [{ pair: 'author-reviewer', required: 'provider-independent' }],
    [GRANT_REFERENCE],
  );
  const input: PreparePlanReviewRoleTopologyInput = {
    topology: {
      repositoryRoot: '/fixture/repository',
      changeId: CHANGE_ID,
      planningGeneration: PLANNING_GENERATION,
      author: { providerId: 'codex', sessionId: 'author-session' },
      providerPolicyDigest: PROVIDER_POLICY_DIGEST,
      providerEnabled: { claude: true, codex: true },
    },
    author: {
      providerId: 'codex',
      sessionId: 'author-session',
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: false,
    },
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'reviewer-codex-session',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'reviewer-claude-session',
        enabled: true,
        available: true,
      },
    ],
    requirement: {
      investigationId: 'investigation-topology',
      changeId: CHANGE_ID,
      baseline: { head: '1'.repeat(40), tree: '2'.repeat(40) },
      subject: {
        schemaVersion: 1,
        subjectDigest: '3'.repeat(64),
        planningGenerationId: PLANNING_GENERATION,
        planTargetDigest: '4'.repeat(64),
        manifestDigest: '5'.repeat(64),
        investigationTargetDigest: '6'.repeat(64),
        reviewPolicyDigest: '7'.repeat(64),
        requiredIndependence: 'session-independent',
        investigationBaseline: { head: '1'.repeat(40), tree: '2'.repeat(40) },
        investigationDependencies: [],
        investigationRequirements: [],
      },
      author: {
        providerId: 'codex',
        sessionId: 'author-session',
        principalId: null,
        identityAssurance: 'adapter-assigned',
        engineSpawned: false,
      },
      contextGeneration: 3,
    },
  };
  let reads = 0;
  const dependencies: RoleTopologyResolutionDependencyPortV1 = {
    readResolutionSnapshot(request) {
      reads += 1;
      return {
        baseCentralConfigurationDigest:
          changeOverride.baseCentralConfigurationDigest,
        changeOverride,
        providerRegistry: {
          ...providerRegistry,
          providers: providerRegistry.providers.map((provider) => ({
            ...provider,
            enabled: request.providerEnabled[provider.logicalProviderId]!,
          })),
        },
      };
    },
  };
  const selected = preparePlanReviewRoleTopology(input, dependencies);
  assert.equal(reads, 1);
  assert.equal(selected.kind, 'assigned');
  assert.equal(selected.roleTopology.disposition, 'satisfied');
  if (selected.kind !== 'assigned')
    assert.fail('Expected an ordinary reviewer.');
  assert.equal(selected.assignment.providerId, 'claude');
  assert.equal(selected.assignment.sessionId, 'reviewer-claude-session');
  assert.equal(
    selected.assignment.requiredIndependence,
    'provider-independent',
  );
  assert.equal(
    selected.assignment.achievedIndependence,
    'provider-independent',
  );
  assert.deepEqual(selected.roleTopology.exactGrantRolePairs, []);

  const lowered = preparePlanReviewRoleTopology(
    {
      ...input,
      topology: {
        ...input.topology,
        providerEnabled: { claude: false, codex: true },
      },
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        enabled: candidate.providerId === 'codex',
        available: candidate.providerId === 'codex',
      })),
    },
    dependencies,
  );
  assert.equal(reads, 2);
  assert.equal(lowered.kind, 'grant-required');
  if (lowered.kind !== 'grant-required')
    assert.fail('Expected an exact R-007 requirement.');
  assert.equal(lowered.roleTopology.disposition, 'exact-grant-required');
  assert.deepEqual(lowered.roleTopology.exactGrantRolePairs, [
    'author-reviewer',
  ]);
  assert.equal(
    lowered.requirement.reviewerPlacement.logicalProviderId,
    'codex',
  );
  assert.equal(
    lowered.requirement.reviewerPlacement.sessionId,
    'reviewer-codex-session',
  );
  assert.equal(lowered.requirement.contextGeneration, 3);
  assert.deepEqual(lowered.requirement.grantReferences, [GRANT_REFERENCE]);
  assert.deepEqual(lowered.requirement.subject, input.requirement.subject);
  assert.deepEqual(lowered.requirement.author, input.requirement.author);
});

test('production snapshot port owns current plan and reviewed provider-definition capture', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'role-topology-production-port-'),
  );
  try {
    const port = createProductionRoleTopologyResolutionPort('darwin');
    const request = {
      repositoryRoot: repository,
      changeId: CHANGE_ID,
      planningGeneration: PLANNING_GENERATION,
      providerPolicyDigest: PROVIDER_POLICY_DIGEST,
      providerEnabled: { claude: true, codex: false },
    };
    const initial = port.readResolutionSnapshot(request);
    assert.equal(initial.baseCentralConfigurationDigest, null);
    assert.equal(initial.changeOverride, null);
    assert.deepEqual(
      initial.providerRegistry.providers.map(
        ({ logicalProviderId, providerFamily, enabled }) => ({
          logicalProviderId,
          providerFamily,
          enabled,
        }),
      ),
      [
        {
          logicalProviderId: 'claude',
          providerFamily: 'claude',
          enabled: true,
        },
        {
          logicalProviderId: 'codex',
          providerFamily: 'codex',
          enabled: false,
        },
      ],
    );
    assert.equal(
      initial.providerRegistry.providers.every(({ definitionDigest }) =>
        /^[0-9a-f]{64}$/u.test(definitionDigest ?? ''),
      ),
      true,
    );

    writeCentralProviderConfiguration(repository);
    const plan = rolePlan([
      { pair: 'author-reviewer', required: 'session-independent' },
    ]);
    const destination = writeRolePlan(repository, plan);
    const snapshot = port.readResolutionSnapshot(request);
    assert.equal(
      snapshot.baseCentralConfigurationDigest,
      CENTRAL_CONFIGURATION_DIGEST,
    );
    assert.deepEqual(snapshot.changeOverride, plan);

    writeRolePlan(
      repository,
      rolePlan(
        [{ pair: 'author-reviewer', required: 'session-independent' }],
        [],
        'f'.repeat(64),
      ),
    );
    assert.throws(
      () => port.readResolutionSnapshot(request),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.writeFileSync(
      destination,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          changeId: CHANGE_ID,
          planningGeneration: PLANNING_GENERATION,
          roleLanes: [],
          pairwiseRequirements: [],
          customWrapperPolicy: 'forbidden',
          grantReferences: [],
          planDigest: '0'.repeat(64),
        },
        null,
        2,
      )}\n`,
    );
    assert.throws(
      () => port.readResolutionSnapshot(request),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production snapshot refuses cross-file role policy drift', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'role-topology-policy-drift-'),
  );
  const destination = path.join(
    repository,
    'workflow',
    'agent-plans',
    CHANGE_ID.concat('.json'),
  );
  const replacement = path.join(repository, 'replacement-agent-role-plan.json');
  writeCentralProviderConfiguration(repository);
  writeRolePlan(
    repository,
    rolePlan([{ pair: 'author-reviewer', required: 'session-independent' }]),
  );
  fs.writeFileSync(
    replacement,
    renderAgentRolePlanV2(
      rolePlan([{ pair: 'author-reviewer', required: 'none' }]),
    ),
  );
  const originalCloseSync = fs.closeSync;
  let firstPolicyReadClosed = false;
  fs.closeSync = (descriptor: number): void => {
    originalCloseSync(descriptor);
    if (!firstPolicyReadClosed) {
      firstPolicyReadClosed = true;
      fs.renameSync(replacement, destination);
    }
  };
  try {
    const port = createProductionRoleTopologyResolutionPort('darwin');
    assert.throws(
      () =>
        port.readResolutionSnapshot({
          repositoryRoot: repository,
          changeId: CHANGE_ID,
          planningGeneration: PLANNING_GENERATION,
          providerPolicyDigest: PROVIDER_POLICY_DIGEST,
          providerEnabled: { claude: true, codex: true },
        }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.closeSync = originalCloseSync;
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('production CLI injects the topology snapshot port into start, resume, and immediate intake', () => {
  const source = fs.readFileSync(
    new URL('../src/entrypoints/cli/workflow-cli.ts', import.meta.url),
    'utf8',
  );
  const taskLifecycle = fs.readFileSync(
    new URL('../src/entrypoints/cli/task-lifecycle-cli.ts', import.meta.url),
    'utf8',
  );
  const immediateIntake = fs.readFileSync(
    new URL(
      '../src/composition-root/governance-intake-command-production.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    taskLifecycle,
    /import \{ productionRoleTopologyResolutionPort \} from '\.\.\/\.\.\/composition-root\/role-topology-resolution-production\.ts';/u,
  );
  assert.match(
    immediateIntake,
    /import \{ productionRoleTopologyResolutionPort \} from '\.\/role-topology-resolution-production\.ts';/u,
  );
  for (const [owner, count] of [
    [taskLifecycle, 2],
    [immediateIntake, 1],
  ] as const) {
    assert.equal(
      owner.match(
        /roleTopologyResolution:\s*productionRoleTopologyResolutionPort/gu,
      )?.length,
      count,
    );
  }
  assert.match(
    source,
    /import\s*\{[^}]*\bcreateGovernanceIntakeCommandDependencies\b[^}]*\}\s*from '\.\.\/\.\.\/composition-root\/governance-intake-command-production\.ts';/u,
  );
  assert.match(
    source,
    /const intakeDependencies = createGovernanceIntakeCommandDependencies\(\);/u,
  );
  assert.match(
    source,
    /dispatchGovernanceIntakeCommand\(\s*command,\s*rest,\s*discoverRepository\(cwd\)\.repositoryRoot,\s*intakeDependencies,\s*\)/u,
  );
});
