/** Shared test assembly for ordinary session verification and finalization. */
import { reviewedGeneratedAssets } from '../../src/composition-root/planning-provider-authoring-production.ts';
import {
  createSessionCheckService,
  type SessionCheckOptions,
} from '../../src/application/finalize/verification.ts';
import { createProductionCheckExecution } from '../../src/composition-root/check-execution-production.ts';
import { createProductionFinalizationService } from '../../src/composition-root/finalization-production.ts';

type CheckDependencies = Parameters<typeof createSessionCheckService>[0];
export function checkSession(
  manifestOperations: CheckDependencies['manifestOperations'],
  taskStrategyExecutionGate: CheckDependencies['taskStrategyExecutionGate'],
  changeContract: CheckDependencies['changeContract'],
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
) {
  return createSessionCheckService({
    reviewedAssets: reviewedGeneratedAssets,
    manifestOperations,
    taskStrategyExecutionGate,
    changeContract,
    createExecution: createProductionCheckExecution,
  }).checkSession(cwd, requestedSessionId, options);
}

export const {
  rollbackCompletion,
  recoverFinalize,
  finalizeSession,
  finalizeProtectedTaskApplyUnderGrant,
  finalizeTask,
  completeTask,
  finishSession,
} = createProductionFinalizationService();

import { createProductionProtectedTaskApplyGrantPort as createProtectedTaskApplyPort } from '../../src/composition-root/protected-task-apply-grant-production.ts';
export const createProductionProtectedTaskApplyGrantPort =
  createProtectedTaskApplyPort.bind(
    undefined,
    finalizeProtectedTaskApplyUnderGrant,
  );
