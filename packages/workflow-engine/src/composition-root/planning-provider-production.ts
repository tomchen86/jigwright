import {
  inspectPlanningTransition as inspectPlanningTransitionWithReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
  validateOpenSpecPlanning as validatePlanningTransitionWithAdapter,
} from '../adapters/planning/openspec/documents/planning-contract.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  partitionPlanningRolePolicyPaths,
  type PlanningRolePolicyPathPartition,
} from '../modules/source/planning-role-policy-paths.ts';
import {
  readCurrentPlanningRoleOverridePolicy,
  type CurrentPlanningRoleOverridePolicy,
} from '../modules/source/planning-role-provider-policy-reader.ts';
import { planningProviderBindingReader } from '../runtime/repository-transaction/planning-provider-binding-store.ts';
import { repositoryPlanningConfiguration } from '../modules/repository-consumer/repository-consumer-config.ts';

export {
  agentRolePlanV2Path,
  partitionPlanningRolePolicyPaths,
} from '../modules/source/planning-role-policy-paths.ts';
export {
  amendmentLeftWorkMarkedDone,
  assertPlanningTaskHistory,
  taskStates,
} from '../modules/planning-provider/planning-task-history.ts';

export function inspectPlanningTransition(
  repositoryRoot: string,
  baselineHead: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  reopenAuthorized = false,
) {
  const rolePolicyPaths = partitionPlanningRolePolicyPaths(
    changeId,
    changedPaths,
    deletedPaths,
  );
  const inspection = inspectPlanningTransitionWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    baselineHead,
    changeRoot,
    changeId,
    [...rolePolicyPaths.providerChangedPaths],
    rolePolicyPaths.providerDeletedPaths,
    reopenAuthorized,
  );
  const planningRoleOverride = readCurrentPlanningRoleOverridePolicy(
    repositoryRoot,
    changeId,
  );
  assertPlanningRolePolicyClosure(
    inspection.schemaName,
    repositoryPlanningConfiguration(repositoryRoot).currentSchemaName,
    inspection.transitionKind,
    rolePolicyPaths,
    planningRoleOverride,
  );
  return Object.freeze({ ...inspection, planningRoleOverride });
}

export function validatePlanningTransition(
  repositoryRoot: string,
  changeId: string,
  schemaName: Parameters<typeof validatePlanningTransitionWithAdapter>[2],
): ReturnType<typeof validatePlanningTransitionWithAdapter> {
  return validatePlanningTransitionWithAdapter(
    repositoryRoot,
    changeId,
    schemaName,
  );
}

export function resolveHistoricalOpenSpecPlanningTransitionBinding(
  repositoryRoot: string,
  parentCommit: string,
  candidateCommit: string,
  changeRoot: string,
  changeId: string,
  transitionKind: 'introduction' | 'revision',
) {
  return resolveHistoricalOpenSpecPlanningTransitionBindingWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    parentCommit,
    candidateCommit,
    changeRoot,
    changeId,
    transitionKind,
  );
}

export function resolveHistoricalOpenSpecProviderBinding(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
) {
  return resolveHistoricalOpenSpecProviderBindingWithReader(
    planningProviderBindingReader,
    repositoryRoot,
    commit,
    changeRoot,
    changeId,
  );
}

function assertPlanningRolePolicyClosure(
  schemaName: string,
  currentSchemaName: string,
  transitionKind: 'introduction' | 'revision',
  paths: PlanningRolePolicyPathPartition,
  override: CurrentPlanningRoleOverridePolicy | null,
): void {
  if (
    (schemaName !== currentSchemaName &&
      (paths.policyChanged || override !== null)) ||
    (paths.policyChanged && !paths.policyDeleted && override === null) ||
    (paths.policyDeleted && override !== null) ||
    (transitionKind === 'introduction' &&
      override !== null &&
      !paths.policyChanged)
  ) {
    throw workflowError(
      'PLANNING_ROLE_POLICY_PATHS_INVALID',
      'Agent-role planning policy must be one exact investigation-first transition companion.',
      ExitCode.guard,
    );
  }
}
