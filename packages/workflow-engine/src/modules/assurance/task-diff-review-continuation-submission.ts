/**
 * Parses advisory task diff continuation proposals and checks their review
 * and response bindings.
 *
 * Invariants:
 * - A current continuation covers exactly the challenges in its bound
 *   review.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { TaskDiffReviewSubmissionProtocolBindings } from './task-diff-review-artifact.ts';
import type {
  TaskDiffReviewContinuationSubmission,
  TaskDiffReviewContinuationDecision,
  TaskDiffReviewRecord,
  TaskDiffReviewChallengeResponseRecord,
} from './task-diff-review-artifact-record.ts';

export function createTaskDiffReviewContinuationSubmissionProtocol(
  bindings: Pick<
    TaskDiffReviewSubmissionProtocolBindings,
    | 'MAX_FINDINGS'
    | 'sha256'
    | 'isRecord'
    | 'hasExactKeys'
    | 'deepFreeze'
    | 'continuationInvalid'
    | 'DIGEST'
    | 'continuationDigest'
    | 'boundedContinuationText'
    | 'parseTaskDiffReviewRecord'
    | 'assertTaskDiffReviewChallengeResponseCurrent'
  >,
) {
  const {
    MAX_FINDINGS,
    sha256,
    isRecord,
    hasExactKeys,
    deepFreeze,
    continuationInvalid,
    DIGEST,
    continuationDigest,
    boundedContinuationText,
    parseTaskDiffReviewRecord,
    assertTaskDiffReviewChallengeResponseCurrent,
  } = bindings;

  const CONTINUATION_DECISIONS = new Set([
    'accepted',
    'rebutted',
    'superseded',
    'withdrawn',
    'waived',
  ]);

  const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_ID =
    'workflow.task-diff-review-continuation-output.v1';

  /**
   * Provider-facing continuation evidence. These are recommendations only: the
   * engine must authenticate the fixed-runner reviewer and pass the proposal
   * through the shared challenge-closure verifier before it can mint authority.
   */
  const TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'reviewRecordDigest',
      'responseDigest',
      'proposedDispositions',
    ],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      reviewRecordDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      responseDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      proposedDispositions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['challengeId', 'decision', 'rationale', 'supersededBy'],
          properties: {
            challengeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            decision: { enum: [...CONTINUATION_DECISIONS] },
            rationale: { type: 'string', minLength: 1 },
            supersededBy: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: '^[0-9a-f]{64}$' },
              ],
            },
          },
        },
      },
    },
  });

  const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_DIGEST = sha256(
    canonicalJson(TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA),
  );

  const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA = Object.freeze({
    id: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA_DIGEST,
  });

  const TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR = Object.freeze({
    ...TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      try {
        parseTaskDiffReviewContinuationSubmission(value);
        return true;
      } catch {
        return false;
      }
    },
  });

  function parseTaskDiffReviewContinuationSubmission(
    value: unknown,
  ): TaskDiffReviewContinuationSubmission {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'reviewRecordDigest',
        'responseDigest',
        'proposedDispositions',
      ]) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.proposedDispositions) ||
      value.proposedDispositions.length === 0 ||
      value.proposedDispositions.length > MAX_FINDINGS
    ) {
      throw continuationInvalid();
    }
    const proposedDispositions = value.proposedDispositions
      .map((candidate) => {
        if (
          !isRecord(candidate) ||
          !hasExactKeys(candidate, [
            'challengeId',
            'decision',
            'rationale',
            'supersededBy',
          ]) ||
          !CONTINUATION_DECISIONS.has(String(candidate.decision)) ||
          (candidate.supersededBy !== null &&
            (typeof candidate.supersededBy !== 'string' ||
              !DIGEST.test(candidate.supersededBy))) ||
          (candidate.decision === 'superseded') !==
            (typeof candidate.supersededBy === 'string')
        ) {
          throw continuationInvalid();
        }
        return Object.freeze({
          challengeId: continuationDigest(candidate.challengeId),
          decision: candidate.decision as TaskDiffReviewContinuationDecision,
          rationale: boundedContinuationText(candidate.rationale),
          supersededBy: candidate.supersededBy as string | null,
        });
      })
      .sort((left, right) => left.challengeId.localeCompare(right.challengeId));
    if (
      proposedDispositions.some(
        (entry, index) =>
          index > 0 &&
          entry.challengeId === proposedDispositions[index - 1]!.challengeId,
      )
    ) {
      throw continuationInvalid();
    }
    return deepFreeze({
      schemaVersion: 1,
      reviewRecordDigest: continuationDigest(value.reviewRecordDigest),
      responseDigest: continuationDigest(value.responseDigest),
      proposedDispositions,
    });
  }

  function assertTaskDiffReviewContinuationSubmissionCurrent(
    reviewCandidate: TaskDiffReviewRecord,
    responseCandidate: TaskDiffReviewChallengeResponseRecord,
    submissionCandidate: TaskDiffReviewContinuationSubmission,
  ): TaskDiffReviewContinuationSubmission {
    const review = parseTaskDiffReviewRecord(reviewCandidate);
    const response = assertTaskDiffReviewChallengeResponseCurrent(
      review,
      responseCandidate,
    );
    const submission =
      parseTaskDiffReviewContinuationSubmission(submissionCandidate);
    const challenges = review.challenges
      .map(({ challengeId }) => challengeId)
      .sort();
    if (
      submission.reviewRecordDigest !== review.recordDigest ||
      submission.responseDigest !== response.responseDigest ||
      canonicalJson(
        submission.proposedDispositions.map(({ challengeId }) => challengeId),
      ) !== canonicalJson(challenges) ||
      submission.proposedDispositions.some(
        ({ supersededBy }) =>
          supersededBy !== null && !challenges.includes(supersededBy),
      )
    ) {
      throw continuationInvalid();
    }
    return submission;
  }

  return {
    TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
    parseTaskDiffReviewContinuationSubmission,
    assertTaskDiffReviewContinuationSubmissionCurrent,
    CONTINUATION_DECISIONS,
  };
}
