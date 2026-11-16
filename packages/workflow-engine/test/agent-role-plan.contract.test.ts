import { planningAssuranceDependencies } from '../src/composition-root/planning-assurance-production.ts';
import {
  readCurrentPlanningAgentRolePlanV2,
  readCurrentPlanningRoleOverridePolicy,
} from '../src/runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  parseAgentRolePlanV2,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
  type AgentRolePlanV2,
  type CurrentAgentRolePlan,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  parseCurrentCentralRoleProviderDefaultPolicy,
  parseCurrentAgentRolePlanV2,
  projectCurrentPlanningRoleOverridePolicy,
  assertCurrentPlanningRoleOverridePolicy,
} from '../src/modules/provider-orchestration/planning-role-provider-policy.ts';
import { assertPlanningPaths } from '../src/composition-root/planning-provider-production.ts';
import {
  agentRolePlanV2Path,
  partitionPlanningRolePolicyPaths,
} from '../src/modules/source/planning-role-policy-paths.ts';
import {
  assertPinnedAgentRolePlanV2Snapshot,
  readCurrentAgentRolePlanV2,
  readPinnedAgentRolePlanV2,
  readPinnedAgentRolePlanV2Snapshot,
} from '../src/runtime/repository-transaction/agent-role-plan-store.ts';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const CHANGE_ID = 'demo-change';

function centralConfiguration() {
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
          preferredLogicalProviderId: 'claude',
        },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
}

const CENTRAL_CONFIGURATION_DIGEST = centralConfiguration().configurationDigest;

function planBodyV2(
  overrides: Partial<AgentRolePlanBodyV2> = {},
): AgentRolePlanBodyV2 {
  return {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    roleLanes: [
      {
        role: 'author',
        scopeRule: 'planning-generation',
        allowedProviderFamilies: ['anthropic', 'openai'],
        preferredLogicalProviderIds: ['claude', 'codex'],
      },
      {
        role: 'builder',
        scopeRule: 'task',
        allowedProviderFamilies: ['openai'],
        preferredLogicalProviderIds: ['codex'],
      },
      {
        role: 'reviewer',
        scopeRule: 'candidate',
        allowedProviderFamilies: ['anthropic'],
        preferredLogicalProviderIds: ['claude'],
      },
    ],
    pairwiseRequirements: [
      { pair: 'author-builder', required: 'session-independent' },
      { pair: 'author-reviewer', required: 'provider-independent' },
      { pair: 'builder-reviewer', required: 'provider-independent' },
    ],
    customWrapperPolicy: 'allowed-non-protected',
    grantReferences: ['12345678-1234-4123-8123-123456789abc'],
    ...overrides,
  };
}

function planV2(overrides: Partial<AgentRolePlanBodyV2> = {}): AgentRolePlanV2 {
  const body = planBodyV2(overrides);
  return { ...body, planDigest: agentRolePlanV2Digest(body) };
}

function parseObjectV2(value: unknown): AgentRolePlanV2 {
  return parseAgentRolePlanV2(
    `${JSON.stringify(value, null, 2)}\n`,
    CHANGE_ID,
    CENTRAL_CONFIGURATION_DIGEST,
  );
}

function temporaryRepository(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-role-plan-'));
}

function planPath(repository: string): string {
  return path.join(repository, 'workflow', 'agent-plans', `${CHANGE_ID}.json`);
}

function writePlanV2(repository: string, value = planV2()): string {
  const destination = planPath(repository);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderAgentRolePlanV2(value));
  return destination;
}

function writeCentralConfiguration(repository: string): void {
  const destination = path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    renderCentralRoleProviderDefault(centralConfiguration()),
  );
}

test('agent-role plan v2 closes over the central configuration without a self-referential planning generation', () => {
  const value: CurrentAgentRolePlan = planV2();
  const document = renderAgentRolePlanV2(value);
  const parsed = parseAgentRolePlanV2(
    document,
    CHANGE_ID,
    CENTRAL_CONFIGURATION_DIGEST,
  );

  assert.deepEqual(parsed, value);
  assert.equal(parsed.planDigest, agentRolePlanV2Digest(planBodyV2()));
  assert.equal('planningGeneration' in parsed, false);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.roleLanes), true);
  assert.equal(Object.isFrozen(parsed.pairwiseRequirements), true);

  assert.equal(renderAgentRolePlanV2(parsed), document);
  assert.equal(Object.isFrozen(parsed.roleLanes[0]), true);
  assert.equal(
    Object.isFrozen(parsed.roleLanes[0]?.allowedProviderFamilies),
    true,
  );
  assert.equal(Object.isFrozen(parsed.pairwiseRequirements[0]), true);
  assert.equal(Object.isFrozen(parsed.grantReferences), true);
  assert.throws(
    () =>
      parseAgentRolePlanV2(
        document.trimEnd().concat(' ', String.fromCharCode(10)),
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  const schemaOneDocument = JSON.stringify(
    { schemaVersion: 1 },
    null,
    2,
  ).concat(String.fromCharCode(10));
  assert.throws(
    () =>
      parseAgentRolePlanV2(
        schemaOneDocument,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED'),
  );
});

test('agent-role plan v2 rejects central drift, stale digests, and embedded authority', () => {
  const value = planV2();
  assert.throws(
    () =>
      parseAgentRolePlanV2(
        renderAgentRolePlanV2(value),
        CHANGE_ID,
        'f'.repeat(64),
      ),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () => parseObjectV2({ ...value, planDigest: 'f'.repeat(64) }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  assert.throws(
    () => parseObjectV2({ ...value, signedGrant: 'not-override-intent' }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  for (const malformed of [
    {
      ...value,
      roleLanes: [value.roleLanes[0], value.roleLanes[0]],
    },
    {
      ...value,
      pairwiseRequirements: [
        value.pairwiseRequirements[0],
        value.pairwiseRequirements[0],
      ],
    },
    {
      ...value,
      pairwiseRequirements: [
        { pair: 'author-author', required: 'principal-independent' },
      ],
    },
  ]) {
    assert.throws(
      () => parseObjectV2(malformed),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  }
});

test('agent-role plan cannot carry execution or credential authority', () => {
  const value = planV2();
  for (const [field, injected] of [
    ['executable', '/usr/local/bin/claude'],
    ['argv', ['--dangerously-skip-permissions']],
    ['shell', 'rm -rf workspace'],
    ['credentials', { path: '/tmp/provider-token' }],
  ] as const) {
    assert.throws(
      () => parseObjectV2({ ...value, [field]: injected }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      field,
    );
    assert.throws(
      () =>
        parseObjectV2({
          ...value,
          roleLanes: [
            { ...value.roleLanes[0], [field]: injected },
            ...value.roleLanes.slice(1),
          ],
        }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      `nested ${field}`,
    );
  }

  for (const roleLane of [
    {
      ...value.roleLanes[0],
      allowedProviderFamilies: ['../anthropic'],
    },
    {
      ...value.roleLanes[0],
      preferredLogicalProviderIds: ['codex;launch'],
    },
  ]) {
    assert.throws(
      () =>
        parseObjectV2({
          ...value,
          roleLanes: [roleLane, ...value.roleLanes.slice(1)],
        }),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  }
  assert.throws(
    () =>
      parseObjectV2({ ...value, grantReferences: ['secret/provider-token'] }),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
});

test('current agent-role plan reader returns null for absence and rejects unsafe or stale files', () => {
  const repository = temporaryRepository();
  try {
    assert.equal(
      readCurrentAgentRolePlanV2(
        repository,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      null,
    );
    fs.mkdirSync(path.dirname(planPath(repository)), { recursive: true });
    assert.equal(
      readCurrentAgentRolePlanV2(
        repository,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      null,
    );
    writePlanV2(repository);
    assert.deepEqual(
      readCurrentAgentRolePlanV2(
        repository,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      planV2(),
    );
    assert.throws(
      () => readCurrentAgentRolePlanV2(repository, CHANGE_ID, 'b'.repeat(64)),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }

  for (const mutate of [
    (repository: string, destination: string) =>
      fs.chmodSync(destination, 0o755),
    (repository: string, destination: string) => {
      const target = path.join(repository, 'agent-plan-target.json');
      fs.renameSync(destination, target);
      fs.symlinkSync(target, destination);
    },
    (repository: string, destination: string) =>
      fs.linkSync(destination, path.join(repository, 'agent-plan-alias.json')),
    (repository: string, destination: string) =>
      fs.writeFileSync(destination, Buffer.from([0xff])),
    (repository: string, destination: string) =>
      fs.writeFileSync(destination, Buffer.alloc(64 * 1024 + 1, 0x61)),
  ]) {
    const unsafeRepository = temporaryRepository();
    try {
      const destination = writePlanV2(unsafeRepository);
      mutate(unsafeRepository, destination);
      assert.throws(
        () =>
          readCurrentAgentRolePlanV2(
            unsafeRepository,
            CHANGE_ID,
            CENTRAL_CONFIGURATION_DIGEST,
          ),
        (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      );
    } finally {
      fs.rmSync(unsafeRepository, { recursive: true, force: true });
    }
  }
});

test('pinned agent-role plan reader accepts only an exact bounded 100644 blob', () => {
  const repository = temporaryRepository();
  try {
    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.email', 'agent-plan@example.test']);
    git(repository, ['config', 'user.name', 'Agent Plan Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-q', '-m', 'Create fixture']);
    const absentCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      readPinnedAgentRolePlanV2(
        repository,
        absentCommit,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      null,
    );

    writePlanV2(repository);
    git(repository, ['add', `workflow/agent-plans/${CHANGE_ID}.json`]);
    git(repository, ['commit', '-q', '-m', 'Add optional agent plan']);
    const validCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.deepEqual(
      readPinnedAgentRolePlanV2(
        repository,
        validCommit,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      planV2(),
    );
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          'HEAD',
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    git(repository, [
      'update-index',
      '--chmod=+x',
      `workflow/agent-plans/${CHANGE_ID}.json`,
    ]);
    git(repository, ['commit', '-q', '-m', 'Make plan executable']);
    const executableCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          executableCommit,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.rmSync(planPath(repository));
    fs.symlinkSync('../../README.md', planPath(repository));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Make plan a symlink']);
    const symlinkCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          symlinkCommit,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.rmSync(planPath(repository));
    fs.writeFileSync(planPath(repository), Buffer.from([0xff]));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Write invalid UTF-8 plan']);
    const invalidUtf8Commit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          invalidUtf8Commit,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    fs.writeFileSync(planPath(repository), Buffer.alloc(64 * 1024 + 1, 0x61));
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-q', '-m', 'Write oversized agent plan']);
    const oversizedCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          oversizedCommit,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current and pinned v2 readers require the exact central configuration digest', () => {
  const repository = temporaryRepository();
  try {
    assert.equal(
      readCurrentAgentRolePlanV2(
        repository,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      null,
    );
    writePlanV2(repository);
    assert.deepEqual(
      readCurrentAgentRolePlanV2(
        repository,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      planV2(),
    );
    assert.throws(
      () => readCurrentAgentRolePlanV2(repository, CHANGE_ID, 'f'.repeat(64)),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.email', 'agent-plan-v2@example.test']);
    git(repository, ['config', 'user.name', 'Agent Plan V2 Test']);
    git(repository, ['add', agentRolePlanV2Path(CHANGE_ID)]);
    git(repository, ['commit', '-q', '-m', 'Add current agent role plan']);
    const commit = git(repository, ['rev-parse', 'HEAD']).trim();
    const blobObjectId = git(repository, [
      'rev-parse',
      `${commit}:${agentRolePlanV2Path(CHANGE_ID)}`,
    ]).trim();
    const directSnapshot = createAgentRolePlanV2Snapshot({
      pinnedCommit: commit,
      blobObjectId,
      plan: planV2(),
    });
    const pinnedSnapshot = readPinnedAgentRolePlanV2Snapshot(
      repository,
      commit,
      CHANGE_ID,
      CENTRAL_CONFIGURATION_DIGEST,
    );
    assert.deepEqual(pinnedSnapshot, directSnapshot);
    assert.equal(pinnedSnapshot?.artifactPath, agentRolePlanV2Path(CHANGE_ID));
    assert.equal(pinnedSnapshot?.blobObjectId, blobObjectId);
    assert.equal(pinnedSnapshot?.planDigest, planV2().planDigest);
    assert.equal(
      pinnedSnapshot?.sourceDigest,
      crypto
        .createHash('sha256')
        .update(renderAgentRolePlanV2(planV2()))
        .digest('hex'),
    );
    assert.deepEqual(
      assertPinnedAgentRolePlanV2Snapshot(repository, pinnedSnapshot!),
      pinnedSnapshot,
    );
    assert.deepEqual(
      readPinnedAgentRolePlanV2(
        repository,
        commit,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      planV2(),
    );
    const tree = git(repository, ['rev-parse', `${commit}^{tree}`]).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2(
          repository,
          tree,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );

    writePlanV2(repository, planV2({ customWrapperPolicy: 'forbidden' }));
    assert.deepEqual(
      readPinnedAgentRolePlanV2(
        repository,
        commit,
        CHANGE_ID,
        CENTRAL_CONFIGURATION_DIGEST,
      ),
      planV2(),
    );

    git(repository, ['add', agentRolePlanV2Path(CHANGE_ID)]);
    git(repository, [
      'update-index',
      '--chmod=+x',
      agentRolePlanV2Path(CHANGE_ID),
    ]);
    git(repository, ['commit', '-q', '-m', 'Make v2 plan executable']);
    const executableCommit = git(repository, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () =>
        readPinnedAgentRolePlanV2Snapshot(
          repository,
          executableCommit,
          CHANGE_ID,
          CENTRAL_CONFIGURATION_DIGEST,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('agent-role plan v2 is a repository-owned planning companion and changes the planning generation', () => {
  const planningValidatorSource = fs.readFileSync(
    path.join(
      import.meta.dirname,
      '../src/modules/assurance/planning-assurance-validator.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    planningValidatorSource,
    /from\s+['"]\.\.\/\.\.\/runtime\/repository-transaction\/(?:agent-role-plan-store|central-role-provider-default-store)\.ts['"]/u,
    'module-owned planning assurance must not import runtime policy stores',
  );

  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        CHANGE_ID,
        [`workflow/agent-plans/${CHANGE_ID}.json`],
        [],
        'jigwright',
        'jigwright',
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
  assert.throws(
    () =>
      assertPlanningPaths(
        'openspec/changes',
        CHANGE_ID,
        [agentRolePlanV2Path(CHANGE_ID)],
        [],
        'jigwright',
        'jigwright',
      ),
    (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
  );
  assert.deepEqual(
    partitionPlanningRolePolicyPaths(
      CHANGE_ID,
      [
        `openspec/changes/${CHANGE_ID}/proposal.md`,
        agentRolePlanV2Path(CHANGE_ID),
      ],
      [],
    ),
    {
      policyPath: agentRolePlanV2Path(CHANGE_ID),
      policyChanged: true,
      policyDeleted: false,
      providerChangedPaths: [`openspec/changes/${CHANGE_ID}/proposal.md`],
      providerDeletedPaths: [],
    },
  );

  const repository = createFixtureRepository();
  try {
    writeCentralConfiguration(repository);
    writeReadyV3ExemptChange(repository);
    const before = loadChangeContract(repository, CHANGE_ID);
    assert.throws(
      () =>
        deriveInvestigationFirstPlanningSubject(
          planningAssuranceDependencies,
          repository,
          before,
          undefined!,
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
    const beforeSubject = deriveInvestigationFirstPlanningSubject(
      planningAssuranceDependencies,
      repository,
      before,
      readCurrentPlanningRoleOverridePolicy(repository, before.changeId),
    );
    writePlanV2(repository);
    const after = loadChangeContract(repository, CHANGE_ID);
    const afterSubject = deriveInvestigationFirstPlanningSubject(
      planningAssuranceDependencies,
      repository,
      after,
      readCurrentPlanningRoleOverridePolicy(repository, after.changeId),
    );
    assert.deepEqual(after.artifactPaths, before.artifactPaths);
    assert.deepEqual(after.artifactDigests, before.artifactDigests);
    assert.notEqual(
      afterSubject.target.targetDigest,
      beforeSubject.target.targetDigest,
    );
    assert.notEqual(
      afterSubject.generation.planningGenerationId,
      beforeSubject.generation.planningGenerationId,
    );
    const [overrideComponent] = afterSubject.target.components.filter(
      ({ path: componentPath }) =>
        componentPath === agentRolePlanV2Path(CHANGE_ID),
    );
    assert.ok(overrideComponent);
    assert.deepEqual(
      {
        kind: overrideComponent.kind,
        role: overrideComponent.role,
        path: overrideComponent.path,
      },
      {
        kind: 'policy',
        role: 'policy',
        path: agentRolePlanV2Path(CHANGE_ID),
      },
    );
    assert.match(overrideComponent.identityDigest, /^[0-9a-f]{64}$/u);
    const expectedComponentDigest = crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: 'plan-target.policy.v1',
          kind: 'policy',
          role: 'policy',
          path: agentRolePlanV2Path(CHANGE_ID),
          identityDigest: overrideComponent.identityDigest,
          name: 'agent-role-plan',
          version: 2,
          digest: planV2().planDigest,
        }),
      )
      .digest('hex');
    assert.equal(overrideComponent.componentDigest, expectedComponentDigest);

    writePlanV2(repository, planV2({ customWrapperPolicy: 'forbidden' }));
    const changedOverrideSubject = deriveInvestigationFirstPlanningSubject(
      planningAssuranceDependencies,
      repository,
      loadChangeContract(repository, CHANGE_ID),
      readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
    );
    assert.notEqual(
      changedOverrideSubject.target.targetDigest,
      afterSubject.target.targetDigest,
    );

    fs.chmodSync(planPath(repository), 0o600);
    assert.throws(
      () =>
        deriveInvestigationFirstPlanningSubject(
          planningAssuranceDependencies,
          repository,
          loadChangeContract(repository, CHANGE_ID),
          readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
        ),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning role policy decoding binds exact bytes to the central configuration without filesystem reads', (context) => {
  const centralBytes = Buffer.from(
    renderCentralRoleProviderDefault(centralConfiguration()),
  );
  const overrideBytes = Buffer.from(renderAgentRolePlanV2(planV2()));
  context.mock.method(fs, 'readFileSync', () => {
    throw new Error('Unexpected policy I/O');
  });
  context.mock.method(fs, 'openSync', () => {
    throw new Error('Unexpected policy I/O');
  });
  const central = parseCurrentCentralRoleProviderDefaultPolicy(centralBytes);
  const plan = parseCurrentAgentRolePlanV2(overrideBytes, CHANGE_ID, central);
  assert.deepEqual(plan, planV2());
  assert.deepEqual(projectCurrentPlanningRoleOverridePolicy(plan), {
    path: agentRolePlanV2Path(CHANGE_ID),
    baseCentralConfigurationDigest: CENTRAL_CONFIGURATION_DIGEST,
    planDigest: planV2().planDigest,
  });
  assert.throws(
    () => parseCurrentAgentRolePlanV2(overrideBytes, 'another-change', central),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  const otherCentral = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: central.providerGroups,
    globalProviderRanking: ['codex', 'claude'],
  });
  assert.throws(
    () => parseCurrentAgentRolePlanV2(overrideBytes, CHANGE_ID, otherCentral),
    (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
  );
  for (const malformed of [Buffer.from([0xff]), Buffer.from('{}')]) {
    assert.throws(
      () => parseCurrentAgentRolePlanV2(malformed, CHANGE_ID, central),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
    assert.throws(
      () => parseCurrentCentralRoleProviderDefaultPolicy(malformed),
      (error) =>
        isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID'),
    );
  }
});

test('planning role policy input distinguishes explicit absence from omitted or cross-change wiring', () => {
  const policy = projectCurrentPlanningRoleOverridePolicy(planV2());
  assert.equal(assertCurrentPlanningRoleOverridePolicy(null, CHANGE_ID), null);
  assert.deepEqual(
    assertCurrentPlanningRoleOverridePolicy(policy, CHANGE_ID),
    policy,
  );
  for (const invalid of [
    undefined,
    { ...policy, path: agentRolePlanV2Path('another-change') },
    { ...policy, planDigest: 'invalid' },
  ]) {
    assert.throws(
      () => assertCurrentPlanningRoleOverridePolicy(invalid!, CHANGE_ID),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  }
});

test('current planning role reader confirms absence and requires central bytes for an existing override', () => {
  const repository = temporaryRepository();
  try {
    assert.equal(
      readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
      null,
    );
    writePlanV2(repository);
    assert.throws(
      () => readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
      (error) =>
        isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_UNAVAILABLE'),
    );
    writeCentralConfiguration(repository);
    assert.deepEqual(
      readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
      projectCurrentPlanningRoleOverridePolicy(planV2()),
    );
    fs.writeFileSync(
      path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
      Buffer.from([0xff]),
    );
    assert.throws(
      () => readCurrentPlanningRoleOverridePolicy(repository, CHANGE_ID),
      (error) =>
        isWorkflowError(error, 'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current planning role reader rejects unsafe files and invalid UTF-8', () => {
  const repository = temporaryRepository();
  try {
    writeCentralConfiguration(repository);
    const destination = writePlanV2(repository);
    const target = path.join(repository, 'alternate.json');
    fs.renameSync(destination, target);
    fs.symlinkSync(target, destination);
    assert.throws(
      () => readCurrentPlanningAgentRolePlanV2(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
    fs.unlinkSync(destination);
    fs.renameSync(target, destination);
    fs.chmodSync(destination, 0o755);
    assert.throws(
      () => readCurrentPlanningAgentRolePlanV2(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
    fs.chmodSync(destination, 0o644);
    for (const invalid of [
      Buffer.alloc(64 * 1024 + 1, 0x20),
      Buffer.from([0xff]),
    ]) {
      fs.writeFileSync(destination, invalid);
      assert.throws(
        () => readCurrentPlanningAgentRolePlanV2(repository, CHANGE_ID),
        (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current planning role reader rejects central replacement or override deletion between pair reads', () => {
  for (const mutation of ['central-replaced', 'override-deleted'] as const) {
    const repository = temporaryRepository();
    const close = fs.closeSync;
    try {
      writeCentralConfiguration(repository);
      const destination = writePlanV2(repository);
      const replacement = path.join(repository, 'new-central.json');
      const central = centralConfiguration();
      const changedCentral = createCentralRoleProviderDefault({
        schemaVersion: central.schemaVersion,
        kind: central.kind,
        providerGroups: central.providerGroups,
        globalProviderRanking: ['codex', 'claude'],
      });
      fs.writeFileSync(
        replacement,
        renderCentralRoleProviderDefault(changedCentral),
      );
      let closes = 0;
      fs.closeSync = (descriptor) => {
        close(descriptor);
        if (++closes === 2) {
          if (mutation === 'central-replaced')
            fs.renameSync(
              replacement,
              path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
            );
          else fs.unlinkSync(destination);
        }
      };
      assert.throws(
        () => readCurrentPlanningAgentRolePlanV2(repository, CHANGE_ID),
        (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
      );
    } finally {
      fs.closeSync = close;
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});
