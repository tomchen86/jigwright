/** Persisted bootstrap record and evidence contracts; no runtime dependencies. */
import type {
  PROTECTED_CAPABILITY_MANIFEST_PATH,
  ADOPTION_HISTORIES,
} from './control-plane-bootstrap-values.ts';

export type Sha256Digest = `sha256:${string}`;

export interface BootstrapControlPlaneSupervisorState {
  kind: 'control-plane-supervisor-state.v1';
  repositoryId: string;
  activeArtifact: {
    artifactId: Sha256Digest;
    executableDigest: Sha256Digest;
    closureDigest: Sha256Digest;
    executablePath: string;
  };
  generation: number;
  transition: {
    grantId: string;
    txId: string;
    phase: 'candidate-selected' | 'rollback-restored';
  } | null;
  updatedAt: string;
  recordDigest: Sha256Digest;
}

export interface BootstrapControlPlaneEngineArtifact {
  kind: 'engine-artifact.v1';
  sourceChangeId: string;
  sourceDigest: Sha256Digest;
  executableDigest: Sha256Digest;
  protocolVersion: number;
  canReadSessionSchemas: string[];
  writesSessionSchema: string;
  policySchemaVersion: number;
  smokeReportDigest: Sha256Digest;
  artifactId: Sha256Digest;
}

export interface BootstrapWorktreeIdentity {
  worktreeRoot: string;
  branchRef: string | null;
}

export interface BootstrapRepositoryIdentity extends BootstrapWorktreeIdentity {
  gitCommonDirectory: string;
}

export interface BootstrapInitialSupervisorHooks {
  /** Test-only deterministic interleaving seam; production callers omit it. */
  testAfterProvenanceCapture?: () => void;
  /** Test-only hard-crash seam after a durable bootstrap phase. */
  testAfterBootstrapPhase?: (
    phase: 'PREPARED' | 'ARTIFACT_MATERIALIZED' | 'SUPERVISOR_PUBLISHED',
  ) => void;
}

export interface BootstrapLocalEngineSelection {
  executablePath: string;
  executableDigest: Sha256Digest;
  resumeBinding: {
    kind: 'local-engine-resume-binding.v1';
    parentChangeId: string;
    checkpointId: Sha256Digest;
    engineDigest: Sha256Digest;
  };
}

export interface BootstrapParentInterventionFence {
  kind: 'harness-intervention';
  parentChangeId: string;
  checkpointId: Sha256Digest;
  blockedBy: string;
  parentWorkspacePath: string;
}

export interface BootstrapRecoveryQuarantineMarker {
  kind: 'recovery-quarantine-marker.v1';
  repositoryId: string;
  authorityDescriptorDigest: Sha256Digest;
  authorityGeneration: number;
  recoveryRuntimeDigest: Sha256Digest;
  externalAuditRoot: string;
  enterGrantId: string;
  enterEnvelopeDigest: Sha256Digest;
  enteredAt: string;
  markerDigest: Sha256Digest;
}

export interface BootstrapPaths {
  root: string;
  supervisor: string;
  initialBootstrapJournal: string;
  bundles: string;
  artifacts: string;
  approvalCandidates: string;
  controlUpdates: string;
  supervisorHistory: string;
  checkpoints: string;
  interventions: string;
  sidecarSessions: string;
  adoptions: string;
  operations: string;
  localSessions: string;
  localArtifacts: string;
}

export interface BuiltInClosurePackageV2 {
  name: string;
  sourceRoot: string;
  closureRoot: string;
}

export interface BuiltInClosureManifestV2 {
  kind: 'built-in-engine-closure-manifest.v2';
  entrypoint: string;
  scope: 'workspace-runtime-source-closure';
  packages: BuiltInClosurePackageV2[];
  files: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
  }>;
}

export type BuiltInClosureManifest = BuiltInClosureManifestV2;

export interface VerifiedBuiltInEngineClosure {
  manifest: BuiltInClosureManifest;
  manifestBytes: Buffer;
  manifestDigest: Sha256Digest;
  files: Array<{
    path: string;
    repositoryPath: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
    bytes: Buffer;
  }>;
}

export interface VerifiedProtectedCapabilityManifest {
  payload: Record<string, unknown>;
  manifestDigest: Sha256Digest;
  bootstrapRuntimeFiles: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: Sha256Digest;
    bytes: Buffer;
  }>;
}

export interface InitialSupervisorProvenance {
  repositoryId: string;
  branchRef: string;
  remoteBaseRef: string;
  remoteBaseOid: string;
  headOid: string;
  treeOid: string;
  packageRoot: string;
}

export type InitialSupervisorBootstrapPhase =
  'PREPARED' | 'ARTIFACT_MATERIALIZED' | 'SUPERVISOR_PUBLISHED';

export interface InitialSupervisorBootstrapJournalRecord {
  kind: 'initial-supervisor-bootstrap-journal.v1';
  phase: InitialSupervisorBootstrapPhase;
  provenance: InitialSupervisorProvenance;
  initializedAt: string;
  builtInClosureDigest: Sha256Digest;
  protectedManifestDigest: Sha256Digest;
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'];
  supervisorRecordDigest: Sha256Digest;
  previousPhaseDigest: Sha256Digest | null;
  recordDigest: Sha256Digest;
}

export interface InitialSupervisorBootstrapJournalProgress {
  completedPhases: number;
  pendingPhase: InitialSupervisorBootstrapPhase | null;
}

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

export interface BootstrapSupervisorHistoryArtifact {
  artifactId: Sha256Digest;
  executableDigest: Sha256Digest;
  closureDigest: Sha256Digest;
}

export interface BootstrapSupervisorHistoryAnchorAuthority {
  kind: 'initial-bootstrap-anchor.v1';
  initialBootstrapPublishedDigest: Sha256Digest;
}

export interface BootstrapSupervisorHistoryAnchor {
  kind: 'control-plane-supervisor-history-anchor.v1';
  sequence: 0;
  previousRecordDigest: null;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  authority: BootstrapSupervisorHistoryAnchorAuthority;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export interface BootstrapSupervisorHistoryTransition {
  kind: 'control-plane-supervisor-history-transition.v1';
  sequence: number;
  previousRecordDigest: Sha256Digest;
  repositoryId: string;
  phase: 'candidate-selected' | 'rollback-restored';
  fromGeneration: number;
  toGeneration: number;
  fromSupervisorRecordDigest: Sha256Digest;
  toSupervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  grantId: string;
  txId: string;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  promotionLineageDigest: Sha256Digest;
  sourceTransactionState: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED';
  sourceJournalDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export interface BootstrapSupervisorHistoryTerminal {
  kind: 'control-plane-supervisor-history-terminal.v1';
  sequence: number;
  previousRecordDigest: Sha256Digest;
  repositoryId: string;
  generation: number;
  supervisorRecordDigest: Sha256Digest;
  activeArtifact: BootstrapSupervisorHistoryArtifact;
  activeTrustCommit: string;
  terminalState: 'FINALIZED' | 'ROLLED_BACK';
  grantId: string;
  txId: string;
  updateRecordDigest: Sha256Digest;
  transactionJournalDigest: Sha256Digest;
  grantEnvelopeDigest: Sha256Digest;
  promotionBundleDigest: Sha256Digest;
  recordedAt: string;
  recordDigest: Sha256Digest;
}

export type BootstrapSupervisorHistoryRecord =
  | BootstrapSupervisorHistoryAnchor
  | BootstrapSupervisorHistoryTransition
  | BootstrapSupervisorHistoryTerminal;

export interface BootstrapSupervisorHistory {
  records: BootstrapSupervisorHistoryRecord[];
  anchor: BootstrapSupervisorHistoryAnchor;
  leaf: BootstrapSupervisorHistoryTerminal;
}

export interface BootstrapProtectedTreeEntry {
  path: string;
  mode: string;
  objectId: string;
  type: string;
}

export type BootstrapProtectedClosureIdentity =
  | Pick<BootstrapProtectedTreeEntry, 'path' | 'mode' | 'objectId'>
  | {
      path: typeof PROTECTED_CAPABILITY_MANIFEST_PATH;
      mode: 'manifest-self';
      objectId: 'manifest-self';
    };

export interface BootstrapLocalEngineBinding {
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

export type BootstrapAdoptionState = keyof typeof ADOPTION_HISTORIES;

export interface BootstrapAdoptionJournal {
  kind: 'engine-adoption-journal.v1';
  txId: string;
  grantId: string;
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  fromEngineDigest: Sha256Digest;
  toEngineDigest: Sha256Digest;
  artifactId: Sha256Digest;
  sessionSchema: string;
  workflowBindingDigest: Sha256Digest;
  workflowStatus: 'repair-active';
  state: BootstrapAdoptionState;
  history: Array<{ state: BootstrapAdoptionState; at: string }>;
  journalDigest: Sha256Digest;
}

export interface BootstrapLocalAdoptionRecord {
  journal: BootstrapAdoptionJournal;
  artifactRecordDigest: Sha256Digest;
}

export type BootstrapRootNamespace =
  'global' | 'local' | 'operations' | 'unknown';

export interface BootstrapTrustedSigner {
  identity: string;
  publicKey: string;
  fingerprint: string;
}
