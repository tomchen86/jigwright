/** Required observations of bootstrap-verified local engine identity at each point of use. */
export type LocalEngineSelectionReader = (
  storageRoot: string,
  identity: Readonly<{ worktreeRoot: string; branchRef: string | null }>,
) => Readonly<{
  resumeBinding: Readonly<{
    kind: 'local-engine-resume-binding.v1';
    parentChangeId: string;
    checkpointId: `sha256:${string}`;
    engineDigest: `sha256:${string}`;
  }>;
}> | null;

export type BootstrapStateRootReader = (gitCommonDirectory: string) => string;

export type LocalEngineSelectionReaders = Readonly<{
  bootstrapInterventionStateRoot: BootstrapStateRootReader;
  resolveLocalEngineSelection: LocalEngineSelectionReader;
}>;
