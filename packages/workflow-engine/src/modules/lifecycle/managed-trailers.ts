/**
 * Compatibility surface for the mechanically extracted neutral Git trailer
 * grammar. The public core module is the sole parser and error authority.
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
