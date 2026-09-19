import { parseDocumentationClosureFromCommitMessage } from '../../../modules/assurance/documentation-closure.ts';
import { resolveParentCommitOid } from '../../repository-transaction/git-object-ids.ts';
import { validateCiRouteCommit } from './ci-routing.ts';
import type { HistoricalTaskAuthority } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import { listCommitPaths } from './ci-git.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import type { RangeCommit } from '../../../modules/assurance/commit-replay/ci-git.ts';
import { assertUniqueCollaborationGrantUses } from '../../grants/grant-services.ts';
import type { CiCollaborationGrantUse } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { assertTaskHistory } from '../../../modules/assurance/commit-replay/ci-task-state.ts';
import { compareTasks } from '../../../modules/assurance/commit-replay/ci-task-state.ts';
import { taskKey } from '../../../modules/assurance/commit-replay/ci-task-state.ts';
import type { CompletedTask } from '../../../modules/assurance/commit-replay/ci-task-state.ts';
import { parseTasks } from '../../../modules/planning-provider/planning-artifact-parsers.ts';
import type { ChangeContract } from '../../../modules/planning-provider/change-contract.ts';
import { assertDocumentationClosureCommitCurrent } from '../../managed-documents/contracts/documentation-closure.ts';
import { commitFacts } from '../../repository-transaction/git-transitions.ts';
import { findCurrentExecutionTaskCommits } from '../../repository-transaction/git-transitions.ts';
import { completionDocumentPaths } from '../../managed-documents/validation/managed-documents.ts';
import { matchesAllowedPath } from '../../../foundation/repository-path/repository-path.ts';
import { assertExactTaskProjection } from '../../managed-documents/transaction/task-projection.ts';
import type { CommitSequenceResult } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import { recordTransitions } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import { recordDefinitions } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import { ciError } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import type { CiSequenceReplayServices } from './services.ts';
import type { CiSequenceReplayOperations } from '../../../modules/assurance/commit-replay/ci-sequence.ts';

/** Immutable commit replay operations; caller-owned semantic services are required. */

export function createCiSequenceReplay(
  services: CiSequenceReplayServices,
): CiSequenceReplayOperations {
  const {
    validateCiArchiveCommit,
    validateCiAuthorityCommit,
    validateCiPlanningCommit,
    loadHistoricalTaskAuthority,
  } = services;
  function replayCommitSequence(
    repositoryRoot: string,
    commits: RangeCommit[],
    contracts: Map<string, ChangeContract>,
    evaluatedAt: Date = new Date(),
    priorCollaborationGrantUses: readonly CiCollaborationGrantUse[] = [],
  ): CommitSequenceResult {
    const priorTaskTrailers = new Set<string>();
    const completedTasks = new Map<string, CompletedTask>();
    const archivedChanges = new Set<string>();
    const authorityGrants = new Set<string>();
    const requiredCheckDefinitions = new Map<string, string>();
    const collaborationGrantUses: CiCollaborationGrantUse[] = [
      ...priorCollaborationGrantUses,
    ];
    const completionPaths = completionDocumentPaths(repositoryRoot);
    for (const commit of commits) {
      if (commit.parents.length !== 1) {
        throw ciError(
          'CI_NON_LINEAR_COMMIT',
          'Managed PR commits must have exactly one parent.',
        );
      }

      if (!commit.trailers) {
        throw ciError(
          'CI_COMMIT_TRAILERS_REQUIRED',
          'Every current-only PR commit requires canonical managed trailers.',
        );
      }

      if (commit.trailers.kind === 'central-authority') {
        throw ciError(
          'CI_AUTHORITY_COMMIT_INVALID',
          'Central authority commits require the portable Grant receipt verifier before CI replay.',
        );
      }

      if (
        commit.trailers.kind === 'plan' ||
        // An amendment is a planning commit that also says what it replaces, so
        // it is replayed by the same rules rather than by weaker ones.
        commit.trailers.kind === 'amend-plan'
      ) {
        const planning = validateCiPlanningCommit(
          repositoryRoot,
          commit.hash,
          commit.trailers.changeId,
        );
        // Collect rather than decide here: one-use uniqueness is a property of
        // the complete replayed subject, so a grant reused across two otherwise
        // valid planning commits is only visible once the range is known.
        collaborationGrantUses.push(...planning.collaborationGrantUses);
        continue;
      }
      if (commit.trailers.kind === 'archive') {
        const archive = validateCiArchiveCommit(
          repositoryRoot,
          commit.hash,
          commit.trailers.changeId,
        );
        recordDefinitions(requiredCheckDefinitions, archive.checkDefinitions);
        archivedChanges.add(archive.changeId);
        continue;
      }
      if (
        commit.trailers.kind === 'authority' ||
        commit.trailers.kind === 'authority-candidate'
      ) {
        if (
          commit.trailers.kind === 'authority' &&
          authorityGrants.has(commit.trailers.grantId)
        ) {
          throw ciError(
            'CI_AUTHORITY_GRANT_DUPLICATE',
            'A pull-request range may claim each authority grant only once.',
          );
        }
        const authority = validateCiAuthorityCommit(
          repositoryRoot,
          commit,
          evaluatedAt,
        );
        recordDefinitions(
          requiredCheckDefinitions,
          authority.requiredCheckDefinitions,
          true,
        );
        if (authorityGrants.has(authority.grantId)) {
          throw ciError(
            'CI_AUTHORITY_GRANT_DUPLICATE',
            'A pull-request range may claim each authority grant only once.',
          );
        }
        authorityGrants.add(authority.grantId);
        continue;
      }
      if (commit.trailers.kind === 'route') {
        validateCiRouteCommit(repositoryRoot, {
          ...commit,
          trailers: commit.trailers,
        });
        continue;
      }

      const transitions = taskTransitionsForCommit(repositoryRoot, commit);
      if (transitions.length === 0) {
        throw ciError(
          'CI_TASK_TRANSITION_REQUIRED',
          'A task commit must complete its exact trailer task.',
        );
      }
      const authority = loadHistoricalTaskAuthority(
        repositoryRoot,
        commit.parents[0],
        commit.trailers.changeId,
        commit.trailers.taskId,
      );
      validateTaskTransition(
        repositoryRoot,
        commit,
        commit.trailers,
        transitions,
        authority,
        priorTaskTrailers,
      );
      validateTaskScope(
        repositoryRoot,
        commit,
        transitions,
        authority,
        completionPaths,
      );
      validateDocumentationClosure(
        repositoryRoot,
        commit,
        authority,
        completionPaths,
      );
      recordTransitions(completedTasks, transitions);
      recordCheckDefinitions(requiredCheckDefinitions, authority);
      priorTaskTrailers.add(taskKey(commit.trailers));
    }

    assertUniqueCollaborationGrantUses(collaborationGrantUses);

    return {
      completedTasks: [...completedTasks.values()].sort(compareTasks),
      archivedChanges: [...archivedChanges].sort(),
      authorityGrants: [...authorityGrants].sort(),
      requiredCheckDefinitions: Object.fromEntries(
        [...requiredCheckDefinitions].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      collaborationGrantUses,
    };
  }

  function validateDocumentationClosure(
    repositoryRoot: string,
    commit: RangeCommit,
    authority: HistoricalTaskAuthority,
    completionPaths: readonly string[],
  ): void {
    const trailers = commit.trailers;
    if (trailers?.kind !== 'task') {
      throw ciError(
        'CI_DOCUMENTATION_CLOSURE_INVALID',
        'Documentation closure validation requires a task commit.',
      );
    }
    const after = readFileAtCommit(
      repositoryRoot,
      commit.hash,
      authority.tasksPath,
    );
    if (after === undefined) {
      throw ciError(
        'CI_TASK_PROJECTION_INVALID',
        'A task commit is missing its task projection.',
      );
    }
    const finalTask = parseTasks(after).every(({ completed }) => completed);
    const message = commitFacts(repositoryRoot, commit.hash).message;
    const closure = parseDocumentationClosureFromCommitMessage(message);
    if (!finalTask) {
      if (closure !== null) {
        throw ciError(
          'CI_DOCUMENTATION_CLOSURE_PREMATURE',
          'Only the task commit that completes the whole change may carry documentation closure.',
        );
      }
      return;
    }
    const firstTask = authority.tasks[0];
    if (firstTask === undefined) {
      throw ciError(
        'CI_DOCUMENTATION_CLOSURE_INVALID',
        'Documentation closure cannot resolve the first task.',
      );
    }
    const firstTaskCommits = findCurrentExecutionTaskCommits(
      repositoryRoot,
      authority.changeId,
      firstTask.id,
      commit.hash,
    );
    let changeBaseCommit: string;
    if (firstTaskCommits.length === 0) {
      if (trailers.taskId !== firstTask.id) {
        throw ciError(
          'CI_DOCUMENTATION_CLOSURE_INVALID',
          'Documentation closure cannot resolve the first managed task commit.',
        );
      }
      changeBaseCommit = commit.parents[0]!;
    } else if (firstTaskCommits.length === 1) {
      changeBaseCommit = resolveParentCommitOid(
        repositoryRoot,
        firstTaskCommits[0]!.hash,
      );
    } else {
      throw ciError(
        'CI_DOCUMENTATION_CLOSURE_INVALID',
        'Documentation closure found ambiguous first-task commit history.',
      );
    }
    try {
      assertDocumentationClosureCommitCurrent({
        repositoryRoot,
        commitHash: commit.hash,
        changeId: authority.changeId,
        taskId: trailers.taskId,
        changeBaseCommit,
        allowedProjectionPaths: [authority.tasksPath, ...completionPaths],
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'DOCUMENTATION_CLOSURE_REQUIRED'
      ) {
        throw error;
      }
      throw ciError(
        'CI_DOCUMENTATION_CLOSURE_INVALID',
        'The final task commit documentation closure is malformed or stale.',
      );
    }
  }

  function taskTransitionsForCommit(
    repositoryRoot: string,
    commit: RangeCommit,
  ): CompletedTask[] {
    const transitions: CompletedTask[] = [];
    const taskPaths = listCommitPaths(repositoryRoot, commit).filter(
      (filePath) =>
        /^openspec\/changes\/[a-z0-9]+(?:-[a-z0-9]+)*\/tasks\.md$/.test(
          filePath,
        ),
    );
    for (const tasksPath of taskPaths) {
      const changeId = tasksPath.split('/')[2];
      const beforeContent = readFileAtCommit(
        repositoryRoot,
        commit.parents[0],
        tasksPath,
      );
      const afterContent = readFileAtCommit(
        repositoryRoot,
        commit.hash,
        tasksPath,
      );
      if (beforeContent === undefined && afterContent === undefined) {
        continue;
      }
      if (afterContent === undefined) {
        throw ciError(
          'CI_CHANGE_REMOVED',
          `Commit ${commit.hash} removed ${tasksPath}.`,
        );
      }
      const beforeTasks = beforeContent ? parseTasks(beforeContent) : [];
      const afterTasks = parseTasks(afterContent);
      assertTaskHistory(changeId, beforeTasks, afterTasks, {
        // Read from the commit that used the permission, so replay reaches the
        // same verdict from the same bytes.
        reopenAuthorized:
          commit.trailers?.kind === 'amend-plan' &&
          commit.trailers.executionImpact === 'required',
      });
      const beforeById = new Map(beforeTasks.map((task) => [task.id, task]));
      for (const task of afterTasks) {
        if (task.completed && !beforeById.get(task.id)?.completed) {
          transitions.push({ changeId, taskId: task.id });
        }
      }
    }
    return transitions.sort(compareTasks);
  }

  function validateTaskTransition(
    repositoryRoot: string,
    commit: RangeCommit,
    trailers: { kind: 'task'; changeId: string; taskId: string },
    transitions: CompletedTask[],
    authority: HistoricalTaskAuthority,
    priorTaskTrailers: Set<string>,
  ): void {
    const own = {
      changeId: trailers.changeId,
      taskId: trailers.taskId,
    };
    if (
      !transitions.some(
        (task) => task.changeId === own.changeId && task.taskId === own.taskId,
      ) ||
      transitions.some((task) => task.changeId !== own.changeId)
    ) {
      throw ciError(
        'CI_TASK_TRANSITION_COMMIT_MISMATCH',
        'Checkbox transitions are not bound to the commit task trailer.',
      );
    }

    const predecessor = transitions.filter(
      (task) => task.taskId !== own.taskId,
    );
    if (predecessor.length > 0) {
      const ownIndex = authority.tasks.findIndex(({ id }) => id === own.taskId);
      const previous = predecessor[0];
      const previousIndex = authority.tasks.findIndex(
        ({ id }) => id === previous.taskId,
      );
      if (
        predecessor.length !== 1 ||
        previousIndex !== ownIndex - 1 ||
        !priorTaskTrailers.has(taskKey(previous))
      ) {
        throw ciError(
          'CI_PREDECESSOR_TRANSITION_INVALID',
          'Only one previously evidenced adjacent predecessor may be reconciled.',
        );
      }
    }

    const before = readFileAtCommit(
      repositoryRoot,
      commit.parents[0],
      authority.tasksPath,
    );
    const after = readFileAtCommit(
      repositoryRoot,
      commit.hash,
      authority.tasksPath,
    );
    if (before === undefined || after === undefined) {
      throw ciError(
        'CI_TASK_PROJECTION_INVALID',
        'A task commit is missing its task projection.',
      );
    }
    const policyAllowsTaskEdits = authority.allowedPaths.some((allowedPath) =>
      matchesAllowedPath(authority.tasksPath, allowedPath),
    );
    if (!policyAllowsTaskEdits) {
      try {
        assertExactTaskProjection(
          before,
          after,
          transitions.map(({ taskId }) => taskId),
        );
      } catch {
        throw ciError(
          'CI_TASK_PROJECTION_INVALID',
          `Task file ${authority.tasksPath} is not an exact checkbox projection.`,
        );
      }
    }
  }

  function validateTaskScope(
    repositoryRoot: string,
    commit: RangeCommit,
    transitions: CompletedTask[],
    authority: HistoricalTaskAuthority,
    completionPaths: string[],
  ): void {
    const transitionPaths = new Set(
      transitions.map(
        ({ changeId }) => `openspec/changes/${changeId}/tasks.md`,
      ),
    );
    const implicit = new Set([...transitionPaths, ...completionPaths]);
    const changedPaths = listCommitPaths(repositoryRoot, commit);
    const planningMutation = changedPaths.find(
      (changedPath) =>
        changedPath.startsWith('openspec/changes/') &&
        !transitionPaths.has(changedPath),
    );
    if (planningMutation) {
      throw ciError(
        planningMutation.endsWith('/guard.json')
          ? 'CI_GUARD_CHANGED'
          : 'CI_TASK_PLANNING_MUTATION',
        'Task commits may not revise planning authority.',
        { commit: commit.hash, path: planningMutation },
      );
    }
    const unexpected = changedPaths.filter(
      (changedPath) =>
        !implicit.has(changedPath) &&
        !authority.allowedPaths.some((allowedPath) =>
          matchesAllowedPath(changedPath, allowedPath),
        ),
    );
    if (unexpected.length > 0) {
      throw ciError(
        'CI_COMMIT_OUT_OF_SCOPE',
        `Commit ${commit.hash} contains paths outside its parent task scope.`,
        { commit: commit.hash, unexpectedPaths: unexpected },
      );
    }
  }

  function recordCheckDefinitions(
    collected: Map<string, string>,
    authority: HistoricalTaskAuthority,
  ): void {
    recordDefinitions(collected, authority.checkDefinitions);
  }
  return { replayCommitSequence };
}
