/**
 * Exposes the proposal API and binds its workflows to the repository runtime.
 *
 * Invariants:
 * - Public signatures and result shapes remain compatible with existing callers.
 * - Dependency assembly performs no reads, writes, or authority acquisition.
 * - Each workflow receives the same runtime operations throughout its execution.
 */
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import {
  loadChecksConfig,
  loadWorkflowConfig,
} from '../../runtime/workflow-configuration/workflow-configuration.ts';
import { parseCurrentInvestigationManifest } from '../../runtime/repository-validation/change-contract-reader.ts';
import {
  parseExecutionArtifact,
  parseTasks,
} from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { assertTaskMandateOptional } from '../../runtime/repository-observation/task-authorization-policy.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import {
  acknowledgeReviewerTermInputClosureUnderAuthority,
  blockInvestigationForPlanReviewRetryUnderAuthority,
  blockInvestigationForReviewerTermsUnderAuthority,
  getInvestigationStatus,
  inspectReviewerTermResolutionAuthorization,
  reopenInvestigationForReviewerTermsUnderAuthority,
  resumeInvestigationSessionUnderAuthority,
  retryInvestigationProvider,
  startInvestigationSessionUnderLifecycleLock,
} from '../../runtime/investigation-lifecycle/investigation-session.ts';
import { decideReviewerTermReopen } from '../../modules/investigation/domain/reviewer-term-reopen.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import type { InvestigationManifestV3 } from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  inspectInvestigationManifestPublication,
  investigationManifestPublicationGitStateDigest,
  investigationManifestPublicationStateDigest,
  observeInvestigationManifestPublicationState,
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
} from '../../runtime/managed-documents/transaction/investigation-publication.ts';
import {
  assertInvestigationManifestPublicationFailure,
  investigationManifestPublicationFailureEmissionDigest,
  investigationManifestPublicationNamespace,
} from '../../modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  loadAiAdapterPolicy,
} from '../../runtime/provider-policy/ai-adapter-policy.ts';
import {
  loadProviderExecutionRepairContext,
  preflightProviderRepairRetry,
} from '../../runtime/storage-journal/provider-execution-governance.ts';
import { replaceTextAtomic } from '../../runtime/repository-transaction/atomic-text.ts';
import {
  discoverRepository,
  resolveProtectedBaseRef,
  readFileAtCommit,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { readPinnedTrackedTree } from '../../runtime/repository-transaction/tracked-tree-reader.ts';
import {
  assertChangeId,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import { withInvestigationTransitionAuthority } from '../../runtime/session-workspace/planning-lock.ts';
import {
  consumeCollaborationGrant,
  consumeCollaborationGrantUnderLifecycleLock,
  readExactConsumedCollaborationGrantUse,
} from '../../runtime/storage-journal/collaboration-grant-consumption.ts';
import { reserveCollaborationGrantUnderLifecycleLock } from '../../runtime/storage-journal/collaboration-grant-reservation.ts';
import {
  compareAndSwapEvidenceRef,
  computeInvestigationEvidenceRefsClosure,
  readEvidenceNode,
  readEvidenceRefs,
  writeEvidenceNode,
} from '../../runtime/storage-journal/evidence-object-store.ts';
import {
  assertInvestigationCheckpointEnvelope,
  assertInvestigationScanSaturationAcceptanceEnvelope,
  checkpointContributionDigest,
  scanSaturationAcceptanceEnvelopeDigest,
} from '../../modules/investigation/domain/investigation-checkpoint-contract.ts';
import {
  compareAndSwapInvestigationSession,
  readCurrentInvestigationRef,
  readInvestigationSession,
} from '../../runtime/storage-journal/investigation-session-records.ts';
import { readHumanResolutionNode } from '../../runtime/storage-journal/human-resolution-nodes.ts';
import type {
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import {
  clearInvestigationV3FailureObservation,
  writeInvestigationV3FailureObservation,
  writeInvestigationV3PublicationFailureObservation,
} from '../../runtime/storage-journal/investigation-v3-failure-store.ts';
import {
  createProposeExemptionSession,
  isProposeExemptionInvestigationId,
  readCurrentProposeExemptionSession,
  readProposeExemptionSession,
  retireCurrentProposeExemptionSession,
} from '../../runtime/storage-journal/propose-exemption-store.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  createProviderExecutionPolicySnapshot,
  createProviderInvocation,
  ensureProviderExecutionPolicySnapshot,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  providerInvocationExists,
  providerInvocationManifestDigest,
  readBlindSurveyManifest,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  readProviderRetryReservation,
  storeProviderExecutionPolicySnapshot,
  validateProviderExecutionPolicySnapshot,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import type { PlanReviewGrantRequirement } from './plan-review-contracts.ts';
import {
  completeInterruptedPlanReviewReplacement as completeInterruptedPlanReviewReplacementOperation,
  createPlanReviewRetryEnvelope as createPlanReviewRetryEnvelopeOperation,
} from './plan-review-retry.ts';
import { readCurrentRoleContextSharingPlanReviewRequirement as readCurrentRoleContextSharingPlanReviewRequirementOperation } from './plan-review-store.ts';
import { createProviderRetryEnvelope as createProviderRetryEnvelopeOperation } from './propose-provider-lifecycle.ts';
import { publishTrackedInvestigationManifestV3 as publishTrackedInvestigationManifestV3Operation } from './propose-publication.ts';
import { createScanSaturationAcceptanceEnvelope as createScanSaturationAcceptanceEnvelopeOperation } from '../../modules/proposal/propose-input.ts';
import {
  resumeProposeFromFile as resumeProposeFromFileOperation,
  resumePropose as resumeProposeOperation,
} from './propose-resume.ts';
import {
  startProposeFromFile as startProposeFromFileOperation,
  startPropose as startProposeOperation,
} from './propose-start.ts';
import { getProposeStatus as getProposeStatusOperation } from './propose-status.ts';
import type {
  ExemptionPlanningContributionEnvelope,
  ExemptionProposeOutput,
  InvestigationExemptionRequest,
  OrdinaryProposeOutput,
  PlanningContributionEnvelope,
  PlanReviewDispositionsEnvelope,
  PlanReviewProgressEnvelope,
  PlanReviewRetryEnvelope,
  ProposeOptions,
  ProposeOutput,
  ProposeResumeOptions,
  ProviderProgressEnvelope,
  ProviderRetryEnvelope,
} from '../../modules/proposal/propose-types.ts';
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

function createProposeRuntime(decisions: ProposeDecisionServices) {
  return {
    ...decisions,
    workspace: {
      ...decisions.workRegistry,
      ...decisions.investigationEvidence,
      readGovernanceSource: decisions.sources.readGovernanceSource,
      captureGovernanceSource: decisions.sources.captureGovernanceSource,
      loadChecksConfig,
      loadWorkflowConfig,
      parseCurrentInvestigationManifest,
      parseExecutionArtifact,
      parsePlanReviewArtifact: decisions.parsePlanReviewArtifact,
      parseTasks,
      assertTaskMandateOptional,
      loadInvestigationRuntimeContext,
      reviewedGeneratedAssets:
        decisions.planningProvider.reviewedGeneratedAssets,
      replaceTextAtomic,
      discoverRepository,
      resolveProtectedBaseRef,
      readFileAtCommit,
      runGit,
      readPinnedTrackedTree,
      assertChangeId,
      normalizePolicyPath,
      withInvestigationTransitionAuthority,
      ...decisions.planningWorkspace,
      ...decisions.semanticLedger,
      planningProviderAuthoring: (
        context: ReturnType<typeof loadInvestigationRuntimeContext>,
      ) =>
        decisions.planningProvider.createAuthoringPort(
          context.git.repositoryRoot,
        ),
      planningProviderReviewedAssetMirrors: (
        context: ReturnType<typeof loadInvestigationRuntimeContext>,
      ) =>
        decisions.planningProvider.reviewedAssetMirrors(
          context.git.repositoryRoot,
        ),
    },
    evidence: {
      assertStoredEvidenceNode,
      createEvidenceNode,
      compareAndSwapEvidenceRef,
      computeInvestigationEvidenceRefsClosure,
      readEvidenceNode,
      readEvidenceRefs,
      writeEvidenceNode,
    },
    investigation: {
      acknowledgeReviewerTermInputClosureUnderAuthority:
        acknowledgeReviewerTermInputClosureUnderAuthority.bind(
          undefined,
          decisions.loadMaintainerPolicyForResolution,
        ),
      blockInvestigationForPlanReviewRetryUnderAuthority:
        blockInvestigationForPlanReviewRetryUnderAuthority.bind(
          undefined,
          decisions.createInvestigationHumanActionBlocker,
        ),
      blockInvestigationForReviewerTermsUnderAuthority:
        blockInvestigationForReviewerTermsUnderAuthority.bind(
          undefined,
          decisions.createInvestigationHumanActionBlocker,
        ),
      decideReviewerTermReopen,
      getInvestigationStatus,
      inspectReviewerTermResolutionAuthorization:
        inspectReviewerTermResolutionAuthorization.bind(
          undefined,
          decisions.loadMaintainerPolicyForResolution,
        ),
      reopenInvestigationForReviewerTermsUnderAuthority:
        reopenInvestigationForReviewerTermsUnderAuthority.bind(
          undefined,
          decisions.loadMaintainerPolicyForResolution,
        ),
      resumeInvestigationSessionUnderAuthority,
      retryInvestigationProvider: retryInvestigationProvider.bind(
        undefined,
        decisions.taskMandate,
        decisions.readProviderRetryAccountingEvidence,
      ),
      startInvestigationSessionUnderLifecycleLock:
        startInvestigationSessionUnderLifecycleLock.bind(
          undefined,
          decisions.taskMandate,
        ),
      assertInvestigationCheckpointEnvelope,
      assertInvestigationScanSaturationAcceptanceEnvelope,
      checkpointContributionDigest,
      compareAndSwapInvestigationSession,
      readCurrentInvestigationRef,
      readHumanResolutionNode,
      readInvestigationSession,
      scanSaturationAcceptanceEnvelopeDigest,
      createProposeExemptionSession,
      isProposeExemptionInvestigationId,
      readCurrentProposeExemptionSession,
      readProposeExemptionSession,
      retireCurrentProposeExemptionSession,
    },
    grants: {
      createInteractiveSshSigner: decisions.createInteractiveSshSigner,
      consumeCollaborationGrant,
      consumeCollaborationGrantUnderLifecycleLock,
      readExactConsumedCollaborationGrantUse,
      reserveCollaborationGrantUnderLifecycleLock,
    },
    publication: {
      ...decisions.failureObservations,
      assertInvestigationManifestPublicationFailure,
      inspectInvestigationManifestPublication,
      investigationManifestPublicationFailureEmissionDigest,
      investigationManifestPublicationGitStateDigest,
      investigationManifestPublicationNamespace,
      investigationManifestPublicationStateDigest,
      observeInvestigationManifestPublicationState,
      publishInvestigationManifestV3,
      readInvestigationPublicationRefState,
      resumeInvestigationManifestPublication,
      clearInvestigationV3FailureObservation,
      writeInvestigationV3FailureObservation,
      writeInvestigationV3PublicationFailureObservation,
    },
    provider: {
      AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
      loadAiAdapterPolicy,
      loadProviderExecutionRepairContext,
      preflightProviderRepairRetry,
      BLIND_SURVEY_OUTPUT_SCHEMA,
      blindSurveyIntentDigest,
      blindSurveyManifestDigest,
      createProviderExecutionPolicySnapshot,
      createProviderInvocation,
      ensureProviderExecutionPolicySnapshot,
      ensureProviderExecutionPolicySnapshotFromSnapshot,
      providerInvocationExists,
      providerInvocationManifestDigest,
      readBlindSurveyManifest,
      readPlanReviewSnapshotRuntime,
      readProviderInvocation,
      readProviderInvocationManifest,
      readProviderInvocationRequest,
      readProviderRetryReservation,
      storeProviderExecutionPolicySnapshot,
      validateProviderExecutionPolicySnapshot,
    },
  };
}

export type ProposeRuntimeBindings = ReturnType<typeof createProposeRuntime>;

export function createProposeOperations(decisions: ProposeDecisionServices) {
  const proposeRuntime = createProposeRuntime(decisions);
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
    return startProposeOperation(
      proposeRuntime,
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
    return resumeProposeOperation(
      decisions.planningExecution,
      proposeRuntime,
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
    return createProviderRetryEnvelopeOperation(
      proposeRuntime,
      cwd,
      output,
      acknowledgement,
    );
  }

  function createPlanReviewRetryEnvelope(
    cwd: string,
    output: ProposeOutput,
    acknowledgement: { acknowledgeProviderCost: true },
  ): PlanReviewRetryEnvelope {
    return createPlanReviewRetryEnvelopeOperation(
      proposeRuntime,
      cwd,
      output,
      acknowledgement,
    );
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
    return completeInterruptedPlanReviewReplacementOperation(
      proposeRuntime,
      cwd,
      input,
    );
  }

  function startProposeFromFile(
    cwd: string,
    changeId: string,
    intentPath: string,
    options: ProposeOptions = {},
  ): ProposeOutput {
    return startProposeFromFileOperation(
      proposeRuntime,
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
    return resumeProposeFromFileOperation(
      decisions.planningExecution,
      proposeRuntime,
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
    return getProposeStatusOperation(
      proposeRuntime,
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
    return publishTrackedInvestigationManifestV3Operation(
      proposeRuntime,
      input,
    );
  }

  function readCurrentRoleContextSharingPlanReviewRequirement(
    cwd: string,
    requirementNodeId: string,
  ): Extract<PlanReviewGrantRequirement, { kind: 'role-context-sharing' }> {
    return readCurrentRoleContextSharingPlanReviewRequirementOperation(
      proposeRuntime,
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

export { completeRoleContextSharingPlanReviewAdmission } from './plan-review-result.ts';
