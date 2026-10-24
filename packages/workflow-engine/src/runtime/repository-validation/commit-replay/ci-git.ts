/** Immutable commit replay operations; caller-owned semantic services are required. */
import { commitChangedPaths } from '../../repository-transaction/git-transitions.ts';
import {
  resolveCommitOid,
  resolveTreeOid,
} from '../../repository-transaction/git-object-ids.ts';
import { commitFacts } from '../../repository-transaction/git-transitions.ts';
import { runGit } from '../../repository-transaction/git.ts';
import { ManagedTrailerSyntaxError } from '@jigwright/core/managed-transition-trailers';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import type { ManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import { normalizeChangedPath } from '../../../foundation/repository-path/repository-path.ts';
import type { RangeCommit } from '../../../modules/assurance/commit-replay/ci-git.ts';
import { ciGitError } from '../../../modules/assurance/commit-replay/ci-git.ts';

export function assertCiCommit(repositoryRoot: string, value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw ciGitError('CI_COMMIT_ID_INVALID', 'CI requires an exact commit ID.');
  }
  const resolved = resolveCommitOid(repositoryRoot, value);
  if (resolved !== value) {
    throw ciGitError(
      'CI_COMMIT_ID_INVALID',
      'CI commit ID did not resolve exactly.',
    );
  }
  return resolved;
}

export function findMergeBase(
  repositoryRoot: string,
  base: string,
  head: string,
): string {
  const mergeBase = runGit(repositoryRoot, ['merge-base', base, head]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase)) {
    throw ciGitError(
      'CI_MERGE_BASE_INVALID',
      'CI could not determine a valid merge base.',
    );
  }
  return mergeBase;
}

export function listRangeCommits(
  repositoryRoot: string,
  base: string,
  head: string,
): RangeCommit[] {
  const hashes = runGit(repositoryRoot, [
    'rev-list',
    '--reverse',
    `${base}..${head}`,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (hashes.length === 0) {
    throw ciGitError(
      'CI_EMPTY_RANGE',
      'CI base and head contain no PR commits.',
    );
  }
  return hashes.map((hash) => {
    const facts = commitFacts(repositoryRoot, hash);
    let trailers: ManagedTrailers | undefined;
    try {
      trailers = parseManagedTrailers(facts.message);
    } catch (error) {
      if (error instanceof ManagedTrailerSyntaxError) {
        throw ciGitError(
          'CI_INVALID_MANAGED_TRAILERS',
          'A PR commit contains a non-canonical managed trailer block.',
        );
      }
      throw error;
    }
    return {
      hash: facts.hash,
      subject: facts.message.split('\n', 1)[0],
      parents: facts.parents,
      ...(trailers ? { trailers } : {}),
    };
  });
}

export function listRangePaths(
  repositoryRoot: string,
  base: string,
  head: string,
): string[] {
  return runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    '--diff-filter=ACDMRTUXB',
    base,
    head,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath)
    .sort();
}

export function lastCommitChangingPath(
  repositoryRoot: string,
  head: string,
  filePath: string,
): string | null {
  const exactHead = assertCiCommit(repositoryRoot, head);
  const normalizedPath = normalizeChangedPath(filePath);
  const commit = runGit(
    repositoryRoot,
    [
      'log',
      '-1',
      '--format=%H',
      exactHead,
      '--',
      `:(literal)${normalizedPath}`,
    ],
    true,
  ).trim();
  return commit === '' ? null : assertCiCommit(repositoryRoot, commit);
}

export function treeAtCommit(repositoryRoot: string, commit: string): string {
  const exactCommit = assertCiCommit(repositoryRoot, commit);
  return resolveTreeOid(repositoryRoot, exactCommit);
}

export function listChangesAtCommit(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
): string[] {
  const prefix = `${changeRoot}/`;
  return [
    ...new Set(
      runGit(repositoryRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        commit,
        '--',
        changeRoot,
      ])
        .split('\0')
        .filter((filePath) => filePath.endsWith('/guard.json'))
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length).split('/')[0])
        .filter((changeId) => changeId && changeId !== 'archive'),
    ),
  ].sort();
}

export function firstCommitIntroduces(
  repositoryRoot: string,
  commit: RangeCommit,
  requiredPaths: string[],
): boolean {
  const changed = new Set(commitChangedPaths(repositoryRoot, commit.hash));
  return requiredPaths.every((filePath) => changed.has(filePath));
}

export function listCommitPaths(
  repositoryRoot: string,
  commit: RangeCommit,
): string[] {
  return commitChangedPaths(repositoryRoot, commit.hash);
}
