import crypto from 'node:crypto';
import { normalizePolicyPath } from '../../foundation/repository-path/repository-path.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { RangeCommit } from './commit-replay/ci-git.ts';
import type { DocumentationClosureRecord } from './documentation-closure.ts';
import {
  createPreMergeCoverageEntry,
  type PreMergeCoverageEntry,
} from './pre-merge-assurance.ts';
export function groupTaskCommits(commits: readonly RangeCommit[]): Map<
  string,
  Array<
    RangeCommit & {
      trailers: { kind: 'task'; changeId: string; taskId: string };
    }
  >
> {
  const grouped = new Map<
    string,
    Array<
      RangeCommit & {
        trailers: { kind: 'task'; changeId: string; taskId: string };
      }
    >
  >();
  for (const commit of commits) {
    if (commit.trailers?.kind !== 'task') continue;
    const typed = commit as RangeCommit & {
      trailers: { kind: 'task'; changeId: string; taskId: string };
    };
    const group = grouped.get(typed.trailers.changeId) ?? [];
    group.push(typed);
    grouped.set(typed.trailers.changeId, group);
  }
  return grouped;
}

export function implementationCoverageFromClosure(
  closure: DocumentationClosureRecord,
): PreMergeCoverageEntry {
  return createPreMergeCoverageEntry({
    category: 'implementation',
    changeId: closure.changeId,
    subjectDigest: closure.reviewSubjectDigest,
    paths: closure.requirement.changedPaths,
    contextDigests: uniqueDigests([
      closure.reviewRecordDigest,
      closure.closureDigest,
      closure.requirement.requirementDigest,
      closure.requirement.patchDigest,
    ]),
  });
}

export function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizePolicyPath))].sort();
}

export function uniqueDigests(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function planningStale(message: string) {
  return workflowError(
    'PRE_MERGE_PLANNING_GENERATION_STALE',
    message,
    ExitCode.verification,
  );
}

export function preMergeInvalid(message: string) {
  return workflowError(
    'PRE_MERGE_ASSURANCE_INVALID',
    message,
    ExitCode.verification,
  );
}

export function preMergeUnavailable(message: string) {
  return workflowError(
    'PRE_MERGE_ASSURANCE_UNAVAILABLE',
    message,
    ExitCode.verification,
  );
}

import type { CiRepositoryObservations } from './commit-replay/ci-git.ts';
import type { CommittedChangeContractReader } from '../planning-provider/change-contract.ts';
import type { PlanningAssurancePort } from './planning-assurance-port.ts';

import type { PreMergeAssuranceNode } from './pre-merge-assurance.ts';
import type { ConsumedRoleReplayPort } from '../provider-orchestration/role-admission-contracts.ts';
export type PreMergeVerificationServices = Pick<
  CiRepositoryObservations,
  | 'discoverRepository'
  | 'loadWorkflowConfig'
  | 'currentRepositorySchemaName'
  | 'listRangeCommits'
  | 'committedPlanningGeneration'
  | 'commitFacts'
  | 'commitChangedPaths'
  | 'latestPlanCommit'
  | 'commitsChangingPath'
  | 'resolveAncestorMergeBase'
> & {
  loadCommittedChangeContract: CommittedChangeContractReader;
  productionPlanningAssurance: Pick<PlanningAssurancePort, 'validateReadiness'>;
  productionConsumedPlanReviewReplayPort: ConsumedRoleReplayPort;
  storePreMergeAssuranceForRepository(
    cwd: string,
    assurance: PreMergeAssuranceNode,
  ): PreMergeAssuranceNode;
  readPreMergeAssuranceForRepository(
    cwd: string,
    base: string,
    head: string,
  ): PreMergeAssuranceNode | null;
};
