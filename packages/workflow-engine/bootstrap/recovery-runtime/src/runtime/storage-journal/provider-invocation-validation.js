/**
 * Validate provider manifests, records, requests, and runner results without store reads.
 *
 * Invariants:
 * - Current schemas, canonical output bytes, bindings, and transition checks stay exact.
 * - Unsupported output generations and invalid runtime evidence remain rejected.
 *
 * Depends on: provider contracts, manifest schemas, runtime evidence, and shared predicates.
 * Failure modes: Invalid persisted data can be accepted or valid provider output can become unreadable.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { assertReadOnlyProbe, } from "../../modules/provider-orchestration/execution-core.js";
import { createProviderInvocationRequest, } from "../../modules/provider-orchestration/provider-contracts.js";
import { assertAgentRuntimeHostExecutionBindingV1 } from "../../modules/provider-orchestration/agent-runtime-host-execution-binding.js";
import { assertAgentRuntimeCompletionReceipt, PROVIDER_RUNNER_RESIDUALS, assertProviderProcessResult, isProviderExecutableIdentity, assertProviderDefinitionSnapshotForResult, providerDefinitionExecutableBindingDigest, providerDefinitionDigest, assertProviderRuntimeObservation, } from "../../modules/provider-orchestration/provider-runtime-evidence.js";
import { BLIND_SURVEY_OUTPUT_SCHEMA, validateBlindSurveyOutput, } from "../../modules/provider-orchestration/blind-survey-output.js";
import { assertChangeId, assertTaskId, assertSessionId, assertInvocationId, assertInvestigationId, } from "../session-workspace/paths.js";
import { assertPlanReviewSubject, assertPlanReviewTargetSnapshot, PLAN_REVIEW_OUTPUT_SCHEMA, PLAN_REVIEW_OUTPUT_VALIDATOR, } from "../../modules/assurance/plan-review.js";
import { parseTaskDiffReviewRecord, assertTaskDiffReviewChallengeResponseCurrent, parseTaskDiffReviewChallengeResponseRecord, TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA, TASK_DIFF_REVIEW_OUTPUT_SCHEMA, TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR, TASK_DIFF_REVIEW_OUTPUT_VALIDATOR, } from "../../modules/assurance/task-diff-review-artifact.js";
import { parseTaskDiffReviewSubject, parseTaskDiffReviewScope, } from "../../modules/assurance/task-diff-review.js";
import { assertTaskStrategyImplementationManifest, TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA, TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR, } from "../../modules/provider-orchestration/task-strategy-provider-contract.js";
import { sha256, isRecord, hasExactKeys, GIT_OBJECT_ID, MAX_ARCHITECTURE_QUESTION_BYTES, blindManifestInvalid, MAX_BLIND_MANIFEST_BYTES, deepFreeze, invocationInvalid, MAX_INTENT_SUMMARY_BYTES, MAX_INTENT_FACTS_PER_KIND, SOURCE_REFERENCE, MAX_INTENT_FACT_BYTES, isTaskMandateBinding, isDigest, isTimestamp, invocationTransitionInvalid, DIGEST, resultInvalid, } from "./provider-invocation-common.js";
export function blindSurveyManifestDigest(manifest) {
    return sha256(canonicalJson(assertBlindSurveyManifest(manifest)));
}
export function providerInvocationManifestDigest(manifest) {
    return sha256(canonicalJson(assertProviderInvocationManifest(manifest)));
}
export function blindSurveyIntentDigest(manifest) {
    return sha256(canonicalJson(assertBlindSurveyManifest(manifest).normalizedIntent));
}
export function assertBlindSurveyManifest(value) {
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
export function assertProviderInvocationManifest(value) {
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
            'sourceRefs',
            'explicitPaths',
            'explicitSymbols',
            'explicitConfigKeys',
            'renamePairs',
        ]) ||
        value.schemaVersion !== 1 ||
        !isBoundedBlindText(value.summary, MAX_INTENT_SUMMARY_BYTES) ||
        !isCanonicalSourceReferenceArray(value.sourceRefs) ||
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
function isCanonicalSourceReferenceArray(value) {
    if (!Array.isArray(value) ||
        value.length > MAX_INTENT_FACTS_PER_KIND ||
        !value.every((entry) => typeof entry === 'string' && SOURCE_REFERENCE.test(entry))) {
        return false;
    }
    return value.every((entry, index) => index === 0 || value[index - 1].localeCompare(entry) < 0);
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
export function assertProviderResult(request, value) {
    return assertProviderProcessResult(request, value, providerOutputValidator(request), resultInvalid);
}
export function providerResultFromRunnerReport(request, report) {
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
export function providerOutputValidator(request) {
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
export function assertProviderResultManifestBinding(manifest, result) {
    if (manifest.kind !== 'task-strategy-implementation-manifest')
        return;
    if (!isRecord(result.output) ||
        result.output.sessionId !== manifest.subject.sessionId ||
        result.output.sourceTree !== manifest.subject.sourceTree) {
        throw invocationInvalid();
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
