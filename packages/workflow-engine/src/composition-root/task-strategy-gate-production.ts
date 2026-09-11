import type { SessionInspection } from '../modules/lifecycle/session-inspection.ts';
import { createTaskStrategyExecutionGate } from '../application/finalize/task-strategy-gate.ts';
import { createTaskStrategyGateObservations } from '../runtime/repository-observation/task-strategy-gate.ts';
import { resolveCurrentTaskStrategyCorrection } from '../application/execute-task/task-strategy-correction.ts';
import { assertTaskMechanicalTransformationEvidence } from '../application/execute-task/task-mechanical-transform.ts';
export const productionTaskStrategyExecutionGate =
  createTaskStrategyExecutionGate<SessionInspection>({
    observeRepository: (inspection) =>
      createTaskStrategyGateObservations(
        inspection.git.repositoryRoot,
        inspection.git.gitCommonDirectory,
        inspection.contract.config.runtimeDirectory,
        inspection.session.sessionId,
      ),
    resolveCorrection: resolveCurrentTaskStrategyCorrection,
    assertMechanicalEvidence: assertTaskMechanicalTransformationEvidence,
  });
