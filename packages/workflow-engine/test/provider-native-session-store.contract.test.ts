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
import {
  assertAgentRuntimeDurableNativeSessionAuthorityV1,
  createProviderNativeSessionClaimRefV1,
  createProviderNativeSessionCompletionRefV1,
} from '../src/modules/provider-orchestration/agent-runtime-durable-authority.ts';
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import {
  assertProviderNativeSessionCompletionV1,
  createProviderNativeSessionClaimV1,
  createProviderNativeSessionCompletionV1,
  type ProviderNativeSessionAssignmentAuthorityVerifierPort,
  type ProviderNativeSessionCompletionV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';
import {
  claimProviderNativeSessionTurnV1,
  completeClaimedProviderNativeSessionTurnV1,
  completeProviderNativeSessionTurnV1,
  publishProviderNativeSessionContinuationAuthorityV1,
  readProviderNativeSessionChainV1,
  recoverProviderNativeSessionTurnV1,
} from '../src/runtime/storage-journal/provider-native-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  providerNativeSessionClaimObjectPathV1,
  providerNativeSessionClaimRefPathV1,
  providerNativeSessionCompletionObjectPathV1,
  providerNativeSessionCompletionRefPathV1,
  providerNativeSessionContinuationAuthorityObjectPathV1,
  providerNativeSessionStorePathsV1,
} from '../src/runtime/session-workspace/provider-runtime-authority-paths.ts';

const CHANGE_ID = 'native-session-store';
const PLANNING_GENERATION = 'a'.repeat(64);

test('provider native session store exposes no inactive V2 surface', async () => {
  const publicSurface =
    await import('../src/runtime/storage-journal/provider-native-session-store.ts');
  for (const retiredExport of [
    'claimProviderNativeSessionTurnV2',
    'completeProviderNativeSessionTurnV2',
    'inspectProviderNativeSessionChainV2',
    'readProviderNativeSessionChainV2',
  ]) {
    assert.equal(retiredExport in publicSurface, false, retiredExport);
  }
  const source = fs.readFileSync(
    new URL(
      '../src/runtime/storage-journal/provider-native-session-store.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /ProviderNativeSession.*V2|NativeTurnCurrentness/u,
  );
});

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
  return {
    gitCommonDirectory,
    paths,
    assignment,
    slot,
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
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
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
    verifyAssignmentAuthority,
  );
}

function completeTurn(
  state: ReturnType<typeof fixture>,
  input: Parameters<typeof completeProviderNativeSessionTurnV1>[1],
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
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
    verifyAssignmentAuthority,
  );
}

function readChain(
  state: ReturnType<typeof fixture>,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
) {
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
    verifyAssignmentAuthority,
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

function rejectedResultTerminal(
  binding: ProviderWrapperSessionProtocolBinding,
  nativeSessionId: string,
) {
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
  return {
    kind: 'protocol-outcome' as const,
    outcome: parser.finish({ cancellationForced: false }),
    privateIdentityObservation: null,
  };
}

function allFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const location = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(location) : [location];
  });
}

function nativeSessionStoreRoot(state: ReturnType<typeof fixture>): string {
  return providerNativeSessionStorePathsV1(state.paths).root;
}

function nativeSessionFile(
  state: ReturnType<typeof fixture>,
  suffix: string,
): string {
  return allFiles(nativeSessionStoreRoot(state)).find((file) =>
    file.endsWith(suffix),
  )!;
}

function writeForgedContinuationAuthority(
  state: ReturnType<typeof fixture>,
  completion: ProviderNativeSessionCompletionV1,
): string {
  assert.ok(completion.protocolReceipt);
  const authorityPath = providerNativeSessionContinuationAuthorityObjectPathV1(
    providerNativeSessionStorePathsV1(state.paths),
    completion.completionDigest,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-continuation-authority.v1' as const,
    scopeKey: completion.scope.scopeKey,
    turn: completion.turn,
    claimDigest: completion.claimDigest,
    completionDigest: completion.completionDigest,
    invocationId: completion.invocationId,
    requestDigest: completion.requestDigest,
    attemptId: completion.attemptId,
    runtimeReceiptDigest: 'd'.repeat(64),
    terminalRevision: 2,
    terminalState: 'succeeded' as const,
    terminalDisposition: 'accepted' as const,
    failureCode: null,
    protocolReceiptDigest: completion.protocolReceipt.receiptDigest,
  };
  const authority = {
    ...body,
    authorityDigest: crypto
      .createHash('sha256')
      .update(
        `workflow.provider-native-session-continuation-authority.v1\n${canonicalJson(body)}`,
      )
      .digest('hex'),
  };
  fs.mkdirSync(path.dirname(authorityPath), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(authorityPath, `${canonicalJson(authority)}\n`, {
    mode: 0o600,
  });
  return authorityPath;
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

test('V1 native-session claim, read, and completion reverify exact role-assignment Grant authority', () => {
  const state = fixture({ belowFloor: true });
  try {
    let verificationCalls = 0;
    const verifyAssignmentAuthority: ProviderNativeSessionAssignmentAuthorityVerifierPort =
      (assignment) => {
        verificationCalls += 1;
        assert.equal(assignment.recordDigest, state.assignment.recordDigest);
        assert.equal(
          assignment.assignmentDigest,
          state.assignment.assignmentDigest,
        );
      };
    const claim = claimTurn(
      state,
      claimInput(state, null, 'below-floor-exact-authority'),
      verifyAssignmentAuthority,
    );
    assert.equal(claim.outcome, 'claimed');
    assert.ok(claim.binding);
    const callsAfterClaim = verificationCalls;
    assert.ok(callsAfterClaim >= 2);

    const chain = readChain(state, verifyAssignmentAuthority);
    assert.equal(chain.state, 'claimed');
    assert.ok(verificationCalls > callsAfterClaim);
    const callsAfterRead = verificationCalls;

    completeTurn(
      state,
      {
        changeId: state.assignment.changeId,
        planningGeneration: state.assignment.planningGeneration,
        assignmentRecordDigest: state.assignment.recordDigest,
        sessionSlotId: state.slot.sessionSlotId,
        claimDigest: claim.claim.claimDigest,
        terminal: successfulTerminal(
          claim.binding!,
          'provider-native-below-floor-exact-authority',
        ),
      },
      verifyAssignmentAuthority,
    );
    assert.ok(verificationCalls > callsAfterRead);
    assert.equal(
      readChain(state, verifyAssignmentAuthority).state,
      'continuation-pending',
    );
  } finally {
    state.cleanup();
  }
});

test('V1 native-session terminal fact persists from the immutable claim after authority drift', () => {
  const state = fixture({ belowFloor: true });
  try {
    const claim = claimTurn(
      state,
      claimInput(state, null, 'below-floor-terminal-after-drift'),
      () => undefined,
    );
    assert.ok(claim.binding);

    const completion = completeClaimedProviderNativeSessionTurnV1(state.paths, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claim.claim.claimDigest,
      terminal: successfulTerminal(
        claim.binding!,
        'provider-native-terminal-after-authority-drift',
      ),
    });

    assert.equal(completion.claimDigest, claim.claim.claimDigest);
    assert.equal(completion.disposition, 'usable');
  } finally {
    state.cleanup();
  }
});

test('native-session recovery returns an exact existing completion unchanged without private identity', () => {
  const state = fixture();
  try {
    const claimed = claimTurn(
      state,
      claimInput(state, null, 'recovery-existing-completion'),
    );
    assert.ok(claimed.binding);
    const nativeSessionId = 'provider-native-recovery-existing-secret';
    const completion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claimed.claim.claimDigest,
      terminal: successfulTerminal(claimed.binding, nativeSessionId),
    });
    assert.ok(completion.protocolReceipt);

    const recovered = recoverProviderNativeSessionTurnV1(state.paths, {
      scopeKey: claimed.claim.scope.scopeKey,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claimed.claim.claimDigest,
      invocationId: claimed.claim.invocationId,
      requestDigest: claimed.claim.requestDigest,
      attemptId: claimed.claim.attemptId,
      expectedProtocolReceiptDigest: completion.protocolReceipt.receiptDigest,
    });

    assert.equal(recovered.outcome, 'unchanged');
    assert.deepEqual(recovered.completion, completion);
    assert.equal(canonicalJson(recovered).includes(nativeSessionId), false);
    assert.equal(readChain(state).state, 'continuation-pending');
  } finally {
    state.cleanup();
  }
});

test('native-session recovery abandons an exact claimed turn as indeterminate without creating a handle', () => {
  const state = fixture();
  try {
    const claimed = claimTurn(
      state,
      claimInput(state, null, 'recovery-abandon-claimed'),
    );
    assert.ok(claimed.binding);
    const nativeSessionId = 'provider-native-recovery-abandoned-secret';
    const observedTerminal = successfulTerminal(
      claimed.binding,
      nativeSessionId,
    );
    const recoveryInput = {
      scopeKey: claimed.claim.scope.scopeKey,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claimed.claim.claimDigest,
      invocationId: claimed.claim.invocationId,
      requestDigest: claimed.claim.requestDigest,
      attemptId: claimed.claim.attemptId,
      expectedProtocolReceiptDigest:
        observedTerminal.outcome.receipt.receiptDigest,
    };
    assert.equal(canonicalJson(recoveryInput).includes(nativeSessionId), false);
    assert.throws(
      () =>
        recoverProviderNativeSessionTurnV1(state.paths, {
          ...recoveryInput,
          nativeSessionId,
        } as typeof recoveryInput),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    );
    assert.equal(readChain(state).state, 'claimed');

    const recovered = recoverProviderNativeSessionTurnV1(
      state.paths,
      recoveryInput,
    );
    assert.equal(recovered.outcome, 'abandoned');
    assert.equal(recovered.completion.disposition, 'indeterminate');
    assert.equal(recovered.completion.usable, false);
    assert.equal(recovered.completion.handleDigest, null);
    assert.equal(recovered.completion.protocolReceipt, null);

    const replay = recoverProviderNativeSessionTurnV1(
      state.paths,
      recoveryInput,
    );
    assert.equal(replay.outcome, 'unchanged');
    assert.deepEqual(replay.completion, recovered.completion);
    assert.equal(readChain(state).state, 'terminal-unusable');
    assert.equal(
      allFiles(nativeSessionStoreRoot(state)).some((file) =>
        file.includes('/handles/sha256/'),
      ),
      false,
    );
    assert.equal(
      allFiles(nativeSessionStoreRoot(state)).some((file) =>
        fs.readFileSync(file, 'utf8').includes(nativeSessionId),
      ),
      false,
    );
  } finally {
    state.cleanup();
  }
});

test('native-session recovery fails closed on mismatched public claim bindings', () => {
  const state = fixture();
  try {
    const claimed = claimTurn(
      state,
      claimInput(state, null, 'recovery-binding-conflict'),
    );
    assert.ok(claimed.binding);
    const completion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claimed.claim.claimDigest,
      terminal: successfulTerminal(
        claimed.binding,
        'provider-native-recovery-binding-secret',
      ),
    });
    assert.ok(completion.protocolReceipt);
    const exact = {
      scopeKey: claimed.claim.scope.scopeKey,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: claimed.claim.claimDigest,
      invocationId: claimed.claim.invocationId,
      requestDigest: claimed.claim.requestDigest,
      attemptId: claimed.claim.attemptId,
      expectedProtocolReceiptDigest: completion.protocolReceipt.receiptDigest,
    };
    const mismatches = [
      { ...exact, scopeKey: 'f'.repeat(64) },
      {
        ...exact,
        sessionSlotId: `role-assignment-session-${'f'.repeat(64)}`,
      },
      { ...exact, invocationId: 'native-invocation-other' },
      { ...exact, requestDigest: 'f'.repeat(64) },
      { ...exact, attemptId: 'native-attempt-other' },
      { ...exact, expectedProtocolReceiptDigest: 'f'.repeat(64) },
    ];
    for (const mismatch of mismatches) {
      assert.throws(
        () => recoverProviderNativeSessionTurnV1(state.paths, mismatch),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
      );
    }
    assert.equal(readChain(state).state, 'continuation-pending');
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

test('publication recovery removes exact second links before reading a continuation-pending chain', () => {
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
      assert.equal(recovered.state, 'continuation-pending');
      assert.equal(
        recovered.turns[0]?.completion?.completionDigest,
        firstCompletion.completionDigest,
      );
      assert.equal(fs.statSync(target).nlink, 1);
      assert.equal(fs.existsSync(temporary), false);
    }

    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(
            state,
            firstCompletion.completionDigest,
            'after-second-link-recovery',
          ),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_CONTINUATION_NOT_AUTHORIZED',
    );
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

test('a successful start stays pending with the raw ID only in a 0600 handle', () => {
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

    const chain = readChain(state);
    assert.equal(chain.state, 'continuation-pending');
    assert.equal(chain.turns.length, 1);
    assert.equal(
      chain.turns[0]!.completion?.completionDigest,
      firstCompletion.completionDigest,
    );
  } finally {
    state.cleanup();
  }
});

test('a validated result rejected before private identity admission is terminal and cannot resume', () => {
  const state = fixture();
  try {
    const first = claimTurn(
      state,
      claimInput(state, null, 'result-rejected-before-identity-admission'),
    );
    assert.ok(first.binding);
    const nativeSessionId = 'provider-native-rejected-result-secret';
    const completion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: rejectedResultTerminal(first.binding, nativeSessionId),
    });

    assert.deepEqual(
      assertProviderNativeSessionCompletionV1(
        JSON.parse(canonicalJson(completion)),
      ),
      completion,
    );
    assert.equal(completion.disposition, 'rejected');
    assert.equal(completion.usable, false);
    assert.equal(completion.protocolReceipt?.terminal, 'result');
    assert.equal(
      completion.nativeSessionIdDigest,
      completion.protocolReceipt?.observedNativeSessionIdDigest,
    );
    assert.notEqual(completion.nativeSessionIdDigest, null);
    assert.equal(completion.handleDigest, null);
    assert.equal(readChain(state).state, 'terminal-unusable');
    assert.equal(
      allFiles(nativeSessionStoreRoot(state)).some((file) =>
        fs.readFileSync(file, 'utf8').includes(nativeSessionId),
      ),
      false,
    );
    assert.equal(
      allFiles(nativeSessionStoreRoot(state)).some((file) =>
        file.includes('/handles/sha256/'),
      ),
      false,
    );
    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(
            state,
            completion.completionDigest,
            'resume-rejected-result',
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

test('usable native completion remains continuation-pending without exact outer success authority', () => {
  const state = fixture();
  try {
    const first = claimTurn(
      state,
      claimInput(state, null, 'continuation-authority-missing'),
    );
    const completion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: successfulTerminal(
        first.binding!,
        'provider-native-continuation-authority-missing',
      ),
    });

    assert.equal(readChain(state).state, 'continuation-pending');
    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(
            state,
            completion.completionDigest,
            'continuation-authority-missing-resume',
          ),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_CONTINUATION_NOT_AUTHORIZED',
    );
  } finally {
    state.cleanup();
  }
});

test('a forged canonical continuation marker cannot authorize a native resume', () => {
  const state = fixture();
  try {
    const first = claimTurn(
      state,
      claimInput(state, null, 'continuation-authority-forged'),
    );
    const completion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: successfulTerminal(
        first.binding!,
        'provider-native-continuation-authority-forged',
      ),
    });
    const locations = providerNativeSessionStorePathsV1(state.paths);
    const authorityPath =
      providerNativeSessionContinuationAuthorityObjectPathV1(
        locations,
        completion.completionDigest,
      );
    const beforeRejectedPublication = allFiles(state.paths.root).map(
      (filePath) => ({
        relativePath: path.relative(state.paths.root, filePath),
        bytes: fs.readFileSync(filePath),
      }),
    );
    assert.throws(
      () =>
        publishProviderNativeSessionContinuationAuthorityV1(state.paths, {
          changeId: state.assignment.changeId,
          planningGeneration: state.assignment.planningGeneration,
          assignmentRecordDigest: state.assignment.recordDigest,
          sessionSlotId: state.slot.sessionSlotId,
          completionDigest: completion.completionDigest,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    );
    assert.equal(fs.existsSync(authorityPath), false);
    assert.deepEqual(
      allFiles(state.paths.root).map((filePath) => ({
        relativePath: path.relative(state.paths.root, filePath),
        bytes: fs.readFileSync(filePath),
      })),
      beforeRejectedPublication,
    );

    writeForgedContinuationAuthority(state, completion);
    const authorityBytes = fs.readFileSync(authorityPath);
    const completionPath = providerNativeSessionCompletionObjectPathV1(
      locations,
      completion.completionDigest,
    );
    const completionBytes = fs.readFileSync(completionPath);
    assert.throws(
      () => readChain(state),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    );
    assert.throws(
      () =>
        claimTurn(
          state,
          claimInput(
            state,
            completion.completionDigest,
            'continuation-authority-forged-resume',
          ),
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    );
    assert.deepEqual(fs.readFileSync(authorityPath), authorityBytes);
    assert.deepEqual(fs.readFileSync(completionPath), completionBytes);
  } finally {
    state.cleanup();
  }
});

test('linked or symlinked continuation authority fails closed before resume', async (t) => {
  for (const attack of ['hardlink', 'symlink'] as const) {
    await t.test(attack, () => {
      const state = fixture();
      try {
        const first = claimTurn(
          state,
          claimInput(state, null, `continuation-authority-${attack}`),
        );
        const completion = completeTurn(state, {
          changeId: state.assignment.changeId,
          planningGeneration: state.assignment.planningGeneration,
          assignmentRecordDigest: state.assignment.recordDigest,
          sessionSlotId: state.slot.sessionSlotId,
          claimDigest: first.claim.claimDigest,
          terminal: successfulTerminal(
            first.binding!,
            `provider-native-continuation-authority-${attack}`,
          ),
        });
        const authorityPath = writeForgedContinuationAuthority(
          state,
          completion,
        );
        if (attack === 'hardlink') {
          fs.linkSync(authorityPath, `${authorityPath}.alias`);
        } else {
          const original = `${authorityPath}.original`;
          fs.renameSync(authorityPath, original);
          fs.symlinkSync(original, authorityPath);
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
    });
  }
});

test('durable native-session authority requires an exact continuation marker before a successor', () => {
  const state = fixture();
  try {
    const first = claimTurn(
      state,
      claimInput(state, null, 'durable-authority-start'),
    );
    const nativeSessionId = 'provider-native-durable-authority';
    const firstCompletion = completeTurn(state, {
      changeId: state.assignment.changeId,
      planningGeneration: state.assignment.planningGeneration,
      assignmentRecordDigest: state.assignment.recordDigest,
      sessionSlotId: state.slot.sessionSlotId,
      claimDigest: first.claim.claimDigest,
      terminal: successfulTerminal(first.binding!, nativeSessionId),
    });
    const chain = readChain(state);
    const locations = providerNativeSessionStorePathsV1(state.paths);
    const turns = chain.turns.map(({ claim, completion }) => {
      assert.ok(completion);
      return {
        claim: JSON.parse(
          fs.readFileSync(
            providerNativeSessionClaimObjectPathV1(
              locations,
              claim.claimDigest,
            ),
            'utf8',
          ),
        ),
        claimRef: JSON.parse(
          fs.readFileSync(
            providerNativeSessionClaimRefPathV1(
              locations,
              claim.scope.scopeKey,
              claim.turn,
            ),
            'utf8',
          ),
        ),
        completion: JSON.parse(
          fs.readFileSync(
            providerNativeSessionCompletionObjectPathV1(
              locations,
              completion.completionDigest,
            ),
            'utf8',
          ),
        ),
        completionRef: JSON.parse(
          fs.readFileSync(
            providerNativeSessionCompletionRefPathV1(
              locations,
              claim.scope.scopeKey,
              claim.turn,
            ),
            'utf8',
          ),
        ),
        continuationAuthority: null,
        runtimeReceipt: null,
      };
    });

    const authority = assertAgentRuntimeDurableNativeSessionAuthorityV1({
      embeddedClaim: first.claim,
      embeddedCompletionDigest: firstCompletion.completionDigest,
      turns,
    });
    assert.equal(authority.turns.length, 1);
    assert.equal(
      authority.completion.completionDigest,
      firstCompletion.completionDigest,
    );

    const resumeBinding: ProviderWrapperSessionProtocolBinding = {
      invocationId: 'native-invocation-durable-authority-resume',
      requestDigest: crypto
        .createHash('sha256')
        .update('durable-authority-resume')
        .digest('hex'),
      attemptId: 'native-attempt-durable-authority-resume',
      sessionControl: {
        action: 'resume',
        nativeSessionIdentityMode: 'engine-supplied',
        expectedNativeSessionId: nativeSessionId,
      },
    };
    const secondClaim = createProviderNativeSessionClaimV1({
      scope: first.claim.scope,
      turn: 2,
      predecessorCompletion: firstCompletion,
      binding: resumeBinding,
    });
    const secondCompletion = createProviderNativeSessionCompletionV1({
      claim: secondClaim,
      binding: resumeBinding,
      terminal: successfulTerminal(resumeBinding, nativeSessionId),
    }).completion;
    const secondTurn = {
      claim: secondClaim,
      claimRef: createProviderNativeSessionClaimRefV1(secondClaim),
      completion: secondCompletion,
      completionRef:
        createProviderNativeSessionCompletionRefV1(secondCompletion),
      continuationAuthority: null,
      runtimeReceipt: null,
    };
    assert.throws(
      () =>
        assertAgentRuntimeDurableNativeSessionAuthorityV1({
          embeddedClaim: secondClaim,
          embeddedCompletionDigest: secondCompletion.completionDigest,
          turns: [turns[0]!, secondTurn],
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DURABLE_AUTHORITY_INVALID',
    );

    assert.throws(
      () =>
        assertAgentRuntimeDurableNativeSessionAuthorityV1({
          embeddedClaim: first.claim,
          embeddedCompletionDigest: firstCompletion.completionDigest,
          turns: [
            {
              ...turns[0]!,
              completionRef: {
                ...(turns[0]!.completionRef as Record<string, unknown>),
                completionDigest: 'f'.repeat(64),
              },
            },
          ],
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AGENT_RUNTIME_DURABLE_AUTHORITY_INVALID',
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
