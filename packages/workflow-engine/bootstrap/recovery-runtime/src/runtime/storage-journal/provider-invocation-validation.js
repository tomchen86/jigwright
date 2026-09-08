/**
 * Validate invocation request bindings, durable state records, leases, and monotonic transitions.
 *
 * Invariants:
 * - Current record schemas, failure shapes, request bindings, and lease checks stay exact.
 * - Manifest and output validation remain available through this existing entrypoint.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { assertReadOnlyProbe, } from "../../modules/provider-orchestration/execution-core.js";
import { createProviderInvocationRequest, } from "../../modules/provider-orchestration/provider-contracts.js";
import { assertAgentRuntimeCompletionReceipt } from "../../modules/provider-orchestration/provider-runtime-evidence.js";
import { assertInvocationId, assertInvestigationId, assertChangeId, } from "../session-workspace/paths.js";
import { TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA, } from "../../modules/assurance/task-diff-review-artifact.js";
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from "../../modules/provider-orchestration/task-strategy-provider-contract.js";
import { isRecord, invocationInvalid, hasExactKeys, isTaskMandateBinding, isDigest, isTimestamp, invocationTransitionInvalid, DIGEST, sha256, deepFreeze, } from "./provider-invocation-common.js";
import { blindSurveyIntentDigest } from "./provider-invocation-manifest-validation.js";
import { matchesPersistedProviderOutputSchema } from "./provider-invocation-output-validation.js";
export { blindSurveyManifestDigest, providerInvocationManifestDigest, blindSurveyIntentDigest, assertBlindSurveyManifest, assertProviderInvocationManifest, } from "./provider-invocation-manifest-validation.js";
export { providerOutputSchemaGeneration, blindSurveyOutputValidator, providerResidualsGeneration, assertProviderResult, providerResultFromRunnerReport, providerOutputValidator, assertProviderResultManifestBinding, } from "./provider-invocation-output-validation.js";
export function assertProviderRequest(value) {
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
export function assertBlindInvocationBinding(changeId, manifest, manifestDigest, request) {
    if (manifest.changeId !== changeId ||
        manifest.repositoryId !== request.repositoryId ||
        manifest.baseCommit !== request.baseCommit ||
        manifest.baseTree !== request.baseTree ||
        request.purpose !== 'survey' ||
        request.roleAssignment.role !== 'plan-reviewer' ||
        request.capabilityProfile !== 'repository-read-only' ||
        request.targetDigest !== blindSurveyIntentDigest(manifest) ||
        request.inputManifestDigest !== manifestDigest ||
        request.roleAssignment.targetDigest !== request.targetDigest) {
        throw invocationInvalid();
    }
}
export function assertProviderInvocationBinding(changeId, manifest, manifestDigest, request) {
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
            !continuationProviderMatchesReview(manifest.review, request.providerId) ||
            !continuationProviderMatchesReview(manifest.review, request.roleAssignment.providerId) ||
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
function continuationProviderMatchesReview(review, providerId) {
    const originalReviewer = review.assignment.reviewerProviderId;
    if (originalReviewer === null)
        return true;
    const implementationProvider = review.assignment.implementerProviderId;
    return originalReviewer === implementationProvider
        ? providerId !== implementationProvider
        : providerId === originalReviewer;
}
export function assertProviderInvocationRecord(value) {
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
export function assertMonotonicInvocationTransition(current, next) {
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
export function assertCurrentLease(current, leaseGeneration, leaseToken, now) {
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
export function assertProviderFailure(value) {
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
