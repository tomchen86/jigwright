/** Aggregates observed inbox, backlog and pending Finding facts without repository access. */
import type { WorkRegistryInventoryV1 } from './work-registry-contracts.ts';
export type GovernanceIntakeCountsV1 = Readonly<{
  schemaVersion: 1;
  inbox: number;
  pendingFindings: number;
  backlog: number;
}>;
export function projectGovernanceIntakeCounts(
  inventory: WorkRegistryInventoryV1,
  findings: readonly Readonly<{ disposition: string }>[],
): GovernanceIntakeCountsV1 {
  return {
    schemaVersion: 1,
    inbox: inventory.stages.inbox,
    pendingFindings: findings.filter(
      (finding) => finding.disposition === 'pending',
    ).length,
    backlog: inventory.stages.backlog,
  };
}
