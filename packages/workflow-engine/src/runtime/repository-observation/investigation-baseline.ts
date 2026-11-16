/** Verifies that the recorded immutable commit resolves to its exact tree. */
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';
import type { InvestigationV3Baseline } from '../../modules/investigation/manifest/investigation-baseline.ts';
import { assertInvestigationReplayBaseline } from '../../modules/investigation/manifest/investigation-materializer.ts';

export function assertPinnedInvestigationBaseline(
  repositoryRoot: string,
  baseline: InvestigationV3Baseline,
): void {
  assertInvestigationReplayBaseline(baseline);
  let commitOid: string;
  let treeOid: string;
  try {
    commitOid = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${baseline.commitOid}^{commit}`,
    ]).trim();
    treeOid = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${baseline.commitOid}^{tree}`,
    ]).trim();
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw workflowError(
        'REPLAY_INPUT_MISSING',
        'Pinned investigation commit or tree is unavailable.',
        ExitCode.staleState,
        { details: { causeCode: error.code } },
      );
    }
    throw error;
  }
  if (commitOid !== baseline.commitOid || treeOid !== baseline.treeOid) {
    throw workflowError(
      'RECONSTRUCTION_MISMATCH',
      'Pinned commit does not resolve to the recorded investigation tree.',
      ExitCode.staleState,
    );
  }
}
