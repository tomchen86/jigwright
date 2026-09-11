/**
 * Connects Finding operations and intake counts to dedicated Git-ref
 * persistence.
 *
 * Invariants:
 * - Finding services share the same ref reader and publisher; counts use
 *   the resulting list operation.
 */
import { createGovernanceFindingServices } from '../application/governance-intake/governance-findings.ts';
import { projectGovernanceIntakeCounts } from '../modules/governance-intake/intake-summary.ts';
import {
  publishFindingRefRecord,
  readFindingRef,
} from '../runtime/storage-journal/governance-finding-ref.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';

import { readGovernanceSource } from './governance-sources-production.ts';

export const {
  recordGovernanceFinding,
  listGovernanceFindings,
  dismissGovernanceFinding,
  convertGovernanceFinding,
  linkGovernanceFinding,
} = createGovernanceFindingServices({
  readGovernanceSource,
  findingRef: { readFindingRef, publishFindingRefRecord },
});

export function inspectGovernanceIntakeCounts(
  repositoryRoot: string,
  runtimeRoot: string,
) {
  const inventory = workRegistryQueries.inspectWorkRegistry(repositoryRoot);
  return projectGovernanceIntakeCounts(
    inventory,
    listGovernanceFindings(runtimeRoot),
  );
}
