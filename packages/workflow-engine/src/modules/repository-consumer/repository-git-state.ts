/** Observed Git identity and working-state facts, with no Git process dependency. */

export type GitState = {
  repositoryRoot: string;
  repositoryRealPath: string;
  gitCommonDirectory: string;
  branch: string | null;
  head: string;
  tree: string;
  statusEntries: string[];
};
