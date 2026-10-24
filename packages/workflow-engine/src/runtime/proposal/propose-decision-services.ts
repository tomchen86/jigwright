import type { MaintainerSignerFactory } from '../../modules/authority/maintainer-signer-port.ts';
import type { HeldChangeTransitionAuthority } from '../session-workspace/planning-lock.ts';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
import type {
  PlanningProviderAuthoringPort,
  PlanningProviderReviewedAssetMirror,
} from '../../modules/planning-provider/planning-provider-authoring-port.ts';
import type { HumanResolutionServices } from '../../modules/investigation/domain/human-resolution-grant-contract.ts';
import type { InvestigationHumanActionBlockerFactory } from '../../modules/investigation/domain/human-resolution-contract.ts';
import type {
  TaskMandateActiveBinding,
  TaskMandatePreparationAuthorization,
  TaskMandateProviderAdmission,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { SemanticLedgerReader } from '../../modules/why-knowledge/semantic-ledger-reader.ts';
import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
import type { RoleAdmissionServices } from '../../modules/provider-orchestration/role-scheduler.ts';
import type { RoleContextSharingGrantOperations } from '../../modules/authority/role-context-sharing-grant.ts';
import type { PlanReviewArtifactParser } from '../../modules/assurance/plan-review-artifact.ts';
import type { InvestigationV3FailureObservations } from '../../modules/investigation/seal/investigation-v3-failure-source.ts';
import type { WorkRegistryChangePreparation } from '../../modules/governance-intake/work-registry-contracts.ts';
import type { ReadPinnedPathDiff } from '../../modules/investigation/domain/investigation-floor.ts';
import type { InvestigationTreeScanner } from '../../modules/investigation/domain/investigation-scanner.ts';
import type { InvestigationEvidenceReplayer } from '../../modules/investigation/manifest/investigation-materializer.ts';
import type { ManagedDocumentOperations } from '../../modules/projection/managed-documents.ts';
import type { ChangeContractReader } from '../../modules/planning-provider/change-contract.ts';
import type { createGovernanceSourceServices } from '../../modules/governance-intake/governance-sources.ts';
import type { PlanningDraftWorkspacePort } from '../../modules/planning-provider/planning-workspace.ts';
import type { PlanningAssurancePort } from '../../modules/assurance/planning-assurance-port.ts';
import type { PlanningAssuranceDependencies } from '../../modules/assurance/planning-assurance-observations.ts';
import type { ProviderRetryAccountingReader } from '../../modules/provider-orchestration/provider-retry-accounting.ts';

export type ProposeDecisionServices = Readonly<{
  createInteractiveSshSigner: MaintainerSignerFactory;
  /** Routes planning authority to an active task revision. */
  withTaskRevisionPlanningOperation<T>(
    cwd: string,
    requestedSessionId: string,
    operation: (authority: HeldChangeTransitionAuthority) => T,
  ): T;
  planningProvider: Readonly<{
    reviewedGeneratedAssets: ReviewedGeneratedAssetInventory;
    createAuthoringPort(repositoryRoot: string): PlanningProviderAuthoringPort;
    reviewedAssetMirrors(
      repositoryRoot: string,
    ): readonly PlanningProviderReviewedAssetMirror[];
  }>;
  loadMaintainerPolicyForResolution: HumanResolutionServices['loadMaintainerPolicyForResolution'];
  createInvestigationHumanActionBlocker: InvestigationHumanActionBlockerFactory;
  taskMandate: Pick<
    TaskMandateActiveBinding,
    | 'assertActiveTaskMandateBindingUnderLifecycleLock'
    | 'withActiveTaskMandateBinding'
  > &
    Pick<TaskMandatePreparationAuthorization, 'authorizeTaskMandateOperation'> &
    Pick<
      TaskMandateProviderAdmission,
      | 'authorizeTaskMandateProviderReservationUnderLifecycleLock'
      | 'recordTaskMandateProviderInvocationUnderLifecycleLock'
    >;
  semanticLedger: SemanticLedgerReader;
  planningExecution: PlanningTransitionExecutionServices;
  roleAdmission: RoleAdmissionServices;
  roleContextSharingGrants: Pick<
    RoleContextSharingGrantOperations,
    | 'bindingFromRoleContextSharingGrantPayloadV1'
    | 'canonicalRoleContextSharingGrantEnvelopeV1'
  >;
  parsePlanReviewArtifact: PlanReviewArtifactParser;
  failureObservations: Pick<
    InvestigationV3FailureObservations,
    'captureInvestigationV3DirectFailureEmission'
  >;
  workRegistry: WorkRegistryChangePreparation;
  investigationEvidence: Readonly<{
    readPinnedPathDiff: ReadPinnedPathDiff;
    scanInvestigationTreeFacts: InvestigationTreeScanner;
    materializeInvestigationEvidenceView: InvestigationEvidenceReplayer;
  }>;
  managedDocuments: Pick<ManagedDocumentOperations, 'refreshPlanningDocuments'>;
  loadChangeContract: ChangeContractReader;
  sources: Pick<
    ReturnType<typeof createGovernanceSourceServices>,
    'readGovernanceSource' | 'captureGovernanceSource'
  >;
  planningWorkspace: PlanningDraftWorkspacePort;
  planningAssurance: PlanningAssurancePort;
  planningEvidence: Pick<
    PlanningAssuranceDependencies,
    | 'readRepositoryCitation'
    | 'readPlanningSnapshotOrigin'
    | 'readPlanningSnapshotArtifact'
    | 'roleAdmission'
    | 'grantCodec'
    | 'verifyChallengeClosureSignature'
  >;
  readProviderRetryAccountingEvidence: ProviderRetryAccountingReader;
}>;
