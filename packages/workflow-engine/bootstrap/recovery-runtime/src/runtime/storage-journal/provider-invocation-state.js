/**
 * Create, validate, and atomically transition durable invocation state and execution projections.
 *
 * Invariants:
 * - State revision checks, authority checks, writes, and execution materialization keep their order.
 * - Normal reads remain strict; the explicit recovery read option stays bounded.
 *
 * Depends on: execution store, reservations, immutable artifacts, and runtime authority validation.
 * Failure modes: State and execution journals can diverge or stale authority can appear current.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { resolvePlanReviewInvocationOwner, resolveTaskDiffReviewInvocationOwner, resolveTaskStrategyImplementationInvocationOwner, } from "./evidence-object-store.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { projectProviderInvocationExecution } from "../../modules/provider-orchestration/execution-core.js";
import { readExecutionJobState, withExecutionJobStateSnapshot, publishProviderExecutionAdmissionAuthority, materializeProviderExecutionJob, } from "./execution-store.js";
import { assertProviderRuntimeDurableAuthorities, readHumanResolutionHead, readHumanResolutionNode, listProviderInvocationLifecycleProjections, scanProviderInvocationLifecycles, } from "./investigation-session-store.js";
import { withPrivateRuntimeLock, privatePathExists, createPrivateCanonicalJson, readPrivateCanonicalJson, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
import { assertProviderExecutionAdmissionAuthority, providerExecutionAdmissionAuthorityPath, MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES, } from "./provider-execution-admission-authority.js";
import { assertInvestigationId, assertChangeId, assertInvocationId, } from "../session-workspace/paths.js";
import { registerProviderRetentionInvocation } from "./provider-retention-catalog.js";
import { createProviderRepairLineage, prepareProviderPromptContextForInvocation, registerProviderRuntimeEvidence, ensureProviderPromptContext, readProviderRepairAuthorityBinding, assertProviderPromptContextCurrent, assertProviderRepairAuthorityCurrent, } from "../provider-execution/provider-execution-governance.js";
import { resumePreparedProviderInvocationSupersession, prepareProviderInvocationSupersession, finalizeProviderInvocationSupersession, assertProviderInvocationSupersessionEndpointCurrent, readProviderInvocationEvidenceRecord, recoverProviderInvocationSupersessionTransaction, } from "../provider-execution/provider-invocation-supersession.js";
import { invocationInvalid, providerExecutionPolicySnapshotMismatch, isTimestamp, providerInvocationDirectory, invocationUnsafe, invocationLockInvalid, providerInvocationStatePath, deepFreeze, providerAcceptanceBindingStale, sha256, assertProviderAcceptanceBinding, providerCasMismatch, } from "./provider-invocation-common.js";
import { assertProviderInvocationManifest, assertProviderRequest, providerInvocationManifestDigest, assertProviderInvocationBinding, assertProviderInvocationRecord, assertProviderResult, assertProviderResultManifestBinding, assertMonotonicInvocationTransition, } from "./provider-invocation-validation.js";
import { readProviderExecutionPolicySnapshot } from "./provider-invocation-policy.js";
import { createPlanReviewSnapshotFiles, readProviderInvocationRequest, readProviderInvocationManifest, assertPlanReviewSnapshotFiles, } from "./provider-invocation-artifacts.js";
import { readProviderRetryReservation } from "./provider-invocation-reservations.js";
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
export function readProviderInvocationCore(paths, requestedInvocationId, options = {}) {
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
export function assertProviderInvocationNotTerminallyResolved(paths, invocation) {
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
function materializeProviderExecutionState(paths, current, request) {
    const entries = providerExecutionEntries(paths, current, request);
    materializeProviderExecutionJob(paths, entries);
    return entries;
}
export function providerExecutionEntries(paths, current, request) {
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
export function updateProviderInvocation(paths, invocationId, expectedRevision, transition, afterStateWrite) {
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
