/**
 * Persist and validate each invocation's execution policy and retry accounting authority.
 *
 * Invariants:
 * - Policy snapshots retain their schema, canonical bytes, and exact request binding.
 * - Durable execution budget authority is checked before accepting stored policy.
 */
import path from 'node:path';
import { parseAiAdapterPolicyDocument, } from "../provider-execution/ai-adapter-policy.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { privatePathExists, createPrivateCanonicalJson, readPrivateCanonicalJson, } from "./investigation-private-files.js";
import { createProviderExecutionBudgetAuthority, validateProviderExecutionBudgetAuthority, assertDurableProviderExecutionBudgetAuthority as assertStoredProviderExecutionBudgetAuthority, } from "../provider-execution/provider-execution-policy-authority.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
import { assertProviderRequest } from "./provider-invocation-validation.js";
import { providerExecutionPolicySnapshotUnsafe, providerExecutionPolicySnapshotMismatch, deepFreeze, isRecord, hasExactKeys, DIGEST, sha256, providerInvocationDirectory, } from "./provider-invocation-common.js";
/**
 * Publish the exact validated policy bytes selected for one Attempt. The raw
 * document, rather than a reconstructed object, remains the digest authority so
 * the request cannot be rebound through whitespace or alternate JSON bytes.
 */
export function storeProviderExecutionPolicySnapshot(paths, requestInput, loadedInput, executionGrantAuthorization) {
    const snapshot = createProviderExecutionPolicySnapshot(requestInput, loadedInput, executionGrantAuthorization);
    return ensureProviderExecutionPolicySnapshotFromSnapshot(paths, requestInput, snapshot);
}
export function createProviderExecutionPolicySnapshot(requestInput, loadedInput, executionGrantAuthorization) {
    const request = assertProviderRequest(requestInput);
    let loaded;
    try {
        loaded = parseAiAdapterPolicyDocument(loadedInput.document);
    }
    catch {
        throw providerExecutionPolicySnapshotUnsafe();
    }
    if (loaded.digest !== loadedInput.digest ||
        canonicalJson(loaded.policy) !== canonicalJson(loadedInput.policy) ||
        request.policyDigest !== loaded.digest ||
        request.limits.aggregateOutputBytes >
            loaded.policy.limits.aggregateOutputBytes) {
        throw providerExecutionPolicySnapshotMismatch();
    }
    const authority = request.limits.timeoutMs > loaded.policy.limits.timeoutMs
        ? createProviderExecutionBudgetAuthority(request, loaded, executionGrantAuthorization ?? missingExecutionGrantAuthority())
        : null;
    const retryAccounting = structuredClone(loaded.policy.retryAccounting);
    const attemptReservation = Object.freeze({
        runtimeMs: request.limits.timeoutMs,
        providerCostMicros: retryAccounting.reservations[request.providerId].providerCostMicros,
        providerTokens: retryAccounting.reservations[request.providerId].providerTokens,
    });
    const accountingDigest = providerRetryAccountingDigest({
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        policyDigest: request.policyDigest,
        retryAccounting,
        attemptReservation,
    });
    const common = {
        kind: 'provider-execution-policy-snapshot',
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        policyDigest: request.policyDigest,
        policyDocument: loaded.document,
        retryAccounting,
        attemptReservation,
        accountingDigest,
    };
    return deepFreeze(authority === null
        ? { schemaVersion: 2, ...common }
        : { schemaVersion: 3, ...common, authority });
}
export function ensureProviderExecutionPolicySnapshotFromSnapshot(paths, requestInput, snapshotInput) {
    const request = assertProviderRequest(requestInput);
    const expected = validateProviderExecutionPolicySnapshot(request, snapshotInput);
    if (expected.schemaVersion === 3) {
        assertDurableProviderExecutionBudgetAuthority(paths, expected.authority);
    }
    const snapshotPath = providerExecutionPolicySnapshotPath(paths, request.invocationId);
    if (privatePathExists(paths, snapshotPath, providerExecutionPolicySnapshotUnsafe)) {
        const existing = readProviderExecutionPolicySnapshot(paths, request).snapshot;
        if (canonicalJson(existing) !== canonicalJson(expected)) {
            throw providerExecutionPolicySnapshotMismatch();
        }
        return existing;
    }
    createPrivateCanonicalJson(paths, snapshotPath, expected, providerExecutionPolicySnapshotUnsafe, 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_CONFLICT');
    return readProviderExecutionPolicySnapshot(paths, request).snapshot;
}
export function validateProviderExecutionPolicySnapshot(requestInput, snapshotInput) {
    const request = assertProviderRequest(requestInput);
    if (!isRecord(snapshotInput) ||
        ![2, 3].includes(snapshotInput.schemaVersion) ||
        !isProviderExecutionPolicySnapshotShape(snapshotInput)) {
        throw providerExecutionPolicySnapshotUnsafe();
    }
    let loaded;
    try {
        loaded = parseAiAdapterPolicyDocument(snapshotInput.policyDocument);
    }
    catch {
        throw providerExecutionPolicySnapshotUnsafe();
    }
    const expected = createProviderExecutionPolicySnapshot(request, loaded, snapshotInput.schemaVersion === 3
        ? validateProviderExecutionBudgetAuthority(request, loaded, snapshotInput.authority)
        : undefined);
    if (canonicalJson(expected) !== canonicalJson(snapshotInput)) {
        throw providerExecutionPolicySnapshotMismatch();
    }
    return expected;
}
/**
 * Recover a missing snapshot only from policy bytes that independently validate
 * to the request's exact digest. An existing snapshot remains the authority and
 * is validated without consulting possibly newer live policy bytes.
 */
export function ensureProviderExecutionPolicySnapshot(paths, requestInput, loadedInput) {
    const request = assertProviderRequest(requestInput);
    const snapshotPath = providerExecutionPolicySnapshotPath(paths, request.invocationId);
    if (privatePathExists(paths, snapshotPath, providerExecutionPolicySnapshotUnsafe)) {
        return readProviderExecutionPolicySnapshot(paths, request).snapshot;
    }
    return storeProviderExecutionPolicySnapshot(paths, request, loadedInput);
}
export function readProviderExecutionPolicySnapshot(paths, requestInput) {
    const request = assertProviderRequest(requestInput);
    let value;
    try {
        value = readPrivateCanonicalJson(paths, providerExecutionPolicySnapshotPath(paths, request.invocationId), providerExecutionPolicySnapshotUnsafe);
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE') {
            throw error;
        }
        throw providerExecutionPolicySnapshotUnsafe();
    }
    if (!isRecord(value) || !isProviderExecutionPolicySnapshotShape(value)) {
        throw providerExecutionPolicySnapshotUnsafe();
    }
    let loaded;
    try {
        loaded = parseAiAdapterPolicyDocument(value.policyDocument);
    }
    catch {
        throw providerExecutionPolicySnapshotUnsafe();
    }
    const snapshot = validateProviderExecutionPolicySnapshot(request, value);
    if (snapshot.schemaVersion === 3) {
        assertDurableProviderExecutionBudgetAuthority(paths, snapshot.authority);
    }
    return Object.freeze({
        snapshot,
        loaded,
        accounting: deepFreeze({
            retryPolicy: structuredClone(loaded.policy.retryAccounting),
            attemptReservation: structuredClone(snapshot.attemptReservation),
            accountingDigest: snapshot.accountingDigest,
        }),
    });
}
function isProviderExecutionPolicySnapshotShape(value) {
    const common = value.kind === 'provider-execution-policy-snapshot' &&
        typeof value.invocationId === 'string' &&
        typeof value.requestDigest === 'string' &&
        typeof value.policyDigest === 'string' &&
        typeof value.policyDocument === 'string';
    if (!common)
        return false;
    const expectedKeys = [
        'accountingDigest',
        'attemptReservation',
        ...(value.schemaVersion === 3 ? ['authority'] : []),
        'invocationId',
        'kind',
        'policyDigest',
        'policyDocument',
        'requestDigest',
        'retryAccounting',
        'schemaVersion',
    ];
    return ((value.schemaVersion === 2 || value.schemaVersion === 3) &&
        hasExactKeys(value, expectedKeys) &&
        (value.schemaVersion !== 3 || isRecord(value.authority)) &&
        isRecord(value.retryAccounting) &&
        isProviderAttemptBudgetReservation(value.attemptReservation) &&
        typeof value.accountingDigest === 'string' &&
        DIGEST.test(value.accountingDigest));
}
function assertDurableProviderExecutionBudgetAuthority(paths, authority) {
    try {
        assertStoredProviderExecutionBudgetAuthority(paths.root, authority);
    }
    catch {
        throw providerExecutionPolicySnapshotMismatch();
    }
}
function missingExecutionGrantAuthority() {
    throw providerExecutionPolicySnapshotMismatch();
}
function isProviderAttemptBudgetReservation(value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'providerCostMicros',
            'providerTokens',
            'runtimeMs',
        ]) &&
        Number.isSafeInteger(value.runtimeMs) &&
        value.runtimeMs > 0 &&
        Number.isSafeInteger(value.providerCostMicros) &&
        value.providerCostMicros > 0 &&
        Number.isSafeInteger(value.providerTokens) &&
        value.providerTokens > 0);
}
function providerRetryAccountingDigest(input) {
    return sha256(canonicalJson({
        schemaVersion: 1,
        kind: 'provider-retry-accounting-snapshot',
        ...input,
    }));
}
export function providerExecutionPolicySnapshotPath(paths, requestedInvocationId) {
    return path.join(providerInvocationDirectory(paths, assertInvocationId(requestedInvocationId)), 'execution-policy.json');
}
