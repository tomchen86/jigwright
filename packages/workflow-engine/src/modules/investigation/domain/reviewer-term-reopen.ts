import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

export type ReviewerTermResolutionAuthorization =
  | {
      outcome: 'none';
      resolutionNodeId: null;
    }
  | {
      outcome: 'resume';
      resolutionNodeId: string;
    }
  | {
      outcome: 'close-input';
      resolutionNodeId: string;
      assurance: 'degraded' | 'human-waived';
    };

export function decideReviewerTermReopen(input: {
  usedReopens: number;
  novelTermCount: number;
  humanResolution: ReviewerTermResolutionAuthorization;
}):
  | 'no-novel-terms'
  | 'automatic-reopen'
  | 'human-reopen'
  | 'human-close-input'
  | 'human-action-required' {
  if (
    !Number.isSafeInteger(input.usedReopens) ||
    input.usedReopens < 0 ||
    !Number.isSafeInteger(input.novelTermCount) ||
    input.novelTermCount < 0
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_REOPEN_POLICY_INVALID',
      'Reviewer-term reopen policy input is malformed.',
      ExitCode.usage,
    );
  }
  if (input.novelTermCount === 0) {
    return 'no-novel-terms';
  }
  if (input.usedReopens < 2) {
    return 'automatic-reopen';
  }
  if (input.humanResolution.outcome === 'resume') {
    return 'human-reopen';
  }
  if (input.humanResolution.outcome === 'close-input') {
    return 'human-close-input';
  }
  return 'human-action-required';
}
