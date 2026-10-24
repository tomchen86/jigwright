/** Wires registry reads, projections and durable writes while preserving the public operation surface. */
import { createWorkRegistryWriteService } from '../application/work-registry/work-registry.ts';
import { readGovernanceSource } from './governance-sources-production.ts';
import { createWorkRegistryWriteRepository } from '../runtime/work-registry/write-repository.ts';
import {
  workRegistryProjectionOperations,
  workRegistryQueries,
} from './work-registry-read-production.ts';
const writes = createWorkRegistryWriteService({
  repository: createWorkRegistryWriteRepository(),
  queries: workRegistryQueries,
  projections: workRegistryProjectionOperations,
  readSource: readGovernanceSource,
});
export type { WorkRegistryReadTestHooks } from '../application/work-registry/work-registry-queries.ts';
export type * from '../modules/governance-intake/work-registry-contracts.ts';
export { workItemDigest } from '../modules/governance-intake/work-registry-record.ts';
export const {
  createWorkItem,
  createWorkItemAfterExactSourceTextRecheck,
  ensureFindingConversionWorkItem,
  attachSourceToWorkItem,
  correctWorkItemSource,
  workRegistryTransitionRequiresGrant,
  assertOrdinaryWorkRegistryTransition,
  applyWorkItemReview,
  promoteWorkItem,
  hasExactWorkItemPromotionReceipt,
  hasExactCurrentWorkItemPromotion,
  linkSourceToChange,
  reconcileArchivedWorkItems,
  prepareWorkItemPromotionSurvey,
  ensureWorkItemPromotionSurveyBinding,
  ensureWorkItemPromotionChangeDirectory,
  observeWorkItemPromotionPreparationBinding,
  prepareWorkItemPromotionFromBinding,
  workItemPromotionPreparationMatches,
  observeWorkItemPromotionSurveyBinding,
  readWorkItemPromotionSurveyBinding,
} = writes;
export const {
  showWorkItem,
  listWorkItems,
  recommendWorkItemPriorities,
  inspectWorkRegistry,
  searchWorkItems,
  findWorkItemsByExactSourceText,
  traceWorkItem,
  traceGovernanceSource,
  validateWorkRegistry,
  validateCurrentChangeOrigin,
  readCurrentChangeOrigin,
} = workRegistryQueries;
export const {
  renderWorkRegistry,
  workRegistryProjectionBindings,
  inspectWorkRegistryProjectionStatus,
  validateWorkRegistryProjections,
} = workRegistryProjectionOperations;
