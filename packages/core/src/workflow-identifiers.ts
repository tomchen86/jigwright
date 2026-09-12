/** Pure workflow identifier validation, independent of filesystem and runtime layout. */
const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_PATTERN = /^\d+(?:\.\d+)+$/;
const SESSION_ID_PATTERN = /^session-[a-zA-Z0-9-]+$/;
const INVESTIGATION_ID_PATTERN = /^investigation-[a-zA-Z0-9-]+$/;
const INVOCATION_ID_PATTERN = /^invocation-[a-zA-Z0-9-]+$/;

/** Identifies a task execution and the repository baseline it refers to. */
export type TaskSessionReference = {
  sessionId: string;
  changeId: string;
  taskId: string;
  baseline: { head: string; tree: string };
};

export type InvalidRuntimeIdentifierFactory = () => Error;

export function assertChangeId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, CHANGE_ID_PATTERN, invalid);
}

export function assertTaskId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, TASK_ID_PATTERN, invalid);
}

export function assertSessionId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, SESSION_ID_PATTERN, invalid);
}

export function assertInvestigationId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, INVESTIGATION_ID_PATTERN, invalid);
}

export function assertInvocationId(
  value: string,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  return assertIdentifier(value, INVOCATION_ID_PATTERN, invalid);
}

function assertIdentifier(
  value: string,
  pattern: RegExp,
  invalid: InvalidRuntimeIdentifierFactory,
): string {
  if (!pattern.test(value)) throw invalid();
  return value;
}
