/** Observes the exact pinned rename/removal diff used by the investigation floor. */
import type { ReadPinnedPathDiff } from '../../modules/investigation/domain/investigation-floor.ts';
import { runGitBuffer } from '../repository-transaction/git.ts';

export const readPinnedPathDiff: ReadPinnedPathDiff = ({
  repositoryRoot,
  baseCommit,
  targetCommit,
}) => {
  return runGitBuffer(repositoryRoot, [
    'diff',
    '--name-status',
    '--find-renames=50%',
    '-l0',
    '--diff-algorithm=myers',
    '--no-indent-heuristic',
    '--diff-filter=RD',
    '-z',
    baseCommit,
    targetCommit,
    '--',
  ]);
};
