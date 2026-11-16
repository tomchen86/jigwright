/** Bind the package lifecycle and Grant services. */
import { createProductionFinalizationService } from '../src/composition-root/finalization-production.ts';
import { createProductionSessionCheckService } from '../src/composition-root/session-check-production.ts';
import { createProductionWorkflowGrantServices } from '../src/composition-root/grant-production.ts';
import { createArchivePullRequestCliDependencies } from '../src/composition-root/archive-cli-production.ts';
export const sessionLifecycle = {
  ...createProductionFinalizationService(),
  checkSession: createProductionSessionCheckService().checkSession,
};
export const {
  rollbackCompletion,
  recoverFinalize,
  finalizeSession,
  finalizeProtectedTaskApplyUnderGrant,
  finalizeTask,
  completeTask,
  finishSession,
  checkSession,
} = sessionLifecycle;
export const workflowGrantServices = createProductionWorkflowGrantServices(
  finalizeProtectedTaskApplyUnderGrant,
);
export const archiveDependencies = createArchivePullRequestCliDependencies(
  workflowGrantServices.requestArchivePullRequestPublicationGrant,
);
export const {
  createProductionWorkflowGrantCoordinator,
  createProductionCentralGrantRequestPort,
  requestProtectedTaskApplyGrant,
  requestProtectedTaskApplyRecoveryGrant,
  requestProtectedTaskApplyDescendantSettlementGrant,
  requestProviderInvocationCancellationGrant,
  requestChangeRoleAssignmentGrant,
  requestProtectedBaseInitializationGrant,
  requestArchivePullRequestPublicationGrant,
  requestWorkRegistryReviewGrant,
  requestWorkRegistryPromotionGrant,
  requestChangeRoutingContinuationGrant,
  requestInvestigationV3Grant,
  requestInvestigationV3PublicationGrant,
  propagateInvestigationV3PublicationResult,
} = workflowGrantServices;
