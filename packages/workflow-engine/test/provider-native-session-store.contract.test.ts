import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderWrapperSessionProtocolParser,
  parseAgentProviderConfigToml,
  renderProviderWrapperSessionFrame,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionProtocolOutcome,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  assertAgentRolePlanV2Snapshot,
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
  type AgentRolePlanV2SnapshotVerifierPort,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultSnapshotVerifierPort,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  createChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentHostConfigurationVerifierPort,
  type ChangeRoleAssignmentProviderRegistryVerifierPort,
  type ChangeRoleAssignmentSessionCapabilityVerifierPort,
} from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
  type ChangeRoleAssignmentDataAuthorizationVerifierPort,
  type ChangeRoleAssignmentProtectedContextVerifierPort,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import {
  createProviderNativeSessionClaimV2,
  createProviderNativeTurnBindingV1,
  type ProviderNativeTurnBindingV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';
import {
  claimProviderNativeSessionTurnV2,
  claimProviderNativeSessionTurnV1,
  completeProviderNativeSessionTurnV2,
  completeProviderNativeSessionTurnV1,
  inspectProviderNativeSessionChainV2,
  readProviderNativeSessionChainV2,
  readProviderNativeSessionChainV1,
  type ProviderNativeTurnCurrentnessVerifierPort,
} from '../src/runtime/storage-journal/provider-native-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';

const CHANGE_ID = 'native-session-store';
const PLANNING_GENERATION = 'a'.repeat(64);

function assignmentRecord(options: Readonly<{ belowFloor?: boolean }> = {}) {
  const configuration = parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["alpha-primary", "beta-primary", "gamma-primary"]

[[providers]]
id = "alpha-primary"
logical_provider_id = "alpha"
family = "alpha"
capabilities = ["fresh-session", "plan-review", "resumable-session", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "/opt/providers/alpha"
start_args = ["start", "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[[providers]]
id = "beta-primary"
logical_provider_id = "beta"
family = "beta"
capabilities = ["fresh-session", "plan-review", "resumable-session", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "/opt/providers/beta"
start_args = ["start", "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[[providers]]
id = "gamma-primary"
logical_provider_id = "gamma"
family = "gamma"
capabilities = ["fresh-session", "plan-review", "resumable-session", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "/opt/providers/gamma"
start_args = ["start", "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["alpha-primary", "beta-primary", "gamma-primary"]
builder = ["beta-primary", "alpha-primary", "gamma-primary"]
reviewer = ["gamma-primary", "alpha-primary", "beta-primary"]
`,
    { platform: 'linux' },
  );
  const central = createCentralRoleProviderDefault({
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
          preferredLogicalProviderId: 'beta',
        },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'gamma',
        },
      },
    ],
    globalProviderRanking: ['alpha', 'beta', 'gamma'],
  });
  const caller = {
    logicalProviderId: 'alpha',
    profileId: 'alpha-primary',
    engineSessionId: 'caller-session-alpha',
    adoptableRoles: ['author'] as const,
  };
  const dataAuthorization = {
    policyDigest: 'c'.repeat(64),
    inputManifestDigest: '4'.repeat(64),
    relevantTargetDigest: '5'.repeat(64),
    profiles: configuration.providers.map(({ id }) => ({
      profileId: id,
      allowed: true,
      reason: 'AUTHORIZED',
    })),
  };
  const sessionCapabilities = configuration.providers.map(({ id }) => ({
    profileId: id,
    canStartFresh: true,
    canResume: true,
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
  const changeOverrideBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: options.belowFloor
      ? [
          { pair: 'author-builder', required: 'session-independent' },
          { pair: 'author-reviewer', required: 'session-independent' },
          { pair: 'builder-reviewer', required: 'session-independent' },
        ]
      : [],
    customWrapperPolicy: 'allowed',
    grantReferences: [],
  };
  const changeOverridePlan = {
    ...changeOverrideBody,
    planDigest: agentRolePlanV2Digest(changeOverrideBody),
  };
  const resolved = resolveChangeRoleAssignmentV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverridePlan,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext: createChangeRoleAssignmentProtectedContextV1({
      classification: 'ordinary',
      pathRoleSourceDigest: '6'.repeat(64),
      policySourceDigest: '7'.repeat(64),
      inputManifestDigest: '4'.repeat(64),
      relevantTargetDigest: '5'.repeat(64),
    }),
  });
  assert.notEqual(resolved.outcome, 'unsatisfied');
  const centralSource = renderCentralRoleProviderDefault(central);
  const changeOverrideSource = renderAgentRolePlanV2(changeOverridePlan);
  const changeOverride = createAgentRolePlanV2Snapshot({
    pinnedCommit: 'b'.repeat(40),
    blobObjectId: crypto
      .createHash('sha1')
      .update(`blob ${Buffer.byteLength(changeOverrideSource)}\0`)
      .update(changeOverrideSource)
      .digest('hex'),
    plan: changeOverridePlan,
  });
  return createChangeRoleAssignmentRecordV1({
    central: createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: 'b'.repeat(40),
      blobObjectId: crypto
        .createHash('sha1')
        .update(`blob ${Buffer.byteLength(centralSource)}\0`)
        .update(centralSource)
        .digest('hex'),
      configuration: central,
    }),
    host: { sourceDigest: 'e'.repeat(64), configuration },
    changeOverride,
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: (
      resolved as Exclude<typeof resolved, { outcome: 'unsatisfied' }>
    ).resolution,
  });
}

function fixture(options: Readonly<{ belowFloor?: boolean }> = {}) {
  const gitCommonDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-native-session-store-'),
  );
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const assignment = assignmentRecord(options);
  const verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort =
    (candidate) => {
      assert.equal(canonicalJson(candidate), canonicalJson(assignment.central));
      return assignment.central;
    };
  const verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort = (
    candidate,
  ) => assertAgentRolePlanV2Snapshot(candidate);
  const verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort =
    (candidate) => candidate;
  const verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort =
    (candidate) => candidate;
  const verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort =
    (candidate) => candidate;
  const verifySessionCapabilities: ChangeRoleAssignmentSessionCapabilityVerifierPort =
    (candidate) => candidate;
  const verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort =
    (candidate) => candidate;
  createOrReadExactChangeRoleAssignmentRecordV1(
    paths,
    assignment,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapabilities,
    verifyProtectedContext,
  );
  const slot = assignment.sessionSlots.find((entry) =>
    entry.roles.includes('builder'),
  )!;
  const rawLeaseToken = 'private-store-native-turn-lease-token';
  let currentTurnBinding = nativeTurnBinding(
    assignment,
    slot,
    'builder',
    'current',
    rawLeaseToken,
  );
  let currentLeaseToken = rawLeaseToken;
  let currentnessCalls = 0;
  const verifyNativeTurnCurrentness: ProviderNativeTurnCurrentnessVerifierPort =
    {
      withCurrentFence(query, operation) {
        currentnessCalls += 1;
        assert.equal(query.changeId, assignment.changeId);
        assert.equal(query.planningGeneration, assignment.planningGeneration);
        assert.equal(query.assignmentRecordDigest, assignment.recordDigest);
        assert.equal(
          query.sessionSlotId,
          currentTurnBinding.assignment.sessionSlotId,
        );
        assert.equal(
          query.invocationId,
          currentTurnBinding.invocation.invocationId,
        );
        assert.equal(query.workflowId, currentTurnBinding.execution.workflowId);
        assert.equal(query.jobId, currentTurnBinding.execution.jobId);
        assert.equal(query.attemptId, currentTurnBinding.execution.attemptId);
        assert.equal(
          query.leaseGeneration,
          currentTurnBinding.execution.leaseGeneration,
        );
        assert.equal(query.leaseToken, currentLeaseToken);
        assert.equal(
          currentTurnBinding.execution.leaseTokenDigest,
          `sha256:${crypto.createHash('sha256').update(query.leaseToken).digest('hex')}`,
        );
        assert.deepEqual(Object.keys(query).sort(), [
          'assignmentRecordDigest',
          'attemptId',
          'changeId',
          'invocationId',
          'jobId',
          'kind',
          'leaseGeneration',
          'leaseToken',
          'planningGeneration',
          'schemaVersion',
          'sessionSlotId',
          'workflowId',
        ]);
        return operation(currentTurnBinding);
      },
    };
  return {
    gitCommonDirectory,
    paths,
    assignment,
    slot,
    rawLeaseToken,
    verifyNativeTurnCurrentness,
    currentnessCalls: () => currentnessCalls,
    currentTurnBinding: () => currentTurnBinding,
    currentLeaseToken: () => currentLeaseToken,
    setCurrentTurnBinding(
      binding: ProviderNativeTurnBindingV1,
      leaseToken = rawLeaseToken,
    ) {
      currentTurnBinding = binding;
      currentLeaseToken = leaseToken;
    },
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapabilities,
    verifyProtectedContext,
    cleanup: () =>
      fs.rmSync(gitCommonDirectory, { recursive: true, force: true }),
  };
}

function nativeTurnBinding(
  assignment: ReturnType<typeof assignmentRecord>,
  slot: ReturnType<typeof assignmentRecord>['sessionSlots'][number],
  roleLane: 'author' | 'builder' | 'reviewer',
  suffix: string,
  leaseToken: string,
  attemptIdentitySuffix = suffix,
) {
  const profile = slot.profiles.find(
    (candidate) => candidate.profileId !== null,
  )!;
  const profileConfiguration = assignment.host.configuration.providers.find(
    ({ id }) => id === profile.profileId,
  )!;
  return createProviderNativeTurnBindingV1({
    assignment: {
      changeId: assignment.changeId,
      planningGeneration: assignment.planningGeneration,
      assignmentRecordDigest: assignment.recordDigest,
      assignmentDigest: assignment.assignmentDigest,
      resolutionDigest: assignment.resolution.resolutionDigest,
      dataAuthorizationPolicyDigest:
        assignment.dataAuthorization.snapshot.policyDigest,
      inputManifestDigest:
        assignment.dataAuthorization.snapshot.inputManifestDigest!,
      relevantTargetDigest:
        assignment.dataAuthorization.snapshot.relevantTargetDigest!,
      sessionSlotId: slot.sessionSlotId,
      roleLane,
      logicalProviderId: slot.logicalProviderId,
      profileId: profile.profileId!,
      profileDigest: profile.profileDigest!,
      providerFamily: profileConfiguration.family,
      providerDefinitionDigest: slot.providerDefinitionDigest,
    },
    invocation: {
      ownerWorkflowId: `native-workflow-${attemptIdentitySuffix}`,
      invocationId: `native-invocation-${suffix}`,
      revision: 11,
      state: 'leased',
      providerId: profileConfiguration.family,
      purpose: roleLane === 'reviewer' ? 'plan-review' : 'task-implementation',
      requestDigest: crypto
        .createHash('sha256')
        .update(`request-${suffix}`)
        .digest('hex'),
      inputManifestDigest: '4'.repeat(64),
      targetDigest: '5'.repeat(64),
      policyDigest: 'c'.repeat(64),
      repositoryId: 'github:example/repository',
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
    },
    execution: {
      workflowId: `native-workflow-${attemptIdentitySuffix}`,
      workflowEpoch: 5,
      workflowContextDigest: `sha256:${'3'.repeat(64)}`,
      executionRevision: 13,
      executionStateDigest: `sha256:${crypto.createHash('sha256').update(`execution-${suffix}`).digest('hex')}`,
      jobId: `native-job-${attemptIdentitySuffix}`,
      jobStatus: 'running',
      jobRequestDigest: `sha256:${crypto.createHash('sha256').update(`job-request-${attemptIdentitySuffix}`).digest('hex')}`,
      acceptedAttemptId: null,
      acceptanceBindingDigest: null,
      attemptId: `native-attempt-${attemptIdentitySuffix}`,
      attemptNumber: 3,
      retryOf: `native-attempt-prior-${attemptIdentitySuffix}`,
      provider: profileConfiguration.family,
      attemptStatus: 'leased',
      attemptInputDigest: `sha256:${'4'.repeat(64)}`,
      attemptRequestDigest: `sha256:${crypto.createHash('sha256').update(`request-${suffix}`).digest('hex')}`,
      attemptContextDigest: `sha256:${'3'.repeat(64)}`,
      attemptEnvironmentDigest: `sha256:${crypto.createHash('sha256').update(`environment-${suffix}`).digest('hex')}`,
      leaseGeneration: 6,
      leaseWorkerId: `native-worker-${suffix}`,
      leaseTokenDigest: `sha256:${crypto.createHash('sha256').update(leaseToken).digest('hex')}`,
      leaseAcquiredAt: '2030-01-02T02:04:05.000Z',
      leaseExpiresAt: '2030-01-02T03:04:05.000Z',
    },
  });
}

function claimInput(
  state: ReturnType<typeof fixture>,
  predecessorCompletionDigest: string | null,
  suffix: string,
) {
  return {
    changeId: state.assignment.changeId,
    planningGeneration: state.assignment.planningGeneration,
    assignmentRecordDigest: state.assignment.recordDigest,
    sessionSlotId: state.slot.sessionSlotId,
    predecessorCompletionDigest,
    invocationId: `native-invocation-${suffix}`,
    requestDigest: crypto.createHash('sha256').update(suffix).digest('hex'),
    attemptId: `native-attempt-${suffix}`,
  };
}

function claimTurn(
  state: ReturnType<typeof fixture>,
  input: ReturnType<typeof claimInput>,
) {
  return claimProviderNativeSessionTurnV1(
    state.paths,
    input,
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
  );
}

function claimTurnV2(
  state: ReturnType<typeof fixture>,
  predecessorCompletionDigest: string | null,
  sessionSlotId = state.slot.sessionSlotId,
) {
  const binding = state.currentTurnBinding();
  return claimProviderNativeSessionTurnV2(
    state.paths,
    {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId,
      predecessorCompletionDigest,
      invocationId: binding.invocation.invocationId,
      workflowId: binding.execution.workflowId,
      jobId: binding.execution.jobId,
      attemptId: binding.execution.attemptId,
      leaseGeneration: binding.execution.leaseGeneration,
      leaseToken: state.currentLeaseToken(),
    },
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
    state.verifyNativeTurnCurrentness,
  );
}

function completeTurn(
  state: ReturnType<typeof fixture>,
  input: Parameters<typeof completeProviderNativeSessionTurnV1>[1],
) {
  return completeProviderNativeSessionTurnV1(
    state.paths,
    input,
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
  );
}

function completeTurnV2(
  state: ReturnType<typeof fixture>,
  claimDigest: string,
  terminal: Parameters<
    typeof completeProviderNativeSessionTurnV2
  >[1]['terminal'],
) {
  const binding = state.currentTurnBinding();
  return completeProviderNativeSessionTurnV2(
    state.paths,
    {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest,
      invocationId: binding.invocation.invocationId,
      workflowId: binding.execution.workflowId,
      jobId: binding.execution.jobId,
      attemptId: binding.execution.attemptId,
      leaseGeneration: binding.execution.leaseGeneration,
      leaseToken: state.currentLeaseToken(),
      terminal,
    },
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
    state.verifyNativeTurnCurrentness,
  );
}

function readChain(state: ReturnType<typeof fixture>) {
  return readProviderNativeSessionChainV1(
    state.paths,
    state.assignment.changeId,
    state.assignment.planningGeneration,
    state.assignment.recordDigest,
    state.slot.sessionSlotId,
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
  );
}

function readChainV2(state: ReturnType<typeof fixture>) {
  return readProviderNativeSessionChainV2(
    state.paths,
    state.assignment.changeId,
    state.assignment.planningGeneration,
    state.assignment.recordDigest,
    state.slot.sessionSlotId,
    state.verifyCentralSnapshot,
    state.verifyChangeOverrideSnapshot,
    state.verifyHostConfiguration,
    state.verifyProviderRegistry,
    state.verifyDataAuthorization,
    state.verifySessionCapabilities,
    state.verifyProtectedContext,
  );
}

function successfulTerminal(
  binding: ProviderWrapperSessionProtocolBinding,
  nativeSessionId: string,
) {
  let privateIdentityObservation:
    ProviderWrapperNativeSessionIdentityObservation | undefined;
  const parser = createProviderWrapperSessionProtocolParser({
    binding,
    privateNativeSessionIdentitySink(identity) {
      privateIdentityObservation = identity;
    },
  });
  parser.push(
    Buffer.from(
      [
        {
          schemaVersion: 2 as const,
          type: 'hello' as const,
          sequence: 1,
          protocol: 'harness-jsonl-v2' as const,
        },
        {
          schemaVersion: 2 as const,
          type: 'session' as const,
          sequence: 2,
          action: binding.sessionControl.action,
          nativeSessionId,
        },
        {
          schemaVersion: 2 as const,
          type: 'result' as const,
          sequence: 3,
          outputSlot: 'primary' as const,
        },
      ]
        .map(renderProviderWrapperSessionFrame)
        .join(''),
    ),
  );
  const outcome = parser.finish({ cancellationForced: false });
  assert.notEqual(privateIdentityObservation, undefined);
  return {
    kind: 'protocol-outcome' as const,
    outcome,
    privateIdentityObservation: privateIdentityObservation!,
  };
}

function allFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const location = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(location) : [location];
  });
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

function inspectChainV2(state: ReturnType<typeof fixture>) {
  return inspectProviderNativeSessionChainV2(
    state.paths,
    state.assignment.changeId,
    state.assignment.planningGeneration,
    state.assignment.recordDigest,
    state.slot.sessionSlotId,
  );
}

function v2PublicationRecoveryPath(
  target: string,
  state: ReturnType<typeof fixture>,
) {
  const root = path.join(state.paths.root, 'provider-native-sessions', 'v2');
  const relativeTarget = path.relative(root, target).split(path.sep).join('/');
  return path.join(
    root,
    'recovery',
    'sha256',
    `${crypto.createHash('sha256').update(relativeTarget).digest('hex')}.publish.tmp`,
  );
}

function nativeSessionStoreRoot(state: ReturnType<typeof fixture>): string {
  return path.join(state.paths.root, 'provider-native-sessions', 'v1');
}

function nativeSessionFile(
  state: ReturnType<typeof fixture>,
  suffix: string,
): string {
  return allFiles(nativeSessionStoreRoot(state)).find((file) =>
    file.endsWith(suffix),
  )!;
}

function publicationRecoveryPath(
  state: ReturnType<typeof fixture>,
  target: string,
  nonce = crypto.randomUUID(),
): string {
  const root = nativeSessionStoreRoot(state);
  const relativeTarget = path.relative(root, target).split(path.sep).join('/');
  const value = JSON.parse(fs.readFileSync(target, 'utf8')) as Readonly<{
    scope?: Readonly<{ scopeKey?: string }>;
    scopeKey?: string;
  }>;
  const scopeKey = value.scope?.scopeKey ?? value.scopeKey;
  assert.match(scopeKey ?? '', /^[0-9a-f]{64}$/u);
  const directory = path.join(root, 'recovery', 'sha256', scopeKey!);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return path.join(
    directory,
    `v1.${Buffer.from(relativeTarget, 'utf8').toString('base64url')}.${nonce}.publish.tmp`,
  );
}

function movePublishedFileToRecoveryTemp(
  state: ReturnType<typeof fixture>,
  target: string,
): string {
  const temporary = publicationRecoveryPath(state, target);
  fs.linkSync(target, temporary);
  fs.unlinkSync(target);
  assert.equal(fs.statSync(temporary).nlink, 1);
  return temporary;
}

test('historical V2 diagnostic observes an absent chain without callbacks, locks, recovery, or writes', () => {
  const state = fixture();
  try {
    const nativeRoot = path.join(
      state.paths.root,
      'provider-native-sessions',
      'v2',
    );
    assert.equal(fs.existsSync(nativeRoot), false);
    const before = treeFingerprint(state.paths.root);
    const diagnostic = withoutFilesystemMutations(() => inspectChainV2(state));
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      'assignmentAssurance',
      'attemptCurrentness',
      'authorityEligible',
      'chain',
      'kind',
      'operationalWrites',
      'outcome',
      'publicationRecovery',
      'recoveryPerformed',
      'schemaVersion',
      'transitionEligible',
    ]);
    assert.deepEqual(diagnostic, {
      schemaVersion: 2,
      kind: 'provider-native-session-historical-diagnostic.v2',
      outcome: 'absent',
      authorityEligible: false,
      transitionEligible: false,
      operationalWrites: false,
      recoveryPerformed: false,
      assignmentAssurance: 'store-owned-structural-record',
      attemptCurrentness: 'not-observed',
      publicationRecovery: 'not-applied',
      chain: {
        schemaVersion: 2,
        kind: 'provider-native-session-chain.v2',
        scope: diagnostic.chain.scope,
        state: 'empty',
        turns: [],
      },
    });
    assert.equal(fs.existsSync(nativeRoot), false);
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('historical V2 diagnostic validates a usable chain but returns no raw session or lease secret', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    const completionTimeBinding = createProviderNativeTurnBindingV1({
      assignment: first.claim.turnBinding.assignment,
      invocation: {
        ...first.claim.turnBinding.invocation,
        revision: first.claim.turnBinding.invocation.revision + 1,
      },
      execution: {
        ...first.claim.turnBinding.execution,
        executionRevision:
          first.claim.turnBinding.execution.executionRevision + 1,
        executionStateDigest: `sha256:${crypto
          .createHash('sha256')
          .update('historical-diagnostic-completion')
          .digest('hex')}`,
        jobStatus: 'running',
        attemptStatus: 'running',
      },
    });
    state.setCurrentTurnBinding(completionTimeBinding);
    const rawNativeSessionId = 'historical-diagnostic-private-session';
    completeTurnV2(
      state,
      first.claim.claimDigest,
      successfulTerminal(first.binding!, rawNativeSessionId),
    );
    const before = treeFingerprint(state.paths.root);

    const diagnostic = withoutFilesystemMutations(() => inspectChainV2(state));
    assert.equal(diagnostic.outcome, 'inspected');
    assert.equal(diagnostic.authorityEligible, false);
    assert.equal(diagnostic.transitionEligible, false);
    assert.equal(diagnostic.operationalWrites, false);
    assert.equal(diagnostic.recoveryPerformed, false);
    assert.equal(
      diagnostic.assignmentAssurance,
      'store-owned-structural-record',
    );
    assert.equal(diagnostic.attemptCurrentness, 'not-observed');
    assert.equal(diagnostic.publicationRecovery, 'not-applied');
    assert.equal(diagnostic.chain.state, 'resumable');
    const publicEvidence = canonicalJson(diagnostic);
    assert.equal(publicEvidence.includes(rawNativeSessionId), false);
    assert.equal(publicEvidence.includes(state.rawLeaseToken), false);
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('historical V2 diagnostic exposes a publication recovery window without repairing it', () => {
  const state = fixture();
  try {
    claimTurnV2(state, null);
    const root = path.join(state.paths.root, 'provider-native-sessions', 'v2');
    const target = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}chains${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    );
    assert.notEqual(target, undefined);
    const temporary = v2PublicationRecoveryPath(target!, state);
    fs.linkSync(target!, temporary);
    const before = treeFingerprint(state.paths.root);
    assert.equal(fs.statSync(target!).nlink, 2);

    assert.throws(
      () => inspectChainV2(state),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
    );
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.statSync(target!).nlink, 2);
    assert.deepEqual(treeFingerprint(state.paths.root), before);

    assert.equal(readChainV2(state).state, 'claimed');
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.statSync(target!).nlink, 1);
  } finally {
    state.cleanup();
  }
});

test('historical V2 diagnostic leaves an exact temp-only recovery window byte-for-byte untouched', () => {
  const state = fixture();
  try {
    claimTurnV2(state, null);
    const root = path.join(state.paths.root, 'provider-native-sessions', 'v2');
    const target = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}chains${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    )!;
    const temporary = v2PublicationRecoveryPath(target, state);
    fs.linkSync(target, temporary);
    fs.unlinkSync(target);
    const beforeBytes = fs.readFileSync(temporary);
    const beforeStats = fs.statSync(temporary);
    assert.equal(beforeStats.nlink, 1);

    withoutFilesystemMutations(() => {
      assert.throws(
        () => inspectChainV2(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
      );
    });
    const afterStats = fs.statSync(temporary);
    assert.equal(fs.existsSync(target), false);
    assert.equal(afterStats.dev, beforeStats.dev);
    assert.equal(afterStats.ino, beforeStats.ino);
    assert.equal(afterStats.nlink, 1);
    assert.deepEqual(fs.readFileSync(temporary), beforeBytes);
  } finally {
    state.cleanup();
  }
});

test('historical V2 diagnostic rejects an assignment digest rebound without creating native state', () => {
  const state = fixture();
  try {
    const nativeRoot = path.join(
      state.paths.root,
      'provider-native-sessions',
      'v2',
    );
    const before = treeFingerprint(state.paths.root);
    assert.throws(
      () =>
        inspectProviderNativeSessionChainV2(
          state.paths,
          state.assignment.changeId,
          state.assignment.planningGeneration,
          'f'.repeat(64),
          state.slot.sessionSlotId,
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
    assert.equal(fs.existsSync(nativeRoot), false);
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('historical V2 diagnostic rejects a domain-valid claim rebound from its store-owned assignment', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    const reboundBinding = createProviderNativeTurnBindingV1({
      assignment: {
        ...first.claim.turnBinding.assignment,
        assignmentDigest: '6'.repeat(64),
      },
      invocation: first.claim.turnBinding.invocation,
      execution: first.claim.turnBinding.execution,
    });
    const reboundClaim = createProviderNativeSessionClaimV2({
      scope: first.claim.scope,
      turn: 1,
      predecessorCompletion: null,
      turnBinding: reboundBinding,
    });
    const root = path.join(state.paths.root, 'provider-native-sessions', 'v2');
    const claimRef = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}chains${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    )!;
    const attemptRef = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}attempts${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    )!;
    const claimObject = path.join(
      root,
      'claims',
      'sha256',
      `${reboundClaim.claimDigest}.claim.json`,
    );
    fs.writeFileSync(claimObject, `${canonicalJson(reboundClaim)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.writeFileSync(
      claimRef,
      `${canonicalJson({
        schemaVersion: 2,
        kind: 'provider-native-session-claim-ref.v2',
        scopeKey: reboundClaim.scope.scopeKey,
        turn: 1,
        claimDigest: reboundClaim.claimDigest,
      })}\n`,
    );
    fs.writeFileSync(
      attemptRef,
      `${canonicalJson({
        schemaVersion: 2,
        kind: 'provider-native-session-attempt-claim-ref.v2',
        attemptIdentityDigest: reboundBinding.attemptIdentityDigest,
        scopeKey: reboundClaim.scope.scopeKey,
        turn: 1,
        claimDigest: reboundClaim.claimDigest,
        turnBindingDigest: reboundBinding.turnBindingDigest,
      })}\n`,
    );
    const before = treeFingerprint(state.paths.root);

    assert.throws(
      () => inspectChainV2(state),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
    assert.deepEqual(treeFingerprint(state.paths.root), before);
  } finally {
    state.cleanup();
  }
});

test('inactive V2 claims hold exact Attempt currentness across indexed scope publication without public secrets', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    assert.equal(first.outcome, 'claimed');
    assert.notEqual(first.binding, null);
    assert.equal(
      first.claim.turnBinding.execution.attemptId,
      'native-attempt-current',
    );
    assert.equal(
      first.claim.turnBinding.execution.leaseTokenDigest,
      `sha256:${crypto.createHash('sha256').update(state.rawLeaseToken).digest('hex')}`,
    );
    assert.equal(state.currentnessCalls(), 1);

    const replay = claimTurnV2(state, null);
    assert.equal(replay.outcome, 'already-claimed');
    assert.equal(replay.binding, null);
    assert.equal(replay.claim.claimDigest, first.claim.claimDigest);
    assert.equal(state.currentnessCalls(), 2);

    const completionTimeBinding = createProviderNativeTurnBindingV1({
      assignment: first.claim.turnBinding.assignment,
      invocation: {
        ...first.claim.turnBinding.invocation,
        revision: first.claim.turnBinding.invocation.revision + 1,
      },
      execution: {
        ...first.claim.turnBinding.execution,
        executionRevision:
          first.claim.turnBinding.execution.executionRevision + 1,
        executionStateDigest: `sha256:${crypto
          .createHash('sha256')
          .update('completion-time-execution-state')
          .digest('hex')}`,
        jobStatus: 'running',
        attemptStatus: 'running',
      },
    });
    state.setCurrentTurnBinding(completionTimeBinding);
    const rawNativeSessionId = 'private-v2-native-session-id';
    const completion = completeTurnV2(
      state,
      first.claim.claimDigest,
      successfulTerminal(first.binding!, rawNativeSessionId),
    );
    assert.equal(completion.disposition, 'usable');
    assert.equal(
      completion.turnBinding.turnBindingDigest,
      completionTimeBinding.turnBindingDigest,
    );
    assert.notEqual(
      completion.turnBinding.turnBindingDigest,
      first.claim.turnBinding.turnBindingDigest,
    );
    assert.equal(state.currentnessCalls(), 3);
    const chain = readChainV2(state);
    assert.equal(chain.state, 'resumable');
    assert.equal(
      chain.turns[0]?.completion?.completionDigest,
      completion.completionDigest,
    );

    const files = allFiles(
      path.join(state.paths.root, 'provider-native-sessions', 'v2'),
    );
    const publicFiles = files.filter(
      (file) => !file.includes('/handles/sha256/'),
    );
    assert.equal(
      publicFiles.some((file) =>
        fs.readFileSync(file, 'utf8').includes(rawNativeSessionId),
      ),
      false,
    );
    assert.equal(
      files.some((file) =>
        fs.readFileSync(file, 'utf8').includes(state.rawLeaseToken),
      ),
      false,
    );
    const privateHandles = files.filter((file) =>
      file.includes('/handles/sha256/'),
    );
    assert.equal(privateHandles.length, 1);
    assert.equal(
      fs.readFileSync(privateHandles[0]!, 'utf8').includes(rawNativeSessionId),
      true,
    );
    assert.equal(fs.statSync(privateHandles[0]!).mode & 0o777, 0o600);
  } finally {
    state.cleanup();
  }
});

test('inactive V2 completion refuses a rebound or re-leased Attempt before publishing terminal evidence', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    const reboundLeaseToken = 'different-private-lease-token';
    const rebound = createProviderNativeTurnBindingV1({
      assignment: first.claim.turnBinding.assignment,
      invocation: {
        ...first.claim.turnBinding.invocation,
        revision: first.claim.turnBinding.invocation.revision + 1,
      },
      execution: {
        ...first.claim.turnBinding.execution,
        executionRevision:
          first.claim.turnBinding.execution.executionRevision + 1,
        executionStateDigest: `sha256:${crypto
          .createHash('sha256')
          .update('re-leased-execution-state')
          .digest('hex')}`,
        leaseGeneration: first.claim.turnBinding.execution.leaseGeneration + 1,
        leaseTokenDigest: `sha256:${crypto
          .createHash('sha256')
          .update(reboundLeaseToken)
          .digest('hex')}`,
        leaseAcquiredAt: '2030-01-02T02:14:05.000Z',
      },
    });
    assert.equal(
      rebound.attemptIdentityDigest,
      first.claim.turnBinding.attemptIdentityDigest,
    );
    assert.notEqual(
      rebound.turnBindingDigest,
      first.claim.turnBinding.turnBindingDigest,
    );
    state.setCurrentTurnBinding(rebound, reboundLeaseToken);

    assert.throws(
      () =>
        completeTurnV2(
          state,
          first.claim.claimDigest,
          successfulTerminal(first.binding!, 'must-not-be-persisted'),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
    assert.equal(readChainV2(state).state, 'claimed');
    assert.equal(
      allFiles(
        path.join(state.paths.root, 'provider-native-sessions', 'v2'),
      ).some((file) => file.endsWith('.completion.json')),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('inactive V2 rejects a current binding whose role lane is not owned by the selected assignment slot', () => {
  const state = fixture();
  try {
    assert.deepEqual(state.slot.roles, ['builder']);
    state.setCurrentTurnBinding(
      nativeTurnBinding(
        state.assignment,
        state.slot,
        'reviewer',
        'current',
        state.rawLeaseToken,
      ),
    );
    assert.throws(
      () => claimTurnV2(state, null),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
    assert.equal(
      fs.existsSync(
        path.join(state.paths.root, 'provider-native-sessions', 'v2'),
      ),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('inactive V2 rejects assignment and authorized-input rebound before any scope publication', async (t) => {
  const cases = [
    {
      name: 'selected profile and provider family',
      mutate(binding: ProviderNativeTurnBindingV1) {
        return createProviderNativeTurnBindingV1({
          assignment: {
            ...binding.assignment,
            profileId: 'gamma-primary',
            providerFamily: 'gamma',
          },
          invocation: { ...binding.invocation, providerId: 'gamma' },
          execution: { ...binding.execution, provider: 'gamma' },
        });
      },
    },
    {
      name: 'input manifest',
      mutate(binding: ProviderNativeTurnBindingV1) {
        const digest = '8'.repeat(64);
        return createProviderNativeTurnBindingV1({
          assignment: { ...binding.assignment, inputManifestDigest: digest },
          invocation: { ...binding.invocation, inputManifestDigest: digest },
          execution: {
            ...binding.execution,
            attemptInputDigest: `sha256:${digest}`,
          },
        });
      },
    },
    {
      name: 'relevant target',
      mutate(binding: ProviderNativeTurnBindingV1) {
        const digest = '9'.repeat(64);
        return createProviderNativeTurnBindingV1({
          assignment: { ...binding.assignment, relevantTargetDigest: digest },
          invocation: { ...binding.invocation, targetDigest: digest },
          execution: binding.execution,
        });
      },
    },
    {
      name: 'assignment digest',
      mutate(binding: ProviderNativeTurnBindingV1) {
        return createProviderNativeTurnBindingV1({
          assignment: {
            ...binding.assignment,
            assignmentDigest: '6'.repeat(64),
          },
          invocation: binding.invocation,
          execution: binding.execution,
        });
      },
    },
    {
      name: 'data-authorization policy',
      mutate(binding: ProviderNativeTurnBindingV1) {
        const digest = '7'.repeat(64);
        return createProviderNativeTurnBindingV1({
          assignment: {
            ...binding.assignment,
            dataAuthorizationPolicyDigest: digest,
          },
          invocation: { ...binding.invocation, policyDigest: digest },
          execution: binding.execution,
        });
      },
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, () => {
      const state = fixture();
      try {
        state.setCurrentTurnBinding(
          candidate.mutate(state.currentTurnBinding()),
        );
        assert.throws(
          () => claimTurnV2(state, null),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
        );
        assert.equal(
          fs.existsSync(
            path.join(state.paths.root, 'provider-native-sessions', 'v2'),
          ),
          false,
        );
      } finally {
        state.cleanup();
      }
    });
  }
});

test('inactive V2 global Attempt index prevents one engine Attempt from claiming two assignment session scopes', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    const reviewerSlot = state.assignment.sessionSlots.find((entry) =>
      entry.roles.includes('reviewer'),
    )!;
    const secondScopeBinding = nativeTurnBinding(
      state.assignment,
      reviewerSlot,
      'reviewer',
      'other-scope',
      state.rawLeaseToken,
      'current',
    );
    assert.equal(
      secondScopeBinding.attemptIdentityDigest,
      first.claim.turnBinding.attemptIdentityDigest,
    );
    state.setCurrentTurnBinding(secondScopeBinding);

    assert.throws(
      () => claimTurnV2(state, null, reviewerSlot.sessionSlotId),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
    assert.equal(readChainV2(state).turns.length, 1);
  } finally {
    state.cleanup();
  }
});

test('inactive V2 recovers the crash window after Attempt index publication without reissuing launch', () => {
  const state = fixture();
  try {
    const first = claimTurnV2(state, null);
    const root = path.join(state.paths.root, 'provider-native-sessions', 'v2');
    const claimRef = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}chains${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    );
    const attemptIndex = allFiles(root).find(
      (file) =>
        file.includes(`${path.sep}attempts${path.sep}sha256${path.sep}`) &&
        file.endsWith('.claim-ref.json'),
    );
    assert.notEqual(claimRef, undefined);
    assert.notEqual(attemptIndex, undefined);
    const indexBefore = fs.readFileSync(attemptIndex!);

    // Simulate process death after the globally serialized Attempt index was
    // durable but before the per-scope discovery ref was published.
    fs.unlinkSync(claimRef!);
    assert.equal(readChainV2(state).state, 'empty');

    const recovered = claimTurnV2(state, null);
    assert.equal(recovered.outcome, 'already-claimed');
    assert.equal(recovered.binding, null);
    assert.equal(recovered.claim.claimDigest, first.claim.claimDigest);
    assert.equal(readChainV2(state).state, 'claimed');
    assert.deepEqual(fs.readFileSync(attemptIndex!), indexBefore);

    const reviewerSlot = state.assignment.sessionSlots.find((entry) =>
      entry.roles.includes('reviewer'),
    )!;
    state.setCurrentTurnBinding(
      nativeTurnBinding(
        state.assignment,
        reviewerSlot,
        'reviewer',
        'post-recovery-other-scope',
        state.rawLeaseToken,
        'current',
      ),
    );
    assert.throws(
      () => claimTurnV2(state, null, reviewerSlot.sessionSlotId),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
  } finally {
    state.cleanup();
  }
});

test('publication cleanup failure never masks the primary create-only conflict', (t) => {
  const state = fixture();
  const originalLinkSync = fs.linkSync.bind(fs);
  const originalUnlinkSync = fs.unlinkSync.bind(fs);
  try {
    t.mock.method(
      fs,
      'linkSync',
      (temporaryPath: fs.PathLike, targetPath: fs.PathLike) => {
        if (!String(temporaryPath).endsWith('.publish.tmp')) {
          return originalLinkSync(temporaryPath, targetPath);
        }
        fs.writeFileSync(targetPath, '{}\n', { flag: 'wx', mode: 0o600 });
        throw Object.assign(new Error('forced create-only conflict'), {
          code: 'EEXIST',
        });
      },
    );
    t.mock.method(fs, 'unlinkSync', (targetPath: fs.PathLike) => {
      if (String(targetPath).endsWith('.publish.tmp')) {
        throw Object.assign(new Error('forced cleanup failure'), {
          code: 'EACCES',
        });
      }
      return originalUnlinkSync(targetPath);
    });

    assert.throws(
      () => claimTurnV2(state, null),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );
  } finally {
    state.cleanup();
  }
});

test('store refuses a below-floor assignment before publishing any native-session launch evidence', () => {
  const state = fixture({ belowFloor: true });
  try {
    assert.notEqual(state.assignment.grantRequirement, null);
    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(state, null, 'below-floor-without-activation'),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED',
    );
    assert.equal(
      fs.existsSync(path.join(state.paths.root, 'provider-native-sessions')),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('assignment evidence drift after scope preflight blocks claim publication inside the scope lock', () => {
  const state = fixture();
  try {
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
        claimProviderNativeSessionTurnV1(
          state.paths,
          claimInput(state, null, 'assignment-evidence-drift'),
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
      fs.existsSync(path.join(state.paths.root, 'provider-native-sessions')),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('a start claim is create-only and an observed claim can never be relaunched after crash', () => {
  const state = fixture();
  try {
    const input = claimInput(state, null, 'start-crash');
    const first = claimTurn(state, input);
    const replay = claimTurn(state, input);

    assert.equal(first.outcome, 'claimed');
    assert.notEqual(first.binding, null);
    assert.equal(replay.outcome, 'already-claimed');
    assert.equal(replay.binding, null);
    assert.equal(replay.claim.claimDigest, first.claim.claimDigest);
    assert.equal(readChain(state).state, 'claimed');

    const crashed = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: { kind: 'claim-crash' },
    });
    assert.equal(crashed.disposition, 'indeterminate');
    assert.equal(readChain(state).state, 'terminal-unusable');
    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(state, crashed.completionDigest, 'forbidden-relaunch'),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_TERMINAL_UNUSABLE',
    );
  } finally {
    state.cleanup();
  }
});

test('publication recovery discards exact temp-only claim windows and deterministically republishes', async (t) => {
  await t.test('claim object temp before link', () => {
    const state = fixture();
    try {
      const input = claimInput(state, null, 'claim-object-temp-only');
      const first = claimTurn(state, input);
      const claimObject = nativeSessionFile(state, '.claim.json');
      const claimRef = nativeSessionFile(state, '.claim-ref.json');
      fs.unlinkSync(claimRef);
      const temporary = movePublishedFileToRecoveryTemp(state, claimObject);
      fs.truncateSync(temporary, 0);

      const recovered = claimTurn(state, input);
      assert.equal(recovered.outcome, 'claimed');
      assert.notEqual(recovered.binding, null);
      assert.equal(recovered.claim.claimDigest, first.claim.claimDigest);
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(readChain(state).state, 'claimed');
    } finally {
      state.cleanup();
    }
  });

  await t.test('claim ref temp before link', () => {
    const state = fixture();
    try {
      const input = claimInput(state, null, 'claim-ref-temp-only');
      const first = claimTurn(state, input);
      const claimRef = nativeSessionFile(state, '.claim-ref.json');
      const temporary = movePublishedFileToRecoveryTemp(state, claimRef);

      const recovered = claimTurn(state, input);
      assert.equal(recovered.outcome, 'claimed');
      assert.notEqual(recovered.binding, null);
      assert.equal(recovered.claim.claimDigest, first.claim.claimDigest);
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(
        readChain(state).turns[0]?.claim.claimDigest,
        first.claim.claimDigest,
      );
    } finally {
      state.cleanup();
    }
  });
});

test('publication recovery removes exact second links before reading and resuming the chain', () => {
  const state = fixture();
  try {
    const first = claimTurn(
      state,
      claimInput(state, null, 'second-link-recovery'),
    );
    const firstCompletion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: successfulTerminal(
        first.binding!,
        'provider-native-second-link-recovery',
      ),
    });
    const targets = [
      nativeSessionFile(state, '.claim.json'),
      nativeSessionFile(state, '.claim-ref.json'),
      nativeSessionFile(state, '.completion.json'),
      nativeSessionFile(state, '.completion-ref.json'),
      nativeSessionFile(state, '.handle.json'),
    ];
    for (const target of targets) {
      const temporary = publicationRecoveryPath(state, target);
      fs.linkSync(target, temporary);
      assert.equal(fs.statSync(target).nlink, 2);
      const recovered = readChain(state);
      assert.equal(recovered.state, 'resumable');
      assert.equal(
        recovered.turns[0]?.completion?.completionDigest,
        firstCompletion.completionDigest,
      );
      assert.equal(fs.statSync(target).nlink, 1);
      assert.equal(fs.existsSync(temporary), false);
    }

    const resumed = claimTurn(
      state,
      claimInput(
        state,
        firstCompletion.completionDigest,
        'after-second-link-recovery',
      ),
    );
    assert.equal(resumed.outcome, 'claimed');
    assert.equal(resumed.binding?.sessionControl.action, 'resume');
  } finally {
    state.cleanup();
  }
});

test('publication recovery fails closed for conflicting, multiple, or foreign unsafe temps', async (t) => {
  await t.test('conflicting separate inode', () => {
    const state = fixture();
    try {
      claimTurn(state, claimInput(state, null, 'conflicting-recovery-temp'));
      const target = nativeSessionFile(state, '.claim-ref.json');
      const temporary = publicationRecoveryPath(state, target);
      fs.copyFileSync(target, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      assert.throws(
        () => readChain(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
      );
    } finally {
      state.cleanup();
    }
  });

  await t.test('multiple recovery links', () => {
    const state = fixture();
    try {
      claimTurn(state, claimInput(state, null, 'multiple-recovery-temps'));
      const target = nativeSessionFile(state, '.claim-ref.json');
      fs.linkSync(target, publicationRecoveryPath(state, target));
      fs.linkSync(target, publicationRecoveryPath(state, target));
      assert.throws(
        () => readChain(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
      );
    } finally {
      state.cleanup();
    }
  });

  await t.test('foreign symlink is never trusted as a recovery temp', () => {
    const state = fixture();
    try {
      claimTurn(state, claimInput(state, null, 'foreign-recovery-temp'));
      const target = nativeSessionFile(state, '.claim-ref.json');
      const foreign = path.join(state.gitCommonDirectory, 'foreign.json');
      fs.writeFileSync(foreign, fs.readFileSync(target), { mode: 0o600 });
      fs.symlinkSync(foreign, publicationRecoveryPath(state, target));
      assert.throws(
        () => readChain(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
      );
      assert.equal(fs.existsSync(foreign), true);
    } finally {
      state.cleanup();
    }
  });
});

test('successful start and resume form one predecessor-CAS chain with the raw ID only in a 0600 handle', () => {
  const state = fixture();
  try {
    const first = claimTurn(state, claimInput(state, null, 'start-success'));
    assert.equal(first.outcome, 'claimed');
    assert.notEqual(first.binding, null);
    const nativeSessionId = 'provider-native-secret-store-1';
    const firstCompletion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: successfulTerminal(first.binding!, nativeSessionId),
    });
    assert.equal(firstCompletion.disposition, 'usable');
    assert.equal(firstCompletion.protocolReceipt?.terminal, 'result');

    const runtimeFiles = allFiles(
      path.join(state.paths.root, 'provider-native-sessions'),
    );
    const containingRawId = runtimeFiles.filter((file) =>
      fs.readFileSync(file, 'utf8').includes(nativeSessionId),
    );
    assert.equal(containingRawId.length, 1);
    assert.match(containingRawId[0]!, /\/handles\/sha256\//u);
    assert.equal(fs.statSync(containingRawId[0]!).mode & 0o777, 0o600);
    assert.equal(
      runtimeFiles.every((file) => (fs.statSync(file).mode & 0o777) === 0o600),
      true,
    );

    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(state, 'f'.repeat(64), 'wrong-predecessor'),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    );

    const resumed = claimTurn(
      state,
      claimInput(state, firstCompletion.completionDigest, 'resume-success'),
    );
    assert.equal(resumed.outcome, 'claimed');
    assert.equal(resumed.binding?.sessionControl.action, 'resume');
    assert.equal(
      resumed.binding?.sessionControl.expectedNativeSessionId,
      nativeSessionId,
    );
    const replay = claimTurn(
      state,
      claimInput(state, firstCompletion.completionDigest, 'resume-success'),
    );
    assert.equal(replay.outcome, 'already-claimed');
    assert.equal(replay.binding, null);

    const secondCompletion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: resumed.claim.claimDigest,
      terminal: successfulTerminal(resumed.binding!, nativeSessionId),
    });
    const chain = readChain(state);
    assert.equal(chain.state, 'resumable');
    assert.equal(chain.turns.length, 2);
    assert.equal(
      chain.turns[1]!.claim.predecessorCompletionDigest,
      firstCompletion.completionDigest,
    );
    assert.equal(
      chain.turns[1]!.completion?.completionDigest,
      secondCompletion.completionDigest,
    );
  } finally {
    state.cleanup();
  }
});

test('provider error, cancellation, and timeout close the chain without a usable handle', async (t) => {
  for (const disposition of ['error', 'cancelled', 'timeout'] as const) {
    await t.test(disposition, () => {
      const state = fixture();
      try {
        const claimed = claimTurn(state, claimInput(state, null, disposition));
        assert.equal(claimed.outcome, 'claimed');
        let terminal:
          | Readonly<{ kind: 'timeout' }>
          | Readonly<{
              kind: 'protocol-outcome';
              outcome: ProviderWrapperSessionProtocolOutcome;
              privateIdentityObservation: null;
            }>;
        if (disposition === 'timeout') {
          terminal = { kind: 'timeout' };
        } else {
          const parser = createProviderWrapperSessionProtocolParser({
            binding: claimed.binding!,
          });
          parser.push(
            Buffer.from(
              renderProviderWrapperSessionFrame({
                schemaVersion: 2,
                type: 'hello',
                sequence: 1,
                protocol: 'harness-jsonl-v2',
              }),
            ),
          );
          if (disposition === 'cancelled') {
            parser.requestCancellation();
            parser.push(
              Buffer.from(
                renderProviderWrapperSessionFrame({
                  schemaVersion: 2,
                  type: 'cancel-ack',
                  sequence: 2,
                }),
              ),
            );
          } else {
            parser.push(
              Buffer.from(
                renderProviderWrapperSessionFrame({
                  schemaVersion: 2,
                  type: 'error',
                  sequence: 2,
                  code: 'PROVIDER_FAILED',
                }),
              ),
            );
          }
          terminal = {
            kind: 'protocol-outcome',
            outcome: parser.finish({ cancellationForced: false }),
            privateIdentityObservation: null,
          };
        }
        const completion = completeTurn(state, {
          changeId: state.assignment.changeId,
          planningGeneration: state.assignment.planningGeneration,
          assignmentRecordDigest: state.assignment.recordDigest,
          sessionSlotId: state.slot.sessionSlotId,
          claimDigest: claimed.claim.claimDigest,
          terminal,
        });
        assert.equal(completion.disposition, disposition);
        assert.equal(completion.usable, false);
        assert.equal(
          allFiles(
            path.join(state.paths.root, 'provider-native-sessions'),
          ).some((file) => file.includes('/handles/sha256/')),
          false,
        );
        assert.throws(
          () =>
            claimTurn(
              state,
              claimInput(
                state,
                completion.completionDigest,
                `after-${disposition}`,
              ),
            ),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_NATIVE_SESSION_TERMINAL_UNUSABLE',
        );
      } finally {
        state.cleanup();
      }
    });
  }
});

test('unsafe, non-canonical, linked, or symlinked immutable records fail closed', async (t) => {
  await t.test('mode and canonical bytes', () => {
    const state = fixture();
    try {
      claimTurn(state, claimInput(state, null, 'unsafe-mode'));
      const claimFile = allFiles(
        path.join(state.paths.root, 'provider-native-sessions'),
      ).find((file) => file.endsWith('.claim.json'))!;
      fs.chmodSync(claimFile, 0o644);
      assert.throws(
        () => readChain(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
      );
      fs.chmodSync(claimFile, 0o600);
      fs.appendFileSync(claimFile, ' ');
      assert.throws(
        () => readChain(state),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
      );
    } finally {
      state.cleanup();
    }
  });

  await t.test('hardlink and symlink', () => {
    for (const attack of ['hardlink', 'symlink'] as const) {
      const state = fixture();
      try {
        claimTurn(state, claimInput(state, null, `unsafe-${attack}`));
        const claimFile = allFiles(
          path.join(state.paths.root, 'provider-native-sessions'),
        ).find((file) => file.endsWith('.claim.json'))!;
        if (attack === 'hardlink') {
          fs.linkSync(claimFile, `${claimFile}.alias`);
        } else {
          const original = `${claimFile}.original`;
          fs.renameSync(claimFile, original);
          fs.symlinkSync(original, claimFile);
        }
        assert.throws(
          () => readChain(state),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
        );
      } finally {
        state.cleanup();
      }
    }
  });
});
