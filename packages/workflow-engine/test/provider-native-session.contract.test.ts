import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderWrapperSessionProtocolParser,
  parseAgentProviderConfigToml,
  providerNativeSessionIdDigest,
  renderProviderWrapperSessionFrame,
  type AgentProviderConfigSnapshot,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolBinding,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import { createChangeRoleAssignmentRecordV1 } from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import {
  assertProviderNativeTurnBindingContinuationV1,
  assertProviderNativeTurnBindingV1,
  createProviderNativeSessionClaimV2,
  createProviderNativeSessionCompletionV2,
  createProviderNativeSessionClaimV1,
  createProviderNativeSessionCompletionV1,
  createProviderNativeTurnBindingV1,
  deriveProviderNativeSessionScopeV1,
  providerNativeSessionProtocolBindingV2,
} from '../src/modules/provider-orchestration/provider-native-session.ts';

const CHANGE_ID = 'native-session-foundation';
const PLANNING_GENERATION = 'a'.repeat(64);

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return entry.isFile() && candidate.endsWith('.ts') ? [candidate] : [];
  });
}

test('provider-native session foundation has one explicit production composition boundary', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  const owningModules = new Set([
    path.join(
      sourceRoot,
      'modules/provider-orchestration/provider-native-session.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-store.ts',
    ),
  ]);
  const consumers = sourceFiles(sourceRoot)
    .filter((filePath) => !owningModules.has(filePath))
    .filter((filePath) =>
      fs.readFileSync(filePath, 'utf8').includes('provider-native-session'),
    )
    .map((filePath) => path.relative(sourceRoot, filePath));

  assert.deepEqual(consumers, [
    'composition-root/change-role-assignment-production.ts',
    'modules/provider-orchestration/agent-runtime-port.ts',
  ]);
  const workerSource = fs.readFileSync(
    path.join(sourceRoot, 'entrypoints/worker/provider-worker.ts'),
    'utf8',
  );
  const runtimeSource = fs.readFileSync(
    path.join(sourceRoot, 'composition-root/agent-runtime-production.ts'),
    'utf8',
  );
  assert.match(
    workerSource,
    /nativeSessionTurn:\s*assignment\.nativeSessionTurn/u,
  );
  assert.match(
    runtimeSource,
    /runHostWrapperProviderThroughAgentRuntimeV1\(input, options\)/u,
  );
});

function hostConfiguration(
  options: Readonly<{
    protocol?: 'harness-jsonl-v2' | 'single-shot';
    resumable?: boolean;
  }> = {},
): AgentProviderConfigSnapshot {
  const protocol = options.protocol ?? 'harness-jsonl-v2';
  const resumable = options.resumable ?? true;
  const profiles = ['alpha', 'beta', 'gamma'];
  const capabilities = [
    'fresh-session',
    'plan-review',
    ...(resumable ? ['resumable-session'] : []),
    'survey',
    'task-diff-review',
    'task-implementation',
  ];
  const providers = profiles
    .map((logicalProviderId) => {
      if (protocol === 'single-shot') {
        return `[[providers]]
id = "${logicalProviderId}-primary"
logical_provider_id = "${logicalProviderId}"
family = "${logicalProviderId}"
capabilities = [${capabilities.map((value) => `"${value}"`).join(', ')}]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${logicalProviderId}-jsonl-v1"
executable = "/opt/providers/${logicalProviderId}"`;
      }
      return `[[providers]]
id = "${logicalProviderId}-primary"
logical_provider_id = "${logicalProviderId}"
family = "${logicalProviderId}"
capabilities = [${capabilities.map((value) => `"${value}"`).join(', ')}]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "/opt/providers/${logicalProviderId}"
start_args = ["start", "--request", "{request_file}"]
resume_args = [${
        resumable
          ? '"resume", "--session", "{native_session_id}", "--request", "{request_file}"'
          : ''
      }]
prompt_input = "stdin"
cancel = "process-group"`;
    })
    .join('\n\n');
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["alpha-primary", "beta-primary", "gamma-primary"]

${providers}

[provider_preferences]
author = ["alpha-primary", "beta-primary", "gamma-primary"]
builder = ["beta-primary", "alpha-primary", "gamma-primary"]
reviewer = ["gamma-primary", "alpha-primary", "beta-primary"]
`,
    { platform: 'linux' },
  );
}

function assignmentRecord(
  options: Parameters<typeof hostConfiguration>[0] &
    Readonly<{ belowFloor?: boolean }> = {},
) {
  const configuration = hostConfiguration(options);
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
    canResume: options.resumable ?? true,
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

function slotFor(
  record: ReturnType<typeof assignmentRecord>,
  role: 'author' | 'builder' | 'reviewer',
) {
  return record.sessionSlots.find((slot) => slot.roles.includes(role))!;
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

function nativeTurnBinding(
  record: ReturnType<typeof assignmentRecord>,
  roleLane: 'author' | 'builder' | 'reviewer',
  suffix: string,
  leaseToken: string,
) {
  const slot = slotFor(record, roleLane);
  const profile = slot.profiles.find(
    (candidate) => candidate.profileId !== null,
  )!;
  const profileConfiguration = record.host.configuration.providers.find(
    ({ id }) => id === profile.profileId,
  )!;
  return createProviderNativeTurnBindingV1({
    assignment: {
      changeId: record.changeId,
      planningGeneration: record.planningGeneration,
      assignmentRecordDigest: record.recordDigest,
      assignmentDigest: record.assignmentDigest,
      resolutionDigest: record.resolution.resolutionDigest,
      dataAuthorizationPolicyDigest:
        record.dataAuthorization.snapshot.policyDigest,
      inputManifestDigest:
        record.dataAuthorization.snapshot.inputManifestDigest!,
      relevantTargetDigest:
        record.dataAuthorization.snapshot.relevantTargetDigest!,
      sessionSlotId: slot.sessionSlotId,
      roleLane,
      logicalProviderId: slot.logicalProviderId,
      profileId: profile.profileId!,
      profileDigest: profile.profileDigest!,
      providerFamily: profileConfiguration.family,
      providerDefinitionDigest: slot.providerDefinitionDigest,
    },
    invocation: {
      ownerWorkflowId: `native-workflow-${suffix}`,
      invocationId: `native-invocation-${suffix}`,
      revision: 7,
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
      workflowId: `native-workflow-${suffix}`,
      workflowEpoch: 3,
      workflowContextDigest: `sha256:${'3'.repeat(64)}`,
      executionRevision: 9,
      executionStateDigest: `sha256:${crypto.createHash('sha256').update(`execution-${suffix}`).digest('hex')}`,
      jobId: `native-job-${suffix}`,
      jobStatus: 'running',
      jobRequestDigest: `sha256:${crypto.createHash('sha256').update(`job-request-${suffix}`).digest('hex')}`,
      acceptedAttemptId: null,
      acceptanceBindingDigest: null,
      attemptId: `native-attempt-${suffix}`,
      attemptNumber: 2,
      retryOf: `native-attempt-prior-${suffix}`,
      provider: profileConfiguration.family,
      attemptStatus: 'running',
      attemptInputDigest: `sha256:${'4'.repeat(64)}`,
      attemptRequestDigest: `sha256:${crypto.createHash('sha256').update(`request-${suffix}`).digest('hex')}`,
      attemptContextDigest: `sha256:${'3'.repeat(64)}`,
      attemptEnvironmentDigest: `sha256:${crypto.createHash('sha256').update(`environment-${suffix}`).digest('hex')}`,
      leaseGeneration: 4,
      leaseWorkerId: `native-worker-${suffix}`,
      leaseTokenDigest: `sha256:${crypto.createHash('sha256').update(leaseToken).digest('hex')}`,
      leaseAcquiredAt: '2030-01-02T02:04:05.000Z',
      leaseExpiresAt: '2030-01-02T03:04:05.000Z',
    },
  });
}

test('a below-floor assignment cannot create provider-native launch scope before Central Grant activation', () => {
  const record = assignmentRecord({ belowFloor: true });
  assert.notEqual(record.grantRequirement, null);

  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        record,
        slotFor(record, 'builder').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED',
  );
});

test('scope and public terminal records bind the exact assignment-wide slot without raw native identity', () => {
  const record = assignmentRecord();
  const builderSlot = slotFor(record, 'builder');
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    builderSlot.sessionSlotId,
  );
  const replay = deriveProviderNativeSessionScopeV1(
    record,
    builderSlot.sessionSlotId,
  );

  assert.deepEqual(scope, replay);
  assert.equal(scope.assignmentRecordDigest, record.recordDigest);
  assert.equal(scope.resolutionDigest, record.resolution.resolutionDigest);
  assert.equal(scope.sessionSlotId, builderSlot.sessionSlotId);
  assert.equal(scope.profileId, 'beta-primary');
  assert.equal(
    scope.providerConfigurationDigest,
    record.resolution.providerConfigurationDigest,
  );
  assert.equal(
    scope.providerRegistryDigest,
    record.resolution.providerRegistryDigest,
  );
  assert.match(scope.scopeKey, /^[0-9a-f]{64}$/u);

  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-1',
    requestDigest: '1'.repeat(64),
    attemptId: 'native-attempt-1',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const nativeSessionId = 'provider-native-secret-1';
  const materialized = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: successfulTerminal(binding, nativeSessionId),
  });

  assert.equal(materialized.completion.disposition, 'usable');
  assert.equal(materialized.completion.protocolReceipt?.terminal, 'result');
  assert.equal(materialized.handle?.nativeSessionId, nativeSessionId);
  assert.equal(canonicalJson(scope).includes(nativeSessionId), false);
  assert.equal(canonicalJson(claim).includes(nativeSessionId), false);
  assert.equal(
    canonicalJson(materialized.completion).includes(nativeSessionId),
    false,
  );
  assert.equal(Object.isFrozen(materialized.completion), true);
});

test('inactive V2 native-turn evidence is supplied by one exact Attempt fence without public native or lease secrets', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const rawLeaseToken = 'private-native-turn-lease-token';
  const turnBinding = nativeTurnBinding(
    record,
    'builder',
    'attempt-currentness',
    rawLeaseToken,
  );
  const claim = createProviderNativeSessionClaimV2({
    scope,
    turn: 1,
    predecessorCompletion: null,
    turnBinding,
  });
  const protocolBinding = providerNativeSessionProtocolBindingV2(claim);
  const rawNativeSessionId = 'private-native-turn-session-id';
  const materialized = createProviderNativeSessionCompletionV2({
    claim,
    currentTurnBinding: turnBinding,
    terminal: successfulTerminal(protocolBinding, rawNativeSessionId),
  });

  assert.equal(claim.action, 'start');
  assert.equal(protocolBinding.sessionControl.action, 'start');
  assert.equal(protocolBinding.sessionControl.expectedNativeSessionId, null);
  assert.equal(
    claim.turnBinding.execution.leaseTokenDigest,
    `sha256:${crypto.createHash('sha256').update(rawLeaseToken).digest('hex')}`,
  );
  assert.equal(materialized.completion.disposition, 'usable');
  assert.equal(materialized.handle?.nativeSessionId, rawNativeSessionId);
  const publicEvidence = canonicalJson({
    claim,
    completion: materialized.completion,
  });
  assert.equal(publicEvidence.includes(rawLeaseToken), false);
  assert.equal(publicEvidence.includes(rawNativeSessionId), false);
  assert.equal(Object.isFrozen(claim.turnBinding), true);

  assert.throws(
    () =>
      assertProviderNativeTurnBindingV1({
        ...turnBinding,
        execution: {
          ...turnBinding.execution,
          leaseGeneration: turnBinding.execution.leaseGeneration + 1,
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  assert.throws(
    () =>
      createProviderNativeSessionCompletionV2({
        claim,
        terminal: successfulTerminal(protocolBinding, rawNativeSessionId),
      } as never),
    /Provider-native session state is invalid or unsupported\./u,
  );
  assert.throws(
    () =>
      createProviderNativeSessionClaimV2({
        scope,
        turn: 2,
        predecessorCompletion: materialized.completion,
        turnBinding,
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );

  const changedAtSameRevision = createProviderNativeTurnBindingV1({
    assignment: turnBinding.assignment,
    invocation: turnBinding.invocation,
    execution: {
      ...turnBinding.execution,
      executionStateDigest: `sha256:${'8'.repeat(64)}`,
    },
  });
  assert.throws(
    () =>
      assertProviderNativeTurnBindingContinuationV1(
        turnBinding,
        changedAtSameRevision,
      ),
    /Provider-native session state is invalid or unsupported\./u,
  );
  const regressedAttempt = createProviderNativeTurnBindingV1({
    assignment: turnBinding.assignment,
    invocation: turnBinding.invocation,
    execution: {
      ...turnBinding.execution,
      executionRevision: turnBinding.execution.executionRevision + 1,
      executionStateDigest: `sha256:${'9'.repeat(64)}`,
      attemptStatus: 'leased',
    },
  });
  assert.throws(
    () =>
      assertProviderNativeTurnBindingContinuationV1(
        turnBinding,
        regressedAttempt,
      ),
    /Provider-native session state is invalid or unsupported\./u,
  );
  assert.throws(
    () =>
      createProviderNativeTurnBindingV1({
        assignment: turnBinding.assignment,
        invocation: turnBinding.invocation,
        execution: {
          ...turnBinding.execution,
          workflowId: 'different-owner-workflow',
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  for (const repositoryId of [
    ' untrimmed-repository ',
    'x'.repeat(513),
    'repository\u0000identity',
  ]) {
    assert.throws(
      () =>
        createProviderNativeTurnBindingV1({
          assignment: turnBinding.assignment,
          invocation: { ...turnBinding.invocation, repositoryId },
          execution: turnBinding.execution,
        }),
      /Provider-native session state is invalid or unsupported\./u,
    );
  }
});

test('inactive V2 turn binding rejects provider, authorized-input, and role-purpose rebound', () => {
  const record = assignmentRecord();
  const turnBinding = nativeTurnBinding(
    record,
    'builder',
    'assignment-cross-binding',
    'private-assignment-cross-binding-lease-token',
  );

  assert.equal(
    turnBinding.assignment.assignmentDigest,
    record.assignmentDigest,
  );
  assert.equal(
    turnBinding.assignment.dataAuthorizationPolicyDigest,
    record.dataAuthorization.snapshot.policyDigest,
  );
  assert.equal(
    turnBinding.assignment.inputManifestDigest,
    record.dataAuthorization.snapshot.inputManifestDigest,
  );
  assert.equal(
    turnBinding.assignment.relevantTargetDigest,
    record.dataAuthorization.snapshot.relevantTargetDigest,
  );
  assert.equal(
    turnBinding.assignment.providerFamily,
    turnBinding.invocation.providerId,
  );
  assert.equal(
    turnBinding.assignment.providerFamily,
    turnBinding.execution.provider,
  );
  assert.equal(
    turnBinding.assignment.dataAuthorizationPolicyDigest,
    turnBinding.invocation.policyDigest,
  );

  const reboundManifest = '8'.repeat(64);
  const invalidCandidates = [
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        providerId: 'gamma',
      },
      execution: {
        ...turnBinding.execution,
        provider: 'gamma',
      },
    },
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        inputManifestDigest: reboundManifest,
      },
      execution: {
        ...turnBinding.execution,
        attemptInputDigest: `sha256:${reboundManifest}`,
      },
    },
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        targetDigest: '9'.repeat(64),
      },
      execution: turnBinding.execution,
    },
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        policyDigest: '7'.repeat(64),
      },
      execution: turnBinding.execution,
    },
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        purpose: 'plan-review' as const,
      },
      execution: turnBinding.execution,
    },
    {
      assignment: {
        ...turnBinding.assignment,
        roleLane: 'author' as const,
      },
      invocation: turnBinding.invocation,
      execution: turnBinding.execution,
    },
    {
      assignment: turnBinding.assignment,
      invocation: {
        ...turnBinding.invocation,
        purpose: 'survey' as const,
      },
      execution: turnBinding.execution,
    },
  ];

  for (const candidate of invalidCandidates) {
    assert.throws(
      () => createProviderNativeTurnBindingV1(candidate),
      /Provider-native session state is invalid or unsupported\./u,
    );
  }

  const reviewer = nativeTurnBinding(
    record,
    'reviewer',
    'reviewer-purpose',
    'private-reviewer-purpose-lease-token',
  );
  assert.equal(reviewer.assignment.roleLane, 'reviewer');
  assert.equal(reviewer.invocation.purpose, 'plan-review');
});

test('usable completion requires the exact receipt-bound private identity observation', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-observation-binding',
    requestDigest: '9'.repeat(64),
    attemptId: 'native-observation-attempt',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const terminal = successfulTerminal(
    binding,
    'provider-native-observation-secret',
  );

  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          kind: 'protocol-outcome',
          outcome: terminal.outcome,
        } as never,
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          ...terminal,
          privateIdentityObservation: {
            ...terminal.privateIdentityObservation,
            protocolReceiptDigest: '8'.repeat(64),
          },
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  const substitutedNativeSessionId = 'provider-native-substituted-secret';
  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          ...terminal,
          privateIdentityObservation: {
            ...terminal.privateIdentityObservation,
            nativeSessionId: substitutedNativeSessionId,
            nativeSessionIdDigest: providerNativeSessionIdDigest(
              substitutedNativeSessionId,
            ),
          },
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
});

test('resume binds the exact usable predecessor and never serializes its raw native identity', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const startBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-2',
    requestDigest: '2'.repeat(64),
    attemptId: 'native-attempt-2',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const firstClaim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding: startBinding,
  });
  const nativeSessionId = 'provider-native-secret-2';
  const first = createProviderNativeSessionCompletionV1({
    claim: firstClaim,
    binding: startBinding,
    terminal: successfulTerminal(startBinding, nativeSessionId),
  });
  const resumeBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-resume-2',
    requestDigest: '3'.repeat(64),
    attemptId: 'native-attempt-3',
    sessionControl: {
      action: 'resume',
      nativeSessionIdentityMode: 'engine-supplied',
      expectedNativeSessionId: nativeSessionId,
    },
  };
  const resumeClaim = createProviderNativeSessionClaimV1({
    scope,
    turn: 2,
    predecessorCompletion: first.completion,
    binding: resumeBinding,
  });

  assert.equal(resumeClaim.action, 'resume');
  assert.equal(
    resumeClaim.predecessorCompletionDigest,
    first.completion.completionDigest,
  );
  assert.equal(
    resumeClaim.expectedNativeSessionIdDigest,
    first.completion.nativeSessionIdDigest,
  );
  assert.equal(canonicalJson(resumeClaim).includes(nativeSessionId), false);

  assert.throws(
    () =>
      createProviderNativeSessionClaimV1({
        scope,
        turn: 3,
        predecessorCompletion: {
          ...first.completion,
          disposition: 'timeout',
        } as typeof first.completion,
        binding: resumeBinding,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_INVALID',
  );
});

test('caller-existing, V1/single-shot profiles, and missing resume evidence fail closed', () => {
  const current = assignmentRecord();
  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        current,
        slotFor(current, 'author').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_CALLER_EXISTING_UNSUPPORTED',
  );

  const singleShot = assignmentRecord({ protocol: 'single-shot' });
  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        singleShot,
        slotFor(singleShot, 'builder').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_PROTOCOL_UNSUPPORTED',
  );

  const nonResumable = assignmentRecord({ resumable: false });
  const scope = deriveProviderNativeSessionScopeV1(
    nonResumable,
    slotFor(nonResumable, 'builder').sessionSlotId,
  );
  const startBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-no-resume',
    requestDigest: '4'.repeat(64),
    attemptId: 'native-attempt-no-resume',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding: startBinding,
  });
  const nativeSessionId = 'provider-native-no-resume';
  const completed = createProviderNativeSessionCompletionV1({
    claim,
    binding: startBinding,
    terminal: successfulTerminal(startBinding, nativeSessionId),
  });
  assert.throws(
    () =>
      createProviderNativeSessionClaimV1({
        scope,
        turn: 2,
        predecessorCompletion: completed.completion,
        binding: {
          invocationId: 'native-resume-without-evidence',
          requestDigest: '5'.repeat(64),
          attemptId: 'native-attempt-without-evidence',
          sessionControl: {
            action: 'resume',
            nativeSessionIdentityMode: 'engine-supplied',
            expectedNativeSessionId: nativeSessionId,
          },
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED',
  );
});

test('error, cancellation, timeout, and claim-crash are terminal and unusable', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-terminal-1',
    requestDigest: '6'.repeat(64),
    attemptId: 'native-terminal-attempt-1',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const parser = createProviderWrapperSessionProtocolParser({ binding });
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
          type: 'error' as const,
          sequence: 2,
          code: 'PROVIDER_FAILED',
        },
      ]
        .map(renderProviderWrapperSessionFrame)
        .join(''),
    ),
  );
  const providerError = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: {
      kind: 'protocol-outcome',
      outcome: parser.finish({ cancellationForced: false }),
      privateIdentityObservation: null,
    },
  });
  const timeout = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: { kind: 'timeout' },
  });
  const crash = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: { kind: 'claim-crash' },
  });

  assert.equal(providerError.completion.disposition, 'error');
  assert.equal(providerError.handle, null);
  assert.equal(timeout.completion.disposition, 'timeout');
  assert.equal(timeout.handle, null);
  assert.equal(crash.completion.disposition, 'indeterminate');
  assert.equal(crash.handle, null);
  assert.equal(
    [providerError, timeout, crash].every(
      ({ completion }) => completion.usable === false,
    ),
    true,
  );
});
