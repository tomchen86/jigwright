/**
 * Exposes exact staging, managed commit construction, ref updates, and commit history queries.
 *
 * Invariants:
 * - Public operations preserve their existing index, commit, and ref authority semantics.
 * - Message bytes and task-history matching stay compatible with existing commits.
 */

export {
  commitChangedPaths,
  commitFacts,
  findCurrentExecutionTaskCommits,
  findExactTaskCommits,
  hasExactTrailers,
} from './git-commit-history.ts';
export type { TaskCommit } from './git-commit-history.ts';
export {
  amendPlanCommitMessage,
  amendPlanCommitTrailers,
  archiveCommitMessage,
  authorityCandidateCommitMessage,
  authorityCommitMessage,
  gitAuthorityCandidateApplyCommitMessage,
  gitAuthorityCandidateApplyCommitTrailers,
  managedCommitMessage,
  planningCommitMessage,
  routeCommitMessage,
} from './git-commit-messages.ts';
export type {
  AmendmentProvenance,
  GitAuthorityCandidateApplyCommitProvenance,
} from './git-commit-messages.ts';
export {
  createAmendPlanCommitObject,
  createArchiveCommitObject,
  createManagedCommitObject,
  createPlanningCommitObject,
  createRouteCommitObject,
  createSignedAuthorityCandidateCommitObject,
  createSignedAuthorityCommitObject,
  updateManagedRef,
} from './git-commit-objects.ts';
export {
  listStagedPaths,
  previewExactStaging,
  rollbackExactStaging,
  stageExactPaths,
  stageExactPathsPreservingUnstaged,
} from './git-exact-staging.ts';
export type {
  ExactStagingPin,
  PartialStagingPreparation,
} from './git-exact-staging.ts';
export {
  resolveCommitIdentity,
  validateCommitSubject,
} from './git-transition-values.ts';
