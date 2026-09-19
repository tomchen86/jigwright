/** Assemble repository hook admission with current repository, session and publication checks. */
import { createRepositoryHookRules } from '../modules/lifecycle/repository-hooks.ts';
import { repositoryHookObservations } from '../runtime/repository-observation/repository-hooks.ts';
import { validateRepositoryState } from './repository-validation.ts';
import { validateWorkflowIntegrationAssets } from '../adapters/consumer/repository/work-registry/integration-assets.ts';
import { listSessions } from '../runtime/repository-observation/workflow-session-context.ts';
import { assertActivePublishTransaction } from './external-effect-production.ts';

export const { runRepositoryHook } = createRepositoryHookRules({
  ...repositoryHookObservations,
  validateRepositoryState,
  validateWorkflowIntegrationAssets,
  listSessions,
  assertActivePublishTransaction,
});
