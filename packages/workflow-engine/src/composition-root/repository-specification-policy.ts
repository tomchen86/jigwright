/**
 * Combines canonical spec ownership with repository-specific lifecycle
 * paths.
 *
 * Invariants:
 * - Lifecycle selection includes the routing source, configured change tree
 *   and recognized base specifications.
 */
import path from 'node:path';
import { changeLifecycleRelativePath } from '../modules/lifecycle/change-routing.ts';
import { isBaseSpecificationPath } from '../modules/source/system-spec-catalog.ts';

/** Combine canonical specification ownership with the consumer's lifecycle paths. */
export function createRepositorySpecificationPolicy(changeRoot: string) {
  const baseSpecRoot = `${path.posix.dirname(changeRoot)}/specs/`;
  const changePrefix = `${changeRoot}/`;
  return Object.freeze({
    baseSpecificationPaths(paths: readonly string[]): string[] {
      return paths.filter(isBaseSpecificationPath);
    },
    stagedLifecyclePaths(paths: readonly string[]): string[] {
      return paths.filter(
        (filePath) =>
          filePath === changeLifecycleRelativePath ||
          filePath.startsWith(changePrefix) ||
          isBaseSpecificationPath(filePath) ||
          filePath.startsWith(baseSpecRoot),
      );
    },
  });
}
