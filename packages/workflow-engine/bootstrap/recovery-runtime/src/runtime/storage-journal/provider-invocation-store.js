import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAiAdapterPolicyDocument, } from "../provider-execution/ai-adapter-policy.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { resolvePlanReviewInvocationOwner, resolveTaskDiffReviewInvocationOwner, resolveTaskStrategyImplementationInvocationOwner, } from "./evidence-object-store.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertReadOnlyProbe, projectProviderInvocationExecution, } from "../../modules/provider-orchestration/execution-core.js";
import { acceptProviderAttemptResult, materializeProviderExecutionJob, publishProviderExecutionAdmissionAuthority, readExecutionJobState, withExecutionJobStateSnapshot, } from "./execution-store.js";
import { assertPrivateInvestigationDirectory, assertProviderRuntimeDurableAuthorities, assertProviderRuntimeTerminalAuthorityPreflight, createPrivateCanonicalJson, ensurePrivateInvestigationDirectory, listProviderInvocationLifecycleProjections, privatePathExists, readHumanResolutionHead, readHumanResolutionNode, readPrivateCanonicalJson, scanProviderInvocationLifecycles, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from "./investigation-session-store.js";
import { assertDurableProviderExecutionBudgetAuthority as assertStoredProviderExecutionBudgetAuthority, createProviderExecutionBudgetAuthority, validateProviderExecutionBudgetAuthority, } from "../provider-execution/provider-execution-policy-authority.js";
import { MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES, assertProviderExecutionAdmissionAuthority, providerExecutionAdmissionAuthorityPath, } from "./provider-execution-admission-authority.js";
import { createProviderInvocationRequest, evaluateProviderProcess, } from "../../modules/provider-orchestration/provider-contracts.js";
import { assertAgentRuntimeHostExecutionBindingV1 } from "../../modules/provider-orchestration/agent-runtime-host-execution-binding.js";
import { assertProviderRuntimeProtocolReceipt, } from "../../modules/provider-orchestration/agent-runtime-protocol.js";
import { assertAgentRuntimeCompletionReceipt, assertAgentRuntimeProcessProgress, assertProviderInvocationAcceptanceBinding, assertProviderDefinitionSnapshotForResult, assertProviderProcessResult, assertProviderRuntimeObservation, isProviderExecutableIdentity, providerDefinitionDigest, providerDefinitionExecutableBindingDigest, PROVIDER_RUNNER_RESIDUALS, } from "../../modules/provider-orchestration/provider-runtime-evidence.js";
import { BLIND_SURVEY_OUTPUT_SCHEMA, validateBlindSurveyOutput, } from "../../modules/provider-orchestration/blind-survey-output.js";
export { BLIND_SURVEY_OUTPUT_SCHEMA, BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA, } from "../../modules/provider-orchestration/blind-survey-output.js";
import { assertChangeId, assertInvestigationId, assertInvocationId, assertSessionId, assertTaskId, } from "../session-workspace/paths.js";
import { assertProviderInvocationCancellationBindingV1, assertProviderInvocationCancellationParameters, assertProviderInvocationCancellationRequestV1, PROVIDER_INVOCATION_CANCELLATION_CONSEQUENCE_DIGEST, PROVIDER_INVOCATION_CANCELLATION_PARAMETER_SCHEMA_DIGEST, PROVIDER_INVOCATION_CANCELLATION_TRANSITION_ID, } from "../../modules/authority/provider-invocation-cancellation-grant.js";
import { grantRecordDigest, grantStorePaths, readGrantRecord, } from "./grant-store.js";
import { registerProviderRetentionInvocation } from "./provider-retention-catalog.js";
import { publishProviderNativeSessionContinuationAuthorityV1 } from "./provider-native-session-store.js";
import { providerNativeSessionContinuationAuthorityObjectPathV1, providerNativeSessionStorePathsV1, } from "../session-workspace/provider-runtime-authority-paths.js";
import { providerRetentionArtifact, providerRetentionReviewRootArtifact, readCompleteProviderRetentionReceipt, } from "./provider-retention-receipt.js";
import { assertProviderPromptContextCurrent, assertProviderRepairAuthorityCurrent, createProviderRepairLineage, ensureProviderPromptContext, persistProviderRepairEvidence, prepareProviderPromptContextForInvocation, readProviderRepairAuthorityBinding, registerProviderRuntimeEvidence, withCurrentProviderPromptContext, } from "../provider-execution/provider-execution-governance.js";
import { assertProviderInvocationSupersessionEndpointCurrent, finalizeProviderInvocationSupersession, prepareProviderInvocationSupersession, readProviderInvocationEvidenceRecord, recoverProviderInvocationSupersessionTransaction, resumePreparedProviderInvocationSupersession, } from "../provider-execution/provider-invocation-supersession.js";
import { PLAN_REVIEW_OUTPUT_SCHEMA, PLAN_REVIEW_OUTPUT_VALIDATOR, assertPlanReviewTargetSnapshot, assertPlanReviewSubject, planReviewSnapshotLineCount, } from "../../modules/assurance/plan-review.js";
import { assertTaskDiffReviewChallengeResponseCurrent, parseTaskDiffReviewChallengeResponseRecord, parseTaskDiffReviewRecord, TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA, TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR, TASK_DIFF_REVIEW_OUTPUT_SCHEMA, TASK_DIFF_REVIEW_OUTPUT_VALIDATOR, } from "../../modules/assurance/task-diff-review-artifact.js";
import { parseTaskDiffReviewScope, parseTaskDiffReviewSubject, } from "../../modules/assurance/task-diff-review.js";
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA, TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR, assertTaskStrategyImplementationManifest, } from "../../modules/provider-orchestration/task-strategy-provider-contract.js";
import { runtimePaths, withRepositoryLifecycleOperation, } from "../session-workspace/session-store.js";
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BLIND_MANIFEST_BYTES = 262_144;
const MAX_INTENT_SUMMARY_BYTES = 4_096;
const MAX_INTENT_FACT_BYTES = 512;
const MAX_INTENT_FACTS_PER_KIND = 256;
const MAX_ARCHITECTURE_QUESTION_BYTES = 16_384;
export const PROVIDER_COMPLETION_GRACE_MS = 30_000;
export function blindSurveyManifestDigest(manifest) {
    return sha256(canonicalJson(assertBlindSurveyManifest(manifest)));
}
export function providerInvocationManifestDigest(manifest) {
    return sha256(canonicalJson(assertProviderInvocationManifest(manifest)));
}
export function blindSurveyIntentDigest(manifest) {
    return sha256(canonicalJson(assertBlindSurveyManifest(manifest).normalizedIntent));
}
export function createInvestigationStartReservation(paths, input) {
    const changeId = assertChangeId(input.changeId);
    const investigationId = assertInvestigationId(input.investigationId);
    const manifest = assertBlindSurveyManifest(input.manifest);
    const request = assertProviderRequest(input.request);
    const manifestDigest = blindSurveyManifestDigest(manifest);
    assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    if (!isTimestamp(createdAt)) {
        throw invocationInvalid();
    }
    const reservation = assertInvestigationStartReservation({
        schemaVersion: 1,
        kind: 'investigation-start-reservation',
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        investigationId,
        invocationId: request.invocationId,
        repositoryRoot: input.repositoryRoot,
        gitCommonDirectory: input.gitCommonDirectory,
        branch: input.branch,
        baseline: input.baseline,
        manifestDigest,
        requestDigest: request.requestDigest,
        manifest,
        request,
        createdAt,
    });
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${changeId}.investigation-start.lock`), () => {
        storeProviderExecutionPolicySnapshot(paths, request, input.executionPolicy);
        createPrivateCanonicalJson(paths, investigationStartReservationPath(paths, changeId), reservation, invocationUnsafe, 'INVESTIGATION_START_RESERVATION_CONFLICT');
        return readInvestigationStartReservation(paths, changeId);
    }, 'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT', startReservationLockInvalid);
}
export function readInvestigationStartReservation(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const reservationPath = investigationStartReservationPath(paths, changeId);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return null;
    }
    const reservation = assertInvestigationStartReservation(readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe));
    if (reservation.changeId !== changeId) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(reservation));
}
export function readInvestigationStartReservationSnapshot(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const reservationPath = investigationStartReservationPath(paths, changeId);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return absentInvestigationStartReservationSnapshot();
    }
    const rawDocument = readPrivateCanonicalDocument(paths, reservationPath, invocationUnsafe);
    let parsed;
    try {
        parsed = JSON.parse(rawDocument);
    }
    catch {
        throw invocationInvalid();
    }
    const reservation = assertInvestigationStartReservation(parsed);
    if (reservation.changeId !== changeId ||
        rawDocument !== `${canonicalJson(parsed)}\n`) {
        throw invocationInvalid();
    }
    return Object.freeze({
        rawDocument,
        digest: sha256(rawDocument),
        reservation,
    });
}
export function retireInvestigationStartReservation(paths, input) {
    const changeId = assertChangeId(input.changeId);
    if (input.expectedDigest !== null && !DIGEST.test(input.expectedDigest)) {
        throw invocationInvalid();
    }
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${changeId}.investigation-start.lock`), () => {
        const current = readInvestigationStartReservationSnapshot(paths, changeId);
        if (current.digest === null) {
            return current;
        }
        if (current.digest !== input.expectedDigest) {
            throw startReservationCasMismatch(input.expectedDigest, current.digest);
        }
        fs.unlinkSync(investigationStartReservationPath(paths, changeId));
        fsyncDirectory(paths.refs);
        const retired = readInvestigationStartReservationSnapshot(paths, changeId);
        if (retired.digest !== null) {
            throw invocationInvalid();
        }
        return retired;
    }, 'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT', startReservationLockInvalid);
}
export function createProviderRetryReservation(paths, input) {
    const investigationId = assertInvestigationId(input.investigationId);
    const changeId = assertChangeId(input.changeId);
    const previousInvocationId = assertInvocationId(input.previousInvocationId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 2) {
        throw invocationInvalid();
    }
    const manifest = assertProviderInvocationManifest(input.manifest);
    const request = assertProviderRequest(input.request);
    if (input.retryDecision === undefined) {
        throw workflowError('PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED', 'A durable retry decision binding is required before reserving provider work.', ExitCode.guard);
    }
    const retryDecision = assertProviderRetryDecisionBinding(input.retryDecision);
    const executionPolicySnapshot = createProviderExecutionPolicySnapshot(request, input.executionPolicy, input.executionGrantAuthorization);
    const manifestDigest = providerInvocationManifestDigest(manifest);
    assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const reservation = assertProviderRetryReservation({
        schemaVersion: input.replacement === undefined ? 2 : 3,
        kind: 'provider-retry-reservation',
        investigationId,
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        attempt: input.attempt,
        previousInvocationId,
        invocationId: request.invocationId,
        manifestDigest,
        requestDigest: request.requestDigest,
        request,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        retryDecision,
        executionPolicySnapshot,
        ...(input.replacement === undefined
            ? {}
            : { replacement: input.replacement }),
        createdAt,
    });
    createPrivateCanonicalJson(paths, providerRetryReservationPath(paths, investigationId, input.attempt), reservation, invocationUnsafe, 'PROVIDER_RETRY_RESERVATION_CONFLICT');
    ensureProviderExecutionPolicySnapshotFromSnapshot(paths, request, executionPolicySnapshot);
    return readProviderRetryReservation(paths, investigationId, input.attempt);
}
export function readProviderRetryReservation(paths, requestedInvestigationId, attempt) {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    if (!Number.isSafeInteger(attempt) || attempt < 2) {
        throw invocationInvalid();
    }
    const reservationPath = providerRetryReservationPath(paths, investigationId, attempt);
    if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
        return null;
    }
    const reservation = assertProviderRetryReservation(readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe));
    if (reservation.investigationId !== investigationId ||
        reservation.attempt !== attempt) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(reservation));
}
export function createProviderInvocation(paths, input) {
    const investigationId = assertInvestigationId(input.investigationId);
    const changeId = assertChangeId(input.changeId);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
        throw invocationInvalid();
    }
    const manifest = assertProviderInvocationManifest(input.manifest);
    const request = assertProviderRequest(input.request);
    const invocationId = assertInvocationId(request.invocationId);
    const manifestDigest = providerInvocationManifestDigest(manifest);
    assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
    const executionPolicy = readProviderExecutionPolicySnapshot(paths, request);
    if (executionPolicy.snapshot.schemaVersion === 3 &&
        canonicalJson(executionPolicy.snapshot.authority.receipt.mandateBinding) !==
            canonicalJson(input.mandateBinding ?? null)) {
        throw providerExecutionPolicySnapshotMismatch();
    }
    const now = input.createdAt ?? new Date().toISOString();
    if (!isTimestamp(now)) {
        throw invocationInvalid();
    }
    const directory = providerInvocationDirectory(paths, invocationId);
    const manifestPath = path.join(directory, 'manifest.json');
    const requestPath = path.join(directory, 'request.json');
    const statePath = path.join(directory, 'state.json');
    const record = {
        schemaVersion: 1,
        invocationId,
        investigationId,
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        attempt: input.attempt,
        revision: 0,
        state: 'prepared',
        providerId: request.providerId,
        purpose: request.purpose,
        requestDigest: request.requestDigest,
        manifestDigest,
        leaseGeneration: 0,
        lease: null,
        result: null,
        failure: null,
        createdAt: now,
        updatedAt: now,
    };
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        const invocationAlreadyExists = privatePathExists(paths, statePath, invocationUnsafe);
        let supersession = resumePreparedProviderInvocationSupersession(paths, record, request);
        let effectiveNow = now;
        let effectiveRecord = record;
        if (supersession !== null) {
            effectiveNow = supersession.edge.createdAt;
            if (input.createdAt !== undefined && input.createdAt !== effectiveNow) {
                throw invocationInvalid();
            }
            effectiveRecord = {
                ...record,
                createdAt: effectiveNow,
                updatedAt: effectiveNow,
            };
        }
        const executionHistory = supersession === null
            ? providerExecutionHistory(paths, effectiveRecord.investigationId, effectiveRecord.purpose, effectiveRecord.attempt, request)
            : null;
        createPlanReviewSnapshotFiles(paths, directory, manifest, input.planReviewSnapshotFiles);
        // The provider-neutral blind manifest is always made durable before the
        // provider-specific request and mutable prepared state.
        createPrivateCanonicalJson(paths, manifestPath, manifest, invocationUnsafe, 'BLIND_MANIFEST_COLLISION');
        createPrivateCanonicalJson(paths, requestPath, request, invocationUnsafe, 'PROVIDER_REQUEST_COLLISION');
        if (executionHistory !== null) {
            const repairLineage = createProviderRepairLineage(paths, {
                history: executionHistory,
                replacementRecord: effectiveRecord,
                replacementRequest: request,
            });
            supersession = prepareProviderInvocationSupersession(paths, {
                history: executionHistory,
                successorRecord: effectiveRecord,
                successorRequest: request,
                replacementMode: repairLineage === null ? 'retry' : 'repair',
                simulateCrashAfter: input.simulateSupersessionCrashAfter,
            });
        }
        if (!invocationAlreadyExists) {
            const promptContext = prepareProviderPromptContextForInvocation(paths.root, request, manifest, investigationId, new Date(effectiveNow));
            // The runtime this invocation produces is prunable evidence, so its
            // catalog handle is written here, while the context is current and long
            // before a TTL could make the bytes eligible for deletion. Without it a
            // maintainer has no identity to pin and the pruning pass finds no
            // decision to honour.
            registerProviderRuntimeEvidence(paths.root, {
                binding: promptContext,
                attemptId: projectProviderInvocationExecution({
                    record: effectiveRecord,
                    request,
                }).attempt.attemptId,
                invocationId,
                invocationRevision: effectiveRecord.revision,
                now: new Date(effectiveNow),
            });
        }
        registerProviderRetentionInvocation(paths, invocationId, effectiveNow);
        createPrivateCanonicalJson(paths, statePath, effectiveRecord, invocationUnsafe, 'PROVIDER_INVOCATION_COLLISION');
        if (supersession !== null) {
            finalizeProviderInvocationSupersession(paths, supersession, (relatedInvocationId) => ({
                record: readProviderInvocationCore(paths, relatedInvocationId),
                request: readProviderInvocationRequest(paths, relatedInvocationId),
            }), {
                publishedAt: effectiveNow,
                simulateCrashAfter: input.simulateSupersessionCrashAfter,
            });
        }
        const created = readProviderInvocation(paths, invocationId);
        materializeProviderExecutionState(paths, created, request);
        return created;
    }, 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
export function readProviderInvocation(paths, requestedInvocationId) {
    const record = readProviderInvocationCore(paths, requestedInvocationId);
    const request = readProviderInvocationRequest(paths, record.invocationId);
    assertProviderInvocationSupersessionEndpointCurrent(paths, record, request, (relatedInvocationId) => ({
        record: readProviderInvocationCore(paths, relatedInvocationId),
        request: readProviderInvocationRequest(paths, relatedInvocationId),
    }));
    return record;
}
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
/**
 * Read one optional async receipt only after re-admitting its durable
 * Job/Attempt projection. Historical and synchronous records intentionally
 * return null instead of being rewritten.
 */
export function readProviderInvocationRuntimeReceipt(paths, requestedInvocationId) {
    const record = readProviderInvocation(paths, requestedInvocationId);
    const receipt = record.runtimeReceipt;
    if (receipt === undefined)
        return null;
    const execution = readExecutionJobState(paths, receipt.executionJobId);
    const attempt = execution?.attempts.find(({ attemptId }) => attemptId === receipt.executionAttemptId);
    const terminalStatusMatches = receipt.terminalState === 'succeeded'
        ? attempt?.status === 'succeeded' || attempt?.status === 'late-duplicate'
        : attempt !== undefined &&
            [
                'failed-retryable',
                'failed-terminal',
                'timed-out',
                'stale',
                'cancelled',
            ].includes(attempt.status);
    if (execution === null ||
        execution.revision <= receipt.executionRevision ||
        attempt === undefined ||
        attempt.jobId !== receipt.executionJobId ||
        attempt.providerInvocation?.invocationId !== receipt.invocationId ||
        attempt.providerInvocation.invocationRevision !==
            receipt.terminalRevision ||
        (receipt.protocolReceipt !== null &&
            (receipt.protocolReceipt.invocationId !== receipt.invocationId ||
                receipt.protocolReceipt.requestDigest !== receipt.requestDigest ||
                receipt.protocolReceipt.attemptId !== attempt.attemptId)) ||
        !terminalStatusMatches) {
        throw invocationInvalid();
    }
    return receipt;
}
function readProviderInvocationCore(paths, requestedInvocationId, options = {}) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const value = readPrivateCanonicalJson(paths, providerInvocationStatePath(paths, invocationId), invocationUnsafe);
    const record = assertProviderInvocationRecord(value);
    if (record.invocationId !== invocationId) {
        throw invocationInvalid();
    }
    const request = readProviderInvocationRequest(paths, invocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    assertPlanReviewSnapshotFiles(paths, invocationId, manifest, undefined, record);
    assertProviderInvocationBinding(record.changeId, manifest, providerInvocationManifestDigest(manifest), request);
    if (request.requestDigest !== record.requestDigest ||
        providerInvocationManifestDigest(manifest) !== record.manifestDigest ||
        request.providerId !== record.providerId ||
        request.purpose !== record.purpose) {
        throw invocationInvalid();
    }
    const result = record.result === null
        ? null
        : assertProviderResult(request, record.result);
    if (record.result !== null &&
        canonicalJson(result) !== canonicalJson(record.result)) {
        throw invocationInvalid();
    }
    assertProviderRuntimeDurableAuthorities(paths, request, record, result, record.runtimeReceipt ?? null, invocationUnsafe, options);
    if (manifest.kind === 'task-strategy-implementation-manifest' &&
        record.result !== null) {
        assertProviderResultManifestBinding(manifest, assertProviderResult(request, record.result));
    }
    if (record.runtimeReceipt !== undefined) {
        const projection = projectProviderInvocationExecution({ record, request });
        if (record.runtimeReceipt.executionJobId !== projection.job.jobId ||
            record.runtimeReceipt.executionAttemptId !== projection.attempt.attemptId) {
            throw invocationInvalid();
        }
    }
    if (manifest.kind === 'plan-review-manifest' &&
        resolvePlanReviewInvocationOwner(paths, {
            changeId: record.changeId,
            subject: manifest.subject,
            assignment: request.roleAssignment,
            authorizationNodeId: request.authorizationNodeId,
        }) !== record.investigationId) {
        throw invocationInvalid();
    }
    if (manifest.kind === 'task-diff-review-manifest' ||
        manifest.kind === 'task-diff-review-continuation-manifest') {
        const owner = resolveTaskDiffReviewInvocationOwner(paths, {
            changeId: record.changeId,
            sessionId: manifest.sessionId,
            subject: manifest.subject,
            assignment: request.roleAssignment,
            authorizationNodeId: request.authorizationNodeId,
        });
        if (owner.ownerInvestigationId !== record.investigationId ||
            canonicalJson(owner.mandateBinding) !==
                canonicalJson(record.mandateBinding ?? null)) {
            throw invocationInvalid();
        }
    }
    if (manifest.kind === 'task-strategy-implementation-manifest') {
        const owner = resolveTaskStrategyImplementationInvocationOwner(paths, {
            changeId: record.changeId,
            sessionId: manifest.subject.sessionId,
            subject: manifest.subject,
            assignment: request.roleAssignment,
            authorizationNodeId: request.authorizationNodeId,
        });
        if (owner.ownerInvestigationId !== record.investigationId ||
            canonicalJson(owner.mandateBinding) !==
                canonicalJson(record.mandateBinding ?? null)) {
            throw invocationInvalid();
        }
    }
    return deepFreeze(structuredClone(record));
}
export function readProviderInvocationEvidence(paths, requestedInvocationId) {
    const record = readProviderInvocationCore(paths, requestedInvocationId);
    const request = readProviderInvocationRequest(paths, record.invocationId);
    return readProviderInvocationEvidenceRecord(paths, record, request, (relatedInvocationId) => ({
        record: readProviderInvocationCore(paths, relatedInvocationId),
        request: readProviderInvocationRequest(paths, relatedInvocationId),
    }));
}
export function recoverProviderInvocationSupersession(paths, requestedSuccessorInvocationId, input = {}) {
    return recoverProviderInvocationSupersessionTransaction(paths, requestedSuccessorInvocationId, (relatedInvocationId) => ({
        record: readProviderInvocationCore(paths, relatedInvocationId),
        request: readProviderInvocationRequest(paths, relatedInvocationId),
    }), { recoveredAt: input.recoveredAt ?? new Date().toISOString() });
}
export function readPlanReviewSnapshotRuntime(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    if (manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined) {
        return null;
    }
    assertPlanReviewSnapshotFiles(paths, invocationId, manifest);
    const root = path.join(providerInvocationDirectory(paths, invocationId), 'review-root');
    return {
        root,
        files: manifest.planningTarget.artifacts.map((artifact) => ({
            id: `planning-snapshot:${artifact.path}`,
            path: path.join(root, artifact.snapshotFile),
        })),
    };
}
export function readProviderInvocationRequest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const value = readPrivateCanonicalJson(paths, path.join(providerInvocationDirectory(paths, invocationId), 'request.json'), invocationUnsafe);
    const request = assertProviderRequest(value);
    if (request.invocationId !== invocationId) {
        throw invocationInvalid();
    }
    return request;
}
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
export function readBlindSurveyManifest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    if (manifest.kind !== 'blind-survey-manifest') {
        throw invocationInvalid();
    }
    return manifest;
}
export function readProviderInvocationManifest(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const value = readPrivateCanonicalJson(paths, path.join(providerInvocationDirectory(paths, invocationId), 'manifest.json'), invocationUnsafe);
    return assertProviderInvocationManifest(value);
}
export function providerInvocationExists(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return privatePathExists(paths, providerInvocationStatePath(paths, invocationId), invocationUnsafe);
}
export function prepareProviderInvocationAcceptanceBinding(paths, requestedInvocationId, receiptRequirement) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const record = readProviderInvocation(paths, invocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    if (record.state !== 'leased' || record.lease === null) {
        throw providerAcceptanceBindingStale();
    }
    assertProviderInvocationNotTerminallyResolved(paths, record);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    const context = ensureProviderPromptContext(paths.root, request, manifest, record.investigationId);
    const projection = projectProviderInvocationExecution({ record, request });
    const repair = readProviderRepairAuthorityBinding(paths, record, request);
    return withExecutionJobStateSnapshot(paths, projection.job.jobId, (execution) => {
        const attempt = execution?.attempts.find(({ attemptId }) => attemptId === projection.attempt.attemptId);
        if (execution === null ||
            execution.workflow.workflowId !== record.investigationId ||
            execution.job.jobId !== projection.job.jobId ||
            execution.job.acceptedAttemptId !== null ||
            attempt === undefined ||
            attempt.providerInvocation?.invocationId !== invocationId ||
            attempt.providerInvocation.invocationRevision !== record.revision) {
            throw providerAcceptanceBindingStale();
        }
        const payload = {
            schemaVersion: 1,
            kind: 'provider-invocation-acceptance-binding',
            invocationId,
            requestDigest: request.requestDigest,
            ownerWorkflowId: record.investigationId,
            invocationRevision: record.revision,
            leaseGeneration: record.leaseGeneration,
            context,
            executionJobId: projection.job.jobId,
            executionAttemptId: projection.attempt.attemptId,
            executionRevision: execution.revision,
            executionStateDigest: sha256(canonicalJson(execution)),
            receiptRequirement,
            repair,
        };
        const binding = deepFreeze({
            ...payload,
            bindingDigest: sha256(canonicalJson(payload)),
        });
        publishProviderExecutionAdmissionAuthority(paths, binding, execution);
        return binding;
    });
}
export function assertProviderInvocationAcceptanceBindingCurrent(paths, binding) {
    assertProviderAcceptanceBinding(binding);
    const record = readProviderInvocation(paths, binding.invocationId);
    const request = readProviderInvocationRequest(paths, binding.invocationId);
    if (record.investigationId !== binding.ownerWorkflowId ||
        record.requestDigest !== binding.requestDigest ||
        record.revision !== binding.invocationRevision ||
        record.state !== 'leased' ||
        record.lease === null ||
        record.leaseGeneration !== binding.leaseGeneration ||
        record.lease.generation !== binding.leaseGeneration) {
        throw providerAcceptanceBindingStale();
    }
    assertProviderInvocationNotTerminallyResolved(paths, record);
    assertProviderPromptContextCurrent(paths.root, binding.context);
    const projection = projectProviderInvocationExecution({ record, request });
    const execution = readExecutionJobState(paths, binding.executionJobId);
    const attempt = execution?.attempts.find(({ attemptId }) => attemptId === binding.executionAttemptId);
    if (projection.job.jobId !== binding.executionJobId ||
        projection.attempt.attemptId !== binding.executionAttemptId ||
        execution === null ||
        execution.revision !== binding.executionRevision ||
        sha256(canonicalJson(execution)) !== binding.executionStateDigest ||
        execution.workflow.workflowId !== binding.ownerWorkflowId ||
        execution.job.acceptedAttemptId !== null ||
        attempt === undefined ||
        attempt.providerInvocation?.invocationId !== binding.invocationId ||
        attempt.providerInvocation.invocationRevision !== binding.invocationRevision) {
        throw providerAcceptanceBindingStale();
    }
    assertProviderRepairAuthorityCurrent(paths, record, request, binding.repair);
}
/**
 * Re-admit an already-launched completion without pretending the live Job is
 * still the pre-launch snapshot. Another leased Attempt may have won meanwhile;
 * the result CAS remains the sole authority that classifies that race.
 */
export function assertProviderInvocationAcceptanceBindingTerminalCurrent(paths, binding) {
    assertProviderAcceptanceBinding(binding);
    const record = readProviderInvocation(paths, binding.invocationId);
    const request = readProviderInvocationRequest(paths, binding.invocationId);
    if (record.investigationId !== binding.ownerWorkflowId ||
        record.requestDigest !== binding.requestDigest ||
        record.revision !== binding.invocationRevision ||
        record.state !== 'leased' ||
        record.lease === null ||
        record.leaseGeneration !== binding.leaseGeneration ||
        record.lease.generation !== binding.leaseGeneration) {
        throw providerAcceptanceBindingStale();
    }
    assertProviderInvocationNotTerminallyResolved(paths, record);
    assertProviderPromptContextCurrent(paths.root, binding.context);
    const authority = assertProviderExecutionAdmissionAuthority(readPrivateCanonicalJson(paths, providerExecutionAdmissionAuthorityPath(paths, binding), providerAcceptanceBindingStale, MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES), providerAcceptanceBindingStale);
    const projection = projectProviderInvocationExecution({ record, request });
    const execution = readExecutionJobState(paths, binding.executionJobId);
    const attempt = execution?.attempts.find(({ attemptId }) => attemptId === binding.executionAttemptId);
    const acceptedByDifferentAttempt = execution !== null &&
        execution.job.acceptedAttemptId !== null &&
        execution.job.acceptedAttemptId !== binding.executionAttemptId;
    if (canonicalJson(authority.acceptanceBinding) !== canonicalJson(binding) ||
        authority.acceptanceBindingDigest !== binding.bindingDigest ||
        authority.executionStateDigest !== binding.executionStateDigest ||
        authority.receiptRequirement !== binding.receiptRequirement ||
        projection.job.jobId !== binding.executionJobId ||
        projection.attempt.attemptId !== binding.executionAttemptId ||
        execution === null ||
        execution.workflow.workflowId !== binding.ownerWorkflowId ||
        execution.job.jobId !== binding.executionJobId ||
        (!acceptedByDifferentAttempt &&
            (execution.revision !== binding.executionRevision ||
                sha256(canonicalJson(execution)) !== binding.executionStateDigest)) ||
        attempt?.status !== 'leased' ||
        attempt.lease === null ||
        attempt.jobId !== binding.executionJobId ||
        attempt.leaseGeneration !== binding.leaseGeneration ||
        attempt.lease.generation !== binding.leaseGeneration ||
        attempt.providerInvocation?.invocationId !== binding.invocationId ||
        attempt.providerInvocation.invocationRevision !== binding.invocationRevision) {
        throw providerAcceptanceBindingStale();
    }
    assertProviderRepairAuthorityCurrent(paths, record, request, binding.repair);
}
export function claimProviderInvocation(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    if (typeof input.workerId !== 'string' ||
        input.workerId.trim().length === 0 ||
        Buffer.byteLength(input.workerId, 'utf8') > 256 ||
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs < 1 ||
        input.leaseDurationMs > request.limits.timeoutMs) {
        throw leaseInvalid();
    }
    const now = parseNow(input.now);
    return withProviderWorkerLifecycle(paths, () => claimProviderInvocationUnderLifecycleLock(paths, invocationId, input, now));
}
export function claimProviderInvocationForWorker(paths, requestedInvocationId, input) {
    return withProviderWorkerLifecycle(paths, (assertOwned) => claimProviderInvocationForWorkerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned));
}
export function claimProviderInvocationForWorkerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    if (typeof input.workerId !== 'string' ||
        input.workerId.trim().length === 0 ||
        Buffer.byteLength(input.workerId, 'utf8') > 256 ||
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs < 1 ||
        input.leaseDurationMs > request.limits.timeoutMs) {
        throw leaseInvalid();
    }
    const now = parseNow(input.now);
    assertOwned();
    const claim = claimProviderInvocationUnderLifecycleLock(paths, invocationId, input, now);
    const workerFenceToken = crypto.randomUUID();
    createProviderWorkerFence(paths, claim.record, workerFenceToken);
    assertOwned();
    return { ...claim, workerFenceToken };
}
function claimProviderInvocationUnderLifecycleLock(paths, invocationId, input, now) {
    const leaseToken = crypto.randomBytes(32).toString('hex');
    const record = updateProviderInvocation(paths, invocationId, input.expectedRevision, (current) => {
        assertProviderInvocationNotTerminallyResolved(paths, current);
        if (current.state === 'leased' &&
            current.lease !== null &&
            now >= Date.parse(current.lease.expiresAt)) {
            throw workflowError('PROVIDER_INVOCATION_LEASE_EXPIRED', 'Provider invocation lease expired and requires explicit recovery.', ExitCode.staleState);
        }
        if (current.state !== 'prepared') {
            throw workflowError('PROVIDER_INVOCATION_LEASE_CONFLICT', 'Provider invocation is not prepared or already has a lease.', ExitCode.conflict);
        }
        const generation = current.leaseGeneration + 1;
        return {
            ...current,
            revision: current.revision + 1,
            state: 'leased',
            leaseGeneration: generation,
            lease: {
                generation,
                workerId: input.workerId,
                tokenDigest: sha256(leaseToken),
                acquiredAt: new Date(now).toISOString(),
                expiresAt: new Date(now + input.leaseDurationMs + PROVIDER_COMPLETION_GRACE_MS).toISOString(),
            },
            result: null,
            failure: null,
            updatedAt: new Date(now).toISOString(),
        };
    });
    return { record, leaseToken };
}
function assertProviderInvocationNotTerminallyResolved(paths, invocation) {
    const resolutionNodeId = readHumanResolutionHead(paths, invocation.investigationId);
    if (resolutionNodeId === null) {
        return;
    }
    const resolution = readHumanResolutionNode(paths, resolutionNodeId);
    if (resolution.target.workflowId !== invocation.investigationId ||
        resolution.target.changeId !== invocation.changeId) {
        throw invocationInvalid();
    }
    if (['abort', 'supersede', 'quarantine', 'repair'].includes(resolution.decision.kind)) {
        throw workflowError('PROVIDER_INVOCATION_TERMINALLY_RESOLVED', 'Provider invocation belongs to a terminally resolved investigation.', ExitCode.guard);
    }
}
function createProviderWorkerFence(paths, record, ownerToken) {
    if (record.state !== 'leased' || record.lease === null) {
        throw providerWorkerFenceUnsafe();
    }
    const fence = {
        schemaVersion: 1,
        kind: 'provider-worker-fence',
        invocationId: record.invocationId,
        leaseGeneration: record.leaseGeneration,
        workerId: record.lease.workerId,
        leaseTokenDigest: record.lease.tokenDigest,
        ownerToken,
        pid: process.pid,
        acquiredAt: record.lease.acquiredAt,
    };
    createPrivateCanonicalJson(paths, providerWorkerFencePath(paths, record.invocationId), fence, providerWorkerFenceUnsafe, 'PROVIDER_INVOCATION_WORKER_FENCE_CONFLICT');
}
export function releaseProviderInvocationWorkerFence(paths, requestedInvocationId, ownerToken) {
    withProviderWorkerLifecycle(paths, (assertOwned) => releaseProviderInvocationWorkerFenceUnderLifecycleLock(paths, requestedInvocationId, ownerToken, assertOwned));
}
export function releaseProviderInvocationWorkerFenceForWorkerClaim(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        assertProviderWorkerFenceClaim(paths, invocationId, input);
        fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
        fsyncDirectory(paths.locks);
    }, 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
export function releaseProviderInvocationWorkerFenceUnderLifecycleLock(paths, requestedInvocationId, ownerToken, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    assertOwned();
    const fence = readProviderWorkerFence(paths, invocationId);
    if (fence === null ||
        fence.ownerToken !== ownerToken ||
        fence.pid !== process.pid) {
        throw providerWorkerFenceUnsafe();
    }
    assertOwned();
    fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
    fsyncDirectory(paths.locks);
    assertOwned();
}
export function assertProviderWorkersQuiescentUnderLifecycleLock(paths) {
    const stats = fs.lstatSync(paths.locks, { throwIfNoEntry: false });
    if (!stats) {
        return;
    }
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700) {
        throw providerWorkerFenceUnsafe();
    }
    const suffix = '.worker-active';
    for (const entry of fs
        .readdirSync(paths.locks, { withFileTypes: true })
        .filter(({ name }) => name.endsWith(suffix))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw providerWorkerFenceUnsafe();
        }
        const invocationId = assertInvocationId(entry.name.slice(0, -suffix.length));
        assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId);
    }
}
function assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId, options = {}) {
    const fence = readProviderWorkerFence(paths, invocationId);
    if (fence === null) {
        return;
    }
    const invocation = readProviderInvocation(paths, invocationId);
    if (invocation.leaseGeneration !== fence.leaseGeneration ||
        invocation.state === 'prepared' ||
        (invocation.state === 'leased' &&
            (invocation.lease === null ||
                invocation.lease.workerId !== fence.workerId ||
                invocation.lease.tokenDigest !== fence.leaseTokenDigest))) {
        throw providerWorkerFenceUnsafe();
    }
    if (isProcessAlive(fence.pid)) {
        throw workflowError('PROVIDER_INVOCATION_WORKER_ACTIVE', 'Provider invocation still has a live worker activity fence.', ExitCode.conflict, { details: { invocationId, pid: fence.pid } });
    }
    if (invocation.state === 'leased') {
        if (options.allowDeadLeasedFence === true) {
            return;
        }
        throw workflowError('PROVIDER_INVOCATION_WORKER_RECOVERY_REQUIRED', 'A dead provider worker still owns a leased invocation and requires explicit recovery.', ExitCode.conflict, { details: { invocationId, pid: fence.pid } });
    }
    fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
    fsyncDirectory(paths.locks);
}
function readProviderWorkerFence(paths, invocationId) {
    const filePath = providerWorkerFencePath(paths, invocationId);
    if (!privatePathExists(paths, filePath, providerWorkerFenceUnsafe)) {
        return null;
    }
    const value = readPrivateCanonicalJson(paths, filePath, providerWorkerFenceUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'invocationId',
            'leaseGeneration',
            'workerId',
            'leaseTokenDigest',
            'ownerToken',
            'pid',
            'acquiredAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-worker-fence' ||
        value.invocationId !== invocationId ||
        !Number.isSafeInteger(value.leaseGeneration) ||
        value.leaseGeneration < 1 ||
        typeof value.workerId !== 'string' ||
        value.workerId.length === 0 ||
        !isDigest(value.leaseTokenDigest) ||
        typeof value.ownerToken !== 'string' ||
        value.ownerToken.length === 0 ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 1 ||
        !isTimestamp(value.acquiredAt)) {
        throw providerWorkerFenceUnsafe();
    }
    return value;
}
function providerWorkerFenceDigest(fence) {
    return providerSha256(`workflow.provider-worker-fence.v1\n${canonicalJson(fence)}`);
}
function assertProviderWorkerFenceClaim(paths, invocationId, input) {
    const fence = readProviderWorkerFence(paths, invocationId);
    if (fence === null ||
        fence.leaseGeneration !== input.leaseGeneration ||
        fence.leaseTokenDigest !== sha256(input.leaseToken) ||
        fence.ownerToken !== input.workerFenceToken ||
        fence.pid !== process.pid) {
        throw providerWorkerFenceUnsafe();
    }
}
function providerWorkerFencePath(paths, invocationId) {
    return path.join(paths.locks, `${invocationId}.worker-active`);
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}
export function expireProviderInvocationLease(paths, requestedInvocationId, input) {
    return withProviderWorkerLifecycle(paths, (assertOwned) => expireProviderInvocationLeaseUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned));
}
export function expireProviderInvocationLeaseUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const now = parseNow(input.now);
    assertOwned();
    assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId, { allowDeadLeasedFence: true });
    const expired = updateProviderInvocation(paths, invocationId, input.expectedRevision, (current) => {
        if (current.state !== 'leased' ||
            current.lease === null ||
            now < Date.parse(current.lease.expiresAt)) {
            throw workflowError('PROVIDER_INVOCATION_LEASE_NOT_EXPIRED', 'Provider invocation lease is absent or still current.', ExitCode.guard);
        }
        return {
            ...current,
            revision: current.revision + 1,
            state: 'failed',
            lease: null,
            result: null,
            failure: {
                kind: 'retryable',
                code: 'PROVIDER_INVOCATION_LEASE_EXPIRED',
                message: 'The prior worker lease expired; retry requires a fresh invocation.',
            },
            updatedAt: new Date(now).toISOString(),
        };
    });
    assertOwned();
    assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId);
    return expired;
}
export function completeProviderInvocation(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const observed = readProviderInvocation(paths, invocationId);
    if (observed.revision !== input.expectedRevision) {
        throw providerCasMismatch(input.expectedRevision, observed.revision);
    }
    const acceptanceBinding = input.acceptanceBinding ??
        prepareProviderInvocationAcceptanceBinding(paths, invocationId, 'synchronous-no-activity');
    if (acceptanceBinding.receiptRequirement !== 'synchronous-no-activity') {
        throw invocationInvalid();
    }
    const request = readProviderInvocationRequest(paths, invocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    const result = evaluateProviderProcess(request, input.outcome, providerOutputValidator(request));
    assertProviderResultManifestBinding(manifest, result);
    const now = parseNow(input.now);
    return withProviderWorkerLifecycle(paths, () => updateProviderInvocation(paths, invocationId, input.expectedRevision, (current) => {
        assertCurrentLease(current, input.leaseGeneration, input.leaseToken, now);
        assertProviderInvocationAcceptanceBindingTerminalCurrent(paths, acceptanceBinding);
        const next = assertProviderInvocationRecord({
            ...current,
            revision: current.revision + 1,
            state: 'succeeded',
            lease: null,
            result,
            failure: null,
            updatedAt: new Date(now).toISOString(),
        });
        assertProviderRuntimeTerminalAuthorityPreflight(paths, request, next, result, null, invocationUnsafe);
        persistProviderCompletionCandidate(paths, {
            current,
            request,
            leaseGeneration: input.leaseGeneration,
            leaseToken: input.leaseToken,
            result,
            completedAt: new Date(now).toISOString(),
        });
        persistProviderExecutionResult(paths, current, request, input.leaseGeneration, input.leaseToken, result.outputDigest, now);
        if (input.simulateCrashAfterExecutionAcceptance === true) {
            throw workflowError('PROVIDER_COMPLETION_SIMULATED_CRASH', 'Simulated crash after durable execution acceptance.', ExitCode.internal);
        }
        return next;
    }));
}
/**
 * Complete one leased invocation directly from the fixed runner report. The
 * semantic output and runtime observation are revalidated independently; a
 * real report is never reconstructed through the fake stdout evaluator.
 */
export function completeProviderInvocationFromRunner(paths, requestedInvocationId, input) {
    return withProviderWorkerLifecycle(paths, (assertOwned) => completeProviderInvocationFromRunnerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned));
}
export function completeProviderInvocationFromRunnerForWorkerClaim(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return completeProviderInvocationFromRunnerUnderLifecycleLock(paths, invocationId, input, () => assertProviderWorkerFenceClaim(paths, invocationId, {
        leaseGeneration: input.leaseGeneration,
        leaseToken: input.leaseToken,
        workerFenceToken: input.workerFenceToken,
    }));
}
/**
 * Complete one fixed-runner result while the caller holds the repository
 * lifecycle lock. This seam lets lifecycle-owned subjects revalidate their
 * exact owner and publish terminal success in one critical section.
 */
export function completeProviderInvocationFromRunnerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    const manifest = readProviderInvocationManifest(paths, invocationId);
    const result = providerResultFromRunnerReport(request, input.report);
    assertProviderResultManifestBinding(manifest, result);
    const now = parseNow(input.now);
    assertProviderAcceptanceBinding(input.acceptanceBinding);
    if (input.acceptanceBinding.invocationId !== invocationId ||
        input.acceptanceBinding.requestDigest !== request.requestDigest) {
        throw providerAcceptanceBindingStale();
    }
    if ((input.acceptanceBinding.receiptRequirement === 'schema-v4') !==
        (input.runtimeProgress !== undefined)) {
        throw invocationInvalid();
    }
    const protocolReceipt = assertSuccessfulRunnerProtocolReceipt(input.report.wrapperProtocolReceipt, request, input.acceptanceBinding);
    if (protocolReceipt !== undefined && input.runtimeProgress === undefined) {
        throw invocationInvalid();
    }
    assertOwned();
    const completed = withCurrentProviderPromptContext(paths.root, input.acceptanceBinding.context, () => updateProviderInvocation(paths, invocationId, input.expectedRevision, (current) => {
        assertCurrentLease(current, input.leaseGeneration, input.leaseToken, now);
        assertProviderInvocationAcceptanceBindingTerminalCurrent(paths, input.acceptanceBinding);
        const runtimeReceipt = input.runtimeProgress === undefined
            ? undefined
            : createAgentRuntimeCompletionReceipt({
                current,
                request,
                acceptanceBinding: input.acceptanceBinding,
                terminalState: 'succeeded',
                failureCode: null,
                progress: input.runtimeProgress,
                ...(protocolReceipt === undefined ? {} : { protocolReceipt }),
                ...(protocolReceipt === undefined
                    ? {}
                    : {
                        hostExecutionBinding: input.report.hostExecutionBinding ?? null,
                    }),
            });
        const next = assertProviderInvocationRecord({
            ...current,
            revision: current.revision + 1,
            state: 'succeeded',
            lease: null,
            result,
            failure: null,
            ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
            updatedAt: new Date(now).toISOString(),
        });
        assertProviderRuntimeTerminalAuthorityPreflight(paths, request, next, result, runtimeReceipt ?? null, invocationUnsafe);
        const accepted = persistProviderExecutionResult(paths, current, request, input.leaseGeneration, input.leaseToken, result.outputDigest, now);
        if (runtimeReceipt !== undefined && !accepted) {
            throw workflowError('PROVIDER_ASYNC_RESULT_LATE_DUPLICATE', 'An async provider result cannot publish an accepted receipt after another Attempt already won the Job.', ExitCode.conflict);
        }
        persistProviderCompletionCandidate(paths, {
            current,
            request,
            leaseGeneration: input.leaseGeneration,
            leaseToken: input.leaseToken,
            result,
            completedAt: new Date(now).toISOString(),
            ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
        });
        if (input.simulateCrashAfterExecutionAcceptance === true) {
            throw workflowError('PROVIDER_COMPLETION_SIMULATED_CRASH', 'Simulated crash after durable execution acceptance.', ExitCode.internal);
        }
        return next;
    }, (next) => {
        if (input.simulateCrashAfterProviderStateWriteBeforeContinuationAuthority ===
            true) {
            throw workflowError('PROVIDER_CONTINUATION_AUTHORITY_SIMULATED_CRASH', 'Simulated crash after durable provider success and before native continuation authority publication.', ExitCode.internal);
        }
        publishProviderNativeContinuationAuthorityForRecord(paths, next);
    }));
    assertOwned();
    return completed;
}
export function providerCompletionCandidateExists(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return privatePathExists(paths, providerCompletionCandidatePath(paths, invocationId), invocationUnsafe);
}
/**
 * Recover the current invocation state from its exact durable Attempt result.
 * This path never scans or materializes historical invocation journals.
 */
export function recoverProviderInvocationCompletion(paths, requestedInvocationId, input) {
    return withProviderWorkerLifecycle(paths, (assertOwned) => recoverProviderInvocationCompletionForWorkerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned));
}
export function recoverProviderInvocationCompletionForWorkerUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    assertOwned();
    const current = readProviderInvocationForNativeContinuationRecovery(paths, invocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    const projection = projectProviderInvocationExecution({
        record: current,
        request,
    });
    const durable = readExecutionJobState(paths, projection.job.jobId);
    const result = durable?.results.find(({ attemptId }) => attemptId === projection.attempt.attemptId);
    if (result === undefined || result.acceptance !== 'accepted') {
        throw workflowError('PROVIDER_COMPLETION_RECOVERY_STATE_MISSING', 'Completion recovery requires the exact accepted current Attempt result.', ExitCode.staleState);
    }
    return recoverProviderInvocationCompletionUnderLifecycleLock(paths, invocationId, {
        expectedInvocationRevision: input.expectedRevision,
        acceptedOutputDigest: result.outputDigest.replace(/^sha256:/u, ''),
    }, assertOwned);
}
/**
 * Finalize only an already-durable Attempt result. The caller must hold the
 * repository lifecycle lock and prove the exact durable result identity; this
 * function never evaluates or re-runs provider work.
 */
export function recoverProviderInvocationCompletionUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    if (!Number.isSafeInteger(input.expectedInvocationRevision) ||
        input.expectedInvocationRevision < 0 ||
        !isDigest(input.acceptedOutputDigest)) {
        throw invocationInvalid();
    }
    assertOwned();
    assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId, { allowDeadLeasedFence: true });
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        assertOwned();
        const current = readProviderInvocationForNativeContinuationRecovery(paths, invocationId);
        const request = readProviderInvocationRequest(paths, invocationId);
        const candidatePath = providerCompletionCandidatePath(paths, invocationId);
        const candidate = privatePathExists(paths, candidatePath, invocationUnsafe)
            ? readProviderCompletionCandidate(paths, invocationId, request)
            : null;
        if (current.state === 'succeeded' && current.result !== null) {
            const candidateMatches = candidate === null ||
                (current.revision === candidate.expectedInvocationRevision + 1 &&
                    canonicalJson(current.result) === canonicalJson(candidate.result) &&
                    canonicalJson(current.runtimeReceipt ?? null) ===
                        canonicalJson(candidate.runtimeReceipt ?? null));
            const expectedRevisionMatches = current.revision === input.expectedInvocationRevision ||
                candidate?.expectedInvocationRevision ===
                    input.expectedInvocationRevision;
            if (candidateMatches &&
                expectedRevisionMatches &&
                current.result.outputDigest === input.acceptedOutputDigest) {
                const repairedContinuation = publishProviderNativeContinuationAuthorityForRecord(paths, current);
                const recovered = readProviderInvocation(paths, invocationId);
                return deepFreeze({
                    record: recovered,
                    repaired: repairedContinuation,
                    candidateDigest: candidate?.candidateDigest ?? null,
                });
            }
            throw providerCompletionRecoveryConflict();
        }
        if (current.state !== 'leased' ||
            current.lease === null ||
            candidate === null) {
            throw candidate === null && current.state === 'leased'
                ? workflowError('PROVIDER_COMPLETION_RECOVERY_ARTIFACT_REQUIRED', 'Durable acceptance cannot repair provider state without its exact completion candidate.', ExitCode.staleState)
                : providerCompletionRecoveryConflict();
        }
        if (current.revision !== input.expectedInvocationRevision ||
            candidate.expectedInvocationRevision !==
                input.expectedInvocationRevision ||
            candidate.leaseGeneration !== current.leaseGeneration ||
            candidate.leaseGeneration !== current.lease.generation ||
            candidate.leaseTokenDigest !== current.lease.tokenDigest ||
            candidate.result.outputDigest !== input.acceptedOutputDigest) {
            throw providerCompletionRecoveryConflict();
        }
        const executionEntries = providerExecutionEntries(paths, current, request);
        const next = assertProviderInvocationRecord({
            ...current,
            revision: current.revision + 1,
            state: 'succeeded',
            lease: null,
            result: candidate.result,
            failure: null,
            ...(candidate.runtimeReceipt === undefined
                ? {}
                : { runtimeReceipt: candidate.runtimeReceipt }),
            updatedAt: candidate.completedAt,
        });
        assertMonotonicInvocationTransition(current, next);
        assertOwned();
        writePrivateCanonicalJsonAtomic(paths, providerInvocationStatePath(paths, invocationId), next, invocationUnsafe);
        materializeProviderExecutionJob(paths, executionEntries.map((entry) => entry.record.invocationId === invocationId
            ? { ...entry, record: next, request }
            : entry));
        publishProviderNativeContinuationAuthorityForRecord(paths, next);
        const repaired = readProviderInvocation(paths, invocationId);
        assertOwned();
        assertProviderInvocationWorkerQuiescentUnderLifecycleLock(paths, invocationId);
        return deepFreeze({
            record: repaired,
            repaired: true,
            candidateDigest: candidate.candidateDigest,
        });
    }, 'PROVIDER_COMPLETION_RECOVERY_CONFLICT', invocationLockInvalid);
}
/**
 * Repair only the bounded state-success/continuation-marker crash window. The
 * permissive read is private to this recovery seam; its returned record is
 * always re-read through the strict public authority path after publication.
 */
export function recoverProviderInvocationNativeContinuationForReplay(paths, requestedInvocationId) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return withProviderWorkerLifecycle(paths, (assertOwned) => {
        assertOwned();
        const current = readProviderInvocationForNativeContinuationRecovery(paths, invocationId);
        if (current.state !== 'succeeded' || current.result === null)
            return null;
        const request = readProviderInvocationRequest(paths, invocationId);
        const projection = projectProviderInvocationExecution({
            record: current,
            request,
        });
        const durable = readExecutionJobState(paths, projection.job.jobId);
        const acceptedResult = durable?.results.find(({ attemptId, acceptance }) => attemptId === projection.attempt.attemptId && acceptance === 'accepted');
        if (acceptedResult?.outputDigest !== `sha256:${current.result.outputDigest}`) {
            throw providerCompletionRecoveryConflict();
        }
        return recoverProviderInvocationCompletionUnderLifecycleLock(paths, invocationId, {
            expectedInvocationRevision: current.revision,
            acceptedOutputDigest: current.result.outputDigest,
        }, assertOwned).record;
    });
}
function readProviderInvocationForNativeContinuationRecovery(paths, invocationId) {
    return readProviderInvocationCore(paths, invocationId, {
        allowPendingNativeContinuationAuthority: true,
    });
}
function persistProviderExecutionResult(paths, current, request, leaseGeneration, leaseToken, outputDigest, now, expectedExecutionRevision) {
    const entries = providerExecutionEntries(paths, current, request);
    const projection = projectProviderInvocationExecution({
        record: current,
        request,
    });
    const result = acceptProviderAttemptResult(paths, {
        entries,
        attemptId: projection.attempt.attemptId,
        leaseGeneration,
        leaseToken,
        outputDigest,
        completedAt: new Date(now).toISOString(),
        ...(expectedExecutionRevision === undefined
            ? {}
            : { expectedRevision: expectedExecutionRevision }),
    });
    if (result.result.attemptId !== projection.attempt.attemptId ||
        (result.accepted &&
            result.state.job.acceptedAttemptId !== projection.attempt.attemptId)) {
        throw workflowError('PROVIDER_RESULT_ACCEPTANCE_CAS_REJECTED', 'Provider result did not bind to the stable Job result CAS.', ExitCode.staleState);
    }
    return result.accepted;
}
function persistProviderCompletionCandidate(paths, input) {
    const result = assertProviderResult(input.request, input.result);
    const payload = {
        schemaVersion: 1,
        kind: 'provider-completion-candidate',
        invocationId: input.current.invocationId,
        requestDigest: input.request.requestDigest,
        expectedInvocationRevision: input.current.revision,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: sha256(input.leaseToken),
        result,
        ...(input.runtimeReceipt === undefined
            ? {}
            : { runtimeReceipt: input.runtimeReceipt }),
        completedAt: input.completedAt,
    };
    const candidate = {
        ...payload,
        candidateDigest: sha256(canonicalJson(payload)),
    };
    const filePath = providerCompletionCandidatePath(paths, input.current.invocationId);
    if (privatePathExists(paths, filePath, invocationUnsafe)) {
        const existing = readProviderCompletionCandidate(paths, input.current.invocationId, input.request);
        if (canonicalJson(existing) !== canonicalJson(candidate)) {
            throw workflowError('PROVIDER_COMPLETION_CANDIDATE_CONFLICT', 'A different completion candidate already exists for this invocation.', ExitCode.conflict);
        }
        return existing;
    }
    createPrivateCanonicalJson(paths, filePath, candidate, invocationUnsafe, 'PROVIDER_COMPLETION_CANDIDATE_CONFLICT');
    return readProviderCompletionCandidate(paths, input.current.invocationId, input.request);
}
function readProviderCompletionCandidate(paths, invocationId, request) {
    const value = readPrivateCanonicalJson(paths, providerCompletionCandidatePath(paths, invocationId), invocationUnsafe);
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'candidateDigest',
            'completedAt',
            'expectedInvocationRevision',
            'invocationId',
            'kind',
            'leaseGeneration',
            'leaseTokenDigest',
            'requestDigest',
            'result',
            ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
                ? ['runtimeReceipt']
                : []),
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-completion-candidate' ||
        value.invocationId !== invocationId ||
        value.requestDigest !== request.requestDigest ||
        !Number.isSafeInteger(value.expectedInvocationRevision) ||
        value.expectedInvocationRevision < 0 ||
        !Number.isSafeInteger(value.leaseGeneration) ||
        value.leaseGeneration < 1 ||
        !isDigest(value.leaseTokenDigest) ||
        !isTimestamp(value.completedAt) ||
        !isDigest(value.candidateDigest)) {
        throw invocationUnsafe();
    }
    const result = assertProviderResult(request, value.result);
    const runtimeReceipt = Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt, invocationUnsafe)
        : undefined;
    if (runtimeReceipt !== undefined &&
        (runtimeReceipt.invocationId !== invocationId ||
            runtimeReceipt.requestDigest !== request.requestDigest ||
            runtimeReceipt.leasedRevision !== value.expectedInvocationRevision ||
            runtimeReceipt.leaseGeneration !== value.leaseGeneration ||
            runtimeReceipt.terminalState !== 'succeeded')) {
        throw invocationUnsafe();
    }
    const payload = { ...value };
    delete payload.candidateDigest;
    if (sha256(canonicalJson(payload)) !== value.candidateDigest) {
        throw invocationUnsafe();
    }
    return deepFreeze({
        ...value,
        result,
        ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
    });
}
function materializeProviderExecutionState(paths, current, request) {
    const entries = providerExecutionEntries(paths, current, request);
    materializeProviderExecutionJob(paths, entries);
    return entries;
}
function providerExecutionEntries(paths, current, request) {
    const currentProjection = projectProviderInvocationExecution({
        record: current,
        request,
    });
    const entries = listProviderInvocationLifecycleProjections(paths)
        .filter((entry) => entry.investigationId === current.investigationId &&
        entry.purpose === current.purpose)
        .map((entry) => {
        if (entry.invocationId === current.invocationId) {
            return providerExecutionEntry(paths, current, request);
        }
        const historicalRecord = readProviderInvocation(paths, entry.invocationId);
        const historicalRequest = readProviderInvocationRequest(paths, entry.invocationId);
        return providerExecutionEntry(paths, historicalRecord, historicalRequest);
    })
        .filter((entry) => projectProviderInvocationExecution(entry).job.jobId ===
        currentProjection.job.jobId)
        .sort((left, right) => left.record.attempt - right.record.attempt ||
        left.record.invocationId.localeCompare(right.record.invocationId));
    if (entries.filter(({ record }) => record.invocationId === current.invocationId)
        .length !== 1) {
        throw workflowError('PROVIDER_EXECUTION_PROJECTION_MISSING', 'The current provider invocation is absent from execution projection.', ExitCode.staleState);
    }
    return entries;
}
function providerExecutionHistory(paths, investigationId, purpose, beforeAttempt, currentRequest) {
    const scan = scanProviderInvocationLifecycles(paths);
    const currentUnsafe = scan.unsafeInvocations.filter(({ invocationId }) => invocationId === currentRequest.invocationId);
    if (scan.unsafeInvocations.length !== currentUnsafe.length ||
        currentUnsafe.length > 1) {
        // Preserve the scanner's canonical fail-closed error for unrelated unsafe
        // invocation state.
        listProviderInvocationLifecycleProjections(paths);
        throw invocationUnsafe();
    }
    if (currentUnsafe.length === 1) {
        const pendingDirectory = providerInvocationDirectory(paths, currentRequest.invocationId);
        if (canonicalJson(fs.readdirSync(pendingDirectory).sort()) !==
            canonicalJson(['execution-policy.json'])) {
            throw invocationUnsafe();
        }
        readProviderExecutionPolicySnapshot(paths, currentRequest);
    }
    return scan.projections
        .filter((entry) => entry.investigationId === investigationId &&
        entry.purpose === purpose &&
        entry.attempt < beforeAttempt)
        .map((entry) => {
        const record = readProviderInvocation(paths, entry.invocationId);
        const request = readProviderInvocationRequest(paths, entry.invocationId);
        return providerExecutionEntry(paths, record, request);
    })
        .sort((left, right) => left.record.attempt - right.record.attempt ||
        left.record.invocationId.localeCompare(right.record.invocationId));
}
export function failProviderInvocation(paths, requestedInvocationId, input) {
    return withProviderWorkerLifecycle(paths, (assertOwned) => failProviderInvocationUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned));
}
export function failProviderInvocationForWorkerClaim(paths, requestedInvocationId, input) {
    const invocationId = assertInvocationId(requestedInvocationId);
    return failProviderInvocationUnderLifecycleLock(paths, invocationId, input, () => assertProviderWorkerFenceClaim(paths, invocationId, {
        leaseGeneration: input.leaseGeneration,
        leaseToken: input.leaseToken,
        workerFenceToken: input.workerFenceToken,
    }));
}
export function failProviderInvocationUnderLifecycleLock(paths, requestedInvocationId, input, assertOwned) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const request = readProviderInvocationRequest(paths, invocationId);
    const now = parseNow(input.now);
    const failure = assertProviderFailure(input.failure);
    assertOwned();
    const failed = updateProviderInvocation(paths, invocationId, input.expectedRevision, (current) => {
        assertCurrentLease(current, input.leaseGeneration, input.leaseToken, now);
        const runtimeReceipt = input.runtimeEvidence === undefined
            ? undefined
            : createAgentRuntimeCompletionReceipt({
                current,
                request,
                acceptanceBinding: input.runtimeEvidence.acceptanceBinding,
                terminalState: 'failed',
                failureCode: failure.code,
                progress: input.runtimeEvidence.progress,
                ...(input.runtimeEvidence.protocolReceipt === undefined
                    ? {}
                    : {
                        protocolReceipt: input.runtimeEvidence.protocolReceipt,
                    }),
                ...(input.runtimeEvidence.hostExecutionBinding === undefined
                    ? {}
                    : {
                        hostExecutionBinding: input.runtimeEvidence.hostExecutionBinding,
                    }),
            });
        const next = assertProviderInvocationRecord({
            ...current,
            revision: current.revision + 1,
            state: 'failed',
            lease: null,
            result: null,
            failure,
            ...(runtimeReceipt === undefined ? {} : { runtimeReceipt }),
            updatedAt: new Date(now).toISOString(),
        });
        assertProviderRuntimeDurableAuthorities(paths, request, next, next.result, next.runtimeReceipt ?? null, invocationUnsafe);
        if (input.repair !== undefined) {
            persistProviderRepairEvidence(paths, {
                record: current,
                request,
                failure,
                repair: input.repair,
                recordedAt: new Date(now).toISOString(),
            });
        }
        return next;
    });
    assertOwned();
    return failed;
}
function createAgentRuntimeCompletionReceipt(input) {
    assertProviderAcceptanceBinding(input.acceptanceBinding);
    if (input.current.state !== 'leased' ||
        input.current.lease === null ||
        input.acceptanceBinding.invocationId !== input.current.invocationId ||
        input.acceptanceBinding.requestDigest !== input.request.requestDigest ||
        input.acceptanceBinding.requestDigest !== input.current.requestDigest ||
        input.acceptanceBinding.invocationRevision !== input.current.revision ||
        input.acceptanceBinding.leaseGeneration !== input.current.leaseGeneration ||
        (input.terminalState === 'succeeded'
            ? input.failureCode !== null
            : typeof input.failureCode !== 'string' || input.failureCode.length === 0)) {
        throw providerAcceptanceBindingStale();
    }
    const progress = assertAgentRuntimeProcessProgress(input.progress, invocationInvalid);
    const fields = {
        kind: 'agent-runtime-completion-receipt',
        invocationId: input.current.invocationId,
        requestDigest: input.request.requestDigest,
        leasedRevision: input.current.revision,
        terminalRevision: input.current.revision + 1,
        leaseGeneration: input.current.leaseGeneration,
        executionJobId: input.acceptanceBinding.executionJobId,
        executionAttemptId: input.acceptanceBinding.executionAttemptId,
        executionRevision: input.acceptanceBinding.executionRevision,
        executionStateDigest: input.acceptanceBinding.executionStateDigest,
        acceptanceBindingDigest: input.acceptanceBinding.bindingDigest,
        terminalState: input.terminalState,
        launched: true,
        progress,
    };
    const protocolReceipt = input.protocolReceipt === undefined
        ? undefined
        : input.terminalState === 'succeeded'
            ? assertSuccessfulRunnerProtocolReceipt(input.protocolReceipt, input.request, input.acceptanceBinding)
            : assertFailedRunnerProtocolReceipt(input.protocolReceipt, input.request, input.acceptanceBinding);
    const payload = {
        schemaVersion: 4,
        ...fields,
        terminalDisposition: input.terminalState === 'succeeded'
            ? 'accepted'
            : protocolReceipt?.terminal === 'result'
                ? 'rejected-after-result'
                : 'failed-before-result',
        failureCode: input.failureCode,
        acceptanceBinding: input.acceptanceBinding,
        protocolReceipt: protocolReceipt ?? null,
        hostExecutionBinding: input.hostExecutionBinding ?? null,
    };
    return assertAgentRuntimeCompletionReceipt({
        ...payload,
        receiptDigest: sha256(canonicalJson(payload)),
    }, invocationInvalid);
}
function publishProviderNativeContinuationAuthorityForRecord(paths, record) {
    const receipt = record.runtimeReceipt;
    if (record.state !== 'succeeded' ||
        receipt?.schemaVersion !== 4 ||
        receipt.terminalState !== 'succeeded' ||
        receipt.terminalDisposition !== 'accepted' ||
        receipt.failureCode !== null ||
        receipt.hostExecutionBinding?.phase !== 'native-terminal' ||
        receipt.hostExecutionBinding.nativeSessionClaim === null ||
        receipt.hostExecutionBinding.nativeSessionCompletionDigest === null) {
        return false;
    }
    const assignment = receipt.hostExecutionBinding.assignmentBinding;
    const claim = receipt.hostExecutionBinding.nativeSessionClaim;
    const authorityPath = providerNativeSessionContinuationAuthorityObjectPathV1(providerNativeSessionStorePathsV1(paths), receipt.hostExecutionBinding.nativeSessionCompletionDigest);
    const existed = fs.lstatSync(authorityPath, { throwIfNoEntry: false }) !== undefined;
    publishProviderNativeSessionContinuationAuthorityV1(paths, {
        changeId: assignment.changeId,
        planningGeneration: assignment.planningGeneration,
        assignmentRecordDigest: assignment.recordDigest,
        sessionSlotId: claim.scope.sessionSlotId,
        completionDigest: receipt.hostExecutionBinding.nativeSessionCompletionDigest,
    });
    return !existed;
}
function assertSuccessfulRunnerProtocolReceipt(value, request, acceptanceBinding) {
    if (value === undefined)
        return undefined;
    let receipt;
    try {
        receipt = assertProviderRuntimeProtocolReceipt(value, {
            invocationId: request.invocationId,
            requestDigest: request.requestDigest,
            attemptId: acceptanceBinding.executionAttemptId,
        });
    }
    catch {
        throw invocationInvalid();
    }
    if (receipt.terminal !== 'result' ||
        receipt.outputSlot !== 'primary' ||
        receipt.errorCode !== null ||
        receipt.cancellation.acknowledged ||
        receipt.cancellation.forced) {
        throw invocationInvalid();
    }
    return receipt;
}
function assertFailedRunnerProtocolReceipt(value, request, acceptanceBinding) {
    if (value === undefined)
        return undefined;
    let receipt;
    try {
        receipt = assertProviderRuntimeProtocolReceipt(value, {
            invocationId: request.invocationId,
            requestDigest: request.requestDigest,
            attemptId: acceptanceBinding.executionAttemptId,
        });
    }
    catch {
        throw invocationInvalid();
    }
    if ((receipt.terminal === 'error' &&
        (receipt.outputSlot !== null ||
            receipt.errorCode === null ||
            receipt.cancellation.acknowledged ||
            receipt.cancellation.forced)) ||
        (receipt.terminal === 'cancelled' &&
            (receipt.outputSlot !== null ||
                receipt.errorCode !== null ||
                !receipt.cancellation.requested))) {
        throw invocationInvalid();
    }
    return receipt;
}
function withProviderWorkerLifecycle(paths, operation) {
    const runtimeRoot = path.dirname(paths.root);
    return withRepositoryLifecycleOperation(runtimePaths(path.dirname(runtimeRoot), path.basename(runtimeRoot)), operation);
}
function updateProviderInvocation(paths, invocationId, expectedRevision, transition, afterStateWrite) {
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${invocationId}.lock`), () => {
        const current = readProviderInvocation(paths, invocationId);
        if (expectedRevision !== undefined &&
            current.revision !== expectedRevision) {
            throw providerCasMismatch(expectedRevision, current.revision);
        }
        // Re-admit the current durable Job/Attempt lineage before mutating the
        // provider state file. A missing/tampered repair sidecar must fail closed
        // without leaving a lease or other partially applied lifecycle change.
        const request = readProviderInvocationRequest(paths, invocationId);
        const executionEntries = materializeProviderExecutionState(paths, current, request);
        const next = assertProviderInvocationRecord(transition(current));
        assertMonotonicInvocationTransition(current, next);
        assertProviderRuntimeDurableAuthorities(paths, request, next, next.result, next.runtimeReceipt ?? null, invocationUnsafe, { allowPendingNativeContinuationAuthority: true });
        writePrivateCanonicalJsonAtomic(paths, providerInvocationStatePath(paths, invocationId), next, invocationUnsafe);
        materializeProviderExecutionJob(paths, executionEntries.map((entry) => entry.record.invocationId === invocationId
            ? { ...entry, record: next, request }
            : entry));
        afterStateWrite?.(next);
        return readProviderInvocation(paths, invocationId);
    }, 'PROVIDER_INVOCATION_OPERATION_CONFLICT', invocationLockInvalid);
}
function providerExecutionEntry(paths, record, request) {
    const retryReservation = record.attempt < 2
        ? null
        : readProviderRetryReservation(paths, record.investigationId, record.attempt);
    if (retryReservation !== null &&
        (retryReservation.invocationId !== record.invocationId ||
            retryReservation.requestDigest !== request.requestDigest ||
            retryReservation.manifestDigest !== record.manifestDigest)) {
        throw invocationUnsafe();
    }
    return {
        record,
        request,
        retryAccounting: readProviderExecutionPolicySnapshot(paths, request)
            .accounting,
        retryReplacement: retryReservation?.schemaVersion === 3
            ? retryReservation.replacement
            : null,
    };
}
function assertBlindSurveyManifest(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            'repositoryId',
            'baseCommit',
            'baseTree',
            'normalizedIntent',
            'architectureQuestion',
            'capabilityProfile',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'blind-survey-manifest' ||
        typeof value.changeId !== 'string' ||
        !isBoundedBlindText(value.repositoryId, 512) ||
        typeof value.baseCommit !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseCommit) ||
        typeof value.baseTree !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseTree) ||
        !isBoundedBlindText(value.architectureQuestion, MAX_ARCHITECTURE_QUESTION_BYTES) ||
        value.capabilityProfile !== 'repository-read-only') {
        throw blindManifestInvalid();
    }
    assertChangeId(value.changeId);
    assertNormalizedChangeIntent(value.normalizedIntent);
    if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_BLIND_MANIFEST_BYTES) {
        throw blindManifestInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function assertProviderInvocationManifest(value) {
    if (isRecord(value) && value.kind === 'blind-survey-manifest') {
        return assertBlindSurveyManifest(value);
    }
    if (isRecord(value) &&
        value.kind === 'task-diff-review-continuation-manifest') {
        return assertTaskDiffReviewContinuationManifest(value);
    }
    if (isRecord(value) && value.kind === 'task-diff-review-manifest') {
        return assertTaskDiffReviewManifest(value);
    }
    if (isRecord(value) &&
        value.kind === 'task-strategy-implementation-manifest') {
        try {
            return assertTaskStrategyImplementationManifest(value);
        }
        catch {
            throw invocationInvalid();
        }
    }
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            'repositoryId',
            'baseCommit',
            'baseTree',
            'subject',
            ...(Object.hasOwn(value, 'planningTarget')
                ? ['planningTarget']
                : []),
            'capabilityProfile',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'plan-review-manifest' ||
        typeof value.changeId !== 'string' ||
        !isBoundedBlindText(value.repositoryId, 512) ||
        typeof value.baseCommit !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseCommit) ||
        typeof value.baseTree !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseTree) ||
        value.capabilityProfile !== 'repository-read-only') {
        throw invocationInvalid();
    }
    assertChangeId(value.changeId);
    let subject;
    let planningTarget;
    try {
        subject = assertPlanReviewSubject(value.subject);
        planningTarget =
            value.planningTarget === undefined
                ? undefined
                : assertPlanReviewTargetSnapshot(value.planningTarget);
    }
    catch {
        throw invocationInvalid();
    }
    if (planningTarget !== undefined &&
        (planningTarget.changeId !== value.changeId ||
            planningTarget.subjectDigest !== subject.subjectDigest ||
            planningTarget.planningGenerationId !== subject.planningGenerationId ||
            planningTarget.planTargetDigest !== subject.planTargetDigest)) {
        throw invocationInvalid();
    }
    const manifest = {
        schemaVersion: 1,
        kind: 'plan-review-manifest',
        changeId: value.changeId,
        repositoryId: value.repositoryId,
        baseCommit: value.baseCommit,
        baseTree: value.baseTree,
        subject,
        ...(planningTarget ? { planningTarget } : {}),
        capabilityProfile: 'repository-read-only',
    };
    if (Buffer.byteLength(canonicalJson(manifest), 'utf8') >
        MAX_BLIND_MANIFEST_BYTES) {
        throw invocationInvalid();
    }
    return deepFreeze(manifest);
}
function assertTaskDiffReviewManifest(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            'taskId',
            'sessionId',
            'repositoryId',
            'repositoryIdentity',
            'baseCommit',
            'baseTree',
            'subject',
            'reviewScope',
            'capabilityProfile',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-manifest' ||
        typeof value.changeId !== 'string' ||
        typeof value.taskId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !isBoundedBlindText(value.repositoryId, 512) ||
        !isBoundedBlindText(value.repositoryIdentity, 512) ||
        typeof value.baseCommit !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseCommit) ||
        typeof value.baseTree !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseTree) ||
        value.capabilityProfile !== 'repository-read-only') {
        throw invocationInvalid();
    }
    try {
        assertChangeId(value.changeId);
        assertTaskId(value.taskId);
        assertSessionId(value.sessionId);
    }
    catch {
        throw invocationInvalid();
    }
    let subject;
    let reviewScope;
    try {
        subject = parseTaskDiffReviewSubject(value.subject);
        reviewScope = parseTaskDiffReviewScope(value.reviewScope);
    }
    catch {
        throw invocationInvalid();
    }
    if (subject.changeId !== value.changeId ||
        subject.taskId !== value.taskId ||
        subject.repositoryId !== value.repositoryIdentity ||
        subject.baseCommit !== value.baseCommit ||
        subject.baseTree !== value.baseTree ||
        reviewScope.currentSubjectDigest !== subject.subjectDigest) {
        throw invocationInvalid();
    }
    const manifest = {
        schemaVersion: 1,
        kind: 'task-diff-review-manifest',
        changeId: value.changeId,
        taskId: value.taskId,
        sessionId: value.sessionId,
        repositoryId: value.repositoryId,
        repositoryIdentity: value.repositoryIdentity,
        baseCommit: value.baseCommit,
        baseTree: value.baseTree,
        subject,
        reviewScope,
        capabilityProfile: 'repository-read-only',
    };
    if (Buffer.byteLength(canonicalJson(manifest), 'utf8') >
        MAX_BLIND_MANIFEST_BYTES) {
        throw invocationInvalid();
    }
    return deepFreeze(manifest);
}
function assertTaskDiffReviewContinuationManifest(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            'taskId',
            'sessionId',
            'repositoryId',
            'repositoryIdentity',
            'baseCommit',
            'baseTree',
            'subject',
            'review',
            'response',
            'capabilityProfile',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-continuation-manifest' ||
        typeof value.changeId !== 'string' ||
        typeof value.taskId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !isBoundedBlindText(value.repositoryId, 512) ||
        !isBoundedBlindText(value.repositoryIdentity, 512) ||
        typeof value.baseCommit !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseCommit) ||
        typeof value.baseTree !== 'string' ||
        !GIT_OBJECT_ID.test(value.baseTree) ||
        value.capabilityProfile !== 'repository-read-only') {
        throw invocationInvalid();
    }
    try {
        assertChangeId(value.changeId);
        assertTaskId(value.taskId);
        assertSessionId(value.sessionId);
    }
    catch {
        throw invocationInvalid();
    }
    let subject;
    let review;
    let response;
    try {
        subject = parseTaskDiffReviewSubject(value.subject);
        review = parseTaskDiffReviewRecord(value.review);
        response = assertTaskDiffReviewChallengeResponseCurrent(review, parseTaskDiffReviewChallengeResponseRecord(value.response));
    }
    catch {
        throw invocationInvalid();
    }
    if (subject.changeId !== value.changeId ||
        subject.taskId !== value.taskId ||
        subject.repositoryId !== value.repositoryIdentity ||
        subject.baseCommit !== value.baseCommit ||
        subject.baseTree !== value.baseTree ||
        review.subjectDigest !== subject.subjectDigest ||
        canonicalJson(review.subject) !== canonicalJson(subject)) {
        throw invocationInvalid();
    }
    const manifest = {
        schemaVersion: 1,
        kind: 'task-diff-review-continuation-manifest',
        changeId: value.changeId,
        taskId: value.taskId,
        sessionId: value.sessionId,
        repositoryId: value.repositoryId,
        repositoryIdentity: value.repositoryIdentity,
        baseCommit: value.baseCommit,
        baseTree: value.baseTree,
        subject,
        review,
        response,
        capabilityProfile: 'repository-read-only',
    };
    if (Buffer.byteLength(canonicalJson(manifest), 'utf8') >
        MAX_BLIND_MANIFEST_BYTES) {
        throw invocationInvalid();
    }
    return deepFreeze(manifest);
}
function assertNormalizedChangeIntent(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'summary',
            'explicitPaths',
            'explicitSymbols',
            'explicitConfigKeys',
            'renamePairs',
        ]) ||
        value.schemaVersion !== 1 ||
        !isBoundedBlindText(value.summary, MAX_INTENT_SUMMARY_BYTES) ||
        !isUniqueBoundedBlindStringArray(value.explicitPaths) ||
        !isUniqueBoundedBlindStringArray(value.explicitSymbols) ||
        !isUniqueBoundedBlindStringArray(value.explicitConfigKeys) ||
        !Array.isArray(value.renamePairs) ||
        value.renamePairs.length > MAX_INTENT_FACTS_PER_KIND) {
        throw blindManifestInvalid();
    }
    const seenPairs = new Set();
    for (const pair of value.renamePairs) {
        if (!isRecord(pair) ||
            !hasExactKeys(pair, ['from', 'to']) ||
            !isBoundedBlindFact(pair.from) ||
            !isBoundedBlindFact(pair.to) ||
            pair.from === pair.to) {
            throw blindManifestInvalid();
        }
        const key = canonicalJson(pair);
        if (seenPairs.has(key)) {
            throw blindManifestInvalid();
        }
        seenPairs.add(key);
    }
    return deepFreeze(structuredClone(value));
}
function isUniqueBoundedBlindStringArray(value) {
    if (!Array.isArray(value) ||
        value.length > MAX_INTENT_FACTS_PER_KIND ||
        !value.every(isBoundedBlindFact)) {
        return false;
    }
    return new Set(value).size === value.length;
}
function isBoundedBlindFact(value) {
    return (isBoundedBlindText(value, MAX_INTENT_FACT_BYTES) &&
        !containsDisallowedControl(value));
}
function isBoundedBlindText(value, maximumBytes) {
    return (typeof value === 'string' &&
        value.trim().length > 0 &&
        value === value.trim() &&
        Buffer.byteLength(value, 'utf8') <= maximumBytes &&
        !value.includes('\u0000'));
}
function containsDisallowedControl(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
            return true;
        }
    }
    return false;
}
function assertInvestigationStartReservation(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'changeId',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'investigationId',
            'invocationId',
            'repositoryRoot',
            'gitCommonDirectory',
            'branch',
            'baseline',
            'manifestDigest',
            'requestDigest',
            'manifest',
            'request',
            'createdAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'investigation-start-reservation' ||
        typeof value.changeId !== 'string' ||
        (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
            !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
        typeof value.investigationId !== 'string' ||
        typeof value.invocationId !== 'string' ||
        typeof value.repositoryRoot !== 'string' ||
        !path.isAbsolute(value.repositoryRoot) ||
        typeof value.gitCommonDirectory !== 'string' ||
        !path.isAbsolute(value.gitCommonDirectory) ||
        (value.branch !== null &&
            (typeof value.branch !== 'string' || value.branch.length === 0)) ||
        !isBaseline(value.baseline) ||
        !isDigest(value.manifestDigest) ||
        !isDigest(value.requestDigest) ||
        !isTimestamp(value.createdAt)) {
        throw invocationInvalid();
    }
    const changeId = assertChangeId(value.changeId);
    const investigationId = assertInvestigationId(value.investigationId);
    const invocationId = assertInvocationId(value.invocationId);
    const manifest = assertBlindSurveyManifest(value.manifest);
    const request = assertProviderRequest(value.request);
    const manifestDigest = blindSurveyManifestDigest(manifest);
    assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
    if (invocationId !== request.invocationId ||
        value.manifestDigest !== manifestDigest ||
        value.requestDigest !== request.requestDigest ||
        value.baseline.head !== manifest.baseCommit ||
        value.baseline.tree !== manifest.baseTree) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone({
        ...value,
        changeId,
        investigationId,
        invocationId,
        manifest,
        request,
    }));
}
function assertProviderRetryReservation(value) {
    const baseKeys = [
        'schemaVersion',
        'kind',
        'investigationId',
        'changeId',
        'attempt',
        'previousInvocationId',
        'invocationId',
        'manifestDigest',
        'requestDigest',
        'request',
        'createdAt',
    ];
    if (!isRecord(value) ||
        (value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
        !hasExactKeys(value, [
            ...baseKeys,
            'executionPolicySnapshot',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'retryDecision',
            ...(value.schemaVersion === 3 ? ['replacement'] : []),
        ]) ||
        value.kind !== 'provider-retry-reservation' ||
        typeof value.investigationId !== 'string' ||
        typeof value.changeId !== 'string' ||
        (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
            !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 2 ||
        typeof value.previousInvocationId !== 'string' ||
        typeof value.invocationId !== 'string' ||
        !isDigest(value.manifestDigest) ||
        !isDigest(value.requestDigest) ||
        !isTimestamp(value.createdAt)) {
        throw invocationInvalid();
    }
    assertInvestigationId(value.investigationId);
    assertChangeId(value.changeId);
    assertInvocationId(value.previousInvocationId);
    const invocationId = assertInvocationId(value.invocationId);
    const request = assertProviderRequest(value.request);
    const retryDecision = assertProviderRetryDecisionBinding(value.retryDecision);
    const executionPolicySnapshot = assertEmbeddedProviderExecutionPolicySnapshot(value.executionPolicySnapshot, request);
    const replacement = value.schemaVersion === 3
        ? assertProviderRetryReplacementBinding(value.replacement)
        : undefined;
    if (invocationId !== request.invocationId ||
        value.requestDigest !== request.requestDigest ||
        value.previousInvocationId === invocationId ||
        (replacement !== undefined &&
            (replacement.attemptId !== `attempt-provider-${invocationId}` ||
                request.authorizationNodeId !== replacement.authorizationNodeId))) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone({
        ...value,
        invocationId,
        request,
        retryDecision,
        executionPolicySnapshot,
        ...(replacement === undefined ? {} : { replacement }),
    }));
}
function assertEmbeddedProviderExecutionPolicySnapshot(value, request) {
    try {
        return validateProviderExecutionPolicySnapshot(request, value);
    }
    catch {
        throw invocationInvalid();
    }
}
function assertProviderRetryDecisionBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'evaluatedAt',
            'evidenceDigest',
            'executionJobId',
            'executionRevision',
            'failedAttemptId',
            'kind',
            'schemaVersion',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-retry-decision-binding' ||
        typeof value.executionJobId !== 'string' ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
        !Number.isSafeInteger(value.executionRevision) ||
        value.executionRevision < 0 ||
        typeof value.failedAttemptId !== 'string' ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
        typeof value.evidenceDigest !== 'string' ||
        !DIGEST.test(value.evidenceDigest) ||
        !isTimestamp(value.evaluatedAt)) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function assertProviderRetryReplacementBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'attemptId',
            'retryMode',
            'strategyChanges',
            'environmentDigest',
            'executionGrantId',
            'authorizationNodeId',
            'reservationNodeId',
        ]) ||
        typeof value.attemptId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.attemptId) ||
        ![
            'same-input',
            'execution-policy-change',
            'repair',
            'strategy-change',
        ].includes(value.retryMode) ||
        !Array.isArray(value.strategyChanges) ||
        value.strategyChanges.length > 32 ||
        value.strategyChanges.some((entry) => typeof entry !== 'string' ||
            entry.length < 1 ||
            Buffer.byteLength(entry, 'utf8') > 512) ||
        new Set(value.strategyChanges).size !== value.strategyChanges.length ||
        typeof value.environmentDigest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.environmentDigest) ||
        (value.executionGrantId !== null &&
            (typeof value.executionGrantId !== 'string' ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.executionGrantId))) ||
        typeof value.authorizationNodeId !== 'string' ||
        !DIGEST.test(value.authorizationNodeId) ||
        typeof value.reservationNodeId !== 'string' ||
        !DIGEST.test(value.reservationNodeId) ||
        (value.retryMode === 'strategy-change') !== value.strategyChanges.length > 0) {
        throw invocationInvalid();
    }
    return deepFreeze({
        attemptId: value.attemptId,
        retryMode: value.retryMode,
        strategyChanges: [...value.strategyChanges],
        environmentDigest: value.environmentDigest,
        executionGrantId: value.executionGrantId,
        authorizationNodeId: value.authorizationNodeId,
        reservationNodeId: value.reservationNodeId,
    });
}
function assertProviderRequest(value) {
    if (!isRecord(value)) {
        throw invocationInvalid();
    }
    try {
        const reconstructed = createProviderInvocationRequest({
            invocationId: value.invocationId,
            nonce: value.nonce,
            purpose: value.purpose,
            providerId: value.providerId,
            roleAssignment: value.roleAssignment,
            capabilityProfile: value.capabilityProfile,
            repositoryId: value.repositoryId,
            baseCommit: value.baseCommit,
            baseTree: value.baseTree,
            targetDigest: value.targetDigest,
            inputManifestDigest: value.inputManifestDigest,
            authorizationNodeId: value.authorizationNodeId,
            writeAllowedPaths: value.writeAllowedPaths,
            outputSchema: value.outputSchema,
            evaluatorVersion: value.evaluatorVersion,
            policyDigest: value.policyDigest,
            limits: value.limits,
        });
        if (canonicalJson(reconstructed) !== canonicalJson(value)) {
            throw invocationInvalid();
        }
        assertInvocationId(reconstructed.invocationId);
        return reconstructed;
    }
    catch {
        throw invocationInvalid();
    }
}
function assertBlindInvocationBinding(changeId, manifest, manifestDigest, request) {
    if (manifest.changeId !== changeId ||
        manifest.repositoryId !== request.repositoryId ||
        manifest.baseCommit !== request.baseCommit ||
        manifest.baseTree !== request.baseTree ||
        request.purpose !== 'survey' ||
        request.roleAssignment.role !== 'blind-surveyor' ||
        request.capabilityProfile !== 'repository-read-only' ||
        request.targetDigest !== blindSurveyIntentDigest(manifest) ||
        request.inputManifestDigest !== manifestDigest ||
        request.roleAssignment.targetDigest !== request.targetDigest) {
        throw invocationInvalid();
    }
}
function assertProviderInvocationBinding(changeId, manifest, manifestDigest, request) {
    if (manifest.kind === 'blind-survey-manifest') {
        assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
        return;
    }
    if (manifest.kind === 'task-diff-review-manifest') {
        if (manifest.changeId !== changeId ||
            manifest.repositoryId !== request.repositoryId ||
            manifest.baseCommit !== request.baseCommit ||
            manifest.baseTree !== request.baseTree ||
            request.purpose !== 'task-diff-review' ||
            request.roleAssignment.role !== 'task-diff-reviewer' ||
            request.capabilityProfile !== 'repository-read-only' ||
            request.targetDigest !== manifest.subject.subjectDigest ||
            request.inputManifestDigest !== manifestDigest ||
            request.roleAssignment.targetDigest !== request.targetDigest) {
            throw invocationInvalid();
        }
        return;
    }
    if (manifest.kind === 'task-diff-review-continuation-manifest') {
        if (manifest.changeId !== changeId ||
            manifest.repositoryId !== request.repositoryId ||
            manifest.baseCommit !== request.baseCommit ||
            manifest.baseTree !== request.baseTree ||
            request.purpose !== 'task-diff-review' ||
            request.roleAssignment.role !== 'task-diff-reviewer' ||
            request.capabilityProfile !== 'repository-read-only' ||
            request.targetDigest !== manifest.subject.subjectDigest ||
            request.inputManifestDigest !== manifestDigest ||
            request.roleAssignment.targetDigest !== request.targetDigest ||
            request.providerId !== manifest.review.assignment.reviewerProviderId ||
            request.roleAssignment.providerId !==
                manifest.review.assignment.reviewerProviderId ||
            request.roleAssignment.sessionId ===
                manifest.review.assignment.reviewerSessionId ||
            !matchesPersistedProviderOutputSchema(request.outputSchema, TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA)) {
            throw invocationInvalid();
        }
        return;
    }
    if (manifest.kind === 'task-strategy-implementation-manifest') {
        if (manifest.subject.changeId !== changeId ||
            manifest.repositoryId !== request.repositoryId ||
            manifest.baseCommit !== request.baseCommit ||
            manifest.baseTree !== request.baseTree ||
            request.purpose !== 'task-implementation' ||
            request.roleAssignment.role !== 'task-implementer' ||
            request.capabilityProfile !== 'repository-read-only' ||
            request.targetDigest !== manifest.subject.subjectDigest ||
            request.inputManifestDigest !== manifestDigest ||
            request.roleAssignment.targetDigest !== request.targetDigest ||
            !matchesPersistedProviderOutputSchema(request.outputSchema, TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA)) {
            throw invocationInvalid();
        }
        return;
    }
    if (manifest.changeId !== changeId ||
        manifest.repositoryId !== request.repositoryId ||
        manifest.baseCommit !== request.baseCommit ||
        manifest.baseTree !== request.baseTree ||
        request.purpose !== 'plan-review' ||
        request.roleAssignment.role !== 'plan-reviewer' ||
        request.capabilityProfile !== 'repository-read-only' ||
        request.targetDigest !== manifest.subject.subjectDigest ||
        request.inputManifestDigest !== manifestDigest ||
        request.roleAssignment.targetDigest !== request.targetDigest) {
        throw invocationInvalid();
    }
}
function createPlanReviewSnapshotFiles(paths, invocationDirectory, manifest, files) {
    if (manifest.kind !== 'plan-review-manifest') {
        if (files !== undefined)
            throw invocationInvalid();
        return;
    }
    if (manifest.planningTarget === undefined) {
        if (files !== undefined)
            throw invocationInvalid();
        return;
    }
    if (!Array.isArray(files))
        throw invocationInvalid();
    const expected = manifest.planningTarget.artifacts;
    if (files.length !== expected.length)
        throw invocationInvalid();
    const byName = new Map(files.map((entry) => [entry.snapshotFile, entry]));
    if (byName.size !== files.length)
        throw invocationInvalid();
    const root = path.join(invocationDirectory, 'review-root');
    ensurePrivateInvestigationDirectory(paths, root, invocationUnsafe);
    for (const artifact of expected) {
        const supplied = byName.get(artifact.snapshotFile);
        if (!supplied ||
            !Buffer.isBuffer(supplied.content) ||
            supplied.content.byteLength !== artifact.byteLength ||
            sha256Buffer(supplied.content) !== artifact.sha256 ||
            planReviewSnapshotLineCount(supplied.content) !== artifact.lineCount) {
            throw invocationInvalid();
        }
        createPrivateSnapshotFile(path.join(root, artifact.snapshotFile), supplied.content);
    }
    assertPlanReviewSnapshotFiles(paths, path.basename(invocationDirectory), manifest, invocationDirectory);
}
function assertPlanReviewSnapshotFiles(paths, requestedInvocationId, manifest, knownDirectory, record) {
    if (manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined) {
        return;
    }
    const directory = knownDirectory ??
        providerInvocationDirectory(paths, assertInvocationId(requestedInvocationId));
    const root = path.join(directory, 'review-root');
    assertPrivateInvestigationDirectory(paths, root, invocationUnsafe);
    const names = fs.readdirSync(root).sort();
    const expectedNames = manifest.planningTarget.artifacts
        .map(({ snapshotFile }) => snapshotFile)
        .sort();
    const retentionReceipt = record === undefined ||
        (record.state !== 'succeeded' && record.state !== 'failed')
        ? null
        : readCompleteProviderRetentionReceipt(paths, record.invocationId, {
            requestDigest: record.requestDigest,
            manifestDigest: record.manifestDigest,
            invocationRevision: record.revision,
            terminalState: record.state,
            terminalAt: record.updatedAt,
        });
    const retainedReviewRoot = retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, 'review-root');
    const expectedRetainedReviewRoot = providerRetentionReviewRootArtifact(manifest.planningTarget.artifacts.map((artifact) => ({
        name: `review-root/${artifact.snapshotFile}`,
        digest: artifact.sha256,
        bytes: artifact.byteLength,
    })));
    if ((retainedReviewRoot === null
        ? canonicalJson(names) !== canonicalJson(expectedNames)
        : names.some((name) => !expectedNames.includes(name))) ||
        (retainedReviewRoot !== null &&
            canonicalJson(retainedReviewRoot) !==
                canonicalJson(expectedRetainedReviewRoot))) {
        throw invocationInvalid();
    }
    for (const artifact of manifest.planningTarget.artifacts) {
        if (!names.includes(artifact.snapshotFile)) {
            if (retainedReviewRoot === null)
                throw invocationInvalid();
            continue;
        }
        const content = readPrivateSnapshotFile(path.join(root, artifact.snapshotFile));
        if (content.byteLength !== artifact.byteLength ||
            sha256Buffer(content) !== artifact.sha256 ||
            planReviewSnapshotLineCount(content) !== artifact.lineCount) {
            throw invocationInvalid();
        }
    }
}
function createPrivateSnapshotFile(filePath, content) {
    const pendingPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.pending`);
    const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (existing) {
        if (!readPrivateSnapshotFile(filePath).equals(content)) {
            throw invocationInvalid();
        }
        const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
        if (pending) {
            if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
                throw invocationInvalid();
            }
            fs.unlinkSync(pendingPath);
            fsyncDirectory(path.dirname(filePath));
        }
        return;
    }
    const pending = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
    if (pending) {
        if (!readPrivateSnapshotFile(pendingPath).equals(content)) {
            throw invocationInvalid();
        }
    }
    else {
        createPendingSnapshotFile(pendingPath, content);
    }
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
        throw invocationInvalid();
    }
    fs.renameSync(pendingPath, filePath);
    fsyncDirectory(path.dirname(filePath));
    if (!readPrivateSnapshotFile(filePath).equals(content)) {
        throw invocationInvalid();
    }
}
function createPendingSnapshotFile(filePath, content) {
    const flags = fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags, 0o600);
    }
    catch {
        throw invocationInvalid();
    }
    try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600) {
            throw invocationInvalid();
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function readPrivateSnapshotFile(filePath) {
    const flags = fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags);
    }
    catch {
        throw invocationInvalid();
    }
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600) {
            throw invocationInvalid();
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function readPrivateCanonicalDocument(paths, filePath, makeError) {
    assertPrivateInvestigationDirectory(paths, path.dirname(filePath), makeError);
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600) {
        throw makeError();
    }
    const flags = fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, flags);
    }
    catch {
        throw makeError();
    }
    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() ||
            opened.nlink !== 1 ||
            (opened.mode & 0o777) !== 0o600 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino) {
            throw makeError();
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function assertProviderInvocationRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'invocationId',
            'investigationId',
            'changeId',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'attempt',
            'revision',
            'state',
            'providerId',
            'purpose',
            'requestDigest',
            'manifestDigest',
            'leaseGeneration',
            'lease',
            'result',
            'failure',
            ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
                ? ['runtimeReceipt']
                : []),
            'createdAt',
            'updatedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        typeof value.invocationId !== 'string' ||
        typeof value.investigationId !== 'string' ||
        typeof value.changeId !== 'string' ||
        (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
            !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 1 ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !['prepared', 'leased', 'succeeded', 'failed'].includes(String(value.state)) ||
        (value.providerId !== 'codex' && value.providerId !== 'claude') ||
        (value.purpose !== 'survey' &&
            value.purpose !== 'plan-review' &&
            value.purpose !== 'task-diff-review' &&
            value.purpose !== 'task-implementation') ||
        !isDigest(value.requestDigest) ||
        !isDigest(value.manifestDigest) ||
        !Number.isSafeInteger(value.leaseGeneration) ||
        value.leaseGeneration < 0 ||
        !isLease(value.lease) ||
        !isStoredResult(value.result) ||
        !isStoredFailure(value.failure) ||
        !isTimestamp(value.createdAt) ||
        !isTimestamp(value.updatedAt)) {
        throw invocationInvalid();
    }
    assertInvocationId(value.invocationId);
    assertInvestigationId(value.investigationId);
    assertChangeId(value.changeId);
    const runtimeReceipt = Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt, invocationInvalid)
        : undefined;
    if ((value.state === 'prepared' &&
        (value.lease !== null ||
            value.result !== null ||
            value.failure !== null)) ||
        (value.state === 'leased' &&
            (value.lease === null ||
                value.result !== null ||
                value.failure !== null)) ||
        (value.state === 'succeeded' &&
            (value.lease !== null ||
                value.result === null ||
                value.failure !== null)) ||
        (value.state === 'failed' &&
            (value.lease !== null ||
                value.result !== null ||
                value.failure === null)) ||
        (value.lease !== null &&
            value.lease.generation !== value.leaseGeneration) ||
        (runtimeReceipt !== undefined &&
            (value.state !== runtimeReceipt.terminalState ||
                value.invocationId !== runtimeReceipt.invocationId ||
                value.requestDigest !== runtimeReceipt.requestDigest ||
                value.revision !== runtimeReceipt.terminalRevision ||
                value.leaseGeneration !== runtimeReceipt.leaseGeneration ||
                (runtimeReceipt.schemaVersion === 4 &&
                    runtimeReceipt.failureCode !==
                        (value.state === 'failed'
                            ? value.failure.code
                            : null))))) {
        throw invocationInvalid();
    }
    return (runtimeReceipt === undefined ? value : { ...value, runtimeReceipt });
}
function assertMonotonicInvocationTransition(current, next) {
    for (const key of [
        'schemaVersion',
        'invocationId',
        'investigationId',
        'changeId',
        'attempt',
        'providerId',
        'purpose',
        'requestDigest',
        'manifestDigest',
        'createdAt',
    ]) {
        if (canonicalJson(current[key]) !== canonicalJson(next[key])) {
            throw invocationTransitionInvalid();
        }
    }
    if (canonicalJson(current.mandateBinding ?? null) !==
        canonicalJson(next.mandateBinding ?? null) ||
        next.revision !== current.revision + 1 ||
        next.leaseGeneration < current.leaseGeneration ||
        Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
        current.state === 'succeeded' ||
        current.state === 'failed') {
        throw invocationTransitionInvalid();
    }
}
function assertCurrentLease(current, leaseGeneration, leaseToken, now) {
    if (current.state !== 'leased' ||
        current.lease === null ||
        !Number.isSafeInteger(leaseGeneration) ||
        current.leaseGeneration !== leaseGeneration ||
        current.lease.generation !== leaseGeneration ||
        typeof leaseToken !== 'string' ||
        !DIGEST.test(leaseToken) ||
        current.lease.tokenDigest !== sha256(leaseToken) ||
        now >= Date.parse(current.lease.expiresAt)) {
        throw workflowError('PROVIDER_INVOCATION_LEASE_STALE', 'Provider invocation lease is missing, expired, or fenced.', ExitCode.staleState);
    }
}
function providerOutputSchemaUnsupported() {
    return workflowError('PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED', 'Provider invocation does not reference a code-owned output schema.', ExitCode.verification);
}
function codeOwnedProviderOutputSchema(request) {
    if (request.purpose === 'survey') {
        return BLIND_SURVEY_OUTPUT_SCHEMA;
    }
    if (request.purpose === 'plan-review') {
        return PLAN_REVIEW_OUTPUT_SCHEMA;
    }
    if (request.purpose === 'task-diff-review') {
        if (request.outputSchema.id === TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id) {
            return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA;
        }
        return TASK_DIFF_REVIEW_OUTPUT_SCHEMA;
    }
    if (request.purpose === 'task-implementation') {
        return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA;
    }
    throw providerOutputSchemaUnsupported();
}
export function providerOutputSchemaGeneration(request) {
    const codeOwned = codeOwnedProviderOutputSchema(request);
    if (request.outputSchema.id !== codeOwned.id ||
        request.outputSchema.version !== codeOwned.version ||
        request.outputSchema.digest !== codeOwned.digest) {
        throw providerOutputSchemaUnsupported();
    }
    return 'code-owned';
}
function matchesPersistedProviderOutputSchema(observed, current) {
    return (observed.id === current.id &&
        observed.version === current.version &&
        observed.digest === current.digest);
}
export function blindSurveyOutputValidator(request) {
    if (request.purpose !== 'survey' ||
        providerOutputSchemaGeneration(request) !== 'code-owned') {
        throw providerOutputSchemaUnsupported();
    }
    return {
        ...BLIND_SURVEY_OUTPUT_SCHEMA,
        validate(value) {
            return validateBlindSurveyOutput(value, request.invocationId);
        },
    };
}
function classifyProviderResiduals(value) {
    if (!Array.isArray(value) ||
        canonicalJson(value) !== canonicalJson(PROVIDER_RUNNER_RESIDUALS)) {
        throw resultInvalid();
    }
    return deepFreeze({
        generation: 'current',
        missing: [],
    });
}
/**
 * Report the residuals generation a durable record carries, or null when it
 * holds no runtime observation to carry one. Classified from the record rather
 * than from the request, because residuals are what the run observed and not
 * what it was asked to do.
 */
export function providerResidualsGeneration(record) {
    const residuals = record.result?.runtimeObservation?.residuals;
    return residuals === undefined ? null : classifyProviderResiduals(residuals);
}
function assertProviderResult(request, value) {
    return assertProviderProcessResult(request, value, providerOutputValidator(request), resultInvalid);
}
function providerResultFromRunnerReport(request, report) {
    if (!isRecord(report) ||
        report.invocationId !== request.invocationId ||
        report.providerId !== request.providerId ||
        report.purpose !== request.purpose ||
        report.requestDigest !== request.requestDigest ||
        report.providerDefinitionSnapshot === undefined ||
        report.semanticOutputDigest !== sha256(canonicalJson(report.semanticOutput))) {
        throw resultInvalid();
    }
    const validator = providerOutputValidator(request);
    let accepted;
    try {
        accepted = validator.validate(report.semanticOutput) === true;
    }
    catch {
        throw resultInvalid();
    }
    if (!accepted) {
        throw resultInvalid();
    }
    const output = deepFreeze(structuredClone(report.semanticOutput));
    let providerDefinitionSnapshot;
    try {
        if (!isProviderExecutableIdentity(report.executable))
            throw resultInvalid();
        providerDefinitionSnapshot = assertProviderDefinitionSnapshotForResult(report.providerDefinitionSnapshot, request.providerId, report.executable.candidatePath);
    }
    catch {
        throw resultInvalid();
    }
    const hostWrapperProfile = 'profileDigest' in providerDefinitionSnapshot &&
        providerDefinitionSnapshot.trustTier === 'host-wrapper';
    const hostWrapperProtocolReceipt = report.wrapperProtocolReceipt?.kind ===
        'provider-wrapper-session-protocol-receipt';
    let hostExecutionBinding = null;
    try {
        hostExecutionBinding =
            report.hostExecutionBinding === undefined
                ? null
                : assertAgentRuntimeHostExecutionBindingV1(report.hostExecutionBinding);
    }
    catch {
        throw resultInvalid();
    }
    const providerDefinitionBindingDigest = providerDefinitionExecutableBindingDigest(providerDefinitionDigest(providerDefinitionSnapshot), report.executable);
    if (hostWrapperProfile !== hostWrapperProtocolReceipt ||
        hostWrapperProfile !== (hostExecutionBinding !== null) ||
        (hostExecutionBinding !== null &&
            (hostExecutionBinding.phase !== 'native-terminal' ||
                hostExecutionBinding.probe === null ||
                canonicalJson(hostExecutionBinding.assignmentBinding.providerProfileSnapshot) !== canonicalJson(providerDefinitionSnapshot) ||
                hostExecutionBinding.assignmentBinding.definitionDigest !==
                    providerDefinitionDigest(providerDefinitionSnapshot) ||
                hostExecutionBinding.assignmentBinding.dataAuthorizationPolicyDigest !==
                    request.policyDigest ||
                hostExecutionBinding.assignmentBinding.inputManifestDigest !==
                    request.inputManifestDigest ||
                hostExecutionBinding.assignmentBinding.targetDigest !==
                    request.targetDigest ||
                hostExecutionBinding.probe.providerDefinitionBindingDigest !==
                    providerDefinitionBindingDigest))) {
        throw resultInvalid();
    }
    const providerDefinitionEvidence = {
        providerDefinitionSnapshot,
        providerDefinitionBindingDigest,
    };
    const runtimeObservation = assertProviderRuntimeObservation({
        assurance: report.assurance,
        projection: report.projection,
        sameUserProcessConfined: report.sameUserProcessConfined,
        residuals: report.residuals,
        executable: report.executable,
        elapsedMs: report.elapsedMs,
        ...providerDefinitionEvidence,
    }, request, resultInvalid);
    return deepFreeze({
        requestDigest: request.requestDigest,
        invocationId: request.invocationId,
        purpose: request.purpose,
        providerId: request.providerId,
        output,
        outputDigest: sha256(canonicalJson({
            id: request.outputSchema.id,
            version: request.outputSchema.version,
            output,
        })),
        runtimeObservation,
    });
}
function providerOutputValidator(request) {
    if (providerOutputSchemaGeneration(request) !== 'code-owned') {
        throw providerOutputSchemaUnsupported();
    }
    if (request.purpose === 'survey') {
        return blindSurveyOutputValidator(request);
    }
    if (request.purpose === 'plan-review') {
        return PLAN_REVIEW_OUTPUT_VALIDATOR;
    }
    if (request.purpose === 'task-diff-review') {
        if (request.outputSchema.id ===
            TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
            request.outputSchema.version ===
                TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
            request.outputSchema.digest ===
                TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest) {
            return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR;
        }
        return TASK_DIFF_REVIEW_OUTPUT_VALIDATOR;
    }
    if (request.purpose === 'task-implementation') {
        return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR;
    }
    throw providerOutputSchemaUnsupported();
}
function assertProviderResultManifestBinding(manifest, result) {
    if (manifest.kind !== 'task-strategy-implementation-manifest')
        return;
    if (!isRecord(result.output) ||
        result.output.sessionId !== manifest.subject.sessionId ||
        result.output.sourceTree !== manifest.subject.sourceTree) {
        throw invocationInvalid();
    }
}
function assertProviderFailure(value) {
    const hasExecutionKind = isRecord(value) && Object.hasOwn(value, 'executionKind');
    const hasRetryAfter = isRecord(value) && Object.hasOwn(value, 'retryAfterMs');
    const hasProbe = isRecord(value) && Object.hasOwn(value, 'probe');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'kind',
            'code',
            'message',
            ...(hasExecutionKind ? ['executionKind'] : []),
            ...(hasRetryAfter ? ['retryAfterMs'] : []),
            ...(hasProbe ? ['probe'] : []),
        ]) ||
        (value.kind !== 'retryable' &&
            value.kind !== 'repository-reconciliation-required') ||
        typeof value.code !== 'string' ||
        value.code.length === 0 ||
        typeof value.message !== 'string' ||
        value.message.length === 0 ||
        (hasExecutionKind &&
            !PROVIDER_EXECUTION_FAILURE_KINDS.has(value.executionKind)) ||
        (hasRetryAfter &&
            (!Number.isSafeInteger(value.retryAfterMs) ||
                value.retryAfterMs < 0 ||
                value.retryAfterMs > 86_400_000)) ||
        (hasProbe && !isReadOnlyProbe(value.probe)) ||
        hasProbe !== (value.executionKind === 'probe-transient') ||
        Buffer.byteLength(canonicalJson(value), 'utf8') > 16_384) {
        throw invocationInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function isReadOnlyProbe(value) {
    try {
        assertReadOnlyProbe(value);
        return true;
    }
    catch {
        return false;
    }
}
const PROVIDER_EXECUTION_FAILURE_KINDS = new Set([
    'provider-timeout',
    'network',
    'rate-limit',
    'provider-process-crash',
    'worker-crash',
    'lease-expiry',
    'temporary-file-lock',
    'provider-capacity',
    'stdout-truncated',
    'process-nonzero',
    'json-parse',
    'schema-mismatch',
    'missing-required-field',
    'citation-out-of-range',
    'probe-transient',
    'needs-user-decision',
    'state-corruption',
    'unknown-side-effect',
]);
function isLease(value) {
    return (value === null ||
        (isRecord(value) &&
            hasExactKeys(value, [
                'generation',
                'workerId',
                'tokenDigest',
                'acquiredAt',
                'expiresAt',
            ]) &&
            Number.isSafeInteger(value.generation) &&
            value.generation > 0 &&
            typeof value.workerId === 'string' &&
            value.workerId.length > 0 &&
            isDigest(value.tokenDigest) &&
            isTimestamp(value.acquiredAt) &&
            isTimestamp(value.expiresAt) &&
            Date.parse(value.expiresAt) >
                Date.parse(value.acquiredAt)));
}
function isStoredResult(value) {
    return (value === null ||
        (isRecord(value) &&
            hasExactKeys(value, [
                'requestDigest',
                'invocationId',
                'purpose',
                'providerId',
                'output',
                'outputDigest',
                'runtimeObservation',
            ]) &&
            isDigest(value.requestDigest) &&
            typeof value.invocationId === 'string' &&
            (value.purpose === 'survey' ||
                value.purpose === 'plan-review' ||
                value.purpose === 'task-diff-review' ||
                value.purpose === 'task-implementation') &&
            (value.providerId === 'codex' || value.providerId === 'claude') &&
            isDigest(value.outputDigest)));
}
function isStoredFailure(value) {
    if (value === null) {
        return true;
    }
    try {
        assertProviderFailure(value);
        return true;
    }
    catch {
        return false;
    }
}
function providerInvocationDirectory(paths, invocationId) {
    return path.join(paths.invocations, invocationId);
}
function providerInvocationStatePath(paths, invocationId) {
    return path.join(providerInvocationDirectory(paths, invocationId), 'state.json');
}
function providerInvocationCancellationRequestPath(paths, invocationId) {
    return path.join(providerInvocationDirectory(paths, invocationId), 'cancellation-request.json');
}
function providerCompletionCandidatePath(paths, invocationId) {
    return path.join(paths.root, 'execution', 'completion-candidates', `${sha256(invocationId)}.json`);
}
function investigationStartReservationPath(paths, changeId) {
    return path.join(paths.refs, `${changeId}.investigation-start.json`);
}
function providerRetryReservationPath(paths, investigationId, attempt) {
    return path.join(paths.refs, `${investigationId}.provider-retry-${attempt}.json`);
}
function parseNow(value) {
    const now = value === undefined ? Date.now() : Date.parse(value);
    if (!Number.isFinite(now)) {
        throw leaseInvalid();
    }
    return now;
}
function isTaskMandateBinding(value, changeId) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'schemaVersion',
            'mandateTaskId',
            'mandateId',
            'mandateDigest',
            'changeId',
            'externalAuditRoot',
        ]) &&
        value.schemaVersion === 1 &&
        value.changeId === changeId &&
        typeof value.externalAuditRoot === 'string' &&
        path.isAbsolute(value.externalAuditRoot) &&
        path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
        typeof value.mandateTaskId === 'string' &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
        typeof value.mandateId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.mandateId) &&
        isDigest(value.mandateDigest));
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isTimestamp(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
function isBaseline(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['head', 'tree']) &&
        typeof value.head === 'string' &&
        GIT_OBJECT_ID.test(value.head) &&
        typeof value.tree === 'string' &&
        GIT_OBJECT_ID.test(value.tree));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const own = Object.keys(value);
    return (own.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function providerSha256(value) {
    return `sha256:${sha256(value)}`;
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
function blindManifestInvalid() {
    return workflowError('BLIND_MANIFEST_INVALID', 'Blind survey manifest is malformed, over-broad, or contains prior work.', ExitCode.guard);
}
function invocationUnsafe() {
    return workflowError('PROVIDER_INVOCATION_STORE_UNSAFE', 'Provider invocation storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
function providerExecutionPolicySnapshotUnsafe() {
    return workflowError('PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE', 'Durable provider execution policy snapshot is missing, malformed, or unsafe.', ExitCode.unsafeEnvironment);
}
function providerExecutionPolicySnapshotMismatch() {
    return workflowError('PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH', 'Durable provider execution policy snapshot is not bound to this request.', ExitCode.staleState);
}
function assertProviderAcceptanceBinding(binding) {
    try {
        assertProviderInvocationAcceptanceBinding(binding, providerAcceptanceBindingStale);
    }
    catch {
        throw providerAcceptanceBindingStale();
    }
}
function providerAcceptanceBindingStale() {
    return workflowError('PROVIDER_ACCEPTANCE_BINDING_STALE', 'Provider execution authority changed before result acceptance.', ExitCode.staleState);
}
function invocationInvalid() {
    return workflowError('PROVIDER_INVOCATION_INVALID', 'Provider invocation is malformed or internally inconsistent.', ExitCode.staleState);
}
function providerCancellationInvalid() {
    return workflowError('PROVIDER_INVOCATION_CANCELLATION_INVALID', 'Provider invocation cancellation authority or storage is invalid.', ExitCode.guard);
}
function providerCancellationStateChanged() {
    return workflowError('PROVIDER_INVOCATION_CANCELLATION_STATE_CHANGED', 'Provider invocation changed after its exact cancellation binding was created.', ExitCode.staleState);
}
function invocationTransitionInvalid() {
    return workflowError('PROVIDER_INVOCATION_TRANSITION_INVALID', 'Provider invocation transition is not monotonic.', ExitCode.staleState);
}
function leaseInvalid() {
    return workflowError('PROVIDER_INVOCATION_LEASE_INVALID', 'Provider invocation lease request is malformed.', ExitCode.usage);
}
function resultInvalid() {
    return workflowError('PROVIDER_INVOCATION_RESULT_INVALID', 'Provider invocation result is not bound to its durable request.', ExitCode.verification);
}
function providerCompletionRecoveryConflict() {
    return workflowError('PROVIDER_COMPLETION_RECOVERY_CONFLICT', 'Provider state diverged from the exact durable completion candidate.', ExitCode.conflict);
}
function providerCasMismatch(expected, observed) {
    return workflowError('PROVIDER_INVOCATION_CAS_MISMATCH', 'Provider invocation changed during compare-and-swap.', ExitCode.conflict, { details: { expectedRevision: expected, observedRevision: observed } });
}
function startReservationCasMismatch(expectedDigest, observedDigest) {
    return workflowError('INVESTIGATION_START_RESERVATION_CAS_MISMATCH', 'Investigation start reservation changed during compare-and-swap.', ExitCode.conflict, { details: { expectedDigest, observedDigest } });
}
function startReservationLockInvalid() {
    return workflowError('INVESTIGATION_START_RESERVATION_LOCK_INVALID', 'Investigation start reservation lock ownership changed during retirement.', ExitCode.staleState);
}
function invocationLockInvalid() {
    return workflowError('PROVIDER_INVOCATION_LOCK_INVALID', 'Provider invocation lock ownership changed during the transition.', ExitCode.staleState);
}
function providerWorkerFenceUnsafe() {
    return workflowError('PROVIDER_INVOCATION_WORKER_FENCE_UNSAFE', 'Provider worker activity fence is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
function absentInvestigationStartReservationSnapshot() {
    return Object.freeze({
        rawDocument: null,
        digest: null,
        reservation: null,
    });
}
