/**
 * Checks task completion history across planning amendments.
 *
 * Invariants:
 * - Planning changes cannot mark new work complete, and an authorized
 *   reopening must reopen all completed tasks.
 */
export type PlanningTaskHistoryErrorCode =
  'AMENDMENT_PARTIAL_REOPEN' | 'PLANNING_TASK_STATE_INVALID';

export type PlanningTaskCompletion = Readonly<{
  id: string;
  completed: boolean;
}>;

export class PlanningTaskHistoryError extends TypeError {
  readonly code: PlanningTaskHistoryErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: PlanningTaskHistoryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PlanningTaskHistoryError';
    this.code = code;
    this.details = details;
  }
}

export function amendmentLeftWorkMarkedDone<
  Task extends PlanningTaskCompletion,
>(input: {
  reopenAuthorized: boolean;
  reopenedTasks: readonly string[];
  beforeTasks: readonly Task[] | undefined;
}): boolean {
  return (
    input.reopenAuthorized &&
    input.reopenedTasks.length === 0 &&
    (input.beforeTasks ?? []).some(({ completed }) => completed)
  );
}

export function assertPlanningTaskHistory<
  BeforeTask extends PlanningTaskCompletion,
  AfterTask extends PlanningTaskCompletion,
>(
  before: readonly BeforeTask[] | undefined,
  after: readonly AfterTask[],
  options: Readonly<{ reopenAuthorized?: boolean }> = {},
): string[] {
  if (!before) {
    if (after.some(({ completed }) => completed)) {
      throw invalidTaskState();
    }
    return [];
  }
  const beforeById = new Map(before.map((task) => [task.id, task]));
  const afterById = new Map(after.map((task) => [task.id, task]));
  if (before.some((task) => task.completed && !afterById.has(task.id))) {
    throw invalidTaskState();
  }

  const newlyCompleted = after.filter(
    (task) => !beforeById.get(task.id)?.completed && task.completed,
  );
  const reopened = after
    .filter((task) => beforeById.get(task.id)?.completed && !task.completed)
    .map(({ id }) => id);

  if (newlyCompleted.length > 0) {
    throw invalidTaskState();
  }
  if (reopened.length === 0) return [];
  if (!options.reopenAuthorized) {
    throw invalidTaskState();
  }

  const previouslyCompleted = before
    .filter((task) => task.completed)
    .map(({ id }) => id);
  if (reopened.length !== previouslyCompleted.length) {
    throw new PlanningTaskHistoryError(
      'AMENDMENT_PARTIAL_REOPEN',
      'An amendment that reopens execution reopens all of it; a chosen subset would claim the rest is unaffected.',
      {
        reopened,
        stillCompleted: previouslyCompleted.filter(
          (id) => !reopened.includes(id),
        ),
      },
    );
  }
  return reopened.sort();
}

export function taskStates<Task extends PlanningTaskCompletion>(
  tasks: readonly Task[],
): PlanningTaskCompletion[] {
  return tasks.map(({ id, completed }) => ({ id, completed }));
}

function invalidTaskState(): PlanningTaskHistoryError {
  return new PlanningTaskHistoryError(
    'PLANNING_TASK_STATE_INVALID',
    'Planning transition may not project task completion state.',
  );
}
