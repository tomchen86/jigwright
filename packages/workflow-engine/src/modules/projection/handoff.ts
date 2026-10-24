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
  /** Render and write the currently selected handoff document. */
  renderHandoff(repositoryRoot: string): string;
  /** Render and write the handoff for this explicit change. */
  renderHandoffForChange(repositoryRoot: string, changeId: string): string;
  /** Validate current bytes without writing the document. */
  validateHandoff(repositoryRoot: string, context?: HandoffReadContext): void;
  validateHandoffForChange(repositoryRoot: string, changeId: string): void;
}>;
