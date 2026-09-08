import { createTaskDiffFinalAssuranceProtocol } from "./task-diff-final-assurance-artifact.js";
import { createTaskDiffReviewSubmissionProtocol } from "./task-diff-review-submission.js";
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { normalizePolicyPath } from "../../runtime/session-workspace/paths.js";
import { deriveTaskDiffReviewCandidatePlan, parseTaskDiffReviewScope, parseTaskDiffReviewSubject, taskDiffReviewCandidateIdentityDigest, TASK_DIFF_REVIEW_COVERAGE, } from "./task-diff-review.js";
const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FINDINGS = 128;
const MAX_EVIDENCE = 64;
export function createTaskDiffReviewRecord(input) {
    const subject = parseTaskDiffReviewSubject(input.subject);
    const defaultPlan = deriveTaskDiffReviewCandidatePlan({ current: subject });
    if (defaultPlan.action !== 'review')
        throw recordInvalid();
    const reviewScope = assertReviewScopeCurrent(subject, input.reviewScope ?? defaultPlan.scope);
    const assignment = parseAssignment(input.assignment);
    const submission = normalizeSubmission(input.submission, assignment, subject, reviewScope);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-record.v1',
        subject,
        subjectDigest: subject.subjectDigest,
        reviewScope,
        assignment,
        verdict: submission.verdict,
        coverage: TASK_DIFF_REVIEW_COVERAGE,
        scopeAssessment: submission.scopeAssessment,
        challenges: submission.challenges,
        suggestions: submission.suggestions,
        riskPathDispositions: submission.riskPathDispositions,
        residualRisk: submission.residualRisk,
        uncertainty: submission.uncertainty,
        ...(submission.documentationAssessment === undefined
            ? {}
            : { documentationAssessment: submission.documentationAssessment }),
    };
    return parseTaskDiffReviewRecord({
        ...body,
        recordDigest: sha256(canonicalJson(body)),
    });
}
export function parseTaskDiffReviewRecord(value) {
    const legacyKeys = [
        'schemaVersion',
        'kind',
        'recordDigest',
        'subject',
        'subjectDigest',
        'reviewScope',
        'assignment',
        'verdict',
        'coverage',
        'scopeAssessment',
        'challenges',
        'suggestions',
        'riskPathDispositions',
        'residualRisk',
        'uncertainty',
    ];
    if (!isRecord(value) ||
        (!hasExactKeys(value, legacyKeys) &&
            !hasExactKeys(value, [...legacyKeys, 'documentationAssessment'])) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-record.v1') {
        throw recordInvalid();
    }
    const subject = parseSubjectForRecord(value.subject);
    const reviewScope = assertReviewScopeCurrent(subject, parseTaskDiffReviewScope(value.reviewScope));
    const assignment = parseAssignment(value.assignment);
    const verdict = parseVerdict(value.verdict);
    const coverage = parseCoverage(value.coverage);
    const challenges = parseStoredChallenges(value.challenges, assignment);
    const suggestions = parseStoredSuggestions(value.suggestions);
    const riskPathDispositions = assertRiskPathDispositionsCurrent(subject, reviewScope, value.riskPathDispositions);
    assertRiskPathChallengeConsistency(riskPathDispositions, challenges);
    const scopeAssessment = parseScopeAssessment(value.scopeAssessment, challenges.length);
    const documentationAssessment = Object.hasOwn(value, 'documentationAssessment')
        ? assertDocumentationAssessmentCurrent(subject, parseDocumentationAssessment(value.documentationAssessment), verdict, challenges.length)
        : assertDocumentationAssessmentCurrent(subject, undefined, verdict, challenges.length);
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-record.v1',
        recordDigest: parseDigest(value.recordDigest),
        subject,
        subjectDigest: parseDigest(value.subjectDigest),
        reviewScope,
        assignment,
        verdict,
        coverage,
        scopeAssessment,
        challenges,
        suggestions,
        riskPathDispositions,
        residualRisk: boundedText(value.residualRisk),
        uncertainty: boundedText(value.uncertainty),
        ...(documentationAssessment === undefined
            ? {}
            : { documentationAssessment }),
    };
    if (record.subjectDigest !== subject.subjectDigest ||
        record.recordDigest !== sha256(canonicalJson(withoutRecordDigest(record)))) {
        throw recordInvalid();
    }
    return deepFreeze(record);
}
export function createTaskDiffReviewDispositionRecord(input) {
    const review = parseTaskDiffReviewRecord(input.review);
    const entries = normalizeDispositionEntries(input.entries);
    assertDispositionAuthority(review, entries);
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-disposition.v1',
        reviewRecordDigest: review.recordDigest,
        subjectDigest: review.subjectDigest,
        entries,
    };
    return parseTaskDiffReviewDispositionRecord({
        ...body,
        dispositionDigest: sha256(canonicalJson(body)),
    });
}
export function createTaskDiffReviewChallengeResponse(input) {
    const review = parseTaskDiffReviewRecord(input.review);
    const responses = normalizeChallengeResponses(input.responses);
    assertExactChallengeSet(review.challenges.map(({ challengeId }) => challengeId), responses.map(({ challengeId }) => challengeId));
    const body = {
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response.v1',
        reviewRecordDigest: review.recordDigest,
        subjectDigest: review.subjectDigest,
        responses,
    };
    return parseTaskDiffReviewChallengeResponseRecord({
        ...body,
        responseDigest: sha256(canonicalJson(body)),
    });
}
export function parseTaskDiffReviewChallengeResponseRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'responseDigest',
            'reviewRecordDigest',
            'subjectDigest',
            'responses',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-challenge-response.v1') {
        throw dispositionInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response.v1',
        responseDigest: parseDispositionDigest(value.responseDigest),
        reviewRecordDigest: parseDispositionDigest(value.reviewRecordDigest),
        subjectDigest: parseDispositionDigest(value.subjectDigest),
        responses: normalizeChallengeResponses(value.responses),
    };
    if (record.responseDigest !==
        sha256(canonicalJson(withoutResponseDigest(record)))) {
        throw dispositionInvalid();
    }
    return deepFreeze(record);
}
export function assertTaskDiffReviewChallengeResponseCurrent(reviewCandidate, responseCandidate) {
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    const response = parseTaskDiffReviewChallengeResponseRecord(responseCandidate);
    if (response.reviewRecordDigest !== review.recordDigest ||
        response.subjectDigest !== review.subjectDigest) {
        throw dispositionInvalid();
    }
    assertExactChallengeSet(review.challenges.map(({ challengeId }) => challengeId), response.responses.map(({ challengeId }) => challengeId));
    return response;
}
export function parseTaskDiffReviewDispositionRecord(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'dispositionDigest',
            'reviewRecordDigest',
            'subjectDigest',
            'entries',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'task-diff-review-disposition.v1') {
        throw dispositionInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'task-diff-review-disposition.v1',
        dispositionDigest: parseDispositionDigest(value.dispositionDigest),
        reviewRecordDigest: parseDispositionDigest(value.reviewRecordDigest),
        subjectDigest: parseDispositionDigest(value.subjectDigest),
        entries: normalizeDispositionEntries(value.entries),
    };
    if (record.dispositionDigest !==
        sha256(canonicalJson(withoutDispositionDigest(record)))) {
        throw dispositionInvalid();
    }
    return deepFreeze(record);
}
/**
 * Validate the content-level review gate for one exact subject.
 *
 * Assignment identities in this value object are not authentication. A
 * production caller must first bind the record to a verified provider result.
 * Challenge-bearing reviews require a separately verified Final Assurance
 * node; a legacy/advisory disposition value can never authorize this helper.
 */
export function assertTaskDiffReviewContentSatisfied(candidate, reviewCandidate, dispositionCandidate) {
    const subject = parseTaskDiffReviewSubject(candidate);
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    if (taskDiffReviewCandidateIdentityDigest(review.subject) !==
        taskDiffReviewCandidateIdentityDigest(subject)) {
        throw workflowError('TASK_DIFF_REVIEW_STALE', 'TaskDiffReview does not cover the current canonical subject.', ExitCode.staleState);
    }
    if (review.challenges.length === 0) {
        if (dispositionCandidate !== null)
            throw dispositionInvalid();
        return review;
    }
    throw workflowError('TASK_DIFF_REVIEW_CHALLENGE_OPEN', dispositionCandidate === null
        ? 'TaskDiffReview contains challenges without an authenticated Final Assurance record.'
        : 'Advisory TaskDiffReview dispositions cannot substitute for an authenticated Final Assurance record.', ExitCode.verification, {
        details: {
            challengeIds: review.challenges.map(({ challengeId }) => challengeId),
        },
    });
}
function parseAssignment(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'implementerPrincipalId',
            'implementerProviderId',
            'implementationSessionId',
            'reviewerPrincipalId',
            'reviewerProviderId',
            'reviewerSessionId',
            'achievedIndependence',
            'degradedForm',
            'grantUseDigest',
        ]) ||
        (value.grantUseDigest !== null &&
            (typeof value.grantUseDigest !== 'string' ||
                !DIGEST.test(value.grantUseDigest)))) {
        throw independenceInvalid();
    }
    const implementerPrincipalId = identity(value.implementerPrincipalId);
    const implementerProviderId = nullableIdentity(value.implementerProviderId);
    const implementationSessionId = identity(value.implementationSessionId);
    const reviewerPrincipalId = identity(value.reviewerPrincipalId);
    if (value.achievedIndependence === 'none') {
        if (implementerPrincipalId === reviewerPrincipalId ||
            value.reviewerProviderId !== null ||
            value.reviewerSessionId !== null ||
            (value.degradedForm !== 'caller-supplied' &&
                value.degradedForm !== 'direct-human-review') ||
            typeof value.grantUseDigest !== 'string') {
            throw independenceInvalid();
        }
        return Object.freeze({
            implementerPrincipalId,
            implementerProviderId,
            implementationSessionId,
            reviewerPrincipalId,
            reviewerProviderId: null,
            reviewerSessionId: null,
            achievedIndependence: 'none',
            degradedForm: value.degradedForm,
            grantUseDigest: value.grantUseDigest,
        });
    }
    if ((value.achievedIndependence !== 'provider-independent' &&
        value.achievedIndependence !== 'session-independent') ||
        ![null, 'same-provider-fresh-session'].includes(value.degradedForm)) {
        throw independenceInvalid();
    }
    const assignment = {
        implementerPrincipalId,
        implementerProviderId,
        implementationSessionId,
        reviewerPrincipalId,
        reviewerProviderId: identity(value.reviewerProviderId),
        reviewerSessionId: identity(value.reviewerSessionId),
        achievedIndependence: value.achievedIndependence,
        degradedForm: value.degradedForm,
        grantUseDigest: value.grantUseDigest,
    };
    const commonInvalid = assignment.implementationSessionId === assignment.reviewerSessionId;
    const ordinaryInvalid = assignment.degradedForm === null &&
        (assignment.grantUseDigest !== null ||
            assignment.implementerProviderId === null ||
            (assignment.implementerProviderId === assignment.reviewerProviderId
                ? assignment.achievedIndependence !== 'session-independent'
                : assignment.achievedIndependence !== 'provider-independent'));
    const grantedInvalid = assignment.degradedForm === 'same-provider-fresh-session' &&
        (assignment.achievedIndependence !== 'session-independent' ||
            assignment.implementerProviderId === null ||
            assignment.implementerProviderId !== assignment.reviewerProviderId ||
            assignment.grantUseDigest === null);
    if (commonInvalid || ordinaryInvalid || grantedInvalid) {
        throw independenceInvalid();
    }
    return Object.freeze(assignment);
}
function normalizeDispositionEntries(value) {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw dispositionInvalid();
    }
    const entries = value.map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, [
                'challengeId',
                'disposition',
                'rationale',
                'closedBy',
            ]) ||
            !DISPOSITIONS.has(String(entry.disposition))) {
            throw dispositionInvalid();
        }
        return Object.freeze({
            challengeId: parseDispositionDigest(entry.challengeId),
            disposition: entry.disposition,
            rationale: boundedDispositionText(entry.rationale),
            closedBy: dispositionIdentity(entry.closedBy),
        });
    });
    entries.sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (entries.some((entry, index) => index > 0 && entry.challengeId === entries[index - 1].challengeId)) {
        throw dispositionInvalid();
    }
    return Object.freeze(entries);
}
function normalizeChallengeResponses(value) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_FINDINGS) {
        throw dispositionInvalid();
    }
    const responses = value
        .map((entry) => {
        if (!isRecord(entry) ||
            !hasExactKeys(entry, ['challengeId', 'rationale', 'evidence'])) {
            throw dispositionInvalid();
        }
        let evidence;
        try {
            evidence = normalizeEvidence(entry.evidence, false);
        }
        catch {
            throw dispositionInvalid();
        }
        return Object.freeze({
            challengeId: parseDispositionDigest(entry.challengeId),
            rationale: boundedDispositionText(entry.rationale),
            evidence,
        });
    })
        .sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (responses.some((entry, index) => index > 0 && entry.challengeId === responses[index - 1].challengeId)) {
        throw dispositionInvalid();
    }
    return Object.freeze(responses);
}
function assertExactChallengeSet(expected, actual) {
    if (expected.length === 0 ||
        canonicalJson([...expected].sort()) !== canonicalJson([...actual].sort())) {
        throw dispositionInvalid();
    }
}
function assertDispositionAuthority(review, entries) {
    const challengeIds = new Set(review.challenges.map(({ challengeId }) => challengeId));
    for (const entry of entries) {
        if (!challengeIds.has(entry.challengeId) ||
            entry.closedBy === review.assignment.implementerPrincipalId ||
            entry.closedBy !== review.assignment.reviewerPrincipalId) {
            throw dispositionInvalid();
        }
    }
}
function assertReviewScopeCurrent(subject, candidate) {
    const scope = parseTaskDiffReviewScope(candidate);
    if (scope.currentSubjectDigest !== subject.subjectDigest ||
        scope.candidateIdentityDigest !==
            taskDiffReviewCandidateIdentityDigest(subject) ||
        (scope.predecessor === null &&
            (scope.mode !== 'full' ||
                canonicalJson(scope.reviewedPaths) !==
                    canonicalJson(subject.changedPaths))) ||
        (scope.mode === 'delta' && scope.predecessor === null)) {
        throw recordInvalid();
    }
    return scope;
}
function parseSubjectForRecord(value) {
    try {
        return parseTaskDiffReviewSubject(value);
    }
    catch {
        throw recordInvalid();
    }
}
function withoutRecordDigest(record) {
    const { recordDigest: _recordDigest, ...body } = record;
    return body;
}
function withoutResponseDigest(record) {
    const { responseDigest: _responseDigest, ...body } = record;
    return body;
}
function withoutDispositionDigest(record) {
    const { dispositionDigest: _dispositionDigest, ...body } = record;
    return body;
}
function exactPath(value) {
    if (typeof value !== 'string')
        throw recordInvalid();
    let normalized;
    try {
        normalized = normalizePolicyPath(value);
    }
    catch {
        throw recordInvalid();
    }
    if (normalized !== value || normalized.endsWith('/**')) {
        throw recordInvalid();
    }
    return normalized;
}
function boundedText(value) {
    if (typeof value !== 'string' ||
        value.trim() !== value ||
        value.length === 0 ||
        Buffer.byteLength(value) > MAX_TEXT_BYTES) {
        throw recordInvalid();
    }
    return value;
}
function boundedDispositionText(value) {
    try {
        return boundedText(value);
    }
    catch {
        throw dispositionInvalid();
    }
}
function boundedContinuationText(value) {
    try {
        return boundedText(value);
    }
    catch {
        throw continuationInvalid();
    }
}
function identity(value) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw recordInvalid();
    }
    return value;
}
function nullableIdentity(value) {
    return value === null ? null : identity(value);
}
function dispositionIdentity(value) {
    if (typeof value !== 'string' || !IDENTITY.test(value)) {
        throw dispositionInvalid();
    }
    return value;
}
function parseDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw recordInvalid();
    }
    return value;
}
function parseDispositionDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw dispositionInvalid();
    }
    return value;
}
function continuationDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw continuationInvalid();
    }
    return value;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
function hasExactKeys(value, keys) {
    return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function recordInvalid() {
    return workflowError('TASK_DIFF_REVIEW_RECORD_INVALID', 'TaskDiffReview record is malformed or not canonically bound.', ExitCode.staleState);
}
function dispositionInvalid() {
    return workflowError('TASK_DIFF_REVIEW_DISPOSITION_INVALID', 'TaskDiffReview disposition is malformed or lacks independent authority.', ExitCode.guard);
}
function continuationInvalid() {
    return workflowError('TASK_DIFF_REVIEW_CONTINUATION_INVALID', 'TaskDiffReview continuation evidence is malformed or does not cover the exact current challenge set.', ExitCode.guard);
}
function independenceInvalid() {
    return workflowError('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID', 'TaskDiffReview requires a fresh session-independent reviewer assignment.', ExitCode.guard);
}
const taskDiffReviewSubmissionProtocol = createTaskDiffReviewSubmissionProtocol({
    MAX_TEXT_BYTES,
    MAX_FINDINGS,
    MAX_EVIDENCE,
    sha256,
    isRecord,
    hasExactKeys,
    recordInvalid,
    deepFreeze,
    boundedText,
    continuationInvalid,
    DIGEST,
    continuationDigest,
    boundedContinuationText,
    parseTaskDiffReviewRecord,
    assertTaskDiffReviewChallengeResponseCurrent,
    parseDigest,
    exactPath,
    OBJECT_ID,
    identity,
});
export const TASK_DIFF_REVIEW_LIMITS = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_LIMITS;
export const TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA;
export const TASK_DIFF_REVIEW_OUTPUT_SCHEMA = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_OUTPUT_SCHEMA;
export const TASK_DIFF_REVIEW_OUTPUT_VALIDATOR = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_OUTPUT_VALIDATOR;
export const TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA;
export const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA;
export const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR = taskDiffReviewSubmissionProtocol.TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR;
export const completeTaskDiffReviewProviderSubmission = taskDiffReviewSubmissionProtocol.completeTaskDiffReviewProviderSubmission;
export const taskDiffReviewProviderSubmission = taskDiffReviewSubmissionProtocol.taskDiffReviewProviderSubmission;
export const parseTaskDiffReviewProviderSubmission = taskDiffReviewSubmissionProtocol.parseTaskDiffReviewProviderSubmission;
export const parseTaskDiffReviewSubmission = taskDiffReviewSubmissionProtocol.parseTaskDiffReviewSubmission;
export const parseTaskDiffReviewContinuationSubmission = taskDiffReviewSubmissionProtocol.parseTaskDiffReviewContinuationSubmission;
export const assertTaskDiffReviewContinuationSubmissionCurrent = taskDiffReviewSubmissionProtocol.assertTaskDiffReviewContinuationSubmissionCurrent;
const RISK_PATH_OUTCOMES = taskDiffReviewSubmissionProtocol.RISK_PATH_OUTCOMES;
const normalizeSubmission = taskDiffReviewSubmissionProtocol.normalizeSubmission;
const parseVerdict = taskDiffReviewSubmissionProtocol.parseVerdict;
const parseCoverage = taskDiffReviewSubmissionProtocol.parseCoverage;
const parseStoredChallenges = taskDiffReviewSubmissionProtocol.parseStoredChallenges;
const parseStoredSuggestions = taskDiffReviewSubmissionProtocol.parseStoredSuggestions;
const assertRiskPathDispositionsCurrent = taskDiffReviewSubmissionProtocol.assertRiskPathDispositionsCurrent;
const assertRiskPathChallengeConsistency = taskDiffReviewSubmissionProtocol.assertRiskPathChallengeConsistency;
const parseScopeAssessment = taskDiffReviewSubmissionProtocol.parseScopeAssessment;
const assertDocumentationAssessmentCurrent = taskDiffReviewSubmissionProtocol.assertDocumentationAssessmentCurrent;
const parseDocumentationAssessment = taskDiffReviewSubmissionProtocol.parseDocumentationAssessment;
const CONTINUATION_DECISIONS = taskDiffReviewSubmissionProtocol.CONTINUATION_DECISIONS;
const DISPOSITIONS = taskDiffReviewSubmissionProtocol.DISPOSITIONS;
const normalizeEvidence = taskDiffReviewSubmissionProtocol.normalizeEvidence;
const taskDiffFinalAssuranceProtocol = createTaskDiffFinalAssuranceProtocol({
    parseTaskDiffReviewRecord,
    assertTaskDiffReviewChallengeResponseCurrent,
    assertTaskDiffReviewContinuationSubmissionCurrent,
    sha256,
    isRecord,
    hasExactKeys,
    MAX_FINDINGS,
    CONTINUATION_DECISIONS,
    DIGEST,
    deepFreeze,
    IDENTITY,
    boundedText,
});
export const createTaskDiffFinalAssuranceRecord = taskDiffFinalAssuranceProtocol.createTaskDiffFinalAssuranceRecord;
export const parseTaskDiffFinalAssuranceRecord = taskDiffFinalAssuranceProtocol.parseTaskDiffFinalAssuranceRecord;
export const assertTaskDiffFinalAssuranceCurrent = taskDiffFinalAssuranceProtocol.assertTaskDiffFinalAssuranceCurrent;
