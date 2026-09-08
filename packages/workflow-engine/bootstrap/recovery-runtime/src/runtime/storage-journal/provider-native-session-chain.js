/**
 * Rebuilds native session chains under current assignment and runtime receipt authority.
 *
 * Invariants:
 * - Turns remain contiguous and every continuation matches its predecessor.
 * - Scope verification and the scope lock preserve their original boundaries.
 *
 * Depends on: Assignment records, runtime receipt authority, and native session publication recovery.
 * Failure modes: Broken chains, stale assignments, or unauthenticated continuations appear valid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertProviderNativeSessionContinuationAuthorityV1, } from "../../modules/provider-orchestration/agent-runtime-durable-authority.js";
import { assertProviderNativeSessionClaimV1, assertProviderNativeSessionCompletionV1, assertProviderNativeSessionHandleV1, deriveProviderNativeSessionScopeV1, } from "../../modules/provider-orchestration/provider-native-session.js";
import { readChangeRoleAssignmentRecordV1 } from "./change-role-assignment-store.js";
import { readAcceptedProviderInvocationRuntimeReceiptAuthority } from "./provider-runtime-authority.js";
import { readPrivateCanonicalJson, withPrivateRuntimeLock, assertPrivateInvestigationDirectory, } from "./investigation-private-files.js";
import { assertProviderExecutionAdmissionAuthority, providerExecutionAdmissionAuthorityPath, MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES, } from "./provider-execution-admission-authority.js";
import { providerNativeSessionStorePathsV1 as storePaths, providerNativeSessionClaimRefPathV1 as claimRefPath, providerNativeSessionClaimObjectPathV1 as claimObjectPath, providerNativeSessionCompletionRefPathV1 as completionRefPath, providerNativeSessionCompletionObjectPathV1 as completionObjectPath, providerNativeSessionContinuationAuthorityObjectPathV1 as continuationAuthorityObjectPath, providerNativeSessionHandleObjectPathV1 as handleObjectPath, providerNativeSessionChainDirectoryV1 as chainDirectory, } from "../session-workspace/provider-runtime-authority-paths.js";
import { createChain, TURN_REF, MAX_TURN, MAX_REF_BYTES, assertClaimRef, MAX_OBJECT_BYTES, assertCompletionRef, MAX_CONTINUATION_AUTHORITY_BYTES, MAX_HANDLE_BYTES, createStartBinding, createResumeBinding, } from "./provider-native-session-contracts.js";
import { recoverScopePublication } from "./provider-native-session-publication-recovery.js";
import { storeInvalid, storeOperationConflict, storeConflict, compareCodeUnits, } from "./provider-native-session-values.js";
import { readBoundedCanonicalSnapshot, readBoundedCanonicalJson, assertRefUnchanged, sameStableFile, } from "./provider-native-session-files.js";
export function readChainForScope(paths, scope) {
    const locations = storePaths(paths);
    recoverScopePublication(paths, locations, scope.scopeKey);
    const beforeNames = readRefNames(paths, locations, scope.scopeKey);
    if (beforeNames.length === 0)
        return createChain(scope, []);
    const claims = new Set();
    const completions = new Set();
    for (const name of beforeNames) {
        const match = TURN_REF.exec(name);
        if (match === null)
            throw storeInvalid();
        const turn = Number(match[1]);
        if (turn < 1 || turn > MAX_TURN)
            throw storeInvalid();
        (match[2] === 'claim' ? claims : completions).add(turn);
    }
    const lastTurn = Math.max(...claims);
    if (claims.size !== lastTurn ||
        [...Array(lastTurn)].some((_, index) => !claims.has(index + 1)) ||
        [...completions].some((turn) => !claims.has(turn))) {
        throw storeInvalid();
    }
    const turns = [];
    for (let turn = 1; turn <= lastTurn; turn += 1) {
        const claim = readClaim(paths, locations, scope, turn);
        const prior = turns.at(-1)?.completion ?? null;
        if ((turn === 1 &&
            (claim.action !== 'start' ||
                claim.predecessorCompletionDigest !== null)) ||
            (turn > 1 &&
                (prior?.usable !== true ||
                    turns.at(-1)?.continuationAuthority === null ||
                    claim.action !== 'resume' ||
                    claim.predecessorCompletionDigest !== prior.completionDigest ||
                    claim.expectedNativeSessionIdDigest !== prior.nativeSessionIdDigest))) {
            throw storeInvalid();
        }
        const completion = completions.has(turn)
            ? readCompletion(paths, locations, scope, claim)
            : null;
        const continuationAuthority = completion === null
            ? null
            : readContinuationAuthority(paths, locations, completion);
        if ((completion === null && turn !== lastTurn) ||
            (completion?.usable === false && turn !== lastTurn) ||
            (completion?.usable === true &&
                continuationAuthority === null &&
                turn !== lastTurn)) {
            throw storeInvalid();
        }
        if (completion?.usable === true && continuationAuthority !== null) {
            readHandleForCompletion(paths, completion);
        }
        turns.push({ claim, completion, continuationAuthority });
    }
    const afterNames = readRefNames(paths, locations, scope.scopeKey);
    if (canonicalJson(beforeNames) !== canonicalJson(afterNames)) {
        throw storeOperationConflict();
    }
    return createChain(scope, turns);
}
function readClaim(paths, locations, scope, turn) {
    const refPath = claimRefPath(locations, scope.scopeKey, turn);
    const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    const ref = assertClaimRef(before.value, scope.scopeKey, turn);
    const claim = assertProviderNativeSessionClaimV1(readBoundedCanonicalJson(paths, claimObjectPath(locations, ref.claimDigest), MAX_OBJECT_BYTES));
    if (claim.scope.scopeKey !== scope.scopeKey ||
        canonicalJson(claim.scope) !== canonicalJson(scope) ||
        claim.turn !== turn ||
        claim.claimDigest !== ref.claimDigest) {
        throw storeInvalid();
    }
    assertRefUnchanged(paths, refPath, before);
    return claim;
}
function readCompletion(paths, locations, scope, claim) {
    const refPath = completionRefPath(locations, scope.scopeKey, claim.turn);
    const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
    const ref = assertCompletionRef(before.value, scope.scopeKey, claim.turn, claim.claimDigest);
    const completion = assertProviderNativeSessionCompletionV1(readBoundedCanonicalJson(paths, completionObjectPath(locations, ref.completionDigest), MAX_OBJECT_BYTES));
    if (completion.scope.scopeKey !== scope.scopeKey ||
        canonicalJson(completion.scope) !== canonicalJson(scope) ||
        completion.turn !== claim.turn ||
        completion.claimDigest !== claim.claimDigest ||
        completion.action !== claim.action ||
        completion.predecessorCompletionDigest !==
            claim.predecessorCompletionDigest ||
        completion.expectedNativeSessionIdDigest !==
            claim.expectedNativeSessionIdDigest ||
        completion.invocationId !== claim.invocationId ||
        completion.requestDigest !== claim.requestDigest ||
        completion.attemptId !== claim.attemptId ||
        completion.completionDigest !== ref.completionDigest) {
        throw storeInvalid();
    }
    assertRefUnchanged(paths, refPath, before);
    return completion;
}
function readContinuationAuthority(paths, locations, completion) {
    const authorityPath = continuationAuthorityObjectPath(locations, completion.completionDigest);
    if (fs.lstatSync(authorityPath, { throwIfNoEntry: false }) === undefined) {
        return null;
    }
    const runtimeReceipt = readAcceptedOuterSuccessAuthority(paths, completion);
    return assertProviderNativeSessionContinuationAuthorityV1(readBoundedCanonicalJson(paths, authorityPath, MAX_CONTINUATION_AUTHORITY_BYTES), completion, runtimeReceipt, storeInvalid);
}
export function readAcceptedOuterSuccessAuthority(paths, completion) {
    const runtimeReceipt = readAcceptedProviderInvocationRuntimeReceiptAuthority(paths, completion.invocationId, storeInvalid);
    const admissionAuthority = assertProviderExecutionAdmissionAuthority(readPrivateCanonicalJson(paths, providerExecutionAdmissionAuthorityPath(paths, runtimeReceipt.acceptanceBinding), storeInvalid, MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES), storeInvalid);
    if (admissionAuthority.receiptRequirement !== 'schema-v4' ||
        canonicalJson(admissionAuthority.acceptanceBinding) !==
            canonicalJson(runtimeReceipt.acceptanceBinding) ||
        admissionAuthority.acceptanceBindingDigest !==
            runtimeReceipt.acceptanceBindingDigest ||
        admissionAuthority.executionStateDigest !==
            runtimeReceipt.executionStateDigest) {
        throw storeInvalid();
    }
    return runtimeReceipt;
}
export function readHandleForCompletion(paths, completion) {
    if (completion.usable !== true ||
        completion.handleDigest === null ||
        completion.nativeSessionIdDigest === null) {
        throw storeInvalid();
    }
    return assertProviderNativeSessionHandleV1(readBoundedCanonicalJson(paths, handleObjectPath(storePaths(paths), completion.handleDigest), MAX_HANDLE_BYTES), { completion, handleDigest: completion.handleDigest });
}
export function bindingForClaim(paths, chain, turnIndex) {
    const claim = chain.turns[turnIndex].claim;
    if (claim.action === 'start') {
        return createStartBinding(claim);
    }
    const predecessor = chain.turns[turnIndex - 1]?.completion;
    const continuationAuthority = chain.turns[turnIndex - 1]?.continuationAuthority;
    if (predecessor?.usable !== true ||
        continuationAuthority === null ||
        continuationAuthority === undefined ||
        predecessor.completionDigest !== claim.predecessorCompletionDigest) {
        throw storeInvalid();
    }
    return createResumeBinding(claim, readHandleForCompletion(paths, predecessor));
}
export function assertCurrentScope(paths, input, expected, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority) {
    const current = loadScope(paths, input, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority);
    if (current.scopeKey !== expected.scopeKey ||
        canonicalJson(current) !== canonicalJson(expected)) {
        throw storeInvalid();
    }
    return current;
}
export function loadScope(paths, input, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext, verifyAssignmentAuthority) {
    const assignment = readChangeRoleAssignmentRecordV1(paths, input.changeId, input.planningGeneration, verifyCentralSnapshot, verifyChangeOverrideSnapshot, verifyHostConfiguration, verifyProviderRegistry, verifyDataAuthorization, verifySessionCapability, verifyProtectedContext);
    if (assignment === null)
        throw storeInvalid();
    if (assignment.recordDigest !== input.assignmentRecordDigest) {
        throw storeConflict();
    }
    return deriveProviderNativeSessionScopeV1(assignment, input.sessionSlotId, verifyAssignmentAuthority);
}
export function withScopeLock(paths, scope, operation) {
    return withPrivateRuntimeLock(paths, path.join(paths.locks, 'provider-native-sessions', `${scope.scopeKey}.lock`), operation, 'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT', storeInvalid);
}
function readRefNames(paths, locations, scopeKey) {
    const directory = chainDirectory(locations, scopeKey);
    const before = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (before === undefined)
        return Object.freeze([]);
    assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
    const names = fs.readdirSync(directory).sort(compareCodeUnits);
    const after = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (after === undefined ||
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        (before.mode & 0o777) !== 0o700 ||
        !sameStableFile(before, after) ||
        names.length > MAX_TURN * 2) {
        throw storeInvalid();
    }
    return Object.freeze(names);
}
