import { createPlanningExecutionEpochOperations } from '../application/propose/planning-execution-epoch.ts';
import { planningExecutionEpochRepositoryObservations } from '../runtime/repository-observation/planning-execution-epoch.ts';
import { executionEpochStore } from './execution-governance-production.ts';
import { resolveTaskExecutionGenerationEvidence } from './ci-replay-production.ts';
import {
  inspectPlanningTransition,
  validatePlanningTransition,
} from './planning-provider-production.ts';
import type { PlanningTransitionExecutionServices } from '../modules/lifecycle/planning-execution-epoch.ts';
export const planningExecutionEpoch = createPlanningExecutionEpochOperations({
  executionEpochStore,
  observations: {
    ...planningExecutionEpochRepositoryObservations,
    taskExecutionGeneration: resolveTaskExecutionGenerationEvidence,
  },
});

export const planningTransitionExecution: PlanningTransitionExecutionServices =
  Object.freeze({
    planningExecutionEpoch,
    taskExecutionGeneration: resolveTaskExecutionGenerationEvidence,
    inspectPlanningTransition,
    validatePlanningTransition,
  });
