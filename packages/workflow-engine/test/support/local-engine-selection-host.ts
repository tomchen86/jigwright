/** Test host: bind the real outer bootstrap readers without a source fallback. */
import {
  bootstrapInterventionStateRoot,
  resolveLocalEngineSelection,
} from '../../bootstrap/control-plane-trust.ts';
import { reviewedGeneratedAssets } from '../../src/composition-root/planning-provider-authoring-production.ts';
import type { LocalEngineSelectionReaders } from '../../src/modules/authority/local-engine-selection.ts';
import {
  createSessionCheckService,
  type SessionCheckOptions,
} from '../../src/application/finalize/verification.ts';
import { createProductionCheckExecution } from '../../src/composition-root/check-execution-production.ts';
import { createProductionFinalizationService } from '../../src/composition-root/finalization-production.ts';

export const localEngineSelectionReaders: LocalEngineSelectionReaders =
  Object.freeze({
    bootstrapInterventionStateRoot,
    resolveLocalEngineSelection,
  });

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
    localEngineSelection: localEngineSelectionReaders,
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
} = createProductionFinalizationService(localEngineSelectionReaders);

import { createProductionProtectedTaskApplyGrantPort as createProtectedTaskApplyPort } from '../../src/composition-root/protected-task-apply-grant-production.ts';
export const createProductionProtectedTaskApplyGrantPort =
  createProtectedTaskApplyPort.bind(
    undefined,
    finalizeProtectedTaskApplyUnderGrant,
  );
