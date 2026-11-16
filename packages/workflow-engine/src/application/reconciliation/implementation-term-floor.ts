/** Orchestrate one bounded term-floor observation round over required repository capabilities. */
import {
  extractImplementationDeltaTerms,
  buildImplementationTermDelta,
  type ImplementationTermScanObservation,
} from '../../modules/assurance/implementation-term-floor.ts';
import type { ImplementationDeltaTerm } from '../../modules/assurance/implementation-term-dispositions.ts';
export type ImplementationTermFloorInput = Readonly<{
  repositoryRoot: string;
  baselineCommit: string;
  productionPaths: readonly string[];
  knownTermIds: readonly string[];
}>;
export type ImplementationTermObservations = Readonly<{
  readHunk(
    repositoryRoot: string,
    baselineCommit: string,
    candidatePath: string,
  ): string;
  materializeTree(
    input: Pick<
      ImplementationTermFloorInput,
      'repositoryRoot' | 'baselineCommit' | 'productionPaths'
    >,
  ): string;
  scanTree(input: {
    repositoryRoot: string;
    treeOid: string;
    terms: readonly ImplementationDeltaTerm[];
  }): ImplementationTermScanObservation;
}>;
export function createImplementationTermFloor(
  observations: ImplementationTermObservations,
) {
  return function deriveImplementationTermDelta(
    input: ImplementationTermFloorInput,
  ) {
    const diffs = [...input.productionPaths]
      .sort()
      .map((candidatePath) =>
        observations.readHunk(
          input.repositoryRoot,
          input.baselineCommit,
          candidatePath,
        ),
      );
    const newTerms = extractImplementationDeltaTerms(diffs, input.knownTermIds);
    const implementationTree = observations.materializeTree(input);
    const scan: ImplementationTermScanObservation =
      newTerms.length === 0
        ? { outcome: 'ready', facts: [], groups: [] }
        : observations.scanTree({
            repositoryRoot: input.repositoryRoot,
            treeOid: implementationTree,
            terms: newTerms,
          });
    return buildImplementationTermDelta({
      baselineCommit: input.baselineCommit,
      implementationTree,
      knownTermIds: input.knownTermIds,
      newTerms,
      scan,
    });
  };
}
