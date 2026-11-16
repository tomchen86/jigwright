import type { ChangeContract } from '../../planning-provider/change-contract.ts';

/** Canonical commit replay contracts and pure predicates. */
import path from 'node:path';
import type { CollaborationGrantUseIdentity } from '../../authority/collaboration-grant-codec.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import type { AmendPlanManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import type { ManagedSchemaName } from '../../planning-provider/change-contract.ts';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';
import type { InvestigationFirstPlanningAssuranceSummary } from '../planning-assurance-validator.ts';
import { assertPlanningPaths } from '../../source/planning-paths.ts';
import type { PlanningPathPolicy } from '../../source/planning-paths.ts';
import type { ResolvedPlanningProviderBinding } from '../../planning-provider/planning-provider-binding.ts';
import type { PlanningTaskState } from '../../planning-provider/planning-task-history.ts';

export type CiPlanningCommitValidation = {
  changeId: string;
  kind: 'introduction' | 'revision';
  beforeTasks: PlanningTaskState[] | undefined;
  afterTasks: PlanningTaskState[];
  changedPaths: string[];
  schemaName: ManagedSchemaName;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary;
  collaborationGrantUses: readonly CiCollaborationGrantUse[];
};

export type CiCollaborationGrantUse = CollaborationGrantUseIdentity;

export function malformedHistoricalGrantClaim() {
  return ciPlanningError(
    'CI_PLANNING_GRANT_HISTORY_INVALID',
    'Historical planning grant claims are malformed.',
  );
}

export type TreeEntry = {
  mode: string;
  type: string;
  path: string;
};

export function readCommittedAmendment(
  message: string,
  changeId: string,
): AmendPlanManagedTrailers | null {
  let trailers;
  try {
    trailers = parseManagedTrailers(
      message.endsWith('\n') ? message.slice(0, -1) : message,
    );
  } catch {
    return null;
  }
  if (trailers?.kind !== 'amend-plan') return null;
  if (trailers.changeId !== changeId) {
    throw ciPlanningError(
      'CI_PLANNING_AMENDMENT_CHANGE_MISMATCH',
      'An amendment names the change it amends, and this one names another.',
    );
  }
  return trailers;
}

export type PlanningTreeReplay = {
  schemaName: ManagedSchemaName;
  currentSchemaName: ManagedSchemaName;
  manifestBaseline: { commitOid: string; treeOid: string };
  planningAssurance: InvestigationFirstPlanningAssuranceSummary;
  collaborationGrantUses: readonly CiCollaborationGrantUse[];
};

export function requiredArtifactPaths(
  planningPaths: PlanningPathPolicy,
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName,
  currentSchemaName: ManagedSchemaName,
): string[] {
  return [
    ...planningPaths.requiredArtifactPaths(
      changeRoot,
      changeId,
      schemaName,
      currentSchemaName,
    ),
  ];
}

export function assertCompletePlanningTree(
  planningPaths: PlanningPathPolicy,
  changeRoot: string,
  changeId: string,
  entries: TreeEntry[],
  toleratedDeletedPaths: readonly string[] = [],
  schemaName: ManagedSchemaName,
  currentSchemaName: ManagedSchemaName,
): void {
  const paths = entries.map(({ path }) => path);
  assertPlanningPaths(
    planningPaths.admit,
    changeRoot,
    changeId,
    paths,
    toleratedDeletedPaths,
    schemaName,
    currentSchemaName,
  );
  const prefix = `${changeRoot}/${changeId}`;
  const required = requiredArtifactPaths(
    planningPaths,
    changeRoot,
    changeId,
    schemaName,
    currentSchemaName,
  );
  if (
    required.some((requiredPath) => !paths.includes(requiredPath)) ||
    !paths.some(
      (filePath) =>
        filePath.startsWith(`${prefix}/specs/`) &&
        filePath.endsWith('/spec.md'),
    )
  ) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_INVALID',
      'Planning commit tree is missing a required artifact.',
    );
  }
  if (entries.some(({ mode, type }) => mode !== '100644' || type !== 'blob')) {
    throw ciPlanningError(
      'CI_PLANNING_TREE_UNSAFE',
      'Planning artifacts must be non-executable regular Git blobs.',
    );
  }
}

export function assertChangeId(changeId: string): void {
  if (changeId === 'archive') {
    throw ciPlanningError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) {
    throw ciPlanningError(
      'CI_PLANNING_CHANGE_ID_INVALID',
      'CI planning validation requires a canonical change ID.',
    );
  }
}

export function ciPlanningError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, {
    ...(details ? { details } : {}),
  });
}

export type CiPlanningReplayOperations = {
  resolveHistoricalPlanningProviderForCi(
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
  collectHistoricalCollaborationGrantUses(
    repositoryRoot: string,
    head: string,
    changeId: string,
    changeRoot?: string,
  ): readonly CiCollaborationGrantUse[];
  validateCiPlanningCommit(
    repositoryRoot: string,
    commitHash: string,
    changeId: string,
    changeRoot?: string,
  ): CiPlanningCommitValidation;
  collectCurrentCollaborationGrantUses(
    contract: Pick<ChangeContract, 'investigation' | 'planReview'>,
  ): readonly CiCollaborationGrantUse[];
};
