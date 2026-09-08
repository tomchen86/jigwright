/**
 * Expose the provider invocation store API and its grant-backed cancellation operations.
 *
 * Invariants:
 * - Public names, signatures, and cancellation lock and grant checks stay stable.
 * - Cancellation requests remain bound to the exact invocation and worker fence.
 */
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { withPrivateRuntimeLock, createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, } from "./investigation-private-files.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
import { assertProviderInvocationCancellationRequestV1, assertProviderInvocationCancellationBindingV1, PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID, PROVIDER_INVOCATION_CANCELLATION_PARAMETER_SCHEMA_DIGEST, PROVIDER_INVOCATION_CANCELLATION_CONSEQUENCE_DIGEST, assertProviderInvocationCancellationParameters, } from "../../modules/authority/provider-invocation-cancellation-grant.js";
import { readGrantRecord, grantStorePaths, grantRecordDigest, } from "./grant-store.js";
import { invocationLockInvalid, providerCancellationInvalid, providerCancellationStateChanged, parseNow, providerSha256, providerInvocationCancellationRequestPath, } from "./provider-invocation-common.js";
import { assertProviderWorkerFenceClaim, readProviderWorkerFence, providerWorkerFenceDigest, } from "./provider-invocation-workers.js";
import { readProviderInvocation } from "./provider-invocation-state.js";
export { BLIND_SURVEY_OUTPUT_SCHEMA, BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA, } from "../../modules/provider-orchestration/blind-survey-output.js";
export { PROVIDER_COMPLETION_GRACE_MS } from "./provider-invocation-common.js";
export { blindSurveyManifestDigest, providerInvocationManifestDigest, blindSurveyIntentDigest, providerOutputSchemaGeneration, blindSurveyOutputValidator, providerResidualsGeneration, } from "./provider-invocation-validation.js";
export { createInvestigationStartReservation, readInvestigationStartReservation, readInvestigationStartReservationSnapshot, retireInvestigationStartReservation, createProviderRetryReservation, readProviderRetryReservation, } from "./provider-invocation-reservations.js";
export { createProviderInvocation, readProviderInvocation, readProviderInvocationRuntimeReceipt, readProviderInvocationEvidence, recoverProviderInvocationSupersession, prepareProviderInvocationAcceptanceBinding, assertProviderInvocationAcceptanceBindingCurrent, assertProviderInvocationAcceptanceBindingTerminalCurrent, } from "./provider-invocation-state.js";
export { readPlanReviewSnapshotRuntime, readProviderInvocationRequest, readBlindSurveyManifest, readProviderInvocationManifest, providerInvocationExists, } from "./provider-invocation-artifacts.js";
export { storeProviderExecutionPolicySnapshot, createProviderExecutionPolicySnapshot, ensureProviderExecutionPolicySnapshotFromSnapshot, validateProviderExecutionPolicySnapshot, ensureProviderExecutionPolicySnapshot, readProviderExecutionPolicySnapshot, providerExecutionPolicySnapshotPath, } from "./provider-invocation-policy.js";
export { claimProviderInvocation, claimProviderInvocationForWorker, claimProviderInvocationForWorkerUnderLifecycleLock, releaseProviderInvocationWorkerFence, releaseProviderInvocationWorkerFenceForWorkerClaim, releaseProviderInvocationWorkerFenceUnderLifecycleLock, assertProviderWorkersQuiescentUnderLifecycleLock, expireProviderInvocationLease, expireProviderInvocationLeaseUnderLifecycleLock, } from "./provider-invocation-workers.js";
export { completeProviderInvocation, completeProviderInvocationFromRunner, completeProviderInvocationFromRunnerForWorkerClaim, completeProviderInvocationFromRunnerUnderLifecycleLock, providerCompletionCandidateExists, recoverProviderInvocationCompletion, recoverProviderInvocationCompletionForWorkerUnderLifecycleLock, recoverProviderInvocationCompletionUnderLifecycleLock, recoverProviderInvocationNativeContinuationForReplay, failProviderInvocation, failProviderInvocationForWorkerClaim, failProviderInvocationUnderLifecycleLock, } from "./provider-invocation-completion.js";
export function createProviderInvocationCancellationBinding(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => createProviderInvocationCancellationBindingUnlocked(paths, invocationId), 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
export function publishProviderInvocationCancellationRequestFromPreparedGrant(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        const authorized = assertPreparedProviderCancellationGrant(paths, input);
        if (authorized.parameters.binding.invocationId !== invocationId) {
            throw providerCancellationInvalid();
        }
        const existing = readProviderInvocationCancellationRequest(paths, invocationId);
        if (existing !== null) {
            if (existing.grantChallengeId !== input.challengeId ||
                existing.grantOperationId !== input.operationId ||
                existing.grantRecordDigest !== authorized.recordDigest ||
                existing.reason !== authorized.parameters.reason ||
                canonicalJson(existing.binding) !==
                    canonicalJson(authorized.parameters.binding)) {
                throw providerCancellationInvalid();
            }
            return existing;
        }
        const current = createProviderInvocationCancellationBindingUnlocked(paths, invocationId);
        if (canonicalJson(current) !== canonicalJson(authorized.parameters.binding)) {
            throw providerCancellationStateChanged();
        }
        const body = {
            schemaVersion: 1,
            kind: 'provider-invocation-cancellation-request.v1',
            binding: current,
            grantChallengeId: input.challengeId,
            grantOperationId: input.operationId,
            grantRecordDigest: authorized.recordDigest,
            reason: authorized.parameters.reason,
            requestedAt: new Date(parseNow(input.requestedAt)).toISOString(),
        };
        const request = Object.freeze({
            ...body,
            requestDigest: providerSha256(`workflow.provider-invocation-cancellation-request.v1\n${canonicalJson(body)}`),
        });
        createPrivateCanonicalJson(paths, providerInvocationCancellationRequestPath(paths, invocationId), request, providerCancellationInvalid, 'PROVIDER_INVOCATION_CANCELLATION_CONFLICT');
        return readProviderInvocationCancellationRequest(paths, invocationId);
    }, 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
export function readProviderInvocationCancellationRequest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const filePath = providerInvocationCancellationRequestPath(paths, invocationId);
    if (!privatePathExists(paths, filePath, providerCancellationInvalid)) {
        return null;
    }
    const request = assertProviderInvocationCancellationRequestV1(readPrivateCanonicalJson(paths, filePath, providerCancellationInvalid));
    if (request.binding.invocationId !== invocationId) {
        throw providerCancellationInvalid();
    }
    return request;
}
export function readProviderInvocationCancellationRequestForWorkerClaim(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        const request = readProviderInvocationCancellationRequest(paths, invocationId);
        if (request === null)
            return null;
        const authorized = assertPreparedProviderCancellationGrant(paths, {
            challengeId: request.grantChallengeId,
            operationId: request.grantOperationId,
        });
        if (authorized.recordDigest !== request.grantRecordDigest ||
            authorized.parameters.reason !== request.reason ||
            canonicalJson(authorized.parameters.binding) !==
                canonicalJson(request.binding)) {
            throw providerCancellationInvalid();
        }
        assertProviderWorkerFenceClaim(paths, invocationId, input);
        const current = createProviderInvocationCancellationBindingUnlocked(paths, invocationId);
        if (current.expectedState !== 'leased' ||
            canonicalJson(current) !== canonicalJson(request.binding)) {
            throw providerCancellationStateChanged();
        }
        return request;
    }, 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
function createProviderInvocationCancellationBindingUnlocked(paths, invocationId) {
    const record = readProviderInvocation(paths, invocationId);
    if (record.state !== 'prepared' && record.state !== 'leased') {
        throw providerCancellationStateChanged();
    }
    const fence = readProviderWorkerFence(paths, invocationId);
    if ((record.state === 'prepared' &&
        (record.lease !== null || fence !== null)) ||
        (record.state === 'leased' &&
            (record.lease === null ||
                fence === null ||
                fence.leaseGeneration !== record.leaseGeneration ||
                fence.leaseTokenDigest !== record.lease.tokenDigest))) {
        throw providerCancellationStateChanged();
    }
    const body = {
        schemaVersion: 1,
        kind: 'provider-invocation-cancellation-binding.v1',
        invocationId,
        requestDigest: record.requestDigest,
        manifestDigest: record.manifestDigest,
        invocationRecordDigest: providerSha256(`workflow.provider-invocation-record.v1\n${canonicalJson(record)}`),
        expectedRevision: record.revision,
        expectedState: record.state,
        leaseGeneration: record.leaseGeneration,
        leaseTokenDigest: record.lease?.tokenDigest ?? null,
        workerFenceDigest: fence === null ? null : providerWorkerFenceDigest(fence),
    };
    return assertProviderInvocationCancellationBindingV1({
        ...body,
        bindingDigest: providerSha256(`workflow.provider-invocation-cancellation-binding.v1\n${canonicalJson(body)}`),
    });
}
function assertPreparedProviderCancellationGrant(paths, input) {
    const record = readGrantRecord(grantStorePaths(path.dirname(paths.root)), input.challengeId);
    if (record.state !== 'prepared' ||
        record.operationId !== input.operationId ||
        record.challenge.sourceModuleId !== 'provider-runtime' ||
        record.challenge.failureCode !==
            'provider-invocation-cancellation-required' ||
        record.challenge.choices.length !== 1 ||
        record.challenge.choices[0].transitionId !==
            PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID ||
        record.challenge.choices[0].parameterSchemaDigest !==
            PROVIDER_INVOCATION_CANCELLATION_PARAMETER_SCHEMA_DIGEST ||
        record.challenge.choices[0].consequenceDigest !==
            PROVIDER_INVOCATION_CANCELLATION_CONSEQUENCE_DIGEST) {
        throw providerCancellationInvalid();
    }
    const parameters = assertProviderInvocationCancellationParameters(record.challenge.choices[0].parameters);
    if (record.challenge.stateBinding.kind !==
        'provider-invocation-cancellation-state.v1' ||
        record.challenge.stateBinding.digest !== parameters.stateBindingDigest) {
        throw providerCancellationInvalid();
    }
    return Object.freeze({
        parameters,
        recordDigest: grantRecordDigest(record),
    });
}
