import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { AgentRuntimeCompletionReceiptV4 } from './agent-runtime-port.ts';
import {
  assertAgentRuntimeAssignmentBindingV1,
  createAgentRuntimeAssignmentBindingV1,
  type AgentRuntimeAssignmentBindingV1,
} from './agent-runtime-assignment-binding.ts';
import {
  assertChangeRoleAssignmentRecordV1,
  type ChangeRoleAssignmentRecordV1,
} from './change-role-assignment-record.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import {
  assertProviderNativeSessionClaimV1,
  assertProviderNativeSessionCompletionV1,
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionV1,
} from './provider-native-session.ts';
import { assertAgentRuntimeCompletionReceipt } from './provider-runtime-evidence.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ROLE_BY_PURPOSE = Object.freeze({
  survey: 'author',
  'plan-review': 'reviewer',
  'task-diff-review': 'reviewer',
  'task-implementation': 'builder',
} as const);

export type AgentRuntimeDurableAuthorityInvalidFactory = () => Error;

export type AgentRuntimeAssignmentRequestFactsV1 = Readonly<{
  purpose: ProviderInvocationRequest['purpose'];
  providerId: string;
  inputManifestDigest: string;
  targetDigest: string;
}>;

export type ChangeRoleAssignmentRefV1 = Readonly<{
  schemaVersion: 1;
  kind: 'change-role-assignment-ref.v1';
  changeId: string;
  planningGeneration: string;
  recordDigest: string;
}>;

export type ProviderNativeSessionClaimRefV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-claim-ref.v1';
  scopeKey: string;
  turn: number;
  claimDigest: string;
}>;

export type ProviderNativeSessionCompletionRefV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-completion-ref.v1';
  scopeKey: string;
  turn: number;
  claimDigest: string;
  completionDigest: string;
}>;

/**
 * Separate, create-only authority for reusing one otherwise usable native
 * completion. The native completion publisher cannot manufacture this fact;
 * it is derived only after the outer invocation commits exact success.
 */
export type ProviderNativeSessionContinuationAuthorityV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-continuation-authority.v1';
  scopeKey: string;
  turn: number;
  claimDigest: string;
  completionDigest: string;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  runtimeReceiptDigest: string;
  terminalRevision: number;
  terminalState: 'succeeded';
  terminalDisposition: 'accepted';
  failureCode: null;
  protocolReceiptDigest: string;
  authorityDigest: string;
}>;

export type ParsedProviderNativeSessionTurnAuthorityV1 = Readonly<{
  claim: unknown;
  claimRef: unknown;
  completion: unknown;
  completionRef: unknown;
  continuationAuthority: unknown | null;
  runtimeReceipt: unknown | null;
}>;

export type DurableProviderNativeSessionTurnAuthorityV1 = Readonly<{
  claim: ProviderNativeSessionClaimV1;
  claimRef: ProviderNativeSessionClaimRefV1;
  completion: ProviderNativeSessionCompletionV1;
  completionRef: ProviderNativeSessionCompletionRefV1;
  continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  runtimeReceipt: AgentRuntimeCompletionReceiptV4 | null;
}>;

export type AgentRuntimeDurableNativeSessionAuthorityV1 = Readonly<{
  claim: ProviderNativeSessionClaimV1;
  completion: ProviderNativeSessionCompletionV1;
  turns: readonly DurableProviderNativeSessionTurnAuthorityV1[];
}>;

export class AgentRuntimeDurableAuthorityError extends TypeError {
  readonly code = 'AGENT_RUNTIME_DURABLE_AUTHORITY_INVALID';

  constructor() {
    super('Agent Runtime durable authority is invalid.');
    this.name = 'AgentRuntimeDurableAuthorityError';
  }
}

/** Reproject the only launch binding admitted by one parsed current record. */
export function projectAgentRuntimeAssignmentBindingV1(
  candidate: ChangeRoleAssignmentRecordV1,
  request: AgentRuntimeAssignmentRequestFactsV1,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): AgentRuntimeAssignmentBindingV1 {
  const record = parseAssignmentRecord(candidate, invalid);
  if (
    !isRecord(request) ||
    !Object.hasOwn(ROLE_BY_PURPOSE, request.purpose) ||
    typeof request.providerId !== 'string' ||
    request.providerId.length === 0 ||
    !isDigest(request.inputManifestDigest) ||
    !isDigest(request.targetDigest)
  ) {
    throw invalid();
  }
  const role = ROLE_BY_PURPOSE[request.purpose];
  const placement = record.resolution.placements.find(
    (candidatePlacement) => candidatePlacement.role === role,
  );
  const slot = record.sessionSlots.find((candidateSlot) =>
    candidateSlot.roles.includes(role),
  );
  const profile = record.host.configuration.providers.find(
    (candidateProfile) => candidateProfile.id === placement?.profileId,
  );
  if (
    placement === undefined ||
    slot === undefined ||
    profile === undefined ||
    profile.family !== request.providerId ||
    placement.logicalProviderId !== slot.logicalProviderId ||
    slot.sessionMode !== 'fresh'
  ) {
    throw invalid();
  }
  try {
    return createAgentRuntimeAssignmentBindingV1({
      schemaVersion: 1,
      kind: 'agent-runtime-assignment-binding.v1',
      changeId: record.changeId,
      planningGeneration: record.planningGeneration,
      recordDigest: record.recordDigest,
      assignmentDigest: record.assignmentDigest,
      role,
      logicalProviderId: placement.logicalProviderId,
      providerProfileId: profile.id,
      providerProfileSnapshot: profile,
      definitionDigest: slot.providerDefinitionDigest,
      dataAuthorizationPolicyDigest:
        record.dataAuthorization.snapshot.policyDigest,
      assignmentManifestDigest:
        record.dataAuthorization.snapshot.inputManifestDigest!,
      inputManifestDigest: request.inputManifestDigest,
      targetDigest: request.targetDigest,
    });
  } catch {
    throw invalid();
  }
}

/** Compare an embedded runtime binding with the exact durable reprojection. */
export function assertAgentRuntimeDurableAssignmentAuthorityV1(
  value: unknown,
  record: ChangeRoleAssignmentRecordV1,
  request: AgentRuntimeAssignmentRequestFactsV1,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): AgentRuntimeAssignmentBindingV1 {
  const binding = parseAssignmentBinding(value, invalid);
  const expected = projectAgentRuntimeAssignmentBindingV1(
    record,
    request,
    invalid,
  );
  if (canonicalJson(binding) !== canonicalJson(expected)) throw invalid();
  return binding;
}

export function createChangeRoleAssignmentRefV1(
  value: ChangeRoleAssignmentRecordV1,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ChangeRoleAssignmentRefV1 {
  const record = parseAssignmentRecord(value, invalid);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-ref.v1',
    changeId: record.changeId,
    planningGeneration: record.planningGeneration,
    recordDigest: record.recordDigest,
  });
}

export function assertChangeRoleAssignmentRefV1(
  value: unknown,
  changeId: string,
  planningGeneration: string,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ChangeRoleAssignmentRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'planningGeneration',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'change-role-assignment-ref.v1' ||
    value.changeId !== changeId ||
    value.planningGeneration !== planningGeneration ||
    !isChangeId(changeId) ||
    !isDigest(planningGeneration) ||
    !isDigest(value.recordDigest)
  ) {
    throw invalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-ref.v1',
    changeId,
    planningGeneration,
    recordDigest: value.recordDigest,
  });
}

export function createProviderNativeSessionClaimRefV1(
  value: ProviderNativeSessionClaimV1,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionClaimRefV1 {
  const claim = parseNativeClaim(value, invalid);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-claim-ref.v1',
    scopeKey: claim.scope.scopeKey,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
  });
}

export function assertProviderNativeSessionClaimRefV1(
  value: unknown,
  scopeKey: string,
  turn: number,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionClaimRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-claim-ref.v1' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    !isDigest(scopeKey) ||
    !isTurn(turn) ||
    !isDigest(value.claimDigest)
  ) {
    throw invalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-claim-ref.v1',
    scopeKey,
    turn,
    claimDigest: value.claimDigest,
  });
}

export function createProviderNativeSessionCompletionRefV1(
  value: ProviderNativeSessionCompletionV1,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionCompletionRefV1 {
  const completion = parseNativeCompletion(value, invalid);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-completion-ref.v1',
    scopeKey: completion.scope.scopeKey,
    turn: completion.turn,
    claimDigest: completion.claimDigest,
    completionDigest: completion.completionDigest,
  });
}

export function assertProviderNativeSessionCompletionRefV1(
  value: unknown,
  scopeKey: string,
  turn: number,
  claimDigest: string,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionCompletionRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
      'completionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-completion-ref.v1' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    value.claimDigest !== claimDigest ||
    !isDigest(scopeKey) ||
    !isTurn(turn) ||
    !isDigest(claimDigest) ||
    !isDigest(value.completionDigest)
  ) {
    throw invalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-completion-ref.v1',
    scopeKey,
    turn,
    claimDigest,
    completionDigest: value.completionDigest,
  });
}

export function createProviderNativeSessionContinuationAuthorityV1(
  completionValue: ProviderNativeSessionCompletionV1,
  runtimeReceiptValue: AgentRuntimeCompletionReceiptV4,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionContinuationAuthorityV1 {
  const completion = parseNativeCompletion(completionValue, invalid);
  const runtimeReceipt = parseRuntimeReceipt(runtimeReceiptValue, invalid);
  const hostBinding = runtimeReceipt.hostExecutionBinding;
  const nativeClaim = hostBinding?.nativeSessionClaim ?? null;
  if (
    completion.usable !== true ||
    completion.disposition !== 'usable' ||
    completion.handleDigest === null ||
    completion.protocolReceipt?.terminal !== 'result' ||
    runtimeReceipt.terminalState !== 'succeeded' ||
    runtimeReceipt.terminalDisposition !== 'accepted' ||
    runtimeReceipt.failureCode !== null ||
    runtimeReceipt.protocolReceipt === null ||
    runtimeReceipt.protocolReceipt.terminal !== 'result' ||
    hostBinding?.phase !== 'native-terminal' ||
    nativeClaim === null ||
    hostBinding.nativeSessionCompletionDigest !== completion.completionDigest ||
    !completionMatchesClaim(completion, nativeClaim) ||
    runtimeReceipt.invocationId !== completion.invocationId ||
    runtimeReceipt.requestDigest !== completion.requestDigest ||
    runtimeReceipt.executionAttemptId !== completion.attemptId ||
    canonicalJson(runtimeReceipt.protocolReceipt) !==
      canonicalJson(completion.protocolReceipt)
  ) {
    throw invalid();
  }
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
    runtimeReceiptDigest: runtimeReceipt.receiptDigest,
    terminalRevision: runtimeReceipt.terminalRevision,
    terminalState: runtimeReceipt.terminalState,
    terminalDisposition: runtimeReceipt.terminalDisposition,
    failureCode: runtimeReceipt.failureCode,
    protocolReceiptDigest: completion.protocolReceipt.receiptDigest,
  };
  return deepFreeze({
    ...body,
    authorityDigest: sha256(
      `workflow.provider-native-session-continuation-authority.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertProviderNativeSessionContinuationAuthorityV1(
  value: unknown,
  completionValue: ProviderNativeSessionCompletionV1,
  runtimeReceiptValue: AgentRuntimeCompletionReceiptV4,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionContinuationAuthorityV1 {
  const authority = assertProviderNativeSessionContinuationAuthorityEnvelopeV1(
    value,
    invalid,
  );
  const completion = parseNativeCompletion(completionValue, invalid);
  const expected = createProviderNativeSessionContinuationAuthorityV1(
    completion,
    runtimeReceiptValue,
    invalid,
  );
  if (canonicalJson(authority) !== canonicalJson(expected)) throw invalid();
  return expected;
}

export function assertProviderNativeSessionContinuationAuthorityEnvelopeV1(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): ProviderNativeSessionContinuationAuthorityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
      'completionDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
      'runtimeReceiptDigest',
      'terminalRevision',
      'terminalState',
      'terminalDisposition',
      'failureCode',
      'protocolReceiptDigest',
      'authorityDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-continuation-authority.v1' ||
    !isDigest(value.scopeKey) ||
    !isTurn(value.turn) ||
    !isDigest(value.claimDigest) ||
    !isDigest(value.completionDigest) ||
    typeof value.invocationId !== 'string' ||
    value.invocationId.length === 0 ||
    !isDigest(value.requestDigest) ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.length === 0 ||
    !isDigest(value.runtimeReceiptDigest) ||
    !isRevision(value.terminalRevision) ||
    value.terminalState !== 'succeeded' ||
    value.terminalDisposition !== 'accepted' ||
    value.failureCode !== null ||
    !isDigest(value.protocolReceiptDigest) ||
    !isDigest(value.authorityDigest)
  ) {
    throw invalid();
  }
  const { authorityDigest, ...body } =
    value as unknown as ProviderNativeSessionContinuationAuthorityV1;
  if (
    sha256(
      `workflow.provider-native-session-continuation-authority.v1\n${canonicalJson(body)}`,
    ) !== authorityDigest
  ) {
    throw invalid();
  }
  return deepFreeze(
    structuredClone(value) as ProviderNativeSessionContinuationAuthorityV1,
  );
}

/**
 * Re-admit a terminal embedded claim/completion through the exact parsed
 * content-addressed objects and every predecessor ref in its durable chain.
 * This function performs no filesystem I/O.
 */
export function assertAgentRuntimeDurableNativeSessionAuthorityV1(
  input: Readonly<{
    embeddedClaim: unknown;
    embeddedCompletionDigest: string;
    turns: readonly ParsedProviderNativeSessionTurnAuthorityV1[];
  }>,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory = durableAuthorityInvalid,
): AgentRuntimeDurableNativeSessionAuthorityV1 {
  if (
    !isRecord(input) ||
    !Array.isArray(input.turns) ||
    !isDigest(input.embeddedCompletionDigest)
  ) {
    throw invalid();
  }
  const embeddedClaim = parseNativeClaim(input.embeddedClaim, invalid);
  if (input.turns.length !== embeddedClaim.turn || input.turns.length === 0) {
    throw invalid();
  }

  const turns: DurableProviderNativeSessionTurnAuthorityV1[] = [];
  let predecessor: DurableProviderNativeSessionTurnAuthorityV1 | null = null;
  for (const [index, value] of input.turns.entries()) {
    if (!isRecord(value)) throw invalid();
    const claim = parseNativeClaim(value.claim, invalid);
    const claimRef = assertProviderNativeSessionClaimRefV1(
      value.claimRef,
      embeddedClaim.scope.scopeKey,
      index + 1,
      invalid,
    );
    const completion = parseNativeCompletion(value.completion, invalid);
    const completionRef = assertProviderNativeSessionCompletionRefV1(
      value.completionRef,
      embeddedClaim.scope.scopeKey,
      index + 1,
      claim.claimDigest,
      invalid,
    );
    if (
      (value.continuationAuthority === null) !==
      (value.runtimeReceipt === null)
    ) {
      throw invalid();
    }
    const runtimeReceipt =
      value.runtimeReceipt === null
        ? null
        : parseRuntimeReceipt(value.runtimeReceipt, invalid);
    const continuationAuthority =
      value.continuationAuthority === null || runtimeReceipt === null
        ? null
        : assertProviderNativeSessionContinuationAuthorityV1(
            value.continuationAuthority,
            completion,
            runtimeReceipt,
            invalid,
          );
    if (
      claim.turn !== index + 1 ||
      canonicalJson(claim.scope) !== canonicalJson(embeddedClaim.scope) ||
      claimRef.claimDigest !== claim.claimDigest ||
      completionRef.completionDigest !== completion.completionDigest ||
      !completionMatchesClaim(completion, claim)
    ) {
      throw invalid();
    }
    if (predecessor === null) {
      if (
        claim.turn !== 1 ||
        claim.action !== 'start' ||
        claim.predecessorCompletionDigest !== null ||
        claim.expectedNativeSessionIdDigest !== null
      ) {
        throw invalid();
      }
    } else if (
      predecessor.completion.usable !== true ||
      predecessor.continuationAuthority === null ||
      predecessor.runtimeReceipt === null ||
      claim.action !== 'resume' ||
      claim.predecessorCompletionDigest !==
        predecessor.completion.completionDigest ||
      claim.expectedNativeSessionIdDigest !==
        predecessor.completion.nativeSessionIdDigest
    ) {
      throw invalid();
    }
    const durableTurn = Object.freeze({
      claim,
      claimRef,
      completion,
      completionRef,
      continuationAuthority,
      runtimeReceipt,
    });
    turns.push(durableTurn);
    predecessor = durableTurn;
  }

  const terminal = turns.at(-1)!;
  if (
    canonicalJson(terminal.claim) !== canonicalJson(embeddedClaim) ||
    terminal.completion.completionDigest !== input.embeddedCompletionDigest
  ) {
    throw invalid();
  }
  return deepFreeze({
    claim: terminal.claim,
    completion: terminal.completion,
    turns,
  });
}

function completionMatchesClaim(
  completion: ProviderNativeSessionCompletionV1,
  claim: ProviderNativeSessionClaimV1,
): boolean {
  return (
    canonicalJson(completion.scope) === canonicalJson(claim.scope) &&
    completion.turn === claim.turn &&
    completion.claimDigest === claim.claimDigest &&
    completion.action === claim.action &&
    completion.predecessorCompletionDigest ===
      claim.predecessorCompletionDigest &&
    completion.expectedNativeSessionIdDigest ===
      claim.expectedNativeSessionIdDigest &&
    completion.invocationId === claim.invocationId &&
    completion.requestDigest === claim.requestDigest &&
    completion.attemptId === claim.attemptId
  );
}

function parseAssignmentRecord(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory,
): ChangeRoleAssignmentRecordV1 {
  try {
    return assertChangeRoleAssignmentRecordV1(value);
  } catch {
    throw invalid();
  }
}

function parseAssignmentBinding(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory,
): AgentRuntimeAssignmentBindingV1 {
  try {
    return assertAgentRuntimeAssignmentBindingV1(value);
  } catch {
    throw invalid();
  }
}

function parseNativeClaim(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory,
): ProviderNativeSessionClaimV1 {
  try {
    return assertProviderNativeSessionClaimV1(value);
  } catch {
    throw invalid();
  }
}

function parseNativeCompletion(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory,
): ProviderNativeSessionCompletionV1 {
  try {
    return assertProviderNativeSessionCompletionV1(value);
  } catch {
    throw invalid();
  }
}

function parseRuntimeReceipt(
  value: unknown,
  invalid: AgentRuntimeDurableAuthorityInvalidFactory,
): AgentRuntimeCompletionReceiptV4 {
  let receipt;
  try {
    receipt = assertAgentRuntimeCompletionReceipt(value, invalid);
  } catch {
    throw invalid();
  }
  if (receipt.schemaVersion !== 4) throw invalid();
  return receipt;
}

function durableAuthorityInvalid(): AgentRuntimeDurableAuthorityError {
  return new AgentRuntimeDurableAuthorityError();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isChangeId(value: unknown): value is string {
  return (
    typeof value === 'string' && CHANGE_ID.test(value) && value !== 'archive'
  );
}

function isTurn(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 10_000
  );
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
