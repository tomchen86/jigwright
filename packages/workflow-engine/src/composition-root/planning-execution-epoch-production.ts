import { createPlanningExecutionEpochOperations } from '../application/propose/planning-execution-epoch.ts';
import { planningExecutionEpochRepositoryObservations } from '../runtime/repository-observation/planning-execution-epoch.ts';
import { executionEpochStore } from './execution-governance-production.ts';
import { resolveTaskExecutionGenerationEvidence } from './ci-replay-production.ts';
export const planningExecutionEpoch = createPlanningExecutionEpochOperations({
  executionEpochStore,
  observations: {
    ...planningExecutionEpochRepositoryObservations,
    taskExecutionGeneration: resolveTaskExecutionGenerationEvidence,
  },
});

export const planningTransitionExecution = {
  planningExecutionEpoch,
  taskExecutionGeneration: resolveTaskExecutionGenerationEvidence,
};
