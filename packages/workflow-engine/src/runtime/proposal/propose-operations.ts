import { createProposePublication } from './propose-publication.ts';
import { createProposeContext } from './propose-context.ts';
import { createPlanningStore } from './propose-planning-store.ts';
import { createInvestigationFacts } from './propose-investigation-facts.ts';
import { createReviewerTerms } from './propose-reviewer-terms.ts';
import { createBlindSurveyAdmission } from './propose-blind-survey-admission.ts';
import { createInvestigationRebuild } from './propose-investigation-rebuild.ts';
import { createPlanReviewStore } from './plan-review-store.ts';
import { createProposeStatus } from './propose-status.ts';
import { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import { createPlanReviewResults } from './plan-review-result.ts';
import { createPlanReviewCompletion } from './plan-review-completion.ts';
import { createPlanReviewPreparation } from './plan-review-preparation.ts';
import { createPlanReviewRetry } from './plan-review-retry.ts';
import { createPlanningMaterialization } from './propose-planning-materialization.ts';
import { createProposeStart } from './propose-start.ts';
import { createReviewerReconciliation } from './propose-reviewer-reconciliation.ts';
import { createProposeResumption } from './propose-resume.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import type {
  ProposeOptions,
  OrdinaryProposeOutput,
  InvestigationExemptionRequest,
  ExemptionProposeOutput,
  ProposeOutput,
  PlanningContributionEnvelope,
  ProviderProgressEnvelope,
  ProviderRetryEnvelope,
  ProposeResumeOptions,
  ExemptionPlanningContributionEnvelope,
  PlanReviewRetryEnvelope,
  PlanReviewProgressEnvelope,
  PlanReviewDispositionsEnvelope,
} from '../../modules/proposal/propose-types.ts';

import type {
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
} from '../../modules/investigation/domain/investigation-session-types.ts';

import { createScanSaturationAcceptanceEnvelope as createScanSaturationAcceptanceEnvelopeOperation } from '../../modules/proposal/propose-input.ts';
import { createProviderRetryEnvelope as createProviderRetryEnvelopeOperation } from './propose-provider-lifecycle.ts';
import { createPlanReviewRetryEnvelope as createPlanReviewRetryEnvelopeOperation } from './plan-review-retry.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';

import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import type { InvestigationManifestV3 } from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import { publishTrackedInvestigationManifestV3 as publishTrackedInvestigationManifestV3Operation } from './propose-publication.ts';
import type { PlanReviewGrantRequirement } from '../../modules/proposal/plan-review-contracts.ts';
import { readCurrentRoleContextSharingPlanReviewRequirement as readCurrentRoleContextSharingPlanReviewRequirementOperation } from './plan-review-store.ts';

export function createProposeOperations(decisions: ProposeDecisionServices) {
  const loadChangeContract = decisions.loadChangeContract.bind(decisions);
  const managedDocuments = decisions.managedDocuments;
  const planningAssurance = decisions.planningAssurance;
  const planningEvidence = decisions.planningEvidence;
  const readProviderRetryAccountingEvidence =
    decisions.readProviderRetryAccountingEvidence.bind(decisions);
  const roleAdmission = decisions.roleAdmission;
  const roleContextSharingGrants = decisions.roleContextSharingGrants;
  const taskMandate = decisions.taskMandate;
  const withTaskRevisionPlanningOperation =
    decisions.withTaskRevisionPlanningOperation.bind(decisions);
  const workRegistryOwner = decisions.workRegistry;
  const workRegistry: ProposeDecisionServices['workRegistry'] = {
    ensureWorkItemPromotionChangeDirectory:
      workRegistryOwner.ensureWorkItemPromotionChangeDirectory.bind(
        workRegistryOwner,
      ),
    linkSourceToChange:
      workRegistryOwner.linkSourceToChange.bind(workRegistryOwner),
    readCurrentChangeOrigin:
      workRegistryOwner.readCurrentChangeOrigin.bind(workRegistryOwner),
  };
  const investigationEvidenceOwner = decisions.investigationEvidence;
  const investigationEvidence: ProposeDecisionServices['investigationEvidence'] =
    {
      readPinnedPathDiff: investigationEvidenceOwner.readPinnedPathDiff.bind(
        investigationEvidenceOwner,
      ),
      scanInvestigationTreeFacts:
        investigationEvidenceOwner.scanInvestigationTreeFacts.bind(
          investigationEvidenceOwner,
        ),
      materializeInvestigationEvidenceView:
        investigationEvidenceOwner.materializeInvestigationEvidenceView.bind(
          investigationEvidenceOwner,
        ),
    };
  const sourcesOwner = decisions.sources;
  const sources: ProposeDecisionServices['sources'] = {
    readGovernanceSource: sourcesOwner.readGovernanceSource.bind(sourcesOwner),
    captureGovernanceSource:
      sourcesOwner.captureGovernanceSource.bind(sourcesOwner),
  };
  const planningWorkspaceOwner = decisions.planningWorkspace;
  const planningWorkspace: ProposeDecisionServices['planningWorkspace'] = {
    preparePlanningDraftWorkspace:
      planningWorkspaceOwner.preparePlanningDraftWorkspace.bind(
        planningWorkspaceOwner,
      ),
    readPlanningDraftWorkspace:
      planningWorkspaceOwner.readPlanningDraftWorkspace.bind(
        planningWorkspaceOwner,
      ),
    inspectPlanningDraftWorkspace:
      planningWorkspaceOwner.inspectPlanningDraftWorkspace.bind(
        planningWorkspaceOwner,
      ),
  };
  const semanticLedgerOwner = decisions.semanticLedger;
  const semanticLedger: ProposeDecisionServices['semanticLedger'] = {
    readLedgerEntry:
      semanticLedgerOwner.readLedgerEntry.bind(semanticLedgerOwner),
    readLedgerIndex:
      semanticLedgerOwner.readLedgerIndex.bind(semanticLedgerOwner),
  };
  const parsePlanReviewArtifact =
    decisions.parsePlanReviewArtifact.bind(decisions);
  const reviewedGeneratedAssets =
    decisions.planningProvider.reviewedGeneratedAssets;
  const createInteractiveSshSigner =
    decisions.createInteractiveSshSigner.bind(decisions);
  const captureInvestigationV3DirectFailureEmission =
    decisions.failureObservations.captureInvestigationV3DirectFailureEmission.bind(
      decisions.failureObservations,
    );
  const acknowledgePolicyLoader = decisions.loadMaintainerPolicyForResolution;
  const planReviewRetryBlocker =
    decisions.createInvestigationHumanActionBlocker;
  const reviewerTermBlocker = decisions.createInvestigationHumanActionBlocker;
  const inspectReviewerPolicyLoader =
    decisions.loadMaintainerPolicyForResolution;
  const reopenReviewerPolicyLoader =
    decisions.loadMaintainerPolicyForResolution;
  const retryTaskMandate = decisions.taskMandate;
  const retryAccounting = decisions.readProviderRetryAccountingEvidence;
  const startTaskMandate = decisions.taskMandate;
  const createPlanningAuthoringPort: ProposeDecisionServices['planningProvider']['createAuthoringPort'] =
    (repositoryRoot) =>
      decisions.planningProvider.createAuthoringPort(repositoryRoot);
  const readPlanningAssetMirrors: ProposeDecisionServices['planningProvider']['reviewedAssetMirrors'] =
    (repositoryRoot) =>
      decisions.planningProvider.reviewedAssetMirrors(repositoryRoot);
  const proposalPublication = createProposePublication({
    captureInvestigationV3DirectFailureEmission,
    createPlanningAuthoringPort,
    investigationEvidence,
    roleContextSharingGrants,
  });
  const proposalContext = createProposeContext({
    planningWorkspace,
    sources,
    withTaskRevisionPlanningOperation,
    workRegistry,
  });
  const planningStore = createPlanningStore({
    createPlanningAuthoringPort,
    investigationEvidence,
    roleContextSharingGrants,
    assertCurrentGovernanceSources:
      proposalContext.assertCurrentGovernanceSources,
  });
  const investigationFacts = createInvestigationFacts({
    readPlanningAssetMirrors,
    semanticLedger,
  });
  const reviewerTerms = createReviewerTerms({ planningEvidence });
  const blindSurveyAdmission = createBlindSurveyAdmission({ roleAdmission });
  const investigationRebuild = createInvestigationRebuild({
    investigationEvidence,
    reviewedGeneratedAssets,
    semanticLedger,
    createBlindSurveyRoleResult:
      blindSurveyAdmission.createBlindSurveyRoleResult,
    deriveReviewedAssetRelationships:
      investigationFacts.deriveReviewedAssetRelationships,
    investigationKnowledgeCarries:
      investigationFacts.investigationKnowledgeCarries,
    readReviewerTermSource: reviewerTerms.readReviewerTermSource,
  });
  const planReviewStore = createPlanReviewStore({
    parsePlanReviewArtifact,
    planningEvidence,
    roleAdmission,
  });
  const proposalStatus = createProposeStatus({
    prepareExemptionPlanningScaffold:
      proposalPublication.prepareExemptionPlanningScaffold,
    preparePlanningScaffold: proposalPublication.preparePlanningScaffold,
    readMaterializedExemptionPlanningArtifacts:
      planningStore.readMaterializedExemptionPlanningArtifacts,
    readMaterializedPlanningArtifacts:
      planningStore.readMaterializedPlanningArtifacts,
    readTrackedPlanReview: planReviewStore.readTrackedPlanReview,
    rebuildInvestigation: investigationRebuild.rebuildInvestigation,
    resolveProposePlanningWorkspaceForInvestigation:
      proposalContext.resolveProposePlanningWorkspaceForInvestigation,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
  });
  const providerLifecycle = createProposeProviderLifecycle({
    retryAccounting,
    retryTaskMandate,
    taskMandate,
    getProposeStatus: proposalStatus.getProposeStatus,
  });
  const planReviewResults = createPlanReviewResults({
    acknowledgePolicyLoader,
    inspectReviewerPolicyLoader,
    planningEvidence,
    reopenReviewerPolicyLoader,
    reviewerTermBlocker,
    roleAdmission,
    readTrackedPlanReview: planReviewStore.readTrackedPlanReview,
    rebuildInvestigation: investigationRebuild.rebuildInvestigation,
    writeTrackedPlanReview: planReviewStore.writeTrackedPlanReview,
  });
  const planReviewCompletion = createPlanReviewCompletion({
    createInteractiveSshSigner,
    loadChangeContract,
    managedDocuments,
    planningEvidence,
    dispatchMandatedProviderInvocation:
      providerLifecycle.dispatchMandatedProviderInvocation,
    getProposeStatus: proposalStatus.getProposeStatus,
    getProposeStatusInternal: proposalStatus.getProposeStatusInternal,
    materializePlanReviewResult: planReviewResults.materializePlanReviewResult,
    readTrackedPlanReview: planReviewStore.readTrackedPlanReview,
    renderProposeOutputWithPlanningAuthority:
      proposalStatus.renderProposeOutputWithPlanningAuthority,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
    writeTrackedPlanReview: planReviewStore.writeTrackedPlanReview,
  });
  const planReviewPreparation = createPlanReviewPreparation({
    roleAdmission,
    roleContextSharingGrants,
    taskMandate,
  });
  const planReviewRetry = createPlanReviewRetry({
    planReviewRetryBlocker,
    readProviderRetryAccountingEvidence,
    taskMandate,
    authorizePlanReviewReservationMandate:
      planReviewPreparation.authorizePlanReviewReservationMandate,
    dispatchPreparedPlanReview: providerLifecycle.dispatchPreparedPlanReview,
    getProposeStatus: proposalStatus.getProposeStatus,
    readTrackedPlanReview: planReviewStore.readTrackedPlanReview,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
  });
  const planningMaterialization = createPlanningMaterialization({
    createPlanningAuthoringPort,
    planningAssurance,
    assertCurrentGovernanceSources:
      proposalContext.assertCurrentGovernanceSources,
    prepareExemptionPlanningScaffold:
      proposalPublication.prepareExemptionPlanningScaffold,
    preparePlanningScaffold: proposalPublication.preparePlanningScaffold,
    preparePlanReviewInvocation:
      planReviewPreparation.preparePlanReviewInvocation,
  });
  const proposalStart = createProposeStart({
    roleAdmission,
    startTaskMandate,
    taskMandate,
    assertCurrentGovernanceSources:
      proposalContext.assertCurrentGovernanceSources,
    dispatchMandatedProviderInvocation:
      providerLifecycle.dispatchMandatedProviderInvocation,
    dispatchPreparedPlanReview: providerLifecycle.dispatchPreparedPlanReview,
    getExemptionProposeStatus: proposalStatus.getExemptionProposeStatus,
    materializeExemptionPlanningContribution:
      planningMaterialization.materializeExemptionPlanningContribution,
    prepareExemptionPlanningScaffold:
      proposalPublication.prepareExemptionPlanningScaffold,
    renderExemptionProposeOutput: proposalStatus.renderExemptionProposeOutput,
    renderProposeOutputWithPlanningAuthority:
      proposalStatus.renderProposeOutputWithPlanningAuthority,
    resolveImmediateSource: proposalContext.resolveImmediateSource,
    resolveProposePlanningWorkspace:
      proposalContext.resolveProposePlanningWorkspace,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
  });
  const reviewerReconciliation = createReviewerReconciliation({
    planningAssurance,
    dispatchPreparedPlanReview: providerLifecycle.dispatchPreparedPlanReview,
    getProposeStatus: proposalStatus.getProposeStatus,
    preparePlanningScaffold: proposalPublication.preparePlanningScaffold,
    preparePlanReviewInvocation:
      planReviewPreparation.preparePlanReviewInvocation,
    rebuildInvestigation: investigationRebuild.rebuildInvestigation,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
  });
  const proposalResumption = createProposeResumption({
    buildWhyAuthoringFromCheckpoint:
      investigationFacts.buildWhyAuthoringFromCheckpoint,
    completePlanReviewDispositions:
      planReviewCompletion.completePlanReviewDispositions,
    dispatchPreparedInvocation: providerLifecycle.dispatchPreparedInvocation,
    dispatchPreparedPlanReview: providerLifecycle.dispatchPreparedPlanReview,
    getProposeStatus: proposalStatus.getProposeStatus,
    materializePlanningContribution:
      planningMaterialization.materializePlanningContribution,
    rebuildInvestigation: investigationRebuild.rebuildInvestigation,
    reconcileReviewerTermPlanningRevision:
      reviewerReconciliation.reconcileReviewerTermPlanningRevision,
    renderProposeOutput: proposalStatus.renderProposeOutput,
    renderProposeOutputWithPlanningAuthority:
      proposalStatus.renderProposeOutputWithPlanningAuthority,
    resolveProposePlanningWorkspace:
      proposalContext.resolveProposePlanningWorkspace,
    resumeExemptionPlanningContribution:
      proposalStart.resumeExemptionPlanningContribution,
    resumeInvestigationForPropose:
      proposalContext.resumeInvestigationForPropose,
    resumePlanReview: planReviewCompletion.resumePlanReview,
    resumePlanReviewRetry: planReviewRetry.resumePlanReviewRetry,
    resumeProviderRetry: providerLifecycle.resumeProviderRetry,
    withProposeTransitionAuthority:
      proposalContext.withProposeTransitionAuthority,
  });
  function startPropose(
    cwd: string,
    requestedChangeId: string,
    intentInput: NormalizedChangeIntent,
    options?: ProposeOptions,
  ): OrdinaryProposeOutput;

  function startPropose(
    cwd: string,
    requestedChangeId: string,
    intentInput: InvestigationExemptionRequest,
    options?: ProposeOptions,
  ): ExemptionProposeOutput;

  function startPropose(
    cwd: string,
    requestedChangeId: string,
    intentInput: unknown,
    options?: ProposeOptions,
  ): ProposeOutput;

  function startPropose(
    cwd: string,
    requestedChangeId: string,
    intentInput: unknown,
    options: ProposeOptions = {},
  ): ProposeOutput {
    return proposalStart.startPropose(
      cwd,
      requestedChangeId,
      intentInput,
      options,
    );
  }

  function resumePropose(
    cwd: string,
    requestedChangeId: string,
    inputValue:
      | InvestigationCheckpointEnvelope
      | InvestigationScanSaturationAcceptanceEnvelope
      | PlanningContributionEnvelope
      | ProviderProgressEnvelope
      | ProviderRetryEnvelope,
    options?: ProposeResumeOptions,
  ): OrdinaryProposeOutput;

  function resumePropose(
    cwd: string,
    requestedChangeId: string,
    inputValue: ExemptionPlanningContributionEnvelope,
    options?: ProposeResumeOptions,
  ): ExemptionProposeOutput;

  function resumePropose(
    cwd: string,
    requestedChangeId: string,
    inputValue:
      | PlanReviewRetryEnvelope
      | PlanReviewProgressEnvelope
      | PlanReviewDispositionsEnvelope,
    options?: ProposeResumeOptions,
  ): ProposeOutput;

  function resumePropose(
    cwd: string,
    requestedChangeId: string,
    inputValue: unknown,
    options?: ProposeResumeOptions,
  ): ProposeOutput;

  function resumePropose(
    cwd: string,
    requestedChangeId: string,
    inputValue: unknown,
    options: ProposeResumeOptions = {},
  ): ProposeOutput {
    return proposalResumption.resumePropose(
      decisions.planningExecution,
      cwd,
      requestedChangeId,
      inputValue,
      options,
    );
  }

  function createScanSaturationAcceptanceEnvelope(
    output: ProposeOutput,
  ): InvestigationScanSaturationAcceptanceEnvelope {
    return createScanSaturationAcceptanceEnvelopeOperation(output);
  }

  function createProviderRetryEnvelope(
    cwd: string,
    output: ProposeOutput,
    acknowledgement: { acknowledgeProviderCost: true },
  ): ProviderRetryEnvelope {
    return createProviderRetryEnvelopeOperation(cwd, output, acknowledgement);
  }

  function createPlanReviewRetryEnvelope(
    cwd: string,
    output: ProposeOutput,
    acknowledgement: { acknowledgeProviderCost: true },
  ): PlanReviewRetryEnvelope {
    return createPlanReviewRetryEnvelopeOperation(cwd, output, acknowledgement);
  }

  function completeInterruptedPlanReviewReplacement(
    cwd: string,
    input: {
      investigationId: string;
      changeId: string;
      replacementRequest: ProviderInvocationRequest;
      failedInvocationId: string;
      executionGrantId: string;
    },
  ): { published: boolean } {
    return planReviewRetry.completeInterruptedPlanReviewReplacement(cwd, input);
  }

  function startProposeFromFile(
    cwd: string,
    changeId: string,
    intentPath: string,
    options: ProposeOptions = {},
  ): ProposeOutput {
    return proposalStart.startProposeFromFile(
      cwd,
      changeId,
      intentPath,
      options,
    );
  }

  function resumeProposeFromFile(
    cwd: string,
    changeId: string,
    inputPath: string,
    options: ProposeResumeOptions = {},
  ): ProposeOutput {
    return proposalResumption.resumeProposeFromFile(
      decisions.planningExecution,
      cwd,
      changeId,
      inputPath,
      options,
    );
  }

  function getProposeStatus(
    cwd: string,
    requestedInvestigationId: string,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ProposeOutput {
    return proposalStatus.getProposeStatus(
      cwd,
      requestedInvestigationId,
      grantValidation,
    );
  }

  function publishTrackedInvestigationManifestV3(input: {
    context: ReturnType<typeof loadInvestigationRuntimeContext>;
    manifest: InvestigationManifestV3;
    assertOwned: () => void;
    assertCurrent: () => void;
  }): void {
    return publishTrackedInvestigationManifestV3Operation(input);
  }

  function readCurrentRoleContextSharingPlanReviewRequirement(
    cwd: string,
    requirementNodeId: string,
  ): Extract<PlanReviewGrantRequirement, { kind: 'role-context-sharing' }> {
    return readCurrentRoleContextSharingPlanReviewRequirementOperation(
      cwd,
      requirementNodeId,
    );
  }

  return {
    startPropose,
    resumePropose,
    createScanSaturationAcceptanceEnvelope,
    createProviderRetryEnvelope,
    createPlanReviewRetryEnvelope,
    completeInterruptedPlanReviewReplacement,
    startProposeFromFile,
    resumeProposeFromFile,
    getProposeStatus,
    publishTrackedInvestigationManifestV3,
    readCurrentRoleContextSharingPlanReviewRequirement,
  };
}

export type ProposeOperations = ReturnType<typeof createProposeOperations>;
export {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  createProviderProgressEnvelope,
} from '../../modules/proposal/propose-input.ts';
export type {
  ExemptionPlanningContributionEnvelope,
  ExemptionProposeOutput,
  InvestigationExemptionRequest,
  OrdinaryProposeOutput,
  PlanningContributionEnvelope,
  PlanningContributionPayload,
  PlanReviewDispositionsEnvelope,
  PlanReviewProgressEnvelope,
  PlanReviewReservation,
  PlanReviewRetryEnvelope,
  ProposeAssuranceAssessment,
  ProposeFullBlobWork,
  ProposeGroupWork,
  ProposeInput,
  ProposeOptions,
  ProposeOutput,
  ProposePlanReviewStatus,
  ProposeProviderDispatcher,
  ProposeProviderDriver,
  ProposeResumeOptions,
  ProposeStartInput,
  ProposeWork,
  ProviderProgressEnvelope,
  ProviderRetryEnvelope,
  RebuiltInvestigation,
} from '../../modules/proposal/propose-types.ts';
export { completeRoleContextSharingPlanReviewAdmission } from './plan-review-result.ts';
