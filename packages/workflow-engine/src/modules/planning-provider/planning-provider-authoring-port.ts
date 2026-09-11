/**
 * Declares the planning provider instructions and artifact status used
 * during authoring.
 *
 * Invariants:
 * - The port exposes instruction and status queries; artifact states are
 *   limited to done, ready and blocked.
 */
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
