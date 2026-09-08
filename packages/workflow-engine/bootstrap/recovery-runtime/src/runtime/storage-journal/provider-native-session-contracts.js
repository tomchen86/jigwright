import { createProviderNativeSessionClaimRefV1 as createDurableClaimRef, createProviderNativeSessionCompletionRefV1 as createDurableCompletionRef, assertProviderNativeSessionClaimRefV1 as assertDurableClaimRef, assertProviderNativeSessionCompletionRefV1 as assertDurableCompletionRef, } from "../../modules/provider-orchestration/agent-runtime-durable-authority.js";
import { deepFreeze, storeInvalid, isRecord, hasExactKeys, } from "./provider-native-session-values.js";
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
export function createStartBinding(input) {
    return deepFreeze({
        invocationId: input.invocationId,
        requestDigest: input.requestDigest,
        attemptId: input.attemptId,
        sessionControl: {
            action: 'start',
            nativeSessionIdentityMode: 'provider-observed',
            expectedNativeSessionId: null,
        },
    });
}
export function createResumeBinding(input, handle) {
    return deepFreeze({
        invocationId: input.invocationId,
        requestDigest: input.requestDigest,
        attemptId: input.attemptId,
        sessionControl: {
            action: 'resume',
            nativeSessionIdentityMode: 'engine-supplied',
            expectedNativeSessionId: handle.nativeSessionId,
        },
    });
}
export function createChain(scope, turns) {
    const lastTurn = turns.at(-1);
    const last = lastTurn?.completion;
    const state = turns.length === 0
        ? 'empty'
        : last === undefined || last === null
            ? 'claimed'
            : last.usable
                ? lastTurn.continuationAuthority === null
                    ? 'continuation-pending'
                    : 'resumable'
                : 'terminal-unusable';
    return deepFreeze({
        schemaVersion: 1,
        kind: 'provider-native-session-chain.v1',
        scope,
        state,
        turns: turns.map(({ claim, completion, continuationAuthority }) => ({
            claim,
            completion,
            continuationAuthority,
        })),
    });
}
export function createClaimRef(claim) {
    return createDurableClaimRef(claim, storeInvalid);
}
export function createCompletionRef(completion) {
    return createDurableCompletionRef(completion, storeInvalid);
}
export function assertClaimRef(value, scopeKey, turn) {
    return assertDurableClaimRef(value, scopeKey, turn, storeInvalid);
}
export function assertCompletionRef(value, scopeKey, turn, claimDigest) {
    return assertDurableCompletionRef(value, scopeKey, turn, claimDigest, storeInvalid);
}
export function assertClaimInput(value) {
    if (!isRecord(value) ||
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
        !isBindingIdentifier(value.attemptId)) {
        throw storeInvalid();
    }
    return deepFreeze(structuredClone(value));
}
export function assertCompletionInput(value) {
    if (!isRecord(value) ||
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
        !isDigest(value.claimDigest)) {
        throw storeInvalid();
    }
    return deepFreeze(structuredClone(value));
}
export function assertRecoveryInput(value) {
    if (!isRecord(value) ||
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
        !isNullableDigest(value.expectedProtocolReceiptDigest)) {
        throw storeInvalid();
    }
    return deepFreeze(structuredClone(value));
}
export function assertContinuationAuthorityInput(value) {
    if (!isRecord(value) ||
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
        !isDigest(value.completionDigest)) {
        throw storeInvalid();
    }
    return deepFreeze(structuredClone(value));
}
export function assertChainIdentity(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'changeId',
            'planningGeneration',
            'assignmentRecordDigest',
            'sessionSlotId',
        ]) ||
        !isChangeId(value.changeId) ||
        !isDigest(value.planningGeneration) ||
        !isDigest(value.assignmentRecordDigest) ||
        !isSessionSlotId(value.sessionSlotId)) {
        throw storeInvalid();
    }
    return Object.freeze({
        changeId: value.changeId,
        planningGeneration: value.planningGeneration,
        assignmentRecordDigest: value.assignmentRecordDigest,
        sessionSlotId: value.sessionSlotId,
    });
}
export function claimMatchesInput(claim, input) {
    return (claim.predecessorCompletionDigest === input.predecessorCompletionDigest &&
        claim.invocationId === input.invocationId &&
        claim.requestDigest === input.requestDigest &&
        claim.attemptId === input.attemptId);
}
export function claimMatchesRecoveryInput(claim, input) {
    return (claim.scope.scopeKey === input.scopeKey &&
        claim.scope.sessionSlotId === input.sessionSlotId &&
        claim.claimDigest === input.claimDigest &&
        claim.invocationId === input.invocationId &&
        claim.requestDigest === input.requestDigest &&
        claim.attemptId === input.attemptId);
}
export function assertDigest(value) {
    if (!isDigest(value))
        throw storeInvalid();
    return value;
}
function isChangeId(value) {
    return (typeof value === 'string' && CHANGE_ID.test(value) && value !== 'archive');
}
function isSessionSlotId(value) {
    return typeof value === 'string' && SESSION_SLOT_ID.test(value);
}
function isBindingIdentifier(value) {
    return typeof value === 'string' && BINDING_IDENTIFIER.test(value);
}
export function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isNullableDigest(value) {
    return value === null || isDigest(value);
}
