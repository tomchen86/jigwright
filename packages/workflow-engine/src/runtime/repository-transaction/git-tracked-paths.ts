/**
 * Lists controlled tracked, untracked, and ignored repository paths.
 *
 * Invariants:
 * - NUL-delimited Git output and ignored-path normalization preserve exact path identities.
 * - Hidden index flags keep their current rejection interpretation.
 */
import { normalizeChangedPath } from '../../foundation/repository-path/repository-path.ts';
import { runGit } from './git-command.ts';

export function hasHiddenIndexFlag(entry: string): boolean {
  const tag = entry[0];
  return tag === 'S' || (tag >= 'a' && tag <= 'z');
}

export function listControlledUntrackedPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--exclude-per-directory=.gitignore',
      '-z',
      '--',
    ]),
  ).map(normalizeChangedPath);
}

export function listTrackedPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, ['ls-files', '--cached', '-z', '--']),
  ).map(normalizeChangedPath);
}

export function listTrackedPathsAtCommit(
  repositoryRoot: string,
  commit: string,
): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      commit,
      '--',
    ]),
  ).map(normalizeChangedPath);
}

export function listRepositoryIgnoredPaths(repositoryRoot: string): string[] {
  return splitNull(
    runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-per-directory=.gitignore',
      // An ignored directory is one canonical record, exactly like an ignored
      // nested repository: enumerating every file inside dependency trees such
      // as node_modules exhausts the projection budget without governing
      // anything, because ignored content is never a provider input.
      '--directory',
      '-z',
      '--',
    ]),
  ).map(normalizeGitIgnoredPath);
}

function normalizeGitIgnoredPath(value: string): string {
  const candidate = value.endsWith('/') ? value.slice(0, -1) : value;
  return normalizeChangedPath(candidate);
}

export function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
