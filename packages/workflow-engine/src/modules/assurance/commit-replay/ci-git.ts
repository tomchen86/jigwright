/** Canonical commit replay contracts and pure predicates. */
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';
import type { ManagedTrailers } from '@jigwright/core/managed-transition-trailers';

export type RangeCommit = {
  hash: string;
  subject: string;
  parents: string[];
  trailers?: ManagedTrailers;
};

export function ciGitError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

import type { GitState } from '../../repository-consumer/repository-git-state.ts';
import type { CommitFacts } from '../../repository-consumer/commit-facts.ts';
import type { WorkflowConfig } from '../../repository-consumer/workflow-config.ts';
import type { ChecksConfig } from '../../source/check-command.ts';
export type CiRepositoryObservations = {
 discoverRepository(cwd: string): GitState;
 assertCiCommit(repositoryRoot: string, value: string): string;
 findMergeBase(repositoryRoot: string, base: string, head: string): string;
 listRangeCommits(repositoryRoot: string, base: string, head: string): RangeCommit[];
 listRangePaths(repositoryRoot: string, base: string, head: string): string[];
 listChangesAtCommit(repositoryRoot: string, commit: string, changeRoot: string): string[];
 readFileAtCommit(repositoryRoot: string, commit: string, filePath: string): string | undefined;
 readCurrentFile(repositoryRoot: string, filePath: string): string | undefined;
 loadWorkflowConfig(repositoryRoot: string): WorkflowConfig;
 loadChecksConfig(repositoryRoot: string): ChecksConfig;
 currentRepositorySchemaName(repositoryRoot: string): string;
 commitFacts(repositoryRoot: string, commit: string): CommitFacts;
 commitChangedPaths(repositoryRoot: string, commit: string): string[];
 committedPlanningGeneration(repositoryRoot: string, commit: string, changeRoot: string, changeId: string): string | null;
 listFirstParentHashes(repositoryRoot: string, base: string): string[];
 listTagRefs(repositoryRoot: string, prefix: string): string[];
 readTagObject(repositoryRoot: string, ref: string): string;
 resolveTagCommit(repositoryRoot: string, ref: string): string;
 resolveCommitTree(repositoryRoot: string, commit: string): string;
 readHistoricalPolicyBlob(repositoryRoot: string, commit: string): string;
 readHistoricalPolicyContent(repositoryRoot: string, commit: string): string;
 latestPlanCommit(repositoryRoot: string, head: string, artifactPath: string): string;
 commitsChangingPath(repositoryRoot: string, afterCommit: string, head: string, filePath: string): string[];
 resolveAncestorMergeBase(repositoryRoot: string, ancestor: string, descendant: string): string;
};
