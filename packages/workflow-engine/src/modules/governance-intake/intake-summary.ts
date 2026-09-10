/**
 * Aggregates inbox, pending Finding and backlog counts through supplied
 * readers.
 *
 * Invariants:
 * - Pending Finding counts include only records whose current disposition
 *   is pending.
 */
import type { GovernanceFindingReadModelV1 } from './governance-intake.ts';
import { inspectWorkRegistry } from './work-registry.ts';

export type GovernanceIntakeCountsV1 = Readonly<{
  schemaVersion: 1;
  inbox: number;
  pendingFindings: number;
  backlog: number;
}>;

/**
 * Read one current aggregate without creating Source, Finding, Work Item, or
 * projection records. The Work Registry reader retains its existing
 * transaction-recovery boundary so counts never observe a half-promotion.
 */
export function createGovernanceIntakeCountsReader(
  listGovernanceFindings: (
    runtimeRoot: string,
  ) => readonly GovernanceFindingReadModelV1[],
) {
  return inspectGovernanceIntakeCounts.bind(null, listGovernanceFindings);
}

function inspectGovernanceIntakeCounts(
  listGovernanceFindings: (
    runtimeRoot: string,
  ) => readonly GovernanceFindingReadModelV1[],
  repositoryRoot: string,
  runtimeRoot: string,
): GovernanceIntakeCountsV1 {
  const inventory = inspectWorkRegistry(repositoryRoot);
  const pendingFindings = listGovernanceFindings(runtimeRoot).filter(
    (finding) => finding.disposition === 'pending',
  ).length;
  return {
    schemaVersion: 1,
    inbox: inventory.stages.inbox,
    pendingFindings,
    backlog: inventory.stages.backlog,
  };
}
