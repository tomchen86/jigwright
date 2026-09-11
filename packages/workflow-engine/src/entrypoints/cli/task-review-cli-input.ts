/**
 * Loads TaskDiffReview JSON and selects the appropriate typed review input
 * parser.
 *
 * Invariants:
 * - Only the three recognized envelope kinds select provider response,
 *   initial external review or external closure routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  parseTaskDiffReviewChallengeResponseInput,
  parseTaskDiffReviewExternalSubmissionInput,
  parseTaskDiffReviewExternalClosureRequestInput,
} from '../../composition-root/cli-command-services.ts';
import type {
  TaskDiffReviewChallengeResponseInput,
  TaskDiffReviewExternalSubmissionInput,
  TaskDiffReviewExternalClosureRequestInput,
} from '../../composition-root/cli-command-services.ts';

type TaskDiffReviewCliInput =
  | Readonly<{
      route: 'provider-response';
      input: TaskDiffReviewChallengeResponseInput;
    }>
  | Readonly<{
      route: 'external-initial';
      input: TaskDiffReviewExternalSubmissionInput;
    }>
  | Readonly<{
      route: 'external-closure';
      input: TaskDiffReviewExternalClosureRequestInput;
    }>;

export function parseTaskDiffReviewCliInput(
  cwd: string,
  inputPath: string,
): TaskDiffReviewCliInput {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_DIFF_REVIEW_INPUT_INVALID',
      'TaskDiffReview input must be a readable exact typed JSON envelope.',
      ExitCode.usage,
    );
  }
  const kind =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).kind === 'string'
      ? (value as Record<string, unknown>).kind
      : null;
  if (kind === 'task-diff-review-challenge-response-input.v1') {
    return Object.freeze({
      route: 'provider-response' as const,
      input: parseTaskDiffReviewChallengeResponseInput(value),
    });
  }
  if (kind === 'task-diff-review-submission-input.v1') {
    return Object.freeze({
      route: 'external-initial' as const,
      input: parseTaskDiffReviewExternalSubmissionInput(value),
    });
  }
  if (kind === 'task-diff-review-external-closure-request.v1') {
    return Object.freeze({
      route: 'external-closure' as const,
      input: parseTaskDiffReviewExternalClosureRequestInput(value),
    });
  }
  throw workflowError(
    'TASK_DIFF_REVIEW_INPUT_INVALID',
    'TaskDiffReview input kind must select provider response, external initial review, or external challenge closure.',
    ExitCode.usage,
  );
}
