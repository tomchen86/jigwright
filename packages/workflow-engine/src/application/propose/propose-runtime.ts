/**
 * Names the runtime port types shared by propose application modules.
 *
 * Invariants:
 * - Aliases preserve the original runtime contract, including optional and nullable fields.
 * - All dependencies remain type-only and introduce no runtime initialization or execution.
 */

import type {
  ProposeRuntimeBindings,
  ProposeRuntimeData,
} from './propose-orchestrator.ts';

export type ProposeRuntime = ProposeRuntimeBindings;
export type BehaviorContractRef = ProposeRuntimeData['BehaviorContractRef'];
export type ChangeContract = ProposeRuntimeData['ChangeContract'];
export type ExecutionArtifact = ProposeRuntimeData['ExecutionArtifact'];
export type GuardContract = ProposeRuntimeData['GuardContract'];
export type EvidenceNode = ProposeRuntimeData['EvidenceNode'];
export type InvestigationStatus = ProposeRuntimeData['InvestigationStatus'];
export type MaintainerSignerProvider =
  ProposeRuntimeData['MaintainerSignerProvider'];
export type InvestigationManifestPublicationFailure =
  ProposeRuntimeData['InvestigationManifestPublicationFailure'];
export type InvestigationManifestPublicationLifecycleIdentity =
  ProposeRuntimeData['InvestigationManifestPublicationLifecycleIdentity'];
export type InvestigationManifestPublicationPaths =
  ProposeRuntimeData['InvestigationManifestPublicationPaths'];
export type InvestigationManifestPublicationSnapshot =
  ProposeRuntimeData['InvestigationManifestPublicationSnapshot'];
export type TrackedTreeSnapshot = ProposeRuntimeData['TrackedTreeSnapshot'];
export type HeldChangeTransitionAuthority =
  ProposeRuntimeData['HeldChangeTransitionAuthority'];
export type CollaborationGrantUseProjection =
  ProposeRuntimeData['CollaborationGrantUseProjection'];
export type GroupDispositionsPayload =
  ProposeRuntimeData['GroupDispositionsPayload'];
export type InvestigationCheckpointEnvelope =
  ProposeRuntimeData['InvestigationCheckpointEnvelope'];
export type InvestigationScanSaturationAcceptanceEnvelope =
  ProposeRuntimeData['InvestigationScanSaturationAcceptanceEnvelope'];
export type InvestigationSession = ProposeRuntimeData['InvestigationSession'];
export type StoredInvestigationCheckpoint =
  ProposeRuntimeData['StoredInvestigationCheckpoint'];
export type WhyAnswersPayload = ProposeRuntimeData['WhyAnswersPayload'];
export type ProposeExemptionSession =
  ProposeRuntimeData['ProposeExemptionSession'];
export type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
export type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
export type { PlanReviewManifest } from '../../modules/assurance/provider-review-manifests.ts';
export type { ProviderExecutionPolicySnapshotCurrent } from '../../modules/provider-orchestration/provider-execution-policy-snapshot.ts';
export type { ProviderRetryDecisionBinding } from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
