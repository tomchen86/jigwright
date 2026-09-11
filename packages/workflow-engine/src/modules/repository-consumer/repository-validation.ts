/** Canonical result of validating repository changes and managed documents. */
export type RepositoryValidation = {
  repositoryRoot: string;
  changes: string[];
  documents: string[];
};
