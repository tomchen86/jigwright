import type { TaskCommit } from '../../modules/assurance/task-execution-evidence.ts';
import { resolveCommitOid } from './git-object-ids.ts';
import type { CommitFacts } from '../../modules/repository-consumer/commit-facts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import { normalizeChangedPath } from '../../foundation/repository-path/repository-path.ts';
import { splitNull } from './git-transition-values.ts';
import { runGit } from './git.ts';

export type { TaskCommit } from '../../modules/assurance/task-execution-evidence.ts';

/**
 * Reads immutable commit facts and finds task commits after the current execution boundary.
 *
 * Invariants:
 * - Exact trailer matching and changed-path ordering preserve their current semantics.
 * - Task queries exclude commits from superseded execution boundaries.
 */

export function commitFacts(
  repositoryRoot: string,
  commitHash: string,
): CommitFacts {
  const hash = resolveCommitOid(repositoryRoot, commitHash);
  const parents = runGit(repositoryRoot, ['show', '-s', '--format=%P', hash])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const tree = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%T',
    hash,
  ]).trim();
  const rawCommit = runGit(repositoryRoot, ['cat-file', 'commit', hash]);
  const messageOffset = rawCommit.indexOf('\n\n');
  if (messageOffset === -1) {
    throw workflowError(
      'INVALID_COMMIT_OBJECT',
      'Git commit object does not contain a message boundary.',
      ExitCode.staleState,
    );
  }
  const message = rawCommit.slice(messageOffset + 2);
  return { hash, parents, tree, message };
}

export function commitChangedPaths(
  repositoryRoot: string,
  commitHash: string,
): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      commitHash,
      '--',
    ]),
  )
    .map(normalizeChangedPath)
    .sort();
}

export function findExactTaskCommits(
  repositoryRoot: string,
  changeId: string,
  taskId: string,
  tip = 'HEAD',
): TaskCommit[] {
  const values = runGit(repositoryRoot, [
    'log',
    tip,
    '--format=%H%x00%s%x00%B%x00',
  ]).split('\0');
  const commits: TaskCommit[] = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    const hash = values[index].trimStart();
    const subject = values[index + 1];
    const message = values[index + 2];
    if (!/^[0-9a-f]{40,64}$/.test(hash)) {
      continue;
    }
    if (hasExactTrailers(message, changeId, taskId)) {
      commits.push({ hash, subject });
    }
  }
  return commits;
}

/**
 * Find the exact task commits that belong to the execution generation visible
 * at `tip`. A required-impact plan amendment deliberately reopens every task;
 * commits from the invalidated generation remain immutable history, but they
 * are not candidates for the new generation's completion evidence.
 */
export function findCurrentExecutionTaskCommits(
  repositoryRoot: string,
  changeId: string,
  taskId: string,
  tip = 'HEAD',
): TaskCommit[] {
  const commits = findExactTaskCommits(repositoryRoot, changeId, taskId, tip);
  const boundary = latestRequiredExecutionBoundary(
    repositoryRoot,
    changeId,
    tip,
  );
  if (boundary === null) return commits;
  return commits.filter(
    ({ hash }) =>
      hash !== boundary &&
      runGit(repositoryRoot, ['merge-base', boundary, hash], true).trim() ===
        boundary,
  );
}

function latestRequiredExecutionBoundary(
  repositoryRoot: string,
  changeId: string,
  tip: string,
): string | null {
  const values = runGit(repositoryRoot, [
    'log',
    '--first-parent',
    tip,
    '--format=%H%x00%B%x00',
  ]).split('\0');
  for (let index = 0; index + 1 < values.length; index += 2) {
    const commitHash = values[index].trimStart();
    if (!/^[0-9a-f]{40,64}$/.test(commitHash)) continue;
    const rawMessage = values[index + 1];
    const message = rawMessage.endsWith('\n')
      ? rawMessage.slice(0, -1)
      : rawMessage;
    const trailers = parseManagedTrailers(message);
    if (
      trailers?.kind === 'amend-plan' &&
      trailers.changeId === changeId &&
      trailers.executionImpact === 'required'
    ) {
      return commitHash;
    }
  }
  return null;
}

export function hasExactTrailers(
  message: string,
  changeId: string,
  taskId: string,
): boolean {
  const normalized = message.endsWith('\n') ? message.slice(0, -1) : message;
  if (normalized.endsWith('\n') || normalized.includes('\r')) {
    return false;
  }
  const lines = normalized.split('\n');
  if (
    lines.length < 4 ||
    lines.at(-3) !== '' ||
    lines.at(-2) !== `Change: ${changeId}` ||
    lines.at(-1) !== `Task: ${taskId}`
  ) {
    return false;
  }
  return !lines.slice(0, -2).some((line) => /^(?:Change|Task):/.test(line));
}
