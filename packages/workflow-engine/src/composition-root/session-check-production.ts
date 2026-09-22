import { createSessionCheckService } from '../application/finalize/verification.ts';
import type { LocalEngineSelectionReaders } from '../modules/authority/local-engine-selection.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from './task-strategy-gate-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { createProductionCheckExecution } from './check-execution-production.ts';

/** Selects the six production capabilities once for session verification. */
export function createProductionSessionCheckService(
  localEngineSelection: LocalEngineSelectionReaders,
) {
  return createSessionCheckService({
    reviewedAssets: reviewedGeneratedAssets,
    localEngineSelection,
    manifestOperations: maintainerManifestOperations,
    taskStrategyExecutionGate: productionTaskStrategyExecutionGate,
    changeContract: productionChangeContract,
    createExecution: createProductionCheckExecution,
  });
}
