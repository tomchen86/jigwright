import type { ParsedTask } from '../planning-provider/planning-artifact-types.ts';

export type HandoffChange = { changeId: string; tasks: ParsedTask[] };
export type HandoffReadContext = Readonly<{
  contracts: readonly HandoffChange[];
  readText: (relativePath: string) => string | undefined;
}>;

/** Handoff document operations observe their inputs at each invocation. */
export type HandoffDocumentOperations = Readonly<{
  projectHandoff(repositoryRoot: string): string;
  projectHandoffForTaskProjection(
    repositoryRoot: string,
    changeId: string,
    tasks: string,
  ): string;
  renderHandoffForChange(repositoryRoot: string, changeId: string): string;
  validateHandoff(repositoryRoot: string, context?: HandoffReadContext): void;
}>;
