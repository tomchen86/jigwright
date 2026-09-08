/**
 * Coordinates claimed provider turns, terminal completion, and continuation publication.
 *
 * Invariants:
 * - A repeated claim never returns a second launch binding.
 * - Scope checks and object publication remain inside the original lock boundaries.
 *
 * Depends on: Native session contracts, chain readers, and create-only publication.
 * Failure modes: Duplicate launches, stale assignment acceptance, or unauthorized continuation.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { createProviderNativeSessionContinuationAuthorityV1, assertProviderNativeSessionContinuationAuthorityV1, } from "../../modules/provider-orchestration/agent-runtime-durable-authority.js";
import { createProviderNativeSessionClaimV1, createProviderNativeSessionCompletionV1, assertProviderNativeSessionClaimV1, assertProviderNativeSessionCompletionV1, } from "../../modules/provider-orchestration/provider-native-session.js";
import { providerNativeSessionStorePathsV1 as storePaths, providerNativeSessionClaimObjectPathV1 as claimObjectPath, providerNativeSessionClaimRefPathV1 as claimRefPath, providerNativeSessionHandleObjectPathV1 as handleObjectPath, providerNativeSessionCompletionObjectPathV1 as completionObjectPath, providerNativeSessionCompletionRefPathV1 as completionRefPath, providerNativeSessionContinuationAuthorityObjectPathV1 as continuationAuthorityObjectPath, } from "../session-workspace/provider-runtime-authority-paths.js";
import { assertClaimInput, claimMatchesInput, createStartBinding, createResumeBinding, MAX_OBJECT_BYTES, createClaimRef, MAX_REF_BYTES, assertCompletionInput, MAX_HANDLE_BYTES, createCompletionRef, assertContinuationAuthorityInput, MAX_CONTINUATION_AUTHORITY_BYTES, assertRecoveryInput, claimMatchesRecoveryInput, assertChainIdentity, } from "./provider-native-session-contracts.js";
import { loadScope, withScopeLock, assertCurrentScope, readChainForScope, readHandleForCompletion, bindingForClaim, readAcceptedOuterSuccessAuthority, } from "./provider-native-session-chain.js";
import { terminalUnusable, continuationNotAuthorized, storeConflict, deepFreeze, storeInvalid, } from "./provider-native-session-values.js";
import { publishCanonicalCreateOnly } from "./provider-native-session-publication.js";
import { readBoundedCanonicalJson } from "./provider-native-session-files.js";
/**
 * Claim one exact start/resume turn. A published claim is launch evidence: an
 * exact retry observes it but never receives a second launch binding.
 */
export function claimProviderNativeSessionTurnV1(paths, candidate, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority) {
    const input = assertClaimInput(candidate);
    const scope = loadScope(paths, input, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
    return withScopeLock(paths, scope, () => {
        const currentScope = assertCurrentScope(paths, input, scope, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
        const chain = readChainForScope(paths, currentScope);
        if (chain.state === 'terminal-unusable')
            throw terminalUnusable();
        if (chain.state === 'continuation-pending') {
            throw continuationNotAuthorized();
        }
        if (chain.state === 'claimed') {
            const current = chain.turns.at(-1).claim;
            if (!claimMatchesInput(current, input))
                throw storeConflict();
            return deepFreeze({
                outcome: 'already-claimed',
                claim: current,
                binding: null,
            });
        }
        const predecessor = chain.turns.at(-1)?.completion ?? null;
        if ((predecessor === null && input.predecessorCompletionDigest !== null) ||
            (predecessor !== null &&
                input.predecessorCompletionDigest !== predecessor.completionDigest)) {
            throw storeConflict();
        }
        const turn = chain.turns.length + 1;
        const binding = predecessor === null
            ? createStartBinding(input)
            : createResumeBinding(input, readHandleForCompletion(paths, predecessor));
        const claim = createProviderNativeSessionClaimV1({
            scope: currentScope,
            turn,
            predecessorCompletion: predecessor,
            binding,
        });
        const locations = storePaths(paths);
        publishCanonicalCreateOnly(paths, currentScope.scopeKey, claimObjectPath(locations, claim.claimDigest), claim, MAX_OBJECT_BYTES);
        publishCanonicalCreateOnly(paths, currentScope.scopeKey, claimRefPath(locations, currentScope.scopeKey, turn), createClaimRef(claim), MAX_REF_BYTES);
        const published = readChainForScope(paths, currentScope);
        const publishedTurn = published.turns.at(-1);
        if (published.state !== 'claimed' ||
            publishedTurn?.completion !== null ||
            publishedTurn?.claim.claimDigest !== claim.claimDigest) {
            throw storeInvalid();
        }
        return deepFreeze({ outcome: 'claimed', claim, binding });
    });
}
/**
 * Complete a claimed turn. Raw native identity is written only to a private
 * handle object; immutable public completion records contain its digest.
 */
export function completeProviderNativeSessionTurnV1(paths, candidate, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority) {
    const input = assertCompletionInput(candidate);
    const scope = loadScope(paths, input, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
    return withScopeLock(paths, scope, () => {
        const currentScope = assertCurrentScope(paths, input, scope, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
        const chain = readChainForScope(paths, currentScope);
        const turnIndex = chain.turns.findIndex(({ claim }) => claim.claimDigest === input.claimDigest);
        if (turnIndex < 0)
            throw storeConflict();
        const turn = chain.turns[turnIndex];
        const binding = bindingForClaim(paths, chain, turnIndex);
        const materialized = createProviderNativeSessionCompletionV1({
            claim: turn.claim,
            binding,
            terminal: input.terminal,
        });
        if (turn.completion !== null) {
            if (turn.completion.completionDigest !==
                materialized.completion.completionDigest) {
                throw storeConflict();
            }
            return turn.completion;
        }
        if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
            throw storeConflict();
        }
        const locations = storePaths(paths);
        if (materialized.handle !== null) {
            publishCanonicalCreateOnly(paths, currentScope.scopeKey, handleObjectPath(locations, materialized.handle.handleDigest), materialized.handle, MAX_HANDLE_BYTES);
        }
        publishCanonicalCreateOnly(paths, currentScope.scopeKey, completionObjectPath(locations, materialized.completion.completionDigest), materialized.completion, MAX_OBJECT_BYTES);
        publishCanonicalCreateOnly(paths, currentScope.scopeKey, completionRefPath(locations, currentScope.scopeKey, turn.claim.turn), createCompletionRef(materialized.completion), MAX_REF_BYTES);
        const published = readChainForScope(paths, currentScope);
        const publishedCompletion = published.turns[turnIndex]?.completion;
        if (publishedCompletion?.completionDigest !==
            materialized.completion.completionDigest) {
            throw storeInvalid();
        }
        return publishedCompletion;
    });
}
/**
 * Persist a terminal fact for one already-published launch claim without
 * re-running mutable admission policy. Claim creation remains the authority
 * boundary; completion is exact, immutable execution evidence.
 */
export function completeClaimedProviderNativeSessionTurnV1(paths, candidate) {
    const input = assertCompletionInput(candidate);
    const claim = assertProviderNativeSessionClaimV1(readBoundedCanonicalJson(paths, claimObjectPath(storePaths(paths), input.claimDigest), MAX_OBJECT_BYTES));
    const scope = claim.scope;
    if (claim.claimDigest !== input.claimDigest ||
        scope.changeId !== input.changeId ||
        scope.planningGeneration !== input.planningGeneration ||
        scope.assignmentRecordDigest !== input.assignmentRecordDigest ||
        scope.sessionSlotId !== input.sessionSlotId) {
        throw storeConflict();
    }
    return withScopeLock(paths, scope, () => {
        const chain = readChainForScope(paths, scope);
        const turnIndex = chain.turns.findIndex(({ claim: current }) => current.claimDigest === input.claimDigest);
        if (turnIndex < 0)
            throw storeConflict();
        const turn = chain.turns[turnIndex];
        const binding = bindingForClaim(paths, chain, turnIndex);
        const materialized = createProviderNativeSessionCompletionV1({
            claim: turn.claim,
            binding,
            terminal: input.terminal,
        });
        if (turn.completion !== null) {
            if (turn.completion.completionDigest !==
                materialized.completion.completionDigest) {
                throw storeConflict();
            }
            return turn.completion;
        }
        if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
            throw storeConflict();
        }
        const locations = storePaths(paths);
        if (materialized.handle !== null) {
            publishCanonicalCreateOnly(paths, scope.scopeKey, handleObjectPath(locations, materialized.handle.handleDigest), materialized.handle, MAX_HANDLE_BYTES);
        }
        publishCanonicalCreateOnly(paths, scope.scopeKey, completionObjectPath(locations, materialized.completion.completionDigest), materialized.completion, MAX_OBJECT_BYTES);
        publishCanonicalCreateOnly(paths, scope.scopeKey, completionRefPath(locations, scope.scopeKey, turn.claim.turn), createCompletionRef(materialized.completion), MAX_REF_BYTES);
        const published = readChainForScope(paths, scope);
        const publishedCompletion = published.turns[turnIndex]?.completion;
        if (publishedCompletion?.completionDigest !==
            materialized.completion.completionDigest) {
            throw storeInvalid();
        }
        return publishedCompletion;
    });
}
/**
 * Authorize continuation only after the outer invocation has durably committed
 * one exact success receipt. Native completion alone never publishes this
 * marker and therefore cannot authorize resume.
 */
export function publishProviderNativeSessionContinuationAuthorityV1(paths, candidate) {
    const input = assertContinuationAuthorityInput(candidate);
    const locations = storePaths(paths);
    const completion = assertProviderNativeSessionCompletionV1(readBoundedCanonicalJson(paths, completionObjectPath(locations, input.completionDigest), MAX_OBJECT_BYTES));
    if (completion.scope.changeId !== input.changeId ||
        completion.scope.planningGeneration !== input.planningGeneration ||
        completion.scope.assignmentRecordDigest !== input.assignmentRecordDigest ||
        completion.scope.sessionSlotId !== input.sessionSlotId ||
        completion.completionDigest !== input.completionDigest) {
        throw storeConflict();
    }
    const scope = completion.scope;
    const preflightRuntimeReceipt = readAcceptedOuterSuccessAuthority(paths, completion);
    return withScopeLock(paths, scope, () => {
        const runtimeReceipt = readAcceptedOuterSuccessAuthority(paths, completion);
        if (canonicalJson(runtimeReceipt) !== canonicalJson(preflightRuntimeReceipt)) {
            throw storeInvalid();
        }
        const chain = readChainForScope(paths, scope);
        const turn = chain.turns.find(({ completion: candidateCompletion }) => candidateCompletion?.completionDigest === completion.completionDigest);
        if (turn?.completion === null ||
            turn?.completion === undefined ||
            canonicalJson(turn.completion) !== canonicalJson(completion)) {
            throw storeConflict();
        }
        const authority = createProviderNativeSessionContinuationAuthorityV1(completion, runtimeReceipt, storeInvalid);
        const authorityPath = continuationAuthorityObjectPath(locations, completion.completionDigest);
        publishCanonicalCreateOnly(paths, scope.scopeKey, authorityPath, authority, MAX_CONTINUATION_AUTHORITY_BYTES);
        const published = assertProviderNativeSessionContinuationAuthorityV1(readBoundedCanonicalJson(paths, authorityPath, MAX_CONTINUATION_AUTHORITY_BYTES), completion, runtimeReceipt, storeInvalid);
        if (canonicalJson(published) !== canonicalJson(authority)) {
            throw storeInvalid();
        }
        return published;
    });
}
/**
 * Recover one exact public completion binding without accepting raw native
 * identity. A still-claimed launch is abandoned because recovery cannot safely
 * reconstruct the private handle required to make that session resumable.
 */
export function recoverProviderNativeSessionTurnV1(paths, candidate) {
    const input = assertRecoveryInput(candidate);
    const locations = storePaths(paths);
    const claim = assertProviderNativeSessionClaimV1(readBoundedCanonicalJson(paths, claimObjectPath(locations, input.claimDigest), MAX_OBJECT_BYTES));
    if (!claimMatchesRecoveryInput(claim, input))
        throw storeConflict();
    const scope = claim.scope;
    return withScopeLock(paths, scope, () => {
        const chain = readChainForScope(paths, scope);
        const turnIndex = chain.turns.findIndex(({ claim: current }) => current.claimDigest === input.claimDigest);
        if (turnIndex < 0)
            throw storeConflict();
        const turn = chain.turns[turnIndex];
        if (!claimMatchesRecoveryInput(turn.claim, input))
            throw storeConflict();
        if (turn.completion !== null) {
            const receiptDigest = turn.completion.protocolReceipt?.receiptDigest ?? null;
            if (turn.completion.disposition !== 'indeterminate' &&
                receiptDigest !== input.expectedProtocolReceiptDigest) {
                throw storeConflict();
            }
            return deepFreeze({
                outcome: 'unchanged',
                completion: turn.completion,
            });
        }
        if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
            throw storeConflict();
        }
        const materialized = createProviderNativeSessionCompletionV1({
            claim: turn.claim,
            binding: bindingForClaim(paths, chain, turnIndex),
            terminal: { kind: 'claim-crash' },
        });
        if (materialized.handle !== null ||
            materialized.completion.disposition !== 'indeterminate' ||
            materialized.completion.usable !== false ||
            materialized.completion.handleDigest !== null) {
            throw storeInvalid();
        }
        publishCanonicalCreateOnly(paths, scope.scopeKey, completionObjectPath(locations, materialized.completion.completionDigest), materialized.completion, MAX_OBJECT_BYTES);
        publishCanonicalCreateOnly(paths, scope.scopeKey, completionRefPath(locations, scope.scopeKey, turn.claim.turn), createCompletionRef(materialized.completion), MAX_REF_BYTES);
        const published = readChainForScope(paths, scope);
        const publishedCompletion = published.turns[turnIndex]?.completion;
        if (publishedCompletion?.completionDigest !==
            materialized.completion.completionDigest) {
            throw storeInvalid();
        }
        return deepFreeze({
            outcome: 'abandoned',
            completion: publishedCompletion,
        });
    });
}
/** Read and revalidate the complete immutable chain without exposing handles. */
export function readProviderNativeSessionChainV1(paths, requestedChangeId, requestedPlanningGeneration, requestedAssignmentRecordDigest, requestedSessionSlotId, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority) {
    const identity = assertChainIdentity({
        changeId: requestedChangeId,
        planningGeneration: requestedPlanningGeneration,
        assignmentRecordDigest: requestedAssignmentRecordDigest,
        sessionSlotId: requestedSessionSlotId,
    });
    const scope = loadScope(paths, identity, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
    return withScopeLock(paths, scope, () => {
        const currentScope = assertCurrentScope(paths, identity, scope, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
        return readChainForScope(paths, currentScope);
    });
}
