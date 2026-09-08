/**
 * Resolves task review and implementation invocation owners from durable evidence.
 *
 * Invariants:
 * - Task mandate, actor, assignment, and request subjects remain exactly bound.
 * - Task review and implementation retain their distinct author and role rules.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { parseTaskDiffReviewSubject, TASK_DIFF_REVIEW_POLICY_DIGEST, } from "../../modules/assurance/task-diff-review.js";
import { isProviderRoleAssignment } from "../../modules/provider-orchestration/provider-contracts.js";
import { assertTaskStrategyImplementationSubject, TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST, } from "../../modules/provider-orchestration/task-strategy-provider-contract.js";
import { assertChangeId, assertInvestigationId, } from "../session-workspace/paths.js";
import { readEvidenceNode } from "./evidence-node-store.js";
import { DIGEST_PATTERN, hasExactKeys, isDigest, isPlainRecord, refInvalid, sha256, } from "./evidence-store-values.js";
export function resolveTaskDiffReviewInvocationOwner(paths, input) {
    const changeId = assertChangeId(input.changeId);
    const subject = parseTaskDiffReviewSubject(input.subject);
    if (!DIGEST_PATTERN.test(input.authorizationNodeId))
        throw refInvalid();
    const authorization = readEvidenceNode(paths, input.authorizationNodeId);
    const output = authorization.output;
    if (authorization.type !== 'task-diff-review-authorization' ||
        authorization.nodeSchema !== 'workflow.task-diff-review-authorization.v1' ||
        authorization.evaluator !== 'workflow-task-diff-review.v1' ||
        authorization.policyDigest !== TASK_DIFF_REVIEW_POLICY_DIGEST ||
        authorization.outputSchema !==
            'workflow.task-diff-review-authorization-output.v1' ||
        !hasExactKeys(authorization.exactInputDigests, [
            'actor',
            'assignment',
            'mandate',
            'session',
            'subject',
        ]) ||
        !hasExactKeys(authorization.semanticParentResultDigests, []) ||
        !hasExactKeys(authorization.provenanceParentNodeIds, []) ||
        !isPlainRecord(output) ||
        !hasExactKeys(output, [
            'ownerInvestigationId',
            'sessionId',
            'changeId',
            'taskId',
            'subject',
            'implementationActor',
            'assignment',
            'mandateBinding',
        ]) ||
        output.changeId !== changeId ||
        output.sessionId !== input.sessionId ||
        output.taskId !== subject.taskId ||
        canonicalJson(output.subject) !== canonicalJson(subject) ||
        canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
        !isTaskDiffReviewImplementationActor(output.implementationActor) ||
        !isTaskDiffReviewAssignmentForActor(output.assignment, output.implementationActor, subject.subjectDigest) ||
        !isTaskDiffReviewMandateBinding(output.mandateBinding, changeId) ||
        authorization.exactInputDigests.actor !==
            sha256(canonicalJson(output.implementationActor)) ||
        authorization.exactInputDigests.assignment !==
            sha256(canonicalJson(output.assignment)) ||
        authorization.exactInputDigests.mandate !==
            sha256(canonicalJson(output.mandateBinding)) ||
        authorization.exactInputDigests.session !==
            sha256(canonicalJson({
                sessionId: input.sessionId,
                changeId,
                taskId: subject.taskId,
            })) ||
        authorization.exactInputDigests.subject !== subject.subjectDigest ||
        typeof output.ownerInvestigationId !== 'string') {
        throw refInvalid();
    }
    let ownerInvestigationId;
    try {
        ownerInvestigationId = assertInvestigationId(output.ownerInvestigationId);
    }
    catch {
        throw refInvalid();
    }
    return Object.freeze({
        ownerInvestigationId,
        sessionId: input.sessionId,
        mandateBinding: structuredClone(output.mandateBinding),
    });
}
export function resolveTaskStrategyImplementationInvocationOwner(paths, input) {
    const changeId = assertChangeId(input.changeId);
    const subject = assertTaskStrategyImplementationSubject(input.subject);
    if (!DIGEST_PATTERN.test(input.authorizationNodeId))
        throw refInvalid();
    const authorization = readEvidenceNode(paths, input.authorizationNodeId);
    const output = authorization.output;
    if (authorization.type !== 'task-strategy-implementation-authorization' ||
        authorization.nodeSchema !==
            'workflow.task-strategy-implementation-authorization.v1' ||
        authorization.evaluator !== 'workflow-task-strategy.v1' ||
        authorization.policyDigest !== TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
        authorization.outputSchema !==
            'workflow.task-strategy-implementation-authorization-output.v1' ||
        !hasExactKeys(authorization.exactInputDigests, [
            'assignment',
            'author',
            'mandate',
            'session',
            'subject',
            'transaction',
        ]) ||
        !hasExactKeys(authorization.semanticParentResultDigests, ['red']) ||
        !hasExactKeys(authorization.provenanceParentNodeIds, ['red']) ||
        !isPlainRecord(output) ||
        !hasExactKeys(output, [
            'ownerInvestigationId',
            'sessionId',
            'changeId',
            'taskId',
            'subject',
            'redAuthor',
            'assignment',
            'mandateBinding',
        ]) ||
        output.changeId !== changeId ||
        output.sessionId !== input.sessionId ||
        output.taskId !== subject.taskId ||
        canonicalJson(output.subject) !== canonicalJson(subject) ||
        canonicalJson(output.assignment) !== canonicalJson(input.assignment) ||
        !isTaskStrategyRedAuthor(output.redAuthor) ||
        !isTaskStrategyImplementationAssignmentForAuthor(output.assignment, output.redAuthor, subject.subjectDigest) ||
        !isTaskDiffReviewMandateBinding(output.mandateBinding, changeId) ||
        authorization.exactInputDigests.author !==
            sha256(canonicalJson(output.redAuthor)) ||
        authorization.exactInputDigests.assignment !==
            sha256(canonicalJson(output.assignment)) ||
        authorization.exactInputDigests.mandate !==
            sha256(canonicalJson(output.mandateBinding)) ||
        authorization.exactInputDigests.session !==
            sha256(canonicalJson({
                sessionId: input.sessionId,
                changeId,
                taskId: subject.taskId,
            })) ||
        authorization.exactInputDigests.subject !== subject.subjectDigest ||
        authorization.exactInputDigests.transaction !== subject.transactionDigest ||
        authorization.semanticParentResultDigests.red !==
            subject.redEvidenceResultDigest ||
        authorization.provenanceParentNodeIds.red !== subject.redEvidenceNodeId ||
        typeof output.ownerInvestigationId !== 'string') {
        throw refInvalid();
    }
    const red = readEvidenceNode(paths, subject.redEvidenceNodeId);
    if (red.type !== 'task-strategy-red-evidence' ||
        red.nodeId !== subject.redEvidenceNodeId ||
        red.resultDigest !== subject.redEvidenceResultDigest) {
        throw refInvalid();
    }
    let ownerInvestigationId;
    try {
        ownerInvestigationId = assertInvestigationId(output.ownerInvestigationId);
    }
    catch {
        throw refInvalid();
    }
    return Object.freeze({
        ownerInvestigationId,
        sessionId: input.sessionId,
        mandateBinding: structuredClone(output.mandateBinding),
    });
}
function isTaskDiffReviewImplementationActor(value) {
    if (!(isPlainRecord(value) &&
        hasExactKeys(value, [
            'providerId',
            'sessionId',
            'principalId',
            'identityAssurance',
            'engineSpawned',
        ]) &&
        (value.providerId === 'codex' || value.providerId === 'claude') &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0)) {
        return false;
    }
    const callerAttributed = typeof value.principalId === 'string' &&
        value.principalId === `provider:${value.providerId}` &&
        (value.identityAssurance === 'self-declared' ||
            value.identityAssurance === 'runtime-hint') &&
        value.engineSpawned === false;
    const engineAttributed = value.principalId === null &&
        value.identityAssurance === 'adapter-assigned' &&
        value.engineSpawned === true;
    return callerAttributed || engineAttributed;
}
function isTaskDiffReviewAssignmentForActor(value, actor, subjectDigest) {
    if (!isProviderRoleAssignment(value) ||
        value.role !== 'task-diff-reviewer' ||
        value.targetDigest !== subjectDigest) {
        return false;
    }
    if (!('grantId' in value)) {
        return (value.requiredIndependence === 'session-independent' &&
            value.sessionId !== actor.sessionId &&
            (value.achievedIndependence === 'provider-independent' ||
                value.achievedIndependence === 'session-independent'));
    }
    return (value.degradedForm === 'same-provider-fresh-session' &&
        value.providerId === actor.providerId &&
        value.achievedIndependence === 'session-independent' &&
        value.author.providerId === actor.providerId &&
        value.author.sessionId === actor.sessionId &&
        value.participant.providerId === value.providerId &&
        value.participant.sessionId === value.sessionId &&
        value.participant.engineSpawned === true &&
        value.participant.principalId ===
            `collaboration-grant:${value.grantId}:task-diff-reviewer`);
}
function isTaskStrategyImplementationAssignmentForAuthor(value, author, subjectDigest) {
    if (!isProviderRoleAssignment(value) ||
        value.role !== 'task-implementer' ||
        value.targetDigest !== subjectDigest) {
        return false;
    }
    if (!('grantId' in value)) {
        return (value.requiredIndependence === 'session-independent' &&
            value.sessionId !== author.sessionId &&
            (value.achievedIndependence === 'provider-independent' ||
                value.achievedIndependence === 'session-independent'));
    }
    return (value.degradedForm === 'same-provider-fresh-session' &&
        value.providerId === author.providerId &&
        value.achievedIndependence === 'session-independent' &&
        value.author.providerId === author.providerId &&
        value.author.sessionId === author.sessionId &&
        value.participant.providerId === value.providerId &&
        value.participant.sessionId === value.sessionId &&
        value.participant.engineSpawned === true &&
        value.participant.principalId ===
            `collaboration-grant:${value.grantId}:task-implementer`);
}
function isTaskStrategyRedAuthor(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, [
            'providerId',
            'sessionId',
            'principalId',
            'identityAssurance',
            'engineSpawned',
        ]) &&
        (value.providerId === 'codex' || value.providerId === 'claude') &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        value.principalId === `provider:${value.providerId}` &&
        (value.identityAssurance === 'self-declared' ||
            value.identityAssurance === 'runtime-hint' ||
            value.identityAssurance === 'adapter-assigned') &&
        value.engineSpawned === false);
}
function isTaskDiffReviewMandateBinding(value, changeId) {
    return (value === null ||
        (isPlainRecord(value) &&
            hasExactKeys(value, [
                'schemaVersion',
                'mandateTaskId',
                'mandateId',
                'mandateDigest',
                'changeId',
                'externalAuditRoot',
            ]) &&
            value.schemaVersion === 1 &&
            typeof value.mandateTaskId === 'string' &&
            value.mandateTaskId.length > 0 &&
            typeof value.mandateId === 'string' &&
            value.mandateId.length > 0 &&
            isDigest(value.mandateDigest) &&
            value.changeId === changeId &&
            typeof value.externalAuditRoot === 'string' &&
            value.externalAuditRoot.length > 0));
}
