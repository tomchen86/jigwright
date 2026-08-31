import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertAgentRuntimeAssignmentBindingV1, createAgentRuntimeAssignmentBindingV1, } from "./agent-runtime-assignment-binding.js";
import { assertChangeRoleAssignmentRecordV1, } from "./change-role-assignment-record.js";
import { assertProviderNativeSessionClaimV1, assertProviderNativeSessionCompletionV1, } from "./provider-native-session.js";
import { assertAgentRuntimeCompletionReceipt } from "./provider-runtime-evidence.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ROLE_BY_PURPOSE = Object.freeze({
    survey: 'author',
    'plan-review': 'reviewer',
    'task-diff-review': 'reviewer',
    'task-implementation': 'builder',
});
export class AgentRuntimeDurableAuthorityError extends TypeError {
    code = 'AGENT_RUNTIME_DURABLE_AUTHORITY_INVALID';
    constructor() {
        super('Agent Runtime durable authority is invalid.');
        this.name = 'AgentRuntimeDurableAuthorityError';
    }
}
/** Reproject the only launch binding admitted by one parsed current record. */
export function projectAgentRuntimeAssignmentBindingV1(candidate, request, invalid = durableAuthorityInvalid) {
    const record = parseAssignmentRecord(candidate, invalid);
    if (!isRecord(request) ||
        !Object.hasOwn(ROLE_BY_PURPOSE, request.purpose) ||
        typeof request.providerId !== 'string' ||
        request.providerId.length === 0 ||
        !isDigest(request.inputManifestDigest) ||
        !isDigest(request.targetDigest)) {
        throw invalid();
    }
    const role = ROLE_BY_PURPOSE[request.purpose];
    const placement = record.resolution.placements.find((candidatePlacement) => candidatePlacement.role === role);
    const slot = record.sessionSlots.find((candidateSlot) => candidateSlot.roles.includes(role));
    const profile = record.host.configuration.providers.find((candidateProfile) => candidateProfile.id === placement?.profileId);
    if (placement === undefined ||
        slot === undefined ||
        profile === undefined ||
        profile.family !== request.providerId ||
        placement.logicalProviderId !== slot.logicalProviderId ||
        slot.sessionMode !== 'fresh') {
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
            dataAuthorizationPolicyDigest: record.dataAuthorization.snapshot.policyDigest,
            assignmentManifestDigest: record.dataAuthorization.snapshot.inputManifestDigest,
            inputManifestDigest: request.inputManifestDigest,
            targetDigest: request.targetDigest,
        });
    }
    catch {
        throw invalid();
    }
}
/** Compare an embedded runtime binding with the exact durable reprojection. */
export function assertAgentRuntimeDurableAssignmentAuthorityV1(value, record, request, invalid = durableAuthorityInvalid) {
    const binding = parseAssignmentBinding(value, invalid);
    const expected = projectAgentRuntimeAssignmentBindingV1(record, request, invalid);
    if (canonicalJson(binding) !== canonicalJson(expected))
        throw invalid();
    return binding;
}
export function createChangeRoleAssignmentRefV1(value, invalid = durableAuthorityInvalid) {
    const record = parseAssignmentRecord(value, invalid);
    return Object.freeze({
        schemaVersion: 1,
        kind: 'change-role-assignment-ref.v1',
        changeId: record.changeId,
        planningGeneration: record.planningGeneration,
        recordDigest: record.recordDigest,
    });
}
export function assertChangeRoleAssignmentRefV1(value, changeId, planningGeneration, invalid = durableAuthorityInvalid) {
    if (!isRecord(value) ||
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
        !isDigest(value.recordDigest)) {
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
export function createProviderNativeSessionClaimRefV1(value, invalid = durableAuthorityInvalid) {
    const claim = parseNativeClaim(value, invalid);
    return Object.freeze({
        schemaVersion: 1,
        kind: 'provider-native-session-claim-ref.v1',
        scopeKey: claim.scope.scopeKey,
        turn: claim.turn,
        claimDigest: claim.claimDigest,
    });
}
export function assertProviderNativeSessionClaimRefV1(value, scopeKey, turn, invalid = durableAuthorityInvalid) {
    if (!isRecord(value) ||
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
        !isDigest(value.claimDigest)) {
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
export function createProviderNativeSessionCompletionRefV1(value, invalid = durableAuthorityInvalid) {
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
export function assertProviderNativeSessionCompletionRefV1(value, scopeKey, turn, claimDigest, invalid = durableAuthorityInvalid) {
    if (!isRecord(value) ||
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
        !isDigest(value.completionDigest)) {
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
export function createProviderNativeSessionContinuationAuthorityV1(completionValue, runtimeReceiptValue, invalid = durableAuthorityInvalid) {
    const completion = parseNativeCompletion(completionValue, invalid);
    const runtimeReceipt = parseRuntimeReceipt(runtimeReceiptValue, invalid);
    const hostBinding = runtimeReceipt.hostExecutionBinding;
    const nativeClaim = hostBinding?.nativeSessionClaim ?? null;
    if (completion.usable !== true ||
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
            canonicalJson(completion.protocolReceipt)) {
        throw invalid();
    }
    const body = {
        schemaVersion: 1,
        kind: 'provider-native-session-continuation-authority.v1',
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
        authorityDigest: sha256(`workflow.provider-native-session-continuation-authority.v1\n${canonicalJson(body)}`),
    });
}
export function assertProviderNativeSessionContinuationAuthorityV1(value, completionValue, runtimeReceiptValue, invalid = durableAuthorityInvalid) {
    const authority = assertProviderNativeSessionContinuationAuthorityEnvelopeV1(value, invalid);
    const completion = parseNativeCompletion(completionValue, invalid);
    const expected = createProviderNativeSessionContinuationAuthorityV1(completion, runtimeReceiptValue, invalid);
    if (canonicalJson(authority) !== canonicalJson(expected))
        throw invalid();
    return expected;
}
export function assertProviderNativeSessionContinuationAuthorityEnvelopeV1(value, invalid = durableAuthorityInvalid) {
    if (!isRecord(value) ||
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
        !isDigest(value.authorityDigest)) {
        throw invalid();
    }
    const { authorityDigest, ...body } = value;
    if (sha256(`workflow.provider-native-session-continuation-authority.v1\n${canonicalJson(body)}`) !== authorityDigest) {
        throw invalid();
    }
    return deepFreeze(structuredClone(value));
}
/**
 * Re-admit a terminal embedded claim/completion through the exact parsed
 * content-addressed objects and every predecessor ref in its durable chain.
 * This function performs no filesystem I/O.
 */
export function assertAgentRuntimeDurableNativeSessionAuthorityV1(input, invalid = durableAuthorityInvalid) {
    if (!isRecord(input) ||
        !Array.isArray(input.turns) ||
        !isDigest(input.embeddedCompletionDigest)) {
        throw invalid();
    }
    const embeddedClaim = parseNativeClaim(input.embeddedClaim, invalid);
    if (input.turns.length !== embeddedClaim.turn || input.turns.length === 0) {
        throw invalid();
    }
    const turns = [];
    let predecessor = null;
    for (const [index, value] of input.turns.entries()) {
        if (!isRecord(value))
            throw invalid();
        const claim = parseNativeClaim(value.claim, invalid);
        const claimRef = assertProviderNativeSessionClaimRefV1(value.claimRef, embeddedClaim.scope.scopeKey, index + 1, invalid);
        const completion = parseNativeCompletion(value.completion, invalid);
        const completionRef = assertProviderNativeSessionCompletionRefV1(value.completionRef, embeddedClaim.scope.scopeKey, index + 1, claim.claimDigest, invalid);
        if ((value.continuationAuthority === null) !==
            (value.runtimeReceipt === null)) {
            throw invalid();
        }
        const runtimeReceipt = value.runtimeReceipt === null
            ? null
            : parseRuntimeReceipt(value.runtimeReceipt, invalid);
        const continuationAuthority = value.continuationAuthority === null || runtimeReceipt === null
            ? null
            : assertProviderNativeSessionContinuationAuthorityV1(value.continuationAuthority, completion, runtimeReceipt, invalid);
        if (claim.turn !== index + 1 ||
            canonicalJson(claim.scope) !== canonicalJson(embeddedClaim.scope) ||
            claimRef.claimDigest !== claim.claimDigest ||
            completionRef.completionDigest !== completion.completionDigest ||
            !completionMatchesClaim(completion, claim)) {
            throw invalid();
        }
        if (predecessor === null) {
            if (claim.turn !== 1 ||
                claim.action !== 'start' ||
                claim.predecessorCompletionDigest !== null ||
                claim.expectedNativeSessionIdDigest !== null) {
                throw invalid();
            }
        }
        else if (predecessor.completion.usable !== true ||
            predecessor.continuationAuthority === null ||
            predecessor.runtimeReceipt === null ||
            claim.action !== 'resume' ||
            claim.predecessorCompletionDigest !==
                predecessor.completion.completionDigest ||
            claim.expectedNativeSessionIdDigest !==
                predecessor.completion.nativeSessionIdDigest) {
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
    const terminal = turns.at(-1);
    if (canonicalJson(terminal.claim) !== canonicalJson(embeddedClaim) ||
        terminal.completion.completionDigest !== input.embeddedCompletionDigest) {
        throw invalid();
    }
    return deepFreeze({
        claim: terminal.claim,
        completion: terminal.completion,
        turns,
    });
}
function completionMatchesClaim(completion, claim) {
    return (canonicalJson(completion.scope) === canonicalJson(claim.scope) &&
        completion.turn === claim.turn &&
        completion.claimDigest === claim.claimDigest &&
        completion.action === claim.action &&
        completion.predecessorCompletionDigest ===
            claim.predecessorCompletionDigest &&
        completion.expectedNativeSessionIdDigest ===
            claim.expectedNativeSessionIdDigest &&
        completion.invocationId === claim.invocationId &&
        completion.requestDigest === claim.requestDigest &&
        completion.attemptId === claim.attemptId);
}
function parseAssignmentRecord(value, invalid) {
    try {
        return assertChangeRoleAssignmentRecordV1(value);
    }
    catch {
        throw invalid();
    }
}
function parseAssignmentBinding(value, invalid) {
    try {
        return assertAgentRuntimeAssignmentBindingV1(value);
    }
    catch {
        throw invalid();
    }
}
function parseNativeClaim(value, invalid) {
    try {
        return assertProviderNativeSessionClaimV1(value);
    }
    catch {
        throw invalid();
    }
}
function parseNativeCompletion(value, invalid) {
    try {
        return assertProviderNativeSessionCompletionV1(value);
    }
    catch {
        throw invalid();
    }
}
function parseRuntimeReceipt(value, invalid) {
    let receipt;
    try {
        receipt = assertAgentRuntimeCompletionReceipt(value, invalid);
    }
    catch {
        throw invalid();
    }
    if (receipt.schemaVersion !== 4)
        throw invalid();
    return receipt;
}
function durableAuthorityInvalid() {
    return new AgentRuntimeDurableAuthorityError();
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isChangeId(value) {
    return (typeof value === 'string' && CHANGE_ID.test(value) && value !== 'archive');
}
function isTurn(value) {
    return (Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= 10_000);
}
function isRevision(value) {
    return Number.isSafeInteger(value) && value >= 1;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
