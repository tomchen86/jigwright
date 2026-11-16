import { createSessionCheckService } from '../runtime/repository-validation/session-verification.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from './task-strategy-gate-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { createProductionCheckExecution } from './check-execution-production.ts';

/** Selects the production capabilities once for session verification. */
export function createProductionSessionCheckService() {
  return createSessionCheckService({
    reviewedAssets: reviewedGeneratedAssets,
    manifestOperations: maintainerManifestOperations,
    taskStrategyExecutionGate: productionTaskStrategyExecutionGate,
    changeContract: productionChangeContract,
    createExecution: createProductionCheckExecution,
  });
}

export type ProductionSessionCheck = ReturnType<
  typeof createProductionSessionCheckService
>['checkSession'];
