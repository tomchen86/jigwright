import { productionChangeRoutingAdmissionReader } from './change-routing-observation-production.ts';
/** Binds the mandatory reconciliation gate before opening a RED successor. */
import { createTaskStrategyRedRevisionService } from '../application/execute-task/task-strategy-red-revision.ts';
import { assertCurrentImplementationReconciliation } from './implementation-reconciliation-production.ts';
export const { beginTaskStrategyRedRevision, continueTaskStrategyRedRevision } =
  createTaskStrategyRedRevisionService(
    productionChangeRoutingAdmissionReader,
    assertCurrentImplementationReconciliation,
  );
