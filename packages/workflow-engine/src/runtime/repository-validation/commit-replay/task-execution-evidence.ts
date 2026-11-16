/** Observes exact Git history and replays evidence through required commit validators. */
import type { CiPlanningReplayOperations } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import type { CiSequenceReplayOperations } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import {
  invalidGeneration,
  uniqueTaskExecutionTaskIds,
  assertTaskExecutionReplayCompletesTask,
  assertRequiredAmendmentTaskReopening,
  type TaskExecutionGenerationEvidence,
  type TaskExecutionGenerationReader,
} from '../../../modules/assurance/task-execution-evidence.ts';
import { listRangeCommits } from './ci-git.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import { parseTasks } from '../../../modules/planning-provider/planning-artifact-parsers.ts';
import {
  commitFacts,
  findExactTaskCommits,
} from '../../repository-transaction/git-transitions.ts';
import { runGit } from '../../repository-transaction/git.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
export function createTaskExecutionGenerationReader(
  replay: Pick<CiPlanningReplayOperations, 'validateCiPlanningCommit'> &
    Pick<CiSequenceReplayOperations, 'replayCommitSequence'>,
): TaskExecutionGenerationReader {
  const { validateCiPlanningCommit, replayCommitSequence } = replay;
  function resolveTaskExecutionGenerationEvidence(
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
    taskIds: readonly string[],
    tip = 'HEAD',
  ): TaskExecutionGenerationEvidence {
    const uniqueTaskIds = uniqueTaskExecutionTaskIds(taskIds);
    const firstParentCommits = new Set(
      runGit(repositoryRoot, ['rev-list', '--first-parent', tip])
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );
    const boundary = latestRequiredAmendmentBoundary(
      repositoryRoot,
      changeRoot,
      changeId,
      tip,
    );
    const commitsByTask = Object.fromEntries(
      uniqueTaskIds.map((taskId) => {
        const candidates = findExactTaskCommits(
          repositoryRoot,
          changeId,
          taskId,
          tip,
        );
        for (const candidate of candidates) {
          if (!firstParentCommits.has(candidate.hash)) {
            throw invalidGeneration(
              'Task execution evidence must be on the managed first-parent history.',
              candidate.hash,
            );
          }
          assertCanonicalTaskCommit(
            repositoryRoot,
            changeId,
            taskId,
            candidate.hash,
          );
        }
        return [
          taskId,
          boundary === null
            ? candidates
            : candidates.filter(({ hash }) =>
                isStrictlyBetween(
                  repositoryRoot,
                  boundary.commitHash,
                  hash,
                  tip,
                ),
              ),
        ];
      }),
    );
    return { boundary, commitsByTask };
  }

  function assertCanonicalTaskCommit(
    repositoryRoot: string,
    changeId: string,
    taskId: string,
    commitHash: string,
  ): void {
    const facts = commitFacts(repositoryRoot, commitHash);
    if (facts.parents.length !== 1) {
      throw invalidGeneration(
        'Task execution evidence must have exactly one parent.',
        commitHash,
      );
    }
    let replay;
    try {
      const commits = listRangeCommits(
        repositoryRoot,
        facts.parents[0],
        commitHash,
      );
      replay = replayCommitSequence(repositoryRoot, commits, new Map());
    } catch {
      throw invalidGeneration(
        'Task execution evidence did not pass canonical task-transition replay.',
        commitHash,
      );
    }
    assertTaskExecutionReplayCompletesTask(
      replay.completedTasks,
      changeId,
      taskId,
      commitHash,
    );
  }

  function latestRequiredAmendmentBoundary(
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
    tip: string,
  ): NonNullable<TaskExecutionGenerationEvidence['boundary']> | null {
    const values = runGit(repositoryRoot, [
      'log',
      '--first-parent',
      tip,
      '--format=%H%x00%B%x00',
    ]).split('\0');
    for (let index = 0; index + 1 < values.length; index += 2) {
      const commitHash = values[index].trimStart();
      if (!/^[0-9a-f]{40,64}$/.test(commitHash)) continue;
      let trailers;
      try {
        trailers = parseManagedTrailers(values[index + 1]);
      } catch {
        throw invalidGeneration(
          'Task execution generation history contains a malformed managed transition.',
          commitHash,
        );
      }
      if (
        trailers?.kind !== 'amend-plan' ||
        trailers.changeId !== changeId ||
        trailers.executionImpact !== 'required'
      ) {
        continue;
      }
      try {
        validateCiPlanningCommit(
          repositoryRoot,
          commitHash,
          changeId,
          changeRoot,
        );
      } catch {
        throw invalidGeneration(
          'Required-impact execution boundary did not pass canonical planning replay.',
          commitHash,
        );
      }
      assertRequiredAmendmentReopenedEveryTask(
        repositoryRoot,
        changeRoot,
        changeId,
        commitHash,
      );
      return {
        commitHash,
        planningGeneration: trailers.planningGeneration,
        amendsPlanningGeneration: trailers.amendsPlanningGeneration,
      };
    }
    return null;
  }

  function assertRequiredAmendmentReopenedEveryTask(
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
    commitHash: string,
  ): void {
    const facts = commitFacts(repositoryRoot, commitHash);
    const tasksPath = `${changeRoot}/${changeId}/tasks.md`;
    if (facts.parents.length !== 1) {
      throw invalidGeneration(
        'Required-impact execution boundary must have exactly one parent.',
        commitHash,
      );
    }
    let before;
    let after;
    try {
      const beforeBytes = readFileAtCommit(
        repositoryRoot,
        facts.parents[0],
        tasksPath,
      );
      const afterBytes = readFileAtCommit(
        repositoryRoot,
        commitHash,
        tasksPath,
      );
      if (beforeBytes === undefined || afterBytes === undefined) {
        throw new Error('missing tasks');
      }
      before = parseTasks(beforeBytes);
      after = parseTasks(afterBytes);
    } catch {
      throw invalidGeneration(
        'Required-impact execution boundary has no valid task projection.',
        commitHash,
      );
    }
    assertRequiredAmendmentTaskReopening(before, after, commitHash);
  }

  function isStrictlyBetween(
    repositoryRoot: string,
    lowerExclusive: string,
    candidate: string,
    upperInclusive: string,
  ): boolean {
    return (
      candidate !== lowerExclusive &&
      runGit(
        repositoryRoot,
        ['merge-base', lowerExclusive, candidate],
        true,
      ).trim() === lowerExclusive &&
      runGit(
        repositoryRoot,
        ['merge-base', candidate, upperInclusive],
        true,
      ).trim() === candidate
    );
  }
  return resolveTaskExecutionGenerationEvidence;
}
