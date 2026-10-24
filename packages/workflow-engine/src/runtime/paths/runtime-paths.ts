/**
 * Exposes workflow identifiers and repository-boundary checks for runtime workspaces.
 *
 * Invariants:
 * - Identifier errors and runtime directory layouts retain their exact contracts.
 * - Policy paths cannot escape the repository or cross symbolic-link aliases.
 */
import {
  RepositoryBoundaryError,
  type InvestigationRuntimePaths,
} from '@jigwright/core/runtime-path-kernel';
import {
  assertPolicyPathInsideRepository as assertCorePolicyPathInsideRepository,
  investigationRuntimePaths,
} from '@jigwright/repository-runtime/paths';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertChangeId,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';

export { investigationRuntimePaths };
export type { InvestigationRuntimePaths };

export function assertPolicyPathInsideRepository(
  repositoryRoot: string,
  policyPath: string,
): void {
  const normalized = normalizePolicyPath(policyPath);
  try {
    assertCorePolicyPathInsideRepository(repositoryRoot, normalized);
  } catch (error) {
    if (!(error instanceof RepositoryBoundaryError)) throw error;
    if (error.code === 'PATH_ESCAPES_REPOSITORY') {
      throw workflowError(
        'PATH_ESCAPES_REPOSITORY',
        `Policy path escapes the repository: ${policyPath}`,
        ExitCode.guard,
        { details: { policyPath } },
      );
    }
    throw workflowError(
      'SYMLINK_POLICY_PATH',
      `Policy path crosses a symbolic link: ${policyPath}`,
      ExitCode.guard,
      {
        details: { policyPath, symlinkPath: error.symlinkPath },
        recovery: 'Use a direct repository path without symbolic-link aliases.',
      },
    );
  }
}
