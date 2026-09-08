/**
 * Fingerprints Git refs, control files, index, and tracked or untracked worktree categories.
 *
 * Invariants:
 * - Control tree traversal and index framing preserve exact path and metadata semantics.
 * - Each category consumes the same shared projection bounds.
 *
 * Depends on: Git commands, repository path inventories, and bounded file framing.
 * Failure modes: Git control changes or worktree drift escape guarded provider evidence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git-command.ts';
import {
  consumeProjectionEntries,
  fingerprintStats,
  fingerprintTrackedEntry,
  type GovernedProjectionBudget,
  INCLUDE_VOLATILE_PROJECTION_METADATA,
  MAX_GOVERNED_PROJECTION_DEPTH,
  readDirectoryEntriesBounded,
  updateBoundedFramed,
  updateFramed,
  updateFramedFile,
} from './git-projection-files.ts';
import {
  listControlledUntrackedPaths,
  listRepositoryIgnoredPaths,
  listTrackedPaths,
} from './git-tracked-paths.ts';
import { fingerprintWorktreeEntry } from './governed-artifact-fingerprints.ts';

export function digestRefsProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  updateBoundedFramed(
    digest,
    'head-symbolic',
    runGit(repositoryRoot, ['symbolic-ref', '--quiet', 'HEAD'], true),
    budget,
  );
  updateBoundedFramed(
    digest,
    'head-oid',
    runGit(repositoryRoot, ['rev-parse', 'HEAD']),
    budget,
  );
  updateBoundedFramed(
    digest,
    'head-tree',
    runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
    budget,
  );
  return digest.digest('hex');
}

/**
 * Digest the local Git control surface a provider process could weaponize
 * without touching a tracked worktree path: the repository-local configuration
 * and the executable hook programs and local exclude/attribute inputs under the
 * Git common directory. A change to any of these is governed drift.
 */
const GIT_WORKTREE_CONTROL_FILES = [
  'AUTO_MERGE',
  'BISECT_ANCESTORS_OK',
  'BISECT_EXPECTED_REV',
  'BISECT_HEAD',
  'BISECT_LOG',
  'BISECT_NAMES',
  'BISECT_RUN',
  'BISECT_START',
  'BISECT_TERMS',
  'CHERRY_PICK_HEAD',
  'FETCH_HEAD',
  'MERGE_AUTOSTASH',
  'MERGE_HEAD',
  'MERGE_MODE',
  'MERGE_MSG',
  'MERGE_RR',
  'ORIG_HEAD',
  'REBASE_AUTOSTASH',
  'REBASE_HEAD',
  'REVERT_HEAD',
  'SQUASH_MSG',
  'commondir',
  'config.worktree',
  'gitdir',
  'info/sparse-checkout',
  'index.lock',
] as const;

export function digestGitControlProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  updateBoundedFramed(
    digest,
    'config-local',
    runGit(repositoryRoot, ['config', '--list', '--local', '-z'], true),
    budget,
  );
  const commonDirectory = localGitCommonDirectory(repositoryRoot);
  for (const relative of [
    'config',
    'config.worktree',
    'info/exclude',
    'info/attributes',
    'info/grafts',
    'objects/info/alternates',
    'shallow',
  ]) {
    updateFramed(digest, 'control-path', relative);
    fingerprintControlEntry(
      digest,
      path.join(commonDirectory, relative),
      budget,
    );
  }
  digestControlTree(
    digest,
    path.join(commonDirectory, 'hooks'),
    'hooks',
    budget,
    0,
  );
  const gitDirectory = localGitDirectory(repositoryRoot);
  for (const relative of GIT_WORKTREE_CONTROL_FILES) {
    updateFramed(digest, 'worktree-control-path', relative);
    fingerprintControlEntry(digest, path.join(gitDirectory, relative), budget);
  }
  for (const relative of ['rebase-apply', 'rebase-merge', 'sequencer']) {
    digestControlTree(
      digest,
      path.join(gitDirectory, relative),
      `worktree/${relative}`,
      budget,
      0,
    );
  }
  digestControlTree(
    digest,
    path.join(commonDirectory, 'rr-cache'),
    'common/rr-cache',
    budget,
    0,
  );
  return digest.digest('hex');
}

function digestControlTree(
  digest: ReturnType<typeof crypto.createHash>,
  absoluteDirectory: string,
  label: string,
  budget: GovernedProjectionBudget,
  depth: number,
): void {
  if (depth > MAX_GOVERNED_PROJECTION_DEPTH) {
    throw new Error('Governed projection directory depth exceeded.');
  }
  const stats = fs.lstatSync(absoluteDirectory, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    updateFramed(digest, 'control-tree', 'missing');
    return;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Git control-tree root is not a plain directory.');
  }
  updateFramed(
    digest,
    'control-tree-stat',
    fingerprintStats(stats, INCLUDE_VOLATILE_PROJECTION_METADATA),
  );
  const entries = readDirectoryEntriesBounded(absoluteDirectory, budget);
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const childLabel = `${label}/${entry.name}`;
    updateFramed(digest, 'control-path', childLabel);
    const absoluteChild = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      digestControlTree(digest, absoluteChild, childLabel, budget, depth + 1);
    } else {
      fingerprintControlEntry(digest, absoluteChild, budget);
    }
  }
}

function fingerprintControlEntry(
  digest: ReturnType<typeof crypto.createHash>,
  absolutePath: string,
  budget: GovernedProjectionBudget,
): void {
  const stats = fs.lstatSync(absolutePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    updateFramed(digest, 'control-kind', 'missing');
    return;
  }
  updateFramed(digest, 'control-stat', fingerprintStats(stats, false));
  if (stats.isSymbolicLink()) {
    updateFramed(digest, 'control-kind', 'symlink');
    updateBoundedFramed(
      digest,
      'control-link',
      fs.readlinkSync(absolutePath),
      budget,
    );
  } else if (stats.isFile()) {
    updateFramed(digest, 'control-kind', 'file');
    updateFramedFile(digest, 'control-content', absolutePath, stats, budget);
  } else if (stats.isDirectory()) {
    updateFramed(digest, 'control-kind', 'directory');
  } else {
    updateFramed(digest, 'control-kind', 'other');
  }
}

function localGitCommonDirectory(repositoryRoot: string): string {
  const value = runGit(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim();
  return fs.realpathSync(
    path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value),
  );
}

function localGitDirectory(repositoryRoot: string): string {
  const value = runGit(repositoryRoot, ['rev-parse', '--git-dir']).trim();
  return fs.realpathSync(
    path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value),
  );
}

export function digestIndexProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  updateBoundedFramed(
    digest,
    'ls-files-stage',
    runGit(repositoryRoot, ['ls-files', '--stage', '-z', '--']),
    budget,
  );
  updateBoundedFramed(
    digest,
    'ls-files-flags',
    runGit(repositoryRoot, ['ls-files', '-v', '-z', '--']),
    budget,
  );
  updateBoundedFramed(
    digest,
    'diff-cached',
    runGit(repositoryRoot, ['diff', '--cached', '--raw', '-z', 'HEAD', '--']),
    budget,
  );
  return digest.digest('hex');
}

export function digestTrackedWorktreeProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  const trackedPaths = listTrackedPaths(repositoryRoot);
  consumeProjectionEntries(budget, trackedPaths.length);
  for (const trackedPath of trackedPaths) {
    updateFramed(digest, 'tracked-path', trackedPath);
    fingerprintTrackedEntry(
      digest,
      repositoryRoot,
      trackedPath,
      INCLUDE_VOLATILE_PROJECTION_METADATA,
      budget,
    );
  }
  return digest.digest('hex');
}

export function digestUntrackedWorktreeProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  const untrackedPaths = listControlledUntrackedPaths(repositoryRoot);
  consumeProjectionEntries(budget, untrackedPaths.length);
  for (const untrackedPath of untrackedPaths) {
    updateFramed(digest, 'untracked-path', untrackedPath);
    fingerprintWorktreeEntry(
      digest,
      path.join(repositoryRoot, untrackedPath),
      'untracked',
      true,
      budget,
    );
  }
  return digest.digest('hex');
}

export function digestIgnoredWorktreeProjection(
  repositoryRoot: string,
  budget: GovernedProjectionBudget,
): string {
  const digest = crypto.createHash('sha256');
  const ignoredPaths = listRepositoryIgnoredPaths(repositoryRoot);
  consumeProjectionEntries(budget, ignoredPaths.length);
  for (const ignoredPath of ignoredPaths) {
    updateFramed(digest, 'ignored-path', ignoredPath);
    fingerprintWorktreeEntry(
      digest,
      path.join(repositoryRoot, ignoredPath),
      'ignored',
      false,
      budget,
    );
  }
  return digest.digest('hex');
}
