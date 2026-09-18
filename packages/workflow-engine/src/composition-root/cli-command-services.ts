import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { readAndValidateTaskRevisionApproval } from './task-revision-approval-production.ts';
export type { ControlPlanePromotionBootstrapObservations } from '../modules/authority/intervention-bootstrap-contract.ts';
import {
  preparePullRequestPreMergeAssurance,
  verifyPullRequest,
} from './ci-verification-production.ts';

import { maintainerManifestOperations } from './maintainer-manifest-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from './planning-execution-epoch-production.ts';
import { productionTaskStrategyExecutionGate } from './task-strategy-gate-production.ts';
import { archiveEligibilityReplayServices } from './ci-replay-production.ts';
import { productionPlanningArchiveSourcePolicy } from './planning-archive-projection-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import {
  productionChangeRoutingAdmissionReader,
  productionChangeRoutingInspector,
} from './change-routing-observation-production.ts';

import { collaborationGrantCodec as productionArchiveGrantCodec } from '../runtime/grants/grant-services.ts';
import { reconcileArchivedWorkItems as productionArchivedWorkItemReconciler } from './work-registry-production.ts';
import { managedDocuments } from './managed-documents-production.ts';
import { renderHandoffFromTrackedFacts as productionTrackedHandoffRenderer } from './handoff-production.ts';
import { commitArchiveTransition as commitArchiveTransitionWithHandoff } from '../application/archive/archive-transition.ts';
export const commitArchiveTransition = commitArchiveTransitionWithHandoff.bind(
  undefined,
  productionPlanningExecution,
  productionPlanningArchiveSourcePolicy,
  archiveEligibilityReplayServices,
  productionArchiveGrantCodec,
  productionTrackedHandoffRenderer,
  productionArchivedWorkItemReconciler,
);
import { preparePostMergeArchivePullRequest as preparePostMergeArchivePullRequestWithHandoff } from '../application/archive/archive-pr-orchestration.ts';
export const preparePostMergeArchivePullRequest =
  preparePostMergeArchivePullRequestWithHandoff.bind(
    undefined,
    preparePullRequestPreMergeAssurance,
    productionPlanningExecution,
    productionPlanningArchiveSourcePolicy,
    archiveEligibilityReplayServices,
    productionArchiveGrantCodec,
    productionTrackedHandoffRenderer,
    productionArchivedWorkItemReconciler,
  );
import {
  loadChangeContract as productionChangeContractReader,
  loadCommittedChangeContract as productionCommittedChangeContractReader,
} from './consumer-contract-production.ts';
import {
  resumeTask as resumeTaskWithContractReader,
  reviseTask as reviseTaskWithRouting,
} from '../application/revise/task-revision.ts';
export const resumeTask = resumeTaskWithContractReader.bind(
  undefined,
  productionPlanningExecution,
  managedDocuments,
  productionChangeContractReader,
  readAndValidateTaskRevisionApproval,
);
import {
  resolveOpenTaskId as resolveOpenTaskIdWithContractReader,
  contextualizeOpenTaskError as contextualizeOpenTaskErrorWithContractReader,
  findOpenTaskLifecycleStatus as findOpenTaskLifecycleStatusWithContractReader,
} from '../application/execute-task/open-task.ts';
export const resolveOpenTaskId = resolveOpenTaskIdWithContractReader.bind(
  undefined,
  productionChangeContractReader,
);

export const contextualizeOpenTaskError =
  contextualizeOpenTaskErrorWithContractReader.bind(
    undefined,
    productionChangeRoutingInspector,
    productionChangeContractReader,
  );

export const findOpenTaskLifecycleStatus =
  findOpenTaskLifecycleStatusWithContractReader.bind(
    undefined,
    productionChangeRoutingInspector,
    productionChangeContractReader,
  );
import { updateTaskSessionBase as updateTaskSessionBaseWithContractReader } from '../application/execute-task/update-base.ts';
export const updateTaskSessionBase =
  updateTaskSessionBaseWithContractReader.bind(
    undefined,
    verifyPullRequest,
    productionChangeRoutingInspector,
    {
      loadChangeContract: productionChangeContractReader,
      loadCommittedChangeContract: productionCommittedChangeContractReader,
    },
  );
import {
  commitPlanningTransition as commitPlanningTransitionWithContractReader,
  commitPlanAmendment as commitPlanAmendmentWithContractReader,
} from '../application/propose/planning-transition.ts';
export const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );

export const commitPlanAmendment = commitPlanAmendmentWithContractReader.bind(
  undefined,
  productionPlanningExecution,
  managedDocuments,
  productionChangeContractReader,
);
/**
 * Collects workflow lifecycle and authority services used by CLI command
 * handlers.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
// Production services used by the CLI command families.

export { discoverArchivePullRequestCandidates } from '../application/archive/archive-pr-orchestration.ts';
export type { GitHubArchiveAdapterModuleV1 } from '../application/archive/archive-pr-orchestration.ts';
export { inspectAuthorityPlan } from '../application/control-plane/authority-plan.ts';

export type { AuthorityPlanIntent } from '../application/control-plane/authority-plan.ts';
export { loadWorkflowConfig } from '../runtime/repository-observation/workflow-configuration.ts';
export { parseExecutionBudgetGrantRequest } from '../modules/authority/execution-governance-grant-contracts.ts';
export { externalEffectStorePaths } from '../runtime/storage-journal/external-effect-grant-store.ts';
export {
  revokeExternalEffectGrant,
  inspectExternalEffectGrant,
  reconcileExternalEffectGrant,
} from './external-effect-production.ts';
export { EXTERNAL_EFFECT_MAX_TTL_SECONDS } from '../modules/authority/external-effect-grant.ts';
export { issueExternalEffectGrant } from './external-effect-production.ts';
export type {
  ExternalEffectTarget,
  ExternalEffectRollbackPlan,
  ExternalEffectGrantRequest,
  ExternalEffectKind,
  ExternalEffectReconciliationRequest,
} from '../modules/authority/external-effect-grant.ts';
export { executePublishGrant } from './external-effect-production.ts';
export {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
export { assertMaintainerGrantId } from '../modules/authority/maintainer-grant-contracts.ts';
export {
  parseMaintainerEvidenceWaivers,
  type MaintainerEvidenceWaiver,
} from '../modules/authority/maintainer-grant-v2-codec.ts';
export type { MaintainerGrantV2PreflightRequest } from '../modules/authority/maintainer-grant-v2.ts';

export type { AuthorityAttestationRequest } from '../application/control-plane/maintainer-attestation.ts';
export {
  maintainerGrantStorePaths,
  inspectMaintainerGrants,
} from '../runtime/storage-journal/maintainer-store.ts';
export { assertInteractiveSignerContext } from '../adapters/signing/ssh/maintainer-signer.ts';
export { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import { revokeMaintainerGrantV2 as revokeMaintainerGrantV2WithAudit } from '../application/control-plane/maintainer-approve.ts';
import { withAuthorityRefusalAudit } from './authority-refusal-production.ts';
export const revokeMaintainerGrantV2 = revokeMaintainerGrantV2WithAudit.bind(
  undefined,
  createInteractiveSshSigner,
  withAuthorityRefusalAudit,
);

export type {
  ApproveAndApplyMaintainerGrantV2Request,
  ReissueAndApplyMaintainerGrantV2Request,
} from '../application/control-plane/maintainer-approve.ts';
export type { CandidateExternalEffect } from '../modules/authority/maintainer-candidate-contracts.ts';
import { produceControlPlaneApprovalCandidateV3 as produceControlPlaneApprovalCandidateWithArtifacts } from '../application/control-plane/control-plane-promotion-producer.ts';
import {
  readStoredImmutableCandidateBundle,
  assertStoredCandidateSupportingArtifacts,
} from '../runtime/storage-journal/maintainer-candidate-reader.ts';
export function produceControlPlaneApprovalCandidateV3(
  repositoryRoot: string,
  storageRoot: string,
  candidateId: string,
  dependencies: Omit<
    Parameters<typeof produceControlPlaneApprovalCandidateWithArtifacts>[3],
    'candidateArtifacts'
  >,
) {
  return produceControlPlaneApprovalCandidateWithArtifacts(
    repositoryRoot,
    storageRoot,
    candidateId,
    {
      ...dependencies,
      candidateArtifacts: {
        readStoredImmutableCandidateBundle,
        assertStoredCandidateSupportingArtifacts,
      },
    },
  );
}
export {
  inspectHumanResolutionGrantPublicationRecoveries,
  inspectHumanResolutionGrants,
  discardHumanResolutionGrantPublication,
  revokeHumanResolutionGrant,
} from './investigation-retry-production.ts';
export { inspectInvestigationQuarantineState } from '../runtime/storage-journal/human-resolution-state.ts';
export { runtimePaths } from '../runtime/session-workspace/session-store.ts';
export {
  prepareTaskRevisionApprovalBinding,
  inspectTaskRevisionStatus,
} from '../application/revise/task-revision.ts';
export {
  resumeDirectHumanTaskDiffReview,
  inspectTaskDiffReviewSubject,
  inspectTaskDiffReviewStatus,
  reconcileTaskDiffReview,
  reconcileExternalTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
  beginTaskDiffReviewContinuationFromInput,
  submitExternalTaskDiffReview,
  loadCurrentAuthenticatedTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
  beginTaskDiffReview,
} from './task-diff-review-production.ts';
export { issueTaskRevisionApproval } from './task-revision-approval-production.ts';
export { parseTaskMandateRequest } from '../modules/authority/task-mandate-records.ts';
export const {
  inspectActiveTaskMandateBinding,
  authorizeTaskMandate,
  inspectTaskMandate,
  revokeTaskMandate,
} = taskMandateOperations;
export { workflowGuidanceUsageLines } from '../modules/guidance/next-steps/workflow-guidance.ts';
export { assertProtectedTaskApplyRecoveryGrantRequiredDetails } from '../modules/authority/protected-task-apply-recovery-grant.ts';
export type { ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 } from '../modules/authority/protected-task-apply-recovery-grant.ts';
export { assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails } from '../modules/authority/protected-task-apply-descendant-settlement-grant.ts';
export type { ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 } from '../modules/authority/protected-task-apply-descendant-settlement-grant.ts';
export type {
  WorkItemReviewV1,
  WorkRegistryGrantRequiredDetailsV1,
} from './work-registry-production.ts';
export { parseChangeRoutingIntent } from '../modules/lifecycle/change-routing.ts';
export { observeChangeRoutingContinuationState } from '../runtime/repository-observation/change-routing.ts';

export { openTask } from './open-task-production.ts';
export { inspectGovernanceIntakeCounts } from './governance-findings-production.ts';
export { findTaskCommits } from '../application/finalize/lifecycle.ts';
export {
  inspectFinalizeRecoveryStatus,
  cancelFinalizeRecovery,
} from './finalization-production.ts';

export {
  getSession,
  listSessions,
} from '../application/execute-task/session.ts';
export { abortSession } from './task-session-production.ts';

export { resumeTaskStrategy } from './task-strategy-production.ts';
export type { TaskStrategyLifecycleStatus } from '../application/execute-task/task-strategy-lifecycle.ts';
export { parseTaskStrategyRedRevisionRequest } from '../runtime/storage-journal/task-strategy-red-revision-store.ts';
export { createTaskDiffReviewChallengeResponse } from '../modules/assurance/task-diff-review-artifact.ts';

export {
  resumeProposeFromFile,
  startProposeFromFile,
  getProposeStatus,
} from './propose-production.ts';
export { readProviderInvocation } from '../runtime/storage-journal/provider-invocation-store.ts';
export {
  parseTaskDiffReviewChallengeResponseInput,
  parseTaskDiffReviewExternalSubmissionInput,
  parseTaskDiffReviewExternalClosureRequestInput,
} from '../modules/assurance/task-diff-review-input.ts';
export type {
  TaskDiffReviewChallengeResponseInput,
  TaskDiffReviewExternalSubmissionInput,
  TaskDiffReviewExternalClosureRequestInput,
} from '../modules/assurance/task-diff-review-input.ts';

export const reviseTask = reviseTaskWithRouting.bind(
  undefined,
  productionChangeRoutingAdmissionReader,
);
import { commitSession as commitSessionWithRouting } from '../application/finalize/lifecycle.ts';
export const commitSession = commitSessionWithRouting.bind(
  undefined,
  productionChangeRoutingAdmissionReader,
);
import {
  preflightTaskSession as preflightTaskSessionWithRouting,
  checkSession as checkSessionWithRouting,
} from '../application/execute-task/session.ts';
export const preflightTaskSession = preflightTaskSessionWithRouting.bind(
  undefined,
  productionChangeRoutingAdmissionReader,
);

export function createProductionSessionCheck(
  readers: LocalEngineSelectionReaders,
) {
  return checkSessionWithRouting.bind(
    undefined,
    reviewedGeneratedAssets,
    readers,
    maintainerManifestOperations,
    productionTaskStrategyExecutionGate,
    productionChangeRoutingAdmissionReader,
  );
}
export { inspectTaskStrategyLifecycle } from './task-strategy-production.ts';

import type { LocalEngineSelectionReaders } from './finalization-production.ts';
export type {
  LocalEngineSelectionReaders,
  ProductionFinalizationService,
} from './finalization-production.ts';
export type ProductionSessionCheck = ReturnType<
  typeof createProductionSessionCheck
>;
