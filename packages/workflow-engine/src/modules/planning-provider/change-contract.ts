/** Parsed change artifact facts, before provider readiness and planning-assurance admission. */
import type { InvestigationManifestV3 } from '../investigation/manifest/investigation-manifest-types.ts';
import type { ImmutableGitTreeInvestigationObservation } from '../investigation/manifest/investigation-observation.ts';
import type { WorkflowConfig } from '../repository-consumer/workflow-config.ts';
import type { ChecksConfig } from '../source/check-command.ts';
import type {
  GuardContract,
  ParsedTask,
  BehaviorContractRef,
  ExecutionArtifact,
  PlanReviewArtifact,
} from './planning-artifact-types.ts';
export type ManagedSchemaName = string;

export type ChangeSchemaName = string;

/**
 * A v3 Manifest replayed from the exact tracked file observed by the active
 * change loader. PlanReview cross-binding is deliberately a later boundary;
 * this value establishes only that the current file is Manifest-authority
 * admissible on its own facts.
 */
export type CurrentInvestigationManifest = {
  manifest: InvestigationManifestV3;
  validation: {
    kind: 'manifest-authority-admissible';
    manifestDigest: string;
    investigationTargetDigest: string;
  };
  currentTreeObservation:
    | {
        kind: 'current-tracked-tree';
        path: string;
        contentDigest: string;
      }
    | ImmutableGitTreeInvestigationObservation;
};

export type ChangeContract = {
  changeId: string;
  changeDirectory: string;
  schemaName: ChangeSchemaName;
  config: WorkflowConfig;
  checks: ChecksConfig;
  guard: GuardContract;
  tasks: ParsedTask[];
  behaviorContracts: BehaviorContractRef[];
  investigation?: CurrentInvestigationManifest;
  execution?: ExecutionArtifact;
  planReview?: PlanReviewArtifact;
  artifactPaths: string[];
  artifactDigests: Record<string, string>;
};

/** Live observation always requires the private current publication reference. */
export type ChangeContractReader = (
  repositoryRoot: string,
  changeId: string,
  expectedSchemaName?: ChangeSchemaName,
) => ChangeContract;
/** Committed observation requires an exact clean checkout of the requested commit. */
export type CommittedChangeContractReader = (
  repositoryRoot: string,
  commit: string,
  changeId: string,
  expectedSchemaName?: ChangeSchemaName,
) => ChangeContract;
export type ChangeContractReaders = Readonly<{
  loadChangeContract: ChangeContractReader;
  loadCommittedChangeContract: CommittedChangeContractReader;
}>;
