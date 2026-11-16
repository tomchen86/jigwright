/** Immutable Git commit facts and exact task-trailer matching. */
export type CommitFacts = {
  hash: string;
  parents: string[];
  tree: string;
  message: string;
};

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
