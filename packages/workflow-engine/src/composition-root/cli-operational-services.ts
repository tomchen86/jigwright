/**
 * Collects runtime inspection, retry, retention and replacement services
 * for operational CLI commands.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
// Production bindings for operational CLI command families.
export { loadWorkflowConformanceVectorsV2 } from '@jigwright/core/conformance-vectors';
export { discoverRepository } from '../runtime/repository-transaction/git.ts';
export {
  type AuthorityRemapPair,
  projectAuthorityRemap,
} from './authority-remap.ts';
export { inspectT3BoundaryInventory } from '../modules/assurance/t3-boundary-inventory.ts';
export type { T3BoundaryTypeScriptApi } from '../modules/assurance/t3-boundary-scanner.ts';
export type { IntegrationDeltaReviewSubmission } from '../modules/assurance/pre-merge-assurance.ts';
export {
  requestExecutionReplacement,
  executeGrantedReplacement,
} from '../application/control-plane/execution-replacement.ts';
export {
  listExecutionJobs,
  inspectExecutionJob,
  prepareProviderReplacement,
} from '../runtime/provider-execution/execution-runtime.ts';
export { pruneProviderRuntime } from '../runtime/provider-execution/provider-retention.ts';
export {
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence,
} from '../runtime/provider-execution/retention-control.ts';
export {
  pumpProviderRetrySchedules,
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
} from '../runtime/provider-execution/provider-retry-scheduler.ts';
export { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';
