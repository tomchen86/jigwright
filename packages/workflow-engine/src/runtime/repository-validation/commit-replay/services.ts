export type { CiAuthorityReplayServices } from '../../../modules/assurance/commit-replay/ci-authority.ts';
import type { PlanningPathPolicy } from '../../../modules/source/planning-paths.ts';
import type { ReadSystemSpecDeltaInputs } from '../../../modules/source/system-spec-deltas.ts';
/** Required semantic capabilities for immutable commit replay. */
import type {
  ChangeContract,
  CommittedChangeContractReader,
  ManagedSchemaName,
} from '../../../modules/planning-provider/change-contract.ts';
import type { PlanningAssurancePort } from '../../../modules/assurance/planning-assurance-port.ts';

import type { PlanReviewArtifactParser } from '../../../modules/assurance/plan-review-artifact.ts';
import type { validateForAuthority } from '../../../modules/investigation/manifest/investigation-manifest.ts';
import type {
  ArchiveApplicabilityProjectionInput,
  PlanningArchiveProjectionPort,
} from '../../../modules/planning-provider/planning-archive-projection-port.ts';
import type { ResolvedPlanningProviderBinding } from '../../../modules/planning-provider/planning-provider-binding.ts';
import type { GeneratedDocumentMutation } from '../../../modules/projection/managed-documents.ts';
import type { ArchivedWorkItemReconciler } from '../../../modules/governance-intake/work-registry-contracts.ts';
import type { CiPlanningReplayOperations } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import type { CiArchiveReplayOperations } from '../../../modules/assurance/commit-replay/ci-archive.ts';
import type { CiAuthorityReplayOperations } from '../../../modules/assurance/commit-replay/ci-authority.ts';
import type { CiHistoricalReplayOperations } from '../../../modules/assurance/commit-replay/ci-historical-contract.ts';
import type { ConsumedRoleReplayPort } from '../../../modules/provider-orchestration/role-admission-contracts.ts';
type Tail<Values extends readonly unknown[]> = Values extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : never;
export type CiPlanningReplayServices = {
  planningPaths: PlanningPathPolicy;
  validateHandoffForChange(repositoryRoot: string, changeId: string): void;
  productionPlanningAssurance: PlanningAssurancePort;
  productionConsumedPlanReviewReplayPort: ConsumedRoleReplayPort;
  parsePlanReviewArtifact: PlanReviewArtifactParser;
  validateForAuthority(
    ...args: Tail<Parameters<typeof validateForAuthority>>
  ): ReturnType<typeof validateForAuthority>;
  createArchiveApplicabilityProjection(
    input: ArchiveApplicabilityProjectionInput,
  ): void;
  loadCommittedPlanningDocumentProjection(
    repositoryRoot: string,
    commit: string,
    changeId: string,
    schemaName: ManagedSchemaName,
  ): {
    contract: ChangeContract;
    semanticLedgerMutations: readonly GeneratedDocumentMutation[];
  };
  resolveHistoricalOpenSpecPlanningTransitionBinding(
    repositoryRoot: string,
    parentCommit: string,
    candidateCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding;
  resolveHistoricalOpenSpecProviderBinding(
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
};
export type CiArchiveReplayServices = Pick<
  CiPlanningReplayOperations,
  | 'collectHistoricalCollaborationGrantUses'
  | 'resolveHistoricalPlanningProviderForCi'
> & {
  readSystemSpecDeltaInputs: ReadSystemSpecDeltaInputs;
  createRepositorySpecificationPolicy(changeRoot: string): {
    baseSpecificationPaths(paths: readonly string[]): string[];
    stagedLifecyclePaths(paths: readonly string[]): string[];
  };
  loadCommittedChangeContract: CommittedChangeContractReader;
  archiveReconciliationTimestamp(
    repositoryRoot: string,
    parentCommit: string,
  ): string;
  refreshArchiveManagedHandoff(
    repositoryRoot: string,
    parentCommit: string,
  ): readonly string[];
  reconcileArchivedWorkItems: ArchivedWorkItemReconciler;
  createOpenSpecPlanningArchiveProjectionPort(): PlanningArchiveProjectionPort;
};

export type CiHistoricalReplayServices = Pick<
  CiPlanningReplayOperations,
  'validateCiPlanningCommit'
>;
export type CiSequenceReplayServices = Pick<
  CiPlanningReplayOperations,
  'validateCiPlanningCommit'
> &
  Pick<CiArchiveReplayOperations, 'validateCiArchiveCommit'> &
  Pick<CiAuthorityReplayOperations, 'validateCiAuthorityCommit'> &
  Pick<CiHistoricalReplayOperations, 'loadHistoricalTaskAuthority'>;
