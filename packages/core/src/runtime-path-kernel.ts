/**
 * Defines deterministic runtime layouts, identifiers, and repository-boundary facts.
 *
 * Invariants:
 * - Filesystem canonicalization and inspection belong to repository runtime.
 * - The caller supplies a canonical Git-common directory for layout projection.
 */
import path from 'node:path';

export {
  assertChangeId,
  assertTaskId,
  assertSessionId,
  assertInvestigationId,
  assertInvocationId,
  type InvalidRuntimeIdentifierFactory,
} from './workflow-identifiers.ts';

export type InvestigationRuntimePaths = {
  base: string;
  root: string;
  objects: string;
  refs: string;
  sessions: string;
  invocations: string;
  locks: string;
};

export type RepositoryBoundaryErrorCode =
  'PATH_ESCAPES_REPOSITORY' | 'SYMLINK_POLICY_PATH';

/**
 * A consumer-neutral repository-boundary fact. Presentation, exit status, and
 * recovery policy remain owned by the calling adapter.
 */
export class RepositoryBoundaryError extends Error {
  readonly code: RepositoryBoundaryErrorCode;
  readonly policyPath: string;
  readonly symlinkPath?: string;

  constructor(options: {
    code: RepositoryBoundaryErrorCode;
    policyPath: string;
    symlinkPath?: string;
  }) {
    super(
      options.code === 'PATH_ESCAPES_REPOSITORY'
        ? `Policy path escapes the repository: ${options.policyPath}`
        : `Policy path crosses a symbolic link: ${options.policyPath}`,
    );
    this.name = 'RepositoryBoundaryError';
    this.code = options.code;
    this.policyPath = options.policyPath;
    this.symlinkPath = options.symlinkPath;
  }
}

/**
 * Resolve the investigation runtime layout beneath a canonical Git-common
 * base. This owns path projection only, never storage or session state.
 */
export function projectInvestigationRuntimePaths(
  canonicalGitCommonDirectory: string,
  runtimeDirectory: string,
): InvestigationRuntimePaths {
  const base = canonicalGitCommonDirectory;
  const root = path.join(base, runtimeDirectory, 'investigations');
  return {
    base,
    root,
    objects: path.join(root, 'objects', 'sha256'),
    refs: path.join(root, 'refs'),
    sessions: path.join(root, 'sessions'),
    invocations: path.join(root, 'invocations'),
    locks: path.join(root, 'locks'),
  };
}
