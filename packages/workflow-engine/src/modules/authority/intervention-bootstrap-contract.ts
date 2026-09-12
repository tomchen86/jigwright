/** Canonical intervention bootstrap inputs, parent state and human approval data. */
import type {
  EngineArtifact,
  ParentChangeState,
  HarnessMaintenanceOperation,
  HarnessMaintenanceWaiver,
} from './intervention-control-adoption.ts';
import type { Sha256Digest } from './intervention-control-values.ts';
import type { MaintainerSignerProvider } from './maintainer-signer-port.ts';

export type BootstrapHumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

export interface BootstrapDependencies {
  now?: () => Date;
  verifyHumanSignature?: BootstrapHumanSignatureVerifier;
  testHooks?: {
    afterBindingUpdatedBeforeJournal?: () => void;
    afterWorktreeReceiptPersistedBeforeSidecar?: () => void;
    afterAdoptionReceiptPersistedBeforeSidecar?: () => void;
  };
}

export interface MaintenanceApprovalSummary {
  kind: 'maintenance-approval-summary.v1';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  reason: string;
  childWorkspace: {
    path: string;
    changeRef: string;
  };
  scope: {
    paths: string[];
    operations: HarnessMaintenanceOperation[];
  };
  waivers: HarnessMaintenanceWaiver[];
  authorityAudit: {
    externalAuditRoot: string;
    repositoryId: Sha256Digest;
  };
  maxLocalAdoptions: 1;
  humanReadable: string;
}

export interface DurableInterventionParentState {
  parent: ParentChangeState;
  sessionSnapshotPath: string;
  pendingIntent: string;
  policyDigest: Sha256Digest;
}

export interface BootstrapInterventionCliDependencies extends BootstrapDependencies {
  resolveParentDurableState?: (input: {
    parentChangeId: string;
    repositoryRoot: string;
    stateRoot: string;
    reason: string;
  }) => DurableInterventionParentState;
  maintenanceSigner?: MaintainerSignerProvider;
  presentMaintenanceSummary?: (summary: MaintenanceApprovalSummary) => void;
  testHooks?: {
    afterMaintenanceGrantPersisted?: () => void;
    afterAdoptionStep?: () => void;
    afterAuthorityAuditRecorded?: () => void;
    afterBindingUpdatedBeforeJournal?: () => void;
    afterAbandonmentIntentPersisted?: () => void;
  };
}

export interface LocalEngineBinding {
  kind: 'local-parent-session-metadata.v2';
  parentChangeId: string;
  parentWorkspacePath: string;
  parentBranch: string;
  interventionChangeId: string;
  txId: string;
  checkpointId: Sha256Digest;
  engineDigest: Sha256Digest;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    executablePath: string;
  };
  sessionSchema: string;
  blocker: {
    kind: 'harness-intervention';
    checkpointId: Sha256Digest;
    blockedBy: string;
  } | null;
  interventionState: 'active' | 'adopted';
  generation: number;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

/** The built-in artifact has the existing engine artifact fields, without a workflow binding. */
export type BootstrapControlPlaneEngineArtifact = Omit<
  EngineArtifact,
  'workflowBindingDigest'
>;

export interface InitialControlPlaneSupervisorAnchorEvidence {
  repositoryId: string;
  activeTrustCommit: string;
  publishedRecordDigest: Sha256Digest;
  supervisorRecordDigest: Sha256Digest;
  generation: 1;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
  };
  recordedAt: string;
}

/** Required observations supplied by the bootstrap host at the original producer phases. */
export interface ControlPlanePromotionBootstrapObservations {
  bootstrapInterventionStateRoot(gitCommonDirectory: string): string;
  readInitialControlPlaneSupervisorAnchorEvidence(
    storageRoot: string,
    expectedRepositoryId: string,
  ): InitialControlPlaneSupervisorAnchorEvidence;
  readBuiltInControlPlaneEngineArtifact(
    storageRoot: string,
  ): BootstrapControlPlaneEngineArtifact;
}
