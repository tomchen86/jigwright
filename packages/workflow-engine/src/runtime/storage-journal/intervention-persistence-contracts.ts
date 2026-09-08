/**
 * Defines the persisted intervention, sidecar, adoption, and control-update record contracts.
 *
 * Invariants:
 * - Schema discriminants, optional fields, record digests, and authority bindings retain their meaning.
 * - Shared size and permission constants preserve the existing storage limits.
 */
import type {
  Sha256Digest,
  ParentChangeState,
  HarnessInterventionRelationship,
  WipCheckpoint,
  EngineAdoptionJournal,
  HarnessMaintenanceGrantEnvelope,
  MinimalUpdaterTransaction,
  ProtectedCapabilityManifest,
  ControlPlaneGrantEnvelopeV3,
  ExactControlPlaneChangeV2,
} from '../../modules/authority/intervention-control.ts';

export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export const PRIVATE_FILE_MODE = 0o600;

export const PRIVATE_DIRECTORY_MODE = 0o700;

export type PersistenceHumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

export interface PersistenceHumanDependencies {
  now?: () => Date;
  verifyHumanSignature?: PersistenceHumanSignatureVerifier;
}

export interface InterventionControlPersistencePaths {
  root: string;
  checkpoints: string;
  interventions: string;
  sidecarSessions: string;
  sidecarHistory: string;
  sidecarPromotionPins: string;
  adoptions: string;
  controlUpdates: string;
  operations: string;
}

export interface ChildWorktreeMetadata {
  kind: 'intervention-child-worktree.v1';
  workspaceId: Sha256Digest;
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  baseOid: string;
  parentWorkspacePath: string;
  childWorkspacePath: string;
  changeRef: string;
  state: 'planned';
  createdAt: string;
  effectsPerformed: false;
  metadataDigest: Sha256Digest;
}

export interface PersistedInterventionRecord {
  kind: 'persisted-harness-intervention.v1';
  parent: ParentChangeState;
  relationship: HarnessInterventionRelationship;
  checkpoint: WipCheckpoint;
  childWorkspace: ChildWorktreeMetadata;
  createdAt: string;
  recordDigest: Sha256Digest;
}

export type BootstrapSidecarSessionEventKind =
  | 'sidecar-created'
  | 'workspace-materialized'
  | 'artifact-ready'
  | 'adopted-by-parent'
  | 'repository-default-promoted'
  | 'intervention-abandoned';

export interface BootstrapSidecarSessionHistoryEntry {
  sequence: number;
  eventKind: BootstrapSidecarSessionEventKind;
  evidenceDigest: Sha256Digest;
  recordedAt: string;
}

interface BootstrapSidecarIdentity {
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  workspaceId: Sha256Digest;
}

interface BootstrapSidecarParentUnblock {
  kind: 'sidecar-unblocks-parent.v1';
  parentChangeId: string;
  state: 'blocking' | 'unblocked';
  resolution: 'local-adoption' | 'abandonment' | null;
  resolvedByTxId: string | null;
  resolvedAt: string | null;
}

interface BootstrapSidecarWorkspace {
  childWorkspacePath: string;
  changeRef: string;
  state: 'planned' | 'materialized';
  receiptDigest: Sha256Digest | null;
  materializedAt: string | null;
}

interface BootstrapSidecarArtifact {
  artifactId: Sha256Digest;
  sourceDigest: Sha256Digest;
  executableDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
  readyAt: string;
  workflowBindingDigest: Sha256Digest;
  workflowStatus: 'repair-active';
}

interface BootstrapSidecarAdoption {
  txId: string;
  artifactId: Sha256Digest;
  journalDigest: Sha256Digest;
  adoptedAt: string;
  workflowBindingDigest: Sha256Digest;
  workflowStatus: 'repair-active';
}

interface BootstrapSidecarPromotion {
  grantId: string;
  txId: string;
  artifactId: Sha256Digest;
  closureDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
  promotedAt: string;
}

export type BootstrapMaintenanceWorkflowStatus =
  'repair-active' | 'adopted' | 'abandoned';

export interface BootstrapMaintenanceWorkflowBindingV1 {
  kind: 'bootstrap-maintenance-workflow.v1';
  workflowType: 'bootstrap-maintenance';
  workflowId: Sha256Digest;
  changeId: string;
  parentChangeId: string;
  checkpointId: Sha256Digest;
  workspaceId: Sha256Digest;
  repositoryRoot: string;
  changeRef: string;
  baselineOid: string;
  status: BootstrapMaintenanceWorkflowStatus;
  workflowBindingDigest: Sha256Digest;
}

export interface PersistedBootstrapSidecarSessionV2 {
  /**
   * A bootstrap-owned Workflow for the independent intervention Change. It is
   * intentionally not an ordinary task WorkflowSession: its authority is the
   * sealed bootstrap-maintenance protocol and exact parent/intervention fence.
   */
  kind: 'bootstrap-sidecar-session.v2';
  sidecarSessionId: Sha256Digest;
  identity: BootstrapSidecarIdentity;
  workflowBinding: BootstrapMaintenanceWorkflowBindingV1;
  state: BootstrapMaintenanceWorkflowStatus;
  parentUnblock: BootstrapSidecarParentUnblock;
  workspace: BootstrapSidecarWorkspace;
  artifacts: BootstrapSidecarArtifact[];
  adoption: BootstrapSidecarAdoption | null;
  promotion: BootstrapSidecarPromotion | null;
  history: BootstrapSidecarSessionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export interface PersistedTransitionObservation {
  sequence: number;
  eventKind: string;
  fromState: string;
  toState: string;
  evidenceDigest: Sha256Digest;
  recordedAt: string;
}

export interface PersistedEngineAdoptionRecord {
  kind: 'persisted-engine-adoption.v2';
  journal: EngineAdoptionJournal;
  /** Present when adoption is prepared from a persisted artifact record. */
  artifactRecordDigest?: Sha256Digest;
  maintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
  grantEnvelopeDigest: Sha256Digest;
  observations: PersistedTransitionObservation[];
  createdAt: string;
  updatedAt: string;
  effectsPerformed: false;
  recordDigest: Sha256Digest;
}

export interface PersistedBootstrapSidecarPromotionPin {
  kind: 'bootstrap-sidecar-promotion-pin.v1';
  parentChangeId: string;
  interventionChangeId: string;
  sidecarSessionId: Sha256Digest;
  workflowBindingDigest: Sha256Digest;
  artifactId: Sha256Digest;
  artifactRecordDigest: Sha256Digest;
  sourceDigest: Sha256Digest;
  executableDigest: Sha256Digest;
  closureDigest: Sha256Digest;
  grantId: string;
  txId: string;
  state: 'reserved' | 'commit-intent' | 'finalized' | 'rolled-back';
  createdAt: string;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

interface PersistedControlPlaneUpdateRecordFields {
  grantState: 'reserved' | 'consumed';
  transaction: MinimalUpdaterTransaction;
  beforeManifest: ProtectedCapabilityManifest;
  afterManifest: ProtectedCapabilityManifest;
  observations: PersistedTransitionObservation[];
  createdAt: string;
  updatedAt: string;
  effectsPerformed: false;
  recordDigest: Sha256Digest;
}

export interface PersistedControlPlaneUpdateRecordV3 extends PersistedControlPlaneUpdateRecordFields {
  kind: 'persisted-control-plane-update.v3';
  envelope: ControlPlaneGrantEnvelopeV3;
  changes: ExactControlPlaneChangeV2[];
}

export type PersistedControlPlaneUpdateRecord =
  PersistedControlPlaneUpdateRecordV3;
