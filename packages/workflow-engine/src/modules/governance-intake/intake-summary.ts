import { listGovernanceFindings } from './governance-intake.ts';
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
export function inspectGovernanceIntakeCounts(
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
