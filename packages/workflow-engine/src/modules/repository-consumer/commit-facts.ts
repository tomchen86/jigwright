/** Immutable facts read from one Git commit object. */
export type CommitFacts = {
  hash: string;
  parents: string[];
  tree: string;
  message: string;
};
