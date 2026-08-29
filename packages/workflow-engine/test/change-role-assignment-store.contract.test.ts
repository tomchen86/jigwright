import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseAgentProviderConfigToml } from '@jigwright/agent-runtime';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type TrustedGrantPresentation,
} from '../src/modules/authority/grant-coordinator.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
  type AgentRolePlanV2Snapshot,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultSnapshotV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  createChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentHostConfigurationVerifierPort,
  type ChangeRoleAssignmentProviderRegistryVerifierPort,
  type ChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentSessionCapabilityVerifierPort,
} from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
  type ChangeRoleAssignmentDataAuthorizationVerifierPort,
  type ChangeRoleAssignmentProtectedContextVerifierPort,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import {
  changeRoleAssignmentGrantTransitionDefinitions,
  changeRoleAssignmentGrantRequirementDigestV1,
  createChangeRoleAssignmentGrantRequest,
  type ChangeRoleAssignmentGrantParametersV1,
} from '../src/modules/provider-orchestration/change-role-assignment-grant.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import {
  createOrReadExactChangeRoleAssignmentRecordV1,
  inspectHistoricalChangeRoleAssignmentRecordV1,
  readChangeRoleAssignmentRecordV1,
} from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import {
  activateChangeRoleAssignmentGrant,
  observeChangeRoleAssignmentGrantActivation,
  readCompletedChangeRoleAssignmentGrantAuthority,
} from '../src/runtime/storage-journal/change-role-assignment-grant-store.ts';
import { grantStorePaths } from '../src/runtime/storage-journal/grant-store.ts';
import {
  assertPinnedAgentRolePlanV2Snapshot,
  readPinnedAgentRolePlanV2Snapshot,
} from '../src/runtime/repository-transaction/agent-role-plan-store.ts';
import {
  assertPinnedCentralRoleProviderDefaultSnapshot,
  CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
  readPinnedCentralRoleProviderDefaultSnapshot,
} from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { git } from './fixture.ts';

const CHANGE_ID = 'durable-role-assignment';
const GENERATION = 'a'.repeat(64);
const INPUT_MANIFEST_DIGEST = '4'.repeat(64);
const RELEVANT_TARGET_DIGEST = '5'.repeat(64);
const PATH_ROLE_SOURCE_DIGEST = '6'.repeat(64);
const PROTECTED_POLICY_SOURCE_DIGEST = '7'.repeat(64);
const GRANT_NOW = new Date('2030-01-02T03:04:05.000Z');
const GRANT_CHALLENGE_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_OPERATION_ID = '22222222-2222-4222-8222-222222222222';

function centralConfiguration(reviewerPreference: string | null = null) {
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
          preferredLogicalProviderId: reviewerPreference,
        },
      },
    ],
    globalProviderRanking: ['alpha', 'beta', 'gamma'],
  });
}

function record(
  centralSnapshot: CentralRoleProviderDefaultSnapshotV1,
  belowFloor = false,
  changeOverrideSnapshot: AgentRolePlanV2Snapshot | null = null,
  includeProtectedContext = true,
): ChangeRoleAssignmentRecordV1 {
  const configuration = parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["alpha-primary", "beta-primary", "gamma-primary"]

[[providers]]
id = "alpha-primary"
logical_provider_id = "alpha"
family = "alpha"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "alpha-jsonl-v1"
executable = "/opt/providers/alpha"

[[providers]]
id = "beta-primary"
logical_provider_id = "beta"
family = "beta"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "beta-jsonl-v1"
executable = "/opt/providers/beta"

[[providers]]
id = "gamma-primary"
logical_provider_id = "gamma"
family = "gamma"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "gamma-jsonl-v1"
executable = "/opt/providers/gamma"

[provider_preferences]
author = ["alpha-primary", "beta-primary", "gamma-primary"]
builder = ["alpha-primary", "beta-primary", "gamma-primary"]
reviewer = ["alpha-primary", "beta-primary", "gamma-primary"]
`,
    { platform: 'linux' },
  );
  const central = centralSnapshot.configuration;
  const caller = {
    logicalProviderId: 'alpha',
    profileId: 'alpha-primary',
    engineSessionId: 'caller-session-alpha',
    adoptableRoles: ['author'] as const,
  };
  const changeOverride = belowFloor ? changeOverrideSnapshot?.plan : null;
  if (belowFloor && changeOverride === undefined) {
    throw new TypeError('Below-floor fixture requires one pinned override.');
  }
  const dataAuthorization = {
    policyDigest: 'c'.repeat(64),
    inputManifestDigest: INPUT_MANIFEST_DIGEST,
    relevantTargetDigest: RELEVANT_TARGET_DIGEST,
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
    policyDigest: 'd'.repeat(64),
    providers: ['alpha', 'beta', 'gamma'].map((logicalProviderId, index) => ({
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
  const result = resolveChangeRoleAssignmentV1({
    changeId: CHANGE_ID,
    planningGeneration: GENERATION,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverride ?? null,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext: includeProtectedContext
      ? createChangeRoleAssignmentProtectedContextV1({
          classification: 'ordinary',
          pathRoleSourceDigest: PATH_ROLE_SOURCE_DIGEST,
          policySourceDigest: PROTECTED_POLICY_SOURCE_DIGEST,
          inputManifestDigest: INPUT_MANIFEST_DIGEST,
          relevantTargetDigest: RELEVANT_TARGET_DIGEST,
        })
      : undefined,
  });
  assert.notEqual(result.outcome, 'unsatisfied');
  return createChangeRoleAssignmentRecordV1({
    central: centralSnapshot,
    host: { sourceDigest: 'e'.repeat(64), configuration },
    changeOverride: belowFloor ? changeOverrideSnapshot : null,
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: (result as Exclude<typeof result, { outcome: 'unsatisfied' }>)
      .resolution,
  });
}

function fixture() {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'change-role-assignment-store-'),
  );
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'assignment@example.test']);
  git(repository, ['config', 'user.name', 'Assignment Test']);
  const destination = path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    renderCentralRoleProviderDefault(centralConfiguration()),
    { mode: 0o644 },
  );
  const overrideBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: centralConfiguration().configurationDigest,
    roleLanes: [],
    pairwiseRequirements: [
      { pair: 'author-builder', required: 'session-independent' },
      { pair: 'author-reviewer', required: 'session-independent' },
      { pair: 'builder-reviewer', required: 'session-independent' },
    ],
    customWrapperPolicy: 'forbidden',
    grantReferences: [],
  };
  const overridePlan = {
    ...overrideBody,
    planDigest: agentRolePlanV2Digest(overrideBody),
  };
  const overridePath = agentRolePlanV2Path(CHANGE_ID);
  const overrideDestination = path.join(repository, overridePath);
  fs.mkdirSync(path.dirname(overrideDestination), { recursive: true });
  fs.writeFileSync(overrideDestination, renderAgentRolePlanV2(overridePlan), {
    mode: 0o644,
  });
  git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH, overridePath]);
  git(repository, ['commit', '-q', '-m', 'Add central default']);
  const primaryCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  const primaryCentralSnapshot = readPinnedCentralRoleProviderDefaultSnapshot(
    repository,
    primaryCommit,
  );
  const primaryChangeOverrideSnapshot = readPinnedAgentRolePlanV2Snapshot(
    repository,
    primaryCommit,
    CHANGE_ID,
    centralConfiguration().configurationDigest,
  )!;
  fs.writeFileSync(
    destination,
    renderCentralRoleProviderDefault(centralConfiguration('gamma')),
  );
  git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
  git(repository, ['commit', '-q', '-m', 'Change central default']);
  const alternateCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  const alternateCentralSnapshot = readPinnedCentralRoleProviderDefaultSnapshot(
    repository,
    alternateCommit,
  );
  const verifyCentralSnapshot = (
    snapshot: CentralRoleProviderDefaultSnapshotV1,
  ) => assertPinnedCentralRoleProviderDefaultSnapshot(repository, snapshot);
  const verifyChangeOverrideSnapshot = (snapshot: AgentRolePlanV2Snapshot) =>
    assertPinnedAgentRolePlanV2Snapshot(repository, snapshot);
  const verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort =
    (snapshot) => snapshot;
  const verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort =
    (snapshot) => snapshot;
  const verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort =
    (snapshot) => {
      assert.equal(snapshot.policyDigest, 'c'.repeat(64));
      assert.equal(snapshot.inputManifestDigest, INPUT_MANIFEST_DIGEST);
      assert.equal(snapshot.relevantTargetDigest, RELEVANT_TARGET_DIGEST);
      return snapshot;
    };
  const verifySessionCapabilities: ChangeRoleAssignmentSessionCapabilityVerifierPort =
    (snapshot) => snapshot;
  const verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort =
    (context) => {
      assert.equal(context.classification, 'ordinary');
      assert.equal(context.pathRoleSourceDigest, PATH_ROLE_SOURCE_DIGEST);
      assert.equal(context.policySourceDigest, PROTECTED_POLICY_SOURCE_DIGEST);
      assert.equal(context.inputManifestDigest, INPUT_MANIFEST_DIGEST);
      assert.equal(context.relevantTargetDigest, RELEVANT_TARGET_DIGEST);
      return context;
    };
  return {
    repository,
    paths: investigationRuntimePaths(
      path.join(repository, '.git'),
      'workflow-engine',
    ),
    primaryCentralSnapshot,
    primaryChangeOverrideSnapshot,
    alternateCentralSnapshot,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapabilities,
    verifyProtectedContext,
    cleanup: () => fs.rmSync(repository, { recursive: true, force: true }),
  };
}

function locations(
  paths: ReturnType<typeof investigationRuntimePaths>,
  value: ChangeRoleAssignmentRecordV1,
) {
  const root = path.join(paths.root, 'change-role-assignments', 'v1');
  return {
    object: path.join(root, 'objects', 'sha256', `${value.recordDigest}.json`),
    ref: path.join(
      root,
      'refs',
      value.changeId,
      `${value.planningGeneration}.json`,
    ),
  };
}

test('completed Central Grant activates only the exact durable below-floor assignment', async () => {
  const state = fixture();
  try {
    const expected = record(
      state.primaryCentralSnapshot,
      true,
      state.primaryChangeOverrideSnapshot,
    );
    assert.notEqual(expected.grantRequirement, null);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const parameters: ChangeRoleAssignmentGrantParametersV1 = {
      schemaVersion: 1,
      kind: 'change-role-assignment-grant-activation.v1',
      repositoryId: 'github:example/jigwright',
      changeId: expected.changeId,
      planningGeneration: expected.planningGeneration,
      invocationId: 'provider-invocation-below-floor',
      recordDigest: expected.recordDigest,
      assignmentDigest: expected.assignmentDigest,
      grantRequirementDigest: changeRoleAssignmentGrantRequirementDigestV1(
        expected.grantRequirement!,
      ),
      exactRolePairs: expected.grantRequirement!.exactRolePairs,
    };
    const port = {
      observe: (input: ChangeRoleAssignmentGrantParametersV1) =>
        observeChangeRoleAssignmentGrantActivation(state.paths, input),
      activate: (
        input: Parameters<
          ReturnType<typeof changeRoleAssignmentGrantTransitionDefinitions>[number]['execute']
        >[0],
      ) => activateChangeRoleAssignmentGrant(state.paths, input),
    };
    const ids = [GRANT_CHALLENGE_ID, GRANT_OPERATION_ID];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(path.dirname(state.paths.root)),
      registry: createTransitionRegistry(
        changeRoleAssignmentGrantTransitionDefinitions(port),
      ),
      policy: parseGrantPolicyV2(roleAssignmentGrantPolicy(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(GRANT_NOW),
      randomUUID: () => ids.shift()!,
      openApprovalSession: roleAssignmentGrantApprovalSession,
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => undefined);
      },
    });
    const challenge = await coordinator.requestGrant(
      createChangeRoleAssignmentGrantRequest(
        port.observe(parameters),
        'Approve only this exact below-floor role assignment.',
      ),
    );

    assert.equal(
      readCompletedChangeRoleAssignmentGrantAuthority(
        state.paths,
        path.dirname(state.paths.root),
        expected,
        parameters.invocationId,
        parameters.repositoryId,
      ),
      null,
    );
    const completed = await coordinator.resolveChallenge(challenge.challengeId);
    assert.equal(completed.outcome, 'completed');
    const authority = readCompletedChangeRoleAssignmentGrantAuthority(
      state.paths,
      path.dirname(state.paths.root),
      expected,
      parameters.invocationId,
      parameters.repositoryId,
    );
    assert.equal(authority?.challengeId, GRANT_CHALLENGE_ID);
    assert.equal(authority?.assignmentRecordDigest, expected.recordDigest);
    assert.equal(
      authority?.grantRequirementDigest,
      parameters.grantRequirementDigest,
    );
    assert.throws(
      () =>
        readCompletedChangeRoleAssignmentGrantAuthority(
          state.paths,
          path.dirname(state.paths.root),
          expected,
          parameters.invocationId,
          'github:other/repository',
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
    );
    assert.equal(
      readCompletedChangeRoleAssignmentGrantAuthority(
        state.paths,
        path.dirname(state.paths.root),
        expected,
        'provider-invocation-other',
        parameters.repositoryId,
      ),
      null,
    );

    const drifted = {
      ...expected,
      assignmentDigest: 'f'.repeat(64),
    } as ChangeRoleAssignmentRecordV1;
    assert.throws(
      () =>
        readCompletedChangeRoleAssignmentGrantAuthority(
          state.paths,
          path.dirname(state.paths.root),
          drifted,
          parameters.invocationId,
          parameters.repositoryId,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_GRANT_ACTIVATION_INVALID',
    );
  } finally {
    state.cleanup();
  }
});

function roleAssignmentGrantPolicy() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': {
        requiredClaims: ['fresh-local-device-owner'],
      },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: { maintainerPolicyV1: 'read-only' },
  };
}

function roleAssignmentGrantApprovalSession(
  presentation: TrustedGrantPresentation,
): GrantApprovalSession {
  return {
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        reasonCode: 'approve-exact-role-independence-exception',
        reason: 'The exact assignment is acceptable for this current state.',
        approvalMethod: 'human-presence',
        sessionNonce: 'role-assignment-grant-session-0000000000000001',
      };
    },
    async authenticate({ approvalSubjectDigest }) {
      return [roleAssignmentGrantProof(approvalSubjectDigest)];
    },
    async close() {},
  };
}

function roleAssignmentGrantProof(
  subjectDigest: `sha256:${string}`,
): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: subjectDigest,
    proofDigest: `sha256:${'9'.repeat(64)}`,
    verifiedAt: GRANT_NOW.toISOString(),
    identity: null,
  };
}

function treeFingerprint(root: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  const visit = (location: string): string[] => {
    const stats = fs.lstatSync(location);
    const relative = path.relative(root, location) || '.';
    const identity = [
      relative,
      stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      stats.mode.toString(8),
      stats.nlink,
      stats.size,
      stats.dev,
      stats.ino,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(':');
    if (!stats.isDirectory()) {
      const digest = stats.isFile()
        ? crypto
            .createHash('sha256')
            .update(fs.readFileSync(location))
            .digest('hex')
        : '';
      return [`${identity}:${digest}`];
    }
    return [
      identity,
      ...fs
        .readdirSync(location)
        .sort()
        .flatMap((name) => visit(path.join(location, name))),
    ];
  };
  return visit(root);
}

function withoutFilesystemMutations<T>(operation: () => T): T {
  const mutableFs = fs as unknown as Record<string, unknown>;
  const mutationMethods = [
    'appendFileSync',
    'chmodSync',
    'chownSync',
    'copyFileSync',
    'cpSync',
    'createWriteStream',
    'fchmodSync',
    'fchownSync',
    'fdatasyncSync',
    'ftruncateSync',
    'fsyncSync',
    'futimesSync',
    'lchownSync',
    'linkSync',
    'lutimesSync',
    'mkdirSync',
    'mkdtempSync',
    'renameSync',
    'rmSync',
    'rmdirSync',
    'symlinkSync',
    'truncateSync',
    'unlinkSync',
    'utimesSync',
    'writeFileSync',
    'writeSync',
    'writevSync',
  ] as const;
  const originals = new Map<string, unknown>();
  const promiseOriginals = new Map<string, unknown>();
  const originalOpenSync = fs.openSync;
  for (const method of mutationMethods) {
    if (typeof mutableFs[method] !== 'function') continue;
    originals.set(method, mutableFs[method]);
    mutableFs[method] = () => {
      throw new Error(`unexpected filesystem mutation: ${method}`);
    };
  }
  for (const method of [
    'appendFile',
    'chmod',
    'chown',
    'copyFile',
    'cp',
    'fchmod',
    'fchown',
    'fdatasync',
    'ftruncate',
    'fsync',
    'futimes',
    'lchown',
    'link',
    'lutimes',
    'mkdir',
    'mkdtemp',
    'open',
    'rename',
    'rm',
    'rmdir',
    'symlink',
    'truncate',
    'unlink',
    'utimes',
    'write',
    'writeFile',
    'writev',
  ]) {
    if (typeof mutableFs[method] !== 'function') continue;
    originals.set(method, mutableFs[method]);
    mutableFs[method] = () => {
      throw new Error(`unexpected callback filesystem mutation: ${method}`);
    };
  }
  for (const method of [
    'appendFile',
    'chmod',
    'chown',
    'copyFile',
    'cp',
    'lchown',
    'lutimes',
    'mkdir',
    'mkdtemp',
    'open',
    'rename',
    'rm',
    'rmdir',
    'symlink',
    'truncate',
    'unlink',
    'utimes',
    'writeFile',
  ]) {
    const promises = fs.promises as unknown as Record<string, unknown>;
    if (typeof promises[method] !== 'function') continue;
    promiseOriginals.set(method, promises[method]);
    promises[method] = () => {
      throw new Error(`unexpected promise filesystem mutation: ${method}`);
    };
  }
  mutableFs.openSync = (...args: Parameters<typeof fs.openSync>) => {
    const flags = args[1];
    const requiredFlags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const forbiddenFlags =
      fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_EXCL |
      ((fs.constants as unknown as Record<string, number>).O_TMPFILE ?? 0);
    if (
      typeof flags !== 'number' ||
      (flags & forbiddenFlags) !== 0 ||
      (flags & requiredFlags) !== requiredFlags
    ) {
      throw new Error('unexpected unsafe filesystem open');
    }
    return originalOpenSync(...args);
  };
  try {
    return operation();
  } finally {
    mutableFs.openSync = originalOpenSync;
    for (const [method, original] of originals) mutableFs[method] = original;
    for (const [method, original] of promiseOriginals) {
      (fs.promises as unknown as Record<string, unknown>)[method] = original;
    }
  }
}

test('historical assignment inspection is store-owned, explicitly non-authorizing, and zero-write', () => {
  const state = fixture();
  try {
    const emptyBefore = treeFingerprint(state.repository);
    assert.equal(
      withoutFilesystemMutations(() =>
        inspectHistoricalChangeRoleAssignmentRecordV1(
          state.paths,
          CHANGE_ID,
          GENERATION,
        ),
      ),
      null,
    );
    assert.deepEqual(treeFingerprint(state.repository), emptyBefore);

    const expected = record(state.primaryCentralSnapshot);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const before = treeFingerprint(state.paths.root);
    let objectOpenCount = 0;
    const objectPath = locations(state.paths, expected).object;
    const mutableFs = fs as unknown as { openSync: typeof fs.openSync };
    const originalOpenSync = fs.openSync;
    mutableFs.openSync = (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === objectPath) objectOpenCount += 1;
      return originalOpenSync(...args);
    };
    let observation: ReturnType<
      typeof inspectHistoricalChangeRoleAssignmentRecordV1
    >;
    try {
      observation = withoutFilesystemMutations(() =>
        inspectHistoricalChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
        ),
      );
    } finally {
      mutableFs.openSync = originalOpenSync;
    }
    assert.notEqual(observation, null);
    assert.deepEqual(Object.keys(observation!).sort(), [
      'authorityEligible',
      'kind',
      'operationalWrites',
      'record',
      'schemaVersion',
      'sourceAuthority',
    ]);
    assert.equal(observation!.schemaVersion, 1);
    assert.equal(
      observation!.kind,
      'historical-change-role-assignment-observation.v1',
    );
    assert.equal(observation!.authorityEligible, false);
    assert.equal(observation!.operationalWrites, false);
    assert.equal(observation!.sourceAuthority, 'not-evaluated');
    assert.deepEqual(observation!.record, expected);
    assert.equal(objectOpenCount, 2);
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('historical assignment inspection exposes an exact publish window as an operation conflict without cleanup', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const target = locations(state.paths, expected).ref;
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.publish.tmp`;
    fs.linkSync(target, temporary);
    const before = treeFingerprint(state.paths.root);
    assert.equal(fs.statSync(target).nlink, 2);

    assert.throws(
      () =>
        inspectHistoricalChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_OPERATION_CONFLICT',
    );
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('historical assignment inspection rejects same-bytes object replacement between snapshots', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const objectPath = locations(state.paths, expected).object;
    const replacement = path.join(
      path.dirname(objectPath),
      `${'f'.repeat(64)}.json`,
    );
    fs.copyFileSync(objectPath, replacement, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(replacement, 0o600);
    const originalBytes = fs.readFileSync(objectPath);
    const originalIdentity = fs.statSync(objectPath);
    const replacementIdentity = fs.statSync(replacement);
    assert.notEqual(replacementIdentity.ino, originalIdentity.ino);
    const mutableFs = fs as unknown as { openSync: typeof fs.openSync };
    const originalOpenSync = fs.openSync;
    let objectOpenCount = 0;
    mutableFs.openSync = (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === objectPath) {
        objectOpenCount += 1;
        if (objectOpenCount === 2) fs.renameSync(replacement, objectPath);
      }
      return originalOpenSync(...args);
    };
    try {
      assert.throws(
        () =>
          inspectHistoricalChangeRoleAssignmentRecordV1(
            state.paths,
            expected.changeId,
            expected.planningGeneration,
          ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_OPERATION_CONFLICT' ||
            error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID'),
      );
    } finally {
      mutableFs.openSync = originalOpenSync;
    }
    assert.equal(objectOpenCount, 2);
    assert.equal(fs.existsSync(replacement), false);
    assert.equal(fs.statSync(objectPath).ino, replacementIdentity.ino);
    assert.deepEqual(fs.readFileSync(objectPath), originalBytes);
  } finally {
    state.cleanup();
  }
});

test('store publishes one create-only object and generation ref with exact replay', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    assert.equal(
      readChangeRoleAssignmentRecordV1(
        state.paths,
        expected.changeId,
        expected.planningGeneration,
        state.verifyCentralSnapshot,
        state.verifyChangeOverrideSnapshot,
        state.verifyHostConfiguration,
        state.verifyProviderRegistry,
        state.verifyDataAuthorization,
        state.verifySessionCapabilities,
        state.verifyProtectedContext,
      ),
      null,
    );
    const created = createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const replay = createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    assert.deepEqual(created, expected);
    assert.deepEqual(replay, expected);
    assert.deepEqual(
      readChangeRoleAssignmentRecordV1(
        state.paths,
        expected.changeId,
        expected.planningGeneration,
        state.verifyCentralSnapshot,
        state.verifyChangeOverrideSnapshot,
        state.verifyHostConfiguration,
        state.verifyProviderRegistry,
        state.verifyDataAuthorization,
        state.verifySessionCapabilities,
        state.verifyProtectedContext,
      ),
      expected,
    );
    const files = locations(state.paths, expected);
    assert.equal(fs.statSync(files.object).mode & 0o777, 0o600);
    assert.equal(fs.statSync(files.ref).mode & 0o777, 0o600);
  } finally {
    state.cleanup();
  }
});

test('a commit rebound to another exact blob and configuration is rejected before any write', () => {
  const state = fixture();
  try {
    const rebound = createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: state.alternateCentralSnapshot.pinnedCommit,
      blobObjectId: state.primaryCentralSnapshot.blobObjectId,
      configuration: state.primaryCentralSnapshot.configuration,
    });
    const candidate = record(rebound);
    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          candidate,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
    assert.equal(
      fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('an injected verifier failure blocks both create and read', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    const throwingVerifier = () => {
      throw new Error('injected central snapshot verifier failure');
    };
    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          expected,
          throwingVerifier,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
    assert.equal(
      fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
      false,
    );

    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    assert.throws(
      () =>
        readChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
          throwingVerifier,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
  } finally {
    state.cleanup();
  }
});

test('host, registry, and session evidence ports are mandatory and reject failure or drift before create and read', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    const valid = {
      host: state.verifyHostConfiguration,
      registry: state.verifyProviderRegistry,
      session: state.verifySessionCapabilities,
    };
    const throwingHost: ChangeRoleAssignmentHostConfigurationVerifierPort =
      () => {
        throw new Error('injected host evidence verifier failure');
      };
    const throwingRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort =
      () => {
        throw new Error('injected provider registry verifier failure');
      };
    const throwingSession: ChangeRoleAssignmentSessionCapabilityVerifierPort =
      () => {
        throw new Error('injected session capability verifier failure');
      };
    const driftHost: ChangeRoleAssignmentHostConfigurationVerifierPort = (
      snapshot,
    ) => ({ ...snapshot, sourceDigest: '8'.repeat(64) });
    const driftRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort = (
      snapshot,
    ) => ({ ...snapshot, registryDigest: '8'.repeat(64) });
    const driftSession: ChangeRoleAssignmentSessionCapabilityVerifierPort = (
      snapshot,
    ) => ({ ...snapshot, capabilitySnapshotDigest: '8'.repeat(64) });
    const cases = [
      {
        ...valid,
        host: undefined as unknown as ChangeRoleAssignmentHostConfigurationVerifierPort,
      },
      {
        ...valid,
        registry:
          undefined as unknown as ChangeRoleAssignmentProviderRegistryVerifierPort,
      },
      {
        ...valid,
        session:
          undefined as unknown as ChangeRoleAssignmentSessionCapabilityVerifierPort,
      },
      { ...valid, host: throwingHost },
      { ...valid, registry: throwingRegistry },
      { ...valid, session: throwingSession },
      { ...valid, host: driftHost },
      { ...valid, registry: driftRegistry },
      { ...valid, session: driftSession },
    ] as const;

    for (const verifiers of cases) {
      assert.throws(
        () =>
          createOrReadExactChangeRoleAssignmentRecordV1(
            state.paths,
            expected,
            state.verifyCentralSnapshot,
            state.verifyChangeOverrideSnapshot,
            verifiers.host,
            verifiers.registry,
            state.verifyDataAuthorization,
            verifiers.session,
            state.verifyProtectedContext,
          ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
      );
      assert.equal(
        fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
        false,
      );
    }

    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      valid.host,
      valid.registry,
      state.verifyDataAuthorization,
      valid.session,
      state.verifyProtectedContext,
    );
    for (const verifiers of cases) {
      assert.throws(
        () =>
          readChangeRoleAssignmentRecordV1(
            state.paths,
            expected.changeId,
            expected.planningGeneration,
            state.verifyCentralSnapshot,
            state.verifyChangeOverrideSnapshot,
            verifiers.host,
            verifiers.registry,
            state.verifyDataAuthorization,
            verifiers.session,
            state.verifyProtectedContext,
          ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
      );
    }
  } finally {
    state.cleanup();
  }
});

test('evidence drift after preflight but before first object publication fails closed', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    let hostVerificationCalls = 0;
    const driftingHostVerifier: ChangeRoleAssignmentHostConfigurationVerifierPort =
      (snapshot) => {
        hostVerificationCalls += 1;
        return hostVerificationCalls === 1
          ? snapshot
          : { ...snapshot, sourceDigest: '8'.repeat(64) };
      };

    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          expected,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          driftingHostVerifier,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
    assert.equal(hostVerificationCalls, 2);
    assert.equal(
      fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('data-authorization and protected-context ports are mandatory and reverify exact current evidence before create and read', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    const throwingDataAuthorizationVerifier = () => {
      throw new Error('injected data-authorization verifier failure');
    };
    const reboundProtectedContextVerifier: ChangeRoleAssignmentProtectedContextVerifierPort =
      (context) => ({
        ...context,
        pathRoleSourceDigest: '8'.repeat(64),
      });

    for (const [dataVerifier, contextVerifier] of [
      [undefined, state.verifyProtectedContext],
      [state.verifyDataAuthorization, undefined],
      [throwingDataAuthorizationVerifier, state.verifyProtectedContext],
      [state.verifyDataAuthorization, reboundProtectedContextVerifier],
    ] as const) {
      assert.throws(
        () =>
          createOrReadExactChangeRoleAssignmentRecordV1(
            state.paths,
            expected,
            state.verifyCentralSnapshot,
            state.verifyChangeOverrideSnapshot,
            state.verifyHostConfiguration,
            state.verifyProviderRegistry,
            dataVerifier as ChangeRoleAssignmentDataAuthorizationVerifierPort,
            state.verifySessionCapabilities,
            contextVerifier as ChangeRoleAssignmentProtectedContextVerifierPort,
          ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
      );
      assert.equal(
        fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
        false,
      );
    }

    const contextless = record(
      state.primaryCentralSnapshot,
      false,
      null,
      false,
    );
    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          contextless,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );

    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    assert.throws(
      () =>
        readChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          throwingDataAuthorizationVerifier,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
    assert.throws(
      () =>
        readChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          reboundProtectedContextVerifier,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
  } finally {
    state.cleanup();
  }
});

test('assignment evidence verification has one explicit production composition and worker caller', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  const candidates = [
    path.join(sourceRoot, 'application'),
    path.join(sourceRoot, 'composition-root'),
    path.join(sourceRoot, 'entrypoints'),
  ];
  const consumers = candidates.flatMap((root) =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((filePath) =>
        fs
          .readFileSync(filePath, 'utf8')
          .includes('createOrReadExactChangeRoleAssignmentRecordV1'),
      ),
  );

  assert.deepEqual(
    consumers.map((filePath) => path.relative(sourceRoot, filePath)),
    ['composition-root/change-role-assignment-production.ts'],
  );
  const productionCallers = candidates.flatMap((root) =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter(
        (filePath) =>
          !filePath.endsWith('change-role-assignment-production.ts') &&
          fs
            .readFileSync(filePath, 'utf8')
            .includes('createCurrentAgentRuntimeAssignmentV1('),
      ),
  );
  assert.deepEqual(
    productionCallers.map((filePath) => path.relative(sourceRoot, filePath)),
    ['entrypoints/worker/provider-worker.ts'],
  );
});

test('a non-null change override is re-read from its exact commit and blob before create and read', () => {
  const state = fixture();
  try {
    const expected = record(
      state.primaryCentralSnapshot,
      true,
      state.primaryChangeOverrideSnapshot,
    );
    const throwingOverrideVerifier = () => {
      throw new Error('injected change-override verifier failure');
    };
    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          expected,
          state.verifyCentralSnapshot,
          throwingOverrideVerifier,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
    assert.equal(
      fs.existsSync(path.join(state.paths.root, 'change-role-assignments')),
      false,
    );

    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    assert.throws(
      () =>
        readChangeRoleAssignmentRecordV1(
          state.paths,
          expected.changeId,
          expected.planningGeneration,
          state.verifyCentralSnapshot,
          throwingOverrideVerifier,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
    );
  } finally {
    state.cleanup();
  }
});

test('store persists a grant-neutral below-floor requirement without a proof or lifecycle receipt', () => {
  const state = fixture();
  try {
    const expected = record(
      state.primaryCentralSnapshot,
      true,
      state.primaryChangeOverrideSnapshot,
    );
    assert.notEqual(expected.grantRequirement, null);
    const created = createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const replay = readChangeRoleAssignmentRecordV1(
      state.paths,
      expected.changeId,
      expected.planningGeneration,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );

    assert.deepEqual(created, expected);
    assert.deepEqual(replay, expected);
    assert.equal(
      replay?.grantRequirement?.assignmentDigest,
      expected.assignmentDigest,
    );
    assert.deepEqual(replay?.grantRequirement?.exactRolePairs, [
      'author-builder',
      'author-reviewer',
      'builder-reviewer',
    ]);
    for (const forbidden of [
      'grantId',
      'proofMethod',
      'reservationReceiptDigest',
      'consumeReceiptDigest',
    ]) {
      assert.equal(Object.hasOwn(replay!.grantRequirement!, forbidden), false);
    }
  } finally {
    state.cleanup();
  }
});

test('same change and planning generation is an absent-to-digest CAS', () => {
  const state = fixture();
  try {
    const original = record(state.primaryCentralSnapshot);
    const divergent = record(state.alternateCentralSnapshot);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      original,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const originalPaths = locations(state.paths, original);
    const objectBytes = fs.readFileSync(originalPaths.object);
    const refBytes = fs.readFileSync(originalPaths.ref);

    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          divergent,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_CONFLICT',
    );
    assert.deepEqual(fs.readFileSync(originalPaths.object), objectBytes);
    assert.deepEqual(fs.readFileSync(originalPaths.ref), refBytes);
    assert.deepEqual(
      readChangeRoleAssignmentRecordV1(
        state.paths,
        original.changeId,
        original.planningGeneration,
        state.verifyCentralSnapshot,
        state.verifyChangeOverrideSnapshot,
        state.verifyHostConfiguration,
        state.verifyProviderRegistry,
        state.verifyDataAuthorization,
        state.verifySessionCapabilities,
        state.verifyProtectedContext,
      ),
      original,
    );
  } finally {
    state.cleanup();
  }
});

test('an exact object written before its ref is recoverable', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    const files = locations(state.paths, expected);
    fs.mkdirSync(path.dirname(files.object), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(files.object), 0o700);
    fs.writeFileSync(files.object, `${canonicalJson(expected)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });

    assert.deepEqual(
      createOrReadExactChangeRoleAssignmentRecordV1(
        state.paths,
        expected,
        state.verifyCentralSnapshot,
        state.verifyChangeOverrideSnapshot,
        state.verifyHostConfiguration,
        state.verifyProviderRegistry,
        state.verifyDataAuthorization,
        state.verifySessionCapabilities,
        state.verifyProtectedContext,
      ),
      expected,
    );
    assert.equal(fs.existsSync(files.ref), true);
  } finally {
    state.cleanup();
  }
});

test('assignment publication cleanup failure never masks the primary operation error', () => {
  const state = fixture();
  const mutableFs = fs as unknown as { fsyncSync: typeof fs.fsyncSync };
  const originalFsyncSync = fs.fsyncSync;
  try {
    const expected = record(state.primaryCentralSnapshot);
    const files = locations(state.paths, expected);
    let injectedFailures = 0;
    mutableFs.fsyncSync = (descriptor: number) => {
      if (fs.existsSync(files.object) && injectedFailures < 2) {
        injectedFailures += 1;
        throw Object.assign(
          new Error('injected primary publication conflict'),
          {
            code: 'CHANGE_ROLE_ASSIGNMENT_STORE_CONFLICT',
          },
        );
      }
      return originalFsyncSync(descriptor);
    };

    assert.throws(
      () =>
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          expected,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_CONFLICT',
    );
    assert.equal(injectedFailures, 2);
  } finally {
    mutableFs.fsyncSync = originalFsyncSync;
    state.cleanup();
  }
});

test('a ref replacement between the first read and object admission fails closed', () => {
  const state = fixture();
  try {
    const expected = record(state.primaryCentralSnapshot);
    createOrReadExactChangeRoleAssignmentRecordV1(
      state.paths,
      expected,
      state.verifyCentralSnapshot,
      state.verifyChangeOverrideSnapshot,
      state.verifyHostConfiguration,
      state.verifyProviderRegistry,
      state.verifyDataAuthorization,
      state.verifySessionCapabilities,
      state.verifyProtectedContext,
    );
    const files = locations(state.paths, expected);
    const replacement = `${files.ref}.replacement`;
    fs.copyFileSync(files.ref, replacement, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(replacement, 0o600);

    const mutableFs = fs as any;
    const openSync = fs.openSync;
    let replaced = false;
    mutableFs.openSync = (...args: any[]) => {
      const descriptor = openSync(...(args as Parameters<typeof fs.openSync>));
      if (!replaced && args[0] === files.object) {
        fs.renameSync(replacement, files.ref);
        replaced = true;
      }
      return descriptor;
    };
    try {
      assert.throws(
        () =>
          readChangeRoleAssignmentRecordV1(
            state.paths,
            expected.changeId,
            expected.planningGeneration,
            state.verifyCentralSnapshot,
            state.verifyChangeOverrideSnapshot,
            state.verifyHostConfiguration,
            state.verifyProviderRegistry,
            state.verifyDataAuthorization,
            state.verifySessionCapabilities,
            state.verifyProtectedContext,
          ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
      );
      assert.equal(replaced, true);
    } finally {
      mutableFs.openSync = openSync;
    }
  } finally {
    state.cleanup();
  }
});

test('noncanonical, linked, permissive, oversized, and digest-swapped records fail closed', async (t) => {
  const cases: Array<{
    name: string;
    tamper(
      files: ReturnType<typeof locations>,
      expected: ChangeRoleAssignmentRecordV1,
    ): void;
  }> = [
    {
      name: 'noncanonical object',
      tamper(files, expected) {
        fs.writeFileSync(
          files.object,
          `${JSON.stringify(expected, null, 2)}\n`,
        );
      },
    },
    {
      name: 'hard-linked object',
      tamper(files) {
        fs.linkSync(files.object, `${files.object}.alias`);
      },
    },
    {
      name: 'permissive object mode',
      tamper(files) {
        fs.chmodSync(files.object, 0o644);
      },
    },
    {
      name: 'oversized object',
      tamper(files) {
        fs.writeFileSync(files.object, 'x'.repeat(2_200_000));
      },
    },
    {
      name: 'ref digest swap',
      tamper(files, expected) {
        const ref = {
          schemaVersion: 1,
          kind: 'change-role-assignment-ref.v1',
          changeId: expected.changeId,
          planningGeneration: expected.planningGeneration,
          recordDigest: 'f'.repeat(64),
        };
        fs.writeFileSync(files.ref, `${canonicalJson(ref)}\n`);
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const state = fixture();
      try {
        const expected = record(state.primaryCentralSnapshot);
        createOrReadExactChangeRoleAssignmentRecordV1(
          state.paths,
          expected,
          state.verifyCentralSnapshot,
          state.verifyChangeOverrideSnapshot,
          state.verifyHostConfiguration,
          state.verifyProviderRegistry,
          state.verifyDataAuthorization,
          state.verifySessionCapabilities,
          state.verifyProtectedContext,
        );
        entry.tamper(locations(state.paths, expected), expected);
        assert.throws(
          () =>
            readChangeRoleAssignmentRecordV1(
              state.paths,
              expected.changeId,
              expected.planningGeneration,
              state.verifyCentralSnapshot,
              state.verifyChangeOverrideSnapshot,
              state.verifyHostConfiguration,
              state.verifyProviderRegistry,
              state.verifyDataAuthorization,
              state.verifySessionCapabilities,
              state.verifyProtectedContext,
            ),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'CHANGE_ROLE_ASSIGNMENT_STORE_INVALID',
        );
      } finally {
        state.cleanup();
      }
    });
  }
});
