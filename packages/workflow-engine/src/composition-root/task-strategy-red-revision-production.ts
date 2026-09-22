/** Binds the mandatory reconciliation gate before opening a RED successor. */
import { productionTaskStrategyCorrection } from './task-strategy-correction-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { createTaskStrategyRedRevisionService } from '../application/execute-task/task-strategy-red-revision.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation-production.ts';
export const { beginTaskStrategyRedRevision, continueTaskStrategyRedRevision } =
  createTaskStrategyRedRevisionService(
    productionChangeContract,
    assertCurrentImplementationReconciliation,
    productionTaskStrategyCorrection,
  );
