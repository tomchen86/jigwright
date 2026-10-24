/** Binds current-count observation and per-command immediate propose execution. */
import { createCurrentGovernanceIntakeCounts } from '../application/governance-intake/current-governance-intake-counts.ts';
import {
  createGovernanceIntakeCountInspector,
  type ImmediateChangeStart,
} from '../application/governance-intake/governance-intake-workflow.ts';
import { observeGovernanceIntakeCountContext } from '../runtime/repository-observation/governance-intake-count-context.ts';
import { listGovernanceFindings } from './governance-findings-production.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';
import { startPropose } from './propose-production.ts';
import { productionRoleTopologyResolutionPort } from './role-topology-resolution-production.ts';
import { dispatchProviderWorker } from './provider-worker-dispatch-production.ts';
export const currentGovernanceIntakeCounts =
  createCurrentGovernanceIntakeCounts({
    observe: observeGovernanceIntakeCountContext,
    inspect: createGovernanceIntakeCountInspector({
      queries: workRegistryQueries,
      findings: { listGovernanceFindings },
    }),
  });
export function createGovernanceIntakeCommandDependencies(): {
  startImmediateChange: ImmediateChangeStart;
} {
  const providerDispatcher =
    process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
      ? undefined
      : dispatchProviderWorker;
  return {
    startImmediateChange(repositoryRoot, changeId, intent, immediateSource) {
      return startPropose(repositoryRoot, changeId, intent, {
        environment: process.env,
        ...(immediateSource === null ? {} : { immediateSource }),
        ...(providerDispatcher === undefined ? {} : { providerDispatcher }),
        roleTopologyResolution: productionRoleTopologyResolutionPort,
      });
    },
  };
}
