import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError, } from "../../foundation/errors/errors.js";
import { assertStoredEvidenceNode, createEvidenceNode, } from "../../adapters/planning/investigation/evidence-node.js";
import { normalizeInvestigationTerm, } from "../investigation/domain/investigation-terms.js";
import { verifySshSignatureWithPublicKey, } from "../../adapters/signing/ssh/maintainer-signer.js";
import { normalizeExactRepositoryPath } from "../../runtime/session-workspace/paths.js";
import { isProviderId } from "../provider-orchestration/provider-registry.js";
import { isProviderRoleAssignment, recreateProviderInvocationRequest, } from "../provider-orchestration/provider-contracts.js";
import { assertProviderProcessResult } from "../provider-orchestration/provider-runtime-evidence.js";
import { assertPlanningGeneration, } from "../lifecycle/planning-generation.js";
import { normalizeInvestigationRequirementsV3 } from "../investigation/manifest/investigation-manifest.js";
import { assertAuthorizedReviewChallengeClosure, } from "./review-challenge.js";
import { createPlanReviewTargetSnapshotForSubject, readPlanReviewTargetSnapshotNode, } from "./plan-review-target-snapshot.js";
import { deepFreeze, hasExactKeys, isDigest, isRecord, sha256, } from "./plan-review-values.js";
export { assertPlanReviewTargetSnapshot, planReviewSnapshotLineCount, readPlanReviewTargetSnapshotNode, } from "./plan-review-target-snapshot.js";
const PLAN_REVIEW_TYPE = 'plan-review';
const PLAN_REVIEW_SCHEMA = 'plan-review.v2';
const PLAN_REVIEW_EVALUATOR = 'plan-review.v2';
const PLAN_REVIEW_OUTPUT_SCHEMA_ID = 'plan-review-output.v3';
const PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID = 'plan-review-node-output.v2';
const PROVIDER_RESULT_TYPE = 'plan-review-provider-result';
const PROVIDER_RESULT_SCHEMA = 'plan-review-provider-result.v3';
const PROVIDER_RESULT_EVALUATOR = 'plan-review-provider-result.v3';
const PROVIDER_RESULT_OUTPUT_SCHEMA = 'plan-review-provider-result-output.v3';
const DISPOSITION_TYPE = 'plan-review-disposition';
const DISPOSITION_SCHEMA = 'plan-review-disposition.v1';
const DISPOSITION_EVALUATOR = 'plan-review-disposition.v1';
const DISPOSITION_OUTPUT_SCHEMA = 'plan-review-disposition-output.v1';
const AUTHORIZED_DISPOSITION_SCHEMA = 'plan-review-disposition.v2';
const AUTHORIZED_DISPOSITION_EVALUATOR = 'plan-review-disposition.v2';
const AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA = 'plan-review-disposition-output.v2';
export const PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE = 'jigwright.plan-review-challenge-closure.v1';
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const PLAN_REVIEW_MAX_PROPOSED_TERMS = 256;
const PLAN_REVIEW_LIMITS = Object.freeze({
    maxFindings: 128,
    maxSuggestions: 128,
    maxProposedTerms: PLAN_REVIEW_MAX_PROPOSED_TERMS,
    maxEvidencePerEntry: 64,
    maxInvestigationDependencies: 4096,
    maxSummaryBytes: 16 * 1024,
    maxObservationBytes: 16 * 1024,
    maxResidualRiskBytes: 16 * 1024,
    maxUncertaintyBytes: 16 * 1024,
    maxDispositionRationaleBytes: 16 * 1024,
    maxAuthorBytes: 1024,
    maxRepositoryPathBytes: 4096,
});
/**
 * The fixed scope-and-depth challenge surface a single exact-plan review must
 * cover. A submission attests the complete set; a missing area is incomplete
 * coverage and fails closed. It doubles as the allowed challenge category set.
 */
export const PLAN_REVIEW_COVERAGE = Object.freeze([
    'missing-scope',
    'missing-consumers',
    'weak-why',
    'unsupported-invariants',
    'contradictory-artifacts',
    'task-strategy-risks',
    'additional-search-terms',
]);
const COVERAGE_SET = new Set(PLAN_REVIEW_COVERAGE);
const FOLLOWUP_CATEGORIES = new Set(['follow-up']);
const VERDICTS = new Set([
    'advisory-approve',
    'advisory-reject',
]);
const SEVERITIES = new Set([
    'critical',
    'high',
    'medium',
    'low',
    'informational',
]);
const TERM_KINDS = new Set([
    'literal-content',
    'literal-path',
    'symbol',
    'config-key',
]);
const EVIDENCE_KINDS = [
    'planning-location',
    'repository-location',
    'investigation-node',
    'survey-record',
    'investigation-role-result',
];
const DISPOSITION_DECISIONS = new Set([
    'mitigated',
    'rejected',
    'accepted',
]);
const AUTHORIZED_DISPOSITION_DECISIONS = new Set([
    'accepted',
    'rebutted',
    'superseded',
    'withdrawn',
    'waived',
]);
const INDEPENDENCE_DIMENSIONS = new Set([
    'provider-independent',
    'principal-independent',
    'session-independent',
    'none',
]);
const SUBMISSION_KEYS = [
    'schemaVersion',
    'verdict',
    'coverage',
    'scopeAssessment',
    'findings',
    'proposedTerms',
    'suggestions',
    'residualRisk',
    'uncertainty',
];
/**
 * What a provider actually authors. Everything else in a submission is derived
 * by the engine: the schema version and the complete coverage list are engine
 * constants, `scopeAssessment.kind` is a function of the finding categories,
 * and each finding's `kind`/`currentChangeImpact` follow from the array it was
 * submitted in. Asking a provider to restate a value the engine already knows
 * only creates a place for the two to disagree, and a disagreement over a
 * derived field used to discard an otherwise usable review.
 */
const PROVIDER_SUBMISSION_KEYS = [
    'verdict',
    'scopeEvidence',
    'findings',
    'proposedTerms',
    'suggestions',
    'residualRisk',
    'uncertainty',
];
const OUTPUT_KEYS = [
    'schemaVersion',
    'planningGenerationId',
    'planTargetDigest',
    'subjectDigest',
    'assignment',
    'verdict',
    'coverage',
    'scopeAssessment',
    'findings',
    'suggestions',
    'proposedTerms',
    'residualRisk',
    'uncertainty',
    'requiredIndependence',
    'achievedIndependence',
];
const SUBJECT_KEYS = [
    'schemaVersion',
    'subjectDigest',
    'planningGenerationId',
    'planTargetDigest',
    'manifestDigest',
    'investigationTargetDigest',
    'reviewPolicyDigest',
    'requiredIndependence',
    'investigationBaseline',
    'investigationDependencies',
    'investigationRequirements',
];
const PROVIDER_RESULT_OUTPUT_KEYS = [
    'schemaVersion',
    'subjectDigest',
    'assignment',
    'request',
    'result',
];
const ROLE_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
];
const PLAN_REVIEW_SCHEMA_GRAMMAR = {
    schema: 'plan-review-output-grammar.v2',
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 2,
    submissionKeys: [...PROVIDER_SUBMISSION_KEYS],
    canonicalSubmissionKeys: [...SUBMISSION_KEYS],
    storedOutputKeys: [...OUTPUT_KEYS],
    subjectKeys: [...SUBJECT_KEYS],
    roleAssignmentKeys: [...ROLE_ASSIGNMENT_KEYS],
    providerResult: {
        type: PROVIDER_RESULT_TYPE,
        nodeSchema: PROVIDER_RESULT_SCHEMA,
        evaluator: PROVIDER_RESULT_EVALUATOR,
        outputSchema: PROVIDER_RESULT_OUTPUT_SCHEMA,
        outputKeys: [...PROVIDER_RESULT_OUTPUT_KEYS],
        exactInputRoles: [
            'assignment',
            'output',
            'request',
            'runtimeObservation',
            'subject',
            'targetSnapshot',
        ],
        semanticParentRoles: ['targetSnapshot'],
        provenanceParentRoles: ['targetSnapshot'],
    },
    reviewNode: {
        type: PLAN_REVIEW_TYPE,
        nodeSchema: PLAN_REVIEW_SCHEMA,
        evaluator: PLAN_REVIEW_EVALUATOR,
        outputSchema: PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
        exactInputRoles: ['assignment', 'subject', 'submission'],
        semanticParentRoles: ['providerResult'],
        provenanceParentRoles: ['providerResult'],
    },
    coverage: [...PLAN_REVIEW_COVERAGE],
    verdicts: [...VERDICTS],
    challenge: {
        submissionKeys: ['severity', 'category', 'summary', 'evidence'],
        storedKeys: [
            'findingId',
            'kind',
            'severity',
            'category',
            'currentChangeImpact',
            'summary',
            'evidence',
        ],
        categories: [...PLAN_REVIEW_COVERAGE],
        impact: 'required',
    },
    suggestion: {
        submissionKeys: ['severity', 'summary', 'evidence'],
        storedKeys: [
            'suggestionId',
            'kind',
            'severity',
            'category',
            'currentChangeImpact',
            'summary',
            'evidence',
        ],
        categories: [...FOLLOWUP_CATEGORIES],
        impact: 'independent-follow-up',
    },
    scopeAssessment: {
        challengesKeys: ['kind'],
        noChallengeKeys: ['kind', 'evidence'],
        requiredScopeChallengeCategories: ['missing-consumers', 'missing-scope'],
        derivedFromFindingCategories: true,
        providerKey: 'scopeEvidence',
    },
    evidence: {
        kinds: [...EVIDENCE_KINDS],
        repositoryLocationKeys: ['kind', 'line', 'observation', 'path'],
        graphKeys: ['kind', 'nodeId', 'resultDigest'],
    },
    proposedTermKeys: ['kind', 'value'],
    termKinds: [...TERM_KINDS],
    disposition: {
        entryKeys: ['author', 'challengeId', 'decision', 'rationale'],
        decisions: [...DISPOSITION_DECISIONS],
        outputKeys: ['schemaVersion', 'dispositions'],
        exactInputRoles: ['dispositions'],
        semanticParentRoles: ['review'],
        provenanceParentRoles: ['review'],
    },
    independenceDimensions: [...INDEPENDENCE_DIMENSIONS],
    severities: [...SEVERITIES],
    limits: PLAN_REVIEW_LIMITS,
};
const PLAN_REVIEW_GRAMMAR_DIGEST = sha256(canonicalJson(PLAN_REVIEW_SCHEMA_GRAMMAR));
/**
 * The provider-facing JSON Schema. It asks only for what a reviewer actually
 * authors; the engine fills in the schema version, the complete coverage list,
 * the scope-assessment kind, and every constant discriminator before the
 * canonical validator runs, so a provider has no derived field to contradict.
 * Its comment binds the stricter code-owned semantic grammar (finding/category
 * pairings, sorted uniqueness, and evidence rules) that JSON Schema alone
 * cannot express.
 *
 * The shape is additionally constrained by what a structured-output endpoint
 * accepts: `oneOf` is rejected outright, a `const` must carry a sibling `type`,
 * and `uniqueItems` is not permitted. Both unions here are discriminated by an
 * exclusive `kind`, so `anyOf` is equivalent, and coverage uniqueness is
 * enforced by `assertCoverage` rather than by the wire schema.
 *
 * Provider CLIs infer their supported dialect. The canonical schema therefore
 * omits an external `$schema` URI so request identity, runtime bytes, provider
 * input, and native validation remain exact while avoiding a pre-launch resolver
 * failure.
 */
export const PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    $comment: `workflow-semantic-grammar-sha256:${PLAN_REVIEW_GRAMMAR_DIGEST}`,
    type: 'object',
    additionalProperties: false,
    required: [...PROVIDER_SUBMISSION_KEYS],
    properties: {
        verdict: { enum: [...VERDICTS] },
        scopeEvidence: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/$defs/evidence' },
        },
        findings: {
            type: 'array',
            maxItems: PLAN_REVIEW_LIMITS.maxFindings,
            items: { $ref: '#/$defs/finding' },
        },
        proposedTerms: {
            type: 'array',
            maxItems: PLAN_REVIEW_LIMITS.maxProposedTerms,
            items: { $ref: '#/$defs/term' },
        },
        suggestions: {
            type: 'array',
            maxItems: PLAN_REVIEW_LIMITS.maxSuggestions,
            items: { $ref: '#/$defs/suggestion' },
        },
        residualRisk: { type: 'string', minLength: 1 },
        uncertainty: { type: 'string', minLength: 1 },
    },
    $defs: {
        evidence: {
            anyOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'path', 'line', 'observation'],
                    properties: {
                        kind: {
                            enum: ['planning-location', 'repository-location'],
                        },
                        path: { type: 'string', minLength: 1 },
                        line: { type: 'integer', minimum: 1 },
                        observation: { type: 'string', minLength: 1 },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'nodeId', 'resultDigest'],
                    properties: {
                        kind: { enum: ['investigation-node', 'survey-record'] },
                        nodeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    },
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'role', 'requestDigest', 'resultDigest'],
                    properties: {
                        kind: { enum: ['investigation-role-result'] },
                        role: { enum: ['reviewer-pre-anchor', 'investigation-reviewer'] },
                        requestDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                        resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    },
                },
            ],
        },
        finding: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'category', 'summary', 'evidence'],
            properties: {
                severity: { enum: [...SEVERITIES] },
                category: { enum: [...PLAN_REVIEW_COVERAGE] },
                summary: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/$defs/evidence' },
                },
            },
        },
        suggestion: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'summary', 'evidence'],
            properties: {
                severity: { enum: [...SEVERITIES] },
                summary: { type: 'string', minLength: 1 },
                evidence: { type: 'array', items: { $ref: '#/$defs/evidence' } },
            },
        },
        term: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'value'],
            properties: {
                kind: { enum: [...TERM_KINDS] },
                value: { type: 'string', minLength: 1 },
            },
        },
    },
});
const PLAN_REVIEW_OUTPUT_DIGEST = sha256(canonicalJson(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA));
/**
 * The code-owned schema identity for a plan-review provider submission. The
 * digest binds the fixed coverage set, verdict values, evidence kinds, and term
 * kinds so the accepted output grammar is reviewed and replayed rather than
 * driven by an external policy file.
 */
export const PLAN_REVIEW_OUTPUT_SCHEMA = Object.freeze({
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 3,
    digest: PLAN_REVIEW_OUTPUT_DIGEST,
});
/**
 * The bound validator for a plan-review submission. It accepts only a strictly
 * shaped submission — exact keys, complete coverage, evidence-bound findings,
 * and enumerated terms — and returns a literal boolean so a generic semantic
 * action (an unknown proposal key) is rejected rather than admitted.
 */
export const PLAN_REVIEW_OUTPUT_VALIDATOR = Object.freeze({
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 3,
    digest: PLAN_REVIEW_OUTPUT_DIGEST,
    validate(value) {
        try {
            assertPlanReviewProviderSubmission(value);
            return true;
        }
        catch {
            return false;
        }
    },
    explain(value) {
        try {
            assertPlanReviewProviderSubmission(value);
            return [];
        }
        catch (error) {
            return [
                {
                    path: '/',
                    code: 'PLAN_REVIEW_INVALID',
                    message: error instanceof Error
                        ? error.message
                        : 'Plan review submission failed its bound semantic validator.',
                },
            ];
        }
    },
});
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
export function planReviewSubmissionDigest(submission) {
    return sha256(canonicalJson({
        schema: 'plan-review-submission.v2',
        submission,
    }));
}
/**
 * Canonicalize what a provider actually wrote, filling in every engine-derived
 * field. Exposed so the derivation is observable rather than only reachable
 * through a stored provider result.
 */
export function canonicalizePlanReviewProviderSubmission(value) {
    return deepFreeze(canonicalSubmission(assertPlanReviewProviderSubmission(value)));
}
export function canonicalizePlanReviewSubmission(value) {
    return deepFreeze(canonicalSubmission(assertPlanReviewSubmission(value)));
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
/**
 * Bind a disposition for every named challenge into an immutable node that
 * descends from the exact review. Each disposition must name a real challenge in
 * the review with an allowed decision and rationale; an unknown or duplicated
 * challenge fails closed.
 */
export function createPlanReviewDispositionNode(input) {
    if (!isRecord(input) ||
        !hasExactKeys(input, ['reviewNode', 'policyDigest', 'dispositions'])) {
        throw planReviewInvalid('Plan review disposition input is malformed.');
    }
    const review = readPlanReviewNode(input.reviewNode);
    if (!isDigest(input.policyDigest)) {
        throw planReviewInvalid('Plan review disposition policy digest is invalid.');
    }
    const challengeIds = new Set(review.findings.map((finding) => finding.findingId));
    const dispositions = assertBoundedArray(input.dispositions, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many dispositions.').map((entry) => assertDisposition(entry));
    if (dispositions.length === 0) {
        throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const seen = new Set();
    for (const disposition of dispositions) {
        if (!challengeIds.has(disposition.challengeId)) {
            throw planReviewInvalid('Disposition names an unknown challenge.');
        }
        if (seen.has(disposition.challengeId)) {
            throw planReviewInvalid('Disposition duplicates a challenge.');
        }
        seen.add(disposition.challengeId);
    }
    const sorted = [...dispositions].sort((left, right) => left.challengeId < right.challengeId ? -1 : 1);
    return createEvidenceNode({
        type: DISPOSITION_TYPE,
        nodeSchema: DISPOSITION_SCHEMA,
        evaluator: DISPOSITION_EVALUATOR,
        policyDigest: input.policyDigest,
        exactInputDigests: {
            dispositions: planReviewDispositionDigest(sorted),
        },
        semanticParentResultDigests: { review: input.reviewNode.resultDigest },
        provenanceParentNodeIds: { review: input.reviewNode.nodeId },
        outputSchema: DISPOSITION_OUTPUT_SCHEMA,
        output: { schemaVersion: 1, dispositions: sorted },
        runtimeMetadata: {},
    });
}
export function createAuthorizedPlanReviewDispositionNode(input) {
    const review = readPlanReviewNode(input.reviewNode);
    if (!isDigest(input.policyDigest) || !isRecord(input.binding)) {
        throw planReviewInvalid('Authorized plan review disposition input is malformed.');
    }
    const dispositions = assertBoundedArray(input.dispositions, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many dispositions.').map(assertAuthorizedDisposition);
    assertDispositionChallengeSet(review, dispositions);
    const sorted = [...dispositions].sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (!['reviewer', 'domain-owner'].includes(input.role) ||
        !Number.isFinite(input.issuedAt.getTime()) ||
        input.binding.subjectDigest !== review.subjectDigest ||
        input.binding.planningGenerationId !== review.planningGenerationId ||
        !GIT_OBJECT_ID_PATTERN.test(input.binding.baselineCommit) ||
        !GIT_OBJECT_ID_PATTERN.test(input.binding.baselineTree) ||
        !isDigest(input.binding.subjectDigest) ||
        !isDigest(input.binding.planningGenerationId) ||
        !isBoundedNonBlankText(input.binding.repositoryId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        !isBoundedNonBlankText(input.binding.changeId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        !isBoundedNonBlankText(input.binding.investigationId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        !isBoundedNonBlankText(input.binding.authorId, PLAN_REVIEW_LIMITS.maxAuthorBytes)) {
        throw planReviewInvalid('Authorized plan review disposition binding is malformed.');
    }
    input.signer.assertHumanPresent();
    const signer = input.signer.identity();
    if (!isBoundedNonBlankText(signer, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        sorted.some(({ author }) => author !== signer) ||
        signer === input.binding.authorId) {
        throw planReviewInvalid('Challenge closure must be signed by an authenticated reviewer distinct from the plan author.');
    }
    const authorityPayload = {
        schemaVersion: 1,
        kind: 'plan-review-challenge-closure-authority',
        namespace: PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
        repositoryId: input.binding.repositoryId,
        changeId: input.binding.changeId,
        investigationId: input.binding.investigationId,
        baselineCommit: input.binding.baselineCommit,
        baselineTree: input.binding.baselineTree,
        subjectDigest: input.binding.subjectDigest,
        planningGenerationId: input.binding.planningGenerationId,
        reviewNodeId: input.reviewNode.nodeId,
        reviewResultDigest: input.reviewNode.resultDigest,
        dispositionsDigest: authorizedDispositionDigest(sorted),
        authorId: input.binding.authorId,
        role: input.role,
        signer,
        issuedAt: input.issuedAt.toISOString(),
    };
    const payload = `${canonicalJson(authorityPayload)}\n`;
    const signature = input.signer.sign(payload, PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE);
    input.signer.verify(payload, signature, signer, PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE);
    const authority = Object.freeze({
        ...authorityPayload,
        signature,
    });
    return createEvidenceNode({
        type: DISPOSITION_TYPE,
        nodeSchema: AUTHORIZED_DISPOSITION_SCHEMA,
        evaluator: AUTHORIZED_DISPOSITION_EVALUATOR,
        policyDigest: input.policyDigest,
        exactInputDigests: {
            authority: sha256(payload),
            dispositions: authority.dispositionsDigest,
            signature: sha256(signature),
        },
        semanticParentResultDigests: { review: input.reviewNode.resultDigest },
        provenanceParentNodeIds: { review: input.reviewNode.nodeId },
        outputSchema: AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA,
        output: { schemaVersion: 2, dispositions: sorted, authority },
        runtimeMetadata: {},
    });
}
/**
 * Read a stored disposition node back into its typed record, revalidating the
 * bound review provenance, allowed decisions, and canonical ordering.
 */
export function readPlanReviewDispositionNode(node) {
    const validated = assertStoredEvidenceNode(node, () => planReviewInvalid('Plan review disposition envelope is malformed.'));
    if (validated.nodeSchema === AUTHORIZED_DISPOSITION_SCHEMA) {
        return readAuthorizedPlanReviewDispositionNode(validated);
    }
    if (validated.type !== DISPOSITION_TYPE ||
        validated.nodeSchema !== DISPOSITION_SCHEMA ||
        validated.evaluator !== DISPOSITION_EVALUATOR ||
        validated.outputSchema !== DISPOSITION_OUTPUT_SCHEMA) {
        throw planReviewInvalid('Plan review disposition identity is unexpected.');
    }
    assertExactDigestRoles(validated.exactInputDigests, ['dispositions'], 'Plan review disposition exact-input roles are unexpected.');
    assertExactDigestRoles(validated.semanticParentResultDigests, ['review'], 'Plan review disposition semantic-parent roles are unexpected.');
    assertExactDigestRoles(validated.provenanceParentNodeIds, ['review'], 'Plan review disposition provenance-parent roles are unexpected.');
    if (Object.keys(validated.runtimeMetadata).length !== 0) {
        throw planReviewInvalid('Plan review disposition runtime metadata must be empty.');
    }
    const reviewNodeId = validated.provenanceParentNodeIds.review;
    const reviewResultDigest = validated.semanticParentResultDigests.review;
    if (!isDigest(reviewNodeId) || !isDigest(reviewResultDigest)) {
        throw planReviewInvalid('Disposition is not bound to a review.');
    }
    const output = assertExactKeys(validated.output, [
        'schemaVersion',
        'dispositions',
    ]);
    if (output.schemaVersion !== 1) {
        throw planReviewInvalid('Disposition output schema version must be 1.');
    }
    const dispositions = assertBoundedArray(output.dispositions, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many dispositions.').map((entry) => assertDisposition(entry));
    if (dispositions.length === 0) {
        throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const seen = new Set();
    let previous = null;
    for (const disposition of dispositions) {
        if (seen.has(disposition.challengeId)) {
            throw planReviewInvalid('Disposition duplicates a challenge.');
        }
        if (previous !== null && disposition.challengeId <= previous) {
            throw planReviewInvalid('Dispositions are not canonically sorted.');
        }
        seen.add(disposition.challengeId);
        previous = disposition.challengeId;
    }
    if (validated.exactInputDigests.dispositions !==
        planReviewDispositionDigest(dispositions)) {
        throw planReviewInvalid('Plan review disposition input digest does not match.');
    }
    const record = {
        schemaVersion: 1,
        reviewNodeId,
        reviewResultDigest,
        policyDigest: validated.policyDigest,
        dispositions,
    };
    return deepFreeze(record);
}
function readAuthorizedPlanReviewDispositionNode(validated) {
    if (validated.type !== DISPOSITION_TYPE ||
        validated.nodeSchema !== AUTHORIZED_DISPOSITION_SCHEMA ||
        validated.evaluator !== AUTHORIZED_DISPOSITION_EVALUATOR ||
        validated.outputSchema !== AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA) {
        throw planReviewInvalid('Authorized plan review disposition identity is unexpected.');
    }
    assertExactDigestRoles(validated.exactInputDigests, ['authority', 'dispositions', 'signature'], 'Authorized plan review disposition exact-input roles are unexpected.');
    assertExactDigestRoles(validated.semanticParentResultDigests, ['review'], 'Authorized plan review disposition semantic-parent roles are unexpected.');
    assertExactDigestRoles(validated.provenanceParentNodeIds, ['review'], 'Authorized plan review disposition provenance-parent roles are unexpected.');
    if (Object.keys(validated.runtimeMetadata).length !== 0) {
        throw planReviewInvalid('Authorized plan review disposition runtime metadata must be empty.');
    }
    const output = assertExactKeys(validated.output, [
        'schemaVersion',
        'dispositions',
        'authority',
    ]);
    if (output.schemaVersion !== 2) {
        throw planReviewInvalid('Authorized disposition output schema version must be 2.');
    }
    const dispositions = assertBoundedArray(output.dispositions, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many dispositions.').map(assertAuthorizedDisposition);
    if (dispositions.length === 0 ||
        dispositions.some((entry, index) => index > 0 && entry.challengeId <= dispositions[index - 1].challengeId)) {
        throw planReviewInvalid('Authorized dispositions are empty, duplicated, or unsorted.');
    }
    const authority = assertPlanReviewChallengeClosureAuthority(output.authority);
    const payload = canonicalPlanReviewChallengeClosurePayload(authority);
    if (authority.reviewNodeId !== validated.provenanceParentNodeIds.review ||
        authority.reviewResultDigest !==
            validated.semanticParentResultDigests.review ||
        authority.dispositionsDigest !==
            authorizedDispositionDigest(dispositions) ||
        validated.exactInputDigests.authority !== sha256(payload) ||
        validated.exactInputDigests.dispositions !== authority.dispositionsDigest ||
        validated.exactInputDigests.signature !== sha256(authority.signature) ||
        dispositions.some(({ author }) => author !== authority.signer)) {
        throw planReviewInvalid('Authorized disposition authority is not bound to its exact review and decisions.');
    }
    return deepFreeze({
        schemaVersion: 2,
        reviewNodeId: authority.reviewNodeId,
        reviewResultDigest: authority.reviewResultDigest,
        policyDigest: validated.policyDigest,
        dispositions,
        authority,
    });
}
export function assertAuthorizedPlanReviewChallengeClosure(input) {
    const record = readPlanReviewDispositionNode(input.dispositionNode);
    const review = readPlanReviewNode(input.reviewNode);
    if (record.schemaVersion !== 2) {
        throw planReviewInvalid('Global review challenges require an authenticated v2 disposition.');
    }
    const authority = record.authority;
    const expected = input.expected;
    if (authority.repositoryId !== expected.repositoryId ||
        authority.changeId !== expected.changeId ||
        authority.investigationId !== expected.investigationId ||
        authority.baselineCommit !== expected.baselineCommit ||
        authority.baselineTree !== expected.baselineTree ||
        authority.subjectDigest !== expected.subjectDigest ||
        authority.planningGenerationId !== expected.planningGenerationId ||
        authority.authorId !== expected.authorId ||
        authority.reviewNodeId !== input.reviewNode.nodeId ||
        authority.reviewResultDigest !== input.reviewNode.resultDigest ||
        authority.subjectDigest !== review.subjectDigest ||
        authority.planningGenerationId !== review.planningGenerationId ||
        authority.repositoryId !== input.policy.repository.id ||
        authority.signer === authority.authorId) {
        throw planReviewInvalid('Authenticated challenge closure does not match the current planning authority.');
    }
    const signer = input.policy.trustedSigners.find(({ identity }) => identity === authority.signer);
    if (signer === undefined) {
        throw planReviewInvalid('Challenge closure signer is not trusted by the baseline policy.');
    }
    verifySshSignatureWithPublicKey(canonicalPlanReviewChallengeClosurePayload(authority), authority.signature, authority.signer, signer.publicKey, PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE);
    const challenges = review.findings.map((finding) => ({
        challengeId: finding.findingId,
        raisedBy: review.assignment.providerId,
        severity: finding.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
        targetId: finding.findingId,
    }));
    const closures = record.dispositions.map((entry) => ({
        challengeId: entry.challengeId,
        disposition: entry.decision,
        closedBy: authority.signer,
        ...(entry.supersededBy === null
            ? {}
            : { supersededBy: entry.supersededBy }),
    }));
    assertAuthorizedReviewChallengeClosure({
        expectedSubjectDigest: expected.subjectDigest,
        authoritySubjectDigest: authority.subjectDigest,
        authenticatedCloserId: authority.signer,
        challenges,
        closures,
        context: {
            authorId: authority.authorId,
            reviewerIds: [authority.signer],
            domainOwnerIds: authority.role === 'domain-owner' ? [authority.signer] : [],
        },
    });
    return record;
}
function planReviewDispositionDigest(dispositions) {
    return sha256(canonicalJson({
        schema: 'plan-review-disposition-input.v1',
        dispositions,
    }));
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
function assertPlanReviewSubmission(value) {
    if (!isRecord(value) || !hasExactKeys(value, SUBMISSION_KEYS)) {
        throw planReviewInvalid('Plan review submission shape is malformed.');
    }
    if (value.schemaVersion !== 2) {
        throw planReviewInvalid('Plan review submission schema version must be 2.');
    }
    if (typeof value.verdict !== 'string' || !VERDICTS.has(value.verdict)) {
        throw planReviewInvalid('Plan review verdict is unexpected.');
    }
    const coverage = assertCoverage(value.coverage);
    const findings = assertBoundedArray(value.findings, PLAN_REVIEW_LIMITS.maxFindings, 'Plan review contains too many findings.')
        .map((entry) => assertSubmissionChallenge(entry))
        .sort((left, right) => left.findingId < right.findingId
        ? -1
        : left.findingId > right.findingId
            ? 1
            : 0);
    assertUniqueChallengeIds(findings.map((finding) => finding.findingId));
    const suggestions = assertBoundedArray(value.suggestions, PLAN_REVIEW_LIMITS.maxSuggestions, 'Plan review contains too many suggestions.')
        .map((entry) => assertSubmissionSuggestion(entry))
        .sort((left, right) => left.suggestionId < right.suggestionId
        ? -1
        : left.suggestionId > right.suggestionId
            ? 1
            : 0);
    const proposedTerms = assertProposedTerms(value.proposedTerms);
    const scopeAssessment = assertScopeAssessment(value.scopeAssessment, findings);
    const residualRisk = assertBoundedRequiredText(value.residualRisk, PLAN_REVIEW_LIMITS.maxResidualRiskBytes, 'Plan review residual risk is malformed.');
    const uncertainty = assertBoundedRequiredText(value.uncertainty, PLAN_REVIEW_LIMITS.maxUncertaintyBytes, 'Plan review uncertainty is malformed.');
    return {
        verdict: value.verdict,
        coverage,
        scopeAssessment,
        findings,
        suggestions,
        proposedTerms,
        residualRisk,
        uncertainty,
    };
}
/**
 * Complete a provider submission into the canonical form the rest of the engine
 * stores and replays. Every field filled in here is one the engine already
 * knows, so a provider cannot disagree with it: the scope-assessment kind is
 * read off the finding categories, and each entry's discriminators follow from
 * the array it arrived in. The completed value is then validated exactly as a
 * caller-supplied submission, so no rule is relaxed by this path.
 */
function completeProviderSubmission(value) {
    if (!isRecord(value) || !hasExactKeys(value, PROVIDER_SUBMISSION_KEYS)) {
        throw planReviewInvalid(`Plan review provider submission must carry exactly: ${[...PROVIDER_SUBMISSION_KEYS].join(', ')}.`);
    }
    const findings = isDenseArray(value.findings) ? value.findings : undefined;
    const suggestions = isDenseArray(value.suggestions)
        ? value.suggestions
        : undefined;
    if (findings === undefined || suggestions === undefined) {
        throw planReviewInvalid('Plan review provider findings and suggestions must be arrays.');
    }
    // Scope evidence is authored on every submission, so the rule holds on its
    // own field: it never depends on what the findings say. When a scope
    // challenge is present, that challenge carries the evidence forward and the
    // assessment records only the kind.
    const scopeEvidence = assertEvidenceArray(value.scopeEvidence);
    const scopeChallenged = findings.some((entry) => isRecord(entry) &&
        (entry.category === 'missing-scope' ||
            entry.category === 'missing-consumers'));
    return {
        schemaVersion: 2,
        verdict: value.verdict,
        coverage: [...PLAN_REVIEW_COVERAGE],
        scopeAssessment: scopeChallenged
            ? { kind: 'challenges' }
            : { kind: 'no-challenge', evidence: scopeEvidence },
        findings: findings.map((entry) => isRecord(entry)
            ? { ...entry, kind: 'challenge', currentChangeImpact: 'required' }
            : entry),
        proposedTerms: value.proposedTerms,
        suggestions: suggestions.map((entry) => isRecord(entry)
            ? {
                ...entry,
                kind: 'suggestion',
                category: 'follow-up',
                currentChangeImpact: 'independent-follow-up',
            }
            : entry),
        residualRisk: value.residualRisk,
        uncertainty: value.uncertainty,
    };
}
/** Validate a raw provider submission in its authored wire form. */
function assertPlanReviewProviderSubmission(value) {
    return assertPlanReviewSubmission(completeProviderSubmission(value));
}
/**
 * Reduce a canonical submission to the authored wire form. The inverse of
 * `completeProviderSubmission`, used where a caller must emit exactly what a
 * provider would have written.
 */
export function planReviewProviderSubmission(submission) {
    const scopeEvidence = submission.scopeAssessment.kind === 'no-challenge'
        ? submission.scopeAssessment.evidence
        : submission.findings.flatMap(({ category, evidence }) => category === 'missing-scope' || category === 'missing-consumers'
            ? evidence
            : []);
    return {
        verdict: submission.verdict,
        scopeEvidence: scopeEvidence.map((entry) => ({ ...entry })),
        findings: submission.findings.map(({ severity, category, summary, evidence }) => ({
            severity,
            category,
            summary,
            evidence: evidence.map((entry) => ({ ...entry })),
        })),
        proposedTerms: submission.proposedTerms.map((term) => ({ ...term })),
        suggestions: submission.suggestions.map(({ severity, summary, evidence }) => ({
            severity,
            summary,
            evidence: evidence.map((entry) => ({ ...entry })),
        })),
        residualRisk: submission.residualRisk,
        uncertainty: submission.uncertainty,
    };
}
function canonicalSubmission(submission) {
    return {
        schemaVersion: 2,
        verdict: submission.verdict,
        coverage: [...submission.coverage],
        scopeAssessment: submission.scopeAssessment.kind === 'challenges'
            ? { kind: 'challenges' }
            : {
                kind: 'no-challenge',
                evidence: submission.scopeAssessment.evidence.map((entry) => ({
                    ...entry,
                })),
            },
        findings: submission.findings.map(stripChallengeIdentity),
        proposedTerms: submission.proposedTerms.map((term) => ({ ...term })),
        suggestions: submission.suggestions.map(stripSuggestionIdentity),
        residualRisk: submission.residualRisk,
        uncertainty: submission.uncertainty,
    };
}
function stripChallengeIdentity(finding) {
    return {
        kind: 'challenge',
        severity: finding.severity,
        category: finding.category,
        currentChangeImpact: 'required',
        summary: finding.summary,
        evidence: finding.evidence.map((entry) => ({ ...entry })),
    };
}
function stripSuggestionIdentity(suggestion) {
    return {
        kind: 'suggestion',
        severity: suggestion.severity,
        category: suggestion.category,
        currentChangeImpact: 'independent-follow-up',
        summary: suggestion.summary,
        evidence: suggestion.evidence.map((entry) => ({ ...entry })),
    };
}
function assertSubmissionEvidenceBindings(submission, subject) {
    const allowedGraphEvidence = new Set(subject.investigationDependencies.map(({ nodeId, resultDigest }) => `${nodeId}\u0000${resultDigest}`));
    const allowedRoleEvidence = new Set(subject.investigationDependencies.map(({ role, nodeId, resultDigest }) => `${role}\u0000${nodeId}\u0000${resultDigest}`));
    const evidence = [
        ...submission.findings.flatMap((finding) => finding.evidence),
        ...submission.suggestions.flatMap((suggestion) => suggestion.evidence),
        ...(submission.scopeAssessment.kind === 'no-challenge'
            ? submission.scopeAssessment.evidence
            : []),
    ];
    for (const citation of evidence) {
        if ((citation.kind === 'investigation-node' ||
            citation.kind === 'survey-record') &&
            !allowedGraphEvidence.has(`${citation.nodeId}\u0000${citation.resultDigest}`)) {
            throw planReviewInvalid('Plan review graph evidence is not bound to the investigation subject.');
        }
        if (citation.kind === 'investigation-role-result' &&
            !allowedRoleEvidence.has(`${citation.role}\u0000${citation.requestDigest}\u0000${citation.resultDigest}`)) {
            throw planReviewInvalid('Plan review role-result evidence is not bound to the investigation subject.');
        }
    }
}
function assertSubmissionChallenge(value) {
    const record = assertExactKeys(value, [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
    ]);
    return normalizeChallenge(record);
}
function assertStoredChallenge(value) {
    const record = assertExactKeys(value, [
        'findingId',
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
    ]);
    const normalized = normalizeChallenge(record);
    if (record.findingId !== normalized.findingId) {
        throw planReviewInvalid('Plan review challenge identity does not match.');
    }
    if (canonicalJson(record) !==
        canonicalJson({
            findingId: normalized.findingId,
            ...stripChallengeIdentity(normalized),
        })) {
        throw planReviewInvalid('Plan review challenge is not canonical.');
    }
    return normalized;
}
function normalizeChallenge(record) {
    if (record.kind !== 'challenge') {
        throw planReviewInvalid('A required finding must be a challenge.');
    }
    if (record.currentChangeImpact !== 'required') {
        throw planReviewInvalid('A challenge must be current-change required.');
    }
    const category = record.category;
    if (typeof category !== 'string' || !COVERAGE_SET.has(category)) {
        throw planReviewInvalid('Plan review challenge category is unexpected.');
    }
    const summary = assertSummary(record.summary);
    const severity = assertSeverity(record.severity);
    const evidence = assertEvidenceArray(record.evidence);
    return {
        findingId: findingDigest('challenge', severity, category, 'required', summary, evidence),
        kind: 'challenge',
        severity,
        category,
        currentChangeImpact: 'required',
        summary,
        evidence,
    };
}
function assertSubmissionSuggestion(value) {
    const record = assertExactKeys(value, [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
    ]);
    return normalizeSuggestion(record);
}
function assertStoredSuggestion(value) {
    const record = assertExactKeys(value, [
        'suggestionId',
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
    ]);
    const normalized = normalizeSuggestion(record);
    if (record.suggestionId !== normalized.suggestionId) {
        throw planReviewInvalid('Plan review suggestion identity does not match.');
    }
    if (canonicalJson(record) !==
        canonicalJson({
            suggestionId: normalized.suggestionId,
            ...stripSuggestionIdentity(normalized),
        })) {
        throw planReviewInvalid('Plan review suggestion is not canonical.');
    }
    return normalized;
}
function normalizeSuggestion(record) {
    if (record.kind !== 'suggestion') {
        throw planReviewInvalid('An independent finding must be a suggestion.');
    }
    if (record.currentChangeImpact !== 'independent-follow-up') {
        throw planReviewInvalid('A suggestion must be an independent follow-up.');
    }
    const category = record.category;
    if (typeof category !== 'string' || !FOLLOWUP_CATEGORIES.has(category)) {
        throw planReviewInvalid('Plan review suggestion category is unexpected.');
    }
    const summary = assertSummary(record.summary);
    const severity = assertSeverity(record.severity);
    const evidence = assertEvidenceArray(record.evidence);
    return {
        suggestionId: findingDigest('suggestion', severity, category, 'independent-follow-up', summary, evidence),
        kind: 'suggestion',
        severity,
        category,
        currentChangeImpact: 'independent-follow-up',
        summary,
        evidence,
    };
}
function assertScopeAssessment(value, findings) {
    if (!isRecord(value)) {
        throw planReviewInvalid('Plan review scope assessment is malformed.');
    }
    if (value.kind === 'challenges') {
        assertExactKeys(value, ['kind']);
        if (!findings.some(({ category }) => category === 'missing-scope' || category === 'missing-consumers')) {
            throw planReviewInvalid('A challenges scope assessment requires an explicit scope challenge.');
        }
        return { kind: 'challenges' };
    }
    if (value.kind === 'no-challenge') {
        assertExactKeys(value, ['kind', 'evidence']);
        const evidence = assertEvidenceArray(value.evidence);
        if (findings.some(({ category }) => category === 'missing-scope' || category === 'missing-consumers')) {
            throw planReviewInvalid('A no-challenge scope assessment cannot carry a scope challenge.');
        }
        return { kind: 'no-challenge', evidence };
    }
    throw planReviewInvalid('Plan review scope assessment kind is unexpected.');
}
function assertCoverage(value) {
    if (!isDenseArray(value) || value.length !== PLAN_REVIEW_COVERAGE.length) {
        throw planReviewInvalid('Plan review coverage is incomplete.');
    }
    const seen = new Set();
    for (const area of value) {
        if (typeof area !== 'string' || !COVERAGE_SET.has(area) || seen.has(area)) {
            throw planReviewInvalid('Plan review coverage is malformed.');
        }
        seen.add(area);
    }
    for (const area of PLAN_REVIEW_COVERAGE) {
        if (!seen.has(area)) {
            throw planReviewInvalid('Plan review coverage is incomplete.');
        }
    }
    return [...PLAN_REVIEW_COVERAGE];
}
function assertProposedTerms(value) {
    const terms = assertBoundedArray(value, PLAN_REVIEW_LIMITS.maxProposedTerms, 'Plan review contains too many proposed terms.').map((entry) => {
        const record = assertExactKeys(entry, ['kind', 'value']);
        const kind = record.kind;
        const termValue = record.value;
        if (typeof kind !== 'string' || !TERM_KINDS.has(kind)) {
            throw planReviewInvalid('Proposed term kind is unexpected.');
        }
        if (typeof termValue !== 'string') {
            throw planReviewInvalid('Proposed term value is malformed.');
        }
        let normalized;
        try {
            normalized = normalizeInvestigationTerm({
                kind: kind,
                value: termValue,
            });
        }
        catch {
            throw planReviewInvalid('Proposed term value is malformed.');
        }
        return {
            kind: normalized.kind,
            value: normalized.value,
            termId: normalized.termId,
        };
    });
    const unique = new Map();
    for (const term of terms) {
        unique.set(term.termId, term);
    }
    return [...unique.values()]
        .sort((left, right) => left.termId < right.termId ? -1 : left.termId > right.termId ? 1 : 0)
        .map(({ kind, value: termValue }) => ({ kind, value: termValue }));
}
function assertEvidenceArray(value) {
    const array = assertBoundedArray(value, PLAN_REVIEW_LIMITS.maxEvidencePerEntry, 'Plan review contains too many evidence citations.');
    if (array.length === 0) {
        throw planReviewInvalid('At least one evidence citation is required.');
    }
    const unique = new Map();
    for (const entry of array.map((candidate) => assertEvidence(candidate))) {
        unique.set(canonicalJson(entry), entry);
    }
    return [...unique.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, evidence]) => evidence);
}
function assertEvidence(value) {
    if (!isRecord(value)) {
        throw planReviewInvalid('Plan review evidence is malformed.');
    }
    const kind = value.kind;
    if (kind === 'planning-location' || kind === 'repository-location') {
        assertExactKeys(value, ['kind', 'path', 'line', 'observation']);
        const path = value.path;
        const line = value.line;
        const observation = value.observation;
        if (typeof path !== 'string' ||
            Buffer.byteLength(path, 'utf8') >
                PLAN_REVIEW_LIMITS.maxRepositoryPathBytes ||
            !Number.isInteger(line) ||
            line < 1 ||
            line > Number.MAX_SAFE_INTEGER ||
            !isBoundedNonBlankText(observation, PLAN_REVIEW_LIMITS.maxObservationBytes)) {
            throw planReviewInvalid('Repository-location evidence is malformed.');
        }
        let normalizedPath;
        try {
            normalizedPath = normalizeExactRepositoryPath(path);
        }
        catch {
            throw planReviewInvalid('Repository-location evidence is malformed.');
        }
        return {
            kind,
            path: normalizedPath,
            line: line,
            observation: observation,
        };
    }
    if (kind === 'investigation-node' || kind === 'survey-record') {
        assertExactKeys(value, ['kind', 'nodeId', 'resultDigest']);
        const nodeId = value.nodeId;
        const resultDigest = value.resultDigest;
        if (!isDigest(nodeId) || !isDigest(resultDigest)) {
            throw planReviewInvalid('Graph evidence digests are malformed.');
        }
        return kind === 'investigation-node'
            ? { kind: 'investigation-node', nodeId, resultDigest }
            : { kind: 'survey-record', nodeId, resultDigest };
    }
    if (kind === 'investigation-role-result') {
        assertExactKeys(value, ['kind', 'role', 'requestDigest', 'resultDigest']);
        const role = value.role;
        const requestDigest = value.requestDigest;
        const resultDigest = value.resultDigest;
        if ((role !== 'reviewer-pre-anchor' && role !== 'investigation-reviewer') ||
            !isDigest(requestDigest) ||
            !isDigest(resultDigest)) {
            throw planReviewInvalid('Investigation role-result evidence is malformed.');
        }
        return {
            kind: 'investigation-role-result',
            role,
            requestDigest,
            resultDigest,
        };
    }
    throw planReviewInvalid('Plan review evidence kind is unexpected.');
}
function assertDisposition(value) {
    const record = assertExactKeys(value, [
        'challengeId',
        'decision',
        'rationale',
        'author',
    ]);
    const challengeId = record.challengeId;
    const decision = record.decision;
    const rationale = record.rationale;
    const author = record.author;
    if (!isDigest(challengeId)) {
        throw planReviewInvalid('Disposition challenge identity is malformed.');
    }
    if (typeof decision !== 'string' || !DISPOSITION_DECISIONS.has(decision)) {
        throw planReviewInvalid('Disposition decision is unexpected.');
    }
    if (!isBoundedNonBlankText(rationale, PLAN_REVIEW_LIMITS.maxDispositionRationaleBytes)) {
        throw planReviewInvalid('Disposition rationale is required.');
    }
    if (!isBoundedNonBlankText(author, PLAN_REVIEW_LIMITS.maxAuthorBytes)) {
        throw planReviewInvalid('Disposition author is required.');
    }
    return {
        challengeId,
        decision: decision,
        rationale: rationale,
        author: author,
    };
}
function assertAuthorizedDisposition(value) {
    const record = assertExactKeys(value, [
        'challengeId',
        'decision',
        'rationale',
        'author',
        'supersededBy',
    ]);
    if (!isDigest(record.challengeId) ||
        typeof record.decision !== 'string' ||
        !AUTHORIZED_DISPOSITION_DECISIONS.has(record.decision) ||
        !isBoundedNonBlankText(record.rationale, PLAN_REVIEW_LIMITS.maxDispositionRationaleBytes) ||
        !isBoundedNonBlankText(record.author, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        (record.supersededBy !== null && !isDigest(record.supersededBy)) ||
        (record.decision === 'superseded') !==
            (typeof record.supersededBy === 'string')) {
        throw planReviewInvalid('Authenticated plan review disposition is malformed.');
    }
    return {
        challengeId: record.challengeId,
        decision: record.decision,
        rationale: record.rationale,
        author: record.author,
        supersededBy: record.supersededBy,
    };
}
function assertDispositionChallengeSet(review, dispositions) {
    if (dispositions.length === 0) {
        throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const challengeIds = new Set(review.findings.map((finding) => finding.findingId));
    const seen = new Set();
    for (const disposition of dispositions) {
        if (!challengeIds.has(disposition.challengeId)) {
            throw planReviewInvalid('Disposition names an unknown challenge.');
        }
        if (seen.has(disposition.challengeId)) {
            throw planReviewInvalid('Disposition duplicates a challenge.');
        }
        seen.add(disposition.challengeId);
    }
}
function assertPlanReviewChallengeClosureAuthority(value) {
    const record = assertExactKeys(value, [
        'schemaVersion',
        'kind',
        'namespace',
        'repositoryId',
        'changeId',
        'investigationId',
        'baselineCommit',
        'baselineTree',
        'subjectDigest',
        'planningGenerationId',
        'reviewNodeId',
        'reviewResultDigest',
        'dispositionsDigest',
        'authorId',
        'role',
        'signer',
        'issuedAt',
        'signature',
    ]);
    if (record.schemaVersion !== 1 ||
        record.kind !== 'plan-review-challenge-closure-authority' ||
        record.namespace !== PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE ||
        !isBoundedNonBlankText(record.repositoryId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        !isBoundedNonBlankText(record.changeId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        !isBoundedNonBlankText(record.investigationId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        typeof record.baselineCommit !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(record.baselineCommit) ||
        typeof record.baselineTree !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(record.baselineTree) ||
        !isDigest(record.subjectDigest) ||
        !isDigest(record.planningGenerationId) ||
        !isDigest(record.reviewNodeId) ||
        !isDigest(record.reviewResultDigest) ||
        !isDigest(record.dispositionsDigest) ||
        !isBoundedNonBlankText(record.authorId, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        (record.role !== 'reviewer' && record.role !== 'domain-owner') ||
        !isBoundedNonBlankText(record.signer, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
        typeof record.issuedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.issuedAt)) ||
        new Date(record.issuedAt).toISOString() !== record.issuedAt ||
        !isBoundedNonBlankText(record.signature, 64 * 1024)) {
        throw planReviewInvalid('Plan review challenge closure authority is malformed.');
    }
    return record;
}
function authorizedDispositionDigest(dispositions) {
    return sha256(canonicalJson({
        schema: 'plan-review-disposition-input.v2',
        dispositions,
    }));
}
function canonicalPlanReviewChallengeClosurePayload(authority) {
    const { signature: _signature, ...payload } = authority;
    return `${canonicalJson(payload)}\n`;
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
function assertSummary(value) {
    return assertBoundedRequiredText(value, PLAN_REVIEW_LIMITS.maxSummaryBytes, 'Plan review summary is required.');
}
function assertSeverity(value) {
    if (typeof value !== 'string' || !SEVERITIES.has(value)) {
        throw planReviewInvalid('Plan review finding severity is unexpected.');
    }
    return value;
}
function assertBoundedRequiredText(value, maximumBytes, message) {
    if (!isBoundedNonBlankText(value, maximumBytes)) {
        throw planReviewInvalid(message);
    }
    return value;
}
function assertUniqueChallengeIds(ids) {
    if (new Set(ids).size !== ids.length) {
        throw planReviewInvalid('Plan review contains duplicate challenges.');
    }
}
function findingDigest(kind, severity, category, currentChangeImpact, summary, evidence) {
    return sha256(canonicalJson({
        schema: 'plan-review-finding.v2',
        kind,
        severity,
        category,
        currentChangeImpact,
        summary,
        evidence,
    }));
}
function assertBoundedArray(value, maximum, message) {
    const array = assertArray(value);
    if (array.length > maximum) {
        throw planReviewInvalid(message);
    }
    return array;
}
function assertArray(value) {
    if (!isDenseArray(value)) {
        throw planReviewInvalid('Expected a plan review array value.');
    }
    return value;
}
function assertExactDigestRoles(value, roles, message) {
    const actual = Object.keys(value).sort();
    const expected = [...roles].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw planReviewInvalid(message);
    }
}
function assertCanonicalIdentityOrder(ids, message, allowEqual = false) {
    for (let index = 1; index < ids.length; index += 1) {
        if (ids[index - 1] > ids[index] ||
            (!allowEqual && ids[index - 1] === ids[index])) {
            throw planReviewInvalid(message);
        }
    }
}
function isBoundedNonBlankText(value, maximumBytes) {
    return (typeof value === 'string' &&
        value.trim().length > 0 &&
        Buffer.byteLength(value, 'utf8') <= maximumBytes);
}
function assertExactKeys(value, keys) {
    if (!isRecord(value) || !hasExactKeys(value, keys)) {
        throw planReviewInvalid('Plan review value has unexpected keys.');
    }
    return value;
}
export function createPlanReviewTargetSnapshotNode(input) {
    const subject = assertPlanReviewSubject(input.subject);
    return createPlanReviewTargetSnapshotForSubject(input, subject);
}
function isDenseArray(value) {
    if (!Array.isArray(value)) {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            return false;
        }
    }
    return true;
}
function planReviewInvalid(message) {
    return workflowError('PLAN_REVIEW_INVALID', message, ExitCode.usage);
}
