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
/** Binds proposal workflows to required current planning and retry observations. */
import { createProposeOperations } from '../application/propose/propose-orchestrator.ts';
import {
  productionPlanningAssurance,
  planningAssuranceDependencies,
} from './planning-assurance-production.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';

export const productionProposeOperations = createProposeOperations({
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
export * from '../application/propose/propose-input.ts';
export type * from '../application/propose/propose-types.ts';

import { completeRoleContextSharingPlanReviewAdmission as completeAdmission } from '../application/propose/plan-review-result.ts';
export const completeRoleContextSharingPlanReviewAdmission =
  completeAdmission.bind(undefined, roleResultAdmission);
