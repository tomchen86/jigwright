/**
 * Supplies repository-backed investigation context with lazily composed planning providers.
 *
 * Invariants:
 * - Provider ports are created on demand from the observed repository root.
 */
import { observeInvestigationRuntimeContext } from '../runtime/repository-observation/investigation-runtime-context.ts';
import {
  createPlanningProviderAuthoringPort,
  planningProviderReviewedAssetMirrors,
} from './planning-provider-authoring-production.ts';

export {
  loadActiveSessionContext,
  runSessionOperation,
} from '../runtime/repository-observation/workflow-session-context.ts';

export function loadInvestigationRuntimeContext(cwd: string) {
  const observation = observeInvestigationRuntimeContext(cwd);
  const { git } = observation;
  return {
    ...observation,
    planningProviderAuthoring: () =>
      createPlanningProviderAuthoringPort(git.repositoryRoot),
    planningProviderReviewedAssetMirrors: () =>
      planningProviderReviewedAssetMirrors(git.repositoryRoot),
  };
}
