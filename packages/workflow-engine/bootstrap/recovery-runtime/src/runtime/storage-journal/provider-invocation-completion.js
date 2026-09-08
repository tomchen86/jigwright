/**
 * Commit provider outcomes and recover interrupted execution acceptance and native continuation publication.
 *
 * Invariants:
 * - Completion candidates, execution acceptance, state writes, and continuation publication keep their order.
 * - Both recovery paths repair only exact durable results while retaining lock and CAS checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { projectProviderInvocationExecution } from "../../modules/provider-orchestration/execution-core.js";
import { readExecutionJobState, materializeProviderExecutionJob, acceptProviderAttemptResult, } from "./execution-store.js";
import { assertProviderRuntimeTerminalAuthorityPreflight, assertProviderRuntimeDurableAuthorities, } from "./investigation-session-store.js";
import { privatePathExists, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, createPrivateCanonicalJson, readPrivateCanonicalJson, } from "./investigation-private-files.js";
import { evaluateProviderProcess, } from "../../modules/provider-orchestration/provider-contracts.js";
import { assertProviderRuntimeProtocolReceipt, } from "../../modules/provider-orchestration/agent-runtime-protocol.js";
import { assertAgentRuntimeCompletionReceipt, assertAgentRuntimeProcessProgress, } from "../../modules/provider-orchestration/provider-runtime-evidence.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
import { publishProviderNativeSessionContinuationAuthorityV1 } from "./provider-native-session-store.js";
import { providerNativeSessionContinuationAuthorityObjectPathV1, providerNativeSessionStorePathsV1, } from "../session-workspace/provider-runtime-authority-paths.js";
import { withCurrentProviderPromptContext, persistProviderRepairEvidence, } from "../provider-execution/provider-execution-governance.js";
import { readProviderInvocation, prepareProviderInvocationAcceptanceBinding, updateProviderInvocation, assertProviderInvocationAcceptanceBindingTerminalCurrent, providerExecutionEntries, readProviderInvocationCore, } from "./provider-invocation-state.js";
import { providerCasMismatch, invocationInvalid, parseNow, invocationUnsafe, assertProviderAcceptanceBinding, providerAcceptanceBindingStale, providerCompletionCandidatePath, isDigest, deepFreeze, providerCompletionRecoveryConflict, providerInvocationStatePath, invocationLockInvalid, sha256, isRecord, hasExactKeys, isTimestamp, } from "./provider-invocation-common.js";
import { readProviderInvocationRequest, readProviderInvocationManifest, } from "./provider-invocation-artifacts.js";
import { providerOutputValidator, assertProviderResultManifestBinding, assertCurrentLease, assertProviderInvocationRecord, providerResultFromRunnerReport, assertMonotonicInvocationTransition, assertProviderResult, assertProviderFailure, } from "./provider-invocation-validation.js";
import { withProviderWorkerLifecycle, assertProviderWorkerFenceClaim, assertProviderInvocationWorkerQuiescentUnderLifecycleLock, } from "./provider-invocation-workers.js";
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
    // Records without a successful result have no continuation authority to
    // publish. Leave admission to the caller's exact owner-aware lifecycle.
    const observed = readProviderInvocationForNativeContinuationRecovery(paths, invocationId);
    if (observed.state !== 'succeeded' || observed.result === null)
        return null;
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
