import crypto from 'node:crypto';

import {
  assertAgentProviderConfigSnapshot,
  assertProviderWrapperSessionProtocolReceipt,
  assertProviderWrapperSessionProtocolOutcome,
  providerNativeSessionIdDigest,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionProtocolOutcome,
  type ProviderWrapperSessionProtocolReceipt,
} from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentRecordV1,
} from './change-role-assignment-record.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const BINDING_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SESSION_SLOT_ID = /^role-assignment-session-[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_TURN = 10_000;

export type ProviderNativeSessionScopeV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-scope.v1';
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  resolutionDigest: string;
  sessionSlotId: string;
  logicalProviderId: string;
  providerDefinitionDigest: string;
  profileId: string;
  profileDigest: string;
  protocol: 'harness-jsonl-v2';
  providerConfigurationDigest: string;
  providerRegistryDigest: string;
  dataAuthorizationDecisionDigest: string;
  sessionCapabilitySnapshotDigest: string;
  canResume: boolean;
  scopeKey: string;
}>;

export type ProviderNativeSessionClaimV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-claim.v1';
  scope: ProviderNativeSessionScopeV1;
  turn: number;
  action: 'start' | 'resume';
  predecessorCompletionDigest: string | null;
  expectedNativeSessionIdDigest: string | null;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  claimDigest: string;
}>;

export type ProviderNativeSessionDispositionV1 =
  'usable' | 'error' | 'cancelled' | 'timeout' | 'indeterminate';

export type ProviderNativeSessionCompletionV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-completion.v1';
  scope: ProviderNativeSessionScopeV1;
  turn: number;
  claimDigest: string;
  action: 'start' | 'resume';
  predecessorCompletionDigest: string | null;
  expectedNativeSessionIdDigest: string | null;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  disposition: ProviderNativeSessionDispositionV1;
  usable: boolean;
  nativeSessionIdDigest: string | null;
  protocolReceipt: ProviderWrapperSessionProtocolReceipt | null;
  handleDigest: string | null;
  completionDigest: string;
}>;

export type ProviderNativeSessionHandleV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-handle.v1';
  scopeKey: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  profileId: string;
  profileDigest: string;
  providerDefinitionDigest: string;
  turn: number;
  claimDigest: string;
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  handleDigest: string;
}>;

export type ProviderNativeSessionCompletionTerminalV1 =
  | Readonly<{
      kind: 'protocol-outcome';
      outcome: ProviderWrapperSessionProtocolOutcome;
      privateIdentityObservation: ProviderWrapperNativeSessionIdentityObservation | null;
    }>
  | Readonly<{ kind: 'timeout' }>
  | Readonly<{ kind: 'claim-crash' }>;

export type ProviderNativeSessionCompletionMaterializationV1 = Readonly<{
  completion: ProviderNativeSessionCompletionV1;
  handle: ProviderNativeSessionHandleV1 | null;
}>;

export type ProviderNativeTurnBindingInputV1 = Readonly<{
  assignment: Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    assignmentDigest: string;
    resolutionDigest: string;
    dataAuthorizationPolicyDigest: string;
    inputManifestDigest: string;
    relevantTargetDigest: string;
    sessionSlotId: string;
    roleLane: 'author' | 'builder' | 'reviewer';
    logicalProviderId: string;
    profileId: string;
    profileDigest: string;
    providerFamily: string;
    providerDefinitionDigest: string;
  }>;
  invocation: Readonly<{
    ownerWorkflowId: string;
    invocationId: string;
    revision: number;
    state: 'leased';
    providerId: string;
    purpose:
      'survey' | 'plan-review' | 'task-diff-review' | 'task-implementation';
    requestDigest: string;
    inputManifestDigest: string;
    targetDigest: string;
    policyDigest: string;
    repositoryId: string;
    baseCommit: string;
    baseTree: string;
  }>;
  execution: Readonly<{
    workflowId: string;
    workflowEpoch: number;
    workflowContextDigest: string;
    executionRevision: number;
    executionStateDigest: string;
    jobId: string;
    jobStatus: 'queued' | 'running';
    jobRequestDigest: string;
    acceptedAttemptId: string | null;
    acceptanceBindingDigest: string | null;
    attemptId: string;
    attemptNumber: number;
    retryOf: string | null;
    provider: string;
    attemptStatus: 'leased' | 'running';
    attemptInputDigest: string;
    attemptRequestDigest: string;
    attemptContextDigest: string;
    attemptEnvironmentDigest: string;
    leaseGeneration: number;
    leaseWorkerId: string;
    leaseTokenDigest: string;
    leaseAcquiredAt: string;
    leaseExpiresAt: string;
  }>;
}>;

/**
 * Engine-observed current-turn facts. The lease token, workspace path and
 * worker-fence owner token are deliberately absent; only their stable digests
 * can enter public native-turn evidence.
 */
export type ProviderNativeTurnBindingV1 = Readonly<
  ProviderNativeTurnBindingInputV1 & {
    schemaVersion: 1;
    kind: 'provider-native-turn-binding.v1';
    attemptIdentityDigest: string;
    turnBindingDigest: string;
  }
>;

export type ProviderNativeSessionClaimV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-claim.v2';
  scope: ProviderNativeSessionScopeV1;
  turn: number;
  action: 'start';
  predecessorCompletionDigest: string | null;
  turnBinding: ProviderNativeTurnBindingV1;
  claimDigest: string;
}>;

export type ProviderNativeSessionCompletionV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-completion.v2';
  scope: ProviderNativeSessionScopeV1;
  turn: number;
  claimDigest: string;
  action: 'start';
  predecessorCompletionDigest: string | null;
  turnBinding: ProviderNativeTurnBindingV1;
  disposition: ProviderNativeSessionDispositionV1;
  usable: boolean;
  nativeSessionIdDigest: string | null;
  protocolReceipt: ProviderWrapperSessionProtocolReceipt | null;
  handleDigest: string | null;
  completionDigest: string;
}>;

export type ProviderNativeSessionHandleV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-handle.v2';
  scopeKey: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  profileId: string;
  profileDigest: string;
  providerDefinitionDigest: string;
  turn: number;
  claimDigest: string;
  attemptIdentityDigest: string;
  turnBindingDigest: string;
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  handleDigest: string;
}>;

export type ProviderNativeSessionCompletionTerminalV2 =
  ProviderNativeSessionCompletionTerminalV1;

export type ProviderNativeSessionCompletionMaterializationV2 = Readonly<{
  completion: ProviderNativeSessionCompletionV2;
  handle: ProviderNativeSessionHandleV2 | null;
}>;

export type ProviderNativeSessionErrorCode =
  | 'PROVIDER_NATIVE_SESSION_INVALID'
  | 'PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED'
  | 'PROVIDER_NATIVE_SESSION_CALLER_EXISTING_UNSUPPORTED'
  | 'PROVIDER_NATIVE_SESSION_PROTOCOL_UNSUPPORTED'
  | 'PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED';

export class ProviderNativeSessionError extends TypeError {
  readonly code: ProviderNativeSessionErrorCode;

  constructor(code: ProviderNativeSessionErrorCode) {
    super('Provider-native session state is invalid or unsupported.');
    this.name = 'ProviderNativeSessionError';
    this.code = code;
  }
}

export type ProviderNativeSessionAssignmentAuthorityVerifierPort = (
  assignment: ChangeRoleAssignmentRecordV1,
) => void;

/**
 * Freeze the assignment-wide facts for one fresh provider-native session slot.
 * The scope contains only digests and public identifiers; native provider
 * session identity is deliberately absent.
 */
export function deriveProviderNativeSessionScopeV1(
  candidate: ChangeRoleAssignmentRecordV1,
  requestedSessionSlotId: string,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ProviderNativeSessionScopeV1 {
  const assignment = assertChangeRoleAssignmentRecordV1(candidate);
  if (assignment.grantRequirement !== null) {
    if (verifyAssignmentAuthority === undefined) {
      throw new ProviderNativeSessionError(
        'PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED',
      );
    }
    verifyAssignmentAuthority(assignment);
  }
  if (
    typeof requestedSessionSlotId !== 'string' ||
    !SESSION_SLOT_ID.test(requestedSessionSlotId)
  ) {
    throw invalidSession();
  }
  const slot = assignment.sessionSlots.find(
    ({ sessionSlotId }) => sessionSlotId === requestedSessionSlotId,
  );
  if (slot === undefined) throw invalidSession();
  if (slot.sessionMode === 'caller-existing') {
    throw new ProviderNativeSessionError(
      'PROVIDER_NATIVE_SESSION_CALLER_EXISTING_UNSUPPORTED',
    );
  }
  if (slot.sessionMode !== 'fresh') throw invalidSession();

  const selectedProfiles = slot.profiles.filter(
    (
      entry,
    ): entry is typeof entry & { profileId: string; profileDigest: string } =>
      entry.profileId !== null && entry.profileDigest !== null,
  );
  const profileIdentities = new Map(
    selectedProfiles.map((entry) => [
      `${entry.profileId}\u0000${entry.profileDigest}`,
      entry,
    ]),
  );
  if (
    selectedProfiles.length !== slot.roles.length ||
    profileIdentities.size !== 1
  ) {
    throw invalidSession();
  }
  const selected = [...profileIdentities.values()][0]!;
  const configuration = assertAgentProviderConfigSnapshot(
    assignment.host.configuration,
  );
  const profile = configuration.providers.find(
    ({ id }) => id === selected.profileId,
  );
  if (
    profile === undefined ||
    profile.profileDigest !== selected.profileDigest ||
    profile.logicalProviderId !== slot.logicalProviderId
  ) {
    throw invalidSession();
  }
  if (
    profile.trustTier !== 'host-wrapper' ||
    profile.protocol !== 'harness-jsonl-v2'
  ) {
    throw new ProviderNativeSessionError(
      'PROVIDER_NATIVE_SESSION_PROTOCOL_UNSUPPORTED',
    );
  }
  const capability = assignment.sessionCapabilities.snapshot.find(
    ({ profileId }) => profileId === profile.id,
  );
  if (
    capability?.canStartFresh !== true ||
    !profile.capabilities.includes('fresh-session')
  ) {
    throw new ProviderNativeSessionError(
      'PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED',
    );
  }
  const canResume =
    capability.canResume === true &&
    profile.capabilities.includes('resumable-session') &&
    profile.resumeArgs.length > 0;
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-scope.v1' as const,
    changeId: assignment.changeId,
    planningGeneration: assignment.planningGeneration,
    assignmentRecordDigest: assignment.recordDigest,
    resolutionDigest: assignment.resolution.resolutionDigest,
    sessionSlotId: slot.sessionSlotId,
    logicalProviderId: slot.logicalProviderId,
    providerDefinitionDigest: slot.providerDefinitionDigest,
    profileId: profile.id,
    profileDigest: profile.profileDigest,
    protocol: 'harness-jsonl-v2' as const,
    providerConfigurationDigest: configuration.configDigest,
    providerRegistryDigest: assignment.providerRegistry.registryDigest,
    dataAuthorizationDecisionDigest:
      assignment.dataAuthorization.decisionSnapshotDigest,
    sessionCapabilitySnapshotDigest:
      assignment.sessionCapabilities.capabilitySnapshotDigest,
    canResume,
  };
  return deepFreeze({
    ...body,
    scopeKey: sha256(
      `workflow.provider-native-session-scope.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertProviderNativeSessionScopeV1(
  value: unknown,
): ProviderNativeSessionScopeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'resolutionDigest',
      'sessionSlotId',
      'logicalProviderId',
      'providerDefinitionDigest',
      'profileId',
      'profileDigest',
      'protocol',
      'providerConfigurationDigest',
      'providerRegistryDigest',
      'dataAuthorizationDecisionDigest',
      'sessionCapabilitySnapshotDigest',
      'canResume',
      'scopeKey',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-scope.v1' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    value.changeId === 'archive' ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isDigest(value.resolutionDigest) ||
    typeof value.sessionSlotId !== 'string' ||
    !SESSION_SLOT_ID.test(value.sessionSlotId) ||
    !isLogicalProviderId(value.logicalProviderId) ||
    !isDigest(value.providerDefinitionDigest) ||
    !isProfileId(value.profileId) ||
    !isDigest(value.profileDigest) ||
    value.protocol !== 'harness-jsonl-v2' ||
    !isDigest(value.providerConfigurationDigest) ||
    !isDigest(value.providerRegistryDigest) ||
    !isDigest(value.dataAuthorizationDecisionDigest) ||
    !isDigest(value.sessionCapabilitySnapshotDigest) ||
    typeof value.canResume !== 'boolean' ||
    !isDigest(value.scopeKey)
  ) {
    throw invalidSession();
  }
  const body = { ...value };
  delete body.scopeKey;
  if (
    sha256(
      `workflow.provider-native-session-scope.v1\n${canonicalJson(body)}`,
    ) !== value.scopeKey
  ) {
    throw invalidSession();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderNativeSessionScopeV1,
  );
}

/** Create one immutable launch claim. Raw resume identity never enters it. */
export function createProviderNativeSessionClaimV1(
  input: Readonly<{
    scope: ProviderNativeSessionScopeV1;
    turn: number;
    predecessorCompletion: ProviderNativeSessionCompletionV1 | null;
    binding: ProviderWrapperSessionProtocolBinding;
  }>,
): ProviderNativeSessionClaimV1 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['scope', 'turn', 'predecessorCompletion', 'binding'])
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(input.scope);
  const turn = assertTurn(input.turn);
  const binding = assertBinding(input.binding);
  let predecessorCompletionDigest: string | null;
  let expectedNativeSessionIdDigest: string | null;

  if (turn === 1) {
    if (
      input.predecessorCompletion !== null ||
      binding.sessionControl.action !== 'start' ||
      binding.sessionControl.nativeSessionIdentityMode !==
        'provider-observed' ||
      binding.sessionControl.expectedNativeSessionId !== null
    ) {
      throw invalidSession();
    }
    predecessorCompletionDigest = null;
    expectedNativeSessionIdDigest = null;
  } else {
    if (!scope.canResume) {
      throw new ProviderNativeSessionError(
        'PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED',
      );
    }
    const predecessor = assertProviderNativeSessionCompletionV1(
      input.predecessorCompletion,
    );
    if (
      predecessor.scope.scopeKey !== scope.scopeKey ||
      predecessor.turn !== turn - 1 ||
      predecessor.disposition !== 'usable' ||
      predecessor.usable !== true ||
      predecessor.nativeSessionIdDigest === null ||
      predecessor.handleDigest === null ||
      binding.sessionControl.action !== 'resume' ||
      binding.sessionControl.nativeSessionIdentityMode !== 'engine-supplied' ||
      providerNativeSessionIdDigest(
        binding.sessionControl.expectedNativeSessionId,
      ) !== predecessor.nativeSessionIdDigest
    ) {
      throw invalidSession();
    }
    predecessorCompletionDigest = predecessor.completionDigest;
    expectedNativeSessionIdDigest = predecessor.nativeSessionIdDigest;
  }

  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-claim.v1' as const,
    scope,
    turn,
    action: binding.sessionControl.action,
    predecessorCompletionDigest,
    expectedNativeSessionIdDigest,
    invocationId: binding.invocationId,
    requestDigest: binding.requestDigest,
    attemptId: binding.attemptId,
  };
  return deepFreeze({
    ...body,
    claimDigest: sha256(
      `workflow.provider-native-session-claim.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertProviderNativeSessionClaimV1(
  value: unknown,
): ProviderNativeSessionClaimV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scope',
      'turn',
      'action',
      'predecessorCompletionDigest',
      'expectedNativeSessionIdDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
      'claimDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-claim.v1' ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    (value.action !== 'start' && value.action !== 'resume') ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    !isNullableDigest(value.expectedNativeSessionIdDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !isDigest(value.claimDigest)
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(value.scope);
  if (
    (value.turn === 1 &&
      (value.action !== 'start' ||
        value.predecessorCompletionDigest !== null ||
        value.expectedNativeSessionIdDigest !== null)) ||
    (value.turn !== 1 &&
      (value.action !== 'resume' ||
        value.predecessorCompletionDigest === null ||
        value.expectedNativeSessionIdDigest === null ||
        !scope.canResume))
  ) {
    throw invalidSession();
  }
  const { claimDigest, ...unboundBody } =
    value as unknown as ProviderNativeSessionClaimV1;
  const body = { ...unboundBody, scope };
  if (
    sha256(
      `workflow.provider-native-session-claim.v1\n${canonicalJson(body)}`,
    ) !== claimDigest
  ) {
    throw invalidSession();
  }
  return deepFreeze({
    ...(body as Omit<ProviderNativeSessionClaimV1, 'claimDigest'>),
    claimDigest,
  });
}

/**
 * Materialize one public terminal receipt and, only on success, one private
 * handle carrying the raw native session identifier.
 */
export function createProviderNativeSessionCompletionV1(
  input: Readonly<{
    claim: ProviderNativeSessionClaimV1;
    binding: ProviderWrapperSessionProtocolBinding;
    terminal: ProviderNativeSessionCompletionTerminalV1;
  }>,
): ProviderNativeSessionCompletionMaterializationV1 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['claim', 'binding', 'terminal'])
  ) {
    throw invalidSession();
  }
  const claim = assertProviderNativeSessionClaimV1(input.claim);
  const binding = assertBinding(input.binding);
  assertBindingMatchesClaim(binding, claim);
  if (!isRecord(input.terminal) || typeof input.terminal.kind !== 'string') {
    throw invalidSession();
  }

  let disposition: ProviderNativeSessionDispositionV1;
  let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null = null;
  let nativeSessionId: string | null = null;
  let nativeSessionIdDigestValue: string | null = null;
  if (input.terminal.kind === 'protocol-outcome') {
    if (
      !hasExactKeys(input.terminal, [
        'kind',
        'outcome',
        'privateIdentityObservation',
      ])
    ) {
      throw invalidSession();
    }
    let outcome: ProviderWrapperSessionProtocolOutcome;
    try {
      outcome = assertProviderWrapperSessionProtocolOutcome(
        input.terminal.outcome,
        binding,
      );
    } catch {
      throw invalidSession();
    }
    protocolReceipt = outcome.receipt;
    nativeSessionIdDigestValue = outcome.receipt.observedNativeSessionIdDigest;
    disposition =
      outcome.receipt.terminal === 'result'
        ? 'usable'
        : outcome.receipt.terminal === 'error'
          ? 'error'
          : 'cancelled';
    if (disposition === 'usable') {
      const identity = assertPrivateIdentityObservation(
        input.terminal.privateIdentityObservation,
        outcome.receipt,
        binding,
      );
      nativeSessionId = identity.nativeSessionId;
      if (nativeSessionIdDigestValue === null) throw invalidSession();
    } else if (input.terminal.privateIdentityObservation !== null) {
      throw invalidSession();
    }
  } else if (input.terminal.kind === 'timeout') {
    if (!hasExactKeys(input.terminal, ['kind'])) throw invalidSession();
    disposition = 'timeout';
  } else if (input.terminal.kind === 'claim-crash') {
    if (!hasExactKeys(input.terminal, ['kind'])) throw invalidSession();
    disposition = 'indeterminate';
  } else {
    throw invalidSession();
  }

  const usable = disposition === 'usable';
  const handle = usable
    ? createHandle(claim, nativeSessionId!, nativeSessionIdDigestValue!)
    : null;
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-completion.v1' as const,
    scope: claim.scope,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
    action: claim.action,
    predecessorCompletionDigest: claim.predecessorCompletionDigest,
    expectedNativeSessionIdDigest: claim.expectedNativeSessionIdDigest,
    invocationId: claim.invocationId,
    requestDigest: claim.requestDigest,
    attemptId: claim.attemptId,
    disposition,
    usable,
    nativeSessionIdDigest: nativeSessionIdDigestValue,
    protocolReceipt,
    handleDigest: handle?.handleDigest ?? null,
  };
  const completion = deepFreeze({
    ...body,
    completionDigest: sha256(
      `workflow.provider-native-session-completion.v1\n${canonicalJson(body)}`,
    ),
  });
  return deepFreeze({ completion, handle });
}

export function assertProviderNativeSessionCompletionV1(
  value: unknown,
): ProviderNativeSessionCompletionV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scope',
      'turn',
      'claimDigest',
      'action',
      'predecessorCompletionDigest',
      'expectedNativeSessionIdDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
      'disposition',
      'usable',
      'nativeSessionIdDigest',
      'protocolReceipt',
      'handleDigest',
      'completionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-completion.v1' ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    !isDigest(value.claimDigest) ||
    (value.action !== 'start' && value.action !== 'resume') ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    !isNullableDigest(value.expectedNativeSessionIdDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !['usable', 'error', 'cancelled', 'timeout', 'indeterminate'].includes(
      String(value.disposition),
    ) ||
    typeof value.usable !== 'boolean' ||
    !isNullableDigest(value.nativeSessionIdDigest) ||
    !isNullableDigest(value.handleDigest) ||
    !isDigest(value.completionDigest)
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(value.scope);
  let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null;
  if (value.protocolReceipt === null) {
    protocolReceipt = null;
  } else {
    try {
      protocolReceipt = assertProtocolReceiptWithoutRawBinding(
        value.protocolReceipt,
        value,
      );
    } catch {
      throw invalidSession();
    }
  }
  if (
    (value.disposition === 'usable' &&
      (value.usable !== true ||
        value.nativeSessionIdDigest === null ||
        value.handleDigest === null ||
        protocolReceipt?.terminal !== 'result')) ||
    (value.disposition !== 'usable' &&
      (value.usable !== false || value.handleDigest !== null)) ||
    ((value.disposition === 'timeout' ||
      value.disposition === 'indeterminate') &&
      (protocolReceipt !== null || value.nativeSessionIdDigest !== null)) ||
    (value.disposition === 'error' && protocolReceipt?.terminal !== 'error') ||
    (value.disposition === 'cancelled' &&
      protocolReceipt?.terminal !== 'cancelled') ||
    (value.action === 'start' &&
      (value.turn !== 1 ||
        value.predecessorCompletionDigest !== null ||
        value.expectedNativeSessionIdDigest !== null)) ||
    (value.action === 'resume' &&
      ((value.turn as number) < 2 ||
        value.predecessorCompletionDigest === null ||
        value.expectedNativeSessionIdDigest === null ||
        !scope.canResume))
  ) {
    throw invalidSession();
  }
  const { completionDigest, ...unboundBody } =
    value as unknown as ProviderNativeSessionCompletionV1;
  const body = { ...unboundBody, scope, protocolReceipt };
  if (
    sha256(
      `workflow.provider-native-session-completion.v1\n${canonicalJson(body)}`,
    ) !== completionDigest
  ) {
    throw invalidSession();
  }
  return deepFreeze({
    ...(body as Omit<ProviderNativeSessionCompletionV1, 'completionDigest'>),
    completionDigest,
  });
}

export function assertProviderNativeSessionHandleV1(
  value: unknown,
  expected?: Readonly<{
    completion?: ProviderNativeSessionCompletionV1;
    handleDigest?: string;
  }>,
): ProviderNativeSessionHandleV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'assignmentRecordDigest',
      'sessionSlotId',
      'profileId',
      'profileDigest',
      'providerDefinitionDigest',
      'turn',
      'claimDigest',
      'nativeSessionId',
      'nativeSessionIdDigest',
      'handleDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-handle.v1' ||
    !isDigest(value.scopeKey) ||
    !isDigest(value.assignmentRecordDigest) ||
    typeof value.sessionSlotId !== 'string' ||
    !SESSION_SLOT_ID.test(value.sessionSlotId) ||
    !isProfileId(value.profileId) ||
    !isDigest(value.profileDigest) ||
    !isDigest(value.providerDefinitionDigest) ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    !isDigest(value.claimDigest) ||
    typeof value.nativeSessionId !== 'string' ||
    !isDigest(value.nativeSessionIdDigest) ||
    !isDigest(value.handleDigest)
  ) {
    throw invalidSession();
  }
  let observedDigest: string;
  try {
    observedDigest = providerNativeSessionIdDigest(value.nativeSessionId);
  } catch {
    throw invalidSession();
  }
  const body = { ...value };
  delete body.handleDigest;
  if (
    observedDigest !== value.nativeSessionIdDigest ||
    sha256(
      `workflow.provider-native-session-handle.v1\n${canonicalJson(body)}`,
    ) !== value.handleDigest ||
    (expected?.handleDigest !== undefined &&
      expected.handleDigest !== value.handleDigest)
  ) {
    throw invalidSession();
  }
  if (expected?.completion !== undefined) {
    const completion = assertProviderNativeSessionCompletionV1(
      expected.completion,
    );
    if (
      completion.usable !== true ||
      completion.handleDigest !== value.handleDigest ||
      completion.nativeSessionIdDigest !== value.nativeSessionIdDigest ||
      completion.scope.scopeKey !== value.scopeKey ||
      completion.scope.assignmentRecordDigest !==
        value.assignmentRecordDigest ||
      completion.scope.sessionSlotId !== value.sessionSlotId ||
      completion.scope.profileId !== value.profileId ||
      completion.scope.profileDigest !== value.profileDigest ||
      completion.scope.providerDefinitionDigest !==
        value.providerDefinitionDigest ||
      completion.turn !== value.turn ||
      completion.claimDigest !== value.claimDigest
    ) {
      throw invalidSession();
    }
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderNativeSessionHandleV1,
  );
}

/**
 * Canonicalize the facts observed by the engine-owned Attempt currentness
 * adapter. `executionStateDigest` is the qualified SHA-256 digest of the
 * canonical landed `DurableExecutionJobState`; the remaining execution fields
 * are its exact Workflow/Job/Attempt projection, including the current lease
 * token digest and any accepted-result identity. The raw lease token is used
 * only by the currentness port and never enters this binding. This pure codec
 * does not establish currentness or authority by itself.
 */
export function createProviderNativeTurnBindingV1(
  candidate: ProviderNativeTurnBindingInputV1,
): ProviderNativeTurnBindingV1 {
  const input = assertProviderNativeTurnBindingInputV1(candidate);
  const attemptIdentityDigest = sha256(
    `workflow.provider-native-turn-attempt-identity.v1\n${canonicalJson({
      workflowId: input.execution.workflowId,
      workflowEpoch: input.execution.workflowEpoch,
      jobId: input.execution.jobId,
      attemptId: input.execution.attemptId,
    })}`,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-turn-binding.v1' as const,
    ...input,
    attemptIdentityDigest,
  };
  return assertProviderNativeTurnBindingV1({
    ...body,
    turnBindingDigest: sha256(
      `workflow.provider-native-turn-binding.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertProviderNativeTurnBindingV1(
  value: unknown,
): ProviderNativeTurnBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'assignment',
      'invocation',
      'execution',
      'attemptIdentityDigest',
      'turnBindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-turn-binding.v1' ||
    !isDigest(value.attemptIdentityDigest) ||
    !isDigest(value.turnBindingDigest)
  ) {
    throw invalidSession();
  }
  const input = assertProviderNativeTurnBindingInputV1({
    assignment: value.assignment,
    invocation: value.invocation,
    execution: value.execution,
  });
  const expectedAttemptIdentityDigest = sha256(
    `workflow.provider-native-turn-attempt-identity.v1\n${canonicalJson({
      workflowId: input.execution.workflowId,
      workflowEpoch: input.execution.workflowEpoch,
      jobId: input.execution.jobId,
      attemptId: input.execution.attemptId,
    })}`,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-turn-binding.v1' as const,
    ...input,
    attemptIdentityDigest: value.attemptIdentityDigest,
  };
  if (
    value.attemptIdentityDigest !== expectedAttemptIdentityDigest ||
    value.turnBindingDigest !==
      sha256(`workflow.provider-native-turn-binding.v1\n${canonicalJson(body)}`)
  ) {
    throw invalidSession();
  }
  return deepFreeze({
    ...body,
    turnBindingDigest: value.turnBindingDigest,
  });
}

/**
 * A completion may observe a later execution revision/status, but it must
 * remain under the exact same Attempt and lease/worker fence observed for the
 * claim. Snapshot digests are therefore fresh while stable semantic and fence
 * facts are byte-identical.
 */
export function assertProviderNativeTurnBindingContinuationV1(
  claimedValue: unknown,
  currentValue: unknown,
): ProviderNativeTurnBindingV1 {
  const claimed = assertProviderNativeTurnBindingV1(claimedValue);
  const current = assertProviderNativeTurnBindingV1(currentValue);
  const claimedStableExecution = {
    ...claimed.execution,
    executionRevision: 0,
    executionStateDigest: `sha256:${'0'.repeat(64)}`,
    jobStatus: 'queued' as const,
    attemptStatus: 'leased' as const,
  };
  const currentStableExecution = {
    ...current.execution,
    executionRevision: 0,
    executionStateDigest: `sha256:${'0'.repeat(64)}`,
    jobStatus: 'queued' as const,
    attemptStatus: 'leased' as const,
  };
  const claimedStableInvocation = { ...claimed.invocation, revision: 0 };
  const currentStableInvocation = { ...current.invocation, revision: 0 };
  if (
    current.attemptIdentityDigest !== claimed.attemptIdentityDigest ||
    canonicalJson(current.assignment) !== canonicalJson(claimed.assignment) ||
    canonicalJson(currentStableInvocation) !==
      canonicalJson(claimedStableInvocation) ||
    canonicalJson(currentStableExecution) !==
      canonicalJson(claimedStableExecution) ||
    current.invocation.revision < claimed.invocation.revision ||
    current.execution.executionRevision < claimed.execution.executionRevision ||
    (current.execution.executionRevision ===
      claimed.execution.executionRevision &&
      canonicalJson(current.execution) !== canonicalJson(claimed.execution)) ||
    (claimed.execution.jobStatus === 'running' &&
      current.execution.jobStatus !== 'running') ||
    (claimed.execution.attemptStatus === 'running' &&
      current.execution.attemptStatus !== 'running')
  ) {
    throw invalidSession();
  }
  return current;
}

/**
 * Pure, non-authorizing materializer for immutable V2 evidence. Durable use
 * must pass through the store's engine-owned currentness verifier port.
 */
export function createProviderNativeSessionClaimV2(
  input: Readonly<{
    scope: ProviderNativeSessionScopeV1;
    turn: number;
    predecessorCompletion: ProviderNativeSessionCompletionV2 | null;
    turnBinding: ProviderNativeTurnBindingV1;
  }>,
): ProviderNativeSessionClaimV2 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'scope',
      'turn',
      'predecessorCompletion',
      'turnBinding',
    ])
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(input.scope);
  const turn = assertTurn(input.turn);
  const turnBinding = assertProviderNativeTurnBindingV1(input.turnBinding);
  assertProviderNativeTurnBindingMatchesScope(turnBinding, scope);
  // V2 binds one fresh native start to one current Attempt. Cross-turn native
  // continuity/resume is intentionally deferred to the later protocol slice.
  if (turn !== 1 || input.predecessorCompletion !== null) {
    throw invalidSession();
  }
  const predecessorCompletionDigest = null;
  const body = {
    schemaVersion: 2 as const,
    kind: 'provider-native-session-claim.v2' as const,
    scope,
    turn,
    action: 'start' as const,
    predecessorCompletionDigest,
    turnBinding,
  };
  return deepFreeze({
    ...body,
    claimDigest: sha256(
      `workflow.provider-native-session-claim.v2\n${canonicalJson(body)}`,
    ),
  });
}

export function assertProviderNativeSessionClaimV2(
  value: unknown,
): ProviderNativeSessionClaimV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scope',
      'turn',
      'action',
      'predecessorCompletionDigest',
      'turnBinding',
      'claimDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-claim.v2' ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    value.action !== 'start' ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    !isDigest(value.claimDigest) ||
    value.turn !== 1 ||
    value.predecessorCompletionDigest !== null
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(value.scope);
  const turnBinding = assertProviderNativeTurnBindingV1(value.turnBinding);
  assertProviderNativeTurnBindingMatchesScope(turnBinding, scope);
  const { claimDigest, ...unbound } =
    value as unknown as ProviderNativeSessionClaimV2;
  const body = { ...unbound, scope, turnBinding };
  if (
    claimDigest !==
    sha256(`workflow.provider-native-session-claim.v2\n${canonicalJson(body)}`)
  ) {
    throw invalidSession();
  }
  return deepFreeze({
    ...(body as Omit<ProviderNativeSessionClaimV2, 'claimDigest'>),
    claimDigest,
  });
}

export function providerNativeSessionProtocolBindingV2(
  candidate: ProviderNativeSessionClaimV2,
): ProviderWrapperSessionProtocolBinding {
  const claim = assertProviderNativeSessionClaimV2(candidate);
  return deepFreeze({
    invocationId: claim.turnBinding.invocation.invocationId,
    requestDigest: claim.turnBinding.invocation.requestDigest,
    attemptId: claim.turnBinding.execution.attemptId,
    sessionControl: {
      action: 'start' as const,
      nativeSessionIdentityMode: 'provider-observed' as const,
      expectedNativeSessionId: null,
    },
  });
}

/**
 * Pure, non-authorizing materializer. Callers cannot use it in place of the
 * store's fresh completion-time currentness observation.
 */
export function createProviderNativeSessionCompletionV2(
  input: Readonly<{
    claim: ProviderNativeSessionClaimV2;
    currentTurnBinding: ProviderNativeTurnBindingV1;
    terminal: ProviderNativeSessionCompletionTerminalV2;
  }>,
): ProviderNativeSessionCompletionMaterializationV2 {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['claim', 'currentTurnBinding', 'terminal'])
  ) {
    throw invalidSession();
  }
  const claim = assertProviderNativeSessionClaimV2(input.claim);
  const currentTurnBinding = assertProviderNativeTurnBindingContinuationV1(
    claim.turnBinding,
    input.currentTurnBinding,
  );
  // The process protocol remains bound to the claim-time request/Attempt even
  // when the fresh durable snapshot revision advances.
  const claimBinding = providerNativeSessionProtocolBindingV2(claim);
  if (!isRecord(input.terminal) || typeof input.terminal.kind !== 'string') {
    throw invalidSession();
  }

  let disposition: ProviderNativeSessionDispositionV1;
  let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null = null;
  let nativeSessionId: string | null = null;
  let nativeSessionIdDigestValue: string | null = null;
  if (input.terminal.kind === 'protocol-outcome') {
    if (
      !hasExactKeys(input.terminal, [
        'kind',
        'outcome',
        'privateIdentityObservation',
      ])
    ) {
      throw invalidSession();
    }
    let outcome: ProviderWrapperSessionProtocolOutcome;
    try {
      outcome = assertProviderWrapperSessionProtocolOutcome(
        input.terminal.outcome,
        claimBinding,
      );
    } catch {
      throw invalidSession();
    }
    protocolReceipt = outcome.receipt;
    nativeSessionIdDigestValue = outcome.receipt.observedNativeSessionIdDigest;
    disposition =
      outcome.receipt.terminal === 'result'
        ? 'usable'
        : outcome.receipt.terminal === 'error'
          ? 'error'
          : 'cancelled';
    if (disposition === 'usable') {
      const identity = assertPrivateIdentityObservation(
        input.terminal.privateIdentityObservation,
        outcome.receipt,
        claimBinding,
      );
      nativeSessionId = identity.nativeSessionId;
      if (nativeSessionIdDigestValue === null) throw invalidSession();
    } else if (input.terminal.privateIdentityObservation !== null) {
      throw invalidSession();
    }
  } else if (input.terminal.kind === 'timeout') {
    if (!hasExactKeys(input.terminal, ['kind'])) throw invalidSession();
    disposition = 'timeout';
  } else if (input.terminal.kind === 'claim-crash') {
    if (!hasExactKeys(input.terminal, ['kind'])) throw invalidSession();
    disposition = 'indeterminate';
  } else {
    throw invalidSession();
  }

  const usable = disposition === 'usable';
  const handle = usable
    ? createHandleV2(
        claim,
        currentTurnBinding,
        nativeSessionId!,
        nativeSessionIdDigestValue!,
      )
    : null;
  const body = {
    schemaVersion: 2 as const,
    kind: 'provider-native-session-completion.v2' as const,
    scope: claim.scope,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
    action: 'start' as const,
    predecessorCompletionDigest: claim.predecessorCompletionDigest,
    turnBinding: currentTurnBinding,
    disposition,
    usable,
    nativeSessionIdDigest: nativeSessionIdDigestValue,
    protocolReceipt,
    handleDigest: handle?.handleDigest ?? null,
  };
  const completion = deepFreeze({
    ...body,
    completionDigest: sha256(
      `workflow.provider-native-session-completion.v2\n${canonicalJson(body)}`,
    ),
  });
  return deepFreeze({ completion, handle });
}

export function assertProviderNativeSessionCompletionV2(
  value: unknown,
): ProviderNativeSessionCompletionV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scope',
      'turn',
      'claimDigest',
      'action',
      'predecessorCompletionDigest',
      'turnBinding',
      'disposition',
      'usable',
      'nativeSessionIdDigest',
      'protocolReceipt',
      'handleDigest',
      'completionDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-completion.v2' ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    !isDigest(value.claimDigest) ||
    value.action !== 'start' ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    value.turn !== 1 ||
    value.predecessorCompletionDigest !== null ||
    !['usable', 'error', 'cancelled', 'timeout', 'indeterminate'].includes(
      String(value.disposition),
    ) ||
    typeof value.usable !== 'boolean' ||
    !isNullableDigest(value.nativeSessionIdDigest) ||
    !isNullableDigest(value.handleDigest) ||
    !isDigest(value.completionDigest)
  ) {
    throw invalidSession();
  }
  const scope = assertProviderNativeSessionScopeV1(value.scope);
  const turnBinding = assertProviderNativeTurnBindingV1(value.turnBinding);
  assertProviderNativeTurnBindingMatchesScope(turnBinding, scope);
  const protocolBinding = deepFreeze({
    invocationId: turnBinding.invocation.invocationId,
    requestDigest: turnBinding.invocation.requestDigest,
    attemptId: turnBinding.execution.attemptId,
    sessionControl: {
      action: 'start' as const,
      nativeSessionIdentityMode: 'provider-observed' as const,
      expectedNativeSessionId: null,
    },
  });
  let protocolReceipt: ProviderWrapperSessionProtocolReceipt | null;
  if (value.protocolReceipt === null) {
    protocolReceipt = null;
  } else {
    try {
      protocolReceipt = assertProviderWrapperSessionProtocolReceipt(
        value.protocolReceipt,
      );
    } catch {
      throw invalidSession();
    }
    if (
      protocolReceipt.invocationId !== protocolBinding.invocationId ||
      protocolReceipt.requestDigest !== protocolBinding.requestDigest ||
      protocolReceipt.attemptId !== protocolBinding.attemptId ||
      protocolReceipt.sessionAction !== 'start' ||
      protocolReceipt.expectedNativeSessionIdDigest !== null ||
      protocolReceipt.observedNativeSessionIdDigest !==
        value.nativeSessionIdDigest
    ) {
      throw invalidSession();
    }
  }
  if (
    (value.disposition === 'usable' &&
      (value.usable !== true ||
        value.nativeSessionIdDigest === null ||
        value.handleDigest === null ||
        protocolReceipt?.terminal !== 'result')) ||
    (value.disposition !== 'usable' &&
      (value.usable !== false || value.handleDigest !== null)) ||
    ((value.disposition === 'timeout' ||
      value.disposition === 'indeterminate') &&
      (protocolReceipt !== null || value.nativeSessionIdDigest !== null)) ||
    (value.disposition === 'error' && protocolReceipt?.terminal !== 'error') ||
    (value.disposition === 'cancelled' &&
      protocolReceipt?.terminal !== 'cancelled')
  ) {
    throw invalidSession();
  }
  const { completionDigest, ...unbound } =
    value as unknown as ProviderNativeSessionCompletionV2;
  const body = { ...unbound, scope, turnBinding, protocolReceipt };
  if (
    completionDigest !==
    sha256(
      `workflow.provider-native-session-completion.v2\n${canonicalJson(body)}`,
    )
  ) {
    throw invalidSession();
  }
  return deepFreeze({
    ...(body as Omit<ProviderNativeSessionCompletionV2, 'completionDigest'>),
    completionDigest,
  });
}

export function assertProviderNativeSessionHandleV2(
  value: unknown,
  expected?: Readonly<{
    completion?: ProviderNativeSessionCompletionV2;
    handleDigest?: string;
  }>,
): ProviderNativeSessionHandleV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'assignmentRecordDigest',
      'sessionSlotId',
      'profileId',
      'profileDigest',
      'providerDefinitionDigest',
      'turn',
      'claimDigest',
      'attemptIdentityDigest',
      'turnBindingDigest',
      'nativeSessionId',
      'nativeSessionIdDigest',
      'handleDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-handle.v2' ||
    !isDigest(value.scopeKey) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotIdValue(value.sessionSlotId) ||
    !isProfileId(value.profileId) ||
    !isDigest(value.profileDigest) ||
    !isDigest(value.providerDefinitionDigest) ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 1 ||
    (value.turn as number) > MAX_TURN ||
    !isDigest(value.claimDigest) ||
    !isDigest(value.attemptIdentityDigest) ||
    !isDigest(value.turnBindingDigest) ||
    typeof value.nativeSessionId !== 'string' ||
    !isDigest(value.nativeSessionIdDigest) ||
    !isDigest(value.handleDigest)
  ) {
    throw invalidSession();
  }
  let observedDigest: string;
  try {
    observedDigest = providerNativeSessionIdDigest(value.nativeSessionId);
  } catch {
    throw invalidSession();
  }
  const body = { ...value };
  delete body.handleDigest;
  if (
    observedDigest !== value.nativeSessionIdDigest ||
    value.handleDigest !==
      sha256(
        `workflow.provider-native-session-handle.v2\n${canonicalJson(body)}`,
      ) ||
    (expected?.handleDigest !== undefined &&
      expected.handleDigest !== value.handleDigest)
  ) {
    throw invalidSession();
  }
  if (expected?.completion !== undefined) {
    const completion = assertProviderNativeSessionCompletionV2(
      expected.completion,
    );
    if (
      completion.usable !== true ||
      completion.handleDigest !== value.handleDigest ||
      completion.nativeSessionIdDigest !== value.nativeSessionIdDigest ||
      completion.scope.scopeKey !== value.scopeKey ||
      completion.scope.assignmentRecordDigest !==
        value.assignmentRecordDigest ||
      completion.scope.sessionSlotId !== value.sessionSlotId ||
      completion.scope.profileId !== value.profileId ||
      completion.scope.profileDigest !== value.profileDigest ||
      completion.scope.providerDefinitionDigest !==
        value.providerDefinitionDigest ||
      completion.turn !== value.turn ||
      completion.claimDigest !== value.claimDigest ||
      completion.turnBinding.attemptIdentityDigest !==
        value.attemptIdentityDigest ||
      completion.turnBinding.turnBindingDigest !== value.turnBindingDigest
    ) {
      throw invalidSession();
    }
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderNativeSessionHandleV2,
  );
}

function createHandleV2(
  claim: ProviderNativeSessionClaimV2,
  currentTurnBinding: ProviderNativeTurnBindingV1,
  nativeSessionId: string,
  nativeSessionIdDigestValue: string,
): ProviderNativeSessionHandleV2 {
  let recomputed: string;
  try {
    recomputed = providerNativeSessionIdDigest(nativeSessionId);
  } catch {
    throw invalidSession();
  }
  if (recomputed !== nativeSessionIdDigestValue) throw invalidSession();
  const body = {
    schemaVersion: 2 as const,
    kind: 'provider-native-session-handle.v2' as const,
    scopeKey: claim.scope.scopeKey,
    assignmentRecordDigest: claim.scope.assignmentRecordDigest,
    sessionSlotId: claim.scope.sessionSlotId,
    profileId: claim.scope.profileId,
    profileDigest: claim.scope.profileDigest,
    providerDefinitionDigest: claim.scope.providerDefinitionDigest,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
    attemptIdentityDigest: currentTurnBinding.attemptIdentityDigest,
    turnBindingDigest: currentTurnBinding.turnBindingDigest,
    nativeSessionId,
    nativeSessionIdDigest: nativeSessionIdDigestValue,
  };
  return deepFreeze({
    ...body,
    handleDigest: sha256(
      `workflow.provider-native-session-handle.v2\n${canonicalJson(body)}`,
    ),
  });
}

function assertProviderNativeTurnBindingInputV1(
  value: unknown,
): ProviderNativeTurnBindingInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['assignment', 'invocation', 'execution']) ||
    !isRecord(value.assignment) ||
    !hasExactKeys(value.assignment, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'assignmentDigest',
      'resolutionDigest',
      'dataAuthorizationPolicyDigest',
      'inputManifestDigest',
      'relevantTargetDigest',
      'sessionSlotId',
      'roleLane',
      'logicalProviderId',
      'profileId',
      'profileDigest',
      'providerFamily',
      'providerDefinitionDigest',
    ]) ||
    typeof value.assignment.changeId !== 'string' ||
    !CHANGE_ID.test(value.assignment.changeId) ||
    value.assignment.changeId === 'archive' ||
    !isDigest(value.assignment.planningGeneration) ||
    !isDigest(value.assignment.assignmentRecordDigest) ||
    !isDigest(value.assignment.assignmentDigest) ||
    !isDigest(value.assignment.resolutionDigest) ||
    !isDigest(value.assignment.dataAuthorizationPolicyDigest) ||
    !isDigest(value.assignment.inputManifestDigest) ||
    !isDigest(value.assignment.relevantTargetDigest) ||
    !isSessionSlotIdValue(value.assignment.sessionSlotId) ||
    !['author', 'builder', 'reviewer'].includes(
      String(value.assignment.roleLane),
    ) ||
    !isLogicalProviderId(value.assignment.logicalProviderId) ||
    !isProfileId(value.assignment.profileId) ||
    !isDigest(value.assignment.profileDigest) ||
    !isProviderFamily(value.assignment.providerFamily) ||
    !isDigest(value.assignment.providerDefinitionDigest) ||
    !isRecord(value.invocation) ||
    !hasExactKeys(value.invocation, [
      'ownerWorkflowId',
      'invocationId',
      'revision',
      'state',
      'providerId',
      'purpose',
      'requestDigest',
      'inputManifestDigest',
      'targetDigest',
      'policyDigest',
      'repositoryId',
      'baseCommit',
      'baseTree',
    ]) ||
    !isBindingIdentifier(value.invocation.ownerWorkflowId) ||
    !isBindingIdentifier(value.invocation.invocationId) ||
    !Number.isSafeInteger(value.invocation.revision) ||
    (value.invocation.revision as number) < 0 ||
    value.invocation.state !== 'leased' ||
    !isBindingIdentifier(value.invocation.providerId) ||
    !isCapabilityPurpose(value.invocation.purpose) ||
    !isDigest(value.invocation.requestDigest) ||
    !isDigest(value.invocation.inputManifestDigest) ||
    !isDigest(value.invocation.targetDigest) ||
    !isDigest(value.invocation.policyDigest) ||
    !isBoundedRepositoryId(value.invocation.repositoryId) ||
    typeof value.invocation.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.invocation.baseCommit) ||
    typeof value.invocation.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.invocation.baseTree) ||
    !isRecord(value.execution) ||
    !hasExactKeys(value.execution, [
      'workflowId',
      'workflowEpoch',
      'workflowContextDigest',
      'executionRevision',
      'executionStateDigest',
      'jobId',
      'jobStatus',
      'jobRequestDigest',
      'acceptedAttemptId',
      'acceptanceBindingDigest',
      'attemptId',
      'attemptNumber',
      'retryOf',
      'provider',
      'attemptStatus',
      'attemptInputDigest',
      'attemptRequestDigest',
      'attemptContextDigest',
      'attemptEnvironmentDigest',
      'leaseGeneration',
      'leaseWorkerId',
      'leaseTokenDigest',
      'leaseAcquiredAt',
      'leaseExpiresAt',
    ]) ||
    !isBindingIdentifier(value.execution.workflowId) ||
    !isPositiveInteger(value.execution.workflowEpoch) ||
    !isQualifiedDigest(value.execution.workflowContextDigest) ||
    !isNonnegativeInteger(value.execution.executionRevision) ||
    !isQualifiedDigest(value.execution.executionStateDigest) ||
    !isBindingIdentifier(value.execution.jobId) ||
    value.execution.jobStatus !== 'running' ||
    !isQualifiedDigest(value.execution.jobRequestDigest) ||
    value.execution.acceptedAttemptId !== null ||
    value.execution.acceptanceBindingDigest !== null ||
    !isBindingIdentifier(value.execution.attemptId) ||
    !isPositiveInteger(value.execution.attemptNumber) ||
    !isNullableBindingIdentifier(value.execution.retryOf) ||
    !isBindingIdentifier(value.execution.provider) ||
    !['leased', 'running'].includes(String(value.execution.attemptStatus)) ||
    !isQualifiedDigest(value.execution.attemptInputDigest) ||
    !isQualifiedDigest(value.execution.attemptRequestDigest) ||
    !isQualifiedDigest(value.execution.attemptContextDigest) ||
    !isQualifiedDigest(value.execution.attemptEnvironmentDigest) ||
    !isPositiveInteger(value.execution.leaseGeneration) ||
    !isBindingIdentifier(value.execution.leaseWorkerId) ||
    !isQualifiedDigest(value.execution.leaseTokenDigest) ||
    !isExactTimestamp(value.execution.leaseAcquiredAt) ||
    !isExactTimestamp(value.execution.leaseExpiresAt) ||
    Date.parse(value.execution.leaseAcquiredAt) >=
      Date.parse(value.execution.leaseExpiresAt) ||
    value.invocation.ownerWorkflowId !== value.execution.workflowId ||
    value.assignment.providerFamily !== value.invocation.providerId ||
    value.assignment.providerFamily !== value.execution.provider ||
    value.invocation.providerId !== value.execution.provider ||
    value.assignment.dataAuthorizationPolicyDigest !==
      value.invocation.policyDigest ||
    value.assignment.inputManifestDigest !==
      value.invocation.inputManifestDigest ||
    value.assignment.relevantTargetDigest !== value.invocation.targetDigest ||
    !isAllowedNativeTurnRolePurpose(
      value.assignment.roleLane,
      value.invocation.purpose,
    ) ||
    value.execution.workflowContextDigest !==
      value.execution.attemptContextDigest ||
    value.execution.attemptInputDigest !==
      `sha256:${value.invocation.inputManifestDigest}` ||
    value.execution.attemptRequestDigest !==
      `sha256:${value.invocation.requestDigest}`
  ) {
    throw invalidSession();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderNativeTurnBindingInputV1,
  );
}

function isCapabilityPurpose(
  value: unknown,
): value is ProviderNativeTurnBindingInputV1['invocation']['purpose'] {
  return (
    value === 'survey' ||
    value === 'plan-review' ||
    value === 'task-diff-review' ||
    value === 'task-implementation'
  );
}

function isAllowedNativeTurnRolePurpose(
  roleLane: unknown,
  purpose: unknown,
): boolean {
  if (roleLane === 'builder') return purpose === 'task-implementation';
  if (roleLane === 'reviewer') {
    return purpose === 'plan-review' || purpose === 'task-diff-review';
  }
  return false;
}

function isProviderFamily(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/u.test(value)
  );
}

function isBoundedRepositoryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !value.includes('\u0000')
  );
}

function assertProviderNativeTurnBindingMatchesScope(
  binding: ProviderNativeTurnBindingV1,
  scope: ProviderNativeSessionScopeV1,
): void {
  if (
    binding.assignment.changeId !== scope.changeId ||
    binding.assignment.planningGeneration !== scope.planningGeneration ||
    binding.assignment.assignmentRecordDigest !==
      scope.assignmentRecordDigest ||
    binding.assignment.resolutionDigest !== scope.resolutionDigest ||
    binding.assignment.sessionSlotId !== scope.sessionSlotId ||
    binding.assignment.logicalProviderId !== scope.logicalProviderId ||
    binding.assignment.profileId !== scope.profileId ||
    binding.assignment.profileDigest !== scope.profileDigest ||
    binding.assignment.providerDefinitionDigest !==
      scope.providerDefinitionDigest
  ) {
    throw invalidSession();
  }
}

function createHandle(
  claim: ProviderNativeSessionClaimV1,
  nativeSessionId: string,
  nativeSessionIdDigestValue: string,
): ProviderNativeSessionHandleV1 {
  let recomputed: string;
  try {
    recomputed = providerNativeSessionIdDigest(nativeSessionId);
  } catch {
    throw invalidSession();
  }
  if (recomputed !== nativeSessionIdDigestValue) throw invalidSession();
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-handle.v1' as const,
    scopeKey: claim.scope.scopeKey,
    assignmentRecordDigest: claim.scope.assignmentRecordDigest,
    sessionSlotId: claim.scope.sessionSlotId,
    profileId: claim.scope.profileId,
    profileDigest: claim.scope.profileDigest,
    providerDefinitionDigest: claim.scope.providerDefinitionDigest,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
    nativeSessionId,
    nativeSessionIdDigest: nativeSessionIdDigestValue,
  };
  return deepFreeze({
    ...body,
    handleDigest: sha256(
      `workflow.provider-native-session-handle.v1\n${canonicalJson(body)}`,
    ),
  });
}

function assertPrivateIdentityObservation(
  value: unknown,
  receipt: ProviderWrapperSessionProtocolReceipt,
  binding: ProviderWrapperSessionProtocolBinding,
): ProviderWrapperNativeSessionIdentityObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'protocol',
      'invocationId',
      'requestDigest',
      'attemptId',
      'sessionAction',
      'nativeSessionId',
      'nativeSessionIdDigest',
      'protocolReceiptDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-wrapper-native-session-identity-observation' ||
    value.protocol !== 'harness-jsonl-v2' ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    (value.sessionAction !== 'start' && value.sessionAction !== 'resume') ||
    typeof value.nativeSessionId !== 'string' ||
    !isDigest(value.nativeSessionIdDigest) ||
    !isDigest(value.protocolReceiptDigest)
  ) {
    throw invalidSession();
  }
  let observedDigest: string;
  try {
    observedDigest = providerNativeSessionIdDigest(value.nativeSessionId);
  } catch {
    throw invalidSession();
  }
  if (
    receipt.terminal !== 'result' ||
    receipt.sessionFrameCount !== 1 ||
    receipt.observedNativeSessionIdDigest === null ||
    observedDigest !== value.nativeSessionIdDigest ||
    value.nativeSessionIdDigest !== receipt.observedNativeSessionIdDigest ||
    value.protocolReceiptDigest !== receipt.receiptDigest ||
    value.invocationId !== binding.invocationId ||
    value.requestDigest !== binding.requestDigest ||
    value.attemptId !== binding.attemptId ||
    value.sessionAction !== binding.sessionControl.action ||
    (binding.sessionControl.nativeSessionIdentityMode === 'engine-supplied' &&
      value.nativeSessionId !== binding.sessionControl.expectedNativeSessionId)
  ) {
    throw invalidSession();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as ProviderWrapperNativeSessionIdentityObservation,
  );
}

function assertProtocolReceiptWithoutRawBinding(
  value: unknown,
  completion: Record<string, unknown>,
): ProviderWrapperSessionProtocolReceipt {
  const receipt = assertProviderWrapperSessionProtocolReceipt(value);
  if (
    receipt.invocationId !== completion.invocationId ||
    receipt.requestDigest !== completion.requestDigest ||
    receipt.attemptId !== completion.attemptId ||
    receipt.sessionAction !== completion.action ||
    receipt.expectedNativeSessionIdDigest !==
      completion.expectedNativeSessionIdDigest ||
    receipt.observedNativeSessionIdDigest !== completion.nativeSessionIdDigest
  ) {
    throw invalidSession();
  }
  return receipt;
}

function assertBindingMatchesClaim(
  binding: ProviderWrapperSessionProtocolBinding,
  claim: ProviderNativeSessionClaimV1,
): void {
  const expectedDigest =
    binding.sessionControl.expectedNativeSessionId === null
      ? null
      : providerNativeSessionIdDigest(
          binding.sessionControl.expectedNativeSessionId,
        );
  if (
    binding.invocationId !== claim.invocationId ||
    binding.requestDigest !== claim.requestDigest ||
    binding.attemptId !== claim.attemptId ||
    binding.sessionControl.action !== claim.action ||
    expectedDigest !== claim.expectedNativeSessionIdDigest ||
    (claim.action === 'start' &&
      binding.sessionControl.nativeSessionIdentityMode !==
        'provider-observed') ||
    (claim.action === 'resume' &&
      binding.sessionControl.nativeSessionIdentityMode !== 'engine-supplied')
  ) {
    throw invalidSession();
  }
}

function assertBinding(value: unknown): ProviderWrapperSessionProtocolBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'invocationId',
      'requestDigest',
      'attemptId',
      'sessionControl',
    ]) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !isRecord(value.sessionControl)
  ) {
    throw invalidSession();
  }
  const control = value.sessionControl;
  if (
    !hasExactKeys(control, [
      'action',
      'nativeSessionIdentityMode',
      'expectedNativeSessionId',
    ]) ||
    (control.action !== 'start' && control.action !== 'resume') ||
    (control.nativeSessionIdentityMode !== 'engine-supplied' &&
      control.nativeSessionIdentityMode !== 'provider-observed') ||
    (control.nativeSessionIdentityMode === 'provider-observed' &&
      (control.action !== 'start' ||
        control.expectedNativeSessionId !== null)) ||
    (control.nativeSessionIdentityMode === 'engine-supplied' &&
      typeof control.expectedNativeSessionId !== 'string')
  ) {
    throw invalidSession();
  }
  if (typeof control.expectedNativeSessionId === 'string') {
    try {
      providerNativeSessionIdDigest(control.expectedNativeSessionId);
    } catch {
      throw invalidSession();
    }
  }
  return deepFreeze(
    structuredClone(value) as unknown as ProviderWrapperSessionProtocolBinding,
  );
}

function assertTurn(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_TURN
  ) {
    throw invalidSession();
  }
  return value as number;
}

function invalidSession(): ProviderNativeSessionError {
  return new ProviderNativeSessionError('PROVIDER_NATIVE_SESSION_INVALID');
}

function isBindingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && BINDING_IDENTIFIER.test(value);
}

function isNullableBindingIdentifier(value: unknown): value is string | null {
  return value === null || isBindingIdentifier(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isExactTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSessionSlotIdValue(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SLOT_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isQualifiedDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isLogicalProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u.test(value)
  );
}

function isProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
