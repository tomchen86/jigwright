import { createPlanReviewDispositionProtocol } from "./plan-review-disposition.js";
import { createPlanReviewSubmissionProtocol } from "./plan-review-submission.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertStoredEvidenceNode, createEvidenceNode, } from "../../adapters/planning/investigation/evidence-node.js";
import { verifySshSignatureWithPublicKey, } from "../../adapters/signing/ssh/maintainer-signer.js";
import { normalizeExactRepositoryPath } from "../../runtime/session-workspace/paths.js";
import { isProviderId } from "../provider-orchestration/provider-registry.js";
import { isProviderRoleAssignment, recreateProviderInvocationRequest, } from "../provider-orchestration/provider-contracts.js";
import { assertProviderProcessResult } from "../provider-orchestration/provider-runtime-evidence.js";
import { assertPlanningGeneration, } from "../lifecycle/planning-generation.js";
import { normalizeInvestigationRequirementsV3 } from "../investigation/manifest/investigation-manifest.js";
import { createPlanReviewTargetSnapshotForSubject, readPlanReviewTargetSnapshotNode, } from "./plan-review-target-snapshot.js";
import { deepFreeze, hasExactKeys, isDigest, isRecord, sha256, } from "./plan-review-values.js";
export { assertPlanReviewTargetSnapshot, planReviewSnapshotLineCount, readPlanReviewTargetSnapshotNode, } from "./plan-review-target-snapshot.js";
/**
 * Bind a planning generation into an immutable review subject. The subject
 * digest fixes the governing generation, exact plan target, investigation
 * baseline and dependencies, review policy, and required independence. The
 * review policy must match the generation's own review policy so a subject
 * cannot bind an inconsistent policy.
 */
export function createPlanReviewSubject(input) {
    if (!isRecord(input) ||
        !hasExactKeys(input, [
            'generation',
            'reviewPolicyDigest',
            'requiredIndependence',
        ])) {
        throw planReviewInvalid('Plan review subject input shape is malformed.');
    }
    let generation;
    try {
        generation = assertPlanningGeneration(input.generation);
    }
    catch {
        throw planReviewInvalid('Plan review subject generation is malformed.');
    }
    const reviewPolicyDigest = input.reviewPolicyDigest;
    const requiredIndependence = input.requiredIndependence;
    const generationPolicy = generation.policies.reviewPolicyDigest;
    if (!isDigest(generation.planningGenerationId) ||
        !isDigest(generation.targetDigest) ||
        !isDigest(generationPolicy) ||
        !isDigest(reviewPolicyDigest) ||
        reviewPolicyDigest !== generationPolicy) {
        throw planReviewInvalid('Plan review policy digest must match the planning generation.');
    }
    if (requiredIndependence !== 'session-independent') {
        throw planReviewInvalid('Plan review requires session-independent separation.');
    }
    const baseline = assertBaseline(generation.investigationBaseline);
    const dependencies = assertDependencies(generation.investigationDependencies);
    const requirements = structuredClone(generation.investigationRequirements);
    const fields = {
        planningGenerationId: generation.planningGenerationId,
        planTargetDigest: generation.targetDigest,
        manifestDigest: generation.manifestDigest,
        investigationTargetDigest: generation.investigationTargetDigest,
        reviewPolicyDigest,
        requiredIndependence,
        investigationBaseline: baseline,
        investigationDependencies: dependencies,
        investigationRequirements: requirements,
    };
    const subject = {
        schemaVersion: 1,
        subjectDigest: planReviewSubjectDigest(fields),
        planningGenerationId: fields.planningGenerationId,
        planTargetDigest: fields.planTargetDigest,
        manifestDigest: fields.manifestDigest,
        investigationTargetDigest: fields.investigationTargetDigest,
        reviewPolicyDigest: fields.reviewPolicyDigest,
        requiredIndependence: fields.requiredIndependence,
        investigationBaseline: fields.investigationBaseline,
        investigationDependencies: fields.investigationDependencies,
        investigationRequirements: fields.investigationRequirements,
    };
    return assertPlanReviewSubject(subject);
}
/**
 * Strictly replay a serialized PlanReview subject. The subject is a closed
 * schema, carries canonical investigation dependencies, and must reproduce its
 * own digest. Construction separately validates the complete planning generation
 * so a caller cannot manufacture a subject from a trusted-looking generation ID.
 */
export function assertPlanReviewSubject(value) {
    const record = assertExactKeys(value, SUBJECT_KEYS);
    if (record.schemaVersion !== 1 ||
        !isDigest(record.subjectDigest) ||
        !isDigest(record.planningGenerationId) ||
        !isDigest(record.planTargetDigest) ||
        !isDigest(record.manifestDigest) ||
        !isDigest(record.investigationTargetDigest) ||
        !isDigest(record.reviewPolicyDigest) ||
        record.requiredIndependence !== 'session-independent') {
        throw planReviewInvalid('Plan review subject binding is malformed.');
    }
    const investigationBaseline = assertBaseline(record.investigationBaseline);
    const investigationDependencies = assertDependencies(record.investigationDependencies);
    const investigationRequirements = assertInvestigationRequirements(record.investigationRequirements);
    const subject = {
        schemaVersion: 1,
        subjectDigest: record.subjectDigest,
        planningGenerationId: record.planningGenerationId,
        planTargetDigest: record.planTargetDigest,
        manifestDigest: record.manifestDigest,
        investigationTargetDigest: record.investigationTargetDigest,
        reviewPolicyDigest: record.reviewPolicyDigest,
        requiredIndependence: 'session-independent',
        investigationBaseline,
        investigationDependencies,
        investigationRequirements,
    };
    if (planReviewSubjectDigest(subject) !== subject.subjectDigest) {
        throw planReviewInvalid('Plan review subject digest does not match.');
    }
    return deepFreeze(subject);
}
/**
 * Recompute the canonical subject digest from its governing fields. Live
 * construction and replay validation share this so a tampered subject whose
 * stored digest no longer matches its fields is detectable.
 */
export function planReviewSubjectDigest(fields) {
    return sha256(canonicalJson({
        schema: 'plan-review-subject.v1',
        planningGenerationId: fields.planningGenerationId,
        planTargetDigest: fields.planTargetDigest,
        manifestDigest: fields.manifestDigest,
        investigationTargetDigest: fields.investigationTargetDigest,
        reviewPolicyDigest: fields.reviewPolicyDigest,
        requiredIndependence: fields.requiredIndependence,
        investigationBaseline: fields.investigationBaseline,
        investigationDependencies: fields.investigationDependencies,
        investigationRequirements: fields.investigationRequirements,
    }));
}
/** Wrap one exact provider request/result pair in tracked PlanReview evidence. */
export function createPlanReviewProviderResultNode(input) {
    if (!isRecord(input) ||
        !hasExactKeys(input, [
            'subject',
            'assignment',
            'request',
            'result',
            'targetSnapshotNode',
        ])) {
        throw planReviewInvalid('Plan review provider result input is malformed.');
    }
    const subject = assertPlanReviewSubject(input.subject);
    const assignment = assertAssignment(input.assignment, subject);
    const request = assertPlanReviewProviderRequest(input.request, assignment);
    const result = assertPlanReviewProviderProcessResult(input.result, request);
    const normalized = assertPlanReviewProviderSubmission(result.output);
    assertSubmissionEvidenceBindings(normalized, subject);
    const targetSnapshot = assertProviderTargetSnapshot(input.targetSnapshotNode, subject);
    const assignmentDigest = planReviewAssignmentDigest(assignment);
    return createEvidenceNode({
        type: PROVIDER_RESULT_TYPE,
        nodeSchema: PROVIDER_RESULT_SCHEMA,
        evaluator: PROVIDER_RESULT_EVALUATOR,
        policyDigest: request.policyDigest,
        exactInputDigests: {
            assignment: assignmentDigest,
            output: result.outputDigest,
            request: request.requestDigest,
            runtimeObservation: sha256(canonicalJson(result.runtimeObservation)),
            subject: subject.subjectDigest,
            targetSnapshot: targetSnapshot.nodeId,
        },
        semanticParentResultDigests: {
            targetSnapshot: targetSnapshot.resultDigest,
        },
        provenanceParentNodeIds: { targetSnapshot: targetSnapshot.nodeId },
        outputSchema: PROVIDER_RESULT_OUTPUT_SCHEMA,
        output: {
            schemaVersion: 3,
            subjectDigest: subject.subjectDigest,
            assignment,
            request,
            result,
        },
        runtimeMetadata: {},
    });
}
export function assertCurrentPlanReviewProviderResultNode(value, expectedProviderInvocation, expectedContent, expectedSubmissionDigest) {
    const node = assertStoredEvidenceNode(value, () => planReviewInvalid('Provider result node is malformed.'));
    if (node.type !== PROVIDER_RESULT_TYPE ||
        node.nodeSchema !== PROVIDER_RESULT_SCHEMA ||
        node.evaluator !== PROVIDER_RESULT_EVALUATOR ||
        node.outputSchema !== PROVIDER_RESULT_OUTPUT_SCHEMA) {
        throw planReviewInvalid('Provider result node identity is unexpected.');
    }
    assertExactDigestRoles(node.exactInputDigests, [
        'assignment',
        'output',
        'request',
        'runtimeObservation',
        'subject',
        'targetSnapshot',
    ], 'Provider result exact-input roles are unexpected.');
    assertExactDigestRoles(node.semanticParentResultDigests, ['targetSnapshot'], 'Provider result semantic-parent roles are unexpected.');
    assertExactDigestRoles(node.provenanceParentNodeIds, ['targetSnapshot'], 'Provider result provenance-parent roles are unexpected.');
    if (Object.keys(node.runtimeMetadata).length !== 0 ||
        node.exactInputDigests.targetSnapshot !==
            node.provenanceParentNodeIds.targetSnapshot ||
        !isDigest(node.semanticParentResultDigests.targetSnapshot)) {
        throw planReviewInvalid('Provider result target binding is malformed.');
    }
    const output = assertExactKeys(node.output, PROVIDER_RESULT_OUTPUT_KEYS);
    if (output.schemaVersion !== 3 || !isDigest(output.subjectDigest)) {
        throw planReviewInvalid('Provider result output identity is malformed.');
    }
    const assignment = assertAssignmentForSubjectDigest(output.assignment, output.subjectDigest);
    const request = assertPlanReviewProviderRequest(output.request, assignment);
    const result = assertPlanReviewProviderProcessResult(output.result, request);
    const submission = canonicalSubmission(assertPlanReviewProviderSubmission(result.output));
    if (node.policyDigest !== request.policyDigest ||
        node.exactInputDigests.subject !== output.subjectDigest ||
        node.exactInputDigests.assignment !==
            planReviewAssignmentDigest(assignment) ||
        node.exactInputDigests.request !== request.requestDigest ||
        node.exactInputDigests.output !== result.outputDigest ||
        node.exactInputDigests.runtimeObservation !==
            sha256(canonicalJson(result.runtimeObservation)) ||
        expectedSubmissionDigest !== planReviewSubmissionDigest(submission) ||
        !planReviewProviderResultMatchesInvocation(request, result, assignment, expectedProviderInvocation) ||
        !planReviewProviderResultMatchesContent(node, request, expectedContent)) {
        throw planReviewInvalid('Provider result does not carry current invocation-bound evidence.');
    }
    return node;
}
function assertPlanReviewProviderRequest(value, assignment) {
    let request;
    try {
        request = recreateProviderInvocationRequest(value);
    }
    catch {
        throw planReviewInvalid('Plan review provider request is malformed.');
    }
    if (request.purpose !== 'plan-review' ||
        request.providerId !== assignment.providerId ||
        request.targetDigest !== assignment.targetDigest ||
        request.evaluatorVersion !== PLAN_REVIEW_EVALUATOR ||
        canonicalJson(request.roleAssignment) !== canonicalJson(assignment) ||
        canonicalJson(request.outputSchema) !==
            canonicalJson(PLAN_REVIEW_OUTPUT_SCHEMA)) {
        throw planReviewInvalid('Plan review provider request is unbound.');
    }
    return request;
}
function assertPlanReviewProviderProcessResult(value, request) {
    let result;
    try {
        result = assertProviderProcessResult(request, value, PLAN_REVIEW_OUTPUT_VALIDATOR, () => planReviewInvalid('Plan review provider result is malformed.'));
    }
    catch {
        throw planReviewInvalid('Plan review provider result is malformed.');
    }
    if (result.runtimeObservation === null) {
        throw planReviewInvalid('Plan review provider result requires a fixed-runner observation.');
    }
    return result;
}
function planReviewProviderResultMatchesInvocation(request, result, assignment, value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'invocationId',
            'requestDigest',
            'outputDigest',
            'providerId',
            'sessionId',
            'targetDigest',
            'engineSpawned',
        ]) &&
        result.runtimeObservation !== null &&
        value.invocationId === request.invocationId &&
        value.requestDigest === request.requestDigest &&
        value.outputDigest === result.outputDigest &&
        value.providerId === request.providerId &&
        value.providerId === assignment.providerId &&
        value.sessionId === assignment.sessionId &&
        value.targetDigest === assignment.targetDigest &&
        value.engineSpawned === true);
}
function planReviewProviderResultMatchesContent(node, request, value) {
    return (isRecord(value) &&
        hasExactKeys(value, [
            'kind',
            'nodeId',
            'resultDigest',
            'outputSchema',
            'evaluator',
            'policyDigest',
            'contentDigest',
            'current',
        ]) &&
        value.kind === 'plan-review' &&
        value.nodeId === node.nodeId &&
        value.resultDigest === node.resultDigest &&
        canonicalJson(value.outputSchema) === canonicalJson(request.outputSchema) &&
        value.evaluator === request.evaluatorVersion &&
        value.policyDigest === request.policyDigest &&
        value.contentDigest === node.resultDigest &&
        value.current === true);
}
export function planReviewAssignmentDigest(assignment) {
    return sha256(canonicalJson({
        schema: 'plan-review-assignment.v1',
        assignment,
    }));
}
/**
 * Construct an immutable exact-plan review evidence node from a strict
 * submission. The submission must carry complete coverage and an evidence-bound
 * challenge or structured no-challenge conclusion; the reviewer assignment must
 * bind this subject with achieved provider independence; and the provider result
 * must have observed the same subject. The node binds the subject, assignment,
 * and submission digests and derives its identity from that canonical content.
 */
export function createPlanReviewNode(input) {
    if (!isRecord(input) ||
        !hasExactKeys(input, [
            'subject',
            'assignment',
            'providerResultNode',
            'submission',
        ])) {
        throw planReviewInvalid('Plan review node input shape is malformed.');
    }
    const subject = assertPlanReviewSubject(input.subject);
    const assignment = assertAssignment(input.assignment, subject);
    const normalized = assertPlanReviewSubmission(input.submission);
    assertSubmissionEvidenceBindings(normalized, subject);
    const submission = canonicalSubmission(normalized);
    const providerResult = assertProviderResult(input.providerResultNode, subject, assignment, submission);
    const output = {
        schemaVersion: 2,
        planningGenerationId: subject.planningGenerationId,
        planTargetDigest: subject.planTargetDigest,
        subjectDigest: subject.subjectDigest,
        assignment,
        verdict: normalized.verdict,
        coverage: normalized.coverage,
        scopeAssessment: normalized.scopeAssessment,
        findings: normalized.findings,
        suggestions: normalized.suggestions,
        proposedTerms: normalized.proposedTerms,
        residualRisk: normalized.residualRisk,
        uncertainty: normalized.uncertainty,
        requiredIndependence: assignment.requiredIndependence,
        achievedIndependence: assignment.achievedIndependence,
    };
    const submissionDigest = planReviewSubmissionDigest(submission);
    const assignmentDigest = planReviewAssignmentDigest(assignment);
    return createEvidenceNode({
        type: PLAN_REVIEW_TYPE,
        nodeSchema: PLAN_REVIEW_SCHEMA,
        evaluator: PLAN_REVIEW_EVALUATOR,
        policyDigest: subject.reviewPolicyDigest,
        exactInputDigests: {
            subject: subject.subjectDigest,
            assignment: assignmentDigest,
            submission: submissionDigest,
        },
        semanticParentResultDigests: {
            providerResult: providerResult.resultDigest,
        },
        provenanceParentNodeIds: { providerResult: providerResult.nodeId },
        outputSchema: PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
        output,
        runtimeMetadata: {},
    });
}
/**
 * Read a stored plan-review node back into a deeply frozen typed report. The
 * node identity, complete coverage, evidence-bound findings, recomputed finding
 * identities, scope conclusion, terms, and independence are all revalidated so a
 * tampered stored node fails closed.
 */
export function readPlanReviewNode(node) {
    const validated = assertStoredEvidenceNode(node, () => planReviewInvalid('Plan review node envelope is malformed.'));
    if (validated.type !== PLAN_REVIEW_TYPE ||
        validated.nodeSchema !== PLAN_REVIEW_SCHEMA ||
        validated.evaluator !== PLAN_REVIEW_EVALUATOR ||
        validated.outputSchema !== PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID) {
        throw planReviewInvalid('Plan review node identity is unexpected.');
    }
    assertExactDigestRoles(validated.exactInputDigests, ['assignment', 'subject', 'submission'], 'Plan review exact-input roles are unexpected.');
    assertExactDigestRoles(validated.semanticParentResultDigests, ['providerResult'], 'Plan review semantic-parent roles are unexpected.');
    assertExactDigestRoles(validated.provenanceParentNodeIds, ['providerResult'], 'Plan review provenance-parent roles are unexpected.');
    if (Object.keys(validated.runtimeMetadata).length !== 0) {
        throw planReviewInvalid('Plan review runtime metadata must be empty.');
    }
    const subjectDigest = validated.exactInputDigests.subject;
    if (!isDigest(subjectDigest)) {
        throw planReviewInvalid('Plan review node is not bound to a subject.');
    }
    const output = assertExactKeys(validated.output, OUTPUT_KEYS);
    if (output.schemaVersion !== 2) {
        throw planReviewInvalid('Plan review output schema version must be 2.');
    }
    if (!isDigest(output.planningGenerationId) ||
        !isDigest(output.planTargetDigest) ||
        output.subjectDigest !== subjectDigest) {
        throw planReviewInvalid('Plan review governing identities are malformed.');
    }
    const assignment = assertAssignmentForSubjectDigest(output.assignment, subjectDigest);
    if (validated.exactInputDigests.assignment !==
        planReviewAssignmentDigest(assignment)) {
        throw planReviewInvalid('Plan review assignment digest does not match.');
    }
    if (typeof output.verdict !== 'string' || !VERDICTS.has(output.verdict)) {
        throw planReviewInvalid('Plan review verdict is unexpected.');
    }
    const coverage = assertCoverage(output.coverage);
    const findings = assertBoundedArray(output.findings, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many stored findings.').map((entry) => assertStoredChallenge(entry));
    assertUniqueChallengeIds(findings.map((finding) => finding.findingId));
    assertCanonicalIdentityOrder(findings.map((finding) => finding.findingId), 'Plan review challenges are not canonically sorted.');
    const suggestions = assertBoundedArray(output.suggestions, PLAN_REVIEW_LIMITS.maxSuggestions, 'Plan review contains too many stored suggestions.').map((entry) => assertStoredSuggestion(entry));
    assertCanonicalIdentityOrder(suggestions.map((suggestion) => suggestion.suggestionId), 'Plan review suggestions are not canonically sorted.', true);
    const proposedTerms = assertProposedTerms(output.proposedTerms);
    const residualRisk = assertBoundedRequiredText(output.residualRisk, PLAN_REVIEW_LIMITS.maxResidualRiskBytes, 'Plan review residual risk is malformed.');
    const uncertainty = assertBoundedRequiredText(output.uncertainty, PLAN_REVIEW_LIMITS.maxUncertaintyBytes, 'Plan review uncertainty is malformed.');
    const scopeAssessment = assertScopeAssessment(output.scopeAssessment, findings);
    if (output.requiredIndependence !== assignment.requiredIndependence ||
        output.achievedIndependence !== assignment.achievedIndependence ||
        (assignment.requiredIndependence !== 'session-independent' &&
            assignment.requiredIndependence !== 'provider-independent')) {
        throw planReviewInvalid('Plan review independence labels are unexpected.');
    }
    const normalizedSubmission = assertPlanReviewSubmission({
        schemaVersion: 2,
        verdict: output.verdict,
        coverage,
        scopeAssessment,
        findings: findings.map(stripChallengeIdentity),
        proposedTerms,
        suggestions: suggestions.map(stripSuggestionIdentity),
        residualRisk,
        uncertainty,
    });
    const submission = canonicalSubmission(normalizedSubmission);
    const storedSubmission = {
        schemaVersion: 2,
        verdict: output.verdict,
        coverage: output.coverage,
        scopeAssessment: output.scopeAssessment,
        findings: findings.map(stripChallengeIdentity),
        proposedTerms: output.proposedTerms,
        suggestions: suggestions.map(stripSuggestionIdentity),
        residualRisk: output.residualRisk,
        uncertainty: output.uncertainty,
    };
    if (canonicalJson(storedSubmission) !== canonicalJson(submission)) {
        throw planReviewInvalid('Plan review output is not canonically normalized.');
    }
    if (validated.exactInputDigests.submission !==
        planReviewSubmissionDigest(submission)) {
        throw planReviewInvalid('Plan review submission digest does not match.');
    }
    const report = {
        schemaVersion: 2,
        nodeId: validated.nodeId,
        resultDigest: validated.resultDigest,
        policyDigest: validated.policyDigest,
        subjectDigest,
        planningGenerationId: output.planningGenerationId,
        planTargetDigest: output.planTargetDigest,
        assignment,
        providerResultNodeId: validated.provenanceParentNodeIds.providerResult,
        providerResultResultDigest: validated.semanticParentResultDigests.providerResult,
        verdict: output.verdict,
        coverage,
        scopeAssessment,
        findings,
        suggestions,
        proposedTerms,
        residualRisk,
        uncertainty,
        requiredIndependence: assignment.requiredIndependence,
        achievedIndependence: assignment.achievedIndependence,
    };
    return deepFreeze(report);
}
function assertAssignment(value, subject) {
    return assertAssignmentForSubjectDigest(value, subject.subjectDigest);
}
function assertAssignmentForSubjectDigest(value, subjectDigest) {
    if (!isProviderRoleAssignment(value)) {
        throw planReviewInvalid('Plan reviewer assignment shape is malformed.');
    }
    if (value.role !== 'plan-reviewer' ||
        !isProviderId(value.providerId) ||
        typeof value.sessionId !== 'string' ||
        value.sessionId.trim().length === 0 ||
        Buffer.byteLength(value.sessionId, 'utf8') >
            PLAN_REVIEW_LIMITS.maxAuthorBytes ||
        value.targetDigest !== subjectDigest ||
        (value.requiredIndependence !== 'session-independent' &&
            value.requiredIndependence !== 'provider-independent')) {
        throw planReviewInvalid('Plan reviewer assignment does not bind the subject.');
    }
    return structuredClone(value);
}
function assertProviderResult(value, subject, assignment, expectedSubmission) {
    const node = assertStoredEvidenceNode(value, () => planReviewInvalid('Provider result node is malformed.'));
    if (node.type !== PROVIDER_RESULT_TYPE ||
        node.nodeSchema !== PROVIDER_RESULT_SCHEMA ||
        node.evaluator !== PROVIDER_RESULT_EVALUATOR ||
        node.outputSchema !== PROVIDER_RESULT_OUTPUT_SCHEMA) {
        throw planReviewInvalid('Provider result node identity is unexpected.');
    }
    assertExactDigestRoles(node.exactInputDigests, [
        'assignment',
        'output',
        'request',
        'runtimeObservation',
        'subject',
        'targetSnapshot',
    ], 'Provider result exact-input roles are unexpected.');
    assertExactDigestRoles(node.semanticParentResultDigests, ['targetSnapshot'], 'Provider result semantic-parent roles are unexpected.');
    assertExactDigestRoles(node.provenanceParentNodeIds, ['targetSnapshot'], 'Provider result provenance-parent roles are unexpected.');
    if (Object.keys(node.runtimeMetadata).length !== 0) {
        throw planReviewInvalid('Provider result runtime metadata must be empty.');
    }
    if (node.exactInputDigests.targetSnapshot !==
        node.provenanceParentNodeIds.targetSnapshot ||
        !isDigest(node.semanticParentResultDigests.targetSnapshot)) {
        throw planReviewInvalid('Provider result target snapshot binding is malformed.');
    }
    const output = assertExactKeys(node.output, PROVIDER_RESULT_OUTPUT_KEYS);
    if (output.schemaVersion !== 3 ||
        output.subjectDigest !== subject.subjectDigest ||
        node.exactInputDigests.subject !== subject.subjectDigest) {
        throw planReviewInvalid('Provider result did not observe the review subject.');
    }
    const storedAssignment = assertAssignment(output.assignment, subject);
    const request = assertPlanReviewProviderRequest(output.request, storedAssignment);
    const result = assertPlanReviewProviderProcessResult(output.result, request);
    const normalizedSubmission = assertPlanReviewProviderSubmission(result.output);
    assertSubmissionEvidenceBindings(normalizedSubmission, subject);
    const submission = canonicalSubmission(normalizedSubmission);
    if (canonicalJson(storedAssignment) !== canonicalJson(assignment) ||
        node.exactInputDigests.assignment !==
            planReviewAssignmentDigest(storedAssignment) ||
        node.policyDigest !== request.policyDigest ||
        node.exactInputDigests.request !== request.requestDigest ||
        node.exactInputDigests.output !== result.outputDigest ||
        node.exactInputDigests.runtimeObservation !==
            sha256(canonicalJson(result.runtimeObservation))) {
        throw planReviewInvalid('Provider result did not use the reviewer assignment and request.');
    }
    if (canonicalJson(submission) !== canonicalJson(expectedSubmission)) {
        throw planReviewInvalid('Provider result semantic output differs from the review submission.');
    }
    return node;
}
function assertProviderTargetSnapshot(value, subject) {
    const node = assertStoredEvidenceNode(value, () => planReviewInvalid('Provider target snapshot node is malformed.'));
    let snapshot;
    try {
        snapshot = readPlanReviewTargetSnapshotNode(node);
    }
    catch {
        throw planReviewInvalid('Provider target snapshot node is malformed.');
    }
    if (snapshot.subjectDigest !== subject.subjectDigest ||
        snapshot.planningGenerationId !== subject.planningGenerationId ||
        snapshot.planTargetDigest !== subject.planTargetDigest ||
        node.policyDigest !== subject.reviewPolicyDigest) {
        throw planReviewInvalid('Provider target snapshot does not bind the review subject.');
    }
    return node;
}
function assertBaseline(value) {
    if (!isRecord(value) || !hasExactKeys(value, ['head', 'tree'])) {
        throw planReviewInvalid('Investigation baseline is malformed.');
    }
    const head = value.head;
    const tree = value.tree;
    if (typeof head !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(head) ||
        typeof tree !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(tree) ||
        head.length !== tree.length) {
        throw planReviewInvalid('Investigation baseline is malformed.');
    }
    return { head, tree };
}
function assertDependencies(value) {
    const dependencies = assertBoundedArray(value, PLAN_REVIEW_LIMITS.maxInvestigationDependencies, 'Plan review subject has too many investigation dependencies.').map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, ['role', 'nodeId', 'resultDigest'])) {
            throw planReviewInvalid('Investigation dependency is malformed.');
        }
        const role = entry.role;
        const nodeId = entry.nodeId;
        const resultDigest = entry.resultDigest;
        if (!isBoundedNonBlankText(role, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
            !isDigest(nodeId) ||
            !isDigest(resultDigest)) {
            throw planReviewInvalid('Investigation dependency is malformed.');
        }
        return { role: role, nodeId, resultDigest };
    });
    const sorted = [...dependencies].sort((left, right) => {
        const leftKey = `${left.role}\u0000${left.nodeId}\u0000${left.resultDigest}`;
        const rightKey = `${right.role}\u0000${right.nodeId}\u0000${right.resultDigest}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const identities = new Set();
    for (const dependency of sorted) {
        const identity = `${dependency.role}\u0000${dependency.nodeId}`;
        if (identities.has(identity)) {
            throw planReviewInvalid('Investigation dependency is duplicated.');
        }
        identities.add(identity);
    }
    if (canonicalJson(dependencies) !== canonicalJson(sorted)) {
        throw planReviewInvalid('Investigation dependencies are not canonically sorted.');
    }
    return sorted;
}
function assertInvestigationRequirements(value) {
    let requirements;
    try {
        requirements = normalizeInvestigationRequirementsV3(value);
    }
    catch {
        throw planReviewInvalid('Investigation requirements are malformed.');
    }
    if (canonicalJson(requirements) !== canonicalJson(value)) {
        throw planReviewInvalid('Investigation requirements are not canonically sorted.');
    }
    return requirements;
}
function assertExactDigestRoles(value, roles, message) {
    const actual = Object.keys(value).sort();
    const expected = [...roles].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw planReviewInvalid(message);
    }
}
export function createPlanReviewTargetSnapshotNode(input) {
    const subject = assertPlanReviewSubject(input.subject);
    return createPlanReviewTargetSnapshotForSubject(input, subject);
}
const planReviewSubmissionProtocol = createPlanReviewSubmissionProtocol({
    normalizeExactRepositoryPath,
});
export const PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE = planReviewSubmissionProtocol.PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE;
export const PLAN_REVIEW_MAX_PROPOSED_TERMS = planReviewSubmissionProtocol.PLAN_REVIEW_MAX_PROPOSED_TERMS;
export const PLAN_REVIEW_COVERAGE = planReviewSubmissionProtocol.PLAN_REVIEW_COVERAGE;
export const PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA = planReviewSubmissionProtocol.PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA;
export const PLAN_REVIEW_OUTPUT_SCHEMA = planReviewSubmissionProtocol.PLAN_REVIEW_OUTPUT_SCHEMA;
export const PLAN_REVIEW_OUTPUT_VALIDATOR = planReviewSubmissionProtocol.PLAN_REVIEW_OUTPUT_VALIDATOR;
export const planReviewSubmissionDigest = planReviewSubmissionProtocol.planReviewSubmissionDigest;
export const canonicalizePlanReviewProviderSubmission = planReviewSubmissionProtocol.canonicalizePlanReviewProviderSubmission;
export const canonicalizePlanReviewSubmission = planReviewSubmissionProtocol.canonicalizePlanReviewSubmission;
export const planReviewProviderSubmission = planReviewSubmissionProtocol.planReviewProviderSubmission;
const planReviewInvalid = planReviewSubmissionProtocol.planReviewInvalid;
const assertExactKeys = planReviewSubmissionProtocol.assertExactKeys;
const SUBJECT_KEYS = planReviewSubmissionProtocol.SUBJECT_KEYS;
const assertPlanReviewProviderSubmission = planReviewSubmissionProtocol.assertPlanReviewProviderSubmission;
const assertSubmissionEvidenceBindings = planReviewSubmissionProtocol.assertSubmissionEvidenceBindings;
const PROVIDER_RESULT_TYPE = planReviewSubmissionProtocol.PROVIDER_RESULT_TYPE;
const PROVIDER_RESULT_SCHEMA = planReviewSubmissionProtocol.PROVIDER_RESULT_SCHEMA;
const PROVIDER_RESULT_EVALUATOR = planReviewSubmissionProtocol.PROVIDER_RESULT_EVALUATOR;
const PROVIDER_RESULT_OUTPUT_SCHEMA = planReviewSubmissionProtocol.PROVIDER_RESULT_OUTPUT_SCHEMA;
const PROVIDER_RESULT_OUTPUT_KEYS = planReviewSubmissionProtocol.PROVIDER_RESULT_OUTPUT_KEYS;
const canonicalSubmission = planReviewSubmissionProtocol.canonicalSubmission;
const PLAN_REVIEW_EVALUATOR = planReviewSubmissionProtocol.PLAN_REVIEW_EVALUATOR;
const assertPlanReviewSubmission = planReviewSubmissionProtocol.assertPlanReviewSubmission;
const PLAN_REVIEW_TYPE = planReviewSubmissionProtocol.PLAN_REVIEW_TYPE;
const PLAN_REVIEW_SCHEMA = planReviewSubmissionProtocol.PLAN_REVIEW_SCHEMA;
const PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID = planReviewSubmissionProtocol.PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID;
const OUTPUT_KEYS = planReviewSubmissionProtocol.OUTPUT_KEYS;
const VERDICTS = planReviewSubmissionProtocol.VERDICTS;
const assertCoverage = planReviewSubmissionProtocol.assertCoverage;
const assertBoundedArray = planReviewSubmissionProtocol.assertBoundedArray;
const PLAN_REVIEW_LIMITS = planReviewSubmissionProtocol.PLAN_REVIEW_LIMITS;
const assertStoredChallenge = planReviewSubmissionProtocol.assertStoredChallenge;
const assertUniqueChallengeIds = planReviewSubmissionProtocol.assertUniqueChallengeIds;
const assertCanonicalIdentityOrder = planReviewSubmissionProtocol.assertCanonicalIdentityOrder;
const assertStoredSuggestion = planReviewSubmissionProtocol.assertStoredSuggestion;
const assertProposedTerms = planReviewSubmissionProtocol.assertProposedTerms;
const assertBoundedRequiredText = planReviewSubmissionProtocol.assertBoundedRequiredText;
const assertScopeAssessment = planReviewSubmissionProtocol.assertScopeAssessment;
const stripChallengeIdentity = planReviewSubmissionProtocol.stripChallengeIdentity;
const stripSuggestionIdentity = planReviewSubmissionProtocol.stripSuggestionIdentity;
const DISPOSITION_TYPE = planReviewSubmissionProtocol.DISPOSITION_TYPE;
const DISPOSITION_SCHEMA = planReviewSubmissionProtocol.DISPOSITION_SCHEMA;
const DISPOSITION_EVALUATOR = planReviewSubmissionProtocol.DISPOSITION_EVALUATOR;
const DISPOSITION_OUTPUT_SCHEMA = planReviewSubmissionProtocol.DISPOSITION_OUTPUT_SCHEMA;
const GIT_OBJECT_ID_PATTERN = planReviewSubmissionProtocol.GIT_OBJECT_ID_PATTERN;
const isBoundedNonBlankText = planReviewSubmissionProtocol.isBoundedNonBlankText;
const AUTHORIZED_DISPOSITION_SCHEMA = planReviewSubmissionProtocol.AUTHORIZED_DISPOSITION_SCHEMA;
const AUTHORIZED_DISPOSITION_EVALUATOR = planReviewSubmissionProtocol.AUTHORIZED_DISPOSITION_EVALUATOR;
const AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA = planReviewSubmissionProtocol.AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA;
const DISPOSITION_DECISIONS = planReviewSubmissionProtocol.DISPOSITION_DECISIONS;
const AUTHORIZED_DISPOSITION_DECISIONS = planReviewSubmissionProtocol.AUTHORIZED_DISPOSITION_DECISIONS;
const planReviewDispositionProtocol = createPlanReviewDispositionProtocol({
    planReviewInvalid,
    readPlanReviewNode,
    assertBoundedArray,
    PLAN_REVIEW_LIMITS,
    createEvidenceNode,
    DISPOSITION_TYPE,
    DISPOSITION_SCHEMA,
    DISPOSITION_EVALUATOR,
    DISPOSITION_OUTPUT_SCHEMA,
    GIT_OBJECT_ID_PATTERN,
    isBoundedNonBlankText,
    PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    AUTHORIZED_DISPOSITION_SCHEMA,
    AUTHORIZED_DISPOSITION_EVALUATOR,
    AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA,
    assertStoredEvidenceNode,
    assertExactDigestRoles,
    assertExactKeys,
    verifySshSignatureWithPublicKey,
    DISPOSITION_DECISIONS,
    AUTHORIZED_DISPOSITION_DECISIONS,
});
export const createPlanReviewDispositionNode = planReviewDispositionProtocol.createPlanReviewDispositionNode;
export const createAuthorizedPlanReviewDispositionNode = planReviewDispositionProtocol.createAuthorizedPlanReviewDispositionNode;
export const readPlanReviewDispositionNode = planReviewDispositionProtocol.readPlanReviewDispositionNode;
export const assertAuthorizedPlanReviewChallengeClosure = planReviewDispositionProtocol.assertAuthorizedPlanReviewChallengeClosure;
