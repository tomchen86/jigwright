import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { readAndValidateTaskRevisionApproval } from './task-revision-approval-production.ts';
export type { ControlPlanePromotionBootstrapObservations } from '../modules/authority/intervention-bootstrap-contract.ts';
import { verifyPullRequest } from './ci-verification-production.ts';

import { planningTransitionExecution as productionPlanningExecution } from './planning-execution-epoch-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';

import { managedDocuments } from './managed-documents-production.ts';
import { handoffDocuments } from './handoff-production.ts';
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
  productionChangeContract,
  productionPlanningExecution,
  managedDocuments,
  productionChangeContractReader,
  readAndValidateTaskRevisionApproval,
);
import {
  resolveOpenTaskId as resolveOpenTaskIdWithContractReader,
  contextualizeOpenTaskError as contextualizeOpenTaskErrorWithContractReader,
} from '../application/execute-task/open-task.ts';
export const resolveOpenTaskId = resolveOpenTaskIdWithContractReader.bind(
  undefined,
  productionChangeContractReader,
);

export const contextualizeOpenTaskError =
  contextualizeOpenTaskErrorWithContractReader.bind(
    undefined,
    handoffDocuments,
    productionChangeContractReader,
  );

import { updateTaskSessionBase as updateTaskSessionBaseWithContractReader } from '../application/execute-task/update-base.ts';
export const updateTaskSessionBase =
  updateTaskSessionBaseWithContractReader.bind(
    undefined,
    productionChangeContract,
    verifyPullRequest,
    handoffDocuments,
    {
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
 * - Production bindings fix workflow dependencies before CLI dispatch.
 */
// Production services used by the CLI command families.

export { discoverArchivePullRequestCandidates } from '../application/archive/archive-pr-orchestration.ts';
export type { GitHubArchiveAdapterModuleV1 } from '../application/archive/archive-pr-orchestration.ts';
export { inspectAuthorityPlan } from '../application/control-plane/authority-plan.ts';

export type { AuthorityPlanIntent } from '../application/control-plane/authority-plan.ts';
export { loadWorkflowConfig } from '../runtime/workflow-configuration/workflow-configuration.ts';
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
export { discoverRepository } from '../runtime/repository-transaction/git.ts';
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
import { prepareTaskRevisionApprovalBinding as prepareTaskRevisionApprovalBindingWithServices } from '../application/revise/task-revision.ts';
export const prepareTaskRevisionApprovalBinding =
  prepareTaskRevisionApprovalBindingWithServices.bind(
    undefined,
    productionChangeContract,
  );
export { resumeDirectHumanTaskDiffReview } from './task-diff-review-production.ts';
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
export { observeChangeRoutingContinuationState } from '../runtime/change-routing/routing-observation.ts';

export { parseTaskStrategyRedRevisionRequest } from '../runtime/storage-journal/task-strategy-red-revision-store.ts';
export { createTaskDiffReviewChallengeResponse } from '../modules/assurance/task-diff-review-artifact.ts';

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
  productionChangeContract,
);
import { commitSession as commitSessionWithRouting } from '../application/finalize/lifecycle.ts';
export const commitSession = commitSessionWithRouting.bind(
  undefined,
  productionChangeContract,
);
import { preflightTaskSession as preflightTaskSessionWithRouting } from '../application/execute-task/session.ts';
export const preflightTaskSession = preflightTaskSessionWithRouting.bind(
  undefined,
  productionChangeContract,
);
