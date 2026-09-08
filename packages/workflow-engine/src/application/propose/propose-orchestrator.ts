/**
 * Exposes the proposal API and binds its workflows to the repository runtime.
 *
 * Invariants:
 * - Public signatures and result shapes remain compatible with existing callers.
 * - Dependency assembly performs no reads, writes, or authority acquisition.
 * - Each workflow receives the same runtime operations throughout its execution.
 *
 * Depends on: proposal use cases, their contracts, and the existing runtime composition.
 * Failure modes: incompatible entry points, missing operations, or incorrectly bound workflows.
 */
import {
  loadChecksConfig,
  loadWorkflowConfig,
  parseCurrentInvestigationManifest,
  parseExecutionArtifact,
  parsePlanReviewArtifact,
  parseTasks,
  type BehaviorContractRef,
  type ChangeContract,
  type ExecutionArtifact,
  type GuardContract,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { assertTaskMandateOptional } from '../../adapters/consumer/repository/work-registry/task-authorization-policy.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from '../../adapters/planning/investigation/evidence-node.ts';
import {
  acknowledgeReviewerTermInputClosureUnderAuthority,
  blockInvestigationForPlanReviewRetryUnderAuthority,
  blockInvestigationForReviewerTermsUnderAuthority,
  decideReviewerTermReopen,
  getInvestigationStatus,
  inspectReviewerTermResolutionAuthorization,
  reopenInvestigationForReviewerTermsUnderAuthority,
  resumeInvestigationSessionUnderAuthority,
  retryInvestigationProvider,
  startInvestigationSessionUnderLifecycleLock,
  type InvestigationStatus,
} from '../../adapters/planning/investigation/investigation-session.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import { type InvestigationManifestV3 } from '../../modules/investigation/manifest/investigation-manifest.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { deriveReviewedMutationClassPolicy } from '../../runtime/managed-documents/ownership/reviewed-mutation-policy.ts';
import {
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
  type InvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationLifecycleIdentity,
  type InvestigationManifestPublicationPaths,
  type InvestigationManifestPublicationSnapshot,
} from '../../runtime/managed-documents/transaction/investigation-publication.ts';
import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  loadAiAdapterPolicy,
} from '../../runtime/provider-execution/ai-adapter-policy.ts';
import {
  loadProviderExecutionRepairContext,
  preflightProviderRepairRetry,
} from '../../runtime/provider-execution/provider-execution-governance.ts';
import { replaceTextAtomic } from '../../runtime/repository-transaction/atomic-text.ts';
import {
  discoverRepository,
  protectedBranchRef,
  readFileAtCommit,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  readPinnedTrackedTree,
  type TrackedTreeSnapshot,
} from '../../runtime/repository-transaction/tracked-tree-reader.ts';
import {
  assertChangeId,
  normalizePolicyPath,
} from '../../runtime/session-workspace/paths.ts';
import {
  withInvestigationTransitionAuthority,
  type HeldChangeTransitionAuthority,
} from '../../runtime/session-workspace/planning-lock.ts';
import {
  inspectPlanningDraftWorkspace,
  preparePlanningDraftWorkspace,
  readPlanningDraftWorkspace,
} from '../../runtime/session-workspace/planning-workspace.ts';
import {
  consumeCollaborationGrant,
  consumeCollaborationGrantUnderLifecycleLock,
  readExactConsumedCollaborationGrantUse,
  reserveCollaborationGrantUnderLifecycleLock,
  type CollaborationGrantUseProjection,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
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
  compareAndSwapInvestigationSession,
  readCurrentInvestigationRef,
  readHumanResolutionNode,
  readInvestigationSession,
  scanSaturationAcceptanceEnvelopeDigest,
  type GroupDispositionsPayload,
  type InvestigationCheckpointEnvelope,
  type InvestigationScanSaturationAcceptanceEnvelope,
  type InvestigationSession,
  type StoredInvestigationCheckpoint,
  type WhyAnswersPayload,
} from '../../runtime/storage-journal/investigation-session-store.ts';
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
  type ProposeExemptionSession,
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
  type BlindSurveyManifest,
  type NormalizedChangeIntent,
  type PlanReviewManifest,
  type ProviderExecutionPolicySnapshotCurrent,
  type ProviderRetryDecisionBinding,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import { readLedgerEntry } from '../../runtime/storage-journal/semantic-ledger-store.ts';
import { type PlanReviewGrantRequirement } from './plan-review-contracts.ts';
import {
  completeInterruptedPlanReviewReplacement as completeInterruptedPlanReviewReplacementOperation,
  createPlanReviewRetryEnvelope as createPlanReviewRetryEnvelopeOperation,
} from './plan-review-retry.ts';
import { readCurrentRoleContextSharingPlanReviewRequirement as readCurrentRoleContextSharingPlanReviewRequirementOperation } from './plan-review-store.ts';
import { createProviderRetryEnvelope as createProviderRetryEnvelopeOperation } from './propose-provider-lifecycle.ts';
import { publishTrackedInvestigationManifestV3 as publishTrackedInvestigationManifestV3Operation } from './propose-publication.ts';
import { createScanSaturationAcceptanceEnvelope as createScanSaturationAcceptanceEnvelopeOperation } from './propose-request-validation.ts';
import {
  resumeProposeFromFile as resumeProposeFromFileOperation,
  resumePropose as resumeProposeOperation,
} from './propose-resume.ts';
import {
  startProposeFromFile as startProposeFromFileOperation,
  startPropose as startProposeOperation,
} from './propose-start.ts';
import { getProposeStatus as getProposeStatusOperation } from './propose-status.ts';
import {
  type ExemptionPlanningContributionEnvelope,
  type ExemptionProposeOutput,
  type InvestigationExemptionRequest,
  type OrdinaryProposeOutput,
  type PlanningContributionEnvelope,
  type PlanReviewDispositionsEnvelope,
  type PlanReviewProgressEnvelope,
  type PlanReviewRetryEnvelope,
  type ProposeOptions,
  type ProposeOutput,
  type ProposeResumeOptions,
  type ProviderProgressEnvelope,
  type ProviderRetryEnvelope,
} from './propose-types.ts';

export {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  createProviderProgressEnvelope,
} from './propose-input.ts';
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
} from './propose-types.ts';

const proposeRuntime = {
  workspace: {
    loadChecksConfig,
    loadWorkflowConfig,
    parseCurrentInvestigationManifest,
    parseExecutionArtifact,
    parsePlanReviewArtifact,
    parseTasks,
    assertTaskMandateOptional,
    loadInvestigationRuntimeContext,
    deriveReviewedMutationClassPolicy,
    replaceTextAtomic,
    discoverRepository,
    protectedBranchRef,
    readFileAtCommit,
    runGit,
    readPinnedTrackedTree,
    assertChangeId,
    normalizePolicyPath,
    withInvestigationTransitionAuthority,
    inspectPlanningDraftWorkspace,
    preparePlanningDraftWorkspace,
    readPlanningDraftWorkspace,
    readLedgerEntry,
    planningProviderAuthoring: (
      context: ReturnType<typeof loadInvestigationRuntimeContext>,
    ) => context.planningProviderAuthoring(),
    planningProviderReviewedAssetMirrors: (
      context: ReturnType<typeof loadInvestigationRuntimeContext>,
    ) => context.planningProviderReviewedAssetMirrors(),
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
    acknowledgeReviewerTermInputClosureUnderAuthority,
    blockInvestigationForPlanReviewRetryUnderAuthority,
    blockInvestigationForReviewerTermsUnderAuthority,
    decideReviewerTermReopen,
    getInvestigationStatus,
    inspectReviewerTermResolutionAuthorization,
    reopenInvestigationForReviewerTermsUnderAuthority,
    resumeInvestigationSessionUnderAuthority,
    retryInvestigationProvider,
    startInvestigationSessionUnderLifecycleLock,
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
    createInteractiveSshSigner,
    consumeCollaborationGrant,
    consumeCollaborationGrantUnderLifecycleLock,
    readExactConsumedCollaborationGrantUse,
    reserveCollaborationGrantUnderLifecycleLock,
  },
  publication: {
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

export type ProposeRuntimeBindings = typeof proposeRuntime;
export type ProposeRuntimeData = {
  BehaviorContractRef: BehaviorContractRef;
  ChangeContract: ChangeContract;
  ExecutionArtifact: ExecutionArtifact;
  GuardContract: GuardContract;
  EvidenceNode: EvidenceNode;
  InvestigationStatus: InvestigationStatus;
  MaintainerSignerProvider: MaintainerSignerProvider;
  InvestigationManifestPublicationFailure: InvestigationManifestPublicationFailure;
  InvestigationManifestPublicationLifecycleIdentity: InvestigationManifestPublicationLifecycleIdentity;
  InvestigationManifestPublicationPaths: InvestigationManifestPublicationPaths;
  InvestigationManifestPublicationSnapshot: InvestigationManifestPublicationSnapshot;
  TrackedTreeSnapshot: TrackedTreeSnapshot;
  HeldChangeTransitionAuthority: HeldChangeTransitionAuthority;
  CollaborationGrantUseProjection: CollaborationGrantUseProjection;
  GroupDispositionsPayload: GroupDispositionsPayload;
  InvestigationCheckpointEnvelope: InvestigationCheckpointEnvelope;
  InvestigationScanSaturationAcceptanceEnvelope: InvestigationScanSaturationAcceptanceEnvelope;
  InvestigationSession: InvestigationSession;
  StoredInvestigationCheckpoint: StoredInvestigationCheckpoint;
  WhyAnswersPayload: WhyAnswersPayload;
  ProposeExemptionSession: ProposeExemptionSession;
  BlindSurveyManifest: BlindSurveyManifest;
  NormalizedChangeIntent: NormalizedChangeIntent;
  PlanReviewManifest: PlanReviewManifest;
  ProviderExecutionPolicySnapshotCurrent: ProviderExecutionPolicySnapshotCurrent;
  ProviderRetryDecisionBinding: ProviderRetryDecisionBinding;
};

export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: NormalizedChangeIntent,
  options?: ProposeOptions,
): OrdinaryProposeOutput;

export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: InvestigationExemptionRequest,
  options?: ProposeOptions,
): ExemptionProposeOutput;

export function startPropose(
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options?: ProposeOptions,
): ProposeOutput;

export function startPropose(
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

export function resumePropose(
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

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: ExemptionPlanningContributionEnvelope,
  options?: ProposeResumeOptions,
): ExemptionProposeOutput;

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue:
    | PlanReviewRetryEnvelope
    | PlanReviewProgressEnvelope
    | PlanReviewDispositionsEnvelope,
  options?: ProposeResumeOptions,
): ProposeOutput;

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options?: ProposeResumeOptions,
): ProposeOutput;

export function resumePropose(
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  return resumeProposeOperation(
    proposeRuntime,
    cwd,
    requestedChangeId,
    inputValue,
    options,
  );
}

export function createScanSaturationAcceptanceEnvelope(
  output: ProposeOutput,
): InvestigationScanSaturationAcceptanceEnvelope {
  return createScanSaturationAcceptanceEnvelopeOperation(
    proposeRuntime,
    output,
  );
}

export function createProviderRetryEnvelope(
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

export function createPlanReviewRetryEnvelope(
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

export function completeInterruptedPlanReviewReplacement(
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

export function startProposeFromFile(
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

export function resumeProposeFromFile(
  cwd: string,
  changeId: string,
  inputPath: string,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  return resumeProposeFromFileOperation(
    proposeRuntime,
    cwd,
    changeId,
    inputPath,
    options,
  );
}

export { completeRoleContextSharingPlanReviewAdmission } from './plan-review-result.ts';

export function getProposeStatus(
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

export function publishTrackedInvestigationManifestV3(input: {
  context: ReturnType<typeof loadInvestigationRuntimeContext>;
  manifest: InvestigationManifestV3;
  assertOwned: () => void;
  assertCurrent: () => void;
}): void {
  return publishTrackedInvestigationManifestV3Operation(proposeRuntime, input);
}

export function readCurrentRoleContextSharingPlanReviewRequirement(
  cwd: string,
  requirementNodeId: string,
): Extract<PlanReviewGrantRequirement, { kind: 'role-context-sharing' }> {
  return readCurrentRoleContextSharingPlanReviewRequirementOperation(
    proposeRuntime,
    cwd,
    requirementNodeId,
  );
}
