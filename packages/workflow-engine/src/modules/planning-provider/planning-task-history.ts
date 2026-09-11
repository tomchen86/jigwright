/**
 * Adapts shared planning task-history checks to workflow errors.
 *
 * Invariants:
 * - Partial reopening retains the verification category and error details;
 *   other history errors use the guard category.
 */
import {
  amendmentLeftWorkMarkedDone as amendmentLeftWorkMarkedDoneWithCore,
  assertPlanningTaskHistory as assertPlanningTaskHistoryWithCore,
  PlanningTaskHistoryError,
  taskStates as taskStatesWithCore,
  type PlanningTaskCompletion,
} from '@jigwright/core/planning-task-history';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type { PlanningTaskCompletion };

export function amendmentLeftWorkMarkedDone<
  Task extends PlanningTaskCompletion,
>(input: {
  reopenAuthorized: boolean;
  reopenedTasks: readonly string[];
  beforeTasks: readonly Task[] | undefined;
}): boolean {
  return amendmentLeftWorkMarkedDoneWithCore(input);
}

export function assertPlanningTaskHistory<
  BeforeTask extends PlanningTaskCompletion,
  AfterTask extends PlanningTaskCompletion,
>(
  before: readonly BeforeTask[] | undefined,
  after: readonly AfterTask[],
  options: Readonly<{ reopenAuthorized?: boolean }> = {},
): string[] {
  return mapTaskHistoryError(() =>
    assertPlanningTaskHistoryWithCore(before, after, options),
  );
}

export function taskStates<Task extends PlanningTaskCompletion>(
  tasks: readonly Task[],
): PlanningTaskCompletion[] {
  return taskStatesWithCore(tasks);
}

function mapTaskHistoryError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof PlanningTaskHistoryError)) throw error;
    throw workflowError(
      error.code,
      error.message,
      error.code === 'AMENDMENT_PARTIAL_REOPEN'
        ? ExitCode.verification
        : ExitCode.guard,
      error.details === undefined ? undefined : { details: error.details },
    );
  }
}

export type PlanningTaskState = {
  id: string;
  completed: boolean;
};
