import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { withTaskRevisionPlanningOperation } from '../application/revise/task-revision.ts';
import {
  createPlanningProviderAuthoringPort,
  planningProviderReviewedAssetMirrors,
  reviewedGeneratedAssets,
} from './planning-provider-authoring-production.ts';
import { loadMaintainerPolicyForResolution } from '../runtime/repository-observation/human-resolution-grants.ts';
import { createInvestigationHumanActionBlocker } from './investigation-retry-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { readPinnedPathDiff } from '../runtime/repository-observation/investigation-floor.ts';
import {
  readLedgerEntry,
  readLedgerIndex,
} from '../runtime/storage-journal/semantic-ledger-store.ts';
import { planningTransitionExecution as planningExecution } from './planning-execution-epoch-production.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import {
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
} from '../runtime/grants/optional-grants-package.ts';
import { parsePlanReviewArtifact } from './plan-review-artifact-production.ts';
import { investigationFailureObservations } from './investigation-failure-production.ts';
import {
  ensureWorkItemPromotionChangeDirectory,
  linkSourceToChange,
} from './work-registry-production.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';
import { managedDocuments } from './managed-documents-production.ts';
import { loadChangeContract } from './consumer-contract-production.ts';
import {
  scanInvestigationTreeFacts,
  materializeInvestigationEvidenceView,
} from './investigation-production.ts';
import {
  readGovernanceSource,
  captureGovernanceSource,
} from './governance-sources-production.ts';
import { planningDraftWorkspace } from './planning-workspace-production.ts';
import { createProposeOperations } from '../runtime/proposal/propose-operations.ts';
import {
  productionPlanningAssurance,
  planningAssuranceDependencies,
} from './planning-assurance-production.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';
import { completeRoleContextSharingPlanReviewAdmission as completeAdmission } from '../runtime/proposal/plan-review-result.ts';
export const productionProposeOperations = createProposeOperations({
  createInteractiveSshSigner,
  withTaskRevisionPlanningOperation,
  planningProvider: {
    reviewedGeneratedAssets,
    createAuthoringPort: createPlanningProviderAuthoringPort,
    reviewedAssetMirrors: planningProviderReviewedAssetMirrors,
  },
  loadMaintainerPolicyForResolution,
  createInvestigationHumanActionBlocker,
  taskMandate: taskMandateOperations,
  semanticLedger: { readLedgerEntry, readLedgerIndex },
  planningExecution,
  roleAdmission: roleResultAdmission,
  roleContextSharingGrants: {
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
  },
  parsePlanReviewArtifact,
  failureObservations: investigationFailureObservations,
  workRegistry: {
    ensureWorkItemPromotionChangeDirectory,
    linkSourceToChange,
    readCurrentChangeOrigin: workRegistryQueries.readCurrentChangeOrigin,
  },
  investigationEvidence: {
    readPinnedPathDiff,
    scanInvestigationTreeFacts,
    materializeInvestigationEvidenceView,
  },
  managedDocuments,
  loadChangeContract,
  sources: { readGovernanceSource, captureGovernanceSource },
  planningWorkspace: planningDraftWorkspace,
  planningAssurance: productionPlanningAssurance,
  planningEvidence: planningAssuranceDependencies,
  readProviderRetryAccountingEvidence,
});

export const {
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
} = productionProposeOperations;

export * from '../modules/proposal/propose-input.ts';

export type * from '../modules/proposal/propose-types.ts';

export const completeRoleContextSharingPlanReviewAdmission =
  completeAdmission.bind(undefined, roleResultAdmission);
