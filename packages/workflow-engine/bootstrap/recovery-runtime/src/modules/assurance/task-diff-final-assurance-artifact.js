/** TaskDiff Final Assurance records and challenge-closure authority bindings, built from current review and response records. */
import { parseTaskDiffReviewSubject } from "./task-diff-review.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertAuthorizedReviewChallengeClosure } from "./review-challenge.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function createTaskDiffFinalAssuranceProtocol(bindings) {
    const { parseTaskDiffReviewRecord, assertTaskDiffReviewChallengeResponseCurrent, assertTaskDiffReviewContinuationSubmissionCurrent, sha256, isRecord, hasExactKeys, MAX_FINDINGS, CONTINUATION_DECISIONS, DIGEST, deepFreeze, IDENTITY, boundedText, } = bindings;
    function createTaskDiffFinalAssuranceRecord(input) {
        const subject = parseTaskDiffReviewSubject(input.subject);
        const review = parseTaskDiffReviewRecord(input.review);
        const response = assertTaskDiffReviewChallengeResponseCurrent(review, input.response);
        const submission = assertTaskDiffReviewContinuationSubmissionCurrent(review, response, input.submission);
        const reviewerAuthority = parseFinalAssuranceReviewerAuthority(input.reviewerAuthority);
        const exceptions = parseFinalAssuranceExceptions(input.exceptions ?? []);
        const expectedExceptions = expectedFinalAssuranceExceptions(review, reviewerAuthority);
        if (review.subjectDigest !== subject.subjectDigest ||
            canonicalJson(review.subject) !== canonicalJson(subject) ||
            reviewerAuthority.policyDigest !== subject.reviewPolicyDigest ||
            canonicalJson(exceptions) !== canonicalJson(expectedExceptions)) {
            throw finalAssuranceInvalid();
        }
        assertFinalAssuranceAuthorityBindings({
            subject,
            review,
            response,
            reviewerAuthority,
            authenticatedReviewAuthority: input.authenticatedReviewAuthority,
            authenticatedChallengeClosureAuthority: input.authenticatedChallengeClosureAuthority,
        });
        const dispositions = submission.proposedDispositions.map((entry) => Object.freeze({
            ...entry,
            closedBy: reviewerAuthority.principalId,
        }));
        assertTaskDiffChallengeClosure(subject, review, reviewerAuthority, dispositions);
        const body = {
            schemaVersion: 1,
            kind: 'task-diff-final-assurance.v1',
            subject,
            subjectDigest: subject.subjectDigest,
            reviewRecordDigest: review.recordDigest,
            responseDigest: response.responseDigest,
            verdict: dispositions.some(({ decision }) => decision === 'accepted')
                ? 'changes-required'
                : 'satisfied',
            reviewerAuthority,
            dispositions,
            exceptions,
        };
        return parseTaskDiffFinalAssuranceRecord({
            ...body,
            commitmentDigest: sha256(canonicalJson(body)),
        });
    }
    function parseTaskDiffFinalAssuranceRecord(value) {
        if (!isRecord(value) ||
            !hasExactKeys(value, [
                'schemaVersion',
                'kind',
                'commitmentDigest',
                'subject',
                'subjectDigest',
                'reviewRecordDigest',
                'responseDigest',
                'verdict',
                'reviewerAuthority',
                'dispositions',
                'exceptions',
            ]) ||
            value.schemaVersion !== 1 ||
            value.kind !== 'task-diff-final-assurance.v1' ||
            (value.verdict !== 'satisfied' && value.verdict !== 'changes-required') ||
            !Array.isArray(value.dispositions) ||
            value.dispositions.length === 0 ||
            value.dispositions.length > MAX_FINDINGS) {
            throw finalAssuranceInvalid();
        }
        const subject = parseTaskDiffReviewSubject(value.subject);
        const reviewerAuthority = parseFinalAssuranceReviewerAuthority(value.reviewerAuthority);
        const dispositions = value.dispositions.map((candidate) => {
            if (!isRecord(candidate) ||
                !hasExactKeys(candidate, [
                    'challengeId',
                    'decision',
                    'rationale',
                    'closedBy',
                    'supersededBy',
                ]) ||
                !CONTINUATION_DECISIONS.has(String(candidate.decision)) ||
                (candidate.supersededBy !== null &&
                    (typeof candidate.supersededBy !== 'string' ||
                        !DIGEST.test(candidate.supersededBy))) ||
                (candidate.decision === 'superseded') !==
                    (typeof candidate.supersededBy === 'string')) {
                throw finalAssuranceInvalid();
            }
            return Object.freeze({
                challengeId: finalAssuranceDigest(candidate.challengeId),
                decision: candidate.decision,
                rationale: boundedFinalAssuranceText(candidate.rationale),
                closedBy: finalAssuranceIdentity(candidate.closedBy),
                supersededBy: candidate.supersededBy,
            });
        });
        const exceptions = parseFinalAssuranceExceptions(value.exceptions);
        const record = {
            schemaVersion: 1,
            kind: 'task-diff-final-assurance.v1',
            commitmentDigest: finalAssuranceDigest(value.commitmentDigest),
            subject,
            subjectDigest: finalAssuranceDigest(value.subjectDigest),
            reviewRecordDigest: finalAssuranceDigest(value.reviewRecordDigest),
            responseDigest: finalAssuranceDigest(value.responseDigest),
            verdict: value.verdict,
            reviewerAuthority,
            dispositions,
            exceptions,
        };
        if (record.subjectDigest !== subject.subjectDigest ||
            record.reviewerAuthority.policyDigest !== subject.reviewPolicyDigest ||
            record.verdict !==
                (record.dispositions.some(({ decision }) => decision === 'accepted')
                    ? 'changes-required'
                    : 'satisfied') ||
            record.dispositions.some(({ closedBy }) => closedBy !== record.reviewerAuthority.principalId) ||
            !finalAssuranceAuthorityMatchesStoredExceptions(record.reviewerAuthority, record.exceptions) ||
            record.commitmentDigest !==
                sha256(canonicalJson(withoutFinalAssuranceCommitment(record)))) {
            throw finalAssuranceInvalid();
        }
        return deepFreeze(record);
    }
    function assertTaskDiffFinalAssuranceCurrent(input) {
        const subject = parseTaskDiffReviewSubject(input.subject);
        const review = parseTaskDiffReviewRecord(input.review);
        const response = assertTaskDiffReviewChallengeResponseCurrent(review, input.response);
        const assurance = parseTaskDiffFinalAssuranceRecord(input.assurance);
        if (assurance.subjectDigest !== subject.subjectDigest ||
            canonicalJson(assurance.subject) !== canonicalJson(subject) ||
            assurance.reviewRecordDigest !== review.recordDigest ||
            assurance.responseDigest !== response.responseDigest ||
            canonicalJson(assurance.exceptions) !==
                canonicalJson(expectedFinalAssuranceExceptions(review, assurance.reviewerAuthority))) {
            throw finalAssuranceInvalid();
        }
        assertFinalAssuranceAuthorityBindings({
            subject,
            review,
            response,
            reviewerAuthority: assurance.reviewerAuthority,
            authenticatedReviewAuthority: input.authenticatedReviewAuthority,
            authenticatedChallengeClosureAuthority: input.authenticatedChallengeClosureAuthority,
        });
        assertTaskDiffChallengeClosure(subject, review, assurance.reviewerAuthority, assurance.dispositions);
        return assurance;
    }
    function withoutFinalAssuranceCommitment(record) {
        const { commitmentDigest: _commitmentDigest, ...body } = record;
        return body;
    }
    function parseFinalAssuranceReviewerAuthority(value) {
        if (!isRecord(value)) {
            throw finalAssuranceInvalid();
        }
        if (value.kind === 'engine-attributed-provider-reviewer') {
            if (!hasExactKeys(value, [
                'kind',
                'principalId',
                'providerId',
                'policyDigest',
            ])) {
                throw finalAssuranceInvalid();
            }
            return Object.freeze({
                kind: 'engine-attributed-provider-reviewer',
                principalId: finalAssuranceIdentity(value.principalId),
                providerId: finalAssuranceIdentity(value.providerId),
                policyDigest: finalAssuranceDigest(value.policyDigest),
            });
        }
        if (value.kind !== 'grant-attributed-external-reviewer' ||
            !hasExactKeys(value, [
                'kind',
                'principalId',
                'degradedForm',
                'grantUseDigest',
                'policyDigest',
            ]) ||
            (value.degradedForm !== 'caller-supplied' &&
                value.degradedForm !== 'direct-human-review')) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze({
            kind: 'grant-attributed-external-reviewer',
            principalId: finalAssuranceIdentity(value.principalId),
            degradedForm: value.degradedForm,
            grantUseDigest: finalAssuranceDigest(value.grantUseDigest),
            policyDigest: finalAssuranceDigest(value.policyDigest),
        });
    }
    function parseFinalAssuranceExceptions(value) {
        if (!Array.isArray(value) || value.length > 2) {
            throw finalAssuranceInvalid();
        }
        const exceptions = value
            .map((candidate) => {
            if (!isRecord(candidate) ||
                !hasExactKeys(candidate, [
                    'kind',
                    'stage',
                    'grantUseDigest',
                    'degradedForm',
                ]) ||
                candidate.kind !== 'collaboration-grant-degradation' ||
                (candidate.stage !== 'review' &&
                    candidate.stage !== 'challenge-closure') ||
                ![
                    'same-provider-fresh-session',
                    'caller-supplied',
                    'direct-human-review',
                ].includes(String(candidate.degradedForm))) {
                throw finalAssuranceInvalid();
            }
            return Object.freeze({
                kind: 'collaboration-grant-degradation',
                stage: candidate.stage,
                grantUseDigest: finalAssuranceDigest(candidate.grantUseDigest),
                degradedForm: candidate.degradedForm,
            });
        })
            .sort((left, right) => finalAssuranceStageOrder(left.stage) -
            finalAssuranceStageOrder(right.stage));
        if (exceptions.some((entry, index) => index > 0 && entry.stage === exceptions[index - 1].stage) ||
            new Set(exceptions.map(({ grantUseDigest }) => grantUseDigest)).size !==
                exceptions.length) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze(exceptions);
    }
    function expectedFinalAssuranceExceptions(review, authority) {
        const expected = [];
        if (review.assignment.degradedForm !== null &&
            review.assignment.grantUseDigest !== null) {
            expected.push({
                kind: 'collaboration-grant-degradation',
                stage: 'review',
                grantUseDigest: review.assignment.grantUseDigest,
                degradedForm: review.assignment.degradedForm,
            });
        }
        if (authority.kind === 'grant-attributed-external-reviewer') {
            expected.push({
                kind: 'collaboration-grant-degradation',
                stage: 'challenge-closure',
                grantUseDigest: authority.grantUseDigest,
                degradedForm: authority.degradedForm,
            });
        }
        return parseFinalAssuranceExceptions(expected);
    }
    function finalAssuranceAuthorityMatchesStoredExceptions(authority, exceptions) {
        const closureException = exceptions.find(({ stage }) => stage === 'challenge-closure');
        return authority.kind === 'grant-attributed-external-reviewer'
            ? closureException?.grantUseDigest === authority.grantUseDigest &&
                closureException.degradedForm === authority.degradedForm
            : closureException === undefined;
    }
    function finalAssuranceStageOrder(stage) {
        return stage === 'review' ? 0 : 1;
    }
    function parseAuthenticatedReviewerAuthority(value) {
        if (!isRecord(value) ||
            !hasExactKeys(value, [
                'schemaVersion',
                'kind',
                'stage',
                'subjectDigest',
                'reviewRecordDigest',
                'responseDigest',
                'authorityNodeId',
                'authorityResultDigest',
                'authority',
            ]) ||
            value.schemaVersion !== 1 ||
            value.kind !== 'task-diff-authenticated-reviewer-authority.v1' ||
            (value.stage !== 'review' && value.stage !== 'challenge-closure') ||
            (value.responseDigest !== null &&
                (typeof value.responseDigest !== 'string' ||
                    !DIGEST.test(value.responseDigest)))) {
            throw finalAssuranceInvalid();
        }
        return Object.freeze({
            schemaVersion: 1,
            kind: 'task-diff-authenticated-reviewer-authority.v1',
            stage: value.stage,
            subjectDigest: finalAssuranceDigest(value.subjectDigest),
            reviewRecordDigest: finalAssuranceDigest(value.reviewRecordDigest),
            responseDigest: value.responseDigest,
            authorityNodeId: finalAssuranceDigest(value.authorityNodeId),
            authorityResultDigest: finalAssuranceDigest(value.authorityResultDigest),
            authority: parseFinalAssuranceReviewerAuthority(value.authority),
        });
    }
    function expectedInitialReviewAuthority(review) {
        const assignment = review.assignment;
        return assignment.reviewerProviderId === null
            ? Object.freeze({
                kind: 'grant-attributed-external-reviewer',
                principalId: assignment.reviewerPrincipalId,
                degradedForm: assignment.degradedForm,
                grantUseDigest: assignment.grantUseDigest,
                policyDigest: review.subject.reviewPolicyDigest,
            })
            : Object.freeze({
                kind: 'engine-attributed-provider-reviewer',
                principalId: assignment.reviewerPrincipalId,
                providerId: assignment.reviewerProviderId,
                policyDigest: review.subject.reviewPolicyDigest,
            });
    }
    function assertFinalAssuranceAuthorityBindings(input) {
        const expectedReviewAuthority = expectedInitialReviewAuthority(input.review);
        const reviewFact = input.authenticatedReviewAuthority;
        const closureFact = input.authenticatedChallengeClosureAuthority;
        if (reviewFact === undefined || closureFact === undefined) {
            throw finalAssuranceInvalid();
        }
        const authenticatedReview = parseAuthenticatedReviewerAuthority(reviewFact);
        const authenticatedClosure = parseAuthenticatedReviewerAuthority(closureFact);
        if (authenticatedReview.stage !== 'review' ||
            authenticatedReview.subjectDigest !== input.subject.subjectDigest ||
            authenticatedReview.reviewRecordDigest !== input.review.recordDigest ||
            authenticatedReview.responseDigest !== null ||
            canonicalJson(authenticatedReview.authority) !==
                canonicalJson(expectedReviewAuthority) ||
            authenticatedClosure.stage !== 'challenge-closure' ||
            authenticatedClosure.subjectDigest !== input.subject.subjectDigest ||
            authenticatedClosure.reviewRecordDigest !== input.review.recordDigest ||
            authenticatedClosure.responseDigest !== input.response.responseDigest ||
            canonicalJson(authenticatedClosure.authority) !==
                canonicalJson(input.reviewerAuthority) ||
            authenticatedReview.authorityNodeId ===
                authenticatedClosure.authorityNodeId) {
            throw finalAssuranceInvalid();
        }
    }
    function assertTaskDiffChallengeClosure(subject, review, authority, dispositions) {
        const challenges = review.challenges.map((challenge) => ({
            challengeId: challenge.challengeId,
            raisedBy: challenge.raisedBy,
            severity: challenge.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
            targetId: challenge.challengeId,
        }));
        const closures = dispositions.map((entry) => ({
            challengeId: entry.challengeId,
            disposition: entry.decision,
            closedBy: entry.closedBy,
            ...(entry.supersededBy === null
                ? {}
                : { supersededBy: entry.supersededBy }),
        }));
        assertAuthorizedReviewChallengeClosure({
            expectedSubjectDigest: subject.subjectDigest,
            authoritySubjectDigest: review.subjectDigest,
            authenticatedCloserId: authority.principalId,
            challenges,
            closures,
            context: {
                authorId: review.assignment.implementerPrincipalId,
                reviewerIds: [authority.principalId],
                domainOwnerIds: [],
            },
        });
    }
    function finalAssuranceDigest(value) {
        if (typeof value !== 'string' || !DIGEST.test(value)) {
            throw finalAssuranceInvalid();
        }
        return value;
    }
    function finalAssuranceIdentity(value) {
        if (typeof value !== 'string' || !IDENTITY.test(value)) {
            throw finalAssuranceInvalid();
        }
        return value;
    }
    function boundedFinalAssuranceText(value) {
        try {
            return boundedText(value);
        }
        catch {
            throw finalAssuranceInvalid();
        }
    }
    function finalAssuranceInvalid() {
        return workflowError('TASK_DIFF_FINAL_ASSURANCE_INVALID', 'TaskDiff Final Assurance is malformed, stale, or lacks authenticated challenge-closure authority.', ExitCode.guard);
    }
    return {
        createTaskDiffFinalAssuranceRecord,
        parseTaskDiffFinalAssuranceRecord,
        assertTaskDiffFinalAssuranceCurrent,
    };
}
