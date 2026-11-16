/** Observes exact regular test and fixture entries from a RED candidate tree. */
import type { TaskStrategyFrozenFile } from '../../modules/assurance/task-strategy-evidence.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';

export function readFrozenFiles(
  repositoryRoot: string,
  tree: string,
  paths: readonly string[],
): TaskStrategyFrozenFile[] {
  return paths.map((candidatePath) => {
    const output = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      tree,
      '--',
      `:(literal)${candidatePath}`,
    ]);
    const match =
      /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
        output,
      );
    if (!match || match[3] !== candidatePath) {
      throw workflowError(
        'TASK_STRATEGY_RED_FILE_INVALID',
        'A RED test or fixture is absent or is not a regular executable/plain file.',
        ExitCode.verification,
        { details: { path: candidatePath } },
      );
    }
    return {
      path: candidatePath,
      mode: match[1] as TaskStrategyFrozenFile['mode'],
      objectId: match[2]!,
    };
  });
}
