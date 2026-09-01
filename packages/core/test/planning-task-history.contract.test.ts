import assert from 'node:assert/strict';
import test from 'node:test';

import {
  amendmentLeftWorkMarkedDone,
  assertPlanningTaskHistory,
  PlanningTaskHistoryError,
  taskStates,
} from '../src/planning-task-history.ts';

const BEFORE = [
  { id: '1.1', completed: true },
  { id: '1.2', completed: true },
  { id: '1.3', completed: false },
] as const;

test('planning task history is one provider-neutral current reducer', () => {
  assert.deepEqual(
    assertPlanningTaskHistory(
      BEFORE,
      BEFORE.map((task) => ({ ...task, completed: false })),
      { reopenAuthorized: true },
    ),
    ['1.1', '1.2'],
  );
  assert.deepEqual(taskStates(BEFORE), [
    { id: '1.1', completed: true },
    { id: '1.2', completed: true },
    { id: '1.3', completed: false },
  ]);
  assert.equal(
    amendmentLeftWorkMarkedDone({
      reopenAuthorized: true,
      reopenedTasks: [],
      beforeTasks: BEFORE,
    }),
    true,
  );
});

test('planning task history refuses authored completion and partial reopen', () => {
  assert.throws(
    () =>
      assertPlanningTaskHistory(undefined, [{ id: '1.1', completed: true }]),
    (error: unknown) =>
      error instanceof PlanningTaskHistoryError &&
      error.code === 'PLANNING_TASK_STATE_INVALID',
  );
  assert.throws(
    () =>
      assertPlanningTaskHistory(
        BEFORE,
        [
          { id: '1.1', completed: false },
          { id: '1.2', completed: true },
          { id: '1.3', completed: false },
        ],
        { reopenAuthorized: true },
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlanningTaskHistoryError);
      assert.equal(error.code, 'AMENDMENT_PARTIAL_REOPEN');
      assert.deepEqual(error.details, {
        reopened: ['1.1'],
        stillCompleted: ['1.2'],
      });
      return true;
    },
  );
});
