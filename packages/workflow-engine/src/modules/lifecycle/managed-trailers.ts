/**
 * Exposes the shared managed commit trailer grammar to lifecycle callers.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  hasManagedTrailerLine,
  isCentralAuthorityCommitProvenance,
  isCentralAuthorityCommitSubject,
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';
export type {
  AmendPlanManagedTrailers,
  ArchiveManagedTrailers,
  AuthorityCandidateManagedTrailers,
  AuthorityManagedTrailers,
  CentralAuthorityCommitProvenance,
  CentralAuthorityManagedTrailers,
  ManagedTrailers,
  PlanManagedTrailers,
  RouteManagedTrailers,
  TaskManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';
