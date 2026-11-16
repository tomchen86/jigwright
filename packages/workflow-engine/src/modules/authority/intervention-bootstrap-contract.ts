/** Retained intervention metadata and signed disposition inputs. */
import type {
  HarnessMaintenanceOperation,
  HarnessMaintenanceWaiver,
} from './intervention-record-contract.ts';
import type { Sha256Digest } from './intervention-control-values.ts';
import type { MaintainerSignerProvider } from './maintainer-signer-port.ts';

export type BootstrapHumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

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
export interface BootstrapInterventionCliDependencies {
  now?: () => Date;
  verifyHumanSignature?: BootstrapHumanSignatureVerifier;
  maintenanceSigner?: MaintainerSignerProvider;
  testHooks?: {
    afterAuthorityAuditRecorded?: () => void;
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
