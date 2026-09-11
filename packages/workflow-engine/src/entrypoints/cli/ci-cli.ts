/**
 * Parses CI comparison arguments and submits optional integration review
 * evidence.
 *
 * Invariants:
 * - Arguments must exactly follow base, head and optional input order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type CommandResult, usage, optionValue } from './cli-input.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {preparePullRequestPreMergeAssurance,completePreparedPullRequestPreMergeAssurance} from '../../composition-root/ci-verification-production.ts';
import type { IntegrationDeltaReviewSubmission } from '../../modules/assurance/pre-merge-assurance.ts';

function readPreMergeSubmission(
  cwd: string,
  inputPath: string,
): IntegrationDeltaReviewSubmission {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as IntegrationDeltaReviewSubmission;
  } catch {
    throw workflowError(
      'PRE_MERGE_INTEGRATION_REVIEW_INVALID',
      'Pre-merge review input must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}
export function dispatchCiCommand(rest: string[], cwd: string): CommandResult {
  const command = 'ci';
  const inputPath = optionValue(rest, '--input');
  const expected =
    inputPath === undefined
      ? ['--base', rest[1], '--head', rest[3]]
      : ['--base', rest[1], '--head', rest[3], '--input', inputPath];
  if (
    !rest[1] ||
    !rest[3] ||
    (rest.length !== 4 && rest.length !== 6) ||
    JSON.stringify(rest) !== JSON.stringify(expected)
  ) {
    throw usage(
      'Usage: pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
    );
  }
  const prepared = preparePullRequestPreMergeAssurance(cwd, rest[1], rest[3]);
  if (prepared.prepared === null && inputPath === undefined) {
    return { command, ok: true, result: prepared.verification };
  }
  const submission =
    inputPath === undefined ? null : readPreMergeSubmission(cwd, inputPath);
  return {
    command,
    ok: true,
    result: completePreparedPullRequestPreMergeAssurance(
      prepared,
      submission,
      cwd,
    ),
  };
}
