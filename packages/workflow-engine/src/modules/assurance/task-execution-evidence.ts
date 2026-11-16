/** Pure admission rules and facts for task execution generation evidence. */
import type { ParsedTask } from '../planning-provider/planning-artifact-types.ts';
import type { CompletedTask } from './commit-replay/ci-task-state.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export type TaskCommit = {
  hash: string;
  subject: string;
};
export type TaskExecutionGenerationEvidence = {
  boundary: null | {
    commitHash: string;
    planningGeneration: string;
    amendsPlanningGeneration: string;
  };
  commitsByTask: Readonly<Record<string, TaskCommit[]>>;
};
export type TaskExecutionGenerationReader = (
  repositoryRoot: string,
  changeRoot: string,
  changeId: string,
  taskIds: readonly string[],
  tip?: string,
) => TaskExecutionGenerationEvidence;
export function uniqueTaskExecutionTaskIds(
  taskIds: readonly string[],
): string[] {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length !== taskIds.length) {
    throw invalidGeneration(
      'Task execution generation inspection requires unique task identities.',
    );
  }
  return uniqueTaskIds;
}
export function assertTaskExecutionReplayCompletesTask(
  completedTasks: readonly CompletedTask[],
  changeId: string,
  taskId: string,
  commitHash: string,
): void {
  if (
    completedTasks.length !== 1 ||
    completedTasks[0]?.changeId !== changeId ||
    completedTasks[0]?.taskId !== taskId
  ) {
    throw invalidGeneration(
      'Task execution evidence does not complete exactly its named task.',
      commitHash,
    );
  }
}
export function assertRequiredAmendmentTaskReopening(
  before: ParsedTask[],
  after: ParsedTask[],
  commitHash: string,
): void {
  if (
    before.length === 0 ||
    before.some(({ completed }) => !completed) ||
    after.some(({ completed }) => completed) ||
    JSON.stringify(before.map(({ id }) => id)) !==
      JSON.stringify(after.map(({ id }) => id))
  ) {
    throw invalidGeneration(
      'Required-impact execution boundary did not reopen every completed task.',
      commitHash,
    );
  }
}
export function invalidGeneration(message: string, commitHash?: string) {
  return workflowError(
    'TASK_EXECUTION_GENERATION_INVALID',
    message,
    ExitCode.staleState,
    commitHash === undefined ? undefined : { details: { commitHash } },
  );
}
