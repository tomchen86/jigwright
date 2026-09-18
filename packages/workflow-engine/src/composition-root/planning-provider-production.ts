import { assertPlanningPaths as assertPlanningPathsWithAdmission } from '../modules/source/planning-paths.ts';
import { openSpecPlanningPathPolicy } from '../adapters/planning/openspec/documents/planning-path-policy.ts';
export const assertPlanningPaths = assertPlanningPathsWithAdmission.bind(
  undefined,
  openSpecPlanningPathPolicy.admit,
);
export const requiredPlanningArtifactPaths =
  openSpecPlanningPathPolicy.requiredArtifactPaths;
import { loadChangeContract as productionChangeContractReader } from './consumer-contract-production.ts';
const inspectPlanningTransitionWithReader =
  inspectPlanningTransitionWithReaderWithContractReader.bind(
    undefined,
    productionChangeContractReader,
  );
import { workRegistryQueries } from './work-registry-read-production.ts';
/**
 * Assembles planning validation, historical provider bindings and committed document projections.
 *
 * Invariants:
 * - Historical replay loads the contract from its exact commit before projecting document bytes.
 * - Provider and role policy readers preserve the selected repository authority.
 */
import type { CurrentPlanningRoleOverridePolicy } from '../modules/provider-orchestration/planning-role-provider-policy.ts';
import {
  inspectPlanningTransition as inspectPlanningTransitionWithReaderWithContractReader,
  resolveHistoricalOpenSpecPlanningTransitionBinding as resolveHistoricalOpenSpecPlanningTransitionBindingWithReader,
  resolveHistoricalOpenSpecProviderBinding as resolveHistoricalOpenSpecProviderBindingWithReader,
  validateOpenSpecPlanning as validatePlanningTransitionWithAdapter,
} from '../adapters/planning/openspec/documents/planning-contract.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  partitionPlanningRolePolicyPaths,
  type PlanningRolePolicyPathPartition,
} from '../modules/source/planning-role-policy-paths.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../runtime/repository-transaction/planning-role-provider-policy-reader.ts';
import { planningProviderBindingReader } from '../runtime/repository-transaction/planning-provider-binding-store.ts';
import { loadRepositoryConsumerConfiguration } from '../runtime/repository-observation/repository-consumer.ts';
import { loadCommittedChangeContract } from './consumer-contract-production.ts';
import { loadStableValidatedChangeContract } from './validated-contract-context.ts';
import { planPlanningSemanticLedger } from '../runtime/managed-documents/transaction/semantic-ledger-projection.ts';

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
    workRegistryQueries.readCurrentChangeOrigin,
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
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration.planning
      .currentSchemaName,
    inspection.transitionKind,
    rolePolicyPaths,
    planningRoleOverride,
  );
  return Object.freeze({ ...inspection, planningRoleOverride });
}

export function validatePlanningTransition(
  repositoryRoot: string,
  changeId: string,
  schemaName: Parameters<typeof validatePlanningTransitionWithAdapter>[3],
): ReturnType<typeof validatePlanningTransitionWithAdapter> {
  return validatePlanningTransitionWithAdapter(
    loadStableValidatedChangeContract,
    repositoryRoot,
    changeId,
    schemaName,
  );
}

export function loadCommittedPlanningDocumentProjection(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  schemaName: Parameters<typeof loadCommittedChangeContract>[3],
) {
  const contract = loadCommittedChangeContract(
    repositoryRoot,
    commit,
    changeId,
    schemaName,
  );
  return {
    contract,
    semanticLedgerMutations: planPlanningSemanticLedger(
      repositoryRoot,
      changeId,
      contract.investigation?.manifest,
    ),
  };
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
