/** Bind term-floor observation to current Manifest facts and repository operations. */
import { createImplementationTermFloor } from '../application/reconciliation/implementation-term-floor.ts';
import {
  readImplementationHunk,
  materializeImplementationTree,
  scanImplementationTree,
} from '../runtime/repository-observation/implementation-term-floor.ts';
import type { CurrentInvestigationManifest } from '../modules/planning-provider/change-contract.ts';
const derive = createImplementationTermFloor({
  readHunk: readImplementationHunk,
  materializeTree: materializeImplementationTree,
  scanTree: scanImplementationTree,
});
export function deriveImplementationTermDelta(input: {
  repositoryRoot: string;
  baselineCommit: string;
  productionPaths: readonly string[];
  investigation: CurrentInvestigationManifest;
}) {
  return derive({
    repositoryRoot: input.repositoryRoot,
    baselineCommit: input.baselineCommit,
    productionPaths: input.productionPaths,
    knownTermIds: readKnownPlanningTermIds(input.investigation),
  });
}
function readKnownPlanningTermIds(
  investigation: CurrentInvestigationManifest,
): string[] {
  const applicability = investigation.manifest.applicability;
  if (applicability.kind === 'exemption') return [];
  return applicability.replayContract.canonicalTerms.map(
    ({ termId }) => termId,
  );
}
