/** Canonicalizes repository paths and rejects symbolic-link segments for filesystem consumers. */
import fs from 'node:fs';
import path from 'node:path';
import { normalizePolicyPath } from '@jigwright/core/repository-path';
import {
  RepositoryBoundaryError,
  projectInvestigationRuntimePaths,
  type InvestigationRuntimePaths,
} from '@jigwright/core/runtime-path-kernel';

export function investigationRuntimePaths(
  gitCommonDirectory: string,
  runtimeDirectory: string,
): InvestigationRuntimePaths {
  return projectInvestigationRuntimePaths(
    fs.realpathSync(path.resolve(gitCommonDirectory)),
    runtimeDirectory,
  );
}

export function assertPolicyPathInsideRepository(
  repositoryRoot: string,
  policyPath: string,
): void {
  const normalized = normalizePolicyPath(policyPath);
  const relative = normalized.endsWith('/**')
    ? normalized.slice(0, -3)
    : normalized;
  const repositoryRealPath = fs.realpathSync(repositoryRoot);
  const targetPath = path.resolve(repositoryRealPath, relative);

  assertInside(repositoryRealPath, targetPath, policyPath);
  assertNoSymlinkSegments(repositoryRealPath, relative, policyPath);
}

function assertNoSymlinkSegments(
  repositoryRoot: string,
  relativePath: string,
  policyPath: string,
): void {
  let currentPath = repositoryRoot;
  for (const segment of relativePath.split('/')) {
    currentPath = path.join(currentPath, segment);
    const stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      let resolvedPath: string;
      try {
        resolvedPath = fs.realpathSync(currentPath);
      } catch {
        throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
      }
      assertInside(repositoryRoot, resolvedPath, policyPath);
      throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
    }
    if (!stats.isDirectory()) return;
  }
}

function assertInside(
  repositoryRoot: string,
  targetPath: string,
  policyPath: string,
): void {
  const relative = path.relative(repositoryRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RepositoryBoundaryError({
      code: 'PATH_ESCAPES_REPOSITORY',
      policyPath,
    });
  }
}

function invalidPolicySymlink(
  repositoryRoot: string,
  symlinkPath: string,
  policyPath: string,
): RepositoryBoundaryError {
  return new RepositoryBoundaryError({
    code: 'SYMLINK_POLICY_PATH',
    policyPath,
    symlinkPath: path.relative(repositoryRoot, symlinkPath),
  });
}
