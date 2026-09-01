export type PlanningProviderArtifactInstruction = Readonly<{
  outputPath: string;
  instruction: string;
  template: string;
}>;

export type PlanningProviderArtifactStatus = Readonly<{
  id: string;
  status: 'done' | 'ready' | 'blocked';
}>;

export type PlanningProviderAuthoringStatus = Readonly<{
  isComplete: boolean;
  artifacts: readonly PlanningProviderArtifactStatus[];
}>;

export type PlanningProviderReviewedAssetMirror = Readonly<{
  relationshipId: string;
  mirrorOf: string;
  destinationPath: string;
  reference: string;
}>;

/**
 * Read-only provider capability used while the engine prepares and verifies
 * authored planning material. The provider can describe its native artifact
 * graph, but it cannot publish workflow state or authorize a transition.
 */
export type PlanningProviderAuthoringPort = Readonly<{
  providerId: string;
  instruction(
    changeId: string,
    contractName: string,
    artifactId: string,
  ): PlanningProviderArtifactInstruction;
  inspectStatus(
    changeId: string,
    contractName: string,
  ): PlanningProviderAuthoringStatus;
}>;
