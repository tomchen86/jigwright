/**
 * Validates native session inputs and constructs immutable turn bindings and references.
 *
 * Invariants:
 * - Input keys, digest identity, and reference error codes remain exact.
 * - Chain state distinguishes usable completion from authorized continuation.
 */
import type { ProviderWrapperSessionProtocolBinding } from '@jigwright/core/harness-jsonl-v2-contracts';
import {
  type ProviderNativeSessionContinuationAuthorityV1,
  type ProviderNativeSessionClaimRefV1,
  createProviderNativeSessionClaimRefV1 as createDurableClaimRef,
  type ProviderNativeSessionCompletionRefV1,
  createProviderNativeSessionCompletionRefV1 as createDurableCompletionRef,
  assertProviderNativeSessionClaimRefV1 as assertDurableClaimRef,
  assertProviderNativeSessionCompletionRefV1 as assertDurableCompletionRef,
} from '../../modules/provider-orchestration/agent-runtime-durable-authority.ts';
import type {
  ProviderNativeSessionClaimV1,
  ProviderNativeSessionCompletionTerminalV1,
  ProviderNativeSessionCompletionV1,
  ProviderNativeSessionScopeV1,
  ProviderNativeSessionHandleV1,
} from '../../modules/provider-orchestration/provider-native-session.ts';
import {
  deepFreeze,
  storeInvalid,
  isRecord,
  hasExactKeys,
} from './provider-native-session-values.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const DIGEST = /^[0-9a-f]{64}$/u;

const SESSION_SLOT_ID = /^role-assignment-session-[0-9a-f]{64}$/u;

const BINDING_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;

export const TURN_REF = /^(\d{5})\.(claim|completion)-ref\.json$/u;

export const MAX_TURN = 10_000;

export const MAX_OBJECT_BYTES = 512 * 1024;

export const MAX_HANDLE_BYTES = 8 * 1024;

export const MAX_CONTINUATION_AUTHORITY_BYTES = 8 * 1024;

export const MAX_REF_BYTES = 2 * 1024;

export type ClaimProviderNativeSessionTurnInputV1 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  predecessorCompletionDigest: string | null;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
}>;

export type ClaimProviderNativeSessionTurnResultV1 = Readonly<{
  outcome: 'claimed' | 'already-claimed';
  claim: ProviderNativeSessionClaimV1;
  binding: ProviderWrapperSessionProtocolBinding | null;
}>;

export type CompleteProviderNativeSessionTurnInputV1 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  claimDigest: string;
  terminal: ProviderNativeSessionCompletionTerminalV1;
}>;

export type RecoverProviderNativeSessionTurnInputV1 = Readonly<{
  scopeKey: string;
  sessionSlotId: string;
  claimDigest: string;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  expectedProtocolReceiptDigest: string | null;
}>;

export type RecoverProviderNativeSessionTurnResultV1 = Readonly<{
  outcome: 'unchanged' | 'abandoned';
  completion: ProviderNativeSessionCompletionV1;
}>;

export type PublishProviderNativeSessionContinuationAuthorityInputV1 =
  Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    sessionSlotId: string;
    completionDigest: string;
  }>;

export type ProviderNativeSessionChainV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-chain.v1';
  scope: ProviderNativeSessionScopeV1;
  state:
    | 'empty'
    | 'claimed'
    | 'continuation-pending'
    | 'resumable'
    | 'terminal-unusable';
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
    continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  }>[];
}>;

export function createStartBinding(
  input: Pick<
    ClaimProviderNativeSessionTurnInputV1 | ProviderNativeSessionClaimV1,
    'invocationId' | 'requestDigest' | 'attemptId'
  >,
): ProviderWrapperSessionProtocolBinding {
  return deepFreeze({
    invocationId: input.invocationId,
    requestDigest: input.requestDigest,
    attemptId: input.attemptId,
    sessionControl: {
      action: 'start' as const,
      nativeSessionIdentityMode: 'provider-observed' as const,
      expectedNativeSessionId: null,
    },
  });
}

export function createResumeBinding(
  input: Pick<
    ClaimProviderNativeSessionTurnInputV1 | ProviderNativeSessionClaimV1,
    'invocationId' | 'requestDigest' | 'attemptId'
  >,
  handle: ProviderNativeSessionHandleV1,
): ProviderWrapperSessionProtocolBinding {
  return deepFreeze({
    invocationId: input.invocationId,
    requestDigest: input.requestDigest,
    attemptId: input.attemptId,
    sessionControl: {
      action: 'resume' as const,
      nativeSessionIdentityMode: 'engine-supplied' as const,
      expectedNativeSessionId: handle.nativeSessionId,
    },
  });
}

export function createChain(
  scope: ProviderNativeSessionScopeV1,
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
    continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  }>[],
): ProviderNativeSessionChainV1 {
  const lastTurn = turns.at(-1);
  const last = lastTurn?.completion;
  const state =
    turns.length === 0
      ? ('empty' as const)
      : last === undefined || last === null
        ? ('claimed' as const)
        : last.usable
          ? lastTurn!.continuationAuthority === null
            ? ('continuation-pending' as const)
            : ('resumable' as const)
          : ('terminal-unusable' as const);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-native-session-chain.v1' as const,
    scope,
    state,
    turns: turns.map(({ claim, completion, continuationAuthority }) => ({
      claim,
      completion,
      continuationAuthority,
    })),
  });
}

export function createClaimRef(
  claim: ProviderNativeSessionClaimV1,
): ProviderNativeSessionClaimRefV1 {
  return createDurableClaimRef(claim, storeInvalid);
}

export function createCompletionRef(
  completion: ProviderNativeSessionCompletionV1,
): ProviderNativeSessionCompletionRefV1 {
  return createDurableCompletionRef(completion, storeInvalid);
}

export function assertClaimRef(
  value: unknown,
  scopeKey: string,
  turn: number,
): ProviderNativeSessionClaimRefV1 {
  return assertDurableClaimRef(value, scopeKey, turn, storeInvalid);
}

export function assertCompletionRef(
  value: unknown,
  scopeKey: string,
  turn: number,
  claimDigest: string,
): ProviderNativeSessionCompletionRefV1 {
  return assertDurableCompletionRef(
    value,
    scopeKey,
    turn,
    claimDigest,
    storeInvalid,
  );
}

export function assertClaimInput(
  value: unknown,
): ClaimProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'predecessorCompletionDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ClaimProviderNativeSessionTurnInputV1,
  );
}

export function assertCompletionInput(
  value: unknown,
): CompleteProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'claimDigest',
      'terminal',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.claimDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as CompleteProviderNativeSessionTurnInputV1,
  );
}

export function assertRecoveryInput(
  value: unknown,
): RecoverProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'scopeKey',
      'sessionSlotId',
      'claimDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
      'expectedProtocolReceiptDigest',
    ]) ||
    !isDigest(value.scopeKey) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.claimDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !isNullableDigest(value.expectedProtocolReceiptDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as RecoverProviderNativeSessionTurnInputV1,
  );
}

export function assertContinuationAuthorityInput(
  value: unknown,
): PublishProviderNativeSessionContinuationAuthorityInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'completionDigest',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.completionDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as PublishProviderNativeSessionContinuationAuthorityInputV1,
  );
}

export function assertChainIdentity(value: unknown): Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    assignmentRecordDigest: value.assignmentRecordDigest,
    sessionSlotId: value.sessionSlotId,
  });
}

export function claimMatchesInput(
  claim: ProviderNativeSessionClaimV1,
  input: ClaimProviderNativeSessionTurnInputV1,
): boolean {
  return (
    claim.predecessorCompletionDigest === input.predecessorCompletionDigest &&
    claim.invocationId === input.invocationId &&
    claim.requestDigest === input.requestDigest &&
    claim.attemptId === input.attemptId
  );
}

export function claimMatchesRecoveryInput(
  claim: ProviderNativeSessionClaimV1,
  input: RecoverProviderNativeSessionTurnInputV1,
): boolean {
  return (
    claim.scope.scopeKey === input.scopeKey &&
    claim.scope.sessionSlotId === input.sessionSlotId &&
    claim.claimDigest === input.claimDigest &&
    claim.invocationId === input.invocationId &&
    claim.requestDigest === input.requestDigest &&
    claim.attemptId === input.attemptId
  );
}

export function assertDigest(value: unknown): string {
  if (!isDigest(value)) throw storeInvalid();
  return value;
}

function isChangeId(value: unknown): value is string {
  return (
    typeof value === 'string' && CHANGE_ID.test(value) && value !== 'archive'
  );
}

function isSessionSlotId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SLOT_ID.test(value);
}

function isBindingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && BINDING_IDENTIFIER.test(value);
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}
