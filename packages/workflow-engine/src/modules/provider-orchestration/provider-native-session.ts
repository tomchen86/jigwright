/**
 * Defines native provider session scopes, claims, completions, and
 * continuation handles.
 *
 * Invariants:
 * - Assignments requiring a Grant need authority verification before
 *   session scope derivation.
 */
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
  'usable' | 'rejected' | 'error' | 'cancelled' | 'timeout' | 'indeterminate';

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
    if (outcome.receipt.terminal === 'result') {
      if (nativeSessionIdDigestValue === null) throw invalidSession();
      if (input.terminal.privateIdentityObservation === null) {
        disposition = 'rejected';
      } else {
        disposition = 'usable';
        const identity = assertPrivateIdentityObservation(
          input.terminal.privateIdentityObservation,
          outcome.receipt,
          binding,
        );
        nativeSessionId = identity.nativeSessionId;
      }
    } else {
      disposition =
        outcome.receipt.terminal === 'error' ? 'error' : 'cancelled';
      if (input.terminal.privateIdentityObservation !== null) {
        throw invalidSession();
      }
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
    ![
      'usable',
      'rejected',
      'error',
      'cancelled',
      'timeout',
      'indeterminate',
    ].includes(String(value.disposition)) ||
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
    (value.disposition === 'rejected' &&
      (protocolReceipt?.terminal !== 'result' ||
        value.nativeSessionIdDigest === null)) ||
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

function isSessionSlotIdValue(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SLOT_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
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
