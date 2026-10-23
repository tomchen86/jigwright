/** Persisted bootstrap record and evidence contracts; no runtime dependencies. */
export type Sha256Digest = `sha256:${string}`;

export interface BootstrapWorktreeIdentity {
  worktreeRoot: string;
  branchRef: string | null;
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
  checkpoints: string;
  interventions: string;
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
