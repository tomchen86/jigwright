/** Immutable commit replay operations; caller-owned semantic services are required. */
import fs from 'node:fs';
import path from 'node:path';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import { runGit } from '../../repository-transaction/git.ts';
import type { TreeEntry } from '../../../modules/assurance/commit-replay/ci-archive-tree.ts';
import { isArchiveName } from '../../../modules/assurance/commit-replay/ci-archive-tree.ts';
import { sameRelativeTree } from '../../../modules/assurance/commit-replay/ci-archive-tree.ts';
import { replayMismatch } from '../../../modules/assurance/commit-replay/ci-archive-tree.ts';

export function inspectArchiveCommitTree(
  repositoryRoot: string,
  parent: string,
  commitHash: string,
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
): string {
  const activeRoot = `${changeRoot}/${changeId}`;
  const archivePath = actualArchivePath(
    repositoryRoot,
    commitHash,
    changeId,
    changeRoot,
    changedPaths,
  );
  const activeEntries = listTreeEntries(repositoryRoot, parent, activeRoot);
  const archivedEntries = listTreeEntries(
    repositoryRoot,
    commitHash,
    archivePath,
  );
  if (
    activeEntries.length === 0 ||
    listTreeEntries(repositoryRoot, commitHash, activeRoot).length > 0 ||
    !sameRelativeTree(activeEntries, activeRoot, archivedEntries, archivePath)
  ) {
    throw replayMismatch();
  }
  return archivePath;
}

export function assertArchiveReplayContent(
  repositoryRoot: string,
  commitHash: string,
  actualArchivePath: string,
  worktree: string,
  replayArchivePath: string,
  replayPaths: string[],
): void {
  const replayEntries = listWorkingTreeFiles(worktree, replayArchivePath);
  if (
    !sameRelativeWorkingTree(
      repositoryRoot,
      commitHash,
      actualArchivePath,
      worktree,
      replayArchivePath,
      replayEntries,
    )
  ) {
    throw replayMismatch();
  }
  for (const replayPath of replayPaths.filter(
    (filePath) => !filePath.startsWith(`${replayArchivePath}/`),
  )) {
    const actual = readFileAtCommit(repositoryRoot, commitHash, replayPath);
    const entries = listTreeEntries(repositoryRoot, commitHash, replayPath);
    const replay = path.join(worktree, replayPath);
    const stats = fs.lstatSync(replay, { throwIfNoEntry: false });
    if (stats === undefined && actual === undefined && entries.length === 0) {
      continue;
    }
    if (
      actual === undefined ||
      entries.length !== 1 ||
      entries[0]?.path !== replayPath ||
      entries[0]?.mode !== '100644' ||
      entries[0]?.type !== 'blob' ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o111) !== 0 ||
      !Buffer.from(actual).equals(fs.readFileSync(replay))
    ) {
      throw replayMismatch();
    }
  }
}

function actualArchivePath(
  repositoryRoot: string,
  commitHash: string,
  changeId: string,
  changeRoot: string,
  changedPaths: string[],
): string {
  const prefix = `${changeRoot}/archive/`;
  const directories = new Set(
    changedPaths
      .filter((filePath) => filePath.startsWith(prefix))
      .map(
        (filePath) => `${prefix}${filePath.slice(prefix.length).split('/')[0]}`,
      ),
  );
  if (directories.size !== 1) throw replayMismatch();
  const archivePath = [...directories][0];
  if (
    !isArchiveName(path.posix.basename(archivePath), changeId) ||
    listTreeEntries(repositoryRoot, commitHash, archivePath).length === 0
  ) {
    throw replayMismatch();
  }
  return archivePath;
}

function sameRelativeWorkingTree(
  repositoryRoot: string,
  commitHash: string,
  actualRoot: string,
  worktree: string,
  replayRoot: string,
  replayEntries: string[],
): boolean {
  const actualEntries = listTreeEntries(repositoryRoot, commitHash, actualRoot);
  if (
    JSON.stringify(
      actualEntries.map(({ path: filePath }) =>
        filePath.slice(actualRoot.length + 1),
      ),
    ) !== JSON.stringify(replayEntries)
  ) {
    return false;
  }
  return actualEntries.every(({ path: filePath, mode, type }, index) => {
    const actual = readFileAtCommit(repositoryRoot, commitHash, filePath);
    const replay = path.join(worktree, replayRoot, replayEntries[index]);
    const stats = fs.lstatSync(replay, { throwIfNoEntry: false });
    return (
      actual !== undefined &&
      mode === '100644' &&
      type === 'blob' &&
      stats?.isFile() === true &&
      !stats.isSymbolicLink() &&
      (stats.mode & 0o111) === 0 &&
      Buffer.from(actual).equals(fs.readFileSync(replay))
    );
  });
}

function listTreeEntries(
  repositoryRoot: string,
  commit: string,
  root: string,
): TreeEntry[] {
  return runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    commit,
    '--',
    `:(literal)${root}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\S+) ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match) throw replayMismatch();
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        path: match[4],
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function listWorkingTreeFiles(
  repositoryRoot: string,
  relativeRoot: string,
): string[] {
  const result: string[] = [];
  walk(path.join(repositoryRoot, relativeRoot));
  return result.sort();

  function walk(directory: string): void {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw replayMismatch();
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(entryPath);
      } else {
        result.push(
          path
            .relative(path.join(repositoryRoot, relativeRoot), entryPath)
            .split(path.sep)
            .join('/'),
        );
      }
    }
  }
}
