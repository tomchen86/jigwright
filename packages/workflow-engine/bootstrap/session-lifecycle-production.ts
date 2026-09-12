/** Bind fresh local-engine observations to the required lifecycle and Grant services. */
import { bootstrapInterventionStateRoot } from './control-plane-bootstrap-files.ts';
import { resolveLocalEngineSelection } from './control-plane-bootstrap-local.ts';
import {
  createProductionFinalizationService,
  type LocalEngineSelectionReaders,
} from '../src/composition-root/finalization-production.ts';
import { createProductionSessionCheck } from '../src/composition-root/cli-command-services.ts';
import { createProductionWorkflowGrantServices } from '../src/composition-root/grant-production.ts';
import { createArchivePullRequestCliDependencies } from '../src/composition-root/archive-cli-production.ts';
export const localEngineSelectionReaders: LocalEngineSelectionReaders = {
  bootstrapInterventionStateRoot,
  resolveLocalEngineSelection,
};
export const sessionLifecycle = {
  ...createProductionFinalizationService(localEngineSelectionReaders),
  checkSession: createProductionSessionCheck(localEngineSelectionReaders),
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
