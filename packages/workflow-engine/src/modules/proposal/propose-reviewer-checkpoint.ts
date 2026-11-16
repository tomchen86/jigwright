import type { RebuiltInvestigation } from './propose-types.ts';
import type { InvestigationCheckpointEnvelope } from '../investigation/domain/investigation-session-types.ts';
import {
  reviewerReusableGroupDispositions,
  reviewerReusableWhyAnswers,
} from './propose-output.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { assertInvestigationCheckpointEnvelope } from '../investigation/domain/investigation-checkpoint-contract.ts';

export function mergeReviewerReopenCheckpoint(
  rebuilt: RebuiltInvestigation,
  checkpoint: InvestigationCheckpointEnvelope,
): InvestigationCheckpointEnvelope {
  if (checkpoint.kind === 'main-terms') {
    return checkpoint;
  }
  if (checkpoint.kind === 'group-dispositions') {
    const reusable = reviewerReusableGroupDispositions(rebuilt);
    const reusableIds = new Set(reusable.map(({ groupId }) => groupId));
    if (
      checkpoint.payload.dispositions.some(({ groupId }) =>
        reusableIds.has(groupId),
      )
    ) {
      throw workflowError(
        'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
        'Reviewer-term reopening accepts answers only for new or changed groups.',
        ExitCode.guard,
      );
    }
    return assertInvestigationCheckpointEnvelope({
      ...checkpoint,
      payload: {
        // Classes and their audits survive the merge: dropping either would
        // silently turn a covered, reviewed submission into an incomplete one.
        ...(checkpoint.payload.classes === undefined
          ? {}
          : { classes: checkpoint.payload.classes }),
        ...(checkpoint.payload.sampleAudits === undefined
          ? {}
          : { sampleAudits: checkpoint.payload.sampleAudits }),
        dispositions: [...reusable, ...checkpoint.payload.dispositions].sort(
          (left, right) => left.groupId.localeCompare(right.groupId),
        ),
      },
    });
  }
  const reusable = reviewerReusableWhyAnswers(rebuilt);
  const reusableIds = new Set(
    reusable.map(({ manifestEntryId }) => manifestEntryId),
  );
  if (
    checkpoint.payload.answers.some(({ manifestEntryId }) =>
      reusableIds.has(manifestEntryId),
    )
  ) {
    throw workflowError(
      'INVESTIGATION_REVIEWER_REOPEN_SCOPE_INVALID',
      'Reviewer-term reopening accepts WHY answers only for new or changed manifest rows.',
      ExitCode.guard,
    );
  }
  return assertInvestigationCheckpointEnvelope({
    ...checkpoint,
    payload: {
      answers: [...reusable, ...checkpoint.payload.answers].sort(
        (left, right) =>
          left.manifestEntryId.localeCompare(right.manifestEntryId),
      ),
    },
  });
}
